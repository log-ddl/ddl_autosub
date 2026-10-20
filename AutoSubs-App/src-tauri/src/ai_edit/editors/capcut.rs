//! AI Edit backend for CapCut Desktop.
//!
//! CapCut has no scripting API, so every edit rewrites the draft JSON on disk
//! through the `capcut` module. Times there are microseconds; everything here
//! is seconds. The user reopens the project from CapCut Home to see changes.

use serde_json::{json, Value};

use crate::ai_edit::actions::{ActionOutcome, MarkerSpec, SegmentUpdate, StoryboardItem, TextSpec};
use crate::ai_edit::mcp::tools::{delete_tool, marker_tool, storyboard_tool, text_item, tool};
use crate::capcut::bridge::{append_text_track, capcut_get_status, save_draft_json, TextCue};
use crate::capcut::storyboard::{
    capcut_build_storyboard, CapCutBuildStoryboardSpec, CapCutStoryboardEffect, CapCutStoryboardItem,
};
use crate::capcut::timeline::{
    capcut_add_markers, capcut_delete_segment, capcut_get_timeline_snapshot, capcut_update_segment,
    CapCutMarkerInput, CapCutUpdateSegmentArgs,
};

pub async fn timeline_snapshot(draft: Option<String>) -> Result<Value, String> {
    let snap = capcut_get_timeline_snapshot(draft).await?;
    serde_json::to_value(snap).map_err(|e| e.to_string())
}

pub async fn build_storyboard(
    draft: Option<String>,
    mode: Option<String>,
    track: usize,
    audio_path: Option<String>,
    items: Vec<StoryboardItem>,
) -> Result<ActionOutcome, String> {
    let res = capcut_build_storyboard(CapCutBuildStoryboardSpec {
        preferred_draft_id: draft,
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
}

pub async fn add_markers(draft: Option<String>, markers: Vec<MarkerSpec>) -> Result<ActionOutcome, String> {
    let requested = markers.len();
    let mut lines = Vec::new();
    if markers.iter().any(|m| m.note.as_deref().is_some_and(|n| !n.trim().is_empty())) {
        lines.push("CapCut markers have no note field; notes were dropped (put them in the name).".into());
    }
    let res = capcut_add_markers(
        draft,
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
}

pub async fn add_text(
    draft: Option<String>,
    texts: Vec<TextSpec>,
    template: Option<String>,
) -> Result<ActionOutcome, String> {
    let count = texts.len();
    let status = capcut_get_status(draft).await?;
    let draft = status.active_draft.ok_or_else(|| "No CapCut project found.".to_string())?;
    let raw = std::fs::read_to_string(&draft.json_path)
        .map_err(|e| format!("Failed to read {}: {}", draft.json_path, e))?;
    let mut info: Value =
        serde_json::from_str(&raw).map_err(|e| format!("Failed to parse {}: {}", draft.json_path, e))?;
    let cues: Vec<TextCue> = texts
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
}

pub async fn update_segment(draft: Option<String>, u: SegmentUpdate) -> Result<ActionOutcome, String> {
    let mut outcome = ActionOutcome::ok("Updated the clip on the CapCut timeline.");
    if u.opacity.is_some() {
        outcome.lines.push("CapCut: opacity is not supported and was ignored.".into());
        outcome.partial = true;
    }
    capcut_update_segment(CapCutUpdateSegmentArgs {
        preferred_draft_id: draft,
        segment_id: u.segment_id,
        start_sec: u.start_sec,
        duration_sec: u.duration_sec,
        text: u.text,
        zoom: u.zoom,
        zoom_end: u.zoom_end,
        pan_x: u.pan_x,
        pan_x_end: u.pan_x_end,
        pan_y: u.pan_y,
        pan_y_end: u.pan_y_end,
        rotation: u.rotation,
        volume: u.volume,
    })
    .await?;
    Ok(outcome)
}

pub async fn delete_segments(draft: Option<String>, ids: Vec<String>) -> Result<ActionOutcome, String> {
    for id in &ids {
        capcut_delete_segment(draft.clone(), id.clone()).await?;
    }
    Ok(ActionOutcome::ok(format!("Deleted {} clip(s) from the CapCut timeline.", ids.len())))
}

// ---------------------------------------------------------------------------
// MCP tool schemas: what the agent is told CapCut can do
// ---------------------------------------------------------------------------

/// Extra clip fields `get_timeline` returns for CapCut.
pub const SNAPSHOT_FIELDS: &str = ", zoom, text, media path";

pub const MARKER_COLORS: &[&str] = &["Red", "Cyan"];

/// The edit tools, in the order the agent sees them.
pub fn edit_tools() -> Vec<Value> {
    vec![
        storyboard_tool("CapCut", ""),
        marker_tool(
            "Add markers to the CapCut timeline. CapCut has two colors (Red, Cyan) and no note field, so \
             put everything in name. A frame that already has a marker is skipped.",
            MARKER_COLORS,
            false,
        ),
        tool(
            "add_text",
            "Add on-screen text to CapCut as a new text track (white with a black outline, or yellow).",
            json!({
                "type": "object",
                "properties": {
                    "texts": { "type": "array", "items": text_item() },
                    "template": { "type": "string", "enum": ["White", "Yellow"] }
                },
                "required": ["texts"]
            }),
        ),
        tool(
            "update_clip",
            "Change a CapCut clip by id: move or retime it (startSec, durationSec), set zoom/pan/rotation, \
             animate them with zoomEnd/panXEnd/panYEnd (keyframes from clip start to end), set volume, \
             or replace the text of a text clip.",
            json!({
                "type": "object",
                "properties": {
                    "segmentId": { "type": "string" },
                    "startSec": { "type": "number" },
                    "durationSec": { "type": "number" },
                    "zoom": { "type": "number" }, "zoomEnd": { "type": "number" },
                    "panX": { "type": "number" }, "panXEnd": { "type": "number" },
                    "panY": { "type": "number" }, "panYEnd": { "type": "number" },
                    "rotation": { "type": "number" },
                    "volume": { "type": "number", "description": "1.0 = unchanged" },
                    "text": { "type": "string" }
                },
                "required": ["segmentId"]
            }),
        ),
        delete_tool("CapCut", false),
    ]
}
