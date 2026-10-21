//! AI Edit backend for Adobe Premiere Pro.
//!
//! Every edit is one `request_ai_edit` message over the CEP WebSocket bridge
//! (`adobe_bridge::request`), which the panel turns into a call to `aiEdit`
//! in `Adobe-Extension/src/jsx/ppro/ai-edit.ts`. Premiere always edits its
//! active sequence.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use crate::bridges::adobe::bridge as adobe_bridge;
use crate::ai_edit::actions::{
    ActionOutcome, CutPoint, EffectSpec, Editor, MarkerSpec, SegmentUpdate, StoryboardItem, TextSpec, TimeRange,
};
use crate::ai_edit::mcp::tools::{
    clip_target_props, delete_tool, marker_tool, remove_marker_tool, remove_ranges_tool, split_tool, storyboard_tool,
    text_item, tool, CLIP_TARGET_DOC,
};

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
    let reply = call_premiere(
        "BuildStoryboard",
        json!({
            "mode": mode,
            "target_video_track": track,
            "default_still_secs": 3,
            "audio_path": audio_path,
            "items": spec_items,
        }),
    )
    .await?;
    let appended = reply.get("appended").and_then(|v| v.as_u64()).unwrap_or(0);
    let requested = reply.get("requested").and_then(|v| v.as_u64()).unwrap_or(items.len() as u64);
    Ok(ActionOutcome::placed(Editor::Premiere, track, appended, requested, string_lines(&reply)))
}

pub async fn delete_markers(at_secs: Vec<f64>) -> Result<ActionOutcome, String> {
    let requested = at_secs.len();
    let reply = call_premiere("DeleteMarkers", json!({ "atSec": at_secs })).await?;
    let deleted = reply.get("deleted").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    Ok(ActionOutcome {
        message: format!("Removed {}/{} marker(s) in Premiere Pro.", deleted, requested),
        partial: deleted < requested,
        lines: string_lines(&reply),
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

/// Text goes in as Motion Graphics Templates (`template`: a .mogrt path or
/// the name of one Premiere ships or the user installed; "Basic Title" by
/// default), one graphic per entry on the first free video track from
/// `track` up (V2 when omitted). `template: "captions"` makes a caption track
/// from an SRT instead, the same way Subtitles > Add to Timeline does it.
pub async fn add_text(texts: Vec<TextSpec>, template: Option<String>, track: Option<String>) -> Result<ActionOutcome, String> {
    let count = texts.len();
    let template = template.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    if template.as_deref().map_or(false, |t| t.eq_ignore_ascii_case("captions")) {
        return add_captions(texts).await;
    }
    let name = template.unwrap_or_else(|| DEFAULT_MOGRT.to_string());
    let mogrt = find_mogrt(&name)?;
    let track = track
        .as_deref()
        .map(|t| t.trim().trim_start_matches(['V', 'v']))
        .and_then(|t| t.parse::<usize>().ok())
        .filter(|t| *t >= 1)
        .unwrap_or(2);
    let reply = call_premiere(
        "AddGraphics",
        json!({
            "mogrt": mogrt.to_string_lossy(),
            "track": track,
            "texts": texts.iter().map(|t| json!({ "text": t.text.trim(), "start": t.start, "end": t.end })).collect::<Vec<_>>(),
        }),
    )
    .await?;
    let added = reply.get("added").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let lines = string_lines(&reply);
    Ok(ActionOutcome {
        message: format!("Added {}/{} \"{}\" graphic(s) in Premiere Pro.", added, count, mogrt_name(&mogrt)),
        partial: added < count || !lines.is_empty(),
        lines,
    })
}

async fn add_captions(texts: Vec<TextSpec>) -> Result<ActionOutcome, String> {
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

const DEFAULT_MOGRT: &str = "Basic Title";

fn mogrt_name(path: &Path) -> String {
    path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
}

/// Folders holding .mogrt files: the newest Premiere's own Essential
/// Graphics, then the user's installed templates.
fn mogrt_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let (apps, inner): (PathBuf, &[&str]) = if cfg!(target_os = "macos") {
        (PathBuf::from("/Applications"), &["Contents", "Essential Graphics"])
    } else {
        (
            std::env::var_os("ProgramFiles").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Program Files")).join("Adobe"),
            &["Essential Graphics"],
        )
    };
    let mut installs: Vec<PathBuf> = std::fs::read_dir(&apps)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().map_or(false, |n| n.to_string_lossy().starts_with("Adobe Premiere Pro")))
        .collect();
    installs.sort();
    if let Some(install) = installs.pop() {
        // macOS: /Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app/Contents/...
        let base = if cfg!(target_os = "macos") {
            std::fs::read_dir(&install)
                .into_iter()
                .flatten()
                .flatten()
                .map(|e| e.path())
                .find(|p| p.extension().map_or(false, |x| x == "app"))
                .unwrap_or(install)
        } else {
            install
        };
        dirs.push(inner.iter().fold(base, |p, part| p.join(part)));
    }
    let user = if cfg!(target_os = "macos") { dirs::data_dir() } else { dirs::config_dir() };
    if let Some(d) = user {
        dirs.push(d.join("Adobe").join("Common").join("Motion Graphics Templates"));
    }
    dirs
}

/// Every .mogrt under the template folders, first one per name.
fn installed_mogrts() -> Vec<PathBuf> {
    fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() && depth < 4 {
                walk(&path, depth + 1, out);
            } else if path.extension().map_or(false, |x| x.eq_ignore_ascii_case("mogrt"))
                && !out.iter().any(|p| mogrt_name(p).eq_ignore_ascii_case(&mogrt_name(&path)))
            {
                out.push(path);
            }
        }
    }
    let mut out = Vec::new();
    for dir in mogrt_dirs() {
        walk(&dir, 0, &mut out);
    }
    out
}

