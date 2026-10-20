//! Remotion for the AI Edit agent's motion graphics.
//!
//! Building a Remotion project from scratch cost the agent most of a run:
//! scaffolding, a pnpm install that refused esbuild's build script, and
//! Remotion fetching a headless Chrome on the first render. Instead:
//!
//! * One shared kit (`<workspace root>/remotion-kit`) holds the libraries and
//!   the headless browser. It is installed once with npm, and again only when
//!   its pinned versions change. Remotion downloads the browser zip but its
//!   own unzip stops after a couple of files on current Node (v26 here) and
//!   exits 0, so every render re-downloads and writes nothing. The kit unzips
//!   the browser itself into `browser/` and every render passes it with
//!   `--browser-executable`; an installed Google Chrome is the fallback.
//! * Every motion graphic project links its `node_modules` to the kit's, so
//!   it needs no install of its own (preview and render both use the link).
//! * `templates/motion-graphics/remotion-starter` is a project that already
//!   renders; the agent copies it and only writes the scene.
//! * `render` runs `remotion render` and waits for the file, so placing it on
//!   the timeline can never race the render.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde_json::Value;
use tauri::AppHandle;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::ai_cli::runtime::build_cli_path_env;
use crate::ai_cli::workspace::global_workspace_root;

const KIT_PACKAGE_JSON: &str = include_str!("../../templates/remotion-kit/package.json");

/// The starter project, as (path inside the project, contents).
const STARTER_FILES: &[(&str, &str)] = &[
    ("package.json", include_str!("../../templates/remotion-starter/package.json")),
    ("src/index.ts", include_str!("../../templates/remotion-starter/src/index.ts")),
    ("src/Root.tsx", include_str!("../../templates/remotion-starter/src/Root.tsx")),
    ("src/Scene.tsx", include_str!("../../templates/remotion-starter/src/Scene.tsx")),
];

pub const STARTER_NAME: &str = "remotion-starter";

const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);
const RENDER_TIMEOUT: Duration = Duration::from_secs(1200);
/// Lines of Remotion's output kept in an error, so a failed render tells the
/// agent why without flooding its context.
const ERROR_TAIL_LINES: usize = 25;

/// Only one kit install at a time; renders wait for it.
static KIT_LOCK: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

pub fn kit_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(global_workspace_root(app)?.join("remotion-kit"))
}

/// Write the starter into the shared templates folder when it is missing, so
/// the agent always has a project that renders to copy.
pub fn seed_starter(templates_dir: &Path) {
    let dir = templates_dir.join(STARTER_NAME);
    if dir.join("package.json").exists() {
        return;
    }
    for (rel, contents) in STARTER_FILES {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&path, contents);
    }
}

fn remotion_bin(kit: &Path) -> PathBuf {
    let name = if cfg!(windows) { "remotion.cmd" } else { "remotion" };
    kit.join("node_modules").join(".bin").join(name)
}

/// True when `project` is a Remotion project (its package.json names it).
pub fn is_remotion_project(project: &Path) -> bool {
    std::fs::read_to_string(project.join("package.json"))
        .map(|p| p.contains("\"remotion\""))
        .unwrap_or(false)
}

/// Install the kit if it is missing or its pinned versions changed. Returns
/// the kit folder and whether this call installed it (slow, first run only).
pub async fn ensure_kit(app: &AppHandle) -> Result<(PathBuf, bool), String> {
    let _guard = KIT_LOCK.lock().await;
    let kit = kit_dir(app)?;
    let manifest = kit.join("package.json");
    // The stamp holds the manifest the last successful install used.
    let stamp = kit.join(".installed");
    let current = std::fs::read_to_string(&stamp).unwrap_or_default();
    if current == KIT_PACKAGE_JSON && remotion_bin(&kit).exists() {
        return Ok((kit, false));
    }

    std::fs::create_dir_all(&kit).map_err(|e| format!("Could not create {}: {}", kit.display(), e))?;
    std::fs::write(&manifest, KIT_PACKAGE_JSON).map_err(|e| format!("Could not write {}: {}", manifest.display(), e))?;
    run(&kit, npm(), &["install", "--no-audit", "--no-fund", "--loglevel=error"], INSTALL_TIMEOUT)
        .await
        .map_err(|e| format!("Installing Remotion failed (needs Node.js and internet): {}", e))?;
    install_browser(&kit).await;
    let _ = std::fs::write(&stamp, KIT_PACKAGE_JSON);
    Ok((kit, true))
}

