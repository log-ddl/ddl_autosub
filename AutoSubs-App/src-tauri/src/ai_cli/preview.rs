//! Live preview of what the agent coded under the project's `motion-graphics/`.
//!
//! One preview runs at a time, always on 127.0.0.1:
//! - A folder with a `dev` script in `package.json` (Vite, Remotion, ...) runs
//!   that script; dependencies are installed first if `node_modules` is missing.
//! - Anything else is served as files by a small built-in server. `.ts`/`.tsx`/
//!   `.jsx` are transpiled on the fly (oxc), bare imports (`"three"`) resolve to
//!   esm.sh, and `import "./x.css"` / `.json` / images become JS modules, so
//!   code the agent writes for a bundler still runs without one.

use std::collections::VecDeque;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

use regex::Regex;
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Command;
use tokio::task::JoinHandle;

use super::runtime::build_cli_path_env;

const DEV_START_TIMEOUT: Duration = Duration::from_secs(180);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);
const MAX_LOG_LINES: usize = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewInfo {
    pub url: String,
    pub kind: &'static str, // "static" | "dev"
    pub root: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTarget {
    pub name: String,
    pub path: String,
    pub kind: &'static str,
    pub modified_sec: i64,
}

enum Target {
    Static { root: PathBuf, entry: String },
    Dev { root: PathBuf },
}

struct Running {
    server: Option<JoinHandle<()>>,
    pid: Option<u32>,
}

type Logs = Arc<Mutex<VecDeque<String>>>;

fn current() -> &'static Mutex<Option<Running>> {
    static CURRENT: OnceLock<Mutex<Option<Running>>> = OnceLock::new();
    CURRENT.get_or_init(|| Mutex::new(None))
}

fn logs() -> &'static Logs {
    static LOGS: OnceLock<Logs> = OnceLock::new();
    LOGS.get_or_init(|| Arc::new(Mutex::new(VecDeque::new())))
}

fn push_log(line: impl Into<String>) {
    if let Ok(mut l) = logs().lock() {
        l.push_back(line.into());
        while l.len() > MAX_LOG_LINES {
            l.pop_front();
        }
    }
}

fn recent_logs(n: usize) -> String {
    let Ok(l) = logs().lock() else { return String::new() };
    let skip = l.len().saturating_sub(n);
    l.iter().skip(skip).cloned().collect::<Vec<_>>().join("\n")
}

// ── Target detection ────────────────────────────────────────────────────────

fn has_dev_script(dir: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(dir.join("package.json")) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("scripts")?.get("dev").cloned())
        .is_some_and(|v| v.is_string())
}

fn is_html(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(),
        Some("html" | "htm")
    )
}

