//! Timeline edits the AI Edit tab can make, for DaVinci Resolve and CapCut.
//!
//! This is the single place a timeline action runs, whether it came from the
//! MCP server (the agent calling a tool) or from the UI (the user clicking an
//! action card). Every action reports a plain-text outcome so the agent can
//! see what happened and correct itself.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::capcut::bridge::{append_text_track, capcut_get_status, save_draft_json, TextCue};
use crate::capcut::storyboard::{
    capcut_build_storyboard, CapCutBuildStoryboardSpec, CapCutStoryboardEffect, CapCutStoryboardItem,
};
use crate::capcut::timeline::{
    capcut_add_markers, capcut_delete_segment, capcut_get_timeline_snapshot, capcut_update_segment,
    CapCutMarkerInput, CapCutUpdateSegmentArgs,
};
use crate::resolve_bridge::send_resolve_payload;

/// Which editor and project an AI Edit conversation works on.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditTarget {
    /// "davinci" or "capcut".
    pub integration: String,
    /// CapCut draft id; ignored for DaVinci, which always edits the open timeline.
    pub draft_id: Option<String>,
}

impl EditTarget {
    fn is_capcut(&self) -> bool {
        self.integration == "capcut"
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Effect {
    pub zoom: Option<f64>,
    pub pan_x: Option<f64>,
    pub pan_y: Option<f64>,
    pub rotation: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryboardItem {
    pub path: String,
    pub start: f64,
    pub end: Option<f64>,
    pub src_in: Option<f64>,
    pub src_out: Option<f64>,
    pub effect: Option<Effect>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkerSpec {
    pub at_sec: f64,
    pub color: Option<String>,
    pub name: Option<String>,
    pub note: Option<String>,
    pub duration_sec: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSpec {
    pub text: String,
    pub start: f64,
    pub end: f64,
}

/// One timeline edit. The JSON shape is what the agent writes, both as MCP
/// tool arguments and in ```timeline-action blocks.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum TimelineAction {
    #[serde(rename_all = "camelCase")]
    BuildStoryboard {
        mode: Option<String>,
        target_video_track: Option<usize>,
        audio_path: Option<String>,
        #[serde(default)]
        items: Vec<StoryboardItem>,
    },
    #[serde(rename_all = "camelCase")]
    AddMarker { markers: Vec<MarkerSpec> },
    #[serde(rename_all = "camelCase")]
    AddText {
        texts: Vec<TextSpec>,
        /// DaVinci: a Text+ title in the media pool ("AutoSubs Caption" for the
        /// animated captions). CapCut: "Yellow" for yellow text, else white.
        template: Option<String>,
        /// DaVinci video track for the text ("0" or omitted = a new track).
        track: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    UpdateSegment {
        segment_id: String,
        start_sec: Option<f64>,
        duration_sec: Option<f64>,
        zoom: Option<f64>,
        zoom_end: Option<f64>,
        pan_x: Option<f64>,
        pan_x_end: Option<f64>,
        pan_y: Option<f64>,
        pan_y_end: Option<f64>,
        rotation: Option<f64>,
        opacity: Option<f64>,
        volume: Option<f64>,
        text: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    DeleteSegment {
        segment_id: Option<String>,
        #[serde(default)]
        segment_ids: Vec<String>,
        /// DaVinci only: close the gap the clips leave behind.
        #[serde(default)]
        ripple: bool,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionOutcome {
    /// One-line result for a toast or the agent.
    pub message: String,
    /// Per-item details (skipped markers, unsupported fields, ...).
    pub lines: Vec<String>,
    /// True when part of the action was not applied.
    pub partial: bool,
}

impl ActionOutcome {
    fn ok(message: impl Into<String>) -> Self {
        Self { message: message.into(), lines: Vec::new(), partial: false }
    }
}

const RESOLVE_TIMEOUT: Duration = Duration::from_secs(300);

/// Send one request to the Lua server and fail on its `{ error, detail }` reply.
async fn call_resolve(payload: Value) -> Result<Value, String> {
    let func = payload.get("func").and_then(|f| f.as_str()).unwrap_or("").to_string();
    let text = send_resolve_payload(payload, RESOLVE_TIMEOUT).await?;
    let value: Value = if text.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(&text).map_err(|e| format!("Invalid reply from Resolve ({}): {}", func, e))?
    };
    // AddSubtitles nests its own result one level down.
    for v in [Some(&value), value.get("result")].into_iter().flatten() {
        if let Some(err) = v.get("error").filter(|e| !e.is_null() && *e != &json!(false)) {
            let short = err
                .as_str()
                .map(str::to_string)
                .or_else(|| v.get("message").and_then(|m| m.as_str()).map(str::to_string))
                .unwrap_or_else(|| "Resolve reported an error".into());
            let detail = v.get("detail").and_then(|d| d.as_str()).unwrap_or("");
            return Err(if detail.is_empty() { short } else { format!("{}: {}", short, detail) });
        }
    }
    Ok(value)
}

fn string_lines(v: &Value) -> Vec<String> {
    v.get("lines")
        .and_then(|l| l.as_array())
        .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

/// The current timeline as JSON: tracks with their clips (id, name, start and
/// duration in seconds) and markers.
pub async fn timeline_snapshot(target: &EditTarget) -> Result<Value, String> {
    if target.is_capcut() {
        let snap = capcut_get_timeline_snapshot(target.draft_id.clone()).await?;
        serde_json::to_value(snap).map_err(|e| e.to_string())
    } else {
        call_resolve(json!({ "func": "GetTimelineSnapshot" })).await
    }
}

pub async fn execute(target: &EditTarget, action: TimelineAction) -> Result<ActionOutcome, String> {
    match action {
        TimelineAction::BuildStoryboard { mode, target_video_track, audio_path, items } => {
            build_storyboard(target, mode, target_video_track.unwrap_or(1).max(1), audio_path, items).await
        }
        TimelineAction::AddMarker { markers } => add_markers(target, markers).await,
        TimelineAction::AddText { texts, template, track } => add_text(target, texts, template, track).await,
        TimelineAction::UpdateSegment {
            segment_id, start_sec, duration_sec, zoom, zoom_end, pan_x, pan_x_end, pan_y, pan_y_end,
            rotation, opacity, volume, text,
        } => {
            if target.is_capcut() {
                let mut outcome = ActionOutcome::ok("Updated the clip on the CapCut timeline.");
                if opacity.is_some() {
                    outcome.lines.push("CapCut: opacity is not supported and was ignored.".into());
                    outcome.partial = true;
                }
                capcut_update_segment(CapCutUpdateSegmentArgs {
                    preferred_draft_id: target.draft_id.clone(),
                    segment_id,
                    start_sec,
                    duration_sec,
                    text,
                    zoom,
                    zoom_end,
                    pan_x,
                    pan_x_end,
                    pan_y,
                    pan_y_end,
                    rotation,
                    volume,
                })
                .await?;
                Ok(outcome)
            } else {
                let mut ignored = Vec::new();
                for (name, given) in [
                    ("startSec", start_sec.is_some()),
                    ("durationSec", duration_sec.is_some()),
                    ("zoomEnd", zoom_end.is_some()),
                    ("panXEnd", pan_x_end.is_some()),
                    ("panYEnd", pan_y_end.is_some()),
                    ("volume", volume.is_some()),
                ] {
                    if given {
                        ignored.push(name);
                    }
                }
                let reply = call_resolve(json!({
                    "func": "UpdateClip",
                    "id": segment_id,
                    "zoom": zoom,
                    "panX": pan_x,
                    "panY": pan_y,
                    "rotation": rotation,
                    "opacity": opacity,
                    "text": text,
                }))
                .await?;
                let changed = reply
                    .get("updated")
                    .and_then(|u| u.as_array())
                    .map(|a| a.iter().filter_map(|s| s.as_str()).collect::<Vec<_>>().join(", "))
                    .unwrap_or_default();
                let mut outcome = ActionOutcome::ok(format!("Updated the clip in Resolve ({}).", changed));
                if !ignored.is_empty() {
                    outcome.partial = true;
                    outcome.lines.push(format!(
                        "Resolve's scripting API cannot change {}; those were ignored.",
                        ignored.join(", ")
                    ));
                }
                Ok(outcome)
            }
        }
        TimelineAction::DeleteSegment { segment_id, mut segment_ids, ripple } => {
            if let Some(id) = segment_id {
                segment_ids.insert(0, id);
            }
            if segment_ids.is_empty() {
                return Err("delete_segment needs segmentId or segmentIds.".into());
            }
            if target.is_capcut() {
                for id in &segment_ids {
                    capcut_delete_segment(target.draft_id.clone(), id.clone()).await?;
                }
                Ok(ActionOutcome::ok(format!("Deleted {} clip(s) from the CapCut timeline.", segment_ids.len())))
            } else {
                let reply = call_resolve(json!({ "func": "DeleteClips", "ids": segment_ids, "ripple": ripple })).await?;
                let deleted = reply.get("deleted").and_then(|v| v.as_u64()).unwrap_or(0);
                let missing = reply.get("missing").and_then(|v| v.as_u64()).unwrap_or(0);
                let mut outcome = ActionOutcome::ok(format!("Deleted {} clip(s) in Resolve.", deleted));
                if missing > 0 {
                    outcome.partial = true;
                    outcome.lines.push(format!("{} clip id(s) were not on the timeline.", missing));
                }
                Ok(outcome)
            }
        }
    }
}

async fn build_storyboard(
    target: &EditTarget,
    mode: Option<String>,
    track: usize,
    audio_path: Option<String>,
    items: Vec<StoryboardItem>,
) -> Result<ActionOutcome, String> {
    if target.is_capcut() {
        let res = capcut_build_storyboard(CapCutBuildStoryboardSpec {
            preferred_draft_id: target.draft_id.clone(),
            target_video_track: Some(track),
            mode,
            default_still_secs: Some(3.0),
            audio_path,
            items: items
                .into_iter()
                .map(|it| CapCutStoryboardItem {
                    path: it.path,
                    start: it.start,
                    end: it.end,
                    src_in: it.src_in,
                    src_out: it.src_out,
                    effect: it.effect.map(|e| CapCutStoryboardEffect {
                        zoom: e.zoom,
                        pan_x: e.pan_x,
                        pan_y: e.pan_y,
                        rotation: e.rotation,
                    }),
                })
                .collect(),
        })
        .await?;
        Ok(ActionOutcome {
            message: format!("Placed {}/{} clip(s) on CapCut track V{}.", res.appended, res.requested, track),
            partial: res.appended < res.requested,
            lines: res.lines,
        })
    } else {
        let spec_items: Vec<Value> = items
            .iter()
            .map(|it| {
                json!({
                    "path": it.path,
                    "start": it.start,
                    "end": it.end,
                    "src_in": it.src_in,
                    "src_out": it.src_out,
                    "effect": it.effect.as_ref().map(|e| json!({
                        "zoom": e.zoom, "pan_x": e.pan_x, "pan_y": e.pan_y, "rotation": e.rotation,
                    })),
                })
            })
            .collect();
        let reply = call_resolve(json!({
            "func": "BuildStoryboard",
            "spec": {
                "target_video_track": track,
                "mode": mode,
                "default_still_secs": 3,
                "audio_path": audio_path,
                "items": spec_items,
            },
        }))
        .await?;
        let appended = reply.get("appended").and_then(|v| v.as_u64()).unwrap_or(0);
        let requested = reply.get("requested").and_then(|v| v.as_u64()).unwrap_or(items.len() as u64);
        Ok(ActionOutcome {
            message: format!("Placed {}/{} clip(s) on Resolve track V{}.", appended, requested, track),
            partial: appended < requested,
            lines: string_lines(&reply),
        })
    }
}

async fn add_markers(target: &EditTarget, markers: Vec<MarkerSpec>) -> Result<ActionOutcome, String> {
    if markers.is_empty() {
        return Err("add_marker needs at least one marker.".into());
    }
    let requested = markers.len();
    if target.is_capcut() {
        let mut lines = Vec::new();
        if markers.iter().any(|m| m.note.as_deref().is_some_and(|n| !n.trim().is_empty())) {
            lines.push("CapCut markers have no note field; notes were dropped (put them in the name).".into());
        }
        let res = capcut_add_markers(
            target.draft_id.clone(),
            markers
                .into_iter()
                .map(|m| CapCutMarkerInput {
                    at_sec: m.at_sec,
                    color: m.color,
                    name: m.name,
                    duration_sec: m.duration_sec,
                })
                .collect(),
        )
        .await?;
        if res.skipped > 0 {
            lines.push(format!("{} marker(s) skipped: invalid time or a marker already on that frame.", res.skipped));
        }
        Ok(ActionOutcome {
            message: format!("Added {}/{} marker(s) on the CapCut timeline.", res.added, requested),
            partial: res.added < requested || !lines.is_empty(),
            lines,
        })
    } else {
        let payload: Vec<Value> = markers
            .iter()
            .map(|m| {
                json!({
                    "atSec": m.at_sec, "color": m.color, "name": m.name,
                    "note": m.note, "durationSec": m.duration_sec,
                })
            })
            .collect();
        let reply = call_resolve(json!({ "func": "AddMarkers", "markers": payload })).await?;
        let added = reply.get("added").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        Ok(ActionOutcome {
            message: format!("Added {}/{} marker(s) in Resolve.", added, requested),
            partial: added < requested,
            lines: string_lines(&reply),
        })
    }
}

/// Split `text` into words spread evenly over [start, end], for caption
/// templates that animate word by word.
fn even_words(text: &str, start: f64, end: f64) -> Vec<Value> {
    let words: Vec<&str> = text.split_whitespace().collect();
    let step = if words.is_empty() { 0.0 } else { (end - start) / words.len() as f64 };
    words
        .iter()
        .enumerate()
        .map(|(i, w)| {
            json!({ "word": w, "start": start + step * i as f64, "end": start + step * (i + 1) as f64 })
        })
        .collect()
}

async fn add_text(
    target: &EditTarget,
    texts: Vec<TextSpec>,
    template: Option<String>,
    track: Option<String>,
) -> Result<ActionOutcome, String> {
    let valid: Vec<TextSpec> = texts
        .into_iter()
        .filter(|t| !t.text.trim().is_empty() && t.end > t.start && t.start >= 0.0)
        .collect();
    if valid.is_empty() {
        return Err("add_text needs at least one text with a non-empty string and end > start >= 0.".into());
    }
    let count = valid.len();

    if target.is_capcut() {
        let status = capcut_get_status(target.draft_id.clone()).await?;
        let draft = status.active_draft.ok_or_else(|| "No CapCut project found.".to_string())?;
        let raw = std::fs::read_to_string(&draft.json_path)
            .map_err(|e| format!("Failed to read {}: {}", draft.json_path, e))?;
        let mut info: Value =
            serde_json::from_str(&raw).map_err(|e| format!("Failed to parse {}: {}", draft.json_path, e))?;
        let cues: Vec<TextCue> = valid
            .into_iter()
            .map(|t| TextCue { start_sec: t.start, end_sec: t.end, text: t.text })
            .collect();
        let added = append_text_track(&mut info, &cues, template.as_deref());
        let duration_us = info.get("duration").and_then(|v| v.as_i64()).unwrap_or(0);
        save_draft_json(&draft, &info, duration_us)?;
        Ok(ActionOutcome {
            message: format!("Added {}/{} text clip(s) on a new CapCut text track.", added, count),
            partial: added < count,
            lines: Vec::new(),
        })
    } else {
        let segments: Vec<Value> = valid
            .iter()
            .map(|t| {
                json!({
                    "start": t.start,
                    "end": t.end,
                    "text": t.text,
                    "words": even_words(&t.text, t.start, t.end),
                })
            })
            .collect();
        let template = template.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| "Default Template".into());
        call_resolve(json!({
            "func": "AddSubtitles",
            "templateName": template,
            "trackIndex": track.unwrap_or_else(|| "0".into()),
            "conflictMode": Value::Null,
            "subtitleData": {
                "transcriptId": format!("ai-edit-{}", uuid::Uuid::new_v4()),
                "segments": segments,
                "originalSegments": segments,
                "speakers": [],
            },
        }))
        .await?;
        Ok(ActionOutcome::ok(format!("Added {} text clip(s) in Resolve using '{}'.", count, template)))
    }
}

#[tauri::command]
pub async fn ai_edit_execute_action(target: EditTarget, action: Value) -> Result<ActionOutcome, String> {
    let action: TimelineAction =
        serde_json::from_value(action).map_err(|e| format!("Invalid timeline action: {}", e))?;
    execute(&target, action).await
}

#[tauri::command]
pub async fn ai_edit_get_timeline(target: EditTarget) -> Result<Value, String> {
    timeline_snapshot(&target).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(v: Value) -> TimelineAction {
        serde_json::from_value(v).expect("action should parse")
    }

    // The shapes below are the examples the AI Edit prompt teaches the agent.
    #[test]
    fn parses_prompt_examples() {
        match parse(json!({
            "action": "build_storyboard", "summary": "x", "mode": "replace", "targetVideoTrack": 1,
            "audioPath": "/a.mp3",
            "items": [{ "path": "/v.mp4", "start": 120, "end": 135, "srcIn": 0, "srcOut": 15,
                        "effect": { "zoom": 1.0 } }]
        })) {
            TimelineAction::BuildStoryboard { target_video_track, items, .. } => {
                assert_eq!(target_video_track, Some(1));
                assert_eq!(items[0].src_out, Some(15.0));
            }
            other => panic!("{:?}", other),
        }
        match parse(json!({
            "action": "add_marker",
            "markers": [{ "atSec": 12.5, "color": "Red", "name": "B-roll", "note": "xe" }, { "atSec": 45 }]
        })) {
            TimelineAction::AddMarker { markers } => assert_eq!(markers[1].at_sec, 45.0),
            other => panic!("{:?}", other),
        }
        match parse(json!({
            "action": "add_text", "template": "Yellow",
            "texts": [{ "text": "Hi", "start": 0, "end": 3 }]
        })) {
            TimelineAction::AddText { texts, template, track } => {
                assert_eq!(texts[0].end, 3.0);
                assert_eq!(template.as_deref(), Some("Yellow"));
                assert!(track.is_none());
            }
            other => panic!("{:?}", other),
        }
        match parse(json!({ "action": "update_segment", "segmentId": "s1", "zoom": 1.0, "zoomEnd": 2.0 })) {
            TimelineAction::UpdateSegment { segment_id, zoom_end, .. } => {
                assert_eq!(segment_id, "s1");
                assert_eq!(zoom_end, Some(2.0));
            }
            other => panic!("{:?}", other),
        }
        match parse(json!({ "action": "delete_segment", "segmentIds": ["a", "b"], "ripple": true })) {
            TimelineAction::DeleteSegment { segment_ids, ripple, .. } => {
                assert_eq!(segment_ids.len(), 2);
                assert!(ripple);
            }
            other => panic!("{:?}", other),
        }
    }

    #[test]
    fn rejects_unknown_action() {
        assert!(serde_json::from_value::<TimelineAction>(json!({ "action": "explode" })).is_err());
    }

    #[test]
    fn spreads_words_over_the_cue() {
        let words = even_words("a b", 1.0, 3.0);
        assert_eq!(words[0]["end"], json!(2.0));
        assert_eq!(words[1]["start"], json!(2.0));
        assert_eq!(words[1]["end"], json!(3.0));
    }
}
