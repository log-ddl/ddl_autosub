//! MCP tool definitions. The schemas shared by every editor live here; each
//! editor module (`editors/*.rs`) assembles its own list from them in
//! `edit_tools()`, so the agent only sees what that editor supports.

pub mod analyze;
pub mod assets;
pub mod media;
pub mod motion;
pub mod project;
pub mod search;
pub mod transcript;

use serde_json::{json, Value};

use crate::ai_edit::actions::{track_clips, track_labels, Editor};
use crate::ai_edit::editors::{capcut, davinci, premiere};

pub fn tool(name: &str, description: impl Into<String>, schema: Value) -> Value {
    json!({ "name": name, "description": description.into(), "inputSchema": schema })
}

/// The tools for one session: the read tools (`get_timeline`,
/// `get_transcript`) always, the edit tools only when the run may edit (Turbo).
pub fn tool_definitions(editor: Editor, allow_edits: bool) -> Vec<Value> {
    let snapshot_fields = match editor {
        Editor::Davinci => davinci::SNAPSHOT_FIELDS,
        Editor::Capcut => capcut::SNAPSHOT_FIELDS,
        Editor::Premiere => premiere::SNAPSHOT_FIELDS,
    };
    let mut tools = vec![tool(
        "get_timeline",
        format!(
            "Read the open {} timeline: one line per clip (track, id, start-end in seconds, name{}, \
             transform only when not default) and the markers. Call it when you need clip ids, and \
             read only the part you are about to edit: fromSec/toSec for a stretch of time, tracks \
             for some tracks. The first line always counts the clips on every track. Edit tools already report what they did, so \
             only re-read after an edit that failed or was partial.",
            editor.display_name(),
            snapshot_fields
        ),
        json!({
            "type": "object",
            "properties": {
                "fromSec": { "type": "number", "description": "Only clips and markers from this time" },
                "toSec": { "type": "number", "description": "Only clips and markers before this time" },
                "tracks": { "type": "array", "items": { "type": "string" }, "description": "Only these tracks, like [\"V1\", \"A1\"]" }
            }
        }),
    ), transcript_tool()];
    if allow_edits {
        let edits = match editor {
            Editor::Davinci => davinci::edit_tools(),
            Editor::Capcut => capcut::edit_tools(),
            Editor::Premiere => premiere::edit_tools(),
        };
        let names: Vec<&str> = edits.iter().filter_map(|t| t["name"].as_str()).collect();
        let batch = apply_actions_tool(&names);
        tools.extend(edits);
        tools.push(batch);
    }
    tools
}

/// `apply_actions`: several of the edit tools above in one call, so a
/// planned edit costs one model turn instead of one per step.
fn apply_actions_tool(edit_tools: &[&str]) -> Value {
    tool(
        "apply_actions",
        "Run several edits in one call, in order: each entry is one of the edit tools with the same args \
         it takes on its own. Use it once you have a plan (place all the B-roll, add all the titles and \
         markers) instead of calling the tools one by one. Every entry is checked first, so a bad one \
         applies nothing; then the batch stops at the first edit that fails (continueOnError to go on), \
         and the result reports each entry. Entries run against the timeline as the previous ones left \
         it: split_clips, update_clip moves and remove_ranges change clip ids and ripple cuts shift later \
         times, so put those last, give all cut spans in one remove_ranges, and never reuse an id an \
         earlier entry replaced.",
        json!({
            "type": "object",
            "properties": {
                "actions": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 100,
                    "items": {
                        "type": "object",
                        "properties": {
                            "tool": { "type": "string", "enum": edit_tools },
                            "args": { "type": "object", "description": "The arguments that tool takes" }
                        },
                        "required": ["tool", "args"]
                    }
                },
                "continueOnError": { "type": "boolean", "description": "Keep going after a failed edit (default false)" }
            },
            "required": ["actions"]
        }),
    )
}

