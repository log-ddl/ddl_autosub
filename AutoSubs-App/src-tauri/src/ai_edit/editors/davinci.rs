//! AI Edit backend for DaVinci Resolve.
//!
//! Every edit is one request to the Lua loop running inside Resolve (handlers
//! in `resources/modules/ai_edit.lua`), sent through the file mailbox in
//! `resolve_bridge`. Resolve always edits the timeline that is open.

use std::time::Duration;

use serde_json::{json, Value};

use crate::ai_edit::actions::{ActionOutcome, Editor, MarkerSpec, SegmentUpdate, StoryboardItem, TextSpec, TimeRange};
use crate::ai_edit::mcp::tools::{
    delete_tool, marker_tool, remove_ranges_tool, split_tool, storyboard_tool, text_item, tool,
};
use crate::bridges::davinci::bridge::send_resolve_payload;

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
            if short == "Invalid function name" {
                // The Lua loop in Resolve predates this endpoint.
                return Err(format!(
                    "The AutoSubs script running in DaVinci Resolve is an older version without '{}'. \
                     Run Workspace > Scripts > AutoSubs again in Resolve, then retry.",
                    func
                ));
            }
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

pub async fn timeline_snapshot() -> Result<Value, String> {
    call_resolve(json!({ "func": "GetTimelineSnapshot" })).await
}

pub async fn build_storyboard(
    mode: Option<String>,
    track: usize,
    audio_path: Option<String>,
    items: Vec<StoryboardItem>,
) -> Result<ActionOutcome, String> {
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
    Ok(ActionOutcome::placed(Editor::Davinci, track, appended, requested, string_lines(&reply)))
}

