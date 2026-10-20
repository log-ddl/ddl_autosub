//! AI Edit backend for Adobe Premiere Pro.
//!
//! Every edit is one `request_ai_edit` message over the CEP WebSocket bridge
//! (`adobe_bridge::request`), which the panel turns into a call to `aiEdit`
//! in `Adobe-Extension/src/jsx/ppro/ai-edit.ts`. Premiere always edits its
//! active sequence.

use std::time::Duration;

use serde_json::{json, Value};

use crate::adobe_bridge;
use crate::ai_edit::actions::{ActionOutcome, MarkerSpec, SegmentUpdate, StoryboardItem, TextSpec};
use crate::ai_edit::mcp::tools::{delete_tool, marker_tool, storyboard_tool, text_item, tool};

/// Importing media runs once per item and is slow in Premiere.
const PREMIERE_TIMEOUT: Duration = Duration::from_secs(300);

/// Call one `aiEdit` function in the panel and fail on its `{ success: false }` reply.
async fn call_premiere(func: &str, args: Value) -> Result<Value, String> {
    let reply = adobe_bridge::request(
        "premiere",
        "request_ai_edit",
        json!({ "func": func, "args": args }),
        PREMIERE_TIMEOUT,
    )
    .await
    .map_err(|e| format!("{} Open Window > Extensions > AutoSubs in Premiere Pro, then retry.", e))?;
    // ExtendScript answers with a JSON string.
    let value: Value = match reply {
        Value::String(text) => serde_json::from_str(&text)
            .map_err(|e| format!("Invalid reply from Premiere Pro ({}): {}", func, e))?,
        other => other,
    };
    if value.get("success").and_then(|s| s.as_bool()) == Some(false) {
        let err = value.get("error").and_then(|e| e.as_str()).unwrap_or("Premiere Pro reported an error");
        if err == "Invalid function name" || err.contains("Unsupported ExtendScript function") {
            return Err(format!(
                "The AutoSubs panel in Premiere Pro is an older version without '{}'. \
                 Rebuild the extension and reopen the panel, then retry.",
                func
            ));
        }
        return Err(err.to_string());
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
    let mut snap = call_premiere("GetTimelineSnapshot", json!({})).await?;
    if let Some(obj) = snap.as_object_mut() {
        obj.remove("success");
    }
    Ok(snap)
}

pub async fn build_storyboard(
    mode: Option<String>,
    track: usize,
    audio_path: Option<String>,
    items: Vec<StoryboardItem>,
) -> Result<ActionOutcome, String> {
    let mut notes = Vec::new();
    if mode.as_deref().is_some_and(|m| m != "append") {
        notes.push(
            "Premiere: clips are placed after the last clip on the track (append); \
             replace/insert/overlay are not supported yet."
                .to_string(),
        );
    }
    if items.iter().any(|it| it.effect.is_some()) {
        notes.push("Premiere: effect is not applied when placing; use update_clip afterwards.".into());
    }
    let spec_items: Vec<Value> = items
        .iter()
        .map(|it| {
            json!({
                "path": it.path,
                "start": it.start,
                "end": it.end,
                "src_in": it.src_in,
                "src_out": it.src_out,
            })
        })
        .collect();
    let reply = call_premiere(
        "BuildStoryboard",
        json!({
            "target_video_track": track,
            "default_still_secs": 3,
            "audio_path": audio_path,
            "items": spec_items,
        }),
    )
    .await?;
    let appended = reply.get("appended").and_then(|v| v.as_u64()).unwrap_or(0);
    let requested = reply.get("requested").and_then(|v| v.as_u64()).unwrap_or(items.len() as u64);
    let mut lines = string_lines(&reply);
    lines.extend(notes);
    Ok(ActionOutcome {
        message: format!("Placed {}/{} clip(s) on Premiere track V{}.", appended, requested, track),
        partial: appended < requested,
        lines,
    })
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
    let reply = call_premiere("AddMarkers", json!({ "markers": payload })).await?;
    let added = reply.get("added").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let lines = string_lines(&reply);
    Ok(ActionOutcome {
        message: format!("Added {}/{} marker(s) in Premiere Pro.", added, requested),
        partial: added < requested || !lines.is_empty(),
        lines,
    })
}

fn srt_time(secs: f64) -> String {
    let ms = (secs.max(0.0) * 1000.0).round() as u64;
    format!("{:02}:{:02}:{:02},{:03}", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000)
}

fn to_srt(texts: &[TextSpec]) -> String {
    texts
        .iter()
        .enumerate()
        .map(|(i, t)| format!("{}\n{} --> {}\n{}\n", i + 1, srt_time(t.start), srt_time(t.end), t.text.trim()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// ExtendScript cannot create titles, so text goes in as a caption track built
/// from an SRT, the same way Subtitles > Add to Timeline does it.
pub async fn add_text(texts: Vec<TextSpec>) -> Result<ActionOutcome, String> {
    let count = texts.len();
    let path = std::env::temp_dir().join(format!("autosubs-ai-edit-{}.srt", uuid::Uuid::new_v4().simple()));
    std::fs::write(&path, to_srt(&texts)).map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    let reply = call_premiere("ImportCaptions", json!({ "filePath": path.to_string_lossy() })).await?;
    let mut outcome = ActionOutcome::ok(format!("Added {} caption(s) on a new Premiere caption track.", count));
    if reply.get("method").and_then(|m| m.as_str()) == Some("importOnly") {
        outcome.partial = true;
        outcome.lines.push(
            "Premiere imported the captions into the project but could not add the track; \
             drag the caption item from the Project panel onto the sequence."
                .into(),
        );
    }
    Ok(outcome)
}

pub async fn update_segment(u: SegmentUpdate) -> Result<ActionOutcome, String> {
    let reply = call_premiere(
        "UpdateClip",
        json!({
            "segmentId": u.segment_id,
            "startSec": u.start_sec,
            "durationSec": u.duration_sec,
            "zoom": u.zoom,
            "zoomEnd": u.zoom_end,
            "panX": u.pan_x,
            "panXEnd": u.pan_x_end,
            "panY": u.pan_y,
            "panYEnd": u.pan_y_end,
            "rotation": u.rotation,
            "opacity": u.opacity,
            "volume": u.volume,
            "text": u.text,
        }),
    )
    .await?;
    let changed = reply
        .get("updated")
        .and_then(|u| u.as_array())
        .map(|a| a.iter().filter_map(|s| s.as_str()).collect::<Vec<_>>().join(", "))
        .unwrap_or_default();
    let lines = string_lines(&reply);
    Ok(ActionOutcome {
        message: format!("Updated the clip in Premiere Pro ({}).", changed),
        partial: !lines.is_empty(),
        lines,
    })
}

pub async fn delete_segments(ids: Vec<String>, ripple: bool) -> Result<ActionOutcome, String> {
    let reply = call_premiere("DeleteClips", json!({ "ids": ids, "ripple": ripple })).await?;
    let deleted = reply.get("deleted").and_then(|v| v.as_u64()).unwrap_or(0);
    let missing = reply.get("missing").and_then(|v| v.as_u64()).unwrap_or(0);
    let mut outcome = ActionOutcome::ok(format!("Deleted {} clip(s) in Premiere Pro.", deleted));
    if missing > 0 {
        outcome.partial = true;
        outcome.lines.push(format!("{} clip id(s) were not on the sequence.", missing));
    }
    Ok(outcome)
}

// ---------------------------------------------------------------------------
// MCP tool schemas: what the agent is told Premiere can do
// ---------------------------------------------------------------------------

/// Extra clip fields `get_timeline` returns for Premiere.
pub const SNAPSHOT_FIELDS: &str = ", zoom, media path";

pub const MARKER_COLORS: &[&str] = &["Green", "Red", "Purple", "Orange", "Yellow", "White", "Blue", "Cyan"];

/// The edit tools, in the order the agent sees them.
pub fn edit_tools() -> Vec<Value> {
    vec![
        storyboard_tool(
            "Premiere Pro",
            " Premiere: clips always go after the last clip on the track (mode is treated as append), \
             and effect is not applied; set zoom/pan with update_clip afterwards.",
        ),
        marker_tool(
            "Add markers to the active Premiere sequence. note goes into the marker comment.",
            MARKER_COLORS,
            true,
        ),
        tool(
            "add_text",
            "Add on-screen text to Premiere as a new caption track (one caption per entry).",
            json!({
                "type": "object",
                "properties": { "texts": { "type": "array", "items": text_item() } },
                "required": ["texts"]
            }),
        ),
        tool(
            "update_clip",
            "Change a Premiere clip by id: move it (startSec), change its length (durationSec), set \
             zoom (1.0 = 100%), panX/panY (-1..1, 0 = centred), rotation (degrees) or opacity (0-100). \
             zoomEnd/panXEnd/panYEnd add keyframes from clip start to end. Volume and caption text \
             cannot be changed.",
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
                    "opacity": { "type": "number" }
                },
                "required": ["segmentId"]
            }),
        ),
        delete_tool("Premiere Pro", true),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_srt() {
        let srt = to_srt(&[
            TextSpec { text: "Hi".into(), start: 0.0, end: 1.5 },
            TextSpec { text: "Two".into(), start: 3661.25, end: 3662.0 },
        ]);
        assert_eq!(srt, "1\n00:00:00,000 --> 00:00:01,500\nHi\n\n2\n01:01:01,250 --> 01:01:02,000\nTwo\n");
    }
}