/// A template by path, or by name among the installed ones.
fn find_mogrt(name: &str) -> Result<PathBuf, String> {
    let as_path = PathBuf::from(name);
    if as_path.is_absolute() {
        return if as_path.is_file() { Ok(as_path) } else { Err(format!("No .mogrt file at {}.", name)) };
    }
    let wanted = name.trim_end_matches(".mogrt").to_lowercase();
    let all = installed_mogrts();
    all.iter()
        .find(|p| mogrt_name(p).to_lowercase() == wanted)
        .or_else(|| all.iter().find(|p| mogrt_name(p).to_lowercase().contains(&wanted)))
        .cloned()
        .ok_or_else(|| {
            if all.is_empty() {
                "No Motion Graphics Templates found. Pass template as the absolute path of a .mogrt, or \"captions\" for a caption track.".to_string()
            } else {
                format!(
                    "No template named \"{}\". Installed: {}.",
                    name,
                    all.iter().map(|p| mogrt_name(p)).collect::<Vec<_>>().join(", ")
                )
            }
        })
}

/// Change the clips in `ids` the same way. Times of `keyframes` are per clip.
pub async fn update_clips(ids: Vec<String>, u: SegmentUpdate) -> Result<ActionOutcome, String> {
    let count = ids.len();
    let reply = call_premiere(
        "UpdateClip",
        json!({
            "ids": ids,
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
            "speed": u.speed,
            "reverse": u.reverse,
            "keyframes": u.keyframes,
        }),
    )
    .await?;
    let changed = reply
        .get("updated")
        .and_then(|u| u.as_array())
        .map(|a| a.iter().filter_map(|s| s.as_str()).collect::<Vec<_>>().join(", "))
        .unwrap_or_default();
    let done = reply.get("clips").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let lines = string_lines(&reply);
    Ok(ActionOutcome {
        message: if count == 1 {
            format!("Updated the clip in Premiere Pro ({}).", changed)
        } else {
            format!("Updated {}/{} clips in Premiere Pro ({}).", done, count, changed)
        },
        partial: done < count || !lines.is_empty(),
        lines,
    })
}