/// What part of the timeline `get_timeline` returns: clips that touch
/// [from, to) on the listed tracks ("V1", "A1"); everything when empty. On a
/// long edit the whole timeline is hundreds of lines the agent rarely needs.
#[derive(Debug, Default)]
pub struct TimelineFilter {
    pub from: Option<f64>,
    pub to: Option<f64>,
    pub tracks: Vec<String>,
}

impl TimelineFilter {
    pub fn from_args(args: &Value) -> Self {
        let secs = |k: &str| args.get(k).and_then(|v| v.as_f64()).filter(|v| v.is_finite());
        Self {
            from: secs("fromSec"),
            to: secs("toSec"),
            tracks: args
                .get("tracks")
                .and_then(|t| t.as_array())
                .into_iter()
                .flatten()
                .filter_map(|t| t.as_str())
                .map(|t| t.trim().to_ascii_uppercase())
                .filter(|t| !t.is_empty())
                .collect(),
        }
    }

    fn is_empty(&self) -> bool {
        self.from.is_none() && self.to.is_none() && self.tracks.is_empty()
    }

    fn keeps_track(&self, label: &str) -> bool {
        self.tracks.is_empty() || self.tracks.iter().any(|t| t == label)
    }

    fn keeps_span(&self, start: f64, end: f64) -> bool {
        self.from.map_or(true, |f| end > f || (start == end && start >= f)) && self.to.map_or(true, |t| start < t)
    }
}

/// The snapshot as the agent reads it: one line per clip
/// (`V1 id 0.00-4.00 name zoom=1.1`), one per marker, limited to `filter`.
/// The JSON the UI uses is several times longer: on a long edit it
/// overflowed what agy shows inline, so the agent paid a turn to read it
/// back from a file.
pub fn timeline_text(snapshot: &Value, filter: &TimelineFilter) -> String {
    let num = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_f64());
    let text = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let short = |s: &str| {
        let s = s.trim().replace('\n', " ");
        if s.chars().count() > 48 {
            format!("{}...", s.chars().take(45).collect::<String>())
        } else {
            s
        }
    };
    let name = [text(snapshot, "name"), text(snapshot, "draftName")].into_iter().find(|n| !n.is_empty()).unwrap_or_default();
    let size = match (num(snapshot, "width"), num(snapshot, "height")) {
        (Some(w), Some(h)) if w > 0.0 && h > 0.0 => format!(" {}x{},", w, h),
        _ => String::new(),
    };
    let mut out = format!(
        "Timeline \"{}\",{} {} fps, {:.2}s long.",
        name,
        size,
        num(snapshot, "fps").map(|f| format!("{}", (f * 1000.0).round() / 1000.0)).unwrap_or_else(|| "?".into()),
        num(snapshot, "durationSec").unwrap_or(0.0)
    );

    let mut summary = Vec::new();
    let mut lines = Vec::new();
    let mut total = 0;
    for (label, track) in track_labels(snapshot) {
        let clips = track_clips(track);
        summary.push(format!("{}({})", label, clips.len()));
        total += clips.len();
        if !filter.keeps_track(&label) {
            continue;
        }
        for clip in clips {
            let start = num(clip, "startSec").unwrap_or(0.0);
            let end = start + num(clip, "durationSec").unwrap_or(0.0);
            if !filter.keeps_span(start, end) {
                continue;
            }
            let title = [text(clip, "text"), text(clip, "name")].into_iter().find(|n| !n.trim().is_empty()).unwrap_or_default();
            let mut line = format!("{} {} {:.2}-{:.2} {}", label, text(clip, "id"), start, end, short(&title));
            for (key, default) in
                [("zoom", 1.0), ("panX", 0.0), ("panY", 0.0), ("rotation", 0.0), ("opacity", 100.0), ("speed", 1.0)]
            {
                if let Some(v) = num(clip, key).filter(|v| (v - default).abs() > 1e-6) {
                    line.push_str(&format!(" {}={}", key, (v * 1000.0).round() / 1000.0));
                }
            }
            let effects: Vec<&str> = clip
                .get("effects")
                .and_then(|e| e.as_array())
                .into_iter()
                .flatten()
                .filter_map(|e| e.as_str())
                .collect();
            if !effects.is_empty() {
                line.push_str(&format!(" fx=[{}]", effects.join(", ")));
            }
            if clip.get("selected").and_then(|s| s.as_bool()) == Some(true) {
                line.push_str(" selected");
            }
            lines.push(line);
        }
    }
    out.push_str(&format!(" Tracks: {}.", if summary.is_empty() { "none".into() } else { summary.join(" ") }));
    if !filter.is_empty() {
        let mut what = Vec::new();
        if filter.from.is_some() || filter.to.is_some() {
            what.push(format!(
                "{}-{}s",
                filter.from.map(|f| format!("{:.2}", f)).unwrap_or_else(|| "start".into()),
                filter.to.map(|t| format!("{:.2}", t)).unwrap_or_else(|| "end".into())
            ));
        }
        if !filter.tracks.is_empty() {
            what.push(filter.tracks.join(" "));
        }
        out.push_str(&format!(" Showing {} of {} clips ({}).", lines.len(), total, what.join(", ")));
    }
    for line in lines {
        out.push('\n');
        out.push_str(&line);
    }
    let markers: Vec<String> = snapshot
        .get("markers")
        .and_then(|m| m.as_array())
        .into_iter()
        .flatten()
        .filter_map(|m| {
            // Resolve and Premiere say atSec/name, CapCut startSec/title.
            let at = num(m, "atSec").or_else(|| num(m, "startSec")).unwrap_or(0.0);
            if !filter.keeps_span(at, at) {
                return None;
            }
            let mut s = format!("{:.2} {}", at, text(m, "color"));
            let name = [text(m, "name"), text(m, "title")].into_iter().find(|n| !n.is_empty()).unwrap_or_default();
            if !name.is_empty() {
                s.push_str(&format!(" \"{}\"", short(&name)));
            }
            Some(s)
        })
        .collect();
    if !markers.is_empty() {
        out.push_str(&format!("\nMarkers: {}", markers.join("; ")));
    }
    out
}