fn detect(path: &Path) -> Result<Target, String> {
    if path.is_file() {
        if !is_html(path) {
            return Err("Chỉ preview được file .html hoặc một thư mục.".into());
        }
        let root = path.parent().ok_or("Đường dẫn không hợp lệ")?.to_path_buf();
        let entry = path.file_name().unwrap().to_string_lossy().into_owned();
        return Ok(Target::Static { root, entry });
    }
    if !path.is_dir() {
        return Err(format!("Không tìm thấy {}", path.display()));
    }
    if has_dev_script(path) {
        return Ok(Target::Dev { root: path.to_path_buf() });
    }
    if path.join("index.html").is_file() {
        return Ok(Target::Static { root: path.to_path_buf(), entry: "index.html".into() });
    }
    let mut html: Vec<String> = std::fs::read_dir(path)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|e| is_html(&e.path()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    html.sort();
    match html.into_iter().next() {
        Some(entry) => Ok(Target::Static { root: path.to_path_buf(), entry }),
        None => Err("Thư mục không có index.html hoặc script \"dev\" trong package.json.".into()),
    }
}

fn mtime(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Newest modification time of any file under `dir`, skipping dependencies.
fn newest_mtime(dir: &Path, depth: usize) -> i64 {
    let mut newest = mtime(dir);
    if depth == 0 {
        return newest;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return newest };
    for entry in rd.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let p = entry.path();
        let t = if p.is_dir() { newest_mtime(&p, depth - 1) } else { mtime(&p) };
        newest = newest.max(t);
    }
    newest
}

/// Previewable folders and `.html` files directly under `dir` changed at or
/// after `since_sec` (pass 0 for all), newest first.
#[tauri::command]
pub fn preview_candidates(dir: String, since_sec: i64) -> Vec<PreviewTarget> {
    let Ok(rd) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut out: Vec<PreviewTarget> = rd
        .flatten()
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|e| {
            let p = e.path();
            let kind = match detect(&p).ok()? {
                Target::Static { .. } => "static",
                Target::Dev { .. } => "dev",
            };
            let modified_sec = if p.is_dir() { newest_mtime(&p, 6) } else { mtime(&p) };
            (modified_sec >= since_sec).then(|| PreviewTarget {
                name: e.file_name().to_string_lossy().into_owned(),
                path: p.to_string_lossy().into_owned(),
                kind,
                modified_sec,
            })
        })
        .collect();
    out.sort_by(|a, b| b.modified_sec.cmp(&a.modified_sec));
    out
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

fn kill_tree(pid: u32) {
    #[cfg(not(target_os = "windows"))]
    {
        // The dev server is its own process group leader, so this also stops
        // the node/vite children that `npm run` spawned.
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &format!("-{pid}")])
            .status();
    }
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }
}

/// Stops the running preview, if any. Safe to call from the exit handler.
pub fn shutdown() {
    let running = current().lock().ok().and_then(|mut g| g.take());
    if let Some(r) = running {
        if let Some(server) = r.server {
            server.abort();
        }
        if let Some(pid) = r.pid {
            kill_tree(pid);
        }
    }
}

#[tauri::command]
pub async fn preview_stop() -> Result<(), String> {
    shutdown();
    Ok(())
}

#[tauri::command]
pub fn preview_logs() -> String {
    recent_logs(MAX_LOG_LINES)
}

#[tauri::command]
pub async fn preview_start(path: String) -> Result<PreviewInfo, String> {
    shutdown();
    if let Ok(mut l) = logs().lock() {
        l.clear();
    }
    match detect(Path::new(path.trim()))? {
        Target::Static { root, entry } => start_static(root, entry).await,
        Target::Dev { root } => start_dev(root).await,
    }
}

async fn start_static(root: PathBuf, entry: String) -> Result<PreviewInfo, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let serve_root = root.clone();
    let server = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let root = serve_root.clone();
            tokio::spawn(async move {
                let _ = handle_static(stream, &root).await;
            });
        }
    });
    *current().lock().map_err(|e| e.to_string())? = Some(Running { server: Some(server), pid: None });
    Ok(PreviewInfo {
        url: format!("http://127.0.0.1:{port}/{}", encode_path(&entry)),
        kind: "static",
        root: root.to_string_lossy().into_owned(),
    })
}

fn package_manager(root: &Path) -> &'static str {
    if root.join("bun.lock").exists() || root.join("bun.lockb").exists() {
        "bun"
    } else if root.join("pnpm-lock.yaml").exists() {
        "pnpm"
    } else if root.join("yarn.lock").exists() {
        "yarn"
    } else {
        "npm"
    }
}

fn spawn_logged(cmd: &mut Command, logs_prefix: &'static str) -> Result<tokio::process::Child, String> {
    let mut child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Không chạy được lệnh: {e}"))?;
    if let Some(out) = child.stdout.take() {
        tokio::spawn(pipe_lines(out, logs_prefix));
    }
    if let Some(err) = child.stderr.take() {
        tokio::spawn(pipe_lines(err, logs_prefix));
    }
    Ok(child)
}

