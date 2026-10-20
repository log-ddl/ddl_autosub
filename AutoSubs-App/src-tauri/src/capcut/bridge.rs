//! Native CapCut Desktop draft bridge (`draft_info.json` / `draft_meta_info.json`).
//!
//! CapCut Desktop stores every project as a plain JSON folder inside
//! `~/Movies/CapCut/User Data/Projects/com.lveditor.draft/<project>/` (macOS) or
//! `%LOCALAPPDATA%\CapCut\User Data\Projects\com.lveditor.draft\<project>\` (Windows).
//!
//! This module lets AutoSubs (and any embedded AI Director CLI) inspect CapCut
//! projects, place media/B-roll storyboards with zoom/pan/rotation/keyframes,
//! inject styled subtitle tracks, and extract timeline audio for transcription.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

pub(crate) const US_PER_SEC: f64 = 1_000_000.0;

fn now_sec() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn now_us() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0)
}

pub(crate) fn new_id() -> String {
    Uuid::new_v4().to_string().to_uppercase()
}

/// Locate the CapCut `com.lveditor.draft` root directory on the current OS.
pub fn capcut_drafts_root() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = dirs::home_dir()?;
        let candidates = [
            home.join("Movies/CapCut/User Data/Projects/com.lveditor.draft"),
            home.join("Library/Containers/com.lemon.lvoverseas/Data/Movies/CapCut/User Data/Projects/com.lveditor.draft"),
            home.join("Movies/JianyingPro/User Data/Projects/com.lveditor.draft"),
        ];
        for c in &candidates {
            if c.is_dir() {
                return Some(c.clone());
            }
        }
        return Some(candidates[0].clone());
    }

    #[cfg(target_os = "windows")]
    {
        let local = dirs::data_local_dir()?;
        let candidates = [
            local.join("CapCut\\User Data\\Projects\\com.lveditor.draft"),
            local.join("JianyingPro\\User Data\\Projects\\com.lveditor.draft"),
        ];
        for c in &candidates {
            if c.is_dir() {
                return Some(c.clone());
            }
        }
        return Some(candidates[0].clone());
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let home = dirs::home_dir()?;
        Some(home.join("CapCut/User Data/Projects/com.lveditor.draft"))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapCutDraftSummary {
    pub id: String,
    pub name: String,
    pub folder_path: String,
    pub json_path: String,
    pub modified_us: i64,
    pub duration_us: i64,
    pub fps: f64,
    pub width: i64,
    pub height: i64,
    pub track_count: usize,
    pub clip_count: usize,
}

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

fn draft_summary_cache() -> &'static Mutex<HashMap<String, (i64, CapCutDraftSummary)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (i64, CapCutDraftSummary)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn enrich_draft_summary_from_json(mut summary: CapCutDraftSummary) -> CapCutDraftSummary {
    if let Ok(cache) = draft_summary_cache().lock() {
        if let Some((cached_mtime, cached)) = cache.get(&summary.json_path) {
            if *cached_mtime == summary.modified_us && summary.modified_us > 0 {
                return cached.clone();
            }
        }
    }

    if let Ok(text) = fs::read_to_string(&summary.json_path) {
        if let Ok(info) = serde_json::from_str::<Value>(&text) {
            if let Some(fps) = info.get("fps").and_then(|v| v.as_f64()) {
                summary.fps = fps;
            }
            if let Some(dur) = info.get("duration").and_then(|v| v.as_i64()) {
                if dur > 0 {
                    summary.duration_us = dur;
                }
            }
            if let Some(canvas) = info.get("canvas_config") {
                if let Some(w) = canvas.get("width").and_then(|v| v.as_i64()) {
                    summary.width = w;
                }
                if let Some(h) = canvas.get("height").and_then(|v| v.as_i64()) {
                    summary.height = h;
                }
            }
            if let Some(tracks) = info.get("tracks").and_then(|v| v.as_array()) {
                summary.track_count = tracks.len();
                summary.clip_count = tracks
                    .iter()
                    .map(|t| {
                        t.get("segments")
                            .and_then(|s| s.as_array())
                            .map(|a| a.len())
                            .unwrap_or(0)
                    })
                    .sum();
            }
        }
    }

    if let Ok(mut cache) = draft_summary_cache().lock() {
        cache.insert(
            summary.json_path.clone(),
            (summary.modified_us, summary.clone()),
        );
    }
    summary
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapCutTrackOption {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapCutTemplateOption {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapCutStatusResponse {
    pub connected: bool,
    pub drafts_root: String,
    pub drafts: Vec<CapCutDraftSummary>,
    pub active_draft: Option<CapCutDraftSummary>,
    pub name: String,
    pub timeline_id: String,
    pub project_name: String,
    pub fps: f64,
    pub duration: f64,
    pub input_tracks: Vec<CapCutTrackOption>,
    pub output_tracks: Vec<CapCutTrackOption>,
    pub templates: Vec<CapCutTemplateOption>,
}

/// Resolve the JSON file inside a draft directory (`draft_info.json` on modern
/// CapCut Mac/Win, falling back to `draft_content.json`).
fn find_draft_json_path(folder: &Path) -> Option<PathBuf> {
    let info = folder.join("draft_info.json");
    if info.is_file() {
        return Some(info);
    }
    let content = folder.join("draft_content.json");
    if content.is_file() {
        return Some(content);
    }
    None
}

/// Enumerate all valid CapCut drafts, sorted most-recently-modified first.
pub fn list_capcut_drafts() -> Result<(PathBuf, Vec<CapCutDraftSummary>), String> {
    let root = capcut_drafts_root()
        .ok_or_else(|| "Could not determine CapCut drafts directory".to_string())?;
    if !root.is_dir() {
        return Ok((root, Vec::new()));
    }

    let mut drafts: Vec<CapCutDraftSummary> = Vec::new();
    let root_meta_path = root.join("root_meta_info.json");
    if let Ok(text) = fs::read_to_string(&root_meta_path) {
        if let Ok(meta) = serde_json::from_str::<Value>(&text) {
            if let Some(arr) = meta.get("all_draft_store").and_then(|v| v.as_array()) {
                for item in arr {
                    let removed = item
                        .get("tm_draft_removed")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);
                    if removed != 0 {
                        continue;
                    }
                    let fold = item
                        .get("draft_fold_path")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if fold.is_empty() {
                        continue;
                    }
                    let folder_path = PathBuf::from(fold);
                    let Some(json_file) = find_draft_json_path(&folder_path) else {
                        continue;
                    };
                    let id = item
                        .get("draft_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let name = item
                        .get("draft_name")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| {
                            folder_path
                                .file_name()
                                .map(|n| n.to_string_lossy().into_owned())
                                .unwrap_or_else(|| "Untitled".to_string())
                        });
                    let modified_us = item
                        .get("tm_draft_modified")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);
                    let duration_us = item
                        .get("tm_duration")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);

                    drafts.push(enrich_draft_summary_from_json(CapCutDraftSummary {
                        id: if id.is_empty() { name.clone() } else { id },
                        name,
                        folder_path: folder_path.to_string_lossy().into_owned(),
                        json_path: json_file.to_string_lossy().into_owned(),
                        modified_us,
                        duration_us,
                        fps: 30.0,
                        width: 1920,
                        height: 1080,
                        track_count: 0,
                        clip_count: 0,
                    }));
                }
            }
        }
    }

    // Also scan subdirectories in case a draft folder is not yet in root_meta_info.json
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let dir_name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            if dir_name.starts_with('.') {
                continue;
            }
            let Some(json_file) = find_draft_json_path(&path) else {
                continue;
            };
            let folder_str = path.to_string_lossy().into_owned();
            if drafts.iter().any(|d| d.folder_path == folder_str) {
                continue;
            }
            let modified_us = fs::metadata(&json_file)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_micros() as i64)
                .unwrap_or(0);
            drafts.push(enrich_draft_summary_from_json(CapCutDraftSummary {
                id: dir_name.clone(),
                name: dir_name,
                folder_path: folder_str,
                json_path: json_file.to_string_lossy().into_owned(),
                modified_us,
                duration_us: 0,
                fps: 30.0,
                width: 1920,
                height: 1080,
                track_count: 0,
                clip_count: 0,
            }));
        }
    }

    drafts.sort_by(|a, b| b.modified_us.cmp(&a.modified_us));
    Ok((root, drafts))
}

