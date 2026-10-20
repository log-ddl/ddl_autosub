//! Local MCP server that gives the AI Edit agent timeline tools.
//!
//! Speaks the MCP "streamable HTTP" transport in its simplest form: every
//! JSON-RPC request is a POST answered with a single JSON body (no SSE).
//! It listens on 127.0.0.1 on a random port and requires a bearer token that
//! is generated per app run, so other local processes cannot drive it.
//!
//! Each agent run gets its own session path (`/mcp/<session>`) bound to one
//! editor and project, and to whether it may edit. Tools are described per
//! editor, so the agent only sees what that editor supports. Every tool
//! answers with a text outcome or an error, which is how the agent learns
//! whether an edit worked and can correct itself.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::ai_edit::actions::{execute, timeline_snapshot, EditTarget, TimelineAction};

/// Event the UI listens to so it can refresh and toast after an agent edit.
pub const TIMELINE_CHANGED_EVENT: &str = "ai-edit-timeline-changed";

const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;

struct Server {
    port: u16,
    token: String,
}

#[derive(Clone)]
struct Session {
    target: EditTarget,
    allow_edits: bool,
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

/// Register a session for one agent run. None if the server is not running.
pub fn open_session(target: EditTarget, allow_edits: bool) -> Option<McpEndpoint> {
    let srv = server().get()?;
    let session = uuid::Uuid::new_v4().simple().to_string();
    sessions().lock().ok()?.insert(session.clone(), Session { target, allow_edits });
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
        "tools/list" => rpc_result(id, json!({ "tools": tool_definitions(session) })),
        "tools/call" => {
            let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            rpc_result(id, call_tool(session, name, args).await)
        }
        _ => rpc_error(id, -32601, &format!("Method not found: {}", method)),
    })
}

fn editor_name(session: &Session) -> &'static str {
    if session.target.integration == "capcut" { "CapCut" } else { "DaVinci Resolve" }
}

fn instructions(session: &Session) -> String {
    let mut s = format!(
        "Timeline tools for the {} project this conversation is bound to. Times are seconds from the \
         start of the timeline. Call get_timeline to see clip ids, then edit; every edit tool reports \
         what it did, so read the result and fix anything that failed.",
        editor_name(session)
    );
    if !session.allow_edits {
        s.push_str(" This run is read-only (Manual mode): only get_timeline is available.");
    }
    s
}

fn tool_text(text: impl Into<String>, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text.into() }], "isError": is_error })
}

