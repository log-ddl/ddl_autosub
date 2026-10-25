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
//!   the timeline can never race the render. Renders take turns
//!   (`RENDER_SLOTS`): each one already uses every core, so many agents
//!   rendering at once would only slow the machine down, never finish sooner.
//! * `stills` renders a few frames with the kit's `stills.mjs` (one bundle, one
//!   browser for all of them) and `contact_sheet` lays them out with their
//!   times, so the agent can look at a graphic before rendering it.
//! * The kit holds every Remotion library usable inside a composition, and
//!   `reference/` holds Remotion's own agent skills and full docs at the same
//!   version (a sparse clone of the Remotion repo). It is linked into the
//!   `remotion-motion` library skill as `reference/`, so the agent reads them
//!   next to that skill. `prepare` does all of this at app start, so the
//!   reference is there before the agent first reads the skill.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use image::{Rgb, RgbImage};
use once_cell::sync::Lazy;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::ai_cli::runtime::build_cli_path_env;
use crate::ai_cli::workspace::global_workspace_root;

const KIT_PACKAGE_JSON: &str = include_str!("../../templates/remotion-kit/package.json");
const STILLS_SCRIPT: &str = include_str!("../../templates/remotion-kit/stills.mjs");

/// The starter project, as (path inside the project, contents).
const STARTER_FILES: &[(&str, &str)] = &[
    ("package.json", include_str!("../../templates/remotion-starter/package.json")),
    ("src/index.ts", include_str!("../../templates/remotion-starter/src/index.ts")),
    ("src/Root.tsx", include_str!("../../templates/remotion-starter/src/Root.tsx")),
    ("src/Scene.tsx", include_str!("../../templates/remotion-starter/src/Scene.tsx")),
];

pub const STARTER_NAME: &str = "remotion-starter";

const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);
/// Only guards against a hung browser: a long shot with heavy effects can
/// render for hours, and must not be cut off.
const RENDER_TIMEOUT: Duration = Duration::from_secs(8 * 3600);
const STILLS_TIMEOUT: Duration = Duration::from_secs(1200);
/// Lines of Remotion's output kept in an error, so a failed render tells the
/// agent why without flooding its context.
const ERROR_TAIL_LINES: usize = 25;

/// Only one kit install at a time; renders wait for it.
static KIT_LOCK: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

/// Full renders at a time; the rest wait their turn, first come first served.
pub const RENDER_SLOTS: usize = 1;
static RENDER_QUEUE: Lazy<tokio::sync::Semaphore> = Lazy::new(|| tokio::sync::Semaphore::new(RENDER_SLOTS));
/// Previews are a few frames each (seconds), so they do not wait behind a
/// long render, but parallel agents still never open more than this many
/// browsers for them.
static PREVIEW_QUEUE: Lazy<tokio::sync::Semaphore> = Lazy::new(|| tokio::sync::Semaphore::new(2));

/// Where Remotion's skills and docs are cloned from, at tag `v<version>`.
const REMOTION_REPO: &str = "https://github.com/remotion-dev/remotion";
/// The library skill the reference is linked into.
const SKILL_NAME: &str = "remotion-motion";
/// One clone attempt per app run, so an offline machine does not retry on
/// every render.
static REFERENCE_TRIED: AtomicBool = AtomicBool::new(false);

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
        ensure_reference(&kit).await;
        return Ok((kit, false));
    }

    std::fs::create_dir_all(&kit).map_err(|e| format!("Could not create {}: {}", kit.display(), e))?;
    std::fs::write(&manifest, KIT_PACKAGE_JSON).map_err(|e| format!("Could not write {}: {}", manifest.display(), e))?;
    run(&kit, npm(), &["install", "--no-audit", "--no-fund", "--loglevel=error"], INSTALL_TIMEOUT)
        .await
        .map_err(|e| format!("Installing Remotion failed (needs Node.js and internet): {}", e))?;
    install_browser(&kit).await;
    let _ = std::fs::write(&stamp, KIT_PACKAGE_JSON);
    ensure_reference(&kit).await;
    Ok((kit, true))
}

