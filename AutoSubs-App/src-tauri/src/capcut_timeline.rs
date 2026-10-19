//! CapCut Timeline Snapshot & Segment Editing API for AI Video Director (`AI EDIT`).

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::capcut_bridge::{
    capcut_get_status, new_id, save_draft_json, CapCutDraftSummary, US_PER_SEC,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapCutTimelineSegment {
    pub id: String,
    pub material_id: String,
    pub kind: String,
    pub name: String,
    pub media_path: String,
    pub text: String,
    pub start_sec: f64,
    pub duration_sec: f64,
    pub src_in_sec: f64,
    pub src_out_sec: f64,
    pub zoom: f64,
    pub pan_x: f64,
    pub pan_y: f64,
    pub rotation: f64,
    pub volume: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapCutTimelineTrack {
    pub id: String,
    pub name: String,
    pub track_type: String,
    pub segments: Vec<CapCutTimelineSegment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapCutTimelineSnapshot {
    pub draft_id: String,
    pub draft_name: String,
    pub folder_path: String,
    pub json_path: String,
    pub canvas_width: i64,
    pub canvas_height: i64,
    pub fps: f64,
    pub duration_sec: f64,
    pub tracks: Vec<CapCutTimelineTrack>,
}

fn parse_timeline_snapshot(draft: &CapCutDraftSummary, info: &Value) -> CapCutTimelineSnapshot {
    let fps = info.get("fps").and_then(|v| v.as_f64()).unwrap_or(30.0);
    let canvas_width = info
        .get("canvas_config")
        .and_then(|c| c.get("width"))
        .and_then(|v| v.as_i64())
        .unwrap_or(1920);
    let canvas_height = info
        .get("canvas_config")
        .and_then(|c| c.get("height"))
        .and_then(|v| v.as_i64())
        .unwrap_or(1080);

    let mut video_map = std::collections::HashMap::<String, (String, String, String)>::new();
    if let Some(videos) = info
        .get("materials")
        .and_then(|m| m.get("videos"))
        .and_then(|v| v.as_array())
    {
        for v in videos {
            let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let path = v.get("path").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let mtype = v.get("type").and_then(|x| x.as_str()).unwrap_or("video").to_string();
            let name = v
                .get("material_name")
                .and_then(|x| x.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| {
                    Path::new(&path)
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "Clip".to_string())
                });
            if !id.is_empty() {
                video_map.insert(id, (name, path, mtype));
            }
        }
    }

    let mut audio_map = std::collections::HashMap::<String, (String, String)>::new();
    if let Some(audios) = info
        .get("materials")
        .and_then(|m| m.get("audios"))
        .and_then(|v| v.as_array())
    {
        for a in audios {
            let id = a.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let path = a.get("path").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let name = a
                .get("name")
                .and_then(|x| x.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| {
                    Path::new(&path)
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "Audio".to_string())
                });
            if !id.is_empty() {
                audio_map.insert(id, (name, path));
            }
        }
    }

    let mut text_map = std::collections::HashMap::<String, String>::new();
    if let Some(texts) = info
        .get("materials")
        .and_then(|m| m.get("texts"))
        .and_then(|v| v.as_array())
    {
        for t in texts {
            let id = t.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let raw_content = t.get("content").and_then(|x| x.as_str()).unwrap_or("");
            let parsed_text = serde_json::from_str::<Value>(raw_content)
                .ok()
                .and_then(|val| val.get("text").and_then(|s| s.as_str()).map(|s| s.to_string()))
                .unwrap_or_else(|| raw_content.to_string());
            if !id.is_empty() {
                text_map.insert(id, parsed_text);
            }
        }
    }

    let mut tracks_out = Vec::new();
    let mut max_end_sec =
        (info.get("duration").and_then(|v| v.as_i64()).unwrap_or(0) as f64) / US_PER_SEC;

    let mut v_idx = 0usize;
    let mut a_idx = 0usize;
    let mut t_idx = 0usize;

    if let Some(tracks) = info.get("tracks").and_then(|v| v.as_array()) {
        for tr in tracks {
            let track_id = tr.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let track_type = tr
                .get("type")
                .and_then(|x| x.as_str())
                .unwrap_or("video")
                .to_string();
            let track_name = match track_type.as_str() {
                "video" => {
                    v_idx += 1;
                    if v_idx == 1 {
                        "V1 · Main Video".to_string()
                    } else {
                        format!("V{} · Overlay", v_idx)
                    }
                }
                "audio" => {
                    a_idx += 1;
                    format!("A{} · Audio", a_idx)
                }
                "text" => {
                    t_idx += 1;
                    format!("T{} · Subtitles / Text", t_idx)
                }
                other => format!("Track ({})", other),
            };

            let mut segs_out = Vec::new();
            if let Some(segs) = tr.get("segments").and_then(|s| s.as_array()) {
                for seg in segs {
                    let seg_id = seg.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    let mat_id = seg
                        .get("material_id")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let start_us = seg
                        .get("target_timerange")
                        .and_then(|r| r.get("start"))
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);
                    let dur_us = seg
                        .get("target_timerange")
                        .and_then(|r| r.get("duration"))
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);
                    let src_start_us = seg
                        .get("source_timerange")
                        .and_then(|r| r.get("start"))
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);
                    let src_dur_us = seg
                        .get("source_timerange")
                        .and_then(|r| r.get("duration"))
                        .and_then(|v| v.as_i64())
                        .unwrap_or(dur_us);

                    let start_sec = (start_us as f64) / US_PER_SEC;
                    let duration_sec = (dur_us as f64) / US_PER_SEC;
                    let src_in_sec = (src_start_us as f64) / US_PER_SEC;
                    let src_out_sec = ((src_start_us + src_dur_us) as f64) / US_PER_SEC;
                    if start_sec + duration_sec > max_end_sec {
                        max_end_sec = start_sec + duration_sec;
                    }

                    let zoom = seg
                        .get("clip")
                        .and_then(|c| c.get("scale"))
                        .and_then(|s| s.get("x"))
                        .and_then(|v| v.as_f64())
                        .unwrap_or(1.0);
                    let pan_x = seg
                        .get("clip")
                        .and_then(|c| c.get("transform"))
                        .and_then(|t| t.get("x"))
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.0);
                    let pan_y = seg
                        .get("clip")
                        .and_then(|c| c.get("transform"))
                        .and_then(|t| t.get("y"))
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.0);
                    let rotation = seg
                        .get("clip")
                        .and_then(|c| c.get("rotation"))
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.0);
                    let volume = seg.get("volume").and_then(|v| v.as_f64()).unwrap_or(1.0);

                    let (kind, name, media_path, text) = if track_type == "video" {
                        if let Some((n, p, mtype)) = video_map.get(&mat_id) {
                            (
                                if mtype == "photo" {
                                    "photo".to_string()
                                } else {
                                    "video".to_string()
                                },
                                n.clone(),
                                p.clone(),
                                String::new(),
                            )
                        } else {
                            (
                                "video".to_string(),
                                "Video Clip".to_string(),
                                String::new(),
                                String::new(),
                            )
                        }
                    } else if track_type == "audio" {
                        if let Some((n, p)) = audio_map.get(&mat_id) {
                            ("audio".to_string(), n.clone(), p.clone(), String::new())
                        } else {
                            (
                                "audio".to_string(),
                                "Audio Clip".to_string(),
                                String::new(),
                                String::new(),
                            )
                        }
                    } else if track_type == "text" {
                        let txt = text_map
                            .get(&mat_id)
                            .cloned()
                            .unwrap_or_else(|| "Subtitle".to_string());
                        ("text".to_string(), txt.clone(), String::new(), txt)
                    } else {
                        (
                            track_type.clone(),
                            "Item".to_string(),
                            String::new(),
                            String::new(),
                        )
                    };

                    segs_out.push(CapCutTimelineSegment {
                        id: seg_id,
                        material_id: mat_id,
                        kind,
                        name,
                        media_path,
                        text,
                        start_sec,
                        duration_sec,
                        src_in_sec,
                        src_out_sec,
                        zoom,
                        pan_x,
                        pan_y,
                        rotation,
                        volume,
                    });
                }
            }

            tracks_out.push(CapCutTimelineTrack {
                id: track_id,
                name: track_name,
                track_type,
                segments: segs_out,
            });
        }
    }

    CapCutTimelineSnapshot {
        draft_id: draft.id.clone(),
        draft_name: draft.name.clone(),
        folder_path: draft.folder_path.clone(),
        json_path: draft.json_path.clone(),
        canvas_width,
        canvas_height,
        fps,
        duration_sec: max_end_sec,
        tracks: tracks_out,
    }
}

