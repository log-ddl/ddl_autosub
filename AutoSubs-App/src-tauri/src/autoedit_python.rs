// Manages the on-demand Python runtime for AutoEdit.
//
// The runtime is not bundled with the installer — end users who only touch
// AutoSubs don't pay for it. The first time a user enters the AutoEdit
// workspace, we download a portable python-build-standalone distribution
// into the app data dir, extract it, and reuse it forever. Subsequent
// launches see it already installed and go straight into the workspace.
//
// python-build-standalone is Astral's official portable CPython build
// (same one `uv` uses). MIT licensed, fully static, no host Python needed.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::process_ext::HiddenConsole;

// Pinned python-build-standalone release. Bump these two together when we
// want a newer Python. Keep the same tag/version on both this file and
// scripts/download-python.mjs so dev pre-warms and prod runtime match.
const RELEASE_TAG: &str = "20241016";
const PYTHON_VERSION: &str = "3.12.7";

const EVENT_PROGRESS: &str = "autoedit-python-progress";
const EVENT_DONE: &str = "autoedit-python-done";

// One install can be in flight at a time; the second caller just watches the
// same events instead of racing on the same files.
static INSTALLING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Serialize)]
pub struct RuntimeStatus {
    pub installed: bool,
    pub installing: bool,
    pub version: Option<String>,
}

#[derive(Clone, Serialize)]
struct ProgressEvent {
    // 0..=1; None while the server hasn't announced a content-length yet.
    ratio: Option<f64>,
    bytes: u64,
    total: Option<u64>,
    phase: &'static str, // "download" | "extract"
}

#[derive(Clone, Serialize)]
struct DoneEvent {
    ok: bool,
    error: Option<String>,
}

fn host_triple() -> Result<&'static str, String> {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        Ok("x86_64-pc-windows-msvc")
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        Ok("aarch64-apple-darwin")
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        Ok("x86_64-apple-darwin")
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        Ok("x86_64-unknown-linux-gnu")
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        Ok("aarch64-unknown-linux-gnu")
    }
    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
    )))]
    {
        Err("Unsupported OS/architecture for AutoEdit Python runtime".to_string())
    }
}

fn download_url() -> Result<String, String> {
    let triple = host_triple()?;
    Ok(format!(
        "https://github.com/astral-sh/python-build-standalone/releases/download/\
         {tag}/cpython-{ver}+{tag}-{triple}-install_only.tar.gz",
        tag = RELEASE_TAG,
        ver = PYTHON_VERSION,
        triple = triple,
    ))
}

// Root folder that holds the installed Python distribution.
// python-build-standalone unpacks with a top-level `python/` dir, which we
// keep as-is; the interpreter lives at `<root>/python/python.exe` on Windows
// and `<root>/python/bin/python3` on macOS/Linux.
pub fn runtime_root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("autoedit-python"))
}

pub fn python_binary(app: &AppHandle) -> Result<PathBuf, String> {
    let root = runtime_root(app)?;
    #[cfg(target_os = "windows")]
    {
        Ok(root.join("python").join("python.exe"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(root.join("python").join("bin").join("python3"))
    }
}

fn marker_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_root(app)?.join(".version"))
}

fn expected_marker() -> String {
    format!("{}+{}", PYTHON_VERSION, RELEASE_TAG)
}

pub fn is_installed(app: &AppHandle) -> bool {
    let Ok(bin) = python_binary(app) else {
        return false;
    };
    let Ok(marker) = marker_path(app) else {
        return false;
    };
    if !bin.exists() || !marker.exists() {
        return false;
    }
    match std::fs::read_to_string(&marker) {
        Ok(s) => s.trim() == expected_marker(),
        Err(_) => false,
    }
}

#[tauri::command]
pub fn python_runtime_status(app: AppHandle) -> RuntimeStatus {
    RuntimeStatus {
        installed: is_installed(&app),
        installing: INSTALLING.load(Ordering::SeqCst),
        version: if is_installed(&app) {
            Some(expected_marker())
        } else {
            None
        },
    }
}

