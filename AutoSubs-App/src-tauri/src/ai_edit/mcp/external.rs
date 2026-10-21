//! External agents: Claude Code, Antigravity, Codex... driving AutoSubs from
//! their own app instead of the AI Edit tab.
//!
//! When the user turns it on, a second listener opens on a fixed port with a
//! token that is saved, so an agent app registers `autosubs-app` once and
//! keeps working across restarts. Its session is not bound to a run: every
//! request follows the editor project the app has open (`set_target`, pushed
//! by the frontend), with edits allowed.
//!
//! The app also keeps an "agent home" folder (default `~/Documents/AutoSub`)
//! ready to open an agent app in: instructions (CLAUDE.md, AGENTS.md), the
//! MCP entry for Claude Code (.mcp.json), the shared subagents and skills, and
//! a `project` link to the open project's workspace, so the agent reads media,
//! sheets and plans inside its own folder.
//!
//! Each client is told apart by the `Mcp-Session-Id` it gets on initialize;
//! the UI shows who connected and who is driving now.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::ai_cli::runtime::{build_cli_path_env, detect_cli_path};
use crate::ai_cli::workspace::{ensure_library, global_workspace_root, resolve_workspace_dir, WorkspaceProject};
use crate::ai_edit::actions::{EditTarget, Editor};
use crate::process_ext::HiddenConsole;

/// Fixed so agent apps keep their config across restarts.
pub const PORT: u16 = 47185;
/// The name agent apps know the server by. Not `autosubs`, which the AI Edit
/// tab registers per run.
pub const SERVER_NAME: &str = "autosubs-app";
pub const STATUS_EVENT: &str = "external-agent-status";
/// A client that called a tool this recently is "driving".
const ACTIVE_SECS: u64 = 120;
const CONFIG_FILE: &str = "external-agents.json";
/// Marks files in the agent home the app wrote, so it never overwrites the user's.
const HOME_MARK: &str = "<!-- Written by AutoSubs. -->";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    enabled: bool,
    token: String,
    home: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Current {
    pub target: EditTarget,
    /// "My Film" (DaVinci project, Premiere sequence, CapCut draft).
    pub label: Option<String>,
    pub workspace: Option<PathBuf>,
}

#[derive(Clone, Debug)]
struct Client {
    name: String,
    version: String,
    /// HTTP User-Agent at initialize, which finds the client again when it
    /// sends no Mcp-Session-Id on later requests.
    user_agent: String,
    first_seen: u64,
    last_seen: u64,
    last_tool: Option<String>,
    last_tool_at: u64,
}

#[derive(Default)]
struct State {
    config: Option<Config>,
    listening: bool,
    error: Option<String>,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
    current: Option<Current>,
    clients: HashMap<String, Client>,
}

static STATE: Lazy<Mutex<State>> = Lazy::new(|| Mutex::new(State::default()));

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn lock() -> std::sync::MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(CONFIG_FILE))
}

fn load_config(app: &AppHandle) -> Config {
    if let Some(c) = lock().config.clone() {
        return c;
    }
    let mut config: Config = config_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    if config.token.is_empty() {
        config.token = uuid::Uuid::new_v4().simple().to_string();
        save_config(app, &config);
    }
    lock().config = Some(config.clone());
    config
}

fn save_config(app: &AppHandle, config: &Config) {
    if let Some(p) = config_path(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string_pretty(config) {
            let _ = std::fs::write(p, text);
        }
    }
    lock().config = Some(config.clone());
}

/// The token external requests must carry, None while the feature is off.
pub fn token() -> Option<String> {
    lock().config.as_ref().filter(|c| c.enabled).map(|c| c.token.clone())
}

fn url() -> String {
    format!("http://127.0.0.1:{}/mcp", PORT)
}

fn home_dir(app: &AppHandle, config: &Config) -> PathBuf {
    if let Some(h) = config.home.as_deref().filter(|h| !h.trim().is_empty()) {
        return PathBuf::from(h);
    }
    app.path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("AutoSub")
}

