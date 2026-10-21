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

/// Which clips an edit applies to: the ones that match every criterion
/// given. `all` alone takes every clip. The app picks them from the
/// snapshot, so each editor only gets clip ids.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipTarget {
    #[serde(default)]
    pub clips: Vec<String>,
    /// Track labels as get_timeline prints them ("V1", "A2").
    #[serde(default)]
    pub tracks: Vec<String>,
    /// Clips touching [fromSec, toSec).
    pub from_sec: Option<f64>,
    pub to_sec: Option<f64>,
    /// Only the clips selected in the editor.
    #[serde(default)]
    pub selected: bool,
    #[serde(default)]
    pub all: bool,
}

impl ClipTarget {
    pub fn is_empty(&self) -> bool {
        !self.all
            && !self.selected
            && self.clips.is_empty()
            && self.tracks.is_empty()
            && self.from_sec.is_none()
            && self.to_sec.is_none()
    }

    /// Ids of the snapshot's clips that match, in track then time order.
    pub fn matching(&self, snapshot: &Value) -> Vec<String> {
        let tracks = upper(&self.tracks);
        snapshot_clips(snapshot)
            .into_iter()
            .filter(|c| {
                (self.clips.is_empty() || self.clips.iter().any(|id| id == &c.id))
                    && (tracks.is_empty() || tracks.contains(&c.label))
                    && self.from_sec.map_or(true, |f| c.end > f)
                    && self.to_sec.map_or(true, |t| c.start < t)
                    && (!self.selected || c.selected)
            })
            .map(|c| c.id)
            .collect()
    }
}

/// Which edit points `add_transitions` uses. A point is a join between two
/// touching clips on one track or, with `fades` (or when `clips` names the
/// clip), a clip edge with nothing next to it (a fade from or to black).
/// Every criterion given must match; `all` alone takes every join.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CutTarget {
    /// Points at these times (seconds, as get_timeline lists clip edges).
    #[serde(default)]
    pub at_sec: Vec<f64>,
    /// Joins between these pairs of clip ids.
    #[serde(default)]
    pub between: Vec<[String; 2]>,
    /// Edges of these clips; `edge` says which.
    #[serde(default)]
    pub clips: Vec<String>,
    /// "start", "end" or "both" (default) for `clips`.
    pub edge: Option<String>,
    /// Default: every video track, or every track when clips or between
    /// name the clips.
    #[serde(default)]
    pub tracks: Vec<String>,
    pub from_sec: Option<f64>,
    pub to_sec: Option<f64>,
    /// Also clip edges with nothing next to them.
    #[serde(default)]
    pub fades: bool,
    #[serde(default)]
    pub all: bool,
}

/// One place a transition goes: the start or end of a clip. A join is the
/// start of its right-hand clip, centred on the cut.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CutPoint {
    pub id: String,
    pub at_end: bool,
    pub at_sec: f64,
    pub track: String,
}

/// How far apart two clip edges may be and still count as touching, and how
/// far a point may sit from an atSec the agent gave (it reads 2 decimals).
const EDGE_TOLERANCE_SEC: f64 = 0.02;
const AT_TOLERANCE_SEC: f64 = 0.05;

impl CutTarget {
    pub fn is_empty(&self) -> bool {
        !self.all
            && self.at_sec.is_empty()
            && self.between.is_empty()
            && self.clips.is_empty()
            && self.tracks.is_empty()
            && self.from_sec.is_none()
            && self.to_sec.is_none()
    }

