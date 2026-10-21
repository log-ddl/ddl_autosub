//! Titles AI Edit placed in Resolve, remembered so a cut can re-create them.
//!
//! Resolve cuts by rebuilding a clip from its media pool item, and a Text+
//! title has none, so a cut that crosses a title used to leave it whole. Its
//! text cannot be read back either (reading a Fusion input from the bridge
//! loop deadlocks Resolve). So every title `add_text` places is recorded here
//! with its text, template and track, keyed by its TimelineItem id; a cut or
//! split that leaves one of them whole deletes it and places the pieces with
//! the same text. Titles the user made by hand stay as they were.
//!
//! Kept in `<data_local_dir>/com.autosubs/ai-edit-titles.json` so it survives
//! restarts; ids are Resolve UUIDs, unique across timelines.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ai_edit::actions::TimeRange;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Title {
    pub text: String,
    pub template: String,
    pub track: Option<u64>,
}

static TITLES: Lazy<Mutex<Option<HashMap<String, Title>>>> = Lazy::new(|| Mutex::new(None));

fn store_path() -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| d.join("com.autosubs").join("ai-edit-titles.json"))
}

fn with_titles<T>(f: impl FnOnce(&mut HashMap<String, Title>) -> T) -> T {
    let mut guard = TITLES.lock().unwrap_or_else(|e| e.into_inner());
    let titles = guard.get_or_insert_with(|| {
        store_path()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    });
    f(titles)
}

fn save(titles: &HashMap<String, Title>) {
    if let (Some(path), Ok(text)) = (store_path(), serde_json::to_string(titles)) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, text);
    }
}

/// Record the titles an AddSubtitles reply says it placed (`items`).
pub fn remember(reply: &Value, template: &str) {
    let Some(items) = reply.get("items").and_then(|i| i.as_array()) else { return };
    with_titles(|titles| {
        for item in items {
            let (Some(id), Some(text)) = (item.get("id").and_then(|v| v.as_str()), item.get("text").and_then(|v| v.as_str()))
            else {
                continue;
            };
            titles.insert(
                id.to_string(),
                Title { text: text.to_string(), template: template.to_string(), track: item.get("track").and_then(|t| t.as_u64()) },
            );
        }
        save(titles);
    });
}

pub fn get(id: &str) -> Option<Title> {
    with_titles(|titles| titles.get(id).cloned())
}

pub fn forget(id: &str) {
    with_titles(|titles| {
        if titles.remove(id).is_some() {
            save(titles);
        }
    });
}

/// A clip a cut or split could not rebuild, as the Lua side reports it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeftClip {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub track: u64,
    pub start_sec: f64,
    pub end_sec: f64,
    #[serde(default)]
    pub reason: String,
}

pub fn left_clips(reply: &Value) -> Vec<LeftClip> {
    reply
        .get("left")
        .and_then(|l| serde_json::from_value(l.clone()).ok())
        .unwrap_or_default()
}

/// What remains of [start, end) once `ranges` are cut out, in timeline
/// order, as (start, end). With ripple the later pieces move left by what
/// was removed before them, so pieces that end up touching are merged.
pub fn kept_after_cut(start: f64, end: f64, ranges: &[TimeRange], ripple: bool) -> Vec<(f64, f64)> {
    let removed_before = |t: f64| -> f64 { ranges.iter().map(|r| (r.end.min(t) - r.start).max(0.0)).sum() };
    let mut pieces = Vec::new();
    let mut cursor = start;
    for r in ranges {
        if r.end <= cursor || r.start >= end {
            continue;
        }
        if r.start > cursor {
            pieces.push((cursor, r.start));
        }
        cursor = cursor.max(r.end);
    }
    if cursor < end {
        pieces.push((cursor, end));
    }
    let mut out: Vec<(f64, f64)> = Vec::new();
    for (a, b) in pieces {
        let (a, b) = if ripple { (a - removed_before(a), b - removed_before(a)) } else { (a, b) };
        match out.last_mut() {
            Some(last) if (a - last.1).abs() < 1e-6 => last.1 = b,
            _ => out.push((a, b)),
        }
    }
    out.retain(|(a, b)| b - a > 1e-3);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(start: f64, end: f64) -> TimeRange {
        TimeRange { start, end }
    }

    #[test]
    fn cuts_a_title_around_the_span() {
        // Title 18-25, cut 20-22: two pieces in place, or one shorter title
        // when the gap closes.
        assert_eq!(kept_after_cut(18.0, 25.0, &[r(20.0, 22.0)], false), vec![(18.0, 20.0), (22.0, 25.0)]);
        assert_eq!(kept_after_cut(18.0, 25.0, &[r(20.0, 22.0)], true), vec![(18.0, 23.0)]);
        // A span over the title's start trims it.
        assert_eq!(kept_after_cut(18.0, 25.0, &[r(10.0, 19.0)], false), vec![(19.0, 25.0)]);
        assert_eq!(kept_after_cut(18.0, 25.0, &[r(10.0, 19.0)], true), vec![(10.0, 16.0)]);
        // Two spans, ripple: 18-20 stays, 22-23 moves to 20-21, 24-25 to 21-22.
        assert_eq!(kept_after_cut(18.0, 25.0, &[r(20.0, 22.0), r(23.0, 24.0)], true), vec![(18.0, 22.0)]);
        // Wholly inside: nothing left.
        assert!(kept_after_cut(20.5, 21.5, &[r(20.0, 22.0)], false).is_empty());
    }

    #[test]
    fn reads_left_clips() {
        let reply = serde_json::json!({ "left": [
            { "id": "a", "name": "Text+", "kind": "video", "track": 2, "startSec": 18.0, "endSec": 25.0, "reason": "title" }
        ] });
        let left = left_clips(&reply);
        assert_eq!(left.len(), 1);
        assert_eq!((left[0].track, left[0].start_sec, left[0].end_sec), (2, 18.0, 25.0));
        assert!(left_clips(&serde_json::json!({})).is_empty());
    }
}
