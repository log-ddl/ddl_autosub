//! Timeline edits the AI Edit tab can make.
//!
//! This is the single place a timeline action runs, whether it came from the
//! MCP server (the agent calling a tool) or from the UI (the user clicking an
//! action card). It parses and validates the action, then hands it to the
//! editor the conversation is bound to (see `editors/`). Every action reports
//! a plain-text outcome so the agent can see what happened and correct itself.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ai_edit::editors::{capcut, davinci, premiere};

/// The editors AI Edit can drive. Adding one means a new module under
/// `editors/`, a variant here and an arm in each `match` below (and in
/// `mcp::tools::tool_definitions`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Editor {
    Davinci,
    Capcut,
    Premiere,
}

impl Editor {
    /// Name shown to the agent and the user.
    pub fn display_name(self) -> &'static str {
        match self {
            Editor::Davinci => "DaVinci Resolve",
            Editor::Capcut => "CapCut",
            Editor::Premiere => "Premiere Pro",
        }
    }
}

/// Which editor and project an AI Edit conversation works on.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditTarget {
    /// "davinci", "capcut" or "premiere"; any other value is rejected rather than routed
    /// to some editor by default.
    #[serde(rename = "integration")]
    pub editor: Editor,
    /// CapCut draft id; ignored for DaVinci and Premiere, which edit the open timeline.
    pub draft_id: Option<String>,
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

/// Fields `update_segment` may change. Each editor applies what it supports
/// and reports the rest as ignored.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentUpdate {
    pub segment_id: String,
    pub start_sec: Option<f64>,
    pub duration_sec: Option<f64>,
    pub zoom: Option<f64>,
    pub zoom_end: Option<f64>,
    pub pan_x: Option<f64>,
    pub pan_x_end: Option<f64>,
    pub pan_y: Option<f64>,
    pub pan_y_end: Option<f64>,
    pub rotation: Option<f64>,
    pub opacity: Option<f64>,
    pub volume: Option<f64>,
    pub text: Option<String>,
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
    UpdateSegment(SegmentUpdate),
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
    pub fn ok(message: impl Into<String>) -> Self {
        Self { message: message.into(), lines: Vec::new(), partial: false }
    }
}

/// The current timeline as JSON: tracks with their clips (id, name, start and
/// duration in seconds) and markers.
pub async fn timeline_snapshot(target: &EditTarget) -> Result<Value, String> {
    match target.editor {
        Editor::Davinci => davinci::timeline_snapshot().await,
        Editor::Capcut => capcut::timeline_snapshot(target.draft_id.clone()).await,
        Editor::Premiere => premiere::timeline_snapshot().await,
    }
}

pub async fn execute(target: &EditTarget, action: TimelineAction) -> Result<ActionOutcome, String> {
    let draft = target.draft_id.clone();
    match action {
        TimelineAction::BuildStoryboard { mode, target_video_track, audio_path, items } => {
            let track = target_video_track.unwrap_or(1).max(1);
            match target.editor {
                Editor::Davinci => davinci::build_storyboard(mode, track, audio_path, items).await,
                Editor::Capcut => capcut::build_storyboard(draft, mode, track, audio_path, items).await,
                Editor::Premiere => premiere::build_storyboard(mode, track, audio_path, items).await,
            }
        }
        TimelineAction::AddMarker { markers } => {
            if markers.is_empty() {
                return Err("add_marker needs at least one marker.".into());
            }
            match target.editor {
                Editor::Davinci => davinci::add_markers(markers).await,
                Editor::Capcut => capcut::add_markers(draft, markers).await,
                Editor::Premiere => premiere::add_markers(markers).await,
            }
        }
        TimelineAction::AddText { texts, template, track } => {
            let texts: Vec<TextSpec> = texts
                .into_iter()
                .filter(|t| !t.text.trim().is_empty() && t.end > t.start && t.start >= 0.0)
                .collect();
            if texts.is_empty() {
                return Err("add_text needs at least one text with a non-empty string and end > start >= 0.".into());
            }
            match target.editor {
                Editor::Davinci => davinci::add_text(texts, template, track).await,
                Editor::Capcut => capcut::add_text(draft, texts, template).await,
                Editor::Premiere => premiere::add_text(texts).await,
            }
        }
        TimelineAction::UpdateSegment(update) => match target.editor {
            Editor::Davinci => davinci::update_segment(update).await,
            Editor::Capcut => capcut::update_segment(draft, update).await,
            Editor::Premiere => premiere::update_segment(update).await,
        },
        TimelineAction::DeleteSegment { segment_id, mut segment_ids, ripple } => {
            if let Some(id) = segment_id {
                segment_ids.insert(0, id);
            }
            if segment_ids.is_empty() {
                return Err("delete_segment needs segmentId or segmentIds.".into());
            }
            match target.editor {
                Editor::Davinci => davinci::delete_segments(segment_ids, ripple).await,
                Editor::Capcut => capcut::delete_segments(draft, segment_ids).await,
                Editor::Premiere => premiere::delete_segments(segment_ids, ripple).await,
            }
        }
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
    use serde_json::json;

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
            TimelineAction::UpdateSegment(u) => {
                assert_eq!(u.segment_id, "s1");
                assert_eq!(u.zoom_end, Some(2.0));
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
    fn rejects_unsupported_editor() {
        // An editor without a backend must fail loudly, not fall through to Resolve.
        let ok: EditTarget = serde_json::from_value(json!({ "integration": "capcut", "draftId": "d" })).unwrap();
        assert_eq!(ok.editor, Editor::Capcut);
        assert!(serde_json::from_value::<EditTarget>(json!({ "integration": "aftereffects" })).is_err());
    }
}
