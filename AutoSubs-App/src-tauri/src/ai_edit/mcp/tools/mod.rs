//! MCP tool definitions. The schemas shared by every editor live here; each
//! editor module (`editors/*.rs`) assembles its own list from them in
//! `edit_tools()`, so the agent only sees what that editor supports.

pub mod media;
pub mod transcript;

use serde_json::{json, Value};

use crate::ai_edit::actions::Editor;
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
            "Read the open {} timeline: tracks with every clip (id, name, start and duration in seconds{}) \
             and the markers. Call it when you need clip ids. Edit tools already report what they did, so \
             only re-read after an edit that failed or was partial.",
            editor.display_name(),
            snapshot_fields
        ),
        json!({ "type": "object", "properties": {} }),
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
             get new ids: call get_timeline before editing one of them.{}",
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
            "Cut time spans out of the {} timeline on every track: silences, filler words, a bad take. \
             Clips crossing a span are split at its edges and the part inside is deleted. With ripple \
             (the default) everything after moves left to close the gap, so give all spans in one call, \
             in the timeline's current times, and re-read times with get_timeline/get_transcript before \
             a second call.{}",
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
                "ripple": { "type": "boolean", "description": "Close the gaps (default true)" }
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
             a free track above), append (after the last clip). Tracks are created as needed.{}",
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
                            "path": { "type": "string", "description": "Absolute file path" },
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
            "delete_clips", "split_clips", "remove_ranges", "apply_actions",
        ];
        assert_eq!(names(&davinci), all);
        assert_eq!(names(&capcut), all);
        assert_eq!(names(&premiere), all);
        let ripple = |tools: &[Value]| tools[6]["inputSchema"]["properties"].get("ripple").is_some();
        assert!(ripple(&davinci));
        assert!(!ripple(&capcut));
        assert!(capcut[5]["inputSchema"]["properties"].get("zoomEnd").is_some());
        assert!(davinci[5]["inputSchema"]["properties"].get("zoomEnd").is_none());
        assert!(davinci[5]["inputSchema"]["properties"].get("startSec").is_some());
        assert!(premiere[5]["inputSchema"]["properties"].get("volume").is_some());
        let batch_tools = &davinci[9]["inputSchema"]["properties"]["actions"]["items"]["properties"]["tool"]["enum"];
        assert_eq!(batch_tools, &json!(all[2..9]));
    }
}
