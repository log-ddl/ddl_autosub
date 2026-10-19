//! CapCut Storyboard Builder (`capcut_build_storyboard`) for AutoEdit & AI Video Director.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::capcut_bridge::{
    capcut_get_status, is_still_image, new_id, register_in_draft_meta, save_draft_json, US_PER_SEC,
};

#[derive(Debug, Clone, Deserialize)]
pub struct CapCutStoryboardEffect {
    pub zoom: Option<f64>,
    pub pan_x: Option<f64>,
    pub pan_y: Option<f64>,
    pub rotation: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CapCutStoryboardItem {
    pub path: String,
    pub start: f64,
    pub end: Option<f64>,
    pub src_in: Option<f64>,
    pub src_out: Option<f64>,
    pub effect: Option<CapCutStoryboardEffect>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CapCutBuildStoryboardSpec {
    pub preferred_draft_id: Option<String>,
    pub target_video_track: Option<usize>,
    pub mode: Option<String>,
    pub default_still_secs: Option<f64>,
    pub audio_path: Option<String>,
    pub items: Vec<CapCutStoryboardItem>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CapCutBuildStoryboardResult {
    pub lines: Vec<String>,
    pub appended: usize,
    pub requested: usize,
}

#[tauri::command]
pub async fn capcut_build_storyboard(
    spec: CapCutBuildStoryboardSpec,
) -> Result<CapCutBuildStoryboardResult, String> {
    let status = capcut_get_status(spec.preferred_draft_id.clone()).await?;
    let draft = status.active_draft.ok_or_else(|| {
        "No CapCut project found. Please create a project in CapCut first.".to_string()
    })?;

    let text = fs::read_to_string(&draft.json_path)
        .map_err(|e| format!("Failed to read {}: {}", draft.json_path, e))?;
    let mut info: Value = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse {}: {}", draft.json_path, e))?;

    let default_still = spec.default_still_secs.unwrap_or(4.0).max(0.2);
    let canvas_w = info
        .get("canvas_config")
        .and_then(|c| c.get("width"))
        .and_then(|v| v.as_f64())
        .unwrap_or(1920.0)
        .max(1.0);
    let canvas_h = info
        .get("canvas_config")
        .and_then(|c| c.get("height"))
        .and_then(|v| v.as_f64())
        .unwrap_or(1080.0)
        .max(1.0);

    let mut max_end_us = info.get("duration").and_then(|v| v.as_i64()).unwrap_or(0);
    let mut appended = 0usize;
    let mut lines = Vec::new();

    if !info["materials"].is_object() {
        info["materials"] = json!({});
    }
    for key in [
        "videos",
        "audios",
        "speeds",
        "canvases",
        "sound_channel_mappings",
        "vocal_separations",
    ] {
        if !info["materials"][key].is_array() {
            info["materials"][key] = json!([]);
        }
    }
    if !info["tracks"].is_array() {
        info["tracks"] = json!([]);
    }

    // 1. Optional voice-over audio track
    if let Some(ref audio_path) = spec.audio_path {
        if !audio_path.is_empty() && Path::new(audio_path).exists() {
            let audio_mat_id = new_id();
            let speed_id = new_id();
            let scm_id = new_id();
            let vs_id = new_id();
            let last_item_end_sec = spec
                .items
                .iter()
                .map(|it| it.end.unwrap_or(it.start + default_still))
                .fold(0.0_f64, f64::max);
            let dur_us = ((last_item_end_sec.max(10.0)) * US_PER_SEC).round() as i64;
            let name = Path::new(audio_path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "audio".to_string());

            info["materials"]["audios"]
                .as_array_mut()
                .unwrap()
                .push(json!({
                    "app_id": 0,
                    "category_id": "",
                    "category_name": "local",
                    "check_flag": 1,
                    "duration": dur_us,
                    "effect_id": "",
                    "Formula_id": "",
                    "id": audio_mat_id,
                    "local_material_id": "",
                    "music_id": "",
                    "name": name,
                    "path": audio_path,
                    "source_platform": 0,
                    "type": "extract_music",
                    "wave_points": []
                }));
            info["materials"]["speeds"]
                .as_array_mut()
                .unwrap()
                .push(json!({
                    "curve_speed": null,
                    "id": speed_id,
                    "mode": 0,
                    "speed": 1.0,
                    "type": "speed"
                }));
            info["materials"]["sound_channel_mappings"]
                .as_array_mut()
                .unwrap()
                .push(json!({
                    "audio_channel_mapping": 0,
                    "id": scm_id,
                    "is_config_open": false,
                    "type": ""
                }));
            info["materials"]["vocal_separations"]
                .as_array_mut()
                .unwrap()
                .push(json!({
                    "choice": 0,
                    "id": vs_id,
                    "production_path": "",
                    "time_range": null,
                    "type": "vocal_separation"
                }));

            let seg = json!({
                "cartoon": false,
                "clip": null,
                "common_keyframes": [],
                "enable_adjust": false,
                "enable_color_curves": true,
                "enable_color_wheels": true,
                "enable_lut": false,
                "enable_smart_color_adjust": false,
                "extra_material_refs": [speed_id, scm_id, vs_id],
                "group_id": "",
                "hdr_settings": null,
                "id": new_id(),
                "intensifies_audio": false,
                "is_placeholder": false,
                "is_tone_modify": false,
                "keyframe_refs": [],
                "last_nonzero_volume": 1.0,
                "material_id": audio_mat_id,
                "render_index": 0,
                "reverse": false,
                "source_timerange": { "duration": dur_us, "start": 0 },
                "speed": 1.0,
                "target_timerange": { "duration": dur_us, "start": 0 },
                "template_id": "",
                "template_scene": "default",
                "track_attribute": 0,
                "track_render_index": 0,
                "uniform_scale": null,
                "visible": true,
                "volume": 1.0
            });

            info["tracks"].as_array_mut().unwrap().push(json!({
                "attribute": 0,
                "flag": 0,
                "id": new_id(),
                "is_default_name": true,
                "name": "",
                "segments": [seg],
                "type": "audio"
            }));

            max_end_us = max_end_us.max(dur_us);
            lines.push(format!(
                "Added audio track '{}' to CapCut project '{}'",
                name, draft.name
            ));
        }
    }

    // 2. Video / Photo Storyboard items
    if !spec.items.is_empty() {
        let target_v_track = spec.target_video_track.unwrap_or(1).max(1);
        let raw_mode = spec
            .mode
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();

        // Determine existing end time on target_v_track
        let existing_track_end_us = get_video_track_end_us(&info["tracks"], target_v_track);
        let first_req_start_us =
            (spec.items[0].start.max(0.0) * US_PER_SEC).round() as i64;

        let effective_mode = match raw_mode.as_str() {
            "replace" | "overwrite" => "replace",
            "insert" | "ripple" => "insert",
            "overlay" | "broll" => "overlay",
            "append" => "append",
            _ => {
                if target_v_track >= 2 {
                    "overlay"
                } else if existing_track_end_us > 0
                    && first_req_start_us > 0
                    && first_req_start_us < existing_track_end_us
                {
                    "replace"
                } else {
                    "append"
                }
            }
        };

        let mut cursor_us: i64 = 0;
        let mut cursor_seeded = false;

        for item in &spec.items {
            if !Path::new(&item.path).exists() {
                lines.push(format!("Skipped missing file: {}", item.path));
                continue;
            }
            let is_photo = is_still_image(&item.path);
            let req_start_sec = item.start.max(0.0);
            let rec_dur_sec = match item.end {
                Some(e) if e > req_start_sec => e - req_start_sec,
                _ => default_still_or(item.src_in, item.src_out, default_still),
            };
            let req_start_us = (req_start_sec * US_PER_SEC).round() as i64;
            let rec_dur_us = (rec_dur_sec * US_PER_SEC).round() as i64;

            let rec_start_us = match effective_mode {
                "append" => {
                    let cur_track_end =
                        get_video_track_end_us(&info["tracks"], target_v_track);
                    if !cursor_seeded {
                        cursor_us = req_start_us.max(cur_track_end);
                        cursor_seeded = true;
                    }
                    let placed = req_start_us.max(cursor_us);
                    cursor_us = placed + rec_dur_us;
                    placed
                }
                "insert" | "replace" | "overlay" => {
                    if !cursor_seeded {
                        cursor_us = req_start_us;
                        cursor_seeded = true;
                    }
                    let placed = req_start_us.max(cursor_us);
                    cursor_us = placed + rec_dur_us;
                    placed
                }
                _ => req_start_us,
            };

            let src_start_us = if is_photo {
                0
            } else {
                (item.src_in.unwrap_or(0.0).max(0.0) * US_PER_SEC).round() as i64
            };
            let src_dur_us = if is_photo {
                rec_dur_us
            } else if let (Some(si), Some(so)) = (item.src_in, item.src_out) {
                if so > si {
                    ((so - si) * US_PER_SEC).round() as i64
                } else {
                    rec_dur_us
                }
            } else {
                rec_dur_us
            };

            let mat_id = new_id();
            let speed_id = new_id();
            let canvas_id = new_id();
            let scm_id = new_id();
            let vs_id = new_id();
            let filename = Path::new(&item.path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "media".to_string());

            let mat_dur_us = if is_photo {
                10_800_000_000_i64
            } else {
                (src_start_us + src_dur_us).max(rec_dur_us)
            };

            info["materials"]["videos"]
                .as_array_mut()
                .unwrap()
                .push(json!({
                    "aigc_type": "none",
                    "audio_fade": null,
                    "cartoon_path": "",
                    "category_id": "",
                    "category_name": "local",
                    "check_flag": 63487,
                    "crop": {
                        "lower_left_x": 0.0,
                        "lower_left_y": 1.0,
                        "lower_right_x": 1.0,
                        "lower_right_y": 1.0,
                        "upper_left_x": 0.0,
                        "upper_left_y": 0.0,
                        "upper_right_x": 1.0,
                        "upper_right_y": 0.0
                    },
                    "crop_ratio": "free",
                    "crop_scale": 1.0,
                    "duration": mat_dur_us,
                    "extra_type_option": 0,
                    "formula_id": "",
                    "freeze": null,
                    "has_audio": !is_photo,
                    "height": 1080,
                    "id": mat_id,
                    "intensifies_audio_path": "",
                    "intensifies_path": "",
                    "is_ai_generate_content": false,
                    "is_copyright": false,
                    "is_text_edit_overdub": false,
                    "is_unified_beauty_mode": false,
                    "local_id": "",
                    "local_material_id": "",
                    "material_id": "",
                    "material_name": filename,
                    "material_url": "",
                    "matting": {
                        "flag": 0,
                        "has_use_quick_brush": false,
                        "has_use_quick_eraser": false,
                        "interactiveTime": [],
                        "path": "",
                        "strokes": []
                    },
                    "media_path": "",
                    "object_locked": null,
                    "origin_material_id": "",
                    "path": item.path,
                    "picture_from": "none",
                    "picture_set_category_id": "",
                    "picture_set_category_name": "",
                    "request_id": "",
                    "reverse_intensifies_path": "",
                    "reverse_path": "",
                    "smart_motion": null,
                    "source": 0,
                    "source_platform": 0,
                    "stable": {
                        "matrix_path": "",
                        "stable_level": 0,
                        "time_range": { "duration": 0, "start": 0 }
                    },
                    "team_id": "",
                    "type": if is_photo { "photo" } else { "video" },
                    "video_algorithm": {
                        "algorithms": [],
                        "complement_frame_config": null,
                        "deflicker": null,
                        "gameplay_configs": [],
                        "motion_blur_config": null,
                        "noise_reduction": null,
                        "path": "",
                        "quality_enhance": null,
                        "time_range": null
                    },
                    "width": 1920
                }));

            info["materials"]["speeds"]
                .as_array_mut()
                .unwrap()
                .push(json!({
                    "curve_speed": null,
                    "id": speed_id,
                    "mode": 0,
                    "speed": 1.0,
                    "type": "speed"
                }));
            info["materials"]["canvases"]
                .as_array_mut()
                .unwrap()
                .push(json!({
                    "album_image": "",
                    "blur": 0.0,
                    "color": "",
                    "id": canvas_id,
                    "image": "",
                    "image_id": "",
                    "image_name": "",
                    "source_platform": 0,
                    "team_id": "",
                    "type": "canvas_color"
                }));
            info["materials"]["sound_channel_mappings"]
                .as_array_mut()
                .unwrap()
                .push(json!({
                    "audio_channel_mapping": 0,
                    "id": scm_id,
                    "is_config_open": false,
                    "type": ""
                }));
            info["materials"]["vocal_separations"]
                .as_array_mut()
                .unwrap()
                .push(json!({
                    "choice": 0,
                    "id": vs_id,
                    "production_path": "",
                    "time_range": null,
                    "type": "vocal_separation"
                }));

            let zoom = item
                .effect
                .as_ref()
                .and_then(|e| e.zoom)
                .unwrap_or(1.0)
                .max(0.05);
            let tx = item
                .effect
                .as_ref()
                .and_then(|e| e.pan_x)
                .map(|px| (px / (canvas_w / 2.0)).clamp(-2.0, 2.0))
                .unwrap_or(0.0);
            let ty = item
                .effect
                .as_ref()
                .and_then(|e| e.pan_y)
                .map(|py| (py / (canvas_h / 2.0)).clamp(-2.0, 2.0))
                .unwrap_or(0.0);
            let rot = item
                .effect
                .as_ref()
                .and_then(|e| e.rotation)
                .unwrap_or(0.0);

            let new_seg = json!({
                "cartoon": false,
                "clip": {
                    "alpha": 1.0,
                    "flip": { "horizontal": false, "vertical": false },
                    "rotation": rot,
                    "scale": { "x": zoom, "y": zoom },
                    "transform": { "x": tx, "y": ty }
                },
                "common_keyframes": [],
                "enable_adjust": true,
                "enable_color_correct_adjust": false,
                "enable_color_curves": true,
                "enable_color_match_adjust": false,
                "enable_color_wheels": true,
                "enable_lut": true,
                "enable_smart_color_adjust": false,
                "extra_material_refs": [speed_id, canvas_id, scm_id, vs_id],
                "group_id": "",
                "hdr_settings": { "intensity": 1.0, "mode": 1, "nits": 1000 },
                "id": new_id(),
                "intensifies_audio": false,
                "is_placeholder": false,
                "is_tone_modify": false,
                "keyframe_refs": [],
                "last_nonzero_volume": 1.0,
                "material_id": mat_id,
                "render_index": 0,
                "responsive_layout": {
                    "enable": false,
                    "horizontal_pos_layout": 0,
                    "size_layout": 0,
                    "target_follow": "",
                    "vertical_pos_layout": 0
                },
                "reverse": false,
                "source_timerange": { "duration": src_dur_us, "start": src_start_us },
                "speed": 1.0,
                "target_timerange": { "duration": rec_dur_us, "start": rec_start_us },
                "template_id": "",
                "template_scene": "default",
                "track_attribute": 0,
                "track_render_index": 0,
                "uniform_scale": { "on": true, "value": 1.0 },
                "visible": true,
                "volume": 1.0
            });

            let tracks_arr = info["tracks"].as_array_mut().unwrap();
            match effective_mode {
                "overlay" => {
                    let min_v = target_v_track.max(2);
                    let tr_idx = find_or_create_overlay_video_track(
                        tracks_arr,
                        min_v,
                        rec_start_us,
                        rec_start_us + rec_dur_us,
                    );
                    if let Some(segs) =
                        tracks_arr[tr_idx].get_mut("segments").and_then(|s| s.as_array_mut())
                    {
                        segs.push(new_seg);
                        sort_segments_by_start(segs);
                    }
                }
                "replace" => {
                    let tr_idx = ensure_video_track(tracks_arr, target_v_track);
                    if let Some(segs) =
                        tracks_arr[tr_idx].get_mut("segments").and_then(|s| s.as_array_mut())
                    {
                        replace_range_in_segments(segs, rec_start_us, rec_start_us + rec_dur_us);
                        segs.push(new_seg);
                        sort_segments_by_start(segs);
                    }
                }
                "insert" => {
                    let tr_idx = ensure_video_track(tracks_arr, target_v_track);
                    if let Some(segs) =
                        tracks_arr[tr_idx].get_mut("segments").and_then(|s| s.as_array_mut())
                    {
                        ripple_insert_in_segments(segs, rec_start_us, rec_dur_us);
                        segs.push(new_seg);
                        sort_segments_by_start(segs);
                    }
                }
                _ => {
                    let tr_idx = ensure_video_track(tracks_arr, target_v_track);
                    if let Some(segs) =
                        tracks_arr[tr_idx].get_mut("segments").and_then(|s| s.as_array_mut())
                    {
                        segs.push(new_seg);
                        sort_segments_by_start(segs);
                    }
                }
            }

            register_in_draft_meta(&draft.folder_path, &item.path, is_photo, mat_dur_us);
            appended += 1;
        }
    }

    // Recompute overall project duration across all tracks
    if let Some(tracks) = info.get("tracks").and_then(|v| v.as_array()) {
        for tr in tracks {
            if let Some(segs) = tr.get("segments").and_then(|s| s.as_array()) {
                for seg in segs {
                    let s = seg
                        .get("target_timerange")
                        .and_then(|r| r.get("start"))
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);
                    let d = seg
                        .get("target_timerange")
                        .and_then(|r| r.get("duration"))
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);
                    max_end_us = max_end_us.max(s + d);
                }
            }
        }
    }

    info["duration"] = json!(max_end_us);
    save_draft_json(&draft, &info, max_end_us)?;

    lines.push(format!(
        "Placed {}/{} clip(s) into CapCut project '{}'. Re-open the project in CapCut to view.",
        appended,
        spec.items.len(),
        draft.name
    ));

    Ok(CapCutBuildStoryboardResult {
        lines,
        appended,
        requested: spec.items.len(),
    })
}

fn default_still_or(src_in: Option<f64>, src_out: Option<f64>, fallback: f64) -> f64 {
    if let (Some(si), Some(so)) = (src_in, src_out) {
        if so > si {
            return so - si;
        }
    }
    fallback
}

fn new_empty_video_track() -> Value {
    json!({
        "attribute": 0,
        "flag": 0,
        "id": new_id(),
        "is_default_name": true,
        "name": "",
        "segments": [],
        "type": "video"
    })
}

fn get_video_track_end_us(tracks: &Value, target_v_track: usize) -> i64 {
    let Some(arr) = tracks.as_array() else {
        return 0;
    };
    let mut v_idx = 0usize;
    for tr in arr {
        if tr.get("type").and_then(|t| t.as_str()) == Some("video") {
            v_idx += 1;
            if v_idx == target_v_track {
                let mut max_end = 0i64;
                if let Some(segs) = tr.get("segments").and_then(|s| s.as_array()) {
                    for seg in segs {
                        let s = seg
                            .get("target_timerange")
                            .and_then(|r| r.get("start"))
                            .and_then(|v| v.as_i64())
                            .unwrap_or(0);
                        let d = seg
                            .get("target_timerange")
                            .and_then(|r| r.get("duration"))
                            .and_then(|v| v.as_i64())
                            .unwrap_or(0);
                        max_end = max_end.max(s + d);
                    }
                }
                return max_end;
            }
        }
    }
    0
}

fn ensure_video_track(tracks: &mut Vec<Value>, target_v_track: usize) -> usize {
    let mut v_count = 0usize;
    for (idx, tr) in tracks.iter().enumerate() {
        if tr.get("type").and_then(|t| t.as_str()) == Some("video") {
            v_count += 1;
            if v_count == target_v_track {
                return idx;
            }
        }
    }
    while v_count < target_v_track {
        tracks.push(new_empty_video_track());
        v_count += 1;
    }
    tracks.len() - 1
}

fn find_or_create_overlay_video_track(
    tracks: &mut Vec<Value>,
    min_v_track: usize,
    start_us: i64,
    end_us: i64,
) -> usize {
    // Ensure all preceding video tracks (e.g. V1) exist first
    if min_v_track > 1 {
        let _ = ensure_video_track(tracks, min_v_track - 1);
    }
    let mut v_idx = 0usize;
    for (idx, tr) in tracks.iter().enumerate() {
        if tr.get("type").and_then(|t| t.as_str()) == Some("video") {
            v_idx += 1;
            if v_idx >= min_v_track {
                let has_overlap = tr
                    .get("segments")
                    .and_then(|s| s.as_array())
                    .map(|segs| {
                        segs.iter().any(|seg| {
                            let s = seg
                                .get("target_timerange")
                                .and_then(|r| r.get("start"))
                                .and_then(|v| v.as_i64())
                                .unwrap_or(0);
                            let d = seg
                                .get("target_timerange")
                                .and_then(|r| r.get("duration"))
                                .and_then(|v| v.as_i64())
                                .unwrap_or(0);
                            (s + d) > start_us && s < end_us
                        })
                    })
                    .unwrap_or(false);
                if !has_overlap {
                    return idx;
                }
            }
        }
    }
    tracks.push(new_empty_video_track());
    tracks.len() - 1
}

fn sort_segments_by_start(segs: &mut Vec<Value>) {
    segs.sort_by_key(|seg| {
        seg.get("target_timerange")
            .and_then(|r| r.get("start"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0)
    });
}

fn replace_range_in_segments(segs: &mut Vec<Value>, w_start_us: i64, w_end_us: i64) {
    let old = std::mem::take(segs);
    for seg in old {
        let c_start = seg
            .get("target_timerange")
            .and_then(|r| r.get("start"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let c_dur = seg
            .get("target_timerange")
            .and_then(|r| r.get("duration"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let c_end = c_start + c_dur;
        let src_start = seg
            .get("source_timerange")
            .and_then(|r| r.get("start"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);

        if c_end <= w_start_us || c_start >= w_end_us {
            // No overlap
            segs.push(seg);
        } else if c_start >= w_start_us && c_end <= w_end_us {
            // Completely overwritten -> drop
        } else if c_start < w_start_us && c_end > w_end_us {
            // Split into left [c_start, w_start_us] and right [w_end_us, c_end]
            let left_dur = w_start_us - c_start;
            let right_dur = c_end - w_end_us;
            let right_offset = w_end_us - c_start;

            let mut left_seg = seg.clone();
            left_seg["target_timerange"]["duration"] = json!(left_dur);
            if left_seg["source_timerange"].is_object() {
                left_seg["source_timerange"]["duration"] = json!(left_dur);
            }

            let mut right_seg = seg;
            right_seg["id"] = json!(new_id());
            right_seg["target_timerange"]["start"] = json!(w_end_us);
            right_seg["target_timerange"]["duration"] = json!(right_dur);
            if right_seg["source_timerange"].is_object() {
                right_seg["source_timerange"]["start"] = json!(src_start + right_offset);
                right_seg["source_timerange"]["duration"] = json!(right_dur);
            }

            segs.push(left_seg);
            segs.push(right_seg);
        } else if c_start < w_start_us {
            // Trim right tail to w_start_us
            let left_dur = w_start_us - c_start;
            let mut trimmed = seg;
            trimmed["target_timerange"]["duration"] = json!(left_dur);
            if trimmed["source_timerange"].is_object() {
                trimmed["source_timerange"]["duration"] = json!(left_dur);
            }
            segs.push(trimmed);
        } else {
            // Trim left head to w_end_us
            let right_dur = c_end - w_end_us;
            let right_offset = w_end_us - c_start;
            let mut trimmed = seg;
            trimmed["target_timerange"]["start"] = json!(w_end_us);
            trimmed["target_timerange"]["duration"] = json!(right_dur);
            if trimmed["source_timerange"].is_object() {
                trimmed["source_timerange"]["start"] = json!(src_start + right_offset);
                trimmed["source_timerange"]["duration"] = json!(right_dur);
            }
            segs.push(trimmed);
        }
    }
}

fn ripple_insert_in_segments(segs: &mut Vec<Value>, cut_us: i64, ins_dur_us: i64) {
    let old = std::mem::take(segs);
    for mut seg in old {
        let c_start = seg
            .get("target_timerange")
            .and_then(|r| r.get("start"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let c_dur = seg
            .get("target_timerange")
            .and_then(|r| r.get("duration"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let c_end = c_start + c_dur;
        let src_start = seg
            .get("source_timerange")
            .and_then(|r| r.get("start"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);

        if c_end <= cut_us {
            segs.push(seg);
        } else if c_start < cut_us && c_end > cut_us {
            // Split at cut_us and ripple right piece by +ins_dur_us
            let left_dur = cut_us - c_start;
            let right_dur = c_end - cut_us;

            let mut left_seg = seg.clone();
            left_seg["target_timerange"]["duration"] = json!(left_dur);
            if left_seg["source_timerange"].is_object() {
                left_seg["source_timerange"]["duration"] = json!(left_dur);
            }

            seg["id"] = json!(new_id());
            seg["target_timerange"]["start"] = json!(cut_us + ins_dur_us);
            seg["target_timerange"]["duration"] = json!(right_dur);
            if seg["source_timerange"].is_object() {
                seg["source_timerange"]["start"] = json!(src_start + left_dur);
                seg["source_timerange"]["duration"] = json!(right_dur);
            }

            segs.push(left_seg);
            segs.push(seg);
        } else {
            // c_start >= cut_us -> shift right by +ins_dur_us
            seg["target_timerange"]["start"] = json!(c_start + ins_dur_us);
            segs.push(seg);
        }
    }
}