#[tauri::command]
pub async fn capcut_get_timeline_snapshot(
    preferred_draft_id: Option<String>,
) -> Result<CapCutTimelineSnapshot, String> {
    let status = capcut_get_status(preferred_draft_id).await?;
    let draft = status
        .active_draft
        .ok_or_else(|| "No CapCut project found.".to_string())?;
    let text = fs::read_to_string(&draft.json_path)
        .map_err(|e| format!("Failed to read {}: {}", draft.json_path, e))?;
    let info: Value = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse {}: {}", draft.json_path, e))?;
    Ok(parse_timeline_snapshot(&draft, &info))
}

#[tauri::command]
pub async fn capcut_delete_segment(
    preferred_draft_id: Option<String>,
    segment_id: String,
) -> Result<CapCutTimelineSnapshot, String> {
    let status = capcut_get_status(preferred_draft_id).await?;
    let draft = status
        .active_draft
        .ok_or_else(|| "No CapCut project found.".to_string())?;
    let text = fs::read_to_string(&draft.json_path)
        .map_err(|e| format!("Failed to read {}: {}", draft.json_path, e))?;
    let mut info: Value = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse {}: {}", draft.json_path, e))?;

    let mut max_end_us: i64 = 0;
    if let Some(tracks) = info.get_mut("tracks").and_then(|v| v.as_array_mut()) {
        for tr in tracks.iter_mut() {
            if let Some(segs) = tr.get_mut("segments").and_then(|s| s.as_array_mut()) {
                segs.retain(|seg| {
                    seg.get("id").and_then(|x| x.as_str()) != Some(segment_id.as_str())
                });
                for seg in segs.iter() {
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
    Ok(parse_timeline_snapshot(&draft, &info))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapCutUpdateSegmentArgs {
    pub preferred_draft_id: Option<String>,
    pub segment_id: String,
    pub start_sec: Option<f64>,
    pub duration_sec: Option<f64>,
    pub text: Option<String>,
    pub zoom: Option<f64>,
    pub zoom_end: Option<f64>,
    pub pan_x: Option<f64>,
    pub pan_x_end: Option<f64>,
    pub pan_y: Option<f64>,
    pub pan_y_end: Option<f64>,
    pub rotation: Option<f64>,
    pub volume: Option<f64>,
}

fn build_kf_entry(prop: &str, v0: f64, v1: f64, last_offset_us: i64) -> Value {
    json!({
        "id": new_id(),
        "material_id": "",
        "property_type": prop,
        "keyframe_list": [
            {
                "id": new_id(),
                "curveType": "Line",
                "time_offset": 0,
                "left_control": { "x": 0.0, "y": 0.0 },
                "right_control": { "x": 0.0, "y": 0.0 },
                "values": [v0],
                "string_value": "",
                "graphID": ""
            },
            {
                "id": new_id(),
                "curveType": "Line",
                "time_offset": last_offset_us.max(1000),
                "left_control": { "x": 0.0, "y": 0.0 },
                "right_control": { "x": 0.0, "y": 0.0 },
                "values": [v1],
                "string_value": "",
                "graphID": ""
            }
        ]
    })
}

#[tauri::command]
pub async fn capcut_update_segment(
    args: CapCutUpdateSegmentArgs,
) -> Result<CapCutTimelineSnapshot, String> {
    let status = capcut_get_status(args.preferred_draft_id).await?;
    let draft = status
        .active_draft
        .ok_or_else(|| "No CapCut project found.".to_string())?;
    let text = fs::read_to_string(&draft.json_path)
        .map_err(|e| format!("Failed to read {}: {}", draft.json_path, e))?;
    let mut info: Value = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse {}: {}", draft.json_path, e))?;

    let mut target_material_id: Option<String> = None;
    let mut max_end_us: i64 = 0;

    if let Some(tracks) = info.get_mut("tracks").and_then(|v| v.as_array_mut()) {
        for tr in tracks.iter_mut() {
            if let Some(segs) = tr.get_mut("segments").and_then(|s| s.as_array_mut()) {
                for seg in segs.iter_mut() {
                    if seg.get("id").and_then(|x| x.as_str()) == Some(args.segment_id.as_str()) {
                        target_material_id = seg
                            .get("material_id")
                            .and_then(|x| x.as_str())
                            .map(|s| s.to_string());
                        if let Some(start_sec) = args.start_sec {
                            seg["target_timerange"]["start"] =
                                json!((start_sec.max(0.0) * US_PER_SEC).round() as i64);
                        }
                        if let Some(dur_sec) = args.duration_sec {
                            let d_us = (dur_sec.max(0.1) * US_PER_SEC).round() as i64;
                            seg["target_timerange"]["duration"] = json!(d_us);
                            if seg
                                .get("source_timerange")
                                .map(|v| !v.is_null())
                                .unwrap_or(false)
                            {
                                seg["source_timerange"]["duration"] = json!(d_us);
                            }
                        }
                        if let Some(zoom) = args.zoom {
                            seg["clip"]["scale"]["x"] = json!(zoom);
                            seg["clip"]["scale"]["y"] = json!(zoom);
                        }
                        if let Some(px) = args.pan_x {
                            seg["clip"]["transform"]["x"] = json!(px);
                        }
                        if let Some(py) = args.pan_y {
                            seg["clip"]["transform"]["y"] = json!(py);
                        }
                        if let Some(rot) = args.rotation {
                            seg["clip"]["rotation"] = json!(rot);
                        }
                        if let Some(vol) = args.volume {
                            seg["volume"] = json!(vol);
                        }

                        // Support dynamic keyframes (zoom -> zoomEnd, panX -> panXEnd, panY -> panYEnd)
                        if args.zoom_end.is_some()
                            || args.pan_x_end.is_some()
                            || args.pan_y_end.is_some()
                        {
                            let dur_us = seg
                                .get("target_timerange")
                                .and_then(|r| r.get("duration"))
                                .and_then(|v| v.as_i64())
                                .unwrap_or(3_000_000);
                            let last_us = (dur_us - 33_333).max(1_000);
                            let z0 = args.zoom.unwrap_or_else(|| {
                                seg.get("clip")
                                    .and_then(|c| c.get("scale"))
                                    .and_then(|s| s.get("x"))
                                    .and_then(|v| v.as_f64())
                                    .unwrap_or(1.0)
                            });
                            let z1 = args.zoom_end.unwrap_or(z0);
                            let px0 = args.pan_x.unwrap_or_else(|| {
                                seg.get("clip")
                                    .and_then(|c| c.get("transform"))
                                    .and_then(|t| t.get("x"))
                                    .and_then(|v| v.as_f64())
                                    .unwrap_or(0.0)
                            });
                            let px1 = args.pan_x_end.unwrap_or(px0);
                            let py0 = args.pan_y.unwrap_or_else(|| {
                                seg.get("clip")
                                    .and_then(|c| c.get("transform"))
                                    .and_then(|t| t.get("y"))
                                    .and_then(|v| v.as_f64())
                                    .unwrap_or(0.0)
                            });
                            let py1 = args.pan_y_end.unwrap_or(py0);
                            let rot = args.rotation.unwrap_or_else(|| {
                                seg.get("clip")
                                    .and_then(|c| c.get("rotation"))
                                    .and_then(|v| v.as_f64())
                                    .unwrap_or(0.0)
                            });

                            seg["uniform_scale"] = json!({ "on": true, "value": 1.0 });
                            seg["common_keyframes"] = json!([
                                build_kf_entry("KFTypePositionX", px0, px1, last_us),
                                build_kf_entry("KFTypePositionY", py0, py1, last_us),
                                build_kf_entry("KFTypeScaleX", z0, z1, last_us),
                                build_kf_entry("KFTypeRotation", rot, rot, last_us)
                            ]);
                        }
                    }

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

    if let (Some(mat_id), Some(new_text)) = (target_material_id, args.text) {
        if let Some(texts) = info
            .get_mut("materials")
            .and_then(|m| m.get_mut("texts"))
            .and_then(|v| v.as_array_mut())
        {
            for t in texts.iter_mut() {
                if t.get("id").and_then(|x| x.as_str()) == Some(mat_id.as_str()) {
                    let raw = t.get("content").and_then(|x| x.as_str()).unwrap_or("{}");
                    let mut content_val =
                        serde_json::from_str::<Value>(raw).unwrap_or_else(|_| json!({}));
                    content_val["text"] = json!(new_text);
                    t["content"] = json!(content_val.to_string());
                }
            }
        }
    }

    info["duration"] = json!(max_end_us);
    save_draft_json(&draft, &info, max_end_us)?;
    Ok(parse_timeline_snapshot(&draft, &info))
}