#[tauri::command]
pub async fn capcut_get_status(preferred_draft_id: Option<String>) -> Result<CapCutStatusResponse, String> {
    let (root, drafts) = list_capcut_drafts()?;
    let active = preferred_draft_id
        .as_deref()
        .and_then(|want| drafts.iter().find(|d| d.id == want || d.name == want || d.folder_path == want))
        .or_else(|| drafts.first())
        .cloned();

    let Some(draft) = active else {
        return Ok(CapCutStatusResponse {
            connected: false,
            drafts_root: root.to_string_lossy().into_owned(),
            drafts,
            active_draft: None,
            name: String::new(),
            timeline_id: String::new(),
            project_name: String::new(),
            fps: 30.0,
            duration: 0.0,
            input_tracks: Vec::new(),
            output_tracks: Vec::new(),
            templates: Vec::new(),
        });
    };

    let text = fs::read_to_string(&draft.json_path)
        .map_err(|e| format!("Failed to read CapCut draft {}: {}", draft.json_path, e))?;
    let info: Value = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse CapCut draft {}: {}", draft.json_path, e))?;

    let fps = info.get("fps").and_then(|v| v.as_f64()).unwrap_or(30.0);
    let duration_us = info.get("duration").and_then(|v| v.as_i64()).unwrap_or(0);
    let duration = (duration_us as f64) / US_PER_SEC;

    let mut video_track_count = 0usize;
    let mut audio_track_count = 0usize;
    let mut text_track_count = 0usize;
    if let Some(tracks) = info.get("tracks").and_then(|v| v.as_array()) {
        for tr in tracks {
            match tr.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                "video" => video_track_count += 1,
                "audio" => audio_track_count += 1,
                "text" => text_track_count += 1,
                _ => {}
            }
        }
    }

    let mut output_tracks = vec![CapCutTrackOption {
        value: "0".to_string(),
        label: "Add to New Track".to_string(),
    }];
    let total_out = (video_track_count + text_track_count).max(1);
    for i in 1..=total_out {
        output_tracks.push(CapCutTrackOption {
            value: i.to_string(),
            label: format!("Track {}", i),
        });
    }

    let mut input_tracks = Vec::new();
    let total_in = audio_track_count.max(1);
    for i in 1..=total_in {
        input_tracks.push(CapCutTrackOption {
            value: i.to_string(),
            label: format!("Audio {}", i),
        });
    }

    let templates = vec![
        CapCutTemplateOption {
            value: "CapCut Default".to_string(),
            label: "CapCut Default Text".to_string(),
        },
        CapCutTemplateOption {
            value: "CapCut Yellow Pop".to_string(),
            label: "CapCut Yellow Pop".to_string(),
        },
    ];

    Ok(CapCutStatusResponse {
        connected: true,
        drafts_root: root.to_string_lossy().into_owned(),
        drafts,
        active_draft: Some(draft.clone()),
        name: draft.name.clone(),
        timeline_id: draft.id.clone(),
        project_name: draft.name,
        fps,
        duration,
        input_tracks,
        output_tracks,
        templates,
    })
}

