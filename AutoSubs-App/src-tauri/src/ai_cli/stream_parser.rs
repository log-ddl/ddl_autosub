//! NDJSON Stream Parser & Tool/Thinking Step Formatter for `agy` and `claude` CLIs.
//!
//! Parses real-time `stream-json` lines emitted by `agy` (Antigravity CLI) and
//! `claude` (Claude Code CLI), extracts tool invocations, parameters, thinking tokens,
//! and emits structured `cli-chat-event` payloads to the frontend.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStreamEvent {
    pub request_id: String,
    pub event_type: String,
    pub chunk: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Default)]
pub struct StreamParseState {
    pub output_text: String,
    pub result_session_id: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
    pub result_error: String,
    pub claude_step_counter: usize,
    pub claude_tools_by_id: HashMap<String, String>,
}

fn shorten_path_str(raw: &str) -> String {
    let normalized = raw.replace('\\', "/");
    let parts: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() <= 2 {
        return normalized;
    }
    format!("…/{}/{}", parts[parts.len() - 2], parts[parts.len() - 1])
}

fn truncate_inline(raw: &str, max_chars: usize) -> String {
    let single = raw.replace(['\n', '\r'], " ").trim().to_string();
    if single.chars().count() <= max_chars {
        single
    } else {
        let prefix: String = single.chars().take(max_chars).collect();
        format!("{}…", prefix.trim_end())
    }
}