pub async fn add_markers(markers: Vec<MarkerSpec>) -> Result<ActionOutcome, String> {
    let requested = markers.len();
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

pub async fn add_text(
    texts: Vec<TextSpec>,
    template: Option<String>,
    track: Option<String>,
) -> Result<ActionOutcome, String> {
    let count = texts.len();
    let segments: Vec<Value> = texts
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

pub async fn update_segment(u: SegmentUpdate) -> Result<ActionOutcome, String> {
    let mut ignored = Vec::new();
    for (name, given) in [
        ("zoomEnd", u.zoom_end.is_some()),
        ("panXEnd", u.pan_x_end.is_some()),
        ("panYEnd", u.pan_y_end.is_some()),
        ("volume", u.volume.is_some()),
    ] {
        if given {
            ignored.push(name);
        }
    }
    let reply = call_resolve(json!({
        "func": "UpdateClip",
        "id": u.segment_id,
        "startSec": u.start_sec,
        "durationSec": u.duration_sec,
        "zoom": u.zoom,
        "panX": u.pan_x,
        "panY": u.pan_y,
        "rotation": u.rotation,
        "opacity": u.opacity,
        "text": u.text,
    }))
    .await?;
    let changed = reply
        .get("updated")
        .and_then(|u| u.as_array())
        .map(|a| a.iter().filter_map(|s| s.as_str()).collect::<Vec<_>>().join(", "))
        .unwrap_or_default();
    let mut outcome = ActionOutcome::ok(format!("Updated the clip in Resolve ({}).", changed));
    let new_id = reply.get("id").and_then(|v| v.as_str()).filter(|id| *id != u.segment_id);
    if let Some(id) = new_id {
        outcome.lines.push(format!("Moving rebuilt the clip, so its id is now {}.", id));
    }
    if !ignored.is_empty() {
        outcome.partial = true;
        outcome.lines.push(format!(
            "Resolve's scripting API cannot change {}; those were ignored.",
            ignored.join(", ")
        ));
    }
    Ok(outcome)
}

pub async fn delete_segments(ids: Vec<String>, ripple: bool) -> Result<ActionOutcome, String> {
    let reply = call_resolve(json!({ "func": "DeleteClips", "ids": ids, "ripple": ripple })).await?;
    let deleted = reply.get("deleted").and_then(|v| v.as_u64()).unwrap_or(0);
    let missing = reply.get("missing").and_then(|v| v.as_u64()).unwrap_or(0);
    let mut outcome = ActionOutcome::ok(format!("Deleted {} clip(s) in Resolve.", deleted));
    if missing > 0 {
        outcome.partial = true;
        outcome.lines.push(format!("{} clip id(s) were not on the timeline.", missing));
    }
    Ok(outcome)
}

pub async fn split_clips(at_sec: f64, ids: Vec<String>) -> Result<ActionOutcome, String> {
    let reply = call_resolve(json!({ "func": "SplitClips", "atSec": at_sec, "ids": ids })).await?;
    let split = reply.get("split").and_then(|v| v.as_u64()).unwrap_or(0);
    let lines = string_lines(&reply);
    Ok(ActionOutcome {
        message: format!("Split {} clip(s) at {:.2}s in Resolve.", split, at_sec),
        partial: !lines.is_empty(),
        lines,
    })
}

pub async fn remove_ranges(ranges: Vec<TimeRange>, ripple: bool) -> Result<ActionOutcome, String> {
    let total: f64 = ranges.iter().map(|r| r.end - r.start).sum();
    let count = ranges.len();
    let reply = call_resolve(json!({ "func": "RemoveRanges", "ranges": ranges, "ripple": ripple })).await?;
    let cut = reply.get("cut").and_then(|v| v.as_u64()).unwrap_or(0);
    let deleted = reply.get("deleted").and_then(|v| v.as_u64()).unwrap_or(0);
    let mut lines = vec![format!("{} clip(s) cut at the span edges, {} piece(s) deleted.", cut, deleted)];
    let problems = string_lines(&reply);
    let partial = !problems.is_empty();
    lines.extend(problems);
    Ok(ActionOutcome {
        message: format!(
            "Removed {} span(s) ({:.2}s) from the Resolve timeline{}.",
            count,
            total,
            if ripple { " and closed the gaps" } else { ", leaving gaps" }
        ),
        partial,
        lines,
    })
}

// ---------------------------------------------------------------------------
// MCP tool schemas: what the agent is told Resolve can do
// ---------------------------------------------------------------------------

/// Extra clip fields `get_timeline` returns for Resolve.
pub const SNAPSHOT_FIELDS: &str = ", zoom, pan, rotation";

pub const MARKER_COLORS: &[&str] = &[
    "Blue", "Cyan", "Green", "Yellow", "Red", "Pink", "Purple", "Fuchsia", "Rose", "Lavender", "Sky", "Mint",
    "Lemon", "Sand", "Cocoa", "Cream",
];

/// What cutting costs in Resolve, appended to the split and remove tools.
const REBUILD_NOTE: &str = " Resolve rebuilds a cut clip from its media: the pieces keep the transform but lose the \
     color grade and Fusion effects, and titles, generators and speed-changed clips cannot be cut.";

/// The edit tools, in the order the agent sees them.
pub fn edit_tools() -> Vec<Value> {
    vec![
        storyboard_tool(
            "DaVinci Resolve",
            " Resolve can only set a fixed zoom/pan/rotation per clip, not keyframes.",
        ),
        marker_tool(
            "Add markers to the Resolve timeline. A frame that already has a marker is skipped.",
            MARKER_COLORS,
            true,
        ),
        tool(
            "add_text",
            "Add Text+ titles to the Resolve timeline. template is the name of a Text+ in the media pool: \
             \"AutoSubs Caption\" animates word by word, \"Default Template\" is a plain title (the \
             default). track is the video track number, \"0\" or omitted for a new track.",
            json!({
                "type": "object",
                "properties": {
                    "texts": { "type": "array", "items": text_item() },
                    "template": { "type": "string" },
                    "track": { "type": "string" }
                },
                "required": ["texts"]
            }),
        ),
        tool(
            "update_clip",
            "Change a Resolve clip by id: move it (startSec) or change its length (durationSec), and set \
             zoom, panX, panY, rotation, opacity (0-100) or the text of a Text+ clip. Moving or retiming \
             rebuilds the clip from its media, so it gets a new id (in the result), keeps its transform \
             but loses its color grade and Fusion effects; its linked audio moves with it, and the new \
             spot must be free. Resolve cannot keyframe or change volume.",
            json!({
                "type": "object",
                "properties": {
                    "segmentId": { "type": "string" },
                    "startSec": { "type": "number" },
                    "durationSec": { "type": "number" },
                    "zoom": { "type": "number" },
                    "panX": { "type": "number" },
                    "panY": { "type": "number" },
                    "rotation": { "type": "number" },
                    "opacity": { "type": "number" },
                    "text": { "type": "string" }
                },
                "required": ["segmentId"]
            }),
        ),
        delete_tool("DaVinci Resolve", true),
        split_tool("DaVinci Resolve", REBUILD_NOTE),
        remove_ranges_tool(
            "DaVinci Resolve",
            &format!(
                "{} With ripple, a track with no clip inside a span is not moved; the result lists any \
                 clips that did not move.",
                REBUILD_NOTE
            ),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spreads_words_over_the_cue() {
        let words = even_words("a b", 1.0, 3.0);
        assert_eq!(words[0]["end"], json!(2.0));
        assert_eq!(words[1]["start"], json!(2.0));
        assert_eq!(words[1]["end"], json!(3.0));
    }
}
