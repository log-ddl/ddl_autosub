//! Persistent `omnivoice_worker.py serve` subprocess manager.
//!
//! Keeps the ~3.3 GB OmniVoice model resident in GPU / MPS / CPU memory across
//! requests and communicates via newline-delimited JSON on stdin/stdout.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use once_cell::sync::Lazy;
use serde_json::Value;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::oneshot;

use crate::process_ext::HiddenConsole;

use super::paths::{utf8_env, venv_python, worker_path};
use super::{emit_generate_progress, mark_job_canceled, take_job_canceled};

struct PendingRequest {
    app: Option<AppHandle>,
    tx: oneshot::Sender<Value>,
}

struct WorkerProcess {
    stdin: tokio::sync::Mutex<ChildStdin>,
    child: Mutex<Option<Child>>,
}

struct WorkerManager {
    active: tokio::sync::Mutex<Option<Arc<WorkerProcess>>>,
    pending: Mutex<HashMap<String, PendingRequest>>,
}

static WORKER: Lazy<WorkerManager> = Lazy::new(|| WorkerManager {
    active: tokio::sync::Mutex::new(None),
    pending: Mutex::new(HashMap::new()),
});

impl WorkerManager {
    fn fail_all(&self, message: &str) {
        let mut guard = self.pending.lock().unwrap();
        let drained: Vec<(String, PendingRequest)> = guard.drain().collect();
        drop(guard);
        for (job_id, req) in drained {
            let canceled = take_job_canceled(&job_id);
            let _ = req.tx.send(serde_json::json!({
                "success": false,
                "canceled": canceled,
                "error": if canceled { "Canceled".to_string() } else { message.to_string() },
            }));
        }
    }

    async fn ensure_started(&self, app: &AppHandle) -> Result<Arc<WorkerProcess>, String> {
        let mut active_guard = self.active.lock().await;
        if let Some(proc) = active_guard.as_ref() {
            let alive = {
                let mut child_guard = proc.child.lock().unwrap();
                match child_guard.as_mut() {
                    Some(c) => matches!(c.try_wait(), Ok(None)),
                    None => false,
                }
            };
            if alive {
                return Ok(proc.clone());
            }
        }

        let py = venv_python(app)?;
        let worker = worker_path(app)?;
        let env = utf8_env(app)?;

        let mut child = Command::new(&py)
            .arg("-X")
            .arg("utf8")
            .arg(&worker)
            .arg("serve")
            .envs(env)
            .hidden()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to launch OmniVoice worker: {}", e))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "OmniVoice worker stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "OmniVoice worker stdout unavailable".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "OmniVoice worker stderr unavailable".to_string())?;

        let proc = Arc::new(WorkerProcess {
            stdin: tokio::sync::Mutex::new(stdin),
            child: Mutex::new(Some(child)),
        });