// ---------------------------------------------------------------------------
// Listener
// ---------------------------------------------------------------------------

/// At app start: open the listener if the user turned it on before.
pub fn start(app: &AppHandle) {
    let config = load_config(app);
    if config.enabled {
        open_listener(app.clone());
        write_home(app);
    }
}

fn open_listener(app: AppHandle) {
    let mut st = lock();
    if st.task.is_some() {
        return;
    }
    let emit_app = app.clone();
    st.task = Some(tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", PORT)).await {
            Ok(l) => l,
            Err(e) => {
                {
                    let mut st = lock();
                    st.listening = false;
                    st.error = Some(format!("Port {} is in use by another app ({}).", PORT, e));
                    st.task = None;
                }
                emit_status(&emit_app);
                return;
            }
        };
        {
            let mut st = lock();
            st.listening = true;
            st.error = None;
        }
        emit_status(&emit_app);
        tracing::info!("External agent MCP endpoint on {}", url());
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            tauri::async_runtime::spawn(async move {
                if let Err(e) = super::server::serve_external(stream).await {
                    tracing::debug!("External MCP connection error: {}", e);
                }
            });
        }
    }));
}

fn close_listener() {
    let mut st = lock();
    if let Some(task) = st.task.take() {
        task.abort();
    }
    st.listening = false;
    st.clients.clear();
}

// ---------------------------------------------------------------------------
// Target and clients
// ---------------------------------------------------------------------------

/// The project external requests act on, None until the app has seen one.
pub fn current() -> Option<Current> {
    lock().current.clone()
}

/// The editor tools are listed for when no project is known yet.
pub fn fallback_target() -> EditTarget {
    EditTarget { editor: Editor::Davinci, draft_id: None, transcript_file: None }
}

/// A client's `initialize`: returns the session id to hand back.
pub fn client_initialized(app: Option<&AppHandle>, params: &Value, user_agent: &str) -> String {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let info = params.get("clientInfo");
    let field = |k: &str| info.and_then(|i| i.get(k)).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let t = now();
    tracing::info!("External agent connected: {} {}", field("name"), field("version"));
    lock().clients.insert(
        id.clone(),
        Client {
            name: field("name"),
            version: field("version"),
            user_agent: user_agent.to_string(),
            first_seen: t,
            last_seen: t,
            last_tool: None,
            last_tool_at: 0,
        },
    );
    if let Some(app) = app {
        emit_status(app);
    }
    id
}

/// Any later request of a client; `tool` for tool calls. A client without
/// a session id is found by its User-Agent (the latest one that matches);
/// one that never initialized is not shown.
pub fn touch(app: Option<&AppHandle>, session: Option<&str>, user_agent: &str, tool: Option<&str>) {
    let changed = {
        let mut st = lock();
        let key = session.filter(|s| st.clients.contains_key(*s)).map(str::to_string).or_else(|| {
            st.clients
                .iter()
                .filter(|(_, c)| !user_agent.is_empty() && c.user_agent == user_agent)
                .max_by_key(|(_, c)| c.last_seen)
                .map(|(k, _)| k.clone())
        });
        let Some(key) = key else { return };
        let Some(c) = st.clients.get_mut(&key) else { return };
        c.last_seen = now();
        if let Some(t) = tool {
            c.last_tool = Some(t.to_string());
            c.last_tool_at = now();
            true
        } else {
            false
        }
    };
    if changed {
        if let Some(app) = app {
            emit_status(app);
        }
    }
}