pub(crate) fn is_still_image(path: &str) -> bool {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "jpg" | "jpeg" | "png" | "webp" | "bmp" | "gif" | "tiff" | "tif" | "heic"
    )
}

/// Persist modified `draft_info.json` (plus `.bak` and `root_meta_info.json`
/// timestamps) atomically so CapCut picks up the updated timeline cleanly.
pub(crate) fn save_draft_json(draft: &CapCutDraftSummary, info: &Value, max_duration_us: i64) -> Result<(), String> {
    let serialized = serde_json::to_string(info)
        .map_err(|e| format!("Failed to serialize CapCut draft JSON: {}", e))?;

    let json_path = PathBuf::from(&draft.json_path);
    let tmp_path = json_path.with_extension("json.autosubs-tmp");
    fs::write(&tmp_path, &serialized)
        .map_err(|e| format!("Failed to write {}: {}", tmp_path.display(), e))?;
    fs::rename(&tmp_path, &json_path)
        .map_err(|e| format!("Failed to replace {}: {}", json_path.display(), e))?;

    // Keep draft_info.json.bak, draft_content.json.bak, template-2.tmp AND Timelines/<id>/* in sync
    let folder = PathBuf::from(&draft.folder_path);
    let content_filename = json_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("draft_info.json");
    let bak_name = format!("{}.bak", content_filename);

    for rel in [&bak_name as &str, "template-2.tmp"] {
        let p = folder.join(rel);
        if p.exists() {
            let _ = fs::write(&p, &serialized);
        }
    }

    let timelines_dir = folder.join("Timelines");
    if timelines_dir.is_dir() {
        if let Ok(entries) = fs::read_dir(&timelines_dir) {
            for entry in entries.flatten() {
                let sub = entry.path();
                if sub.is_dir() {
                    for rel in [content_filename, &bak_name as &str, "template-2.tmp"] {
                        let target = sub.join(rel);
                        if target.exists() || rel == content_filename {
                            let _ = fs::write(&target, &serialized);
                        }
                    }
                }
            }
        }
    }

    // Update draft_meta_info.json modified timestamp + duration
    let meta_path = folder.join("draft_meta_info.json");
    let modified_now = now_us();
    if let Ok(meta_text) = fs::read_to_string(&meta_path) {
        if let Ok(mut meta_json) = serde_json::from_str::<Value>(&meta_text) {
            meta_json["tm_draft_modified"] = json!(modified_now);
            meta_json["tm_duration"] = json!(max_duration_us);
            if let Ok(out) = serde_json::to_string(&meta_json) {
                let _ = fs::write(&meta_path, out);
            }
        }
    }

    // Update root_meta_info.json modified timestamp + duration
    if let Some(root) = folder.parent() {
        let root_meta = root.join("root_meta_info.json");
        if let Ok(rm_text) = fs::read_to_string(&root_meta) {
            if let Ok(mut rm_json) = serde_json::from_str::<Value>(&rm_text) {
                if let Some(arr) = rm_json.get_mut("all_draft_store").and_then(|v| v.as_array_mut()) {
                    for item in arr {
                        let fold = item.get("draft_fold_path").and_then(|v| v.as_str()).unwrap_or("");
                        if fold == draft.folder_path {
                            item["tm_draft_modified"] = json!(modified_now);
                            item["tm_duration"] = json!(max_duration_us);
                        }
                    }
                }
                if let Ok(out) = serde_json::to_string(&rm_json) {
                    let _ = fs::write(&root_meta, out);
                }
            }
        }
    }

    Ok(())
}