/// `get_transcript`, the same for every editor.
fn transcript_tool() -> Value {
    tool(
        "get_transcript",
        "Read what is said on the timeline: the transcript AutoSubs made of it, one line per subtitle \
         ([start-end] speaker: text, seconds from the timeline start). Reads the transcript open in the \
         app, else the newest; the result lists the others by filename. Use words for per-word timings \
         (to cut a filler word or a bad take precisely) and minPauseSec to list silences, e.g. 0.7, \
         then cut them with remove_ranges.",
        json!({
            "type": "object",
            "properties": {
                "file": { "type": "string", "description": "A filename from the list of other transcripts" },
                "fromSec": { "type": "number", "description": "Only segments ending after this time" },
                "toSec": { "type": "number", "description": "Only segments starting before this time" },
                "words": { "type": "boolean", "description": "Include per-word timings" },
                "minPauseSec": { "type": "number", "description": "List pauses between words at least this long" }
            }
        }),
    )
}

/// `split_clips`; `note` is appended for editor-specific limits.
pub fn split_tool(editor_name: &str, note: &str) -> Value {
    tool(
        "split_clips",
        format!(
            "Cut clips on the {} timeline in two at atSec (a razor cut). Splits the clips listed in \
             segmentIds, or every clip under atSec on every track when segmentIds is omitted. The pieces \
             get new ids; when the result lists them (\"New ids: V1 <id> 0.00-1.50\") use those, \
             otherwise call get_timeline before editing a piece.{}",
            editor_name, note
        ),
        json!({
            "type": "object",
            "properties": {
                "atSec": { "type": "number", "description": "Seconds from the timeline start" },
                "segmentIds": { "type": "array", "items": { "type": "string" } }
            },
            "required": ["atSec"]
        }),
    )
}