pub async fn add_effects(ids: Vec<String>, effects: Vec<EffectSpec>) -> Result<ActionOutcome, String> {
    let count = ids.len();
    let names = effects.iter().map(|e| e.name.trim()).collect::<Vec<_>>().join(", ");
    let reply = call_premiere("AddEffects", json!({ "ids": ids, "effects": effects })).await?;
    let done = reply.get("clips").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let lines = string_lines(&reply);
    Ok(ActionOutcome {
        message: format!("Added {} to {}/{} clip(s) in Premiere Pro.", names, done, count),
        partial: done < count || !lines.is_empty(),
        lines,
    })
}

pub async fn add_transitions(
    points: Vec<CutPoint>,
    transition: Option<String>,
    audio_transition: Option<String>,
    duration: f64,
) -> Result<ActionOutcome, String> {
    let count = points.len();
    let reply = call_premiere(
        "AddTransitions",
        json!({
            "points": points,
            "transition": transition.unwrap_or_else(|| "Cross Dissolve".into()),
            "audioTransition": audio_transition.unwrap_or_else(|| "Constant Power".into()),
            "durationSec": duration,
        }),
    )
    .await?;
    let added = reply.get("added").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let lines = string_lines(&reply);
    let at = points.iter().map(|p| format!("{} {:.2}s", p.track, p.at_sec)).collect::<Vec<_>>();
    let mut outcome = ActionOutcome {
        message: format!("Added {}/{} transition(s) ({:.2}s) in Premiere Pro.", added, count, duration),
        partial: added < count || !lines.is_empty(),
        lines,
    };
    if count <= 12 {
        outcome.lines.insert(0, format!("At: {}.", at.join(", ")));
    }
    Ok(outcome)
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

pub async fn split_clips(at_sec: f64, ids: Vec<String>) -> Result<ActionOutcome, String> {
    let reply = call_premiere("SplitClips", json!({ "atSec": at_sec, "ids": ids })).await?;
    let split = reply.get("split").and_then(|v| v.as_u64()).unwrap_or(0);
    let lines = string_lines(&reply);
    Ok(ActionOutcome {
        message: format!("Cut {} track(s) at {:.2}s in Premiere Pro.", split, at_sec),
        partial: !lines.is_empty(),
        lines,
    })
}

pub async fn remove_ranges(ranges: Vec<TimeRange>, ripple: bool, tracks: Vec<String>) -> Result<ActionOutcome, String> {
    let total: f64 = ranges.iter().map(|r| r.end - r.start).sum();
    let count = ranges.len();
    let reply = call_premiere("RemoveRanges", json!({ "ranges": ranges, "ripple": ripple, "tracks": tracks })).await?;
    let deleted = reply.get("deleted").and_then(|v| v.as_u64()).unwrap_or(0);
    let markers = reply.get("markersRemoved").and_then(|v| v.as_u64()).unwrap_or(0);
    let problems = string_lines(&reply);
    let partial = !problems.is_empty();
    let mut lines = vec![format!("{} clip piece(s) deleted.", deleted)];
    if markers > 0 {
        lines.push(format!("{} marker(s) inside the spans were removed.", markers));
    }
    lines.extend(problems);
    Ok(ActionOutcome {
        message: format!(
            "Removed {} span(s) ({:.2}s) from the Premiere sequence{}.",
            count,
            total,
            if ripple { " and closed the gaps" } else { ", leaving gaps" }
        ),
        partial,
        lines,
    })
}

// ---------------------------------------------------------------------------
// MCP tool schemas: what the agent is told Premiere can do
// ---------------------------------------------------------------------------

/// Extra clip fields `get_timeline` returns for Premiere.
pub const SNAPSHOT_FIELDS: &str = ", zoom, speed, fx=[effects added to it], selected when the user selected it";

pub const MARKER_COLORS: &[&str] = &["Green", "Red", "Purple", "Orange", "Yellow", "White", "Blue", "Cyan"];

/// The edit tools, in the order the agent sees them.
pub fn edit_tools() -> Vec<Value> {
    vec![
        storyboard_tool(
            "Premiere Pro",
            " Premiere: replace overwrites video and its audio; insert pushes only the target video \
             track and the audio track with the same number; overlay places video only.",
        ),
        marker_tool(
            "Add markers to the active Premiere sequence. note goes into the marker comment.",
            MARKER_COLORS,
            true,
        ),
        add_text_tool(),
        update_clip_tool(),
        delete_tool("Premiere Pro", true),
        split_tool("Premiere Pro", ""),
        remove_ranges_tool("Premiere Pro", " With ripple, markers inside a span are removed and later ones move left."),
        remove_marker_tool("Premiere Pro"),
        add_effects_tool(),
        add_transitions_tool(),
    ]
}

fn add_text_tool() -> Value {
    let installed: Vec<String> = installed_mogrts().iter().map(|p| mogrt_name(p)).collect();
    let templates = if installed.is_empty() {
        "No templates were found on this computer; pass the absolute path of a .mogrt.".to_string()
    } else {
        format!("Installed templates: {}.", installed.join(", "))
    };
    tool(
        "add_text",
        format!(
            "Add on-screen text to Premiere as Motion Graphics Templates: one graphic per entry, from start \
             to end, on the first video track from track up (default V2) that is free there, with the text \
             typed into the template's first text field. template is a template name (default \"{}\") or the \
             absolute path of a .mogrt. template \"captions\" makes a caption track instead (for subtitles). \
             Graphics are clips like any other: move, zoom or fade them with update_clip. {}",
            DEFAULT_MOGRT, templates
        ),
        json!({
            "type": "object",
            "properties": {
                "texts": { "type": "array", "items": text_item() },
                "template": { "type": "string", "description": "Template name or .mogrt path; \"captions\" for a caption track" },
                "track": { "type": "string", "description": "Lowest video track to use, like \"V3\" (default V2)" }
            },
            "required": ["texts"]
        }),
    )
}

fn update_clip_tool() -> Value {
    let mut props = json!({
        "segmentId": { "type": "string", "description": "One clip; or pick several with the fields below" },
        "startSec": { "type": "number" },
        "durationSec": { "type": "number" },
        "zoom": { "type": "number" }, "zoomEnd": { "type": "number" },
        "panX": { "type": "number" }, "panXEnd": { "type": "number" },
        "panY": { "type": "number" }, "panYEnd": { "type": "number" },
        "rotation": { "type": "number" },
        "opacity": { "type": "number" },
        "volume": { "type": "number", "description": "1.0 = unchanged" },
        "speed": { "type": "number", "description": "1.0 = normal, 2.0 = twice as fast, 0.5 = slow motion" },
        "reverse": { "type": "boolean", "description": "Play backwards" },
        "keyframes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "property": { "type": "string", "description": "Scale, Position, Rotation, Opacity, Level, or \"<Effect>/<Parameter>\"" },
                    "points": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "sec": { "type": "number", "description": "Seconds after the clip's start" },
                                "fromEnd": { "type": "boolean", "description": "Count sec back from the clip's end" },
                                "value": { "description": "Number, or [x, y] for Position" }
                            },
                            "required": ["sec", "value"]
                        }
                    },
                    "interpolation": { "type": "string", "enum": ["ease", "linear", "hold"] }
                },
                "required": ["property", "points"]
            }
        }
    });
    clip_target_props(&mut props);
    tool(
        "update_clip",
        format!(
            "Change Premiere clips: segmentId for one, or several picked by the fields below. {} \
             startSec (move) and durationSec (length) take one clip. zoom (1.0 = 100%), panX/panY (-1..1, 0 = \
             centred), rotation (degrees), opacity (0-100); zoomEnd/panXEnd/panYEnd add eased keyframes from \
             clip start to end. volume: 1.0 = unchanged, 0.5 = about -6 dB, 0 = silent (a video clip's linked \
             audio too). speed changes the clip's length with it, so a slower clip needs free room after it; \
             reverse plays it backwards. keyframes animate any property in Premiere's own units (Scale 100 = \
             100%, Position [0.5, 0.5] = centre, Opacity 0-100, Rotation degrees, an effect's parameter as \
             its control shows it): sec counts from the clip's start, or back from its end with fromEnd, so one \
             list fits clips of any length (a fade-out is Opacity 100 at sec 1 fromEnd, 0 at sec 0 fromEnd). \
             Caption text cannot be changed.",
            CLIP_TARGET_DOC
        ),
        json!({ "type": "object", "properties": props }),
    )
}