    pub fn matching(&self, snapshot: &Value) -> Vec<CutPoint> {
        let tracks = upper(&self.tracks);
        let named = !self.clips.is_empty() || !self.between.is_empty();
        let edge = self.edge.as_deref().unwrap_or("both").to_ascii_lowercase();
        let (want_start, want_end) = (edge != "end", edge != "start");
        let mut by_track: Vec<(String, Vec<SnapClip>)> = Vec::new();
        for clip in snapshot_clips(snapshot) {
            let keep = if tracks.is_empty() { named || clip.label.starts_with('V') } else { tracks.contains(&clip.label) };
            if !keep {
                continue;
            }
            match by_track.iter_mut().find(|(l, _)| *l == clip.label) {
                Some((_, list)) => list.push(clip),
                None => by_track.push((clip.label.clone(), vec![clip])),
            }
        }

        let mut out = Vec::new();
        for (label, mut clips) in by_track {
            clips.sort_by(|a, b| a.start.total_cmp(&b.start));
            for (i, clip) in clips.iter().enumerate() {
                let prev = i.checked_sub(1).map(|p| &clips[p]).filter(|p| (p.end - clip.start).abs() <= EDGE_TOLERANCE_SEC);
                let next = clips.get(i + 1).filter(|n| (n.start - clip.end).abs() <= EDGE_TOLERANCE_SEC);
                // The start of this clip: a join with `prev`, or a free edge.
                let start_ok = match prev {
                    Some(p) => self.keeps(clip.start, Some((&p.id, &clip.id)), &[(&p.id, false), (&clip.id, true)], want_start, want_end),
                    None => (self.fades || self.names(&clip.id)) && self.keeps(clip.start, None, &[(&clip.id, true)], want_start, want_end),
                };
                if start_ok {
                    out.push(CutPoint { id: clip.id.clone(), at_end: false, at_sec: clip.start, track: label.clone() });
                }
                // The end: a join is handled as the next clip's start.
                if next.is_none()
                    && (self.fades || self.names(&clip.id))
                    && self.keeps(clip.end, None, &[(&clip.id, false)], want_start, want_end)
                {
                    out.push(CutPoint { id: clip.id.clone(), at_end: true, at_sec: clip.end, track: label.clone() });
                }
            }
        }
        out
    }

    fn names(&self, id: &str) -> bool {
        self.clips.iter().any(|c| c == id)
    }

    /// Whether a point at `at` passes every criterion. `join` is its
    /// (left, right) pair; `sides` lists the clips it touches, each with
    /// whether the point is that clip's start.
    fn keeps(&self, at: f64, join: Option<(&String, &String)>, sides: &[(&String, bool)], want_start: bool, want_end: bool) -> bool {
        (self.at_sec.is_empty() || self.at_sec.iter().any(|a| (a - at).abs() <= AT_TOLERANCE_SEC))
            && self.from_sec.map_or(true, |f| at >= f - AT_TOLERANCE_SEC)
            && self.to_sec.map_or(true, |t| at <= t + AT_TOLERANCE_SEC)
            && (self.between.is_empty()
                || join.map_or(false, |(l, r)| {
                    self.between.iter().any(|[a, b]| (a == l && b == r) || (a == r && b == l))
                }))
            && (self.clips.is_empty()
                || sides.iter().any(|(id, is_start)| self.names(id) && if *is_start { want_start } else { want_end }))
    }
}

fn upper(labels: &[String]) -> Vec<String> {
    labels.iter().map(|t| t.trim().to_ascii_uppercase()).filter(|t| !t.is_empty()).collect()
}

/// Every track of a snapshot with the label get_timeline gives it ("V1",
/// "A2", "S1"): the editor's own index when it reports one, else counted per
/// kind in order.
pub fn track_labels(snapshot: &Value) -> Vec<(String, &Value)> {
    let mut counters: Vec<(char, usize)> = Vec::new();
    let mut out = Vec::new();
    for track in snapshot.get("tracks").and_then(|t| t.as_array()).into_iter().flatten() {
        let letter = match track.get("trackType").and_then(|k| k.as_str()).unwrap_or("") {
            "audio" => 'A',
            "subtitle" | "caption" => 'S',
            "text" => 'T',
            "effect" | "filter" | "sticker" => 'E',
            _ => 'V',
        };
        let index = match track.get("index").and_then(|i| i.as_u64()) {
            Some(i) => i as usize,
            None => match counters.iter_mut().find(|(c, _)| *c == letter) {
                Some((_, n)) => {
                    *n += 1;
                    *n
                }
                None => {
                    counters.push((letter, 1));
                    1
                }
            },
        };
        out.push((format!("{}{}", letter, index), track));
    }
    out
}

