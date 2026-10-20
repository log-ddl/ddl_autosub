//! Razor cuts on a CapCut draft: split segments at a time, and cut time spans
//! out of every track (with or without closing the gaps).
//!
//! A cut segment becomes several segments over the same material. The first
//! piece keeps the original segment (and its id); each further piece is a
//! copy with a new id and its own copies of the per-segment materials in
//! `extra_material_refs` (speed, canvas, sound channel mapping, ...), the way
//! CapCut's own split leaves them. Times here are microseconds.

use std::fs;

use serde::Serialize;
use serde_json::{json, Value};

use crate::capcut::bridge::{capcut_get_status, new_id, save_draft_json, US_PER_SEC};

/// What a cut did, for the agent.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CutStats {
    /// Segments cut in two (or more).
    pub split: usize,
    /// Segments that were entirely inside a removed span.
    pub removed: usize,
    /// Segments moved left to close a gap.
    pub shifted: usize,
    /// Markers dropped because they sat inside a removed span.
    pub markers_removed: usize,
}

fn range_of(seg: &Value, key: &str) -> Option<(i64, i64)> {
    let r = seg.get(key)?;
    Some((r.get("start")?.as_i64()?, r.get("duration")?.as_i64()?))
}

fn target_span(seg: &Value) -> (i64, i64) {
    let (start, dur) = range_of(seg, "target_timerange").unwrap_or((0, 0));
    (start, start + dur)
}

/// Copy the material `id` (wherever it lives under `materials`) under a new
/// id, and return that id; `None` when no material has it.
fn clone_material(materials: &mut Value, id: &str) -> Option<String> {
    let lists = materials.as_object_mut()?;
    for list in lists.values_mut() {
        let Some(items) = list.as_array_mut() else { continue };
        if let Some(found) = items.iter().find(|m| m.get("id").and_then(|x| x.as_str()) == Some(id)) {
            let mut copy = found.clone();
            let fresh = new_id();
            copy["id"] = json!(fresh);
            items.push(copy);
            return Some(fresh);
        }
    }
    None
}

/// The part of `seg` from `offset` to `offset + len` (both relative to its
/// start on the timeline), with keyframes moved to match. `fresh` gives it a
/// new id and its own extra materials.
fn piece(seg: &Value, materials: &mut Value, offset: i64, len: i64, fresh: bool) -> Value {
    let mut p = seg.clone();
    let (start, _) = target_span(seg);
    p["target_timerange"] = json!({ "start": start + offset, "duration": len });
    if let Some((src_start, _)) = range_of(seg, "source_timerange") {
        let speed = seg.get("speed").and_then(|v| v.as_f64()).filter(|s| *s > 0.0).unwrap_or(1.0);
        p["source_timerange"] = json!({
            "start": src_start + (offset as f64 * speed).round() as i64,
            "duration": (len as f64 * speed).round() as i64,
        });
    }
    // Keyframe offsets count from the segment start: keep the ones inside the
    // piece, measured from its own start.
    if let Some(groups) = p.get_mut("common_keyframes").and_then(|k| k.as_array_mut()) {
        for group in groups.iter_mut() {
            if let Some(list) = group.get_mut("keyframe_list").and_then(|k| k.as_array_mut()) {
                list.retain(|kf| {
                    let t = kf.get("time_offset").and_then(|v| v.as_i64()).unwrap_or(0);
                    t >= offset && t <= offset + len
                });
                for kf in list.iter_mut() {
                    let t = kf.get("time_offset").and_then(|v| v.as_i64()).unwrap_or(0);
                    kf["time_offset"] = json!(t - offset);
                }
            }
        }
    }
    if fresh {
        p["id"] = json!(new_id());
        if let Some(refs) = seg.get("extra_material_refs").and_then(|r| r.as_array()) {
            let copied: Vec<Value> = refs
                .iter()
                .map(|r| match r.as_str().and_then(|id| clone_material(materials, id)) {
                    Some(fresh_id) => json!(fresh_id),
                    None => r.clone(),
                })
                .collect();
            p["extra_material_refs"] = json!(copied);
        }
    }
    p
}

