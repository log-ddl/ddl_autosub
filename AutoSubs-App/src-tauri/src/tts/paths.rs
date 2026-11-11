//! Filesystem locations and environment setup for the local OmniVoice TTS runtime.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const RUNTIME_VERSION: u32 = 2;
pub const OMNIVOICE_MODEL_ID: &str = "omnivoice-main";
pub const OMNIVOICE_REPOSITORY: &str = "k2-fsa/OmniVoice";
pub const TORCH_VERSION: &str = "2.8.0";
pub const TORCH_CUDA_INDEX: &str = "https://download.pytorch.org/whl/cu128";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeMarker {
    pub version: Option<u32>,
    pub source_version: Option<String>,
    pub torch: Option<String>,
    pub backend: Option<String>,
}

pub fn app_data(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

pub fn managed_python_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join("runtimes").join("managed-python"))
}

pub fn runtime_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join("runtimes").join("omnivoice"))
}

pub fn model_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join("models").join("omnivoice"))
}

pub fn model_path(app: &AppHandle, model_id: &str) -> Result<PathBuf, String> {
    if model_id != OMNIVOICE_MODEL_ID {
        return Err("Unsupported TTS model".to_string());
    }
    Ok(model_root(app)?.join(model_id))
}

pub fn output_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join("tts").join("outputs"))
}

pub fn voice_prompt_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join("tts").join("voices").join("omnivoice"))
}

pub fn profiles_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join("tts").join("profiles.json"))
}

pub fn venv_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_root(app)?.join(".venv"))
}

pub fn venv_python(app: &AppHandle) -> Result<PathBuf, String> {
    let venv = venv_dir(app)?;
    if cfg!(windows) {
        Ok(venv.join("Scripts").join("python.exe"))
    } else {
        Ok(venv.join("bin").join("python"))
    }
}

pub fn runtime_marker_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_root(app)?.join(".runtime-ready"))
}

/// Locate the bundled `resources/omnivoice/` directory containing both the
/// `omnivoice` Python package (`omnivoice/__init__.py` + `pyproject.toml`) and
/// `omnivoice_worker.py`.
pub fn omnivoice_resource_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("resources").join("omnivoice"));
        candidates.push(res.join("omnivoice"));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("omnivoice"),
    );

    for dir in candidates {
        if dir.join("omnivoice").join("__init__.py").is_file()
            && dir.join("omnivoice_worker.py").is_file()
        {
            return Ok(dir);
        }
    }
    Err("Bundled OmniVoice package not found in application resources".to_string())
}

pub fn worker_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(omnivoice_resource_dir(app)?.join("omnivoice_worker.py"))
}

pub fn source_version(source_dir: &Path) -> String {
    let Ok(pyproject) = std::fs::read_to_string(source_dir.join("pyproject.toml")) else {
        return "unknown".to_string();
    };
    for line in pyproject.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("version") {
            let rest = rest.trim_start();
            if let Some(rest) = rest.strip_prefix('=') {
                let val = rest.trim().trim_matches('"').trim_matches('\'');
                if !val.is_empty() {
                    return val.to_string();
                }
            }
        }
    }
    "unknown".to_string()
}

pub fn read_runtime_marker(app: &AppHandle) -> RuntimeMarker {
    runtime_marker_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<RuntimeMarker>(&s).ok())
        .unwrap_or_default()
}

pub fn is_runtime_current(app: &AppHandle) -> bool {
    let Ok(src_dir) = omnivoice_resource_dir(app) else {
        return false;
    };
    let marker = read_runtime_marker(app);
    marker.version == Some(RUNTIME_VERSION)
        && marker.source_version.as_deref() == Some(source_version(&src_dir).as_str())
}

pub fn is_model_installed(app: &AppHandle, model_id: &str) -> bool {
    model_path(app, model_id)
        .map(|p| p.join(".model-ready").is_file())
        .unwrap_or(false)
}

pub fn safe_profile_prompt_path(app: &AppHandle, profile_id: Option<&str>) -> Option<PathBuf> {
    let raw = profile_id?;
    let safe: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    if safe.is_empty() {
        return None;
    }
    let root = voice_prompt_root(app).ok()?;
    let _ = std::fs::create_dir_all(&root);
    Some(root.join(format!("{}.pt", safe)))
}

/// Environment variables passed to every Python command so UTF-8 output, MPS
/// fallback, bundled `omnivoice` imports, and `ffmpeg` discovery work reliably.
pub fn utf8_env(app: &AppHandle) -> Result<HashMap<String, String>, String> {
    let sep = if cfg!(windows) { ";" } else { ":" };
    let src_dir = omnivoice_resource_dir(app)?;
    let ffmpeg = crate::media::probe::ffmpeg_binary();

    let mut env: HashMap<String, String> = std::env::vars().collect();
    env.insert("PYTHONUTF8".into(), "1".into());
    env.insert("PYTHONIOENCODING".into(), "utf-8".into());
    env.insert("PYTORCH_ENABLE_MPS_FALLBACK".into(), "1".into());

    let pythonpath = match std::env::var("PYTHONPATH") {
        Ok(existing) if !existing.is_empty() => {
            format!("{}{}{}", src_dir.to_string_lossy(), sep, existing)
        }
        _ => src_dir.to_string_lossy().into_owned(),
    };
    env.insert("PYTHONPATH".into(), pythonpath);

    let ffmpeg_str = ffmpeg.to_string_lossy().into_owned();
    env.insert("FFMPEG_BINARY".into(), ffmpeg_str.clone());
    env.insert("IMAGEIO_FFMPEG_EXE".into(), ffmpeg_str);

    if let Some(ffmpeg_dir) = ffmpeg.parent().filter(|p| !p.as_os_str().is_empty()) {
        let path_val = match std::env::var("PATH") {
            Ok(existing) if !existing.is_empty() => {
                format!("{}{}{}", ffmpeg_dir.to_string_lossy(), sep, existing)
            }
            _ => ffmpeg_dir.to_string_lossy().into_owned(),
        };
        env.insert("PATH".into(), path_val);
    }

    Ok(env)
}