/// Install the kit and link its reference into the library skill. Run in the
/// background at app start; failures are logged and retried by the next render.
pub async fn prepare(app: AppHandle) {
    match ensure_kit(&app).await {
        Ok((kit, _)) => {
            if let Err(e) = link_reference(&app, &kit) {
                tracing::warn!("Remotion reference not linked: {}", e);
            }
        }
        Err(e) => tracing::warn!("Remotion kit not installed: {}", e),
    }
}

/// The Remotion version the kit pins.
fn kit_version() -> String {
    serde_json::from_str::<Value>(KIT_PACKAGE_JSON)
        .ok()
        .and_then(|v| v["dependencies"]["remotion"].as_str().map(String::from))
        .unwrap_or_default()
}

/// Clone Remotion's agent skills and docs for the kit's version into
/// `kit/reference/` (`skills/`, `docs/`), unless they are there already.
/// Needs git; without it the agent still has the AutoSubs skill.
async fn ensure_reference(kit: &Path) {
    let version = kit_version();
    let reference = kit.join("reference");
    let stamp = reference.join(".version");
    if std::fs::read_to_string(&stamp).ok().as_deref() == Some(version.as_str()) {
        return;
    }
    if version.is_empty() || REFERENCE_TRIED.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Err(e) = clone_reference(kit, &version, &reference).await {
        tracing::warn!("Could not fetch Remotion's skills and docs: {}", e);
    }
}

async fn clone_reference(kit: &Path, version: &str, reference: &Path) -> Result<(), String> {
    let tmp = kit.join("reference-tmp");
    let _ = std::fs::remove_dir_all(&tmp);
    let tmp_s = tmp.to_string_lossy().to_string();
    let tag = format!("v{}", version);
    run(
        kit,
        "git",
        &["clone", "-q", "--depth", "1", "--branch", &tag, "--filter=blob:none", "--sparse", REMOTION_REPO, &tmp_s],
        INSTALL_TIMEOUT,
    )
    .await?;
    run(
        &tmp,
        "git",
        &[
            "sparse-checkout",
            "set",
            "--no-cone",
            "/packages/skills/skills/",
            "/packages/docs/docs/**/*.md",
            "/packages/docs/docs/**/*.mdx",
        ],
        INSTALL_TIMEOUT,
    )
    .await?;
    let _ = std::fs::remove_dir_all(reference);
    std::fs::create_dir_all(reference).map_err(|e| e.to_string())?;
    for (from, to) in [("packages/skills/skills", "skills"), ("packages/docs/docs", "docs")] {
        std::fs::rename(tmp.join(from), reference.join(to)).map_err(|e| format!("{}: {}", from, e))?;
    }
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::write(reference.join(".version"), version).map_err(|e| e.to_string())
}

/// Link `kit/reference` into `library/skills/remotion-motion/reference`.
pub fn link_reference(app: &AppHandle, kit: &Path) -> Result<(), String> {
    let target = kit.join("reference");
    if !target.join("docs").is_dir() {
        return Ok(());
    }
    let skill = crate::ai_cli::workspace::library_root(app)?.join("skills").join(SKILL_NAME);
    std::fs::create_dir_all(&skill).map_err(|e| e.to_string())?;
    link_dir(&target, &skill.join("reference"))
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
/// its own.
pub fn link_kit(kit: &Path, project: &Path) -> Result<(), String> {
    link_dir(&kit.join("node_modules"), &project.join("node_modules"))
}

/// Make `link` point at the folder `target`, unless something is there
/// already. A junction on Windows, which needs no admin rights.
fn link_dir(target: &Path, link: &Path) -> Result<(), String> {
    if link.exists() {
        return Ok(());
    }
    // A dangling link (the kit was moved or deleted) is replaced.
    let _ = std::fs::remove_file(link);
    #[cfg(unix)]
    let result = std::os::unix::fs::symlink(target, link).map_err(|e| e.to_string());
    #[cfg(windows)]
    let result = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .map_err(|e| e.to_string())
        .and_then(|o| if o.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&o.stderr).into_owned()) });
    result.map_err(|e| format!("Could not link {} to {}: {}", link.display(), target.display(), e))
}