/// Let Remotion download its headless browser, then unzip it ourselves into
/// `kit/browser` (see the module doc). Failure is not fatal: `browser_path`
/// falls back to an installed Chrome.
async fn install_browser(kit: &Path) {
    let bin = remotion_bin(kit);
    let _ = run(kit, &bin.to_string_lossy(), &["browser", "ensure"], INSTALL_TIMEOUT).await;
    let zip_dir = kit.join("node_modules").join(".remotion").join("chrome-headless-shell");
    let Some(zip) = std::fs::read_dir(&zip_dir)
        .ok()
        .and_then(|rd| rd.flatten().map(|e| e.path()).find(|p| p.extension().is_some_and(|x| x == "zip")))
    else {
        return;
    };
    let dest = kit.join("browser");
    let _ = std::fs::remove_dir_all(&dest);
    if std::fs::create_dir_all(&dest).is_err() {
        return;
    }
    let (zip_s, dest_s) = (zip.to_string_lossy().to_string(), dest.to_string_lossy().to_string());
    // bsdtar on Windows 10+ reads zips; unzip elsewhere.
    let _ = if cfg!(windows) {
        run(kit, "tar", &["-xf", &zip_s, "-C", &dest_s], INSTALL_TIMEOUT).await
    } else {
        run(kit, "unzip", &["-q", "-o", &zip_s, "-d", &dest_s], INSTALL_TIMEOUT).await
    };
}

/// The browser renders run in: the kit's unzipped headless shell, else one
/// Remotion managed to unpack, else an installed Google Chrome.
fn browser_path(kit: &Path) -> Option<PathBuf> {
    let name = if cfg!(windows) { "chrome-headless-shell.exe" } else { "chrome-headless-shell" };
    for root in [kit.join("browser"), kit.join("node_modules").join(".remotion")] {
        if let Some(found) = find_file(&root, name, 4) {
            return Some(found);
        }
    }
    let installed: &[&str] = if cfg!(target_os = "macos") {
        &["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    } else if cfg!(windows) {
        &[
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        ]
    } else {
        &["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
    };
    installed.iter().map(PathBuf::from).find(|p| p.exists())
}

fn find_file(dir: &Path, name: &str, depth: usize) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            subdirs.push(path);
        } else if path.file_name().is_some_and(|n| n == name) {
            return Some(path);
        }
    }
    if depth == 0 {
        return None;
    }
    subdirs.into_iter().find_map(|d| find_file(&d, name, depth - 1))
}

fn npm() -> &'static str {
    if cfg!(windows) {
        "npm.cmd"
    } else {
        "npm"
    }
}

/// Point `project/node_modules` at the kit's, unless the project already has
/// its own. A junction on Windows, which needs no admin rights.
pub fn link_kit(kit: &Path, project: &Path) -> Result<(), String> {
    let link = project.join("node_modules");
    if link.exists() {
        return Ok(());
    }
    // A dangling link (the kit was moved or deleted) is replaced.
    let _ = std::fs::remove_file(&link);
    let target = kit.join("node_modules");
    #[cfg(unix)]
    let result = std::os::unix::fs::symlink(&target, &link).map_err(|e| e.to_string());
    #[cfg(windows)]
    let result = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&link)
        .arg(&target)
        .output()
        .map_err(|e| e.to_string())
        .and_then(|o| if o.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&o.stderr).into_owned()) });
    result.map_err(|e| format!("Could not link {} to the Remotion kit: {}", link.display(), e))
}