        let stderr_buf = Arc::new(Mutex::new(String::new()));
        let stderr_buf_writer = stderr_buf.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut chunk = [0u8; 1024];
            while let Ok(n) = reader.read(&mut chunk).await {
                if n == 0 {
                    break;
                }
                let text = String::from_utf8_lossy(&chunk[..n]);
                let mut buf = stderr_buf_writer.lock().unwrap();
                buf.push_str(&text);
                if buf.len() > 6000 {
                    let keep: String = buf
                        .chars()
                        .rev()
                        .take(4000)
                        .collect::<String>()
                        .chars()
                        .rev()
                        .collect();
                    *buf = keep;
                }
            }
        });

        let proc_for_reader = proc.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(event) = serde_json::from_str::<Value>(trimmed) else {
                    // Native libraries occasionally print non-JSON banners to stdout.
                    continue;
                };
                let job_id = event
                    .get("jobId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if job_id.is_empty() {
                    continue;
                }
                match event.get("type").and_then(|v| v.as_str()) {
                    Some("progress") => {
                        let app_opt = WORKER
                            .pending
                            .lock()
                            .unwrap()
                            .get(&job_id)
                            .and_then(|p| p.app.clone());
                        if let Some(app_handle) = app_opt {
                            let stage = event
                                .get("stage")
                                .and_then(|v| v.as_str())
                                .unwrap_or("generating");
                            let percent = event.get("percent").and_then(|v| v.as_f64());
                            let message = event
                                .get("message")
                                .and_then(|v| v.as_str())
                                .unwrap_or("Generating speech...");
                            emit_generate_progress(&app_handle, &job_id, stage, percent, message);
                        }
                    }
                    Some("result") => {
                        let removed = WORKER.pending.lock().unwrap().remove(&job_id);
                        if let Some(req) = removed {
                            let _ = req.tx.send(event);
                        }
                    }
                    _ => {}
                }
            }

            // stdout EOF means the worker exited; reap child and fail any in-flight request.
            let exit_code = {
                let mut child_guard = proc_for_reader.child.lock().unwrap();
                child_guard
                    .take()
                    .and_then(|mut c| c.try_wait().ok().flatten())
                    .and_then(|s| s.code())
            };
            {
                let mut active = WORKER.active.lock().await;
                if active
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, &proc_for_reader))
                {
                    *active = None;
                }
            }
            let err_msg = {
                let s = stderr_buf.lock().unwrap();
                let trimmed = s.trim();
                if trimmed.is_empty() {
                    match exit_code {
                        Some(code) => format!("OmniVoice worker exited with code {}", code),
                        None => "OmniVoice worker stopped".to_string(),
                    }
                } else {
                    trimmed.to_string()
                }
            };
            WORKER.fail_all(&err_msg);
        });

        *active_guard = Some(proc.clone());
        Ok(proc)
    }

    async fn request(
        &self,
        app: &AppHandle,
        job_id: &str,
        mut payload: Value,
        emit_events: bool,
    ) -> Value {
        let proc = match self.ensure_started(app).await {
            Ok(p) => p,
            Err(e) => {
                return serde_json::json!({
                    "success": false,
                    "error": e,
                });
            }
        };

        if let Some(obj) = payload.as_object_mut() {
            obj.insert("jobId".to_string(), Value::String(job_id.to_string()));
        }

        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(
            job_id.to_string(),
            PendingRequest {
                app: if emit_events { Some(app.clone()) } else { None },
                tx,
            },
        );

        let line = match serde_json::to_string(&payload) {
            Ok(s) => format!("{}\n", s),
            Err(e) => {
                self.pending.lock().unwrap().remove(job_id);
                return serde_json::json!({ "success": false, "error": e.to_string() });
            }
        };

        let write_res = {
            let mut stdin = proc.stdin.lock().await;
            let res = stdin.write_all(line.as_bytes()).await;
            if res.is_ok() {
                let _ = stdin.flush().await;
            }
            res
        };

        if let Err(e) = write_res {
            self.pending.lock().unwrap().remove(job_id);
            return serde_json::json!({
                "success": false,
                "error": format!("Failed to send request to OmniVoice worker: {}", e),
            });
        }

        match rx.await {
            Ok(val) => val,
            Err(_) => {
                let canceled = take_job_canceled(job_id);
                serde_json::json!({
                    "success": false,
                    "canceled": canceled,
                    "error": if canceled { "Canceled" } else { "OmniVoice worker channel closed" },
                })
            }
        }
    }

    fn stop(&self, job_id: Option<&str>) -> bool {
        if let Some(jid) = job_id {
            let has_job = self.pending.lock().unwrap().contains_key(jid);
            if !has_job {
                return false;
            }
            mark_job_canceled(jid);
        }

        // Kill the running child process synchronously using `start_kill` so
        // both Tauri commands and `RunEvent::ExitRequested` terminate it right away.
        if let Ok(mut active_guard) = self.active.try_lock() {
            if let Some(proc) = active_guard.take() {
                if let Some(mut child) = proc.child.lock().unwrap().take() {
                    let _ = child.start_kill();
                }
            }
        } else {
            // If `ensure_started` currently holds the async mutex, spawn a quick task.
            let jid_owned = job_id.map(str::to_string);
            tokio::spawn(async move {
                let mut active_guard = WORKER.active.lock().await;
                if let Some(proc) = active_guard.take() {
                    let child_opt = { proc.child.lock().unwrap().take() };
                    if let Some(mut child) = child_opt {
                        let _ = child.kill().await;
                    }
                }
                if let Some(jid) = jid_owned {
                    mark_job_canceled(&jid);
                }
                WORKER.fail_all("OmniVoice worker stopped");
            });
            return true;
        }

        self.fail_all("OmniVoice worker stopped");
        true
    }
}

pub async fn worker_request(
    app: &AppHandle,
    job_id: &str,
    payload: Value,
    emit_events: bool,
) -> Value {
    WORKER.request(app, job_id, payload, emit_events).await
}

pub fn stop_worker(job_id: Option<&str>) -> bool {
    WORKER.stop(job_id)
}