pub struct RenderRequest<'a> {
    pub project: &'a Path,
    pub composition: &'a str,
    pub output: &'a Path,
    /// ProRes 4444 with alpha (.mov) when true, else H.264 (.mp4).
    pub transparent: bool,
    pub props: Option<&'a Value>,
}

/// The GL backend renders run with, so WebGL content (light leaks, shaders)
/// renders in the headless browser: ANGLE where there is a GPU driver, its
/// software fallback on Linux.
const GL: &str = if cfg!(target_os = "linux") { "swangle" } else { "angle" };

/// The project's entry file (the one that calls registerRoot).
fn entry_file(project: &Path) -> Result<&'static str, String> {
    ["src/index.ts", "src/index.tsx", "src/index.js", "src/index.jsx"]
        .into_iter()
        .find(|e| project.join(e).exists())
        .ok_or_else(|| format!("{} has no src/index.ts that calls registerRoot.", project.display()))
}

async fn browser_for(kit: &Path) -> Result<PathBuf, String> {
    if let Some(b) = browser_path(kit) {
        return Ok(b);
    }
    // The kit predates the browser fix, or its unzip failed: retry once.
    install_browser(kit).await;
    browser_path(kit).ok_or_else(|| {
        "No browser to render with: Remotion's headless Chrome could not be installed and \
         Google Chrome is not installed."
            .to_string()
    })
}

/// Render one composition and wait for the file. Returns how long it took.
/// Waits for a render slot first; `on_start` runs once it has one. The time
/// returned is the render's own, without the wait.
pub async fn render(
    app: &AppHandle,
    req: RenderRequest<'_>,
    on_start: impl FnOnce(),
) -> Result<(Duration, bool), String> {
    let entry = entry_file(req.project)?;
    let _slot = RENDER_QUEUE.acquire().await.map_err(|e| e.to_string())?;
    on_start();
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
    let browser = browser_for(&kit).await?;
    args.push(format!("--browser-executable={}", browser.display()));
    args.push(format!("--gl={}", GL));
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

pub struct StillsRequest<'a> {
    pub project: &'a Path,
    pub composition: &'a str,
    pub props: Option<&'a Value>,
    /// Folder the PNGs and result.json go into (emptied first).
    pub out_dir: &'a Path,
    /// How many frames, spread over the whole composition...
    pub count: usize,
    /// ...or exactly these times, in seconds.
    pub at_sec: Vec<f64>,
    /// Longer side of each frame, in pixels.
    pub max_side: u32,
}