/// "Claude Code", "Antigravity", ... from an MCP clientInfo name.
fn client_label(name: &str) -> String {
    let n = name.to_ascii_lowercase();
    let known = [
        ("claude-code", "Claude Code"),
        ("claude-ai", "Claude Desktop"),
        ("claude", "Claude"),
        ("antigravity", "Antigravity"),
        ("jetski", "Antigravity"),
        ("agy", "Antigravity"),
        ("gemini", "Gemini CLI"),
        ("codex", "Codex"),
        ("cursor", "Cursor"),
        ("vscode", "VS Code"),
        ("windsurf", "Windsurf"),
    ];
    known
        .iter()
        .find(|(k, _)| n.contains(k))
        .map(|(_, l)| l.to_string())
        .unwrap_or_else(|| if name.is_empty() { "Unknown agent".into() } else { name.to_string() })
}

/// Rewrites workspace paths in a tool's text to their place under the agent
/// home's `project` link, which agent apps may read without asking.
pub fn agent_paths(app: Option<&AppHandle>, text: String) -> String {
    let (Some(app), Some(cur)) = (app, current()) else { return text };
    let Some(ws) = cur.workspace else { return text };
    let home = home_dir(app, &load_config(app)).join("project");
    let ws = ws.to_string_lossy().into_owned();
    if ws.is_empty() {
        return text;
    }
    text.replace(&ws, &home.to_string_lossy())
}

// ---------------------------------------------------------------------------
// Agent home
// ---------------------------------------------------------------------------

fn instructions_md(cur: Option<&Current>) -> String {
    let project = match cur {
        Some(c) => format!(
            "{}{}",
            c.target.editor.display_name(),
            c.label.as_deref().map(|l| format!(", project \"{}\"", l)).unwrap_or_default()
        ),
        None => "no editor project yet".into(),
    };
    format!(
        "{HOME_MARK}\n# AutoSubs\n\n\
         This folder is where you drive AutoSubs, a video editing assistant connected to the user's \
         editor (DaVinci Resolve, Premiere Pro or CapCut). Right now it follows: {project}.\n\n\
         - Every edit, search, download and analysis goes through the `{SERVER_NAME}` MCP server. \
         Its tools act on the editor project AutoSubs has open, and it saves files in that project's \
         folder, which `project/` here links to (media in `project/media`, contact sheets in \
         `project/analysis`, plans in `project/plan`).\n\
         - Start with `get_project_context` to see the editor, the project and its memory.\n\
         - Long workflows are skills: read one with `read_skill` (or from `.claude/skills/`) when a \
         task matches, for example `footage-planning` to find footage for a script or voice.\n\
         - Subagents `footage-scout` and `clip-analyst` run searches and video checks in parallel.\n\
         - Never cut or re-encode video files yourself: place sections with build_storyboard \
         srcIn/srcOut and the editor trims them.\n\
         - If a tool says AutoSubs is not connected, ask the user to open AutoSubs and their editor \
         project.\n"
    )
}

fn owned_or_missing(path: &Path) -> bool {
    match std::fs::read_to_string(path) {
        Ok(t) => t.contains(HOME_MARK) || t.contains(crate::ai_cli::library::SYNC_MARK),
        Err(_) => !path.exists(),
    }
}

fn write_if_ours(path: &Path, contents: &str) {
    if owned_or_missing(path) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, contents);
    }
}