async fn pipe_lines(reader: impl tokio::io::AsyncRead + Unpin, prefix: &'static str) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        push_log(format!("{prefix}{}", strip_ansi(&line)));
    }
}

fn strip_ansi(s: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]").unwrap())
        .replace_all(s, "")
        .into_owned()
}

fn command_in(root: &Path, bin: &str, path_env: &str) -> Result<Command, String> {
    let exe = which::which_in(bin, Some(path_env), root)
        .map_err(|_| format!("Không tìm thấy `{bin}`. Hãy cài Node.js (hoặc {bin}) để preview project này."))?;
    let mut cmd = Command::new(exe);
    cmd.current_dir(root)
        .env("PATH", path_env)
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .env("BROWSER", "none");
    Ok(cmd)
}

async fn start_dev(root: PathBuf) -> Result<PreviewInfo, String> {
    let pm = package_manager(&root);
    let path_env = build_cli_path_env();

    if !root.join("node_modules").exists() {
        push_log(format!("$ {pm} install"));
        let mut child = spawn_logged(command_in(&root, pm, &path_env)?.arg("install"), "")?;
        let status = tokio::time::timeout(INSTALL_TIMEOUT, child.wait())
            .await
            .map_err(|_| "Cài thư viện quá lâu, đã dừng.".to_string())?
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("`{pm} install` lỗi:\n{}", recent_logs(30)));
        }
    }

    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        l.local_addr().map_err(|e| e.to_string())?.port()
    };
    let mut cmd = command_in(&root, pm, &path_env)?;
    cmd.args(["run", "dev"]);
    // npm swallows flags unless they come after `--`; the others forward them.
    if pm == "npm" {
        cmd.arg("--");
    }
    cmd.args(["--port", &port.to_string()]).env("PORT", port.to_string());
    #[cfg(unix)]
    cmd.process_group(0);
    push_log(format!("$ {pm} run dev --port {port}"));
    let mut child = spawn_logged(&mut cmd, "")?;
    let pid = child.id();
    *current().lock().map_err(|e| e.to_string())? = Some(Running { server: None, pid });

    let started = Instant::now();
    let url = loop {
        if let Some(url) = url_from_logs(port) {
            break url;
        }
        if port_open(port).await {
            break format!("http://localhost:{port}/");
        }
        if let Ok(Some(status)) = child.try_wait() {
            shutdown();
            return Err(format!("Dev server đã thoát ({status}):\n{}", recent_logs(30)));
        }
        if started.elapsed() > DEV_START_TIMEOUT {
            shutdown();
            return Err(format!("Dev server không mở cổng sau 3 phút:\n{}", recent_logs(30)));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    };
    // Reap the process when it exits so it doesn't linger as a zombie.
    tokio::spawn(async move {
        let _ = child.wait().await;
    });
    Ok(PreviewInfo { url, kind: "dev", root: root.to_string_lossy().into_owned() })
}

/// The URL a dev server printed, preferring the port we asked for (tools that
/// ignore `--port` print their own).
fn url_from_logs(port: u16) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"https?://(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)[^\s]*").unwrap());
    let text = recent_logs(MAX_LOG_LINES);
    let found: Vec<(String, u16)> = re
        .captures_iter(&text)
        .filter_map(|c| Some((c.get(0)?.as_str().to_string(), c.get(1)?.as_str().parse().ok()?)))
        .collect();
    found
        .iter()
        .find(|(_, p)| *p == port)
        .or(found.first())
        .map(|(u, _)| u.clone())
}

async fn port_open(port: u16) -> bool {
    for host in ["127.0.0.1", "[::1]"] {
        let addr = format!("{host}:{port}");
        if let Ok(Ok(_)) =
            tokio::time::timeout(Duration::from_millis(200), TcpStream::connect(&addr)).await
        {
            return true;
        }
    }
    false
}

// ── Static server ───────────────────────────────────────────────────────────