/// `remove_ranges`; `note` is appended for editor-specific limits.
pub fn remove_ranges_tool(editor_name: &str, note: &str) -> Value {
    tool(
        "remove_ranges",
        format!(
            "Cut time spans out of the {} timeline: silences, filler words, a bad take. Every track by \
             default; tracks limits it to the ones listed, as get_timeline labels them (\"V1\", \"A1\"): \
             to cut a clip and its sound but keep a title above, pass [\"V1\", \"A1\"] in ONE call \
             instead of splitting and deleting. \
             Clips crossing a span are split at its edges and the part inside is deleted, leaving a gap; \
             nothing else moves. Set ripple to true ONLY when the user asks to close the gaps (\"dồn\", \
             ripple, no gaps): then everything after moves left, so give all spans in one call, in the \
             timeline's current times. Never move or re-time other clips, sound effects, titles or \
             markers to follow a cut unless the user asks.{}",
            editor_name, note
        ),
        json!({
            "type": "object",
            "properties": {
                "ranges": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "start": { "type": "number", "description": "Seconds from the timeline start" },
                            "end": { "type": "number", "description": "Seconds from the timeline start" }
                        },
                        "required": ["start", "end"]
                    }
                },
                "ripple": { "type": "boolean", "description": "Also close the gaps. Default false; only when the user asks" },
                "tracks": { "type": "array", "items": { "type": "string" }, "description": "Only these tracks, like [\"V1\", \"A1\"] (default: every track)" }
            },
            "required": ["ranges"]
        }),
    )
}

/// `build_storyboard`; `note` is appended for editor-specific limits.
pub fn storyboard_tool(editor_name: &str, note: &str) -> Value {
    let effect = json!({
        "type": "object",
        "properties": {
            "zoom": { "type": "number", "description": "1.0 = no zoom" },
            "panX": { "type": "number" },
            "panY": { "type": "number" },
            "rotation": { "type": "number", "description": "degrees" }
        }
    });
    tool(
        "build_storyboard",
        format!(
            "Place video, image or audio files on the {} timeline. mode: replace (overwrite [start, end] \
             on the track), insert (ripple: split at start and push later clips right), overlay (put on \
             a free track above), append (after the last clip). Tracks are created as needed. Audio files \
             (sound effects, music) can be mixed in: each goes exactly at its start on a free audio \
             track, never over another clip, trimmed by srcIn/srcOut (or end), and does not move the \
             video clips; the mode only applies to video and images.{}",
            editor_name, note
        ),
        json!({
            "type": "object",
            "properties": {
                "mode": { "type": "string", "enum": ["replace", "insert", "overlay", "append"] },
                "targetVideoTrack": { "type": "integer", "minimum": 1, "description": "1 = V1" },
                "audioPath": { "type": "string", "description": "Optional audio file placed on a new audio track" },
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "path": { "type": "string", "description": "Media id (m12) or absolute file path. Audio files go on free audio tracks at start" },
                            "start": { "type": "number", "description": "Timeline start, seconds" },
                            "end": { "type": "number", "description": "Timeline end, seconds" },
                            "srcIn": { "type": "number", "description": "Cut-in inside the source, seconds" },
                            "srcOut": { "type": "number", "description": "Cut-out inside the source, seconds" },
                            "effect": effect
                        },
                        "required": ["path", "start"]
                    }
                }
            },
            "required": ["items"]
        }),
    )
}

