//! CLI Chat Task Runner & Session Manager (`agy` Antigravity CLI & `claude` Claude Code CLI).
//!
//! Spawns `agy` or `claude` processes in the project workspace, manages session resumption
//! and cancellation, and delegates NDJSON stream parsing to `stream_parser`.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use crate::ai_cli::runtime::{build_cli_path_env, detect_cli_path};
use crate::ai_cli::stream_parser::{handle_stream_json_event, StreamParseState};
use crate::ai_cli::workspace::resolve_workspace_dir;
use crate::ai_edit::actions::EditTarget;
use crate::ai_edit::mcp::{self, McpEndpoint};
use crate::process_ext::HiddenConsole;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCliTextPayload {
    pub adapter: String,
    pub prompt: String,
    pub system_prompt: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub session_key: Option<String>,
    pub request_id: Option<String>,
    pub working_directory: Option<String>,
    pub project_name: Option<String>,
    /// Editor and project for the AutoSubs MCP tools; None runs without them.
    pub edit_target: Option<EditTarget>,
    /// Whether the MCP tools may edit the timeline (Turbo) or only read it.
    #[serde(default)]
    pub allow_edits: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCliTextResult {
    pub success: bool,
    pub output_text: String,
    pub session_id: Option<String>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cost_usd: Option<f64>,
    pub canceled: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
struct SessionState {
    adapter: String,
    session_id: String,
}

fn sessions_map() -> &'static Mutex<HashMap<String, SessionState>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, SessionState>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn active_pids() -> &'static Mutex<HashMap<String, Arc<Mutex<Option<u32>>>>> {
    static PIDS: OnceLock<Mutex<HashMap<String, Arc<Mutex<Option<u32>>>>>> = OnceLock::new();
    PIDS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub async fn cli_cancel_text_task(request_id: String) -> Result<bool, String> {
    let pid_opt = {
        let map = active_pids().lock().map_err(|e| e.to_string())?;
        map.get(&request_id)
            .and_then(|arc| arc.lock().ok().and_then(|g| *g))
    };
    if let Some(pid) = pid_opt {
        #[cfg(not(target_os = "windows"))]
        {
            let _ = Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .status();
        }
        #[cfg(target_os = "windows")]
        {
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .status();
        }
        return Ok(true);
    }
    Ok(false)
}

#[tauri::command]
pub async fn cli_run_text_task(
    app: AppHandle,
    payload: RunCliTextPayload,
) -> Result<RunCliTextResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_cli_blocking(&app, payload))
        .await
        .map_err(|e| e.to_string())?
}

fn run_cli_blocking(
    app: &AppHandle,
    payload: RunCliTextPayload,
) -> Result<RunCliTextResult, String> {
    let adapter = payload.adapter.as_str();
    let bin = detect_cli_path(adapter).ok_or_else(|| {
        format!(
            "CLI '{}' chưa được cài đặt hoặc không tìm thấy trong PATH.",
            adapter
        )
    })?;

    let cwd_dir = resolve_workspace_dir(
        app,
        payload.working_directory.as_deref(),
        payload.project_name.as_deref(),
    )?;
    let _ = fs::create_dir_all(&cwd_dir);

    let resume_session_id = payload.session_key.as_ref().and_then(|key| {
        let map = sessions_map().lock().ok()?;
        let st = map.get(key)?;
        if st.adapter == payload.adapter {
            Some(st.session_id.clone())
        } else {
            None
        }
    });

    let request_id = payload
        .request_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let mut args: Vec<String> = Vec::new();
    let mut stdin_text: Option<String> = None;
    let mut prompt_tmp_file: Option<PathBuf> = None;
    let mut mcp_config_file: Option<PathBuf> = None;
    let mcp_endpoint = payload
        .edit_target
        .clone()
        .and_then(|target| mcp::open_session(target, payload.allow_edits));

    match adapter {
        "agy" => {
            let full_prompt = if let Some(sys) = payload
                .system_prompt
                .as_deref()
                .filter(|s| !s.trim().is_empty())
            {
                format!(
                    "<live_editor_context>\n{}\n</live_editor_context>\n\n{}",
                    sys, payload.prompt
                )
            } else {
                payload.prompt.clone()
            };

            args.extend([
                "--output-format".into(),
                "stream-json".into(),
                "--dangerously-skip-permissions".into(),
                "-p".into(),
                full_prompt,
            ]);

            if let Some(m) = payload.model.as_deref().filter(|s| !s.is_empty()) {
                args.extend(["--model".into(), m.to_string()]);
            }
            if let Some(e) = payload.effort.as_deref().filter(|s| !s.is_empty()) {
                args.extend(["--effort".into(), e.to_string()]);
            }
            if let Some(ref sid) = resume_session_id {
                args.extend(["--conversation".into(), sid.clone()]);
            }
            if let Some(ep) = &mcp_endpoint {
                register_agy_mcp(&bin, ep);
            }
        }
        "claude" => {
            args.extend([
                "--output-format".into(),
                "stream-json".into(),
                "--verbose".into(),
                "--print".into(),
                "-".into(),
                "--dangerously-skip-permissions".into(),
            ]);
            if let Some(m) = payload.model.as_deref().filter(|s| !s.is_empty()) {
                args.extend(["--model".into(), m.to_string()]);
            }
            if let Some(e) = payload.effort.as_deref().filter(|s| !s.is_empty()) {
                args.extend(["--effort".into(), e.to_string()]);
            }
            if let Some(ref sid) = resume_session_id {
                args.extend(["--resume".into(), sid.clone()]);
            }
            // Sent on every run, resumed or not: it carries the live timeline,
            // which changes between messages.
            if let Some(sys) = payload
                .system_prompt
                .as_deref()
                .filter(|s| !s.trim().is_empty())
            {
                let tmp = std::env::temp_dir()
                    .join(format!("autosubs-sys-{}.txt", uuid::Uuid::new_v4()));
                if fs::write(&tmp, sys).is_ok() {
                    args.extend([
                        "--append-system-prompt-file".into(),
                        tmp.to_string_lossy().into_owned(),
                    ]);
                    prompt_tmp_file = Some(tmp);
                }
            }
            if let Some(ep) = &mcp_endpoint {
                let tmp = std::env::temp_dir().join(format!("autosubs-mcp-{}.json", ep.session));
                if fs::write(&tmp, claude_mcp_config(ep).to_string()).is_ok() {
                    args.extend(["--mcp-config".into(), tmp.to_string_lossy().into_owned()]);
                    mcp_config_file = Some(tmp);
                }
            }
            stdin_text = Some(payload.prompt.clone());
        }
        other => {
            return Err(format!("Unsupported adapter: {}", other));
        }
    }

    let mut cmd = Command::new(&bin);
    cmd.args(&args)
        .current_dir(&cwd_dir)
        .env("PATH", build_cli_path_env())
        .stdin(if stdin_text.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn {}: {}", bin.display(), e))?;

    let pid_holder = Arc::new(Mutex::new(Some(child.id())));
    if let Ok(mut map) = active_pids().lock() {
        map.insert(request_id.clone(), pid_holder);
    }

    if let Some(text) = stdin_text {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(text.as_bytes());
            let _ = stdin.write_all(b"\n");
        }
    }

    let mut parse_state = StreamParseState {
        result_session_id: resume_session_id,
        ..Default::default()
    };

    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(event) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            handle_stream_json_event(app, adapter, &request_id, &event, &mut parse_state);
        }
    }

    let status = child.wait().ok();
    if let Ok(mut map) = active_pids().lock() {
        map.remove(&request_id);
    }
    if let Some(tmp) = prompt_tmp_file {
        let _ = fs::remove_file(tmp);
    }
    if let Some(tmp) = mcp_config_file {
        let _ = fs::remove_file(tmp);
    }
    if let Some(ep) = &mcp_endpoint {
        mcp::close_session(&ep.session);
    }

    if let (Some(key), Some(sid)) = (payload.session_key, parse_state.result_session_id.clone()) {
        if let Ok(mut map) = sessions_map().lock() {
            map.insert(
                key,
                SessionState {
                    adapter: payload.adapter.clone(),
                    session_id: sid,
                },
            );
        }
    }

    let success = !parse_state.output_text.trim().is_empty() && parse_state.result_error.is_empty();
    let error = if !parse_state.result_error.is_empty() {
        Some(parse_state.result_error)
    } else if !success {
        Some(format!(
            "{} exited without output (status: {:?})",
            adapter,
            status.and_then(|s| s.code())
        ))
    } else {
        None
    };

    Ok(RunCliTextResult {
        success,
        output_text: parse_state.output_text,
        session_id: parse_state.result_session_id,
        input_tokens: if parse_state.input_tokens > 0 {
            Some(parse_state.input_tokens)
        } else {
            None
        },
        output_tokens: if parse_state.output_tokens > 0 {
            Some(parse_state.output_tokens)
        } else {
            None
        },
        cost_usd: if parse_state.cost_usd > 0.0 {
            Some(parse_state.cost_usd)
        } else {
            None
        },
        canceled: false,
        error,
    })
}

/// Name the AutoSubs MCP server is registered under in both CLIs.
const MCP_SERVER_NAME: &str = "autosubs";

/// `--mcp-config` file contents for Claude Code.
fn claude_mcp_config(ep: &McpEndpoint) -> Value {
    serde_json::json!({
        "mcpServers": {
            MCP_SERVER_NAME: {
                "type": "http",
                "url": ep.url,
                "headers": { "Authorization": format!("Bearer {}", ep.token) }
            }
        }
    })
}

/// Antigravity only reads MCP servers from its own config, so point its
/// `autosubs` entry at this run's session ("add" also updates an existing one).
fn register_agy_mcp(bin: &std::path::Path, ep: &McpEndpoint) {
    let status = Command::new(bin)
        .args([
            "mcp",
            "add",
            "--header",
            &format!("Authorization: Bearer {}", ep.token),
            MCP_SERVER_NAME,
            &ep.url,
        ])
        .env("PATH", build_cli_path_env())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .hidden()
        .status();
    if !matches!(status, Ok(s) if s.success()) {
        tracing::warn!("Could not register the AutoSubs MCP server with agy: {:?}", status);
    }
}