/// `seg` cut down to the absolute spans in `keep` (sorted, inside the
/// segment). Spans shorter than `min_len` are dropped.
fn keep_pieces(seg: &Value, materials: &mut Value, keep: &[(i64, i64)], min_len: i64) -> Vec<Value> {
    let (start, end) = target_span(seg);
    let keep: Vec<(i64, i64)> = keep
        .iter()
        .map(|&(a, b)| (a.max(start), b.min(end)))
        .filter(|&(a, b)| b - a >= min_len)
        .collect();
    if keep == [(start, end)] {
        return vec![seg.clone()];
    }
    keep.iter()
        .enumerate()
        .map(|(i, &(a, b))| piece(seg, materials, a - start, b - a, i > 0))
        .collect()
}

/// Microseconds removed before `t` by the sorted, disjoint `ranges`.
fn removed_before(ranges: &[(i64, i64)], t: i64) -> i64 {
    ranges.iter().map(|&(a, b)| (b.min(t) - a).max(0)).sum()
}

/// Half a frame: pieces shorter than this are rounding left-overs.
fn min_piece_us(info: &Value) -> i64 {
    let fps = info.get("fps").and_then(|v| v.as_f64()).filter(|f| *f > 0.0).unwrap_or(30.0);
    (US_PER_SEC / fps / 2.0) as i64
}

/// Apply `cut` to every segment of every track (tracks stay in place, each
/// one's segments are re-sorted by start).
fn for_each_segment(info: &mut Value, mut cut: impl FnMut(&Value, &mut Value) -> Vec<Value>) {
    let mut tracks = info["tracks"].take();
    if !info["materials"].is_object() {
        info["materials"] = json!({});
    }
    if let Some(list) = tracks.as_array_mut() {
        for track in list.iter_mut() {
            let Some(segs) = track.get_mut("segments").and_then(|s| s.as_array_mut()) else { continue };
            let mut out = Vec::with_capacity(segs.len());
            for seg in segs.iter() {
                out.extend(cut(seg, &mut info["materials"]));
            }
            out.sort_by_key(|s| target_span(s).0);
            *segs = out;
        }
    }
    info["tracks"] = tracks;
}

/// Split the segments in `ids` (or every segment, when empty) that span `at`.
pub fn split_at(info: &mut Value, at: i64, ids: &[String]) -> CutStats {
    let min_len = min_piece_us(info);
    let mut stats = CutStats::default();
    for_each_segment(info, |seg, materials| {
        let id = seg.get("id").and_then(|x| x.as_str()).unwrap_or("");
        let (start, end) = target_span(seg);
        let wanted = ids.is_empty() || ids.iter().any(|w| w == id);
        if !wanted || at - start < min_len || end - at < min_len {
            return vec![seg.clone()];
        }
        stats.split += 1;
        keep_pieces(seg, materials, &[(start, at), (at, end)], min_len)
    });
    stats
}