/// (Re)writes the agent home. Cheap; runs on enable, connect and project change.
pub fn write_home(app: &AppHandle) {
    let config = load_config(app);
    if !config.enabled {
        return;
    }
    let home = home_dir(app, &config);
    if std::fs::create_dir_all(&home).is_err() {
        return;
    }
    let cur = current();
    let md = instructions_md(cur.as_ref());
    write_if_ours(&home.join("CLAUDE.md"), &md);
    write_if_ours(&home.join("AGENTS.md"), &md);

    // Claude Code reads project MCP servers from .mcp.json (asking once).
    let mcp_path = home.join(".mcp.json");
    let mut mcp: Value = std::fs::read_to_string(&mcp_path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({ "mcpServers": {} }));
    if !mcp.get("mcpServers").is_some_and(|v| v.is_object()) {
        mcp["mcpServers"] = json!({});
    }
    mcp["mcpServers"][SERVER_NAME] = json!({
        "type": "http",
        "url": url(),
        "headers": { "Authorization": format!("Bearer {}", config.token) }
    });
    if let Ok(text) = serde_json::to_string_pretty(&mcp) {
        let _ = std::fs::write(&mcp_path, text + "\n");
    }

    if let Some(lib) = global_workspace_root(app).ok().and_then(|g| ensure_library(&g).ok()) {
        crate::ai_cli::library::sync_agents(&lib, &home);
        crate::ai_cli::library::sync_skills(&lib, &home.join(".claude/skills"));
    }

    // `project` -> the open project's workspace.
    let link = home.join("project");
    if let Some(ws) = cur.and_then(|c| c.workspace) {
        let points_there = std::fs::read_link(&link).is_ok_and(|t| t == ws);
        if !points_there {
            if std::fs::symlink_metadata(&link).is_ok_and(|m| m.file_type().is_symlink()) {
                let _ = std::fs::remove_file(&link);
            }
            if !link.exists() {
                #[cfg(unix)]
                let _ = std::os::unix::fs::symlink(&ws, &link);
                #[cfg(windows)]
                let _ = std::os::windows::fs::symlink_dir(&ws, &link);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientStatus {
    pub label: String,
    pub name: String,
    pub version: String,
    pub connected_sec: u64,
    pub last_seen_sec: u64,
    pub last_tool: Option<String>,
    pub last_tool_sec: Option<u64>,
    pub active: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    pub listening: bool,
    pub error: Option<String>,
    pub url: String,
    pub token: String,
    pub server_name: String,
    pub home: String,
    /// "DaVinci Resolve", or None before the app has seen an editor project.
    pub editor: Option<String>,
    pub project: Option<String>,
    pub clients: Vec<ClientStatus>,
    /// Label of the client that called a tool most recently, if lately.
    pub controller: Option<String>,
    pub claude_installed: bool,
    pub agy_installed: bool,
    /// The desktop apps the open buttons launch (macOS bundles, or their CLIs).
    pub claude_app: bool,
    pub antigravity_app: bool,
    pub claude_registered: bool,
    pub agy_registered: bool,
    pub now_sec: u64,
}

fn file_mentions(path: Option<PathBuf>, needle: &str) -> bool {
    path.and_then(|p| std::fs::read_to_string(p).ok()).is_some_and(|t| t.contains(needle))
}

pub fn status(app: &AppHandle) -> Status {
    let config = load_config(app);
    let home = app.path().home_dir().ok();
    let marker = format!("Bearer {}", config.token);
    let st = lock();
    let t = now();
    // One row per app: Claude Code opens a new MCP session per window and
    // subagent, which are all the same agent to the user.
    let mut by_label: HashMap<String, ClientStatus> = HashMap::new();
    for c in st.clients.values() {
        let label = client_label(&c.name);
        let row = ClientStatus {
            label: label.clone(),
            name: c.name.clone(),
            version: c.version.clone(),
            connected_sec: c.first_seen,
            last_seen_sec: c.last_seen,
            last_tool: c.last_tool.clone(),
            last_tool_sec: (c.last_tool_at > 0).then_some(c.last_tool_at),
            active: c.last_tool_at > 0 && t.saturating_sub(c.last_tool_at) <= ACTIVE_SECS,
        };
        match by_label.get_mut(&label) {
            Some(prev) => {
                prev.connected_sec = prev.connected_sec.min(row.connected_sec);
                prev.last_seen_sec = prev.last_seen_sec.max(row.last_seen_sec);
                prev.active |= row.active;
                if row.last_tool_sec > prev.last_tool_sec {
                    prev.last_tool = row.last_tool;
                    prev.last_tool_sec = row.last_tool_sec;
                }
            }
            None => {
                by_label.insert(label, row);
            }
        }
    }
    let mut clients: Vec<ClientStatus> = by_label.into_values().collect();
    clients.sort_by(|a, b| b.last_seen_sec.cmp(&a.last_seen_sec));
    let controller = clients
        .iter()
        .filter(|c| c.active)
        .max_by_key(|c| c.last_tool_sec)
        .map(|c| c.label.clone());
    Status {
        enabled: config.enabled,
        listening: st.listening,
        error: st.error.clone(),
        url: url(),
        token: config.token.clone(),
        server_name: SERVER_NAME.into(),
        home: home_dir(app, &config).to_string_lossy().into_owned(),
        editor: st.current.as_ref().map(|c| c.target.editor.display_name().to_string()),
        project: st.current.as_ref().and_then(|c| c.label.clone()),
        clients,
        controller,
        claude_installed: detect_cli_path("claude").is_some(),
        agy_installed: detect_cli_path("agy").is_some(),
        claude_app: find_app(&APP_CLAUDE).is_some(),
        antigravity_app: find_app(&APP_ANTIGRAVITY).is_some(),
        claude_registered: file_mentions(home.as_ref().map(|h| h.join(".claude.json")), &marker),
        agy_registered: file_mentions(home.as_ref().map(|h| h.join(".gemini/config/mcp_config.json")), &marker),
        now_sec: t,
    }
}

fn emit_status(app: &AppHandle) {
    let _ = app.emit(STATUS_EVENT, status(app));
}

/// True when `autosubs-app` is in agy's global config, which the AI Edit tab
/// turns off for the length of its own agy runs (its tools would be listed twice).
pub fn agy_registered(app: &AppHandle) -> bool {
    let home = app.path().home_dir().ok();
    file_mentions(home.map(|h| h.join(".gemini/config/mcp_config.json")), SERVER_NAME)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn external_agent_status(app: AppHandle) -> Status {
    status(&app)
}

#[tauri::command]
pub async fn external_agent_set_enabled(app: AppHandle, enabled: bool) -> Status {
    let mut config = load_config(&app);
    config.enabled = enabled;
    save_config(&app, &config);
    if enabled {
        open_listener(app.clone());
        let a = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || write_home(&a)).await;
    } else {
        close_listener();
    }
    let s = status(&app);
    let _ = app.emit(STATUS_EVENT, s.clone());
    s
}

#[tauri::command]
pub async fn external_agent_set_home(app: AppHandle, home: String) -> Status {
    let mut config = load_config(&app);
    config.home = Some(home).filter(|h| !h.trim().is_empty());
    save_config(&app, &config);
    let a = app.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || write_home(&a)).await;
    let s = status(&app);
    let _ = app.emit(STATUS_EVENT, s.clone());
    s
}

/// The frontend's editor and project, whenever they change.
#[tauri::command]
pub async fn external_agent_set_target(
    app: AppHandle,
    target: Option<EditTarget>,
    project: Option<WorkspaceProject>,
    label: Option<String>,
) -> Result<(), String> {
    let next = match target {
        Some(target) => {
            let workspace = match project.as_ref() {
                Some(p) => resolve_workspace_dir(&app, None, Some(p)).ok(),
                None => None,
            };
            Some(Current { target, label: label.filter(|l| !l.trim().is_empty()), workspace })
        }
        None => None,
    };
    let changed = {
        let mut st = lock();
        let same = match (&st.current, &next) {
            (Some(a), Some(b)) => {
                a.target.editor == b.target.editor
                    && a.target.draft_id == b.target.draft_id
                    && a.label == b.label
                    && a.workspace == b.workspace
            }
            (None, None) => true,
            _ => false,
        };
        st.current = next;
        !same
    };
    if changed {
        let a = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || write_home(&a)).await;
        emit_status(&app);
    }
    Ok(())
}

fn run_cli(bin: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new(bin)
        .args(args)
        .env("PATH", build_cli_path_env())
        .stdin(Stdio::null())
        .hidden()
        .output()
        .map_err(|e| e.to_string())?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if out.status.success() {
        Ok(text.trim().to_string())
    } else {
        Err(text.trim().to_string())
    }
}

/// Registers the server with an installed agent CLI ("claude" or "agy") for
/// the user, everywhere (not only in the agent home), and installs the
/// shared subagents where that CLI reads them globally.
#[tauri::command]
pub async fn external_agent_connect(app: AppHandle, client: String) -> Result<Status, String> {
    let config = load_config(&app);
    if !config.enabled {
        return Err("Turn on external agents first.".into());
    }
    let header = format!("Authorization: Bearer {}", config.token);
    let a = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let home = a.path().home_dir().map_err(|e| e.to_string())?;
        let library = global_workspace_root(&a).and_then(|g| ensure_library(&g))?;
        match client.as_str() {
            "claude" => {
                let bin = detect_cli_path("claude").ok_or("Claude Code is not installed.")?;
                let _ = run_cli(&bin, &["mcp", "remove", "--scope", "user", SERVER_NAME]);
                run_cli(&bin, &["mcp", "add", "--transport", "http", "--scope", "user", SERVER_NAME, &url(), "--header", &header])?;
                crate::ai_cli::library::sync_agents_to(&library, &home.join(".claude/agents"), true);
                crate::ai_cli::library::sync_skills(&library, &home.join(".claude/skills"));
            }
            "agy" => {
                let bin = detect_cli_path("agy").ok_or("Antigravity (agy) is not installed.")?;
                run_cli(&bin, &["mcp", "add", "--header", &header, SERVER_NAME, &url()])?;
                crate::ai_cli::library::sync_agents_to(&library, &home.join(".gemini/config/agents"), false);
            }
            other => return Err(format!("Unknown agent app: {}", other)),
        }
        write_home(&a);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;
    let s = status(&app);
    let _ = app.emit(STATUS_EVENT, s.clone());
    Ok(s)
}

/// An agent app the open buttons launch: its macOS bundles in order of
/// preference, each with whether it opens a folder, and the CLIs that open
/// a folder elsewhere.
struct AgentApp {
    bundles: &'static [(&'static str, bool)],
    clis: &'static [&'static str],
}

