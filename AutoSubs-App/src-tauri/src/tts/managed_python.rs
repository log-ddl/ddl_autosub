//! Self-contained Python 3.12 bootstrap via Astral's `uv`.
//!
//! Non-technical video editors should never have to install Python manually.
//! When no compatible Python 3.10-3.13 is available, we download a pinned `uv`
//! binary (verified against its SHA-256 digest) and install a private CPython
//! 3.12 under `<app data>/runtimes/managed-python/`.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::process_ext::HiddenConsole;

use super::paths::managed_python_root;
use super::{emit_install_progress, is_job_canceled};

const UV_VERSION: &str = "0.12.3";

struct UvAsset {
    file: &'static str,
    sha256: &'static str,
}

fn current_uv_asset() -> Result<UvAsset, String> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return Ok(UvAsset {
            file: "uv-aarch64-apple-darwin.tar.gz",
            sha256: "546f7f8a6c70ff13a3a9d2bc958db3427298cebf3e0cb756f9177133b7068843",
        });
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return Ok(UvAsset {
            file: "uv-x86_64-apple-darwin.tar.gz",
            sha256: "4c9f52262a14da336e4a42ed24992d12d0c956acde87619e4611d321dffa602b",
        });
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return Ok(UvAsset {
            file: "uv-x86_64-pc-windows-msvc.zip",
            sha256: "b23350c79e8ad0192b8124af13a0f17e8d4e4549524785e1aef389ae5a06990e",
        });
    }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        return Ok(UvAsset {
            file: "uv-aarch64-pc-windows-msvc.zip",
            sha256: "4343217d668727b8a8eb5cad92389a1d2eeead93c89940d1b955ba1bb15462eb",
        });
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        return Ok(UvAsset {
            file: "uv-x86_64-unknown-linux-gnu.tar.gz",
            sha256: "600cf9a742aca00d292673b16b5acffaa7b8c269a364ad0c2e79498dcb1fe101",
        });
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        return Ok(UvAsset {
            file: "uv-aarch64-unknown-linux-gnu.tar.gz",
            sha256: "bb66cb52e7b1823aed1183630d8d8e5c958840d584a4c55ec10a4cfc168dcca2",
        });
    }
    #[allow(unreachable_code)]
    Err("Automatic Python setup is not supported on this OS/architecture".to_string())
}

fn find_file_recursive(root: &Path, filename: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_file() {
            if entry
                .file_name()
                .to_str()
                .is_some_and(|n| n.eq_ignore_ascii_case(filename))
            {
                return Some(path);
            }
        } else if ft.is_dir() {
            if let Some(found) = find_file_recursive(&path, filename) {
                return Some(found);
            }
        }
    }
    None
}

