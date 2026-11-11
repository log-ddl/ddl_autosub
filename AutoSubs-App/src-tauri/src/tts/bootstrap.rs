//! Bootstraps and probes the isolated OmniVoice Python `.venv` runtime.

use std::path::Path;
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::process_ext::HiddenConsole;

use super::managed_python::{ensure_managed_python, find_managed_python};
use super::paths::{
    RUNTIME_VERSION, RuntimeMarker, TORCH_CUDA_INDEX, TORCH_VERSION, is_runtime_current,
    omnivoice_resource_dir, runtime_marker_path, runtime_root, source_version, utf8_env, venv_dir,
    venv_python,
};
use super::{emit_install_progress, is_job_canceled, register_canceler, unregister_canceler};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProbe {
    pub backend: String,
    pub torch_version: String,
    pub cuda_build: Option<String>,
}

pub async fn has_nvidia_gpu() -> bool {
    if cfg!(target_os = "macos") {
        return false;
    }
    let Ok(out) = Command::new("nvidia-smi")
        .arg("-L")
        .hidden()
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
    else {
        return false;
    };
    if !out.status.success() {
        return false;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines().any(|line| {
        let lower = line.to_ascii_lowercase();
        lower.contains("gpu ") && lower.chars().any(|c| c.is_ascii_digit())
    })
}

pub async fn is_compatible_python(app: &AppHandle, python: &Path, prefix: &[&str]) -> bool {
    let Ok(env) = utf8_env(app) else {
        return false;
    };
    let mut cmd = Command::new(python);
    cmd.args(prefix)
        .args([
            "-c",
            "import sys; print(int((3, 10) <= sys.version_info[:2] < (3, 14)))",
        ])
        .envs(env)
        .hidden()
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let Ok(out) = cmd.output().await else {
        return false;
    };
    if !out.status.success() {
        return false;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .map(|l| l.trim() == "1")
        .unwrap_or(false)
}

async fn find_system_python(app: &AppHandle) -> Option<(String, Vec<&'static str>)> {
    if let Some(managed) = find_managed_python(app) {
        if is_compatible_python(app, &managed, &[]).await {
            return Some((managed.to_string_lossy().into_owned(), Vec::new()));
        }
    }

    // On macOS, `/usr/bin/python3` is an Apple stub that pops up a system dialog
    // asking to install Xcode Command Line Tools on non-developer Macs. Only
    // check explicit Python 3.10-3.12 binaries on PATH (e.g. Homebrew/python.org)
    // and otherwise let `uv` install a private Python 3.12 cleanly.
    let candidates: &[(&str, &[&str])] = if cfg!(windows) {
        &[("py", &["-3.12"]), ("py", &["-3"]), ("python", &[])]
    } else if cfg!(target_os = "macos") {
        &[
            ("python3.12", &[]),
            ("python3.11", &[]),
            ("python3.10", &[]),
        ]
    } else {
        &[
            ("python3.12", &[]),
            ("python3.11", &[]),
            ("python3.10", &[]),
            ("python3", &[]),
            ("python", &[]),
        ]
    };

    for (bin, prefix) in candidates {
        if is_compatible_python(app, Path::new(bin), prefix).await {
            return Some(((*bin).to_string(), prefix.to_vec()));
        }
    }
    None
}

pub async fn probe_runtime(app: &AppHandle) -> Option<RuntimeProbe> {
    let py = venv_python(app).ok()?;
    if !py.is_file() {
        return None;
    }
    let env = utf8_env(app).ok()?;
    let script = concat!(
        "import json, torch; ",
        "backend = 'cuda' if torch.cuda.is_available() else (",
        "'xpu' if hasattr(torch, 'xpu') and torch.xpu.is_available() else (",
        "'mps' if hasattr(torch.backends, 'mps') and torch.backends.mps.is_available() else 'cpu')); ",
        "print(json.dumps({'backend': backend, 'torchVersion': torch.__version__, 'cudaBuild': torch.version.cuda}))"
    );
    let out = Command::new(&py)
        .args(["-X", "utf8", "-c", script])
        .envs(env)
        .hidden()
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let last_line = String::from_utf8_lossy(&out.stdout)
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())?
        .trim()
        .to_string();
    serde_json::from_str::<RuntimeProbe>(&last_line).ok()
}

fn parse_hf_percent(line: &str) -> Option<f64> {
    let idx = line.find("%|")?;
    let prefix = &line[..idx];
    let digits: String = prefix
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    let pct: f64 = digits.parse().ok()?;
    if pct <= 100.0 {
        Some((50.0 + (pct * 0.45).round()).min(95.0))
    } else {
        None
    }
}

fn tail_chars(s: &str, max_chars: usize) -> String {
    let count = s.chars().count();
    if count <= max_chars {
        s.to_string()
    } else {
        s.chars().skip(count - max_chars).collect()
    }
}

pub async fn run_step(
    app: &AppHandle,
    job_id: &str,
    command: &str,
    args: &[String],
    stage: &str,
    percent: f64,
) -> Result<(), String> {
    if is_job_canceled(job_id) {
        return Err("Canceled".to_string());
    }
    emit_install_progress(app, job_id, stage, Some(percent), stage);

    let root = runtime_root(app)?;
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let env = utf8_env(app)?;

    let mut child = Command::new(command)
        .args(args)
        .current_dir(&root)
        .envs(env)
        .hidden()
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start {}: {}", stage, e))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let app_out = app.clone();
    let job_out = job_id.to_string();
    let stage_out = stage.to_string();
    let stdout_task = tokio::spawn(async move {
        if let Some(out) = stdout {
            let mut reader = BufReader::new(out).lines();
            while let Ok(Some(raw)) = reader.next_line().await {
                let line = raw.trim();
                if line.is_empty() {
                    continue;
                }
                if let Ok(ev) = serde_json::from_str::<Value>(line) {
                    if ev.get("type").and_then(|v| v.as_str()) == Some("progress") {
                        let p = ev
                            .get("percent")
                            .and_then(|v| v.as_f64())
                            .unwrap_or(percent);
                        let msg = ev.get("message").and_then(|v| v.as_str()).unwrap_or(line);
                        emit_install_progress(&app_out, &job_out, &stage_out, Some(p), msg);
                        continue;
                    }
                }
                emit_install_progress(
                    &app_out,
                    &job_out,
                    &stage_out,
                    Some(percent),
                    &tail_chars(line, 500),
                );
            }
        }
    });

    let app_err = app.clone();
    let job_err = job_id.to_string();
    let stage_err = stage.to_string();
    let is_model_download = stage == "model.download";
    let stderr_task = tokio::spawn(async move {
        let mut collected = String::new();
        if let Some(err) = stderr {
            let mut reader = BufReader::new(err);
            let mut buf = Vec::new();
            let mut byte = [0u8; 1];
            // Read both '\n' and '\r' chunks so tqdm progress bars stream live.
            use tokio::io::AsyncReadExt;
            loop {
                match reader.read(&mut byte).await {
                    Ok(0) | Err(_) => {
                        if !buf.is_empty() {
                            let line = String::from_utf8_lossy(&buf).trim().to_string();
                            if !line.is_empty() {
                                collected.push_str(&line);
                                collected.push('\n');
                            }
                        }
                        break;
                    }
                    Ok(_) => {
                        if byte[0] == b'\n' || byte[0] == b'\r' {
                            let line = String::from_utf8_lossy(&buf).trim().to_string();
                            buf.clear();
                            if !line.is_empty() {
                                let live_pct = if is_model_download {
                                    parse_hf_percent(&line).unwrap_or(percent)
                                } else {
                                    percent
                                };
                                emit_install_progress(
                                    &app_err,
                                    &job_err,
                                    &stage_err,
                                    Some(live_pct),
                                    &tail_chars(&line, 500),
                                );
                                collected.push_str(&line);
                                collected.push('\n');
                                if collected.len() > 8000 {
                                    collected = tail_chars(&collected, 4000);
                                }
                            }
                        } else {
                            buf.push(byte[0]);
                        }
                    }
                }
            }
        }
        collected
    });

    let cancel_rx = register_canceler(job_id);
    let wait_res = tokio::select! {
        status = child.wait() => Some(status),
        _ = cancel_rx => {
            let _ = child.kill().await;
            None
        }
    };
    unregister_canceler(job_id);

    let _ = stdout_task.await;
    let stderr_tail = stderr_task.await.unwrap_or_default();

    match wait_res {
        None => Err("Canceled".to_string()),
        Some(Ok(status)) if status.success() => Ok(()),
        Some(Ok(status)) => {
            if is_job_canceled(job_id) {
                return Err("Canceled".to_string());
            }
            let detail = tail_chars(stderr_tail.trim(), 2500);
            if detail.is_empty() {
                Err(format!(
                    "{} failed (code {})",
                    stage,
                    status.code().unwrap_or(-1)
                ))
            } else {
                Err(detail)
            }
        }
        Some(Err(e)) => Err(format!("{} failed: {}", stage, e)),
    }
}

pub async fn ensure_runtime(app: &AppHandle, job_id: &str) -> Result<(), String> {
    let root = runtime_root(app)?;
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;

    let py_venv = venv_python(app)?;
    let venv = venv_dir(app)?;

    if py_venv.is_file() && !is_compatible_python(app, &py_venv, &[]).await {
        emit_install_progress(
            app,
            job_id,
            "runtime.venv",
            Some(2.0),
            "Replacing incompatible Python virtual environment with Python 3.12...",
        );
        let _ = std::fs::remove_dir_all(&venv);
    }

    if !py_venv.is_file() {
        let (python_cmd, prefix) = match find_system_python(app).await {
            Some((cmd, pref)) => (cmd, pref),
            None => {
                let managed = ensure_managed_python(app, job_id).await?;
                (managed.to_string_lossy().into_owned(), Vec::new())
            }
        };
        let mut args: Vec<String> = prefix.into_iter().map(String::from).collect();
        args.extend([
            "-m".to_string(),
            "venv".to_string(),
            venv.to_string_lossy().into_owned(),
        ]);
        run_step(app, job_id, &python_cmd, &args, "runtime.venv", 10.0).await?;
    }

    let py_str = py_venv.to_string_lossy().into_owned();

    if !is_runtime_current(app) {
        run_step(
            app,
            job_id,
            &py_str,
            &[
                "-m".into(),
                "pip".into(),
                "install".into(),
                "--disable-pip-version-check".into(),
                "--upgrade".into(),
                "pip".into(),
            ],
            "runtime.pip",
            14.0,
        )
        .await?;

        let mut torch_args = vec![
            "-m".to_string(),
            "pip".to_string(),
            "install".to_string(),
            "--disable-pip-version-check".to_string(),
            format!("torch=={}", TORCH_VERSION),
            format!("torchaudio=={}", TORCH_VERSION),
        ];
        if has_nvidia_gpu().await {
            torch_args.push("--index-url".to_string());
            torch_args.push(TORCH_CUDA_INDEX.to_string());
        }
        run_step(
            app,
            job_id,
            &py_str,
            &torch_args,
            "runtime.accelerator",
            22.0,
        )
        .await?;

        run_step(
            app,
            job_id,
            &py_str,
            &[
                "-m".into(),
                "pip".into(),
                "install".into(),
                "--disable-pip-version-check".into(),
                "transformers==5.3.0".into(),
                "accelerate".into(),
                "huggingface-hub>=0.34,<2".into(),
                "pydub".into(),
                "numpy".into(),
                "soundfile>=0.12".into(),
                "librosa".into(),
                "num2words".into(),
            ],
            "runtime.dependencies",
            35.0,
        )
        .await?;
    }

    let nvidia_available = has_nvidia_gpu().await;
    let mut probe = probe_runtime(app).await;
    if nvidia_available && probe.as_ref().map(|p| p.backend.as_str()) != Some("cuda") {
        run_step(
            app,
            job_id,
            &py_str,
            &[
                "-m".into(),
                "pip".into(),
                "install".into(),
                "--disable-pip-version-check".into(),
                "--force-reinstall".into(),
                format!("torch=={}", TORCH_VERSION),
                format!("torchaudio=={}", TORCH_VERSION),
                "--index-url".into(),
                TORCH_CUDA_INDEX.into(),
            ],
            "runtime.accelerator",
            38.0,
        )
        .await?;
        probe = probe_runtime(app).await;
    }

    let probe = probe.ok_or_else(|| "Could not verify OmniVoice Python runtime".to_string())?;
    if nvidia_available && probe.backend != "cuda" {
        return Err("Could not enable CUDA acceleration for OmniVoice runtime".to_string());
    }

    let src_dir = omnivoice_resource_dir(app)?;
    let marker = RuntimeMarker {
        version: Some(RUNTIME_VERSION),
        source_version: Some(source_version(&src_dir)),
        torch: Some(probe.torch_version),
        backend: Some(probe.backend),
    };
    let marker_json = serde_json::to_string_pretty(&marker).map_err(|e| e.to_string())?;
    std::fs::write(runtime_marker_path(app)?, marker_json).map_err(|e| e.to_string())?;
    Ok(())
}