/// A track's clips, whichever key the editor uses for them.
pub fn track_clips(track: &Value) -> Vec<&Value> {
    ["clips", "segments"]
        .iter()
        .filter_map(|k| track.get(*k).and_then(|c| c.as_array()))
        .flatten()
        .collect()
}

#[derive(Debug, Clone)]
struct SnapClip {
    label: String,
    id: String,
    start: f64,
    end: f64,
    selected: bool,
}

fn snapshot_clips(snapshot: &Value) -> Vec<SnapClip> {
    let mut out = Vec::new();
    for (label, track) in track_labels(snapshot) {
        for clip in track_clips(track) {
            let Some(id) = clip.get("id").and_then(|v| v.as_str()) else { continue };
            let start = clip.get("startSec").and_then(|v| v.as_f64()).unwrap_or(0.0);
            out.push(SnapClip {
                label: label.clone(),
                id: id.to_string(),
                start,
                end: start + clip.get("durationSec").and_then(|v| v.as_f64()).unwrap_or(0.0),
                selected: clip.get("selected").and_then(|v| v.as_bool()).unwrap_or(false),
            });
        }
    }
    out
}

/// One effect for `add_effects`: its name in the editor's effect list and
/// the parameters to set, by their names in the effect's controls.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EffectSpec {
    pub name: String,
    #[serde(default)]
    pub params: serde_json::Map<String, Value>,
}

/// Keyframes on one property of a clip. `property` is "Scale",
/// "Opacity" or "<Effect>/<Parameter>" ("Gaussian Blur/Blurriness").
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyframeSpec {
    pub property: String,
    pub points: Vec<KeyPoint>,
    /// "linear", "ease" (default) or "hold".
    pub interpolation: Option<String>,
}

/// A keyframe `sec` seconds after the clip's start, or before its end with
/// `fromEnd`, so one spec fits clips of any length.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyPoint {
    pub sec: f64,
    pub value: Value,
    #[serde(default)]
    pub from_end: bool,
}

/// Fields `update_segment` may change. Each editor applies what it supports
/// and reports the rest as ignored.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentUpdate {
    /// One clip; or leave it empty and pick clips with the target fields.
    #[serde(default)]
    pub segment_id: String,
    #[serde(flatten)]
    pub target: ClipTarget,
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
    /// Playback speed, 2.0 = twice as fast. The clip's length changes with it.
    pub speed: Option<f64>,
    #[serde(default)]
    pub reverse: bool,
    #[serde(default)]
    pub keyframes: Vec<KeyframeSpec>,
}

impl SegmentUpdate {
    /// What it asks for that `editor` cannot do yet.
    fn unsupported(&self, editor: Editor) -> Option<&'static str> {
        if editor == Editor::Premiere {
            None
        } else if !self.target.is_empty() {
            Some("picking clips by clips/tracks/fromSec/selected/all")
        } else if !self.keyframes.is_empty() && editor != Editor::Capcut {
            Some("keyframes")
        } else if self.speed.is_some() || self.reverse {
            Some("speed and reverse")
        } else {
            None
        }
    }
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
    /// Delete the markers that match every criterion given; `all` deletes
    /// every marker. The app finds them in the snapshot, so each editor only
    /// deletes by position.
    #[serde(rename_all = "camelCase")]
    RemoveMarker {
        #[serde(default)]
        at_sec: Vec<f64>,
        from_sec: Option<f64>,
        to_sec: Option<f64>,
        color: Option<String>,
        name: Option<String>,
        #[serde(default)]
        all: bool,
    },
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
        /// Also close the gaps so later clips move left. Off unless asked for:
        /// a cut is only a cut, and closing the gap moves everything after it.
        #[serde(default)]
        ripple: bool,
        /// Only these tracks ("V1", "A1", as get_timeline labels them); all
        /// tracks when empty. "Cut the clip and its sound but keep the
        /// title" is one call instead of split, split, delete.
        #[serde(default)]
        tracks: Vec<String>,
    },
    /// Add effects (with their settings) to the clips `target` picks.
    #[serde(rename_all = "camelCase")]
    AddEffects {
        effects: Vec<EffectSpec>,
        #[serde(flatten)]
        target: ClipTarget,
    },
    /// Put a transition on the edit points `cuts` picks.
    #[serde(rename_all = "camelCase")]
    AddTransitions {
        /// Video transition name; default "Cross Dissolve".
        transition: Option<String>,
        /// For points on audio tracks; default "Constant Power".
        audio_transition: Option<String>,
        duration_sec: Option<f64>,
        #[serde(flatten)]
        cuts: CutTarget,
    },
}

