//! Transport for the AI Edit MCP server.
//!
//! Speaks the MCP "streamable HTTP" transport in its simplest form: every
//! JSON-RPC request is a POST answered with a single JSON body (no SSE).
//! It listens on 127.0.0.1 on a random port and requires a bearer token that
//! is generated per app run, so other local processes cannot drive it.
//!
//! Each agent run gets its own session path (`/mcp/<session>`) bound to one
//! editor and project, and to whether it may edit. Tool schemas come from
//! `mcp::tools`; tool calls run through `actions::execute`. Every tool
//! answers with a text outcome or an error, which is how the agent learns
//! whether an edit worked and can correct itself.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::ai_edit::actions::{execute, timeline_snapshot, ActionOutcome, EditTarget, TimelineAction};
use crate::ai_edit::mcp::tools::{media, motion};
use crate::ai_edit::mcp::tools::transcript::{get_transcript, transcripts_dir, TranscriptArgs};
use crate::ai_edit::mcp::tools::tool_definitions;

/// Event the UI listens to so it can refresh and toast after an agent edit.
pub const TIMELINE_CHANGED_EVENT: &str = "ai-edit-timeline-changed";

const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;

/// Most edits one `apply_actions` call may carry.
const MAX_BATCH_ACTIONS: usize = 100;

struct Server {
    port: u16,
    token: String,
}

#[derive(Clone)]
struct Session {
    target: EditTarget,
    allow_edits: bool,
    /// The run's project workspace, where the download tools save files.
    workspace: Option<PathBuf>,
}

/// Where an agent run reaches the server: URL plus the Authorization header.
#[derive(Debug, Clone)]
pub struct McpEndpoint {
    pub session: String,
    pub url: String,
    pub token: String,
}

fn server() -> &'static OnceLock<Server> {
    static SERVER: OnceLock<Server> = OnceLock::new();
    &SERVER
}

fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn app_handle() -> &'static OnceLock<AppHandle> {
    static APP: OnceLock<AppHandle> = OnceLock::new();
    &APP
}

/// Start the server in the background. Safe to call once at app startup.
pub fn start(app: AppHandle) {
    let _ = app_handle().set(app);
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::bind("127.0.0.1:0").await {
            Ok(l) => l,
            Err(e) => {
                tracing::warn!("AI Edit MCP server could not bind: {}", e);
                return;
            }
        };
        let port = match listener.local_addr() {
            Ok(addr) => addr.port(),
            Err(e) => {
                tracing::warn!("AI Edit MCP server has no local address: {}", e);
                return;
            }
        };
        let _ = server().set(Server { port, token: uuid::Uuid::new_v4().simple().to_string() });
        tracing::info!("AI Edit MCP server listening on 127.0.0.1:{}", port);
        open_debug_session();
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                continue;
            };
            tauri::async_runtime::spawn(async move {
                if let Err(e) = serve_connection(stream).await {
                    tracing::debug!("AI Edit MCP connection error: {}", e);
                }
            });
        }
    });
}

/// Dev builds only: with `AUTOSUBS_MCP_DEBUG` set, open a read-only CapCut
/// session whose workspace is `<temp>/autosubs-mcp-debug` and print how to
/// reach it, so the tools can be called with curl without an agent run.
fn open_debug_session() {
    if !cfg!(debug_assertions) || std::env::var_os("AUTOSUBS_MCP_DEBUG").is_none() {
        return;
    }
    let workspace = std::env::temp_dir().join("autosubs-mcp-debug");
    let _ = std::fs::create_dir_all(&workspace);
    let target = EditTarget { editor: crate::ai_edit::actions::Editor::Capcut, draft_id: None, transcript_file: None };
    if let Some(ep) = open_session(target, false, Some(workspace.clone())) {
        println!("[mcp-debug] url={} token={} workspace={}", ep.url, ep.token, workspace.display());
    }
}