/// `remove_marker`, the same for every editor: the app finds the markers in
/// the snapshot and the editor only deletes them by position.
pub fn remove_marker_tool(editor_name: &str) -> Value {
    tool(
        "remove_marker",
        format!(
            "Delete markers from the {} timeline: those at atSec (seconds, as get_timeline lists them), \
             between fromSec and toSec, of a color, or whose name contains name. Criteria combine (all \
             must match); all: true deletes every marker. Nothing else on the timeline changes.",
            editor_name
        ),
        json!({
            "type": "object",
            "properties": {
                "atSec": { "type": "array", "items": { "type": "number" }, "description": "Marker times to delete" },
                "fromSec": { "type": "number" },
                "toSec": { "type": "number" },
                "color": { "type": "string" },
                "name": { "type": "string", "description": "Part of the marker name" },
                "all": { "type": "boolean", "description": "Delete every marker" }
            }
        }),
    )
}

/// `add_marker` with the editor's colors; `with_note` adds the note field.
pub fn marker_tool(description: &str, colors: &[&str], with_note: bool) -> Value {
    let mut props = json!({
        "atSec": { "type": "number", "description": "Seconds from the timeline start" },
        "color": { "type": "string", "enum": colors },
        "name": { "type": "string" },
        "durationSec": { "type": "number", "description": "Span in seconds; omit for a point marker" }
    });
    if with_note {
        props["note"] = json!({ "type": "string" });
    }
    tool(
        "add_marker",
        description,
        json!({
            "type": "object",
            "properties": {
                "markers": {
                    "type": "array",
                    "items": { "type": "object", "properties": props, "required": ["atSec"] }
                }
            },
            "required": ["markers"]
        }),
    )
}

/// One entry of `add_text`'s `texts` array.
pub fn text_item() -> Value {
    json!({
        "type": "object",
        "properties": {
            "text": { "type": "string" },
            "start": { "type": "number", "description": "Seconds from the timeline start" },
            "end": { "type": "number", "description": "Seconds from the timeline start" }
        },
        "required": ["text", "start", "end"]
    })
}

/// The clip-picking fields shared by every tool that can change several
/// clips at once (`ClipTarget`), added to `props`.
pub fn clip_target_props(props: &mut Value) {
    let fields = json!({
        "clips": { "type": "array", "items": { "type": "string" }, "description": "Clip ids" },
        "tracks": { "type": "array", "items": { "type": "string" }, "description": "Every clip on these tracks, like [\"V1\"]" },
        "fromSec": { "type": "number", "description": "Clips touching this time or later" },
        "toSec": { "type": "number", "description": "Clips starting before this time" },
        "selected": { "type": "boolean", "description": "The clips selected in the editor" },
        "all": { "type": "boolean", "description": "Every clip" }
    });
    if let (Some(p), Some(f)) = (props.as_object_mut(), fields.as_object()) {
        p.extend(f.clone());
    }
}

/// How the clip-picking fields combine, for tool descriptions.
pub const CLIP_TARGET_DOC: &str = "Pick the clips with clips (ids), tracks, fromSec/toSec, selected (what the user \
     selected in the editor) or all: true; criteria combine (a clip must match all of them), so tracks [\"V1\"] \
     with fromSec 10 is every V1 clip from 10s on.";

