//! Media enumeration for the slideshow builder.
//!
//! The webview's `fs` plugin is scoped to a few fixed folders, so it can't list
//! an arbitrary directory the user picks. Rust has full filesystem access, so
//! folder scanning and per-file timestamps go through here instead. Returns only
//! image/video files, each tagged with its kind and creation/modified time so
//! the frontend can offer name / time / random sorting.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "bmp", "webp", "tif", "tiff", "heic", "avif",
];
const VIDEO_EXTS: &[&str] = &[
    "mp4", "mov", "mkv", "avi", "webm", "m4v", "wmv", "mpg", "mpeg", "flv",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFileInfo {
    pub path: String,
    pub name: String,
    /// "image" or "video".
    pub kind: String,
    /// Unix milliseconds; 0 when the platform doesn't expose the value.
    pub created_ms: f64,
    pub modified_ms: f64,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanMediaInput {
    /// A folder to list (top level only). Optional.
    pub dir: Option<String>,
    /// Explicit file paths (e.g. from a multi-select). Optional.
    pub paths: Option<Vec<String>>,
}

fn kind_of(path: &Path) -> Option<&'static str> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())?;
    if IMAGE_EXTS.contains(&ext.as_str()) {
        Some("image")
    } else if VIDEO_EXTS.contains(&ext.as_str()) {
        Some("video")
    } else {
        None
    }
}

fn millis(time: std::io::Result<SystemTime>) -> f64 {
    time.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

fn info_for(path: &Path) -> Option<MediaFileInfo> {
    let kind = kind_of(path)?;
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    // `created` isn't available on every filesystem (some Linux setups); fall
    // back to the modified time so time-sorting still has something to use.
    let created = millis(meta.created());
    let modified = millis(meta.modified());
    Some(MediaFileInfo {
        path: path.display().to_string(),
        name: path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string(),
        kind: kind.to_string(),
        created_ms: if created > 0.0 { created } else { modified },
        modified_ms: modified,
    })
}

/// List the media in `dir` and/or describe the given `paths`. Non-media and
/// unreadable entries are simply skipped. Results are unsorted — the frontend
/// owns ordering.
#[tauri::command]
pub fn scan_media(input: ScanMediaInput) -> Vec<MediaFileInfo> {
    let mut out: Vec<MediaFileInfo> = Vec::new();

    if let Some(dir) = input.dir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                if let Some(info) = info_for(&entry.path()) {
                    out.push(info);
                }
            }
        }
    }

    if let Some(paths) = input.paths {
        for p in paths {
            let path = PathBuf::from(&p);
            if let Some(info) = info_for(&path) {
                out.push(info);
            }
        }
    }

    out
}