/// Claude opens through its `claude://code/new?folder=` link instead (the one
/// Finder's "New Claude Code Session Here" uses), which lands in Code, not chat.
const APP_CLAUDE: AgentApp = AgentApp { bundles: &[("Claude", true)], clis: &[] };
/// The Antigravity app (agent manager) first: it is the one users mean. It
/// takes no folder, so it opens as is; the IDE is the fallback.
const APP_ANTIGRAVITY: AgentApp = AgentApp {
    bundles: &[("Antigravity", false), ("Antigravity IDE", true)],
    clis: &["antigravity", "antigravity-ide"],
};

enum Launch {
    Bundle(PathBuf, bool),
    Cli(PathBuf),
}

fn find_app(app: &AgentApp) -> Option<Launch> {
    if cfg!(target_os = "macos") {
        let roots = [PathBuf::from("/Applications"), std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Applications")).unwrap_or_default()];
        for (name, takes_folder) in app.bundles {
            for root in &roots {
                let p = root.join(format!("{}.app", name));
                if p.is_dir() {
                    return Some(Launch::Bundle(p, *takes_folder));
                }
            }
        }
    }
    app.clis.iter().find_map(|c| detect_cli_path(c)).map(Launch::Cli)
}

/// Opens the agent home in Claude (a Code session in the desktop app, or
/// Claude Code in a terminal when only the CLI is installed) or Antigravity.
/// Returns false when the app opened without the folder (Antigravity has no
/// link for one), so the UI copies the path for the user to pick.
#[tauri::command]
pub async fn external_agent_open_app(app: AppHandle, which: String) -> Result<bool, String> {
    let home = home_dir(&app, &load_config(&app));
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    let a = app.clone();
    tauri::async_runtime::spawn_blocking(move || write_home(&a)).await.map_err(|e| e.to_string())?;
    if which == "antigravity" {
        if let Ok(user_home) = app.path().home_dir() {
            if let Some(id) = ensure_antigravity_project(&user_home, &home) {
                // Opens straight into the project when Antigravity is not
                // running yet; a running one keeps its own state in memory.
                if !antigravity_running() && select_antigravity_project(&app, &id) {
                    if let Some(Launch::Bundle(bundle, _)) = find_app(&APP_ANTIGRAVITY) {
                        Command::new("open").arg("-a").arg(&bundle).hidden().status().map_err(|e| e.to_string())?;
                        return Ok(true);
                    }
                }
            }
        }
    }
    let spec = match which.as_str() {
        "claude" => &APP_CLAUDE,
        "antigravity" => &APP_ANTIGRAVITY,
        other => return Err(format!("Unknown app: {}", other)),
    };
    match find_app(spec) {
        Some(Launch::Bundle(_, true)) if which == "claude" => {
            let link = format!("claude://code/new?folder={}", urlencode_path(&home.to_string_lossy()));
            Command::new("open").arg(link).hidden().status().map_err(|e| e.to_string())?;
            Ok(true)
        }
        Some(Launch::Bundle(bundle, takes_folder)) => {
            let mut cmd = Command::new("open");
            cmd.arg("-a").arg(&bundle);
            if takes_folder {
                cmd.arg(&home);
            }
            cmd.hidden().status().map_err(|e| e.to_string())?;
            Ok(takes_folder)
        }
        Some(Launch::Cli(cli)) => {
            Command::new(cli).arg(&home).env("PATH", build_cli_path_env()).hidden().spawn().map_err(|e| e.to_string())?;
            Ok(true)
        }
        None if which == "claude" => open_claude_code_in_terminal(&home).map(|_| true),
        None => Err("Antigravity is not installed.".into()),
    }
}

/// Antigravity works in projects (`~/.gemini/config/projects/<id>.json`,
/// shared with agy): finds the one on `folder`, or adds one named after it.
/// Returns its id.
fn ensure_antigravity_project(user_home: &Path, folder: &Path) -> Option<String> {
    let dir = user_home.join(".gemini/config/projects");
    let uri = format!("file://{}", folder.to_string_lossy());
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let Some(p) = std::fs::read_to_string(e.path()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else {
                continue;
            };
            let on_folder = p
                .pointer("/projectResources/resources")
                .and_then(|r| r.as_array())
                .is_some_and(|r| {
                    r.iter().any(|x| {
                        x.get("folderUri").or_else(|| x.pointer("/gitFolder/folderUri")).and_then(|u| u.as_str())
                            == Some(uri.as_str())
                    })
                });
            if on_folder {
                return p.get("id").and_then(|i| i.as_str()).map(str::to_string);
            }
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let name = folder.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "AutoSub".into());
    let project = json!({
        "id": id,
        "name": name,
        "projectResources": { "resources": [{ "folderUri": uri }] },
        "permissionGrants": { "v2Migrated": true },
        "settings": {},
        "isWorkspaceOnly": false
    });
    std::fs::create_dir_all(&dir).ok()?;
    std::fs::write(dir.join(format!("{}.json", id)), serde_json::to_string_pretty(&project).ok()?).ok()?;
    Some(id)
}

fn antigravity_running() -> bool {
    cfg!(target_os = "macos")
        && Command::new("pgrep")
            .args(["-f", "Antigravity.app/Contents/MacOS/"])
            .stdout(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
}

/// Makes `id` the project a new Antigravity conversation starts in. Only
/// while Antigravity is closed, since it rewrites this file from memory.
fn select_antigravity_project(app: &AppHandle, id: &str) -> bool {
    let Ok(base) = app.path().home_dir() else { return false };
    let path = base.join("Library/Application Support/Antigravity/app_storage.json");
    let Some(mut storage) = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else {
        return false;
    };
    let Some(map) = storage.as_object_mut() else { return false };
    map.insert("new-convo-last-selected-project".into(), Value::String(id.to_string()));
    map.insert("new-convo-magic-workspace-selected".into(), Value::Bool(false));
    serde_json::to_string(&storage).ok().is_some_and(|t| std::fs::write(&path, t).is_ok())
}

fn urlencode_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// `claude` in a new terminal window, in `home`.
fn open_claude_code_in_terminal(home: &Path) -> Result<(), String> {
    detect_cli_path("claude").ok_or("Claude is not installed.")?;
    let dir = home.to_string_lossy().into_owned();
    if cfg!(target_os = "macos") {
        let script = format!(
            "tell application \"Terminal\"\n activate\n do script \"cd {} && claude\"\nend tell",
            shell_quote(&dir).replace('\\', "\\\\").replace('"', "\\\"")
        );
        Command::new("osascript").arg("-e").arg(script).hidden().status().map_err(|e| e.to_string())?;
    } else if cfg!(windows) {
        Command::new("cmd")
            .args(["/c", "start", "cmd", "/k", &format!("cd /d \"{}\" && claude", dir)])
            .env("PATH", build_cli_path_env())
            .hidden()
            .spawn()
            .map_err(|e| e.to_string())?;
    } else {
        Command::new("x-terminal-emulator")
            .args(["-e", "sh", "-c", &format!("cd {} && claude", shell_quote(&dir))])
            .env("PATH", build_cli_path_env())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_one_antigravity_project_per_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let folder = tmp.path().join("AutoSub");
        let id = ensure_antigravity_project(tmp.path(), &folder).unwrap();
        assert_eq!(ensure_antigravity_project(tmp.path(), &folder).unwrap(), id, "found, not added twice");
        let text = std::fs::read_to_string(tmp.path().join(format!(".gemini/config/projects/{}.json", id))).unwrap();
        assert!(text.contains("\"name\": \"AutoSub\"") && text.contains(&format!("file://{}", folder.display())));
    }

    #[test]
    fn encodes_the_folder_for_claude_links() {
        assert_eq!(urlencode_path("/Users/a b/AutoSub"), "%2FUsers%2Fa%20b%2FAutoSub");
    }

    #[test]
    fn quotes_paths_for_the_shell() {
        assert_eq!(shell_quote("/Users/a b/it's"), "'/Users/a b/it'\\''s'");
    }

    #[test]
    fn names_known_clients() {
        assert_eq!(client_label("claude-code"), "Claude Code");
        assert_eq!(client_label("antigravity-cli"), "Antigravity");
        assert_eq!(client_label("codex-mcp-client"), "Codex");
        assert_eq!(client_label("my-agent"), "my-agent");
        assert_eq!(client_label(""), "Unknown agent");
    }

    #[test]
    fn tracks_clients_and_the_one_driving() {
        let id = client_initialized(None, &json!({ "clientInfo": { "name": "claude-code", "version": "2.1" } }), "ua-claude");
        touch(None, Some(&id), "ua-claude", Some("search_media"));
        // No session id: found by its User-Agent; an unknown one is ignored.
        touch(None, None, "ua-claude", Some("analyze_media"));
        touch(None, None, "ua-nobody", Some("get_timeline"));
        let st = lock();
        let c = st.clients.get(&id).unwrap();
        assert_eq!(c.last_tool.as_deref(), Some("analyze_media"));
        assert!(c.last_tool_at > 0);
        assert!(!st.clients.values().any(|c| c.last_tool.as_deref() == Some("get_timeline")));
    }

    #[test]
    fn instructions_name_the_project() {
        let cur = Current {
            target: EditTarget { editor: Editor::Premiere, draft_id: None, transcript_file: None },
            label: Some("Vlog 3".into()),
            workspace: None,
        };
        let md = instructions_md(Some(&cur));
        assert!(md.starts_with(HOME_MARK));
        assert!(md.contains("Premiere Pro, project \"Vlog 3\""));
        assert!(md.contains(SERVER_NAME));
    }
}