async fn handle_static(mut stream: TcpStream, root: &Path) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    loop {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() > 64 * 1024 {
            break;
        }
    }
    let head = String::from_utf8_lossy(&buf);
    let mut parts = head.lines().next().unwrap_or("").split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");
    if method != "GET" && method != "HEAD" {
        return respond(&mut stream, 405, "text/plain", b"Method Not Allowed", false).await;
    }
    let (raw_path, query) = target.split_once('?').unwrap_or((target, ""));
    let as_module = query.split('&').any(|q| q == "module");

    let Some(file) = resolve_file(root, &percent_decode(raw_path)) else {
        return respond(&mut stream, 404, "text/plain; charset=utf-8", b"Not Found", method == "HEAD").await;
    };
    let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let head_only = method == "HEAD";

    match ext.as_str() {
        "ts" | "tsx" | "mts" | "cts" | "jsx" => {
            let src = tokio::fs::read_to_string(&file).await.unwrap_or_default();
            let js = match transpile(&file, &src) {
                Ok(code) => rewrite_imports(&code),
                Err(err) => error_module(&file, root, &err),
            };
            respond(&mut stream, 200, "text/javascript; charset=utf-8", js.as_bytes(), head_only).await
        }
        "js" | "mjs" => {
            let src = tokio::fs::read_to_string(&file).await.unwrap_or_default();
            let js = rewrite_imports(&src);
            respond(&mut stream, 200, "text/javascript; charset=utf-8", js.as_bytes(), head_only).await
        }
        _ if as_module => {
            let js = asset_module(&file, root, &ext).await;
            respond(&mut stream, 200, "text/javascript; charset=utf-8", js.as_bytes(), head_only).await
        }
        _ => {
            let bytes = tokio::fs::read(&file).await.unwrap_or_default();
            respond(&mut stream, 200, mime_for(&ext), &bytes, head_only).await
        }
    }
}