impl TimelineAction {
    /// What can be checked without the timeline, so `apply_actions` refuses
    /// a bad entry before the first one runs.
    pub fn check(&self) -> Result<(), String> {
        match self {
            TimelineAction::UpdateSegment(u) if u.segment_id.is_empty() && u.target.is_empty() => {
                Err("needs segmentId, or clips/tracks/fromSec/toSec/selected/all".into())
            }
            TimelineAction::AddEffects { effects, target } if effects.is_empty() || target.is_empty() => {
                Err("needs effects and clips/tracks/fromSec/toSec/selected/all".into())
            }
            TimelineAction::AddTransitions { cuts, .. } if cuts.is_empty() => {
                Err("needs atSec, between, clips, tracks, fromSec/toSec or all".into())
            }
            _ => Ok(()),
        }
    }
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

/// Which markers `remove_marker` deletes.
struct MarkerCriteria {
    at_sec: Vec<f64>,
    from_sec: Option<f64>,
    to_sec: Option<f64>,
    color: Option<String>,
    name: Option<String>,
    all: bool,
}

/// How far a marker may sit from an atSec the agent gave (it reads times
/// rounded to 2 decimals).
const MARKER_TOLERANCE_SEC: f64 = 0.05;

impl MarkerCriteria {
    fn is_empty(&self) -> bool {
        !self.all
            && self.at_sec.is_empty()
            && self.from_sec.is_none()
            && self.to_sec.is_none()
            && self.color.as_deref().map_or(true, |c| c.trim().is_empty())
            && self.name.as_deref().map_or(true, |n| n.trim().is_empty())
    }