/// Register a session for one agent run. None if the server is not running.
pub fn open_session(target: EditTarget, allow_edits: bool, workspace: Option<PathBuf>) -> Option<McpEndpoint> {
    let srv = server().get()?;
    let session = uuid::Uuid::new_v4().simple().to_string();
    sessions().lock().ok()?.insert(session.clone(), Session { target, allow_edits, workspace });
    Some(McpEndpoint {
        url: format!("http://127.0.0.1:{}/mcp/{}", srv.port, session),
        token: srv.token.clone(),
        session,
    })
}

pub fn close_session(session: &str) {
    if let Ok(mut map) = sessions().lock() {
        map.remove(session);
    }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

struct HttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

async fn read_request(stream: &mut TcpStream) -> Result<HttpRequest, String> {
    let mut buf = Vec::with_capacity(8192);
    let mut chunk = [0u8; 8192];
    let header_end = loop {
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos;
        }
        if buf.len() > 64 * 1024 {
            return Err("headers too large".into());
        }
        let n = stream.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("connection closed".into());
        }
        buf.extend_from_slice(&chunk[..n]);
    };

    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split_whitespace();
    let method = first.next().unwrap_or("").to_string();
    let path = first.next().unwrap_or("").to_string();
    let headers: HashMap<String, String> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();

    let content_length: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    if content_length > MAX_REQUEST_BYTES {
        return Err("request too large".into());
    }
    let mut body = buf[header_end + 4..].to_vec();
    while body.len() < content_length {
        let n = stream.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(content_length);
    Ok(HttpRequest { method, path, headers, body })
}

async fn respond(stream: &mut TcpStream, status: &str, body: Option<&Value>) -> Result<(), String> {
    let payload = body.map(|b| b.to_string()).unwrap_or_default();
    let content_type = if body.is_some() { "Content-Type: application/json\r\n" } else { "" };
    let head = format!(
        "HTTP/1.1 {}\r\n{}Content-Length: {}\r\nConnection: close\r\n\r\n",
        status,
        content_type,
        payload.len()
    );
    stream.write_all(head.as_bytes()).await.map_err(|e| e.to_string())?;
    stream.write_all(payload.as_bytes()).await.map_err(|e| e.to_string())?;
    stream.flush().await.map_err(|e| e.to_string())
}

async fn serve_connection(mut stream: TcpStream) -> Result<(), String> {
    let req = read_request(&mut stream).await?;

    let Some(srv) = server().get() else {
        return respond(&mut stream, "503 Service Unavailable", None).await;
    };
    let authorized = req
        .headers
        .get("authorization")
        .is_some_and(|v| v == &format!("Bearer {}", srv.token));
    if !authorized {
        return respond(&mut stream, "401 Unauthorized", None).await;
    }

    let session_id = req.path.strip_prefix("/mcp/").unwrap_or("").split('?').next().unwrap_or("");
    let session = sessions().lock().ok().and_then(|m| m.get(session_id).cloned());
    let Some(session) = session else {
        return respond(&mut stream, "404 Not Found", None).await;
    };

    match req.method.as_str() {
        "POST" => {}
        // No server-initiated stream and nothing to tear down per session.
        "DELETE" => return respond(&mut stream, "200 OK", None).await,
        _ => return respond(&mut stream, "405 Method Not Allowed", None).await,
    }

    let message: Value = match serde_json::from_slice(&req.body) {
        Ok(v) => v,
        Err(e) => {
            let err = rpc_error(Value::Null, -32700, &format!("Parse error: {}", e));
            return respond(&mut stream, "400 Bad Request", Some(&err)).await;
        }
    };

    let reply = if let Some(batch) = message.as_array() {
        let mut out = Vec::new();
        for m in batch {
            if let Some(r) = handle_message(&session, m).await {
                out.push(r);
            }
        }
        (!out.is_empty()).then(|| Value::Array(out))
    } else {
        handle_message(&session, &message).await
    };

    match reply {
        Some(body) => respond(&mut stream, "200 OK", Some(&body)).await,
        None => respond(&mut stream, "202 Accepted", None).await,
    }
}

// ---------------------------------------------------------------------------
// JSON-RPC / MCP
// ---------------------------------------------------------------------------

fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Handle one message; notifications (no id) get no reply.
async fn handle_message(session: &Session, msg: &Value) -> Option<Value> {
    let id = msg.get("id").cloned()?;
    let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    Some(match method {
        "initialize" => {
            let version = params
                .get("protocolVersion")
                .and_then(|v| v.as_str())
                .unwrap_or("2025-03-26")
                .to_string();
            rpc_result(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "autosubs", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": instructions(session),
                }),
            )
        }
        "ping" => rpc_result(id, json!({})),
        "tools/list" => {
            let mut tools = tool_definitions(session.target.editor, session.allow_edits);
            if session.workspace.is_some() {
                tools.extend(media::tools());
                tools.extend(motion::tools());
            }
            rpc_result(id, json!({ "tools": tools }))
        }
        "tools/call" => {
            let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            rpc_result(id, call_tool(session, name, args).await)
        }
        _ => rpc_error(id, -32601, &format!("Method not found: {}", method)),
    })
}

fn instructions(session: &Session) -> String {
    let mut s = format!(
        "Timeline tools for the {} project this conversation is bound to. Times are seconds from the \
         start of the timeline. Call get_timeline to see clip ids and get_transcript to see what is said \
         (with word timings for precise cuts), then edit; every edit tool reports \
         what it did, so read the result and fix anything that failed.",
        session.target.editor.display_name()
    );
    if session.workspace.is_some() {
        s.push_str(
            " inspect_media, download_media, save_article and remove_background fetch videos, web \
             articles and remove image backgrounds into the project workspace (ai-broll/, articles/); \
             download_media and remove_background return paths build_storyboard takes. \
             render_motion renders a Remotion project from motion-graphics/ into exports/ and waits \
             for the file.",
        );
    }
    if !session.allow_edits {
        s.push_str(
            " This run is read-only (Manual mode): the timeline cannot be edited, only read; the \
             download tools still work.",
        );
    }
    s
}

fn tool_text(text: impl Into<String>, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text.into() }], "isError": is_error })
}

async fn call_tool(session: &Session, name: &str, args: Value) -> Value {
    if name == "get_timeline" {
        return match timeline_snapshot(&session.target).await {
            Ok(snapshot) => tool_text(snapshot.to_string(), false),
            Err(e) => tool_text(e, true),
        };
    }
    if name == "get_transcript" {
        let args = if args.is_object() { args } else { json!({}) };
        let parsed: TranscriptArgs = match serde_json::from_value(args) {
            Ok(a) => a,
            Err(e) => return tool_text(format!("Invalid arguments for get_transcript: {}", e), true),
        };
        let Some(app) = app_handle().get() else {
            return tool_text("The app is not ready yet; retry.", true);
        };
        return match transcripts_dir(app).and_then(|dir| get_transcript(&dir, &session.target, &parsed)) {
            Ok(text) => tool_text(text, false),
            Err(e) => tool_text(e, true),
        };
    }

    if let Some(app) = app_handle().get() {
        let workspace = session.workspace.as_deref();
        let result = match media::call(app, workspace, name, &args).await {
            Some(r) => Some(r),
            None => motion::call(app, workspace, name, &args).await,
        };
        if let Some(result) = result {
            return match result {
                Ok(text) => tool_text(text, false),
                Err(e) => tool_text(e, true),
            };
        }
    }

    if name != "apply_actions" && edit_action_name(name).is_none() {
        return tool_text(format!("Unknown tool: {}", name), true);
    }
    if !session.allow_edits {
        return tool_text(
            "This conversation is in Manual mode, so the agent cannot edit the timeline. Describe the \
             change in a ```timeline-action block instead; the user applies it.",
            true,
        );
    }
    let result = if name == "apply_actions" {
        apply_actions(session, args).await
    } else {
        match parse_edit(name, args) {
            Ok(action) => execute(&session.target, action).await,
            Err(e) => Err(e),
        }
    };
    if let Some(app) = app_handle().get() {
        let _ = app.emit(
            TIMELINE_CHANGED_EVENT,
            json!({
                "integration": session.target.editor,
                "tool": name,
                "ok": result.is_ok(),
                "message": match &result { Ok(o) => o.message.clone(), Err(e) => e.clone() },
                "partial": result.as_ref().map(|o| o.partial).unwrap_or(false),
            }),
        );
    }
    match result {
        Ok(outcome) => {
            let mut text = outcome.message;
            for line in outcome.lines {
                text.push_str("\n- ");
                text.push_str(&line);
            }
            tool_text(text, false)
        }
        Err(e) => tool_text(e, true),
    }
}

