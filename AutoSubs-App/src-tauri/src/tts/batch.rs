//! Folder batch scanning, text reading, and sibling `.wav` placement.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;

use super::allow_audio_file;
use super::paths::output_root;

const AUDIO_EXTENSIONS: &[&str] = &["wav", "mp3"];
const MAX_FILES: usize = 2000;
const MAX_TEXT_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsBatchScanFile {
    pub path: String,
    pub name: String,
    pub chars: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub existing_audio_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsBatchScanResult {
    pub success: bool,
    pub files: Vec<TtsBatchScanFile>,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsBatchTextResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsBatchSaveResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn sibling_audio_path(text_file: &Path, ext: &str) -> PathBuf {
    let stem = text_file
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("audio");
    let parent = text_file.parent().unwrap_or_else(|| Path::new("."));
    parent.join(format!("{}.{}", stem, ext.trim_start_matches('.')))
}

fn collect_text_files(dir: &Path, found: &mut Vec<PathBuf>) {
    if found.len() >= MAX_FILES {
        return;
    }
    let Ok(read_dir) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = read_dir.flatten().collect();
    entries.sort_by(|a, b| a.file_name().cmp(&b.file_name()));

    for entry in entries {
        if found.len() >= MAX_FILES {
            return;
        }
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') {
            continue;
        }
        // `entry.file_type()` does not follow symlinks, avoiding symlink cycles.
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        let full = entry.path();
        if ft.is_dir() {
            collect_text_files(&full, found);
        } else if ft.is_file()
            && full
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("txt"))
        {
            found.push(full);
        }
    }
}

fn count_characters(file_path: &Path) -> i64 {
    let Ok(meta) = std::fs::metadata(file_path) else {
        return -1;
    };
    if meta.len() > MAX_TEXT_BYTES {
        return -1;
    }
    let Ok(raw) = std::fs::read_to_string(file_path) else {
        return -1;
    };
    let stripped = raw.strip_prefix('\u{FEFF}').unwrap_or(&raw);
    stripped.trim().chars().count() as i64
}

pub fn scan_batch_folder(app: &AppHandle, folder_path: &str) -> TtsBatchScanResult {
    let root = Path::new(folder_path);
    if folder_path.trim().is_empty() || !root.is_dir() {
        return TtsBatchScanResult {
            success: false,
            files: Vec::new(),
            truncated: false,
            error: Some("Folder not found".to_string()),
        };
    }

    let mut found = Vec::new();
    collect_text_files(root, &mut found);
    let truncated = found.len() >= MAX_FILES;

    let mut files = Vec::with_capacity(found.len());
    for file_path in found {
        let rel_name = file_path
            .strip_prefix(root)
            .ok()
            .filter(|p| !p.as_os_str().is_empty())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| {
                file_path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default()
            });

        let existing = AUDIO_EXTENSIONS
            .iter()
            .map(|ext| sibling_audio_path(&file_path, ext))
            .find(|candidate| candidate.is_file());

        if let Some(ref audio) = existing {
            allow_audio_file(app, audio);
        }

        files.push(TtsBatchScanFile {
            path: file_path.to_string_lossy().into_owned(),
            name: rel_name,
            chars: count_characters(&file_path),
            existing_audio_path: existing.map(|p| p.to_string_lossy().into_owned()),
        });
    }

    TtsBatchScanResult {
        success: true,
        files,
        truncated,
        error: None,
    }
}

pub fn read_batch_text(file_path: &str) -> TtsBatchTextResult {
    let path = Path::new(file_path);
    let is_txt = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("txt"));
    if !is_txt {
        return TtsBatchTextResult {
            success: false,
            text: None,
            error: Some("Only .txt files are supported".to_string()),
        };
    }
    let Ok(meta) = std::fs::metadata(path) else {
        return TtsBatchTextResult {
            success: false,
            text: None,
            error: Some("Text file not found".to_string()),
        };
    };
    if meta.len() > MAX_TEXT_BYTES {
        return TtsBatchTextResult {
            success: false,
            text: None,
            error: Some("Text file exceeds 5 MB limit".to_string()),
        };
    }
    match std::fs::read_to_string(path) {
        Ok(raw) => {
            let clean = raw.strip_prefix('\u{FEFF}').unwrap_or(&raw).to_string();
            TtsBatchTextResult {
                success: true,
                text: Some(clean),
                error: None,
            }
        }
        Err(e) => TtsBatchTextResult {
            success: false,
            text: None,
            error: Some(e.to_string()),
        },
    }
}

pub fn save_batch_output(
    app: &AppHandle,
    source_path: &str,
    text_file_path: &str,
) -> TtsBatchSaveResult {
    let src = Path::new(source_path);
    if !src.is_file() {
        return TtsBatchSaveResult {
            success: false,
            output_path: None,
            error: Some("Generated audio file not found".to_string()),
        };
    }
    let txt = Path::new(text_file_path);
    let is_txt = txt
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("txt"));
    if !is_txt {
        return TtsBatchSaveResult {
            success: false,
            output_path: None,
            error: Some("Target path must correspond to a .txt file".to_string()),
        };
    }

    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("wav");
    let dest = sibling_audio_path(txt, ext);
    if let Err(e) = std::fs::copy(src, &dest) {
        return TtsBatchSaveResult {
            success: false,
            output_path: None,
            error: Some(e.to_string()),
        };
    }

    allow_audio_file(app, &dest);

    if let Ok(out_dir) = output_root(app) {
        if let (Ok(canon_src), Ok(canon_out)) = (src.canonicalize(), out_dir.canonicalize()) {
            if canon_src.starts_with(&canon_out) {
                let _ = std::fs::remove_file(src);
            }
        }
    }

    TtsBatchSaveResult {
        success: true,
        output_path: Some(dest.to_string_lossy().into_owned()),
        error: None,
    }
}