/// Extract rich, human-readable step information from an `agy` `step_update` JSON object.
/// Format emitted: `"{state}#{step_index}:{tool_name}||{detail}{dur}"`
pub fn format_agy_step_update(su: &Value) -> Option<String> {
    let step_type = su.get("step_type").and_then(|v| v.as_str()).unwrap_or("");
    if step_type.is_empty() || step_type == "user_input" {
        return None;
    }

    let step_index = su.get("step_index").and_then(|v| v.as_u64()).unwrap_or(0);
    let state = su
        .get("state")
        .and_then(|v| v.as_str())
        .unwrap_or("ACTIVE");
    let dur = su
        .get("duration_seconds")
        .and_then(|v| v.as_f64())
        .filter(|&d| d >= 0.01)
        .map(|d| format!(" ({:.1}s)", d))
        .unwrap_or_default();

    // If `agent_response` finished without `text_delta`, it was an internal reasoning/planning turn!
    if step_type == "agent_response" {
        let has_text = su
            .get("text_delta")
            .and_then(|v| v.as_str())
            .map(|s| !s.is_empty())
            .unwrap_or(false);
        if !has_text && state == "DONE" {
            let think_tokens = su
                .get("usage")
                .and_then(|u| u.get("thinking_tokens"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let detail = if think_tokens > 0 {
                format!("Suy luận & lập kế hoạch ({} thinking tokens)", think_tokens)
            } else {
                "Suy luận & phân tích ngữ cảnh".to_string()
            };
            return Some(format!("DONE#{}:thinking||{}{}", step_index, detail, dur));
        }
        return None;
    }

    let tool_name = su
        .get("tool_name")
        .and_then(|v| v.as_str())
        .or_else(|| {
            su.get("tool_info")
                .and_then(|ti| ti.get("name"))
                .and_then(|v| v.as_str())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or(step_type);

    // agy reaches MCP tools through one generic `call_mcp_tool`; name the
    // actual tool ("autosubs/add_marker") so the step says what it does.
    let params = su.get("tool_info").and_then(|ti| ti.get("parameters"));
    let mcp_tool = (tool_name == "call_mcp_tool")
        .then(|| params)
        .flatten()
        .and_then(|p| {
            let server = p.get("ServerName")?.as_str()?;
            let tool = p.get("ToolName")?.as_str()?;
            Some(format!("{}/{}", server, tool))
        });
    let tool_name = mcp_tool.as_deref().unwrap_or(tool_name);

    let mut detail = String::new();
    if let Some(params) = su.get("tool_info").and_then(|ti| ti.get("parameters")) {
        if let Some(p) = params
            .get("AbsolutePath")
            .or_else(|| params.get("TargetFile"))
            .or_else(|| params.get("DirectoryPath"))
            .or_else(|| params.get("SearchPath"))
            .or_else(|| params.get("file_path"))
            .or_else(|| params.get("path"))
            .and_then(|v| v.as_str())
        {
            detail = shorten_path_str(p);
        } else if let Some(cmd) = params
            .get("CommandLine")
            .or_else(|| params.get("command"))
            .and_then(|v| v.as_str())
        {
            detail = truncate_inline(cmd, 60);
        } else if let Some(q) = params
            .get("Query")
            .or_else(|| params.get("query"))
            .or_else(|| params.get("Pattern"))
            .and_then(|v| v.as_str())
        {
            detail = format!("\"{}\"", truncate_inline(q, 45));
        } else if let Some(url) = params
            .get("Url")
            .or_else(|| params.get("url"))
            .and_then(|v| v.as_str())
        {
            detail = truncate_inline(url, 55);
        } else if let Some(desc) = params
            .get("Description")
            .or_else(|| params.get("Instruction"))
            .or_else(|| params.get("toolSummary"))
            .and_then(|v| v.as_str())
        {
            detail = truncate_inline(desc, 55);
        }
    }

    Some(format!(
        "{}#{}:{}||{}{}",
        state, step_index, tool_name, detail, dur
    ))
}

pub fn format_claude_tool_use(block: &Value, index: usize) -> Option<String> {
    let name = block.get("name").and_then(|v| v.as_str())?;
    let id = block
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| index.to_string());
    let mut detail = String::new();
    if let Some(inp) = block.get("input") {
        if let Some(p) = inp
            .get("file_path")
            .or_else(|| inp.get("path"))
            .and_then(|v| v.as_str())
        {
            detail = shorten_path_str(p);
        } else if let Some(cmd) = inp.get("command").and_then(|v| v.as_str()) {
            detail = truncate_inline(cmd, 60);
        } else if let Some(pat) = inp
            .get("pattern")
            .or_else(|| inp.get("query"))
            .and_then(|v| v.as_str())
        {
            detail = format!("\"{}\"", truncate_inline(pat, 45));
        } else if let Some(desc) = inp.get("description").and_then(|v| v.as_str()) {
            detail = truncate_inline(desc, 55);
        }
    }
    Some(format!("ACTIVE#{}:{}||{}", id, name, detail))
}

pub fn handle_stream_json_event(
    app: &AppHandle,
    adapter: &str,
    request_id: &str,
    event: &Value,
    state: &mut StreamParseState,
) {
    match adapter {
        "agy" => handle_agy_event(app, request_id, event, state),
        "claude" => handle_claude_event(app, request_id, event, state),
        _ => {}
    }
}

fn handle_agy_event(
    app: &AppHandle,
    request_id: &str,
    event: &Value,
    state: &mut StreamParseState,
) {
    if let Some(cid) = event.get("conversation_id").and_then(|v| v.as_str()) {
        state.result_session_id = Some(cid.to_string());
    }
    let ev_type = event.get("event").and_then(|v| v.as_str()).unwrap_or("");
    if ev_type == "step_update" {
        if let Some(su) = event.get("step_update") {
            if let Some(cid) = su.get("conversation_id").and_then(|v| v.as_str()) {
                state.result_session_id = Some(cid.to_string());
            }
            let step_type = su.get("step_type").and_then(|v| v.as_str()).unwrap_or("");

            if let Some(think) = su
                .get("thinking_delta")
                .or_else(|| su.get("thinking"))
                .and_then(|v| v.as_str())
            {
                if !think.is_empty() {
                    let _ = app.emit(
                        "cli-chat-event",
                        CliStreamEvent {
                            request_id: request_id.to_string(),
                            event_type: "thinking".into(),
                            chunk: Some(think.to_string()),
                            session_id: state.result_session_id.clone(),
                        },
                    );
                }
            }

            if step_type == "agent_response" {
                if let Some(delta) = su.get("text_delta").and_then(|v| v.as_str()) {
                    if !delta.is_empty() {
                        state.output_text.push_str(delta);
                        let _ = app.emit(
                            "cli-chat-event",
                            CliStreamEvent {
                                request_id: request_id.to_string(),
                                event_type: "chunk".into(),
                                chunk: Some(delta.to_string()),
                                session_id: state.result_session_id.clone(),
                            },
                        );
                    }
                }
            }

            if let Some(step_label) = format_agy_step_update(su) {
                let _ = app.emit(
                    "cli-chat-event",
                    CliStreamEvent {
                        request_id: request_id.to_string(),
                        event_type: "step".into(),
                        chunk: Some(step_label),
                        session_id: state.result_session_id.clone(),
                    },
                );
            }
        }
    } else if ev_type == "result" {
        if let Some(res_obj) = event.get("result") {
            if let Some(cid) = res_obj.get("conversation_id").and_then(|v| v.as_str()) {
                state.result_session_id = Some(cid.to_string());
            }
            if state.output_text.trim().is_empty() {
                if let Some(resp) = res_obj.get("response").and_then(|v| v.as_str()) {
                    state.output_text = resp.to_string();
                }
            }
            if let Some(usage) = res_obj.get("usage") {
                state.input_tokens = usage
                    .get("input_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                state.output_tokens = usage
                    .get("output_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
            }
            let st = res_obj
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("SUCCESS");
            if st != "SUCCESS" {
                state.result_error = res_obj
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Antigravity CLI error")
                    .to_string();
            }
        }
    }
}

fn handle_claude_event(
    app: &AppHandle,
    request_id: &str,
    event: &Value,
    state: &mut StreamParseState,
) {
    let ev_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if ev_type == "system" && event.get("subtype").and_then(|v| v.as_str()) == Some("init") {
        if let Some(sid) = event.get("session_id").and_then(|v| v.as_str()) {
            state.result_session_id = Some(sid.to_string());
        }
    } else if ev_type == "assistant" {
        if let Some(arr) = event
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
        {
            for block in arr {
                let btype = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if btype == "text" {
                    if let Some(txt) = block.get("text").and_then(|v| v.as_str()) {
                        state.output_text.push_str(txt);
                        let _ = app.emit(
                            "cli-chat-event",
                            CliStreamEvent {
                                request_id: request_id.to_string(),
                                event_type: "chunk".into(),
                                chunk: Some(txt.to_string()),
                                session_id: state.result_session_id.clone(),
                            },
                        );
                    }
                } else if btype == "thinking" {
                    if let Some(think) = block.get("thinking").and_then(|v| v.as_str()) {
                        let _ = app.emit(
                            "cli-chat-event",
                            CliStreamEvent {
                                request_id: request_id.to_string(),
                                event_type: "thinking".into(),
                                chunk: Some(think.to_string()),
                                session_id: state.result_session_id.clone(),
                            },
                        );
                    }
                } else if btype == "tool_use" {
                    state.claude_step_counter += 1;
                    if let Some(step_label) =
                        format_claude_tool_use(block, state.claude_step_counter)
                    {
                        if let Some(id) = block.get("id").and_then(|v| v.as_str()) {
                            if let Some(rest) = step_label.strip_prefix("ACTIVE#") {
                                state
                                    .claude_tools_by_id
                                    .insert(id.to_string(), rest.to_string());
                            }
                        }
                        let _ = app.emit(
                            "cli-chat-event",
                            CliStreamEvent {
                                request_id: request_id.to_string(),
                                event_type: "step".into(),
                                chunk: Some(step_label),
                                session_id: state.result_session_id.clone(),
                            },
                        );
                    }
                }
            }
        }
    } else if ev_type == "user" {
        if let Some(arr) = event
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
        {
            for block in arr {
                if block.get("type").and_then(|v| v.as_str()) == Some("tool_result") {
                    if let Some(tid) = block.get("tool_use_id").and_then(|v| v.as_str()) {
                        if let Some(rest) = state.claude_tools_by_id.get(tid) {
                            let _ = app.emit(
                                "cli-chat-event",
                                CliStreamEvent {
                                    request_id: request_id.to_string(),
                                    event_type: "step".into(),
                                    chunk: Some(format!("DONE#{}", rest)),
                                    session_id: state.result_session_id.clone(),
                                },
                            );
                        }
                    }
                }
            }
        }
    } else if ev_type == "result" {
        if let Some(sid) = event.get("session_id").and_then(|v| v.as_str()) {
            state.result_session_id = Some(sid.to_string());
        }
        if let Some(usage) = event.get("usage") {
            state.input_tokens = usage
                .get("input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0)
                + usage
                    .get("cache_read_input_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
            state.output_tokens = usage
                .get("output_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
        }
        state.cost_usd = event
            .get("total_cost_usd")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        if event
            .get("is_error")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            state.result_error = event
                .get("result")
                .and_then(|v| v.as_str())
                .unwrap_or("Claude CLI error")
                .to_string();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn names_the_mcp_tool_behind_call_mcp_tool() {
        // Shape of an agy step_update, captured from a real run.
        let su = json!({
            "step_index": 4, "state": "DONE", "step_type": "tool", "tool_name": "call_mcp_tool",
            "duration_seconds": 1.8,
            "tool_info": { "name": "call_mcp_tool",
                           "parameters": { "Arguments": {}, "ServerName": "autosubs", "ToolName": "get_timeline" } }
        });
        let step = format_agy_step_update(&su).unwrap();
        assert!(step.starts_with("DONE#4:autosubs/get_timeline||"), "{}", step);
    }
}
