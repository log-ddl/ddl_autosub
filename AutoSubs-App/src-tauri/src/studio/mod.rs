//! Video Studio: code-first videos with Remotion, made from the AI Edit tab
//! (or Claude Code / Antigravity opened on the same folder).
//!
//! Two places:
//! - The **environment** (`<app data>/ai-director-workspace/studio-env/`),
//!   installed once from Settings: `remotion/` with its `node_modules` and
//!   `docs/`, `.venv/` for the Python tools, `.bin/` ffmpeg/ffprobe shims.
//! - The **working folder** the user picks in Settings (default
//!   `~/Documents/AutoSub`, also the external agents' home), laid out like a
//!   plain repo:
//!     ├── `AGENTS.md`, `CLAUDE.md`, `README.md`   rules and layout (the app's until the user edits AGENTS.md)
//!     ├── `core/kit`, `core/tools`               shared video code and tools, copied (they find the
//!     │                                          root from their own real path, so a link would not do)
//!     ├── `remotion/`                            config files copied; `node_modules/` and `docs/` link
//!     │                                          to the environment (`remotion.config.ts` finds `skills/`
//!     │                                          from its own real folder, so the folder itself is real)
//!     ├── `.venv/`, `.bin/`                      links to the environment
//!     ├── `skills/<name>/`                       the user's skills, copied in from the Assets dialog
//!     ├── `library/`, `projects/<id>/`, `voice/` the user's
//!
//! Everything shipped comes from `resources/studio` and belongs to the app:
//! every setup rewrites it. Skills, library and projects are never touched,
//! and the app ships no skill. The Premiere side of AI Edit keeps its own
//! per-project workspace; this is an addition next to it.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::Command;

use crate::ai_cli::runtime::build_cli_path_env;
use crate::ai_cli::workspace::{
    copy_recursive, find_skill_dirs, global_workspace_root, skill_frontmatter,
};
use crate::ai_edit::mcp::external::HOME_MARK;
use crate::process_ext::HiddenConsole;

pub const STATUS_EVENT: &str = "studio-status";
/// Job id for the shared Python bootstrap (it reports progress per job).
const SETUP_JOB: &str = "studio-setup";
const NPM_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const PIP_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const TOOL_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const STUDIO_START_TIMEOUT: Duration = Duration::from_secs(180);
/// Lines of a failed command's output kept in its error.
const ERROR_TAIL_LINES: usize = 30;
const STUDIO_LOG_LINES: usize = 200;
const NPM_STAMP: &str = ".autosubs-installed";
const PIP_STAMP: &str = ".autosubs-requirements";
/// Shipped files the environment needs (the rest only go to the working folder).
const ENV_FILES: &[&str] = &["core", "remotion", "requirements.txt"];
/// Links from the working folder into the environment.
const LINKS: &[&str] = &["remotion/node_modules", "remotion/docs", ".venv", ".bin"];

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The working folder.
    pub root: String,
    /// Setup is running.
    pub busy: bool,
    /// "files" | "node" | "python" | "docs" | "links" while busy.
    pub stage: Option<String>,
    pub error: Option<String>,
    pub node: bool,
    pub python: bool,
    pub docs: bool,
    /// The environment is installed and linked into the working folder.
    pub ready: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEntry {
    pub id: String,
    pub title: String,
    pub path: String,
    pub modified_sec: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEntry {
    pub folder: String,
    pub name: String,
    pub description: String,
    pub path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioInfo {
    pub id: String,
    pub url: String,
}

struct Running {
    pid: Option<u32>,
    port: u16,
}

#[derive(Default)]
struct State {
    busy: bool,
    stage: Option<String>,
    error: Option<String>,
    studios: HashMap<String, Running>,
}

static STATE: Lazy<Mutex<State>> = Lazy::new(|| Mutex::new(State::default()));
static STUDIO_LOGS: Lazy<Arc<Mutex<VecDeque<String>>>> =
    Lazy::new(|| Arc::new(Mutex::new(VecDeque::new())));

fn lock() -> std::sync::MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/// The working folder.
pub fn root(app: &AppHandle) -> PathBuf {
    crate::ai_edit::mcp::external::home(app)
}

fn env_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(global_workspace_root(app)?.join("studio-env"))
}

/// The bundled `resources/studio/` (dev builds read it from the source tree).
fn resource_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("resources").join("studio"));
        candidates.push(res.join("studio"));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("studio"),
    );
    candidates
        .into_iter()
        .find(|d| d.join("core/tools/common.py").is_file())
        .ok_or_else(|| "Bundled Video Studio files not found in application resources".to_string())
}