    /// Positions (seconds) of the snapshot's markers that match. Resolve and
    /// Premiere report atSec/name, CapCut startSec/title.
    fn matching(&self, snapshot: &Value) -> Vec<f64> {
        let text = |m: &Value, keys: &[&str]| {
            keys.iter().find_map(|k| m.get(*k).and_then(|v| v.as_str())).unwrap_or("").to_lowercase()
        };
        snapshot
            .get("markers")
            .and_then(|m| m.as_array())
            .into_iter()
            .flatten()
            .filter_map(|m| {
                let at = m.get("atSec").or_else(|| m.get("startSec")).and_then(|v| v.as_f64())?;
                if self.all {
                    return Some(at);
                }
                let keep = (self.at_sec.is_empty() || self.at_sec.iter().any(|a| (a - at).abs() <= MARKER_TOLERANCE_SEC))
                    && self.from_sec.map_or(true, |f| at >= f - MARKER_TOLERANCE_SEC)
                    && self.to_sec.map_or(true, |t| at < t)
                    && self.color.as_deref().map(str::trim).filter(|c| !c.is_empty())
                        .map_or(true, |c| text(m, &["color"]) == c.to_lowercase())
                    && self.name.as_deref().map(str::trim).filter(|n| !n.is_empty())
                        .map_or(true, |n| text(m, &["name", "title"]).contains(&n.to_lowercase()));
                keep.then_some(at)
            })
            .collect()
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
        TimelineAction::RemoveMarker { at_sec, from_sec, to_sec, color, name, all } => {
            let criteria = MarkerCriteria { at_sec, from_sec, to_sec, color, name, all };
            if criteria.is_empty() {
                return Err("remove_marker needs atSec, fromSec/toSec, color or name, or all: true.".into());
            }
            let snapshot = timeline_snapshot(target).await?;
            let positions = criteria.matching(&snapshot);
            if positions.is_empty() {
                return Ok(ActionOutcome::ok("No marker matched, nothing was removed."));
            }
            match target.editor {
                Editor::Davinci => davinci::delete_markers(positions).await,
                Editor::Capcut => capcut::delete_markers(draft, positions).await,
                Editor::Premiere => premiere::delete_markers(positions).await,
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
                Editor::Premiere => premiere::add_text(texts, template, track).await,
            }
        }
        TimelineAction::UpdateSegment(update) => {
            if target.editor != Editor::Premiere {
                if let Some(what) = update.unsupported(target.editor) {
                    return Err(format!("{} is not available in {} yet.", what, target.editor.display_name()));
                }
                if update.segment_id.is_empty() {
                    return Err("update_clip needs segmentId.".into());
                }
            }
            if update.speed.map_or(false, |s| !(s.is_finite() && s > 0.0 && s <= 100.0)) {
                return Err("speed must be above 0 (1.0 = normal, 2.0 = twice as fast).".into());
            }
            match target.editor {
                Editor::Davinci => davinci::update_segment(update).await,
                Editor::Capcut => capcut::update_segment(draft, update).await,
                Editor::Premiere => {
                    let ids = if !update.segment_id.is_empty() {
                        if !update.target.is_empty() {
                            return Err("update_clip takes segmentId or the clip picking fields, not both.".into());
                        }
                        vec![update.segment_id.clone()]
                    } else if update.target.is_empty() {
                        return Err("update_clip needs segmentId, or clips/tracks/fromSec/toSec/selected/all.".into());
                    } else {
                        let ids = update.target.matching(&timeline_snapshot(target).await?);
                        if ids.is_empty() {
                            return Ok(ActionOutcome::ok("No clip matched, nothing was changed."));
                        }
                        ids
                    };
                    if ids.len() > 1 && (update.start_sec.is_some() || update.duration_sec.is_some()) {
                        return Err("startSec and durationSec change one clip at a time; pass segmentId.".into());
                    }
                    premiere::update_clips(ids, update).await
                }
            }
        }
        TimelineAction::AddEffects { effects, target: clips } => {
            let effects: Vec<EffectSpec> = effects.into_iter().filter(|e| !e.name.trim().is_empty()).collect();
            if effects.is_empty() {
                return Err("add_effects needs at least one effect name.".into());
            }
            if clips.is_empty() {
                return Err("add_effects needs clips, tracks, fromSec/toSec, selected or all: true.".into());
            }
            if target.editor != Editor::Premiere {
                return Err(format!("add_effects is not available in {} yet.", target.editor.display_name()));
            }
            let ids = clips.matching(&timeline_snapshot(target).await?);
            if ids.is_empty() {
                return Ok(ActionOutcome::ok("No clip matched, no effect was added."));
            }
            premiere::add_effects(ids, effects).await
        }
        TimelineAction::AddTransitions { transition, audio_transition, duration_sec, cuts } => {
            if cuts.is_empty() {
                return Err("add_transitions needs atSec, between, clips, tracks, fromSec/toSec or all: true.".into());
            }
            let duration = duration_sec.unwrap_or(0.5);
            if !(duration.is_finite() && duration > 0.0) {
                return Err("durationSec must be above 0.".into());
            }
            if target.editor != Editor::Premiere {
                return Err(format!("add_transitions is not available in {} yet.", target.editor.display_name()));
            }
            let points = cuts.matching(&timeline_snapshot(target).await?);
            if points.is_empty() {
                return Ok(ActionOutcome::ok(
                    "No edit point matched, no transition was added. A join needs two touching clips on one \
                     track; pass fades: true (or name the clip in clips) for a clip edge next to a gap.",
                ));
            }
            premiere::add_transitions(points, transition, audio_transition, duration).await
        }
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
        TimelineAction::RemoveRanges { ranges, ripple, tracks } => {
            let tracks: Vec<String> =
                tracks.iter().map(|t| t.trim().to_ascii_uppercase()).filter(|t| !t.is_empty()).collect();
            let ranges = normalize_ranges(&ranges);
            if ranges.is_empty() {
                return Err("remove_ranges needs at least one range with end > start >= 0.".into());
            }
            match target.editor {
                Editor::Davinci => davinci::remove_ranges(ranges, ripple, tracks).await,
                Editor::Capcut => capcut::remove_ranges(draft, ranges, ripple, tracks).await,
                Editor::Premiere => premiere::remove_ranges(ranges, ripple, tracks).await,
            }
        }
    }
}

#[tauri::command]
pub async fn ai_edit_execute_action(
    app: tauri::AppHandle,
    target: EditTarget,
    mut action: Value,
    workspace: Option<String>,
) -> Result<ActionOutcome, String> {
    // Manual runs place media the same way Turbo does: copied into the
    // project's media/ folder first (see `assets::import_external`).
    if let Some(ws) = workspace.as_deref().map(str::trim).filter(|w| !w.is_empty()) {
        let library = crate::ai_cli::workspace::library_root(&app).ok();
        crate::ai_edit::mcp::tools::assets::import_external(std::path::Path::new(ws), library.as_deref(), &mut action)?;
    }
    let action: TimelineAction =
        serde_json::from_value(action).map_err(|e| format!("Invalid timeline action: {}", e))?;
    action.check().map_err(|e| format!("Invalid timeline action: {}", e))?;
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
            TimelineAction::RemoveRanges { ranges, ripple, .. } => {
                assert_eq!(ranges.len(), 1);
                assert!(!ripple, "a cut leaves the gap unless ripple is asked for");
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
    fn picks_markers_to_remove() {
        let snapshot = serde_json::json!({ "markers": [
            { "atSec": 4.0, "color": "Green", "name": "Scene 2" },
            { "atSec": 8.0, "color": "Red", "name": "Scene 3" },
            { "startSec": 12.0, "color": "#00c1cd", "title": "Marker 01" }
        ] });
        let c = |v: Value| match serde_json::from_value::<TimelineAction>(v).unwrap() {
            TimelineAction::RemoveMarker { at_sec, from_sec, to_sec, color, name, all } => {
                MarkerCriteria { at_sec, from_sec, to_sec, color, name, all }
            }
            _ => unreachable!(),
        };
        let pick = |v: Value| c(v).matching(&snapshot);
        assert_eq!(pick(serde_json::json!({ "action": "remove_marker", "atSec": [7.99] })), vec![8.0]);
        assert_eq!(pick(serde_json::json!({ "action": "remove_marker", "color": "green" })), vec![4.0]);
        assert_eq!(pick(serde_json::json!({ "action": "remove_marker", "fromSec": 5, "toSec": 20 })), vec![8.0, 12.0]);
        assert_eq!(pick(serde_json::json!({ "action": "remove_marker", "name": "marker" })), vec![12.0]);
        assert_eq!(pick(serde_json::json!({ "action": "remove_marker", "all": true })).len(), 3);
        assert!(c(serde_json::json!({ "action": "remove_marker" })).is_empty());
    }

    fn snapshot() -> Value {
        json!({ "tracks": [
            { "trackType": "video", "index": 1, "clips": [
                { "id": "a", "startSec": 0.0, "durationSec": 4.0 },
                { "id": "b", "startSec": 4.0, "durationSec": 4.0, "selected": true },
                { "id": "c", "startSec": 10.0, "durationSec": 2.0 }
            ] },
            { "trackType": "video", "index": 2, "clips": [
                { "id": "t", "startSec": 2.0, "durationSec": 3.0 }
            ] },
            { "trackType": "audio", "index": 1, "clips": [
                { "id": "x", "startSec": 0.0, "durationSec": 4.0 },
                { "id": "y", "startSec": 4.0, "durationSec": 8.0 }
            ] }
        ] })
    }

    #[test]
    fn picks_clips() {
        let pick = |v: Value| serde_json::from_value::<ClipTarget>(v).unwrap().matching(&snapshot());
        assert_eq!(pick(json!({ "clips": ["b"] })), vec!["b"]);
        assert_eq!(pick(json!({ "tracks": ["v1"] })), vec!["a", "b", "c"]);
        assert_eq!(pick(json!({ "fromSec": 3, "toSec": 5, "tracks": ["V1", "V2"] })), vec!["a", "b", "t"]);
        assert_eq!(pick(json!({ "selected": true })), vec!["b"]);
        assert_eq!(pick(json!({ "all": true })).len(), 6);
        assert!(serde_json::from_value::<ClipTarget>(json!({})).unwrap().is_empty());
    }

    #[test]
    fn picks_cuts() {
        let pick = |v: Value| {
            serde_json::from_value::<CutTarget>(v)
                .unwrap()
                .matching(&snapshot())
                .into_iter()
                .map(|p| format!("{}{}@{}", p.id, if p.at_end { ">" } else { "<" }, p.at_sec))
                .collect::<Vec<_>>()
        };
        // Joins only, video tracks only, unless asked otherwise.
        assert_eq!(pick(json!({ "all": true })), vec!["b<@4"]);
        assert_eq!(pick(json!({ "all": true, "tracks": ["A1"] })), vec!["y<@4"]);
        assert_eq!(pick(json!({ "atSec": [4.01] })), vec!["b<@4"]);
        assert_eq!(pick(json!({ "between": [["b", "a"]] })), vec!["b<@4"]);
        assert_eq!(
            pick(json!({ "all": true, "fades": true, "tracks": ["V1"] })),
            vec!["a<@0", "b<@4", "b>@8", "c<@10", "c>@12"]
        );
        // A named clip gets its edges, joins or not.
        assert_eq!(pick(json!({ "clips": ["c"] })), vec!["c<@10", "c>@12"]);
        assert_eq!(pick(json!({ "clips": ["a"], "edge": "end" })), vec!["b<@4"]);
        assert_eq!(pick(json!({ "clips": ["a"], "edge": "start" })), vec!["a<@0"]);
        assert_eq!(pick(json!({ "fromSec": 5, "all": true })), Vec::<String>::new());
    }

    #[test]
    fn parses_effect_actions() {
        match parse(json!({
            "action": "add_effects", "tracks": ["V1"],
            "effects": [{ "name": "Gaussian Blur", "params": { "Blurriness": 20 } }]
        })) {
            TimelineAction::AddEffects { effects, target } => {
                assert_eq!(effects[0].params["Blurriness"], json!(20));
                assert_eq!(target.tracks, vec!["V1"]);
            }
            other => panic!("{:?}", other),
        }
        match parse(json!({ "action": "add_transitions", "between": [["a", "b"]], "durationSec": 1 })) {
            TimelineAction::AddTransitions { cuts, duration_sec, transition, .. } => {
                assert_eq!(cuts.between.len(), 1);
                assert_eq!(duration_sec, Some(1.0));
                assert!(transition.is_none());
            }
            other => panic!("{:?}", other),
        }
        match parse(json!({
            "action": "update_segment", "all": true, "speed": 2,
            "keyframes": [{ "property": "Opacity", "points": [{ "sec": 0, "value": 0 }, { "sec": 1, "value": 100 }] }]
        })) {
            TimelineAction::UpdateSegment(u) => {
                assert!(u.segment_id.is_empty());
                assert!(u.target.all);
                assert_eq!(u.speed, Some(2.0));
                assert_eq!(u.keyframes[0].points.len(), 2);
                assert_eq!(u.unsupported(Editor::Capcut), Some("picking clips by clips/tracks/fromSec/selected/all"));
                assert_eq!(u.unsupported(Editor::Premiere), None);
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
        assert!(ok.transcript_file.is_none());
        assert!(serde_json::from_value::<EditTarget>(json!({ "integration": "aftereffects" })).is_err());
    }
}