/// Register a media file in `draft_meta_info.json` (`draft_materials[0].value`)
/// so it also appears inside CapCut's Project Media bin.
pub(crate) fn register_in_draft_meta(folder_path: &str, file_path: &str, is_photo: bool, duration_us: i64) {
    let meta_path = Path::new(folder_path).join("draft_meta_info.json");
    let Ok(text) = fs::read_to_string(&meta_path) else {
        return;
    };
    let Ok(mut meta) = serde_json::from_str::<Value>(&text) else {
        return;
    };
    let Some(materials) = meta.get_mut("draft_materials").and_then(|v| v.as_array_mut()) else {
        return;
    };
    let Some(bin) = materials
        .iter_mut()
        .find(|m| m.get("type").and_then(|v| v.as_i64()) == Some(0))
    else {
        return;
    };
    let Some(values) = bin.get_mut("value").and_then(|v| v.as_array_mut()) else {
        return;
    };
    if values
        .iter()
        .any(|v| v.get("file_Path").and_then(|p| p.as_str()) == Some(file_path))
    {
        return;
    }

    let filename = Path::new(file_path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let sec = now_sec();
    let us = now_us();
    values.push(json!({
        "ai_group_type": "",
        "create_time": sec,
        "duration": duration_us,
        "enter_from": 0,
        "extra_info": filename,
        "file_Path": file_path,
        "height": if is_photo { 1080 } else { 1080 },
        "id": Uuid::new_v4().to_string(),
        "import_time": sec,
        "import_time_ms": us,
        "item_source": 1,
        "material_color_tag": "",
        "md5": "",
        "metetype": if is_photo { "photo" } else { "video" },
        "roughcut_time_range": { "duration": -1, "start": -1 },
        "sub_time_range": { "duration": -1, "start": -1 },
        "type": 0,
        "width": 1920
    }));

    if let Ok(out) = serde_json::to_string(&meta) {
        let _ = fs::write(&meta_path, out);
    }
}

/// One piece of on-screen text, in seconds on the timeline.
#[derive(Debug, Clone)]
pub(crate) struct TextCue {
    pub start_sec: f64,
    pub end_sec: f64,
    pub text: String,
}

/// Append `cues` to `info` as one new text track (white text, or yellow when
/// the template name contains "Yellow"), and extend the draft duration to
/// cover them. Empty cues and cues that end before they start are skipped.
/// Returns how many were added.
pub(crate) fn append_text_track(info: &mut Value, cues: &[TextCue], template_name: Option<&str>) -> usize {
    if !info["materials"].is_object() {
        info["materials"] = json!({});
    }
    if !info["materials"]["texts"].is_array() {
        info["materials"]["texts"] = json!([]);
    }
    if !info["materials"]["material_animations"].is_array() {
        info["materials"]["material_animations"] = json!([]);
    }
    if !info["tracks"].is_array() {
        info["tracks"] = json!([]);
    }

    let is_yellow = template_name
        .map(|t| t.contains("Yellow"))
        .unwrap_or(false);
    let fill_rgb = if is_yellow {
        [1.0, 0.92, 0.23]
    } else {
        [1.0, 1.0, 1.0]
    };

    let mut max_end_us = info.get("duration").and_then(|v| v.as_i64()).unwrap_or(0);
    let mut track_segments = Vec::new();
    let mut added = 0usize;

    for cue in cues {
        let start_sec = cue.start_sec;
        let end_sec = cue.end_sec;
        let text_str = cue.text.trim();
        if text_str.is_empty() || end_sec <= start_sec {
            continue;
        }

        let start_us = (start_sec.max(0.0) * US_PER_SEC).round() as i64;
        let dur_us = ((end_sec - start_sec).max(0.1) * US_PER_SEC).round() as i64;

        let text_id = new_id();
        let anim_id = new_id();
        let char_count = text_str.chars().count();

        let content_json = json!({
            "styles": [{
                "fill": {
                    "alpha": 1.0,
                    "content": {
                        "render_type": "solid",
                        "solid": {
                            "alpha": 1.0,
                            "color": fill_rgb
                        }
                    }
                },
                "range": [0, char_count],
                "size": 8.0,
                "bold": true,
                "strokes": [{
                    "content": {
                        "solid": {
                            "alpha": 1.0,
                            "color": [0.0, 0.0, 0.0]
                        }
                    },
                    "width": 0.08
                }]
            }],
            "text": text_str
        });

        info["materials"]["texts"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "add_type": 0,
                "alignment": 1,
                "background_alpha": 1.0,
                "background_color": "",
                "background_height": 0.14,
                "background_horizontal_offset": 0.0,
                "background_round_radius": 0.0,
                "background_style": 0,
                "background_vertical_offset": 0.0,
                "background_width": 0.14,
                "base_content": "",
                "bold_width": 0.0,
                "border_alpha": 1.0,
                "border_color": "#000000",
                "border_width": 0.08,
                "caption_template_info": {
                    "category_id": "",
                    "category_name": "",
                    "effect_id": "",
                    "is_new": false,
                    "path": "",
                    "request_id": "",
                    "resource_id": "",
                    "resource_name": "",
                    "source_platform": 0
                },
                "check_flag": 7,
                "combo_info": { "text_templates": [] },
                "content": content_json.to_string(),
                "fixed_height": -1.0,
                "fixed_width": -1.0,
                "font_category_id": "",
                "font_category_name": "",
                "font_id": "",
                "font_name": "",
                "font_path": "",
                "font_resource_id": "",
                "font_size": 8.0,
                "font_source_platform": 0,
                "font_team_id": "",
                "font_title": "none",
                "font_url": "",
                "fonts": [],
                "force_apply_line_max_width": false,
                "global_alpha": 1.0,
                "group_id": "",
                "has_shadow": false,
                "id": text_id,
                "initial_scale": 1.0,
                "inner_padding": -1.0,
                "is_rich_text": false,
                "italic_degree": 0,
                "ktv_color": "",
                "language": "",
                "layer_weight": 1,
                "letter_spacing": 0.0,
                "line_feed": 1,
                "line_max_width": 0.82,
                "line_spacing": 0.02,
                "multi_language_current": "none",
                "name": "",
                "original_size": [],
                "preset_category": "",
                "preset_category_id": "",
                "preset_has_set_alignment": false,
                "preset_id": "",
                "preset_index": 0,
                "preset_name": "",
                "recognize_task_id": "",
                "recognize_type": 0,
                "relevance_segment": [],
                "shadow_alpha": 0.8,
                "shadow_angle": -45.0,
                "shadow_color": "",
                "shadow_distance": 5.0,
                "shadow_point": { "x": 0.6363961030678928, "y": -0.6363961030678928 },
                "shadow_smoothing": 0.45,
                "shape_clip_x": false,
                "shape_clip_y": false,
                "source_from": "",
                "style_name": "",
                "sub_type": 0,
                "subtitle_keywords": null,
                "subtitle_template_original_fontsize": 0.0,
                "text_alpha": 1.0,
                "text_color": if is_yellow { "#ffeb3b" } else { "#ffffff" },
                "text_curve": null,
                "text_preset_resource_id": "",
                "text_size": 30,
                "text_to_audio_ids": [],
                "tts_auto_update": false,
                "type": "subtitle",
                "typesetting": 0,
                "underline": false,
                "underline_offset": 0.22,
                "underline_width": 0.05,
                "use_effect_default_color": true,
                "words": { "end_time": [], "start_time": [], "text": [] }
            }));

        info["materials"]["material_animations"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "animations": [],
                "id": anim_id,
                "multi_language_current": "none",
                "type": "sticker_animation"
            }));

        track_segments.push(json!({
            "cartoon": false,
            "clip": {
                "alpha": 1.0,
                "flip": { "horizontal": false, "vertical": false },
                "rotation": 0.0,
                "scale": { "x": 1.0, "y": 1.0 },
                "transform": { "x": 0.0, "y": -0.75 }
            },
            "common_keyframes": [],
            "enable_adjust": false,
            "enable_color_correct_adjust": false,
            "enable_color_curves": true,
            "enable_color_match_adjust": false,
            "enable_color_wheels": true,
            "enable_lut": false,
            "enable_smart_color_adjust": false,
            "extra_material_refs": [anim_id],
            "group_id": "",
            "hdr_settings": null,
            "id": new_id(),
            "intensifies_audio": false,
            "is_placeholder": false,
            "is_tone_modify": false,
            "keyframe_refs": [],
            "last_nonzero_volume": 1.0,
            "material_id": text_id,
            "render_index": 14000 + (added as i64),
            "responsive_layout": {
                "enable": false,
                "horizontal_pos_layout": 0,
                "size_layout": 0,
                "target_follow": "",
                "vertical_pos_layout": 0
            },
            "reverse": false,
            "source_timerange": null,
            "speed": 1.0,
            "target_timerange": { "duration": dur_us, "start": start_us },
            "template_id": "",
            "template_scene": "default",
            "track_attribute": 0,
            "track_render_index": 1,
            "uniform_scale": { "on": true, "value": 1.0 },
            "visible": true,
            "volume": 1.0
        }));

        max_end_us = max_end_us.max(start_us + dur_us);
        added += 1;
    }

    if !track_segments.is_empty() {
        info["tracks"].as_array_mut().unwrap().push(json!({
            "attribute": 0,
            "flag": 0,
            "id": new_id(),
            "is_default_name": true,
            "name": "",
            "segments": track_segments,
            "type": "text"
        }));
    }

    info["duration"] = json!(max_end_us);
    added
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapCutAddSubtitlesArgs {
    pub file_path: String,
    pub preferred_draft_id: Option<String>,
    pub template_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapCutAddSubtitlesResponse {
    pub added: usize,
    pub draft_name: String,
}

#[tauri::command]
pub async fn capcut_add_subtitles(
    args: CapCutAddSubtitlesArgs,
) -> Result<CapCutAddSubtitlesResponse, String> {
    let status = capcut_get_status(args.preferred_draft_id.clone()).await?;
    let draft = status
        .active_draft
        .ok_or_else(|| "No CapCut project found. Please create a project in CapCut first.".to_string())?;

    let sub_text = fs::read_to_string(&args.file_path)
        .map_err(|e| format!("Failed to read subtitle file {}: {}", args.file_path, e))?;
    let sub_doc: Value = serde_json::from_str(&sub_text)
        .map_err(|e| format!("Failed to parse subtitle file {}: {}", args.file_path, e))?;

    let segments_list = sub_doc
        .get("segments")
        .or_else(|| sub_doc.get("subtitles"))
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Subtitle document has no segments array".to_string())?;

    let cues: Vec<TextCue> = segments_list
        .iter()
        .map(|seg| {
            let start_sec = seg.get("start").and_then(|v| v.as_f64()).unwrap_or(0.0);
            TextCue {
                start_sec,
                end_sec: seg.get("end").and_then(|v| v.as_f64()).unwrap_or(start_sec + 1.5),
                text: seg.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            }
        })
        .collect();

    let draft_text = fs::read_to_string(&draft.json_path)
        .map_err(|e| format!("Failed to read {}: {}", draft.json_path, e))?;
    let mut info: Value = serde_json::from_str(&draft_text)
        .map_err(|e| format!("Failed to parse {}: {}", draft.json_path, e))?;

    let added = append_text_track(&mut info, &cues, args.template_name.as_deref());
    let max_end_us = info.get("duration").and_then(|v| v.as_i64()).unwrap_or(0);
    save_draft_json(&draft, &info, max_end_us)?;

    Ok(CapCutAddSubtitlesResponse {
        added,
        draft_name: draft.name,
    })
}

/// Find the primary audio or video file on the active CapCut timeline so the
/// user can transcribe directly from a CapCut draft.
#[tauri::command]
pub async fn capcut_get_timeline_audio(
    preferred_draft_id: Option<String>,
) -> Result<Value, String> {
    let status = capcut_get_status(preferred_draft_id).await?;
    let draft = status
        .active_draft
        .ok_or_else(|| "No CapCut project found.".to_string())?;

    let text = fs::read_to_string(&draft.json_path)
        .map_err(|e| format!("Failed to read {}: {}", draft.json_path, e))?;
    let info: Value = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse {}: {}", draft.json_path, e))?;

    if let Some(audios) = info["materials"]["audios"].as_array() {
        for a in audios {
            if let Some(p) = a.get("path").and_then(|v| v.as_str()) {
                if !p.is_empty() && Path::new(p).exists() {
                    return Ok(json!({ "path": p, "offset": 0.0 }));
                }
            }
        }
    }
    if let Some(videos) = info["materials"]["videos"].as_array() {
        for v in videos {
            let mtype = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if mtype != "photo" {
                if let Some(p) = v.get("path").and_then(|p| p.as_str()) {
                    if !p.is_empty() && Path::new(p).exists() {
                        return Ok(json!({ "path": p, "offset": 0.0 }));
                    }
                }
            }
        }
    }

    Err("No audio or video clip found in the active CapCut project.".to_string())
}

