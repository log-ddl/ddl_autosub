//! MCP tool definitions. The schemas shared by every editor live here; each
//! editor module (`editors/*.rs`) assembles its own list from them in
//! `edit_tools()`, so the agent only sees what that editor supports.

use serde_json::{json, Value};

use crate::ai_edit::actions::Editor;
use crate::ai_edit::editors::{capcut, davinci, premiere};

pub fn tool(name: &str, description: impl Into<String>, schema: Value) -> Value {
    json!({ "name": name, "description": description.into(), "inputSchema": schema })
}

/// The tools for one session: `get_timeline` always, the edit tools only when
/// the run may edit (Turbo).
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
    )];
    if allow_edits {
        tools.extend(match editor {
            Editor::Davinci => davinci::edit_tools(),
            Editor::Capcut => capcut::edit_tools(),
            Editor::Premiere => premiere::edit_tools(),
        });
    }
    tools
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
        assert_eq!(names(&tool_definitions(Editor::Davinci, false)), ["get_timeline"]);
        assert_eq!(names(&tool_definitions(Editor::Capcut, false)), ["get_timeline"]);
    }

    #[test]
    fn tools_follow_the_editor() {
        let davinci = tool_definitions(Editor::Davinci, true);
        let capcut = tool_definitions(Editor::Capcut, true);
        let premiere = tool_definitions(Editor::Premiere, true);
        let all = ["get_timeline", "build_storyboard", "add_marker", "add_text", "update_clip", "delete_clips"];
        assert_eq!(names(&davinci), all);
        assert_eq!(names(&capcut), all);
        assert_eq!(names(&premiere), all);
        let ripple = |tools: &[Value]| tools[5]["inputSchema"]["properties"].get("ripple").is_some();
        assert!(ripple(&davinci));
        assert!(!ripple(&capcut));
        assert!(capcut[4]["inputSchema"]["properties"].get("zoomEnd").is_some());
        assert!(davinci[4]["inputSchema"]["properties"].get("zoomEnd").is_none());
    }
}