async fn download_to(url: &str, dest: &std::path::Path, app: &AppHandle) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .user_agent("autosubs-autoedit")
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("Download failed: HTTP {}", status));
    }

    let total = resp.content_length();
    let mut file = fs::File::create(dest)
        .await
        .map_err(|e| format!("Cannot create {}: {}", dest.display(), e))?;

    let mut downloaded: u64 = 0;
    let mut last_emit: u64 = 0;
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Read chunk failed: {}", e))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Write failed: {}", e))?;
        downloaded += chunk.len() as u64;

        // Throttle emissions: at most every 256KiB so the UI doesn't drown.
        if downloaded - last_emit >= 256 * 1024 {
            last_emit = downloaded;
            let _ = app.emit(
                EVENT_PROGRESS,
                ProgressEvent {
                    ratio: total.map(|t| downloaded as f64 / t as f64),
                    bytes: downloaded,
                    total,
                    phase: "download",
                },
            );
        }
    }

    file.flush().await.map_err(|e| e.to_string())?;
    // Final tick so the bar reaches 100% cleanly.
    let _ = app.emit(
        EVENT_PROGRESS,
        ProgressEvent {
            ratio: total.map(|_| 1.0),
            bytes: downloaded,
            total,
            phase: "download",
        },
    );
    Ok(())
}

async fn extract_tarball(archive: &std::path::Path, dest_dir: &std::path::Path) -> Result<(), String> {
    // Shell out to `tar` — ships with Windows 10+, macOS, and Linux — instead
    // of pulling in a Rust tar+flate2 dependency for a one-off use.
    let status = Command::new("tar")
        .arg("-xzf")
        .arg(archive)
        .arg("-C")
        .arg(dest_dir)
        .hidden()
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .status()
        .await
        .map_err(|e| format!("Failed to run tar: {}", e))?;

    if !status.success() {
        return Err(format!("tar exited with {}", status));
    }
    Ok(())
}

async fn do_install(app: AppHandle) -> Result<(), String> {
    let root = runtime_root(&app)?;
    // Clean any partial install from a previous crash so we start fresh.
    if root.exists() {
        let _ = fs::remove_dir_all(&root).await;
    }
    fs::create_dir_all(&root)
        .await
        .map_err(|e| format!("Cannot create {}: {}", root.display(), e))?;

    let url = download_url()?;
    let archive = root.join("python.tar.gz");

    download_to(&url, &archive, &app).await?;

    let _ = app.emit(
        EVENT_PROGRESS,
        ProgressEvent {
            ratio: Some(1.0),
            bytes: 0,
            total: None,
            phase: "extract",
        },
    );

    extract_tarball(&archive, &root).await?;
    let _ = fs::remove_file(&archive).await;

    // Sanity check: the interpreter must be where we expect it.
    let bin = python_binary(&app)?;
    if !bin.exists() {
        return Err(format!(
            "Python installation succeeded but interpreter is missing at {}",
            bin.display()
        ));
    }

    // Write the version marker last so a crash mid-install leaves the
    // runtime marked as "not installed" and we redo it next time.
    let marker = marker_path(&app)?;
    fs::write(&marker, expected_marker())
        .await
        .map_err(|e| format!("Cannot write marker: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn install_python_runtime(app: AppHandle) -> Result<(), String> {
    if is_installed(&app) {
        let _ = app.emit(EVENT_DONE, DoneEvent { ok: true, error: None });
        return Ok(());
    }
    if INSTALLING.swap(true, Ordering::SeqCst) {
        // Already installing; the in-flight task will emit EVENT_DONE.
        return Ok(());
    }

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = do_install(app_clone.clone()).await;
        INSTALLING.store(false, Ordering::SeqCst);
        let event = match result {
            Ok(()) => DoneEvent { ok: true, error: None },
            Err(e) => DoneEvent { ok: false, error: Some(e) },
        };
        let _ = app_clone.emit(EVENT_DONE, event);
    });

    Ok(())
}