/// Search only the top-level `cpython-3.12*` install folders created by `uv`
/// so we never pick up `Lib/venv/scripts/nt/python.exe` on Windows.
pub fn find_managed_python(app: &AppHandle) -> Option<PathBuf> {
    let python_root = managed_python_root(app).ok()?.join("python");
    let entries = std::fs::read_dir(&python_root).ok()?;
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if !ft.is_dir() {
            continue;
        }
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with("cpython-3.12") {
            continue;
        }
        let install = entry.path();
        let candidates: Vec<PathBuf> = if cfg!(windows) {
            vec![install.join("python.exe")]
        } else {
            vec![
                install.join("bin").join("python3.12"),
                install.join("bin").join("python3"),
            ]
        };
        for candidate in candidates {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

async fn verify_python_312(python: &Path) -> bool {
    Command::new(python)
        .args([
            "-c",
            "import sys; assert sys.version_info[:2] == (3, 12); print(sys.version)",
        ])
        .hidden()
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)
        .map_err(|e| e.to_string())?
        .permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms).map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

async fn ensure_uv(app: &AppHandle, job_id: &str) -> Result<PathBuf, String> {
    let managed = managed_python_root(app)?;
    let uv_root = managed.join("uv");
    let uv_bin_name = if cfg!(windows) { "uv.exe" } else { "uv" };

    if let Some(existing) = find_file_recursive(&uv_root, uv_bin_name) {
        return Ok(existing);
    }

    let asset = current_uv_asset()?;
    std::fs::create_dir_all(&uv_root).map_err(|e| e.to_string())?;
    let archive_path = managed.join(asset.file);
    let url = format!(
        "https://releases.astral.sh/github/uv/releases/download/{}/{}",
        UV_VERSION, asset.file
    );

    emit_install_progress(
        app,
        job_id,
        "runtime.python.download",
        Some(3.0),
        "Downloading Python runtime manager...",
    );

    let client = reqwest::Client::builder()
        .user_agent("autosubs-omnivoice-tts")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to download Python manager: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Failed to download Python manager (HTTP {})",
            resp.status()
        ));
    }

    let mut file = tokio::fs::File::create(&archive_path)
        .await
        .map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if is_job_canceled(job_id) {
            let _ = tokio::fs::remove_file(&archive_path).await;
            return Err("Canceled".to_string());
        }
        let bytes = chunk.map_err(|e| e.to_string())?;
        hasher.update(&bytes);
        file.write_all(&bytes).await.map_err(|e| e.to_string())?;
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);

    let digest = format!("{:x}", hasher.finalize());
    if digest != asset.sha256 {
        let _ = tokio::fs::remove_file(&archive_path).await;
        return Err("Python bootstrap failed SHA-256 integrity verification".to_string());
    }

    emit_install_progress(
        app,
        job_id,
        "runtime.python.install",
        Some(6.0),
        "Extracting Python runtime manager...",
    );

    let extract_res = if cfg!(windows) {
        Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Expand-Archive",
                "-LiteralPath",
            ])
            .arg(&archive_path)
            .arg("-DestinationPath")
            .arg(&uv_root)
            .arg("-Force")
            .hidden()
            .output()
            .await
    } else {
        Command::new("tar")
            .arg("-xzf")
            .arg(&archive_path)
            .arg("-C")
            .arg(&uv_root)
            .hidden()
            .output()
            .await
    };
    let _ = tokio::fs::remove_file(&archive_path).await;

    let out = extract_res.map_err(|e| format!("Failed to extract uv: {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "Failed to extract uv: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    let exe = find_file_recursive(&uv_root, uv_bin_name)
        .ok_or_else(|| "Could not find uv binary after extraction".to_string())?;
    make_executable(&exe)?;
    Ok(exe)
}

pub async fn ensure_managed_python(app: &AppHandle, job_id: &str) -> Result<PathBuf, String> {
    if let Some(existing) = find_managed_python(app) {
        if verify_python_312(&existing).await {
            return Ok(existing);
        }
    }

    let uv = ensure_uv(app, job_id).await?;
    if is_job_canceled(job_id) {
        return Err("Canceled".to_string());
    }

    let managed = managed_python_root(app)?;
    let python_root = managed.join("python");
    let cache_root = managed.join("cache");
    std::fs::create_dir_all(&python_root).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&cache_root).map_err(|e| e.to_string())?;

    emit_install_progress(
        app,
        job_id,
        "runtime.python.download",
        Some(7.0),
        "Downloading Python 3.12 for this device...",
    );

    let out = Command::new(&uv)
        .args(["python", "install", "3.12", "--install-dir"])
        .arg(&python_root)
        .args(["--no-bin", "--managed-python", "--no-config"])
        .env("UV_PYTHON_INSTALL_DIR", &python_root)
        .env("UV_CACHE_DIR", &cache_root)
        .env("UV_NO_PROGRESS", "1")
        .hidden()
        .output()
        .await
        .map_err(|e| format!("Failed to install Python 3.12: {}", e))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        return Err(format!(
            "Could not install Python 3.12 automatically: {} {}",
            stdout.trim(),
            stderr.trim()
        )
        .trim()
        .to_string());
    }

    let exe = find_managed_python(app)
        .ok_or_else(|| "Python 3.12 was downloaded, but interpreter was not found".to_string())?;
    if !verify_python_312(&exe).await {
        return Err("Downloaded Python 3.12 runtime failed verification".to_string());
    }

    emit_install_progress(
        app,
        job_id,
        "runtime.python.install",
        Some(9.0),
        "Python 3.12 is ready",
    );
    Ok(exe)
}