/// `delete_clips`; `ripple` adds the close-the-gap flag.
pub fn delete_tool(editor_name: &str, ripple: bool) -> Value {
    let mut props = json!({
        "segmentIds": { "type": "array", "items": { "type": "string" } }
    });
    if ripple {
        props["ripple"] = json!({ "type": "boolean", "description": "Close the gap left behind" });
    }
    tool(
        "delete_clips",
        format!("Delete clips from the {} timeline by id.", editor_name),
        json!({ "type": "object", "properties": props, "required": ["segmentIds"] }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(tools: &[Value]) -> Vec<&str> {
        tools.iter().filter_map(|t| t["name"].as_str()).collect()
    }

    #[test]
    fn manual_mode_is_read_only() {
        assert_eq!(names(&tool_definitions(Editor::Davinci, false)), ["get_timeline", "get_transcript"]);
        assert_eq!(names(&tool_definitions(Editor::Capcut, false)), ["get_timeline", "get_transcript"]);
    }

    #[test]
    fn tools_follow_the_editor() {
        let davinci = tool_definitions(Editor::Davinci, true);
        let capcut = tool_definitions(Editor::Capcut, true);
        let premiere = tool_definitions(Editor::Premiere, true);
        let all = [
            "get_timeline", "get_transcript", "build_storyboard", "add_marker", "add_text", "update_clip",
            "delete_clips", "split_clips", "remove_ranges", "remove_marker", "apply_actions",
        ];
        assert_eq!(names(&davinci), all);
        assert_eq!(names(&capcut), all);
        assert_eq!(names(&premiere)[..10], all[..10]);
        assert_eq!(names(&premiere)[10..], ["add_effects", "add_transitions", "apply_actions"]);
        assert!(premiere[5]["inputSchema"]["properties"].get("tracks").is_some());
        let ripple = |tools: &[Value]| tools[6]["inputSchema"]["properties"].get("ripple").is_some();
        assert!(ripple(&davinci));
        assert!(!ripple(&capcut));
        assert!(capcut[5]["inputSchema"]["properties"].get("zoomEnd").is_some());
        assert!(davinci[5]["inputSchema"]["properties"].get("zoomEnd").is_none());
        assert!(davinci[5]["inputSchema"]["properties"].get("startSec").is_some());
        assert!(premiere[5]["inputSchema"]["properties"].get("volume").is_some());

        let snapshot = json!({
            "name": "Seq", "fps": 23.976, "durationSec": 8.0,
            "tracks": [
                { "trackType": "video", "index": 1, "clips": [
                    { "id": "a1", "name": "clip.mp4", "startSec": 0.0, "durationSec": 4.0, "zoom": 1.1 },
                    { "id": "a2", "name": "two.mp4", "startSec": 4.0, "durationSec": 4.0, "zoom": 1.0 }
                ] },
                { "trackType": "audio", "segments": [{ "id": "s1", "name": "boom.wav", "startSec": 0.5, "durationSec": 1.0 }] }
            ],
            "markers": [{ "atSec": 4.0, "color": "Green", "name": "Cut" }]
        });
        let text = timeline_text(&snapshot, &TimelineFilter::default());
        assert!(text.starts_with("Timeline \"Seq\", 23.976 fps, 8.00s long. Tracks: V1(2) A1(1)."), "{}", text);
        assert!(text.contains("\nV1 a1 0.00-4.00 clip.mp4 zoom=1.1\n"), "{}", text);
        assert!(text.contains("\nV1 a2 4.00-8.00 two.mp4\n"), "{}", text);
        assert!(text.contains("\nA1 s1 0.50-1.50 boom.wav"), "{}", text);
        assert!(text.ends_with("Markers: 4.00 Green \"Cut\""), "{}", text);

        // Only 3-5 s on V1: the clip ending at 4 and the one starting at 4,
        // the marker at 4, nothing from A1; the counts still cover everything.
        let part = timeline_text(&snapshot, &TimelineFilter::from_args(&json!({ "fromSec": 4.5, "tracks": ["v1"] })));
        assert!(part.contains("Tracks: V1(2) A1(1). Showing 1 of 3 clips (4.50-ends, V1)."), "{}", part);
        assert!(part.contains("\nV1 a2 4.00-8.00") && !part.contains("a1 0.00") && !part.contains("A1 s1"), "{}", part);
        assert!(!part.contains("Markers"), "{}", part);
        let early = timeline_text(&snapshot, &TimelineFilter::from_args(&json!({ "toSec": 4.0 })));
        assert!(early.contains("V1 a1 0.00-4.00") && early.contains("A1 s1") && !early.contains("a2 4.00"), "{}", early);
        let batch_tools = &davinci[10]["inputSchema"]["properties"]["actions"]["items"]["properties"]["tool"]["enum"];
        assert_eq!(batch_tools, &json!(all[2..10]));
    }
}