fn venv_python(dir: &Path) -> PathBuf {
    if cfg!(windows) {
        dir.join(".venv/Scripts/python.exe")
    } else {
        dir.join(".venv/bin/python")
    }
}

fn npm() -> &'static str {
    if cfg!(windows) { "npm.cmd" } else { "npm" }
}

/// PATH for the tools: the ffmpeg shims and the venv first, so `python3`,
/// `ffmpeg` and `ffprobe` resolve even on a machine without them.
fn path_env(dir: &Path) -> String {
    let sep = if cfg!(windows) { ";" } else { ":" };
    let venv_bin = venv_python(dir)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    [
        dir.join(".bin").to_string_lossy().into_owned(),
        venv_bin.to_string_lossy().into_owned(),
        build_cli_path_env(),
    ]
    .join(sep)
}

fn hash_file(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    Some(format!("{:x}", Sha256::digest(&bytes)))
}

fn stamp_matches(stamp: &Path, source: &Path) -> bool {
    match (std::fs::read_to_string(stamp).ok(), hash_file(source)) {
        (Some(s), Some(h)) => s.trim() == h,
        _ => false,
    }
}

fn node_ready(env: &Path) -> bool {
    let runtime = env.join("remotion");
    stamp_matches(
        &runtime.join("node_modules").join(NPM_STAMP),
        &runtime.join("package-lock.json"),
    )
}

fn python_ready(env: &Path) -> bool {
    venv_python(env).is_file()
        && stamp_matches(
            &env.join(".venv").join(PIP_STAMP),
            &env.join("requirements.txt"),
        )
}

fn docs_ready(env: &Path) -> bool {
    env.join("remotion/docs/.version").is_file()
}

fn linked(root: &Path) -> bool {
    root.join("core/tools/common.py").is_file()
        && venv_python(root).is_file()
        && root.join("remotion/node_modules").is_dir()
}

/// Same rule as `core/tools/common.py`: lowercase, digits, underscores.
fn check_id(id: &str) -> Result<(), String> {
    let mut chars = id.chars();
    let ok = chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    if ok {
        Ok(())
    } else {
        Err("Tên dự án chỉ gồm chữ thường, số, gạch dưới và bắt đầu bằng chữ.".into())
    }
}

/// `studio_port` in `core/tools/common.py`: fixed per id, so several studios
/// never collide.
fn studio_port(id: &str) -> u16 {
    let mut c = 0xFFFF_FFFFu32;
    for &b in id.as_bytes() {
        c ^= b as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 {
                (c >> 1) ^ 0xEDB8_8320
            } else {
                c >> 1
            };
        }
    }
    3100 + ((!c) % 1800) as u16
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

fn walk_files(dir: &Path, base: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_files(&path, base, out);
        } else if let Ok(rel) = path.strip_prefix(base) {
            out.push(rel.to_path_buf());
        }
    }
}

fn marked_or_missing(path: &Path) -> bool {
    match std::fs::read_to_string(path) {
        Ok(t) => t.contains(HOME_MARK),
        Err(_) => !path.exists(),
    }
}