pub struct RenderRequest<'a> {
    pub project: &'a Path,
    pub composition: &'a str,
    pub output: &'a Path,
    /// ProRes 4444 with alpha (.mov) when true, else H.264 (.mp4).
    pub transparent: bool,
    pub props: Option<&'a Value>,
}

/// Render one composition and wait for the file. Returns how long it took.
pub async fn render(app: &AppHandle, req: RenderRequest<'_>) -> Result<(Duration, bool), String> {
    let entry = ["src/index.ts", "src/index.tsx", "src/index.js", "src/index.jsx"]
        .into_iter()
        .find(|e| req.project.join(e).exists())
        .ok_or_else(|| format!("{} has no src/index.ts that calls registerRoot.", req.project.display()))?;
    let (kit, installed) = ensure_kit(app).await?;
    link_kit(&kit, req.project)?;
    if let Some(parent) = req.output.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not create {}: {}", parent.display(), e))?;
    }

    let output = req.output.to_string_lossy().to_string();
    let mut args: Vec<String> = vec!["render".into(), entry.into(), req.composition.into(), output];
    if req.transparent {
        args.extend(
            ["--codec=prores", "--prores-profile=4444", "--pixel-format=yuva444p10le", "--image-format=png"]
                .map(String::from),
        );
    } else {
        args.push("--codec=h264".into());
    }
    if let Some(props) = req.props.filter(|p| p.is_object()) {
        args.push(format!("--props={}", props));
    }
    let browser = match browser_path(&kit) {
        Some(b) => b,
        None => {
            // The kit predates the browser fix, or its unzip failed: retry once.
            install_browser(&kit).await;
            browser_path(&kit).ok_or(
                "No browser to render with: Remotion's headless Chrome could not be installed and \
                 Google Chrome is not installed.",
            )?
        }
    };
    args.push(format!("--browser-executable={}", browser.display()));
    args.push("--log=error".into());

    let started = Instant::now();
    let bin = remotion_bin(&kit);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run(req.project, &bin.to_string_lossy(), &arg_refs, RENDER_TIMEOUT).await?;
    if !req.output.exists() {
        return Err("Remotion finished without writing the file.".into());
    }
    Ok((started.elapsed(), installed))
}

/// Run a command to completion; on failure return the tail of its output.
async fn run(cwd: &Path, program: &str, args: &[&str], timeout: Duration) -> Result<(), String> {
    let path_env = build_cli_path_env();
    let exe = which::which_in(program, Some(&path_env), cwd).unwrap_or_else(|_| PathBuf::from(program));
    let mut child = Command::new(&exe)
        .args(args)
        .current_dir(cwd)
        .env("PATH", &path_env)
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .env("BROWSER", "none")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("could not run {}: {}", program, e))?;

    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let collect = async {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let _ = tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err));
        let status = child.wait().await;
        (status, out, err)
    };
    let (status, out, err) = tokio::time::timeout(timeout, collect)
        .await
        .map_err(|_| format!("timed out after {} s", timeout.as_secs()))?;
    let status = status.map_err(|e| e.to_string())?;
    if status.success() {
        return Ok(());
    }
    let text = format!("{}\n{}", String::from_utf8_lossy(&out), String::from_utf8_lossy(&err));
    let lines: Vec<&str> = text.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).collect();
    let tail = lines[lines.len().saturating_sub(ERROR_TAIL_LINES)..].join("\n");
    Err(format!("exit {}:\n{}", status.code().unwrap_or(-1), strip_ansi(&tail)))
}

fn strip_ansi(s: &str) -> String {
    static RE: Lazy<regex::Regex> = Lazy::new(|| regex::Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]").unwrap());
    RE.replace_all(s, "").into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starter_is_a_remotion_project() {
        let dir = std::env::temp_dir().join(format!("autosubs-starter-{}", uuid::Uuid::new_v4().simple()));
        seed_starter(&dir);
        let project = dir.join(STARTER_NAME);
        assert!(is_remotion_project(&project));
        assert!(project.join("src/Root.tsx").exists());
        assert!(KIT_PACKAGE_JSON.contains("\"remotion\": \"4.0.443\""));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