async fn respond(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
    head_only: bool,
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Error",
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes()).await?;
    if !head_only {
        stream.write_all(body).await?;
    }
    stream.flush().await
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn encode_path(s: &str) -> String {
    s.split('/')
        .map(|seg| {
            seg.bytes()
                .map(|b| match b {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                        (b as char).to_string()
                    }
                    _ => format!("%{b:02X}"),
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Maps a URL path to a file inside `root`. Directories serve `index.html`;
/// extensionless module paths (`./scene`) try the usual source extensions.
fn resolve_file(root: &Path, url_path: &str) -> Option<PathBuf> {
    let rel = Path::new(url_path.trim_start_matches('/'));
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return None;
    }
    let base = root.join(rel);
    let mut candidates = vec![base.clone()];
    if base.is_dir() {
        candidates = vec![base.join("index.html")];
    }
    for ext in ["ts", "tsx", "js", "jsx", "mjs"] {
        candidates.push(PathBuf::from(format!("{}.{ext}", base.display())));
    }
    for name in ["index.ts", "index.tsx", "index.js", "index.jsx"] {
        candidates.push(base.join(name));
    }
    let found = candidates.into_iter().find(|p| p.is_file())?;
    // Symlinks must not lead outside the previewed folder.
    let canon = found.canonicalize().ok()?;
    canon.starts_with(root).then_some(canon)
}

fn mime_for(ext: &str) -> &'static str {
    match ext {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "txt" | "glsl" | "frag" | "vert" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// `import x from "./a.css"` and friends, the way bundlers treat them.
async fn asset_module(file: &Path, root: &Path, ext: &str) -> String {
    match ext {
        "css" => {
            let css = tokio::fs::read_to_string(file).await.unwrap_or_default();
            let lit = serde_json::to_string(&css).unwrap_or_default();
            format!(
                "const s = document.createElement('style');\ns.textContent = {lit};\n\
                 document.head.appendChild(s);\nexport default {lit};\n"
            )
        }
        "json" => {
            let json = tokio::fs::read_to_string(file).await.unwrap_or_default();
            format!("export default {json};\n")
        }
        "txt" | "glsl" | "frag" | "vert" | "md" => {
            let text = tokio::fs::read_to_string(file).await.unwrap_or_default();
            format!("export default {};\n", serde_json::to_string(&text).unwrap_or_default())
        }
        _ => {
            let rel = file.strip_prefix(root).unwrap_or(file).to_string_lossy().replace('\\', "/");
            format!("export default {};\n", serde_json::to_string(&format!("/{}", encode_path(&rel))).unwrap_or_default())
        }
    }
}

fn transpile(path: &Path, src: &str) -> Result<String, String> {
    use oxc::allocator::Allocator;
    use oxc::codegen::Codegen;
    use oxc::parser::Parser;
    use oxc::semantic::SemanticBuilder;
    use oxc::span::SourceType;
    use oxc::transformer::{TransformOptions, Transformer};

    let allocator = Allocator::default();
    let source_type = SourceType::from_path(path).map_err(|e| e.to_string())?;
    let parsed = Parser::new(&allocator, src, source_type).parse();
    if parsed.diagnostics.has_errors() {
        return Err(format_errors(src, parsed.diagnostics.errors().map(|e| (e.to_string(), first_offset(e)))));
    }
    let mut program = parsed.program;
    let scoping = SemanticBuilder::new().build(&program).semantic.into_scoping();
    let options = TransformOptions::default();
    let ret = Transformer::new(&allocator, path, &options).build_with_scoping(scoping, &mut program);
    if ret.diagnostics.has_errors() {
        return Err(format_errors(src, ret.diagnostics.errors().map(|e| (e.to_string(), first_offset(e)))));
    }
    Ok(Codegen::new().build(&program).code)
}

fn first_offset(e: &oxc::diagnostics::OxcDiagnostic) -> Option<usize> {
    e.labels.first().map(|l| l.offset() as usize)
}

fn format_errors(src: &str, errors: impl Iterator<Item = (String, Option<usize>)>) -> String {
    errors
        .map(|(msg, offset)| match offset {
            Some(off) => {
                let before = &src[..off.min(src.len())];
                let line = before.matches('\n').count() + 1;
                let col = before.len() - before.rfind('\n').map(|i| i + 1).unwrap_or(0) + 1;
                format!("{msg} ({line}:{col})")
            }
            None => msg,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// A module that shows a compile error on the page instead of a blank screen.
fn error_module(file: &Path, root: &Path, err: &str) -> String {
    let rel = file.strip_prefix(root).unwrap_or(file).to_string_lossy();
    let text = serde_json::to_string(&format!("{rel}\n{err}")).unwrap_or_default();
    format!(
        "const msg = {text};\nconsole.error(msg);\n\
         const pre = document.createElement('pre');\n\
         pre.style.cssText = 'position:fixed;inset:0;margin:0;padding:16px;background:#1a0f0f;color:#ff8a8a;\
         font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;z-index:2147483647;overflow:auto';\n\
         pre.textContent = msg;\n(document.body || document.documentElement).appendChild(pre);\n\
         throw new Error(msg);\n"
    )
}

const ASSET_EXTS: &[&str] = &[
    "css", "json", "svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "mp4", "webm", "mov", "mp3",
    "wav", "ogg", "m4a", "woff", "woff2", "ttf", "otf", "txt", "glsl", "frag", "vert", "md",
];

/// Bare specifiers go to esm.sh; non-JS relative imports get `?module`.
fn rewrite_imports(code: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(
            r#"(\bimport\s*(?:[\w$*{}\s,]+?\s*from\s*)?|\bexport\s*(?:[\w$*{}\s,]+?\s*)?from\s*|\bimport\s*\(\s*)(["'])([^"'\n]+)(["'])"#,
        )
        .unwrap()
    });
    re.replace_all(code, |c: &regex::Captures| {
        let spec = &c[3];
        let new_spec = if is_bare(spec) {
            format!("https://esm.sh/{spec}")
        } else if spec.starts_with('.') || spec.starts_with('/') {
            let path_part = spec.split(['?', '#']).next().unwrap_or(spec);
            let ext = path_part.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
            if ASSET_EXTS.contains(&ext.as_str()) && !spec.contains("module") {
                format!("{spec}{}module", if spec.contains('?') { '&' } else { '?' })
            } else {
                spec.to_string()
            }
        } else {
            spec.to_string()
        };
        format!("{}{}{}{}", &c[1], &c[2], new_spec, &c[4])
    })
    .into_owned()
}

fn is_bare(spec: &str) -> bool {
    !(spec.starts_with('.')
        || spec.starts_with('/')
        || spec.starts_with('#')
        || spec.contains("://")
        || spec.starts_with("data:")
        || spec.starts_with("blob:"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_bare_and_asset_imports() {
        let src = "import * as THREE from 'three';\nimport './style.css';\nimport data from \"./d.json\";\nimport { a } from './a.ts';\nexport { b } from 'gsap/all';\nconst m = import('./scene');";
        let out = rewrite_imports(src);
        assert!(out.contains("from 'https://esm.sh/three'"));
        assert!(out.contains("import './style.css?module'"));
        assert!(out.contains("from \"./d.json?module\""));
        assert!(out.contains("from './a.ts'"));
        assert!(out.contains("from 'https://esm.sh/gsap/all'"));
        assert!(out.contains("import('./scene')"));
    }

    #[test]
    fn transpiles_typescript() {
        let js = transpile(Path::new("a.ts"), "const x: number = 1; export type T = string; export default x as number;").unwrap();
        assert!(!js.contains(": number"));
        assert!(!js.contains("type T"));
    }

    #[test]
    fn reports_syntax_errors_with_position() {
        let err = transpile(Path::new("a.ts"), "const x = ;").unwrap_err();
        assert!(err.contains("(1:"));
    }

    #[tokio::test]
    async fn serves_a_typescript_project() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("intro card");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("index.html"), "<script type=module src=./src/main.ts></script>").unwrap();
        std::fs::write(root.join("src/main.ts"), "import './style.css';\nimport { n } from './util';\nimport * as THREE from 'three';\nconst x: number = n;\nconsole.log(x, THREE);").unwrap();
        std::fs::write(root.join("src/util.ts"), "export const n: number = 1;").unwrap();
        std::fs::write(root.join("src/style.css"), "body{margin:0}").unwrap();

        assert!(preview_candidates(dir.path().to_string_lossy().into(), 0).iter().any(|t| t.name == "intro card" && t.kind == "static"));
        let info = preview_start(root.to_string_lossy().into()).await.unwrap();
        let base = info.url.trim_end_matches("index.html").to_string();
        let get = |p: &str| {
            let url = format!("{base}{p}");
            async move {
                let r = reqwest::get(url).await.unwrap();
                (r.status().as_u16(), r.headers()["content-type"].to_str().unwrap().to_string(), r.text().await.unwrap())
            }
        };
        let (s, ct, body) = get("src/main.ts").await;
        assert_eq!((s, ct.starts_with("text/javascript")), (200, true));
        assert!(body.contains("https://esm.sh/three") && body.contains("./style.css?module") && !body.contains(": number"), "{body}");
        let (s, _, body) = get("src/util").await;
        assert!(s == 200 && body.contains("export const n = 1"), "{body}");
        let (_, ct, body) = get("src/style.css?module").await;
        assert!(ct.starts_with("text/javascript") && body.contains("createElement('style')"));
        let (s, _, _) = get("../secret").await;
        assert_eq!(s, 404);
        shutdown();
    }

    #[test]
    fn decodes_percent_paths() {
        assert_eq!(percent_decode("/a%20b/c.ts"), "/a b/c.ts");
        assert_eq!(percent_decode("/100%"), "/100%");
    }
}