fn add_effects_tool() -> Value {
    let mut props = json!({
        "effects": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "As in Premiere's Effects panel, like \"Gaussian Blur\", \"Lumetri Color\", \"DeNoise\"" },
                    "params": { "type": "object", "description": "Parameter name to value, like { \"Blurriness\": 20 }" }
                },
                "required": ["name"]
            }
        }
    });
    clip_target_props(&mut props);
    tool(
        "add_effects",
        format!(
            "Add effects to Premiere clips: one clip, some, a whole track or every clip. {} Each effect goes on \
             every picked clip of its kind: video effects on video clips, audio effects (DeNoise, Parametric \
             Equalizer, Reverb) on audio clips, the rest are skipped. params set the effect's controls by the \
             names Premiere shows (Lumetri Color: Exposure, Contrast, Highlights, Shadows, Temperature, Tint, \
             Saturation, Vibrance; checkboxes take true/false, colors [r, g, b, a] 0-1). The result lists \
             close names for an effect or parameter it could not find. To animate a parameter, use update_clip \
             keyframes with \"<Effect>/<Parameter>\".",
            CLIP_TARGET_DOC
        ),
        json!({ "type": "object", "properties": props, "required": ["effects"] }),
    )
}

fn add_transitions_tool() -> Value {
    tool(
        "add_transitions",
        "Put transitions on Premiere edit points: one cut, a few, or all of them. A point is a join between two \
         touching clips on one track. Pick them with atSec (cut times), between (pairs of clip ids), clips (both \
         edges of these clips, edge \"start\" or \"end\" for one), tracks, fromSec/toSec, or all: true; \
         criteria combine. Without tracks only video tracks count (every track when clips or between name the \
         clips). A clip edge next to a gap is a fade from or to black: included when clips names the clip or \
         fades is true. transition is the video transition (default \"Cross Dissolve\"; also \"Dip to Black\", \
         \"Dip to White\", \"Film Dissolve\", \"Push\", \"Slide\"...); points on audio tracks use \
         audioTransition (default \"Constant Power\"). The clips need unused media past the cut for a \
         transition centred on it; Premiere shortens or refuses it otherwise.",
        json!({
            "type": "object",
            "properties": {
                "transition": { "type": "string" },
                "audioTransition": { "type": "string" },
                "durationSec": { "type": "number", "description": "Default 0.5" },
                "atSec": { "type": "array", "items": { "type": "number" } },
                "between": { "type": "array", "items": { "type": "array", "items": { "type": "string" }, "minItems": 2, "maxItems": 2 } },
                "clips": { "type": "array", "items": { "type": "string" } },
                "edge": { "type": "string", "enum": ["start", "end", "both"] },
                "tracks": { "type": "array", "items": { "type": "string" }, "description": "Like [\"V1\", \"A1\"]" },
                "fromSec": { "type": "number" },
                "toSec": { "type": "number" },
                "fades": { "type": "boolean", "description": "Also clip edges next to a gap" },
                "all": { "type": "boolean", "description": "Every join" }
            }
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_installed_templates() {
        // Only meaningful where Premiere is installed.
        let all = installed_mogrts();
        if all.iter().any(|p| mogrt_name(p) == DEFAULT_MOGRT) {
            assert_eq!(mogrt_name(&find_mogrt("basic title").unwrap()), "Basic Title");
            assert!(find_mogrt("Lower Third").is_ok());
            assert!(find_mogrt("no such template").unwrap_err().contains("Installed:"));
        }
    }

    #[test]
    fn writes_srt() {
        let srt = to_srt(&[
            TextSpec { text: "Hi".into(), start: 0.0, end: 1.5 },
            TextSpec { text: "Two".into(), start: 3661.25, end: 3662.0 },
        ]);
        assert_eq!(srt, "1\n00:00:00,000 --> 00:00:01,500\nHi\n\n2\n01:01:01,250 --> 01:01:02,000\nTwo\n");
    }
}
