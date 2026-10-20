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
    /// Transcript open in the app (a file in the Transcripts folder), which
    /// `get_transcript` reads when the agent names none.
    #[serde(default)]
    pub transcript_file: Option<String>,
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

/// A span of the timeline, in seconds from its start.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
pub struct TimeRange {
    pub start: f64,
    pub end: f64,
}

/// Sort `ranges`, drop empty or invalid ones and merge overlapping ones, so
/// every editor gets disjoint spans in timeline order.
pub fn normalize_ranges(ranges: &[TimeRange]) -> Vec<TimeRange> {
    let mut valid: Vec<TimeRange> = ranges
        .iter()
        .filter(|r| r.start.is_finite() && r.end.is_finite())
        .map(|r| TimeRange { start: r.start.max(0.0), end: r.end })
        .filter(|r| r.end > r.start)
        .collect();
    valid.sort_by(|a, b| a.start.total_cmp(&b.start));
    let mut merged: Vec<TimeRange> = Vec::new();
    for r in valid {
        match merged.last_mut() {
            Some(last) if r.start <= last.end => last.end = last.end.max(r.end),
            _ => merged.push(r),
        }
    }
    merged
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
    /// Cut clips in two at `at_sec`: the given clips, or every clip under it.
    #[serde(rename_all = "camelCase")]
    SplitClips {
        at_sec: f64,
        #[serde(default)]
        segment_ids: Vec<String>,
    },
    /// Cut out time spans on every track (silences, filler words, a bad take).
    #[serde(rename_all = "camelCase")]
    RemoveRanges {
        ranges: Vec<TimeRange>,
        /// Close the gaps so later clips move left (default true).
        #[serde(default = "default_true")]
        ripple: bool,
    },
}

fn default_true() -> bool {
    true
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

    /// The result of a `build_storyboard`: one count line, plus only the
    /// lines about something that went wrong. Per-clip "placed at frame N"
    /// lines are dropped; on a long edit they would flood the agent's context
    /// with nothing it needs to act on.
    pub fn placed(editor: Editor, track: usize, appended: u64, requested: u64, lines: Vec<String>) -> Self {
        const PROBLEMS: &[&str] = &["skipped", "could not", "warning", "refused", "no free", "failed", "missing"];
        let lines: Vec<String> = lines
            .into_iter()
            .filter(|l| {
                let l = l.to_ascii_lowercase();
                PROBLEMS.iter().any(|p| l.contains(p))
            })
            .collect();
        Self {
            message: format!(
                "Placed {}/{} item(s) in {} (picture from V{}, audio files on free audio tracks).",
                appended,
                requested,
                editor.display_name(),
                track
            ),
            partial: appended < requested,
            lines,
        }
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
        TimelineAction::SplitClips { at_sec, segment_ids } => {
            if !at_sec.is_finite() || at_sec <= 0.0 {
                return Err("split_clips needs atSec > 0 (seconds from the timeline start).".into());
            }
            match target.editor {
                Editor::Davinci => davinci::split_clips(at_sec, segment_ids).await,
                Editor::Capcut => capcut::split_clips(draft, at_sec, segment_ids).await,
                Editor::Premiere => premiere::split_clips(at_sec, segment_ids).await,
            }
        }
        TimelineAction::RemoveRanges { ranges, ripple } => {
            let ranges = normalize_ranges(&ranges);
            if ranges.is_empty() {
                return Err("remove_ranges needs at least one range with end > start >= 0.".into());
            }
            match target.editor {
                Editor::Davinci => davinci::remove_ranges(ranges, ripple).await,
                Editor::Capcut => capcut::remove_ranges(draft, ranges, ripple).await,
                Editor::Premiere => premiere::remove_ranges(ranges, ripple).await,
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
    fn parses_cut_actions() {
        match parse(json!({ "action": "split_clips", "atSec": 12.5 })) {
            TimelineAction::SplitClips { at_sec, segment_ids } => {
                assert_eq!(at_sec, 12.5);
                assert!(segment_ids.is_empty());
            }
            other => panic!("{:?}", other),
        }
        match parse(json!({ "action": "remove_ranges", "ranges": [{ "start": 1, "end": 2 }] })) {
            TimelineAction::RemoveRanges { ranges, ripple } => {
                assert_eq!(ranges.len(), 1);
                assert!(ripple, "ripple defaults to true");
            }
            other => panic!("{:?}", other),
        }
    }

    #[test]
    fn normalizes_ranges() {
        let r = |start, end| TimeRange { start, end };
        let out = normalize_ranges(&[r(5.0, 6.0), r(1.0, 2.0), r(1.5, 3.0), r(4.0, 4.0), r(-1.0, 0.5)]);
        assert_eq!(out, vec![r(0.0, 0.5), r(1.0, 3.0), r(5.0, 6.0)]);
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
        assert!(ok.transcript_file.is_none());
        assert!(serde_json::from_value::<EditTarget>(json!({ "integration": "aftereffects" })).is_err());
    }
}