async fn call_tool(session: &Session, name: &str, mut args: Value) -> Value {
    if name == "get_timeline" {
        return match timeline_snapshot(&session.target).await {
            Ok(snapshot) => tool_text(snapshot.to_string(), false),
            Err(e) => tool_text(e, true),
        };
    }

    let action = match name {
        "build_storyboard" => "build_storyboard",
        "add_marker" => "add_marker",
        "add_text" => "add_text",
        "update_clip" => "update_segment",
        "delete_clips" => "delete_segment",
        _ => return tool_text(format!("Unknown tool: {}", name), true),
    };
    if !session.allow_edits {
        return tool_text(
            "This conversation is in Manual mode, so the agent cannot edit the timeline. Describe the \
             change in a ```timeline-action block instead; the user applies it.",
            true,
        );
    }
    if !args.is_object() {
        args = json!({});
    }
    args["action"] = json!(action);
    let parsed: TimelineAction = match serde_json::from_value(args) {
        Ok(a) => a,
        Err(e) => return tool_text(format!("Invalid arguments for {}: {}", name, e), true),
    };

    let result = execute(&session.target, parsed).await;
    if let Some(app) = app_handle().get() {
        let _ = app.emit(
            TIMELINE_CHANGED_EVENT,
            json!({
                "integration": session.target.integration,
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

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

fn tool(name: &str, description: String, schema: Value) -> Value {
    json!({ "name": name, "description": description, "inputSchema": schema })
}

fn tool_definitions(session: &Session) -> Vec<Value> {
    let capcut = session.target.integration == "capcut";
    let mut tools = vec![tool(
        "get_timeline",
        format!(
            "Read the open {} timeline: tracks with every clip (id, name, start and duration in seconds{}) \
             and the markers. Call it before editing clips and after edits to check the result.",
            editor_name(session),
            if capcut { ", zoom, text, media path" } else { ", zoom, Text+ text" }
        ),
        json!({ "type": "object", "properties": {} }),
    )];
    if !session.allow_edits {
        return tools;
    }

    let effect = json!({
        "type": "object",
        "properties": {
            "zoom": { "type": "number", "description": "1.0 = no zoom" },
            "panX": { "type": "number" },
            "panY": { "type": "number" },
            "rotation": { "type": "number", "description": "degrees" }
        }
    });
    tools.push(tool(
        "build_storyboard",
        format!(
            "Place video, image or audio files on the {} timeline. mode: replace (overwrite [start, end] \
             on the track), insert (ripple: split at start and push later clips right), overlay (put on \
             a free track above), append (after the last clip). Tracks are created as needed.{}",
            editor_name(session),
            if capcut { "" } else { " Resolve can only set a fixed zoom/pan/rotation per clip, not keyframes." }
        ),
        json!({
            "type": "object",
            "properties": {
                "mode": { "type": "string", "enum": ["replace", "insert", "overlay", "append"] },
                "targetVideoTrack": { "type": "integer", "minimum": 1, "description": "1 = V1" },
                "audioPath": { "type": "string", "description": "Optional audio file placed on a new audio track" },
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "path": { "type": "string", "description": "Absolute file path" },
                            "start": { "type": "number", "description": "Timeline start, seconds" },
                            "end": { "type": "number", "description": "Timeline end, seconds" },
                            "srcIn": { "type": "number", "description": "Cut-in inside the source, seconds" },
                            "srcOut": { "type": "number", "description": "Cut-out inside the source, seconds" },
                            "effect": effect
                        },
                        "required": ["path", "start"]
                    }
                }
            },
            "required": ["items"]
        }),
    ));

    let marker_colors: Vec<&str> = if capcut {
        vec!["Red", "Cyan"]
    } else {
        vec![
            "Blue", "Cyan", "Green", "Yellow", "Red", "Pink", "Purple", "Fuchsia", "Rose", "Lavender",
            "Sky", "Mint", "Lemon", "Sand", "Cocoa", "Cream",
        ]
    };
    let mut marker_props = json!({
        "atSec": { "type": "number", "description": "Seconds from the timeline start" },
        "color": { "type": "string", "enum": marker_colors },
        "name": { "type": "string" },
        "durationSec": { "type": "number", "description": "Span in seconds; omit for a point marker" }
    });
    if !capcut {
        marker_props["note"] = json!({ "type": "string" });
    }
    tools.push(tool(
        "add_marker",
        if capcut {
            "Add markers to the CapCut timeline. CapCut has two colors (Red, Cyan) and no note field, so \
             put everything in name. A frame that already has a marker is skipped."
                .to_string()
        } else {
            "Add markers to the Resolve timeline. A frame that already has a marker is skipped.".to_string()
        },
        json!({
            "type": "object",
            "properties": {
                "markers": {
                    "type": "array",
                    "items": { "type": "object", "properties": marker_props, "required": ["atSec"] }
                }
            },
            "required": ["markers"]
        }),
    ));

    let text_item = json!({
        "type": "object",
        "properties": {
            "text": { "type": "string" },
            "start": { "type": "number", "description": "Seconds from the timeline start" },
            "end": { "type": "number", "description": "Seconds from the timeline start" }
        },
        "required": ["text", "start", "end"]
    });
    tools.push(if capcut {
        tool(
            "add_text",
            "Add on-screen text to CapCut as a new text track (white with a black outline, or yellow)."
                .to_string(),
            json!({
                "type": "object",
                "properties": {
                    "texts": { "type": "array", "items": text_item },
                    "template": { "type": "string", "enum": ["White", "Yellow"] }
                },
                "required": ["texts"]
            }),
        )
    } else {
        tool(
            "add_text",
            "Add Text+ titles to the Resolve timeline. template is the name of a Text+ in the media pool: \
             \"AutoSubs Caption\" animates word by word, \"Default Template\" is a plain title (the \
             default). track is the video track number, \"0\" or omitted for a new track."
                .to_string(),
            json!({
                "type": "object",
                "properties": {
                    "texts": { "type": "array", "items": text_item },
                    "template": { "type": "string" },
                    "track": { "type": "string" }
                },
                "required": ["texts"]
            }),
        )
    });

    tools.push(if capcut {
        tool(
            "update_clip",
            "Change a CapCut clip by id: move or retime it (startSec, durationSec), set zoom/pan/rotation, \
             animate them with zoomEnd/panXEnd/panYEnd (keyframes from clip start to end), set volume, \
             or replace the text of a text clip."
                .to_string(),
            json!({
                "type": "object",
                "properties": {
                    "segmentId": { "type": "string" },
                    "startSec": { "type": "number" },
                    "durationSec": { "type": "number" },
                    "zoom": { "type": "number" }, "zoomEnd": { "type": "number" },
                    "panX": { "type": "number" }, "panXEnd": { "type": "number" },
                    "panY": { "type": "number" }, "panYEnd": { "type": "number" },
                    "rotation": { "type": "number" },
                    "volume": { "type": "number", "description": "1.0 = unchanged" },
                    "text": { "type": "string" }
                },
                "required": ["segmentId"]
            }),
        )
    } else {
        tool(
            "update_clip",
            "Change a Resolve clip by id: zoom, panX, panY, rotation, opacity (0-100), or the text of a \
             Text+ clip. Resolve's API cannot move, retime, keyframe or change volume; to move a clip, \
             delete it and place it again with build_storyboard."
                .to_string(),
            json!({
                "type": "object",
                "properties": {
                    "segmentId": { "type": "string" },
                    "zoom": { "type": "number" },
                    "panX": { "type": "number" },
                    "panY": { "type": "number" },
                    "rotation": { "type": "number" },
                    "opacity": { "type": "number" },
                    "text": { "type": "string" }
                },
                "required": ["segmentId"]
            }),
        )
    });

    let mut delete_props = json!({
        "segmentIds": { "type": "array", "items": { "type": "string" } }
    });
    if !capcut {
        delete_props["ripple"] = json!({ "type": "boolean", "description": "Close the gap left behind" });
    }
    tools.push(tool(
        "delete_clips",
        format!("Delete clips from the {} timeline by id.", editor_name(session)),
        json!({ "type": "object", "properties": delete_props, "required": ["segmentIds"] }),
    ));
    tools
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(integration: &str, allow_edits: bool) -> Session {
        Session {
            target: EditTarget { integration: integration.into(), draft_id: None },
            allow_edits,
        }
    }

    fn names(tools: &[Value]) -> Vec<&str> {
        tools.iter().filter_map(|t| t["name"].as_str()).collect()
    }

    #[test]
    fn manual_mode_is_read_only() {
        assert_eq!(names(&tool_definitions(&session("davinci", false))), ["get_timeline"]);
    }

    #[test]
    fn tools_follow_the_editor() {
        let davinci = tool_definitions(&session("davinci", true));
        let capcut = tool_definitions(&session("capcut", true));
        assert_eq!(
            names(&davinci),
            ["get_timeline", "build_storyboard", "add_marker", "add_text", "update_clip", "delete_clips"]
        );
        let ripple = |tools: &[Value]| tools[5]["inputSchema"]["properties"].get("ripple").is_some();
        assert!(ripple(&davinci));
        assert!(!ripple(&capcut));
        assert!(capcut[4]["inputSchema"]["properties"].get("zoomEnd").is_some());
        assert!(davinci[4]["inputSchema"]["properties"].get("zoomEnd").is_none());
    }

    #[tokio::test]
    async fn answers_initialize_and_ignores_notifications() {
        let s = session("capcut", true);
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
            .insert("s1".into(), session("capcut", true));

        let list = http(post("/mcp/s1", &token, &json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/list" }))).await;
        assert!(list.starts_with("HTTP/1.1 200 OK"), "{}", list);
        let body: Value = serde_json::from_str(list.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body["id"], json!(7));
        assert_eq!(body["result"]["tools"].as_array().unwrap().len(), 6);

        let note = http(post("/mcp/s1", &token, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))).await;
        assert!(note.starts_with("HTTP/1.1 202 Accepted"), "{}", note);

        let bad_token = http(post("/mcp/s1", "nope", &json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }))).await;
        assert!(bad_token.starts_with("HTTP/1.1 401"), "{}", bad_token);

        let bad_session = http(post("/mcp/zzz", &token, &json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }))).await;
        assert!(bad_session.starts_with("HTTP/1.1 404"), "{}", bad_session);
    }

    #[tokio::test]
    async fn read_only_session_refuses_edits() {
        let result = call_tool(&session("davinci", false), "add_marker", json!({ "markers": [] })).await;
        assert_eq!(result["isError"], json!(true));
    }
}