/// Cut `ranges` (sorted, disjoint, microseconds) out of every track. With
/// `ripple`, later segments and markers move left by the time removed before
/// them, so every track stays in sync.
pub fn remove_ranges(info: &mut Value, ranges: &[(i64, i64)], ripple: bool) -> CutStats {
    let min_len = min_piece_us(info);
    let mut stats = CutStats::default();
    for_each_segment(info, |seg, materials| {
        let (start, end) = target_span(seg);
        // What survives of [start, end] once every range is taken out.
        let mut keep = Vec::new();
        let mut cursor = start;
        for &(a, b) in ranges {
            if b <= cursor || a >= end {
                continue;
            }
            if a > cursor {
                keep.push((cursor, a));
            }
            cursor = cursor.max(b);
        }
        if cursor < end {
            keep.push((cursor, end));
        }
        let mut pieces = keep_pieces(seg, materials, &keep, min_len);
        if pieces.is_empty() {
            stats.removed += 1;
        } else if pieces.len() > 1 || keep != [(start, end)] {
            stats.split += 1;
        }
        if ripple {
            for p in pieces.iter_mut() {
                let (s, _) = target_span(p);
                let shift = removed_before(ranges, s);
                if shift > 0 {
                    p["target_timerange"]["start"] = json!(s - shift);
                    stats.shifted += 1;
                }
            }
        }
        pieces
    });

    if ripple {
        if let Some(marks) = info
            .get_mut("time_marks")
            .and_then(|t| t.get_mut("mark_items"))
            .and_then(|m| m.as_array_mut())
        {
            let before = marks.len();
            marks.retain(|m| {
                let t = m.get("time_range").and_then(|r| r.get("start")).and_then(|v| v.as_i64()).unwrap_or(0);
                !ranges.iter().any(|&(a, b)| t >= a && t < b)
            });
            stats.markers_removed = before - marks.len();
            for m in marks.iter_mut() {
                let t = m["time_range"]["start"].as_i64().unwrap_or(0);
                m["time_range"]["start"] = json!(t - removed_before(ranges, t));
            }
        }
    }
    stats
}

/// The end of the last segment on any track.
fn max_end(info: &Value) -> i64 {
    info.get("tracks")
        .and_then(|t| t.as_array())
        .into_iter()
        .flatten()
        .filter_map(|t| t.get("segments").and_then(|s| s.as_array()))
        .flatten()
        .map(|s| target_span(s).1)
        .max()
        .unwrap_or(0)
}

/// Read the draft, run `edit` on it and save it.
async fn edit_draft(
    preferred_draft_id: Option<String>,
    edit: impl FnOnce(&mut Value) -> CutStats,
) -> Result<CutStats, String> {
    let status = capcut_get_status(preferred_draft_id).await?;
    let draft = status.active_draft.ok_or_else(|| "No CapCut project found.".to_string())?;
    let text = fs::read_to_string(&draft.json_path)
        .map_err(|e| format!("Failed to read {}: {}", draft.json_path, e))?;
    let mut info: Value =
        serde_json::from_str(&text).map_err(|e| format!("Failed to parse {}: {}", draft.json_path, e))?;
    let stats = edit(&mut info);
    if stats != CutStats::default() {
        let end = max_end(&info);
        info["duration"] = json!(end);
        save_draft_json(&draft, &info, end)?;
    }
    Ok(stats)
}

pub async fn capcut_split_segments(
    preferred_draft_id: Option<String>,
    at_sec: f64,
    ids: Vec<String>,
) -> Result<CutStats, String> {
    let at = (at_sec * US_PER_SEC).round() as i64;
    edit_draft(preferred_draft_id, |info| split_at(info, at, &ids)).await
}