/// Writes the shipped files under `src` into `dest` (only those under `only`
/// when given). `AGENTS.md` only while it still carries the app's mark;
/// everything else is the app's and is overwritten, and tools the app no
/// longer ships are removed from `core/`.
fn copy_shipped(src: &Path, dest: &Path, only: Option<&[&str]>) -> Result<(), String> {
    let mut files = Vec::new();
    walk_files(src, src, &mut files);
    if let Some(only) = only {
        files.retain(|rel| only.iter().any(|o| rel.starts_with(o)));
    }
    for rel in &files {
        let to = dest.join(rel);
        if rel == Path::new("AGENTS.md") && !marked_or_missing(&to) {
            continue;
        }
        let bytes = std::fs::read(src.join(rel)).map_err(|e| e.to_string())?;
        if std::fs::read(&to).ok().as_deref() == Some(bytes.as_slice()) {
            continue;
        }
        if let Some(dir) = to.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        std::fs::write(&to, bytes).map_err(|e| format!("{}: {e}", to.display()))?;
    }
    for dir in ["core/kit", "core/tools"] {
        for entry in std::fs::read_dir(dest.join(dir))
            .into_iter()
            .flatten()
            .flatten()
        {
            let path = entry.path();
            let rel = Path::new(dir).join(entry.file_name());
            if path.is_file() && !files.contains(&rel) {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    Ok(())
}

/// The working folder's own files: the shipped ones, CLAUDE.md, the user's
/// folders, and nothing else old builds left behind.
fn sync_root(src: &Path, root: &Path) -> Result<(), String> {
    copy_shipped(src, root, None)?;
    remove_old_copies(root);
    link_skills(root);
    let claude = root.join("CLAUDE.md");
    if marked_or_missing(&claude) {
        let text = format!("{HOME_MARK}\n@AGENTS.md\n");
        if std::fs::read_to_string(&claude).ok().as_deref() != Some(text.as_str()) {
            std::fs::write(&claude, text).map_err(|e| e.to_string())?;
        }
    }
    for dir in [
        "skills",
        "projects",
        "voice",
        "library/music",
        "library/sfx",
        "library/images",
        "library/footage",
    ] {
        std::fs::create_dir_all(root.join(dir)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Points the working folder's heavy parts at the environment. A real folder
/// already there (the user's own install) is left alone.
fn link_env(env: &Path, root: &Path) -> Result<(), String> {
    for rel in LINKS {
        let target = env.join(rel);
        if !target.exists() {
            continue;
        }
        let link = root.join(rel);
        let is_link = std::fs::symlink_metadata(&link).is_ok_and(|m| m.file_type().is_symlink());
        if is_link && std::fs::read_link(&link).is_ok_and(|t| t != target) {
            let _ = std::fs::remove_file(&link);
        }
        if let Some(dir) = link.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        crate::media::remotion::link_dir(&target, &link)?;
    }
    Ok(())
}

/// Earlier builds copied the library's skills and subagents into the agent
/// home; skills now come from `skills/` as links (`core/tools/setup.py`), and
/// a copy left in place would keep a skill of the same name from linking.
fn remove_old_copies(root: &Path) {
    use crate::ai_cli::library::{SKILL_MARK_FILE, SYNC_MARK};
    for dir in [".claude/skills", ".agents/skills"] {
        for entry in std::fs::read_dir(root.join(dir))
            .into_iter()
            .flatten()
            .flatten()
        {
            let path = entry.path();
            let is_link =
                std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink());
            if !is_link && path.join(SKILL_MARK_FILE).is_file() {
                let _ = std::fs::remove_dir_all(&path);
            }
        }
    }
    for dir in [".claude/agents", ".agents/agents"] {
        for entry in std::fs::read_dir(root.join(dir))
            .into_iter()
            .flatten()
            .flatten()
        {
            if std::fs::read_to_string(entry.path()).is_ok_and(|t| t.contains(SYNC_MARK)) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// Links each `skills/<name>` into `.claude/skills` (Claude Code) and
/// `.agents/skills` (Antigravity), like `core/tools/setup.py` does, but
/// without needing the environment. A real folder of the same name (the
/// user's own) is left alone; links to removed skills go.
fn link_skills(root: &Path) {
    let skills = find_skill_dirs(&root.join("skills"));
    for home in [".claude/skills", ".agents/skills"] {
        let home = root.join(home);
        let _ = std::fs::create_dir_all(&home);
        for skill in &skills {
            let Some(name) = skill.file_name() else {
                continue;
            };
            let link = home.join(name);
            if std::fs::symlink_metadata(&link).is_ok() {
                continue;
            }
            #[cfg(unix)]
            let _ = std::os::unix::fs::symlink(Path::new("../../skills").join(name), &link);
            #[cfg(windows)]
            let _ = crate::media::remotion::link_dir(skill, &link);
        }
        for entry in std::fs::read_dir(&home).into_iter().flatten().flatten() {
            let path = entry.path();
            let is_link =
                std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink());
            if is_link && !path.exists() {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}

fn list_skills(root: &Path) -> Vec<SkillEntry> {
    find_skill_dirs(&root.join("skills"))
        .into_iter()
        .filter_map(|dir| {
            let text = std::fs::read_to_string(dir.join("SKILL.md")).ok()?;
            let (name, desc) = skill_frontmatter(&text);
            let folder = dir.file_name()?.to_string_lossy().into_owned();
            Some(SkillEntry {
                name: name.unwrap_or_else(|| folder.clone()),
                description: desc.unwrap_or_default(),
                path: dir.to_string_lossy().into_owned(),
                folder,
            })
        })
        .collect()
}

/// Writes the working folder's files (no installs, no links): the agent home
/// calls this so an agent opened there has its rules before the first setup.
pub fn sync_shipped(app: &AppHandle) -> Result<(), String> {
    sync_root(&resource_dir(app)?, &root(app))
}

/// `.bin/ffmpeg` (the app's own) and `.bin/ffprobe` (the one Remotion ships),
/// so the tools find both on a machine that has neither.
fn write_shims(env: &Path) {
    let bin = env.join(".bin");
    let _ = std::fs::create_dir_all(&bin);
    let ffmpeg = crate::media::probe::ffmpeg_binary();
    let ffprobe = std::fs::read_dir(env.join("remotion/node_modules/@remotion"))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("compositor-"))
        .map(|e| {
            e.path().join(if cfg!(windows) {
                "ffprobe.exe"
            } else {
                "ffprobe"
            })
        })
        .find(|p| p.is_file());
    for (name, target) in [
        ("ffmpeg", Some(ffmpeg).filter(|p| p.is_absolute())),
        ("ffprobe", ffprobe),
    ] {
        let Some(target) = target else { continue };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let shim = bin.join(name);
            let text = format!("#!/bin/sh\nexec \"{}\" \"$@\"\n", target.display());
            if std::fs::write(&shim, text).is_ok() {
                let _ = std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755));
            }
        }
        #[cfg(windows)]
        {
            let _ = std::fs::write(
                bin.join(format!("{name}.cmd")),
                format!("@\"{}\" %*\r\n", target.display()),
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

fn command(dir: &Path, cwd: &Path, program: &Path) -> Command {
    let mut cmd = Command::new(program);
    cmd.current_dir(cwd)
        .env("PATH", path_env(dir))
        .env("BROWSER", "none")
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .hidden();
    cmd
}

fn strip_ansi(s: &str) -> String {
    static RE: Lazy<regex::Regex> =
        Lazy::new(|| regex::Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").unwrap());
    RE.replace_all(s, "").into_owned()
}

/// Runs to the end and returns its output; on failure the error holds the
/// last lines of it. `dir` is the folder whose `.bin`/`.venv` go on PATH.
async fn run(
    dir: &Path,
    cwd: &Path,
    program: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<String, String> {
    let mut cmd = command(dir, cwd, program);
    cmd.args(args);
    let shown = format!(
        "{} {}",
        program.file_name().unwrap_or_default().to_string_lossy(),
        args.join(" ")
    );
    let out = tokio::time::timeout(timeout, cmd.output())
        .await
        .map_err(|_| format!("`{shown}` took too long and was stopped."))?
        .map_err(|e| format!("Could not run `{shown}`: {e}"))?;
    let text = strip_ansi(&format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    ));
    if out.status.success() {
        Ok(text.trim().to_string())
    } else {
        let lines: Vec<&str> = text.lines().collect();
        let tail = lines[lines.len().saturating_sub(ERROR_TAIL_LINES)..].join("\n");
        Err(format!("`{shown}` failed:\n{tail}"))
    }
}

/// Runs one of `<dir>/core/tools/*.py` with `<dir>`'s Python, from `<dir>`.
async fn tool(dir: &Path, script: &str, args: &[&str]) -> Result<String, String> {
    if !venv_python(dir).is_file() {
        return Err("The Remotion environment is not installed yet (Settings).".into());
    }
    let script = format!("core/tools/{script}");
    let mut all = vec![script.as_str()];
    all.extend_from_slice(args);
    run(dir, dir, &venv_python(dir), &all, TOOL_TIMEOUT).await
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

pub fn status(app: &AppHandle) -> Status {
    let root = root(app);
    let env = env_dir(app).unwrap_or_default();
    let st = lock();
    let node = node_ready(&env);
    let python = python_ready(&env);
    Status {
        root: root.to_string_lossy().into_owned(),
        busy: st.busy,
        stage: st.stage.clone(),
        error: st.error.clone(),
        node,
        python,
        docs: docs_ready(&env),
        ready: node && python && linked(&root),
    }
}

fn emit_status(app: &AppHandle) {
    let _ = app.emit(STATUS_EVENT, status(app));
}

fn set_stage(app: &AppHandle, stage: &str) {
    lock().stage = Some(stage.to_string());
    emit_status(app);
}

/// At app start: refresh an environment installed before (an update may
/// bring new tools or another Remotion) and its links. A first install waits
/// for the user, since it downloads Node packages and Python.
pub async fn prepare(app: AppHandle) {
    if env_dir(&app).is_ok_and(|e| venv_python(&e).is_file()) {
        let _ = setup(app).await;
    }
}

/// Installs or updates the environment, then links it into the working folder.
pub async fn setup(app: AppHandle) -> Result<(), String> {
    {
        let mut st = lock();
        if st.busy {
            return Ok(());
        }
        st.busy = true;
        st.error = None;
    }
    emit_status(&app);
    let result = match install_env(&app).await {
        Ok(()) => link_root(&app).await,
        Err(e) => Err(e),
    };
    {
        let mut st = lock();
        st.busy = false;
        st.stage = None;
        st.error = result.as_ref().err().cloned();
    }
    emit_status(&app);
    result
}

async fn install_env(app: &AppHandle) -> Result<(), String> {
    let env = env_dir(app)?;
    let src = resource_dir(app)?;

    set_stage(app, "files");
    let (s, e) = (src.clone(), env.clone());
    tauri::async_runtime::spawn_blocking(move || copy_shipped(&s, &e, Some(ENV_FILES)))
        .await
        .map_err(|e| e.to_string())??;

    set_stage(app, "node");
    if !node_ready(&env) {
        let path = path_env(&env);
        let npm_bin = which::which_in(npm(), Some(&path), &env).map_err(|_| {
            "Node.js is not installed. Install it from nodejs.org, then try again.".to_string()
        })?;
        let runtime = env.join("remotion");
        run(
            &env,
            &runtime,
            &npm_bin,
            &["ci", "--no-audit", "--no-fund"],
            NPM_TIMEOUT,
        )
        .await?;
        if let Some(h) = hash_file(&runtime.join("package-lock.json")) {
            let _ = std::fs::write(runtime.join("node_modules").join(NPM_STAMP), h);
        }
    }

    set_stage(app, "python");
    if !python_ready(&env) {
        if !venv_python(&env).is_file() {
            let python = crate::tts::managed_python::ensure_managed_python(app, SETUP_JOB).await?;
            run(&env, &env, &python, &["-m", "venv", ".venv"], PIP_TIMEOUT).await?;
        }
        let args = [
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "-r",
            "requirements.txt",
        ];
        run(&env, &env, &venv_python(&env), &args, PIP_TIMEOUT).await?;
        if let Some(h) = hash_file(&env.join("requirements.txt")) {
            let _ = std::fs::write(env.join(".venv").join(PIP_STAMP), h);
        }
    }
    write_shims(&env);

    // The Remotion docs need git and the network; the tools work without them.
    if !docs_ready(&env) {
        set_stage(app, "docs");
        if let Err(e) = tool(&env, "upgrade.py", &[]).await {
            tracing::warn!("Video Studio: Remotion docs not downloaded: {e}");
        }
    }
    Ok(())
}

/// Writes the working folder and links the environment into it, then lets
/// `setup.py` link skills and write the tsconfig aliases.
async fn link_root(app: &AppHandle) -> Result<(), String> {
    set_stage(app, "links");
    let (src, env, root) = (resource_dir(app)?, env_dir(app)?, root(app));
    let r = root.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        sync_root(&src, &r)?;
        link_env(&env, &r)
    })
    .await
    .map_err(|e| e.to_string())??;
    tool(&root, "setup.py", &[]).await.map(|_| ())
}

/// Re-links skills into `.claude/skills` / `.agents/skills`, and the
/// `@skill/<name>` aliases once the environment is there, after skills change.
async fn relink(root: &Path) {
    link_skills(root);
    if venv_python(root).is_file() {
        if let Err(e) = tool(root, "setup.py", &[]).await {
            tracing::warn!("Video Studio: setup.py failed: {e}");
        }
    }
}

// ---------------------------------------------------------------------------
// Studio processes
// ---------------------------------------------------------------------------

async fn port_open(port: u16) -> bool {
    for host in ["127.0.0.1", "[::1]"] {
        if let Ok(Ok(_)) = tokio::time::timeout(
            Duration::from_millis(200),
            TcpStream::connect(format!("{host}:{port}")),
        )
        .await
        {
            return true;
        }
    }
    false
}

fn push_log(line: String) {
    let mut logs = STUDIO_LOGS.lock().unwrap_or_else(|e| e.into_inner());
    if logs.len() >= STUDIO_LOG_LINES {
        logs.pop_front();
    }
    logs.push_back(line);
}

fn recent_logs(n: usize) -> String {
    let logs = STUDIO_LOGS.lock().unwrap_or_else(|e| e.into_inner());
    logs.iter()
        .skip(logs.len().saturating_sub(n))
        .cloned()
        .collect::<Vec<_>>()
        .join("\n")
}

fn kill_tree(pid: u32) {
    #[cfg(unix)]
    {
        // The studio is its own process group leader, so this also stops the
        // npx/node children render.py spawned.
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &format!("-{pid}")])
            .status();
    }
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .hidden()
            .status();
    }
}

fn stop(id: &str) {
    if let Some(running) = lock().studios.remove(id) {
        if let Some(pid) = running.pid {
            kill_tree(pid);
        }
    }
}

/// Stops every studio. Safe to call from the exit handler.
pub fn shutdown() {
    let studios: Vec<Running> = lock().studios.drain().map(|(_, r)| r).collect();
    for r in studios {
        if let Some(pid) = r.pid {
            kill_tree(pid);
        }
    }
}

/// Builds the project and opens its Remotion Studio (one at a time; opening
/// another stops the previous one).
async fn open_studio(app: &AppHandle, id: &str) -> Result<StudioInfo, String> {
    check_id(id)?;
    let root = root(app);
    if !root
        .join("projects")
        .join(id)
        .join("project.json")
        .is_file()
    {
        return Err(format!("No project `{id}`."));
    }
    let port = studio_port(id);
    let url = format!("http://localhost:{port}");
    let others: Vec<String> = lock()
        .studios
        .keys()
        .filter(|k| *k != id)
        .cloned()
        .collect();
    for other in others {
        stop(&other);
    }

    tool(&root, "build.py", &[id]).await?;

    // The running studio picks up the rebuilt entry on its own.
    let already = lock().studios.get(id).map(|r| r.port);
    if already == Some(port) && port_open(port).await {
        return Ok(StudioInfo {
            id: id.to_string(),
            url,
        });
    }
    stop(id);

    STUDIO_LOGS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
    let mut cmd = command(&root, &root, &venv_python(&root));
    cmd.args(["core/tools/render.py", id, "--studio"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false);
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start Remotion Studio: {e}"))?;
    let readers: [Option<Box<dyn tokio::io::AsyncRead + Unpin + Send>>; 2] = [
        child
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
        child
            .stderr
            .take()
            .map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
    ];
    for reader in readers.into_iter().flatten() {
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(reader).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                push_log(strip_ansi(&line));
            }
        });
    }
    let pid = child.id();
    lock().studios.insert(id.to_string(), Running { pid, port });

    let started = std::time::Instant::now();
    loop {
        if port_open(port).await {
            tauri::async_runtime::spawn(async move {
                let _ = child.wait().await;
            });
            return Ok(StudioInfo {
                id: id.to_string(),
                url,
            });
        }
        if let Ok(Some(_)) = child.try_wait() {
            lock().studios.remove(id);
            return Err(format!(
                "Remotion Studio stopped:\n{}",
                recent_logs(ERROR_TAIL_LINES)
            ));
        }
        if started.elapsed() > STUDIO_START_TIMEOUT {
            stop(id);
            return Err(format!(
                "Remotion Studio did not start:\n{}",
                recent_logs(ERROR_TAIL_LINES)
            ));
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

fn modified_sec(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Video projects in the working folder, newest change first.
fn list_projects(root: &Path) -> Vec<ProjectEntry> {
    let mut out: Vec<ProjectEntry> = std::fs::read_dir(root.join("projects"))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let dir = e.path();
            let meta: Value =
                serde_json::from_str(&std::fs::read_to_string(dir.join("project.json")).ok()?)
                    .ok()?;
            let id = e.file_name().to_string_lossy().into_owned();
            Some(ProjectEntry {
                title: meta["title"]
                    .as_str()
                    .filter(|t| !t.is_empty())
                    .unwrap_or(&id)
                    .to_string(),
                path: dir.to_string_lossy().into_owned(),
                modified_sec: ["project.json", "plan", "src/scenes", "out"]
                    .iter()
                    .map(|p| modified_sec(&dir.join(p)))
                    .max()
                    .unwrap_or(0),
                id,
            })
        })
        .collect();
    out.sort_by(|a, b| b.modified_sec.cmp(&a.modified_sec));
    out
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn studio_status(app: AppHandle) -> Status {
    status(&app)
}

#[tauri::command]
pub async fn studio_setup(app: AppHandle) -> Result<Status, String> {
    setup(app.clone()).await?;
    Ok(status(&app))
}

/// Moves the working folder (also the external agents' home) and links the
/// environment into the new one.
#[tauri::command]
pub async fn studio_set_root(app: AppHandle, path: String) -> Result<Status, String> {
    shutdown();
    crate::ai_edit::mcp::external::set_home(&app, path);
    let a = app.clone();
    let _ =
        tauri::async_runtime::spawn_blocking(move || crate::ai_edit::mcp::external::write_home(&a))
            .await;
    let env_installed = env_dir(&app).is_ok_and(|e| node_ready(&e) && python_ready(&e));
    if env_installed {
        setup(app.clone()).await?;
    } else {
        emit_status(&app);
    }
    Ok(status(&app))
}

#[tauri::command]
pub async fn studio_projects(app: AppHandle) -> Vec<ProjectEntry> {
    list_projects(&root(&app))
}

#[tauri::command]
pub async fn studio_open(app: AppHandle, id: String) -> Result<StudioInfo, String> {
    open_studio(&app, &id).await
}

#[tauri::command]
pub async fn studio_stop(id: Option<String>) -> Result<(), String> {
    match id {
        Some(id) => stop(&id),
        None => shutdown(),
    }
    Ok(())
}

#[tauri::command]
pub async fn studio_logs() -> String {
    recent_logs(STUDIO_LOG_LINES)
}

#[tauri::command]
pub async fn studio_skills(app: AppHandle) -> Vec<SkillEntry> {
    let root = root(&app);
    // Skills copied in by hand get their agent links here too.
    link_skills(&root);
    list_skills(&root)
}

/// Copies every skill folder found in `source` into the working folder's
/// `skills/`. A skill of the same folder name is replaced only with `replace`.
#[tauri::command]
pub async fn studio_import_skills(
    app: AppHandle,
    source: String,
    replace: bool,
) -> Result<Vec<String>, String> {
    let root = root(&app);
    let skills_dir = root.join("skills");
    std::fs::create_dir_all(&skills_dir).map_err(|e| e.to_string())?;
    let found = find_skill_dirs(Path::new(&source));
    if found.is_empty() {
        return Err("Không thấy SKILL.md trong thư mục này hoặc các thư mục con.".into());
    }
    let canon_skills = skills_dir.canonicalize().map_err(|e| e.to_string())?;
    let mut names = Vec::new();
    for src in found {
        let name = src
            .file_name()
            .ok_or("Đường dẫn không hợp lệ")?
            .to_string_lossy()
            .into_owned();
        if src
            .canonicalize()
            .is_ok_and(|s| s.starts_with(&canon_skills))
        {
            continue;
        }
        let dst = skills_dir.join(&name);
        if dst.exists() {
            if !replace {
                return Err(format!("EXISTS:{name}"));
            }
            std::fs::remove_dir_all(&dst).map_err(|e| format!("{name}: {e}"))?;
        }
        copy_recursive(&src, &dst).map_err(|e| format!("Không chép được {name}: {e}"))?;
        names.push(name);
    }
    relink(&root).await;
    Ok(names)
}

#[tauri::command]
pub async fn studio_remove_skill(app: AppHandle, folder: String) -> Result<(), String> {
    let root = root(&app);
    if folder.is_empty() || folder.contains(['/', '\\']) || folder.starts_with('.') {
        return Err("Tên skill không hợp lệ.".into());
    }
    let dir = root.join("skills").join(&folder);
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    relink(&root).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ports_match_the_python_tools() {
        // 3100 + zlib.crc32(id) % 1800, as core/tools/common.py computes it.
        assert_eq!(studio_port("vid7"), 4667);
        assert_eq!(studio_port("t"), 3252);
    }

    #[test]
    fn checks_ids_like_the_python_tools() {
        assert!(check_id("vid_7").is_ok());
        assert!(check_id("7vid").is_err());
        assert!(check_id("Vid").is_err());
        assert!(check_id("").is_err());
    }

    #[test]
    fn writes_the_working_folder_and_keeps_the_users_files() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        let root = tmp.path().join("root");
        std::fs::create_dir_all(src.join("core/tools")).unwrap();
        std::fs::write(src.join("core/tools/common.py"), "new").unwrap();
        std::fs::write(src.join("AGENTS.md"), format!("{HOME_MARK}\nrules")).unwrap();
        std::fs::create_dir_all(root.join("core/tools")).unwrap();
        std::fs::write(root.join("core/tools/common.py"), "old").unwrap();
        std::fs::write(root.join("core/tools/gone.py"), "x").unwrap();
        std::fs::write(root.join("AGENTS.md"), "my own rules").unwrap();
        std::fs::create_dir_all(root.join(".claude/skills/old-copy")).unwrap();
        std::fs::write(root.join(".claude/skills/old-copy/.autosubs"), "").unwrap();
        std::fs::create_dir_all(root.join(".claude/skills/hand-made")).unwrap();

        sync_root(&src, &root).unwrap();

        assert_eq!(
            std::fs::read_to_string(root.join("core/tools/common.py")).unwrap(),
            "new"
        );
        assert!(!root.join("core/tools/gone.py").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("AGENTS.md")).unwrap(),
            "my own rules"
        );
        assert!(
            std::fs::read_to_string(root.join("CLAUDE.md"))
                .unwrap()
                .contains("@AGENTS.md")
        );
        assert!(root.join("skills").is_dir() && root.join("projects").is_dir());
        assert!(!root.join(".claude/skills/old-copy").exists());
        assert!(root.join(".claude/skills/hand-made").is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn links_the_environment_but_keeps_a_real_install() {
        let tmp = tempfile::tempdir().unwrap();
        let (env, root) = (tmp.path().join("env"), tmp.path().join("root"));
        for rel in [
            "remotion/node_modules",
            "remotion/docs",
            ".venv/bin",
            ".bin",
        ] {
            std::fs::create_dir_all(env.join(rel)).unwrap();
        }
        std::fs::create_dir_all(root.join(".venv")).unwrap();

        link_env(&env, &root).unwrap();

        assert_eq!(
            std::fs::read_link(root.join("remotion/node_modules")).unwrap(),
            env.join("remotion/node_modules")
        );
        assert_eq!(
            std::fs::read_link(root.join(".bin")).unwrap(),
            env.join(".bin")
        );
        assert!(
            std::fs::read_link(root.join(".venv")).is_err(),
            "a real .venv stays"
        );
    }

    #[cfg(unix)]
    #[test]
    fn links_skills_for_both_agent_apps() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("skills/military")).unwrap();
        std::fs::write(
            root.join("skills/military/SKILL.md"),
            "---\nname: military\ndescription: d\n---\n",
        )
        .unwrap();
        std::fs::create_dir_all(root.join(".claude/skills/mine")).unwrap();
        std::os::unix::fs::symlink("../../skills/gone", root.join(".agents/skills-gone")).ok();
        link_skills(root);
        for home in [".claude/skills", ".agents/skills"] {
            assert!(root.join(home).join("military/SKILL.md").is_file());
        }
        assert!(root.join(".claude/skills/mine").is_dir());
        assert_eq!(list_skills(root)[0].name, "military");
    }

    #[test]
    fn env_gets_only_what_it_needs() {
        let tmp = tempfile::tempdir().unwrap();
        let (src, env) = (tmp.path().join("src"), tmp.path().join("env"));
        std::fs::create_dir_all(src.join("remotion")).unwrap();
        std::fs::write(src.join("remotion/package.json"), "{}").unwrap();
        std::fs::write(src.join("README.md"), "readme").unwrap();
        copy_shipped(&src, &env, Some(ENV_FILES)).unwrap();
        assert!(env.join("remotion/package.json").is_file());
        assert!(!env.join("README.md").exists());
    }
}