#[derive(Debug, Deserialize)]
pub struct Still {
    pub frame: u32,
    pub path: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stills {
    pub fps: f64,
    pub duration_in_frames: u32,
    pub width: u32,
    pub height: u32,
    pub stills: Vec<Still>,
}

/// Render a few frames of one composition as PNGs (transparent where the
/// graphic is). Returns them with the composition's size, fps and length.
pub async fn stills(app: &AppHandle, req: StillsRequest<'_>) -> Result<(Stills, bool), String> {
    let entry = entry_file(req.project)?;
    let _slot = PREVIEW_QUEUE.acquire().await.map_err(|e| e.to_string())?;
    let (kit, installed) = ensure_kit(app).await?;
    link_kit(&kit, req.project)?;
    let script = kit.join("stills.mjs");
    if std::fs::read_to_string(&script).ok().as_deref() != Some(STILLS_SCRIPT) {
        std::fs::write(&script, STILLS_SCRIPT).map_err(|e| format!("Could not write {}: {}", script.display(), e))?;
    }
    let browser = browser_for(&kit).await?;

    let _ = std::fs::remove_dir_all(req.out_dir);
    std::fs::create_dir_all(req.out_dir).map_err(|e| format!("Could not create {}: {}", req.out_dir.display(), e))?;
    let mut request = json!({
        "entry": req.project.join(entry),
        "composition": req.composition,
        "props": req.props.filter(|p| p.is_object()).cloned().unwrap_or_else(|| json!({})),
        "browser": browser,
        "gl": GL,
        "outDir": req.out_dir,
        "frames": req.count,
        "maxSide": req.max_side,
    });
    if !req.at_sec.is_empty() {
        request["atSec"] = json!(req.at_sec);
    }
    let request_path = req.out_dir.join("request.json");
    std::fs::write(&request_path, request.to_string()).map_err(|e| e.to_string())?;

    let script_s = script.to_string_lossy().to_string();
    let request_s = request_path.to_string_lossy().to_string();
    run(req.project, "node", &[&script_s, &request_s], STILLS_TIMEOUT).await?;
    let result = std::fs::read_to_string(req.out_dir.join("result.json"))
        .map_err(|_| "Remotion finished without writing the frames.".to_string())?;
    let stills: Stills = serde_json::from_str(&result).map_err(|e| format!("Bad stills result: {}", e))?;
    Ok((stills, installed))
}

/// A checkerboard under transparent pixels, so a sheet shows what is see-through.
fn flatten_on_checker(path: &Path) -> Result<RgbImage, String> {
    let img = image::open(path).map_err(|e| format!("Bad frame {}: {}", path.display(), e))?.to_rgba8();
    let mut out = RgbImage::new(img.width(), img.height());
    for (x, y, px) in img.enumerate_pixels() {
        let bg: f32 = if (x / 16 + y / 16) % 2 == 0 { 70.0 } else { 110.0 };
        let a = px[3] as f32 / 255.0;
        let mix = |c: u8| (c as f32 * a + bg * (1.0 - a)).round() as u8;
        out.put_pixel(x, y, Rgb([mix(px[0]), mix(px[1]), mix(px[2])]));
    }
    Ok(out)
}

/// Lay the stills out as JPEG contact sheets in `out_dir`, each tile labelled
/// with its time. Returns each sheet's path with the times on it.
pub fn contact_sheet(stills: &Stills, out_dir: &Path, per_sheet: usize) -> Result<Vec<(PathBuf, Vec<f64>)>, String> {
    let mut frames = Vec::with_capacity(stills.stills.len());
    for s in &stills.stills {
        frames.push((s.frame as f64 / stills.fps, flatten_on_checker(&s.path)?));
    }
    let portrait = stills.height > stills.width;
    let cols = if frames.len() <= 2 { 1 } else if portrait { 6 } else { 4 };
    let mut sheets = Vec::new();
    for (i, chunk) in frames.chunks(per_sheet.max(1)).enumerate() {
        let path = out_dir.join(format!("sheet-{}.jpg", i + 1));
        crate::media::analyze::compose_sheet(chunk, cols)
            .save_with_format(&path, image::ImageFormat::Jpeg)
            .map_err(|e| format!("Could not write {}: {}", path.display(), e))?;
        sheets.push((path, chunk.iter().map(|(t, _)| *t).collect()));
    }
    Ok(sheets)
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
        assert_eq!(kit_version(), "4.0.538");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sheet_shows_transparency_as_a_checkerboard() {
        let dir = std::env::temp_dir().join(format!("autosubs-stills-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut stills = Vec::new();
        for frame in [0u32, 15, 30] {
            // Left half opaque red, right half fully transparent.
            let img = image::RgbaImage::from_fn(64, 36, |x, _| {
                if x < 32 { image::Rgba([255, 0, 0, 255]) } else { image::Rgba([0, 0, 0, 0]) }
            });
            let path = dir.join(format!("frame-{}.png", frame));
            img.save(&path).unwrap();
            stills.push(Still { frame, path });
        }
        let stills = Stills { fps: 30.0, duration_in_frames: 45, width: 64, height: 36, stills };
        let sheets = contact_sheet(&stills, &dir, 2).unwrap();
        assert_eq!(sheets.len(), 2);
        assert_eq!(sheets[0].1, vec![0.0, 0.5]);
        assert_eq!(sheets[1].1, vec![1.0]);
        let flat = flatten_on_checker(&stills.stills[0].path).unwrap();
        assert_eq!(flat.get_pixel(5, 30), &Rgb([255, 0, 0]));
        assert_ne!(flat.get_pixel(40, 30), flat.get_pixel(56, 30), "checker squares alternate");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