pub async fn capcut_remove_ranges(
    preferred_draft_id: Option<String>,
    ranges_sec: Vec<(f64, f64)>,
    ripple: bool,
) -> Result<CutStats, String> {
    let ranges: Vec<(i64, i64)> = ranges_sec
        .iter()
        .map(|&(a, b)| ((a * US_PER_SEC).round() as i64, (b * US_PER_SEC).round() as i64))
        .collect();
    edit_draft(preferred_draft_id, |info| remove_ranges(info, &ranges, ripple)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: i64 = 1_000_000;

    fn seg(id: &str, start: i64, dur: i64, src: i64) -> Value {
        json!({
            "id": id, "material_id": "m",
            "target_timerange": { "start": start, "duration": dur },
            "source_timerange": { "start": src, "duration": dur },
            "speed": 1.0,
            "extra_material_refs": ["speed-1"],
            "common_keyframes": [{ "keyframe_list": [{ "time_offset": 0 }, { "time_offset": dur - 1 }] }]
        })
    }

    fn draft() -> Value {
        json!({
            "fps": 30.0,
            "materials": { "speeds": [{ "id": "speed-1", "speed": 1.0 }] },
            "tracks": [
                { "type": "video", "segments": [seg("v1", 0, 10 * S, 100 * S)] },
                { "type": "text", "segments": [
                    { "id": "t1", "target_timerange": { "start": 2 * S, "duration": S }, "source_timerange": null },
                    { "id": "t2", "target_timerange": { "start": 8 * S, "duration": S }, "source_timerange": null }
                ] }
            ],
            "time_marks": { "mark_items": [
                { "time_range": { "start": 2 * S + S / 2, "duration": 0 } },
                { "time_range": { "start": 9 * S, "duration": 0 } }
            ] }
        })
    }

    fn spans(info: &Value, track: usize) -> Vec<(i64, i64)> {
        info["tracks"][track]["segments"].as_array().unwrap().iter().map(target_span).collect()
    }

    #[test]
    fn splits_one_segment_with_its_own_materials() {
        let mut info = draft();
        let stats = split_at(&mut info, 4 * S, &["v1".into()]);
        assert_eq!(stats.split, 1);
        assert_eq!(spans(&info, 0), vec![(0, 4 * S), (4 * S, 10 * S)]);
        let segs = info["tracks"][0]["segments"].as_array().unwrap();
        assert_eq!(segs[0]["id"], json!("v1"));
        assert_ne!(segs[1]["id"], json!("v1"));
        assert_eq!(segs[1]["source_timerange"]["start"], json!(104 * S));
        assert_ne!(segs[1]["extra_material_refs"][0], json!("speed-1"));
        assert_eq!(info["materials"]["speeds"].as_array().unwrap().len(), 2);
        // The text track was not named, so it is untouched.
        assert_eq!(spans(&info, 1), vec![(2 * S, 3 * S), (8 * S, 9 * S)]);
    }

    #[test]
    fn split_without_ids_cuts_everything_under_the_playhead() {
        let mut info = draft();
        assert_eq!(split_at(&mut info, 8 * S + S / 2, &[]).split, 2);
        assert_eq!(spans(&info, 1).len(), 3);
    }

    #[test]
    fn ripple_remove_keeps_tracks_in_sync() {
        let mut info = draft();
        let stats = remove_ranges(&mut info, &[(2 * S, 3 * S), (5 * S, 6 * S)], true);
        // V1 loses 2s in two places: 0-2, 3-5, 6-10 -> 0-2, 2-4, 4-8.
        assert_eq!(spans(&info, 0), vec![(0, 2 * S), (2 * S, 4 * S), (4 * S, 8 * S)]);
        let v = info["tracks"][0]["segments"].as_array().unwrap();
        assert_eq!(v[1]["source_timerange"]["start"], json!(103 * S));
        assert_eq!(v[2]["source_timerange"]["start"], json!(106 * S));
        // Keyframes outside a piece are dropped, the rest re-based.
        assert_eq!(v[1]["common_keyframes"][0]["keyframe_list"].as_array().unwrap().len(), 0);
        // t1 sat inside the first span; t2 moved left with everything else.
        assert_eq!(spans(&info, 1), vec![(6 * S, 7 * S)]);
        assert_eq!(stats.removed, 1);
        assert_eq!(stats.markers_removed, 1);
        assert_eq!(info["time_marks"]["mark_items"][0]["time_range"]["start"], json!(7 * S));
    }

    #[test]
    fn remove_without_ripple_leaves_gaps() {
        let mut info = draft();
        remove_ranges(&mut info, &[(2 * S, 3 * S)], false);
        assert_eq!(spans(&info, 0), vec![(0, 2 * S), (3 * S, 10 * S)]);
        assert_eq!(spans(&info, 1), vec![(8 * S, 9 * S)]);
        assert_eq!(info["time_marks"]["mark_items"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn honours_speed_when_cutting_the_source() {
        let mut info = draft();
        info["tracks"][0]["segments"][0]["speed"] = json!(2.0);
        split_at(&mut info, 4 * S, &[]);
        let v = info["tracks"][0]["segments"].as_array().unwrap();
        assert_eq!(v[0]["source_timerange"]["duration"], json!(8 * S));
        assert_eq!(v[1]["source_timerange"]["start"], json!(108 * S));
    }
}