/// The `TimelineAction` tag behind an edit tool's name.
fn edit_action_name(tool: &str) -> Option<&'static str> {
    Some(match tool {
        "build_storyboard" => "build_storyboard",
        "add_marker" => "add_marker",
        "add_text" => "add_text",
        "update_clip" => "update_segment",
        "delete_clips" => "delete_segment",
        "split_clips" => "split_clips",
        "remove_ranges" => "remove_ranges",
        _ => return None,
    })
}

/// The timeline action behind an edit tool, with the tool's arguments.
fn parse_edit(name: &str, mut args: Value) -> Result<TimelineAction, String> {
    let action = edit_action_name(name).ok_or_else(|| format!("Unknown tool: {}", name))?;
    if !args.is_object() {
        args = json!({});
    }
    args["action"] = json!(action);
    serde_json::from_value(args).map_err(|e| format!("Invalid arguments for {}: {}", name, e))
}

/// Run several edits in one tool call, in order. Every entry is checked
/// before the first one runs, so a typo never leaves a half-applied batch;
/// at run time the batch stops at the first edit that fails unless
/// `continueOnError` is set. Saves the agent a model turn per edit.
async fn apply_actions(session: &Session, args: Value) -> Result<ActionOutcome, String> {
    let entries = args
        .get("actions")
        .and_then(|a| a.as_array())
        .filter(|a| !a.is_empty())
        .ok_or("apply_actions needs a non-empty actions array.")?;
    if entries.len() > MAX_BATCH_ACTIONS {
        return Err(format!(
            "apply_actions takes at most {} actions; split them over several calls.",
            MAX_BATCH_ACTIONS
        ));
    }
    let continue_on_error = args.get("continueOnError").and_then(|v| v.as_bool()).unwrap_or(false);

    let mut planned = Vec::with_capacity(entries.len());
    for (i, entry) in entries.iter().enumerate() {
        let tool = entry.get("tool").and_then(|t| t.as_str()).unwrap_or("");
        if tool == "apply_actions" {
            return Err(format!("Action {}: apply_actions cannot be nested.", i + 1));
        }
        let args = entry.get("args").cloned().unwrap_or_else(|| json!({}));
        let action = parse_edit(tool, args).map_err(|e| format!("Action {}: {}. Nothing was applied.", i + 1, e))?;
        planned.push((tool.to_string(), action));
    }

    let total = planned.len();
    let (mut done, mut failed) = (0, 0);
    let mut partial = false;
    let mut lines = Vec::new();
    for (i, (tool, action)) in planned.into_iter().enumerate() {
        match execute(&session.target, action).await {
            Ok(outcome) => {
                done += 1;
                partial |= outcome.partial;
                lines.push(format!("{}. {}: {}", i + 1, tool, outcome.message));
                lines.extend(outcome.lines.into_iter().map(|l| format!("   {}", l)));
            }
            Err(e) => {
                failed += 1;
                lines.push(format!("{}. {}: FAILED: {}", i + 1, tool, e));
                if !continue_on_error {
                    if i + 1 < total {
                        lines.push(format!("Stopped; actions {}-{} were not run.", i + 2, total));
                    }
                    break;
                }
            }
        }
    }
    if done == 0 {
        return Err(format!("No action in the batch was applied.\n{}", lines.join("\n")));
    }
    Ok(ActionOutcome {
        message: format!(
            "Applied {}/{} action(s){}.",
            done,
            total,
            if failed > 0 { format!(", {} failed", failed) } else { String::new() }
        ),
        partial: partial || done < total,
        lines,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::ai_edit::actions::Editor;

    fn session(editor: Editor, allow_edits: bool) -> Session {
        Session { target: EditTarget { editor, draft_id: None, transcript_file: None }, allow_edits, workspace: None }
    }

    #[tokio::test]
    async fn answers_initialize_and_ignores_notifications() {
        let s = session(Editor::Capcut, true);
        let init = handle_message(
            &s,
            &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
                     "params": { "protocolVersion": "2025-06-18" } }),
        )
        .await
        .unwrap();
        assert_eq!(init["result"]["protocolVersion"], json!("2025-06-18"));
        assert!(handle_message(&s, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .await
            .is_none());
    }

    /// Run one raw HTTP exchange against serve_connection.
    async fn http(request: String) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server_task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            serve_connection(stream).await.unwrap();
        });
        let mut client = TcpStream::connect(addr).await.unwrap();
        client.write_all(request.as_bytes()).await.unwrap();
        let mut out = String::new();
        client.read_to_string(&mut out).await.unwrap();
        server_task.await.unwrap();
        out
    }

    fn post(path: &str, token: &str, body: &Value) -> String {
        let body = body.to_string();
        format!(
            "POST {} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {}\r\n\
             Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\n\
             Content-Length: {}\r\n\r\n{}",
            path,
            token,
            body.len(),
            body
        )
    }

    #[tokio::test]
    async fn serves_mcp_over_http() {
        let _ = server().set(Server { port: 0, token: "test-token".into() });
        let token = server().get().unwrap().token.clone();
        sessions()
            .lock()
            .unwrap()
            .insert("s1".into(), session(Editor::Capcut, true));

        let list = http(post("/mcp/s1", &token, &json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/list" }))).await;
        assert!(list.starts_with("HTTP/1.1 200 OK"), "{}", list);
        let body: Value = serde_json::from_str(list.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body["id"], json!(7));
        assert_eq!(body["result"]["tools"].as_array().unwrap().len(), 10);

        let note = http(post("/mcp/s1", &token, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))).await;
        assert!(note.starts_with("HTTP/1.1 202 Accepted"), "{}", note);

        let bad_token = http(post("/mcp/s1", "nope", &json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }))).await;
        assert!(bad_token.starts_with("HTTP/1.1 401"), "{}", bad_token);

        let bad_session = http(post("/mcp/zzz", &token, &json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }))).await;
        assert!(bad_session.starts_with("HTTP/1.1 404"), "{}", bad_session);
    }

    #[tokio::test]
    async fn read_only_session_refuses_edits() {
        let result = call_tool(&session(Editor::Davinci, false), "add_marker", json!({ "markers": [] })).await;
        assert_eq!(result["isError"], json!(true));
        let batch = call_tool(&session(Editor::Davinci, false), "apply_actions", json!({ "actions": [] })).await;
        assert_eq!(batch["isError"], json!(true));
    }

    #[tokio::test]
    async fn batch_is_checked_before_anything_runs() {
        let s = session(Editor::Davinci, true);
        let err = apply_actions(&s, json!({ "actions": [] })).await.unwrap_err();
        assert!(err.contains("non-empty"), "{}", err);

        // The second entry is bad, so the first (which would reach Resolve)
        // never runs.
        let err = apply_actions(
            &s,
            json!({ "actions": [
                { "tool": "add_marker", "args": { "markers": [{ "atSec": 1 }] } },
                { "tool": "update_clip", "args": {} }
            ] }),
        )
        .await
        .unwrap_err();
        assert!(err.starts_with("Action 2: Invalid arguments for update_clip"), "{}", err);

        let err = apply_actions(&s, json!({ "actions": [{ "tool": "get_timeline" }] })).await.unwrap_err();
        assert!(err.contains("Unknown tool: get_timeline"), "{}", err);

        let err = apply_actions(&s, json!({ "actions": [{ "tool": "apply_actions" }] })).await.unwrap_err();
        assert!(err.contains("cannot be nested"), "{}", err);
    }
}
