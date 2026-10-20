//! `get_transcript`: what is said in the video, read from the transcripts
//! AutoSubs saves after a transcription (`<app local data>/Transcripts/*.json`,
//! written by `saveSubtitleDocument` in `src/lib/subtitle-documents.ts`).
//!
//! Segment and word times in those files are seconds from the start of the
//! timeline (or file) that was transcribed, the same domain every timeline
//! tool uses, so the agent can pass them straight to `remove_ranges`,
//! `add_marker` or `add_text`.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use crate::ai_edit::actions::EditTarget;

const INDEX_FILENAME: &str = "transcript-index.json";
/// Past this many segments the agent is asked to read the rest by range.
const MAX_SEGMENTS: usize = 1500;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptArgs {
    /// A transcript filename from the "other transcripts" list.
    pub file: Option<String>,
    pub from_sec: Option<f64>,
    pub to_sec: Option<f64>,
    /// Include per-word timings.
    #[serde(default)]
    pub words: bool,
    /// List pauses between words at least this long.
    pub min_pause_sec: Option<f64>,
}

/// Where the app saves transcripts.
pub fn transcripts_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_local_data_dir()
        .map(|d| d.join("Transcripts"))
        .map_err(|e| format!("Could not find the transcripts folder: {}", e))
}

/// Every saved transcript, newest first.
fn list_files(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.extension().is_some_and(|x| x == "json")
                        && p.file_name().is_some_and(|n| n != INDEX_FILENAME)
                })
                .map(|p| (std::fs::metadata(&p).and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH), p))
                .collect()
        })
        .unwrap_or_default();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.into_iter().map(|(_, p)| p).collect()
}

/// A bare filename inside `dir`; anything with a path in it is refused, so the
/// tool only ever reads the transcripts folder.
fn file_in(dir: &Path, name: &str) -> Result<PathBuf, String> {
    let bare = Path::new(name).file_name().and_then(|n| n.to_str()).unwrap_or("");
    if bare.is_empty() || bare != name {
        return Err(format!("'{}' is not a transcript filename; use one from the list.", name));
    }
    Ok(dir.join(bare))
}

fn num(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(|x| x.as_f64())
}

fn text_of(v: &Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/// "S1"-style labels mapped to speaker names, the same way the subtitle
/// editor resolves them: ids are 1-based unless some segment uses "0".
fn speaker_label(id: &str, names: &[String], base: i64) -> String {
    let Ok(n) = id.parse::<i64>() else {
        return format!("Speaker {}", id);
    };
    usize::try_from(n - base)
        .ok()
        .and_then(|i| names.get(i))
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("Speaker {}", n))
}

fn fmt(secs: f64) -> String {
    format!("{:.2}", secs)
}

/// Render one transcript document for the agent.
pub fn render(doc: &Value, filename: &str, args: &TranscriptArgs) -> String {
    let meta = doc.get("metadata").cloned().unwrap_or(Value::Null);
    let name = Some(text_of(&meta, "displayName")).filter(|s| !s.is_empty()).unwrap_or_else(|| filename.into());
    let timeline = Some(text_of(&meta, "timelineName"))
        .filter(|s| !s.is_empty())
        .or_else(|| Some(text_of(doc, "timelineName")).filter(|s| !s.is_empty()));
    let source_file = Some(text_of(&meta, "sourceFileName")).filter(|s| !s.is_empty());

    let mut out = format!("Transcript \"{}\" (file: {}", name, filename);
    if let Some(lang) = doc.get("language").and_then(|l| l.as_str()).filter(|l| !l.is_empty()) {
        out.push_str(&format!(", language: {}", lang));
    }
    if let Some(t) = &timeline {
        out.push_str(&format!(", timeline: \"{}\"", t));
    }
    if let Some(f) = &source_file {
        out.push_str(&format!(", source file: \"{}\"", f));
    }
    out.push_str(")\n");
    out.push_str(if timeline.is_some() {
        "Times are seconds from the start of that timeline, the same as the timeline tools.\n"
    } else {
        "Times are seconds from the start of the source file; if that file starts at 0 on the timeline, \
         they match the timeline tools.\n"
    });

    let segments: Vec<Value> = doc.get("segments").and_then(|s| s.as_array()).cloned().unwrap_or_default();
    let names: Vec<String> = doc
        .get("speakers")
        .and_then(|s| s.as_array())
        .map(|a| a.iter().map(|s| text_of(s, "name")).collect())
        .unwrap_or_default();
    let base = if segments.iter().any(|s| s.get("speaker_id").and_then(|x| x.as_str()) == Some("0")) {
        0
    } else {
        1
    };

    let from = args.from_sec.unwrap_or(f64::NEG_INFINITY);
    let to = args.to_sec.unwrap_or(f64::INFINITY);
    let in_range: Vec<&Value> = segments
        .iter()
        .filter(|s| num(s, "end").unwrap_or(0.0) > from && num(s, "start").unwrap_or(0.0) < to)
        .collect();

    if let (Some(first), Some(last)) = (segments.first(), segments.last()) {
        out.push_str(&format!(
            "{} segment(s) from {}s to {}s",
            segments.len(),
            fmt(num(first, "start").unwrap_or(0.0)),
            fmt(num(last, "end").unwrap_or(0.0))
        ));
        if args.from_sec.is_some() || args.to_sec.is_some() {
            out.push_str(&format!("; {} in the requested range", in_range.len()));
        }
        out.push_str(".\n\n");
    } else {
        out.push_str("The transcript has no segments.\n");
        return out;
    }

    for seg in in_range.iter().take(MAX_SEGMENTS) {
        let speaker = seg
            .get("speaker_id")
            .and_then(|x| x.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(|id| format!("{}: ", speaker_label(id.trim(), &names, base)))
            .unwrap_or_default();
        let text = text_of(seg, "text").split_whitespace().collect::<Vec<_>>().join(" ");
        out.push_str(&format!(
            "[{}-{}] {}{}\n",
            fmt(num(seg, "start").unwrap_or(0.0)),
            fmt(num(seg, "end").unwrap_or(0.0)),
            speaker,
            text
        ));
        if args.words {
            let words: Vec<String> = seg
                .get("words")
                .and_then(|w| w.as_array())
                .map(|a| {
                    a.iter()
                        .map(|w| {
                            format!(
                                "{}@{}-{}",
                                text_of(w, "word").trim(),
                                fmt(num(w, "start").unwrap_or(0.0)),
                                fmt(num(w, "end").unwrap_or(0.0))
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            if !words.is_empty() {
                out.push_str(&format!("  words: {}\n", words.join(" ")));
            }
        }
    }
    if in_range.len() > MAX_SEGMENTS {
        out.push_str(&format!(
            "... {} more segment(s); call get_transcript again with fromSec/toSec to read them.\n",
            in_range.len() - MAX_SEGMENTS
        ));
    }

    if let Some(min) = args.min_pause_sec.filter(|m| *m > 0.0) {
        let pauses = pauses(&in_range, min);
        out.push_str(&format!("\nPauses of at least {}s ({}):\n", min, pauses.len()));
        if pauses.is_empty() {
            out.push_str("  (none)\n");
        }
        for (start, end) in pauses {
            out.push_str(&format!("  {}-{} ({}s)\n", fmt(start), fmt(end), fmt(end - start)));
        }
    }
    out
}

/// Gaps of at least `min` seconds between consecutive words (or segments,
/// when a segment carries no words).
fn pauses(segments: &[&Value], min: f64) -> Vec<(f64, f64)> {
    let mut spans: Vec<(f64, f64)> = Vec::new();
    for seg in segments {
        let words = seg.get("words").and_then(|w| w.as_array()).filter(|a| !a.is_empty());
        match words {
            Some(words) => {
                for w in words {
                    spans.push((num(w, "start").unwrap_or(0.0), num(w, "end").unwrap_or(0.0)));
                }
            }
            None => spans.push((num(seg, "start").unwrap_or(0.0), num(seg, "end").unwrap_or(0.0))),
        }
    }
    spans.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut out = Vec::new();
    let mut last_end: Option<f64> = None;
    for (start, end) in spans {
        if let Some(prev) = last_end {
            if start - prev >= min {
                out.push((prev, start));
            }
        }
        last_end = Some(last_end.map_or(end, |p| p.max(end)));
    }
    out
}

/// The `get_transcript` tool: pick the transcript (the one named, else the one
/// open in the app, else the newest) and render it plus the list of others.
pub fn get_transcript(dir: &Path, target: &EditTarget, args: &TranscriptArgs) -> Result<String, String> {
    let all = list_files(dir);
    let chosen = match args.file.as_deref().or(target.transcript_file.as_deref()) {
        Some(name) => {
            let path = file_in(dir, name)?;
            if !path.is_file() {
                return Err(format!("No transcript named '{}'.{}", name, others(&all, None)));
            }
            path
        }
        None => all.first().cloned().ok_or_else(|| {
            "There is no saved transcript yet. Ask the user to transcribe the timeline in the \
             Transcribe tab first, then call get_transcript again."
                .to_string()
        })?,
    };
    let raw = std::fs::read_to_string(&chosen).map_err(|e| format!("Could not read the transcript: {}", e))?;
    let doc: Value = serde_json::from_str(&raw).map_err(|e| format!("The transcript file is not valid JSON: {}", e))?;
    let filename = chosen.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    let mut out = render(&doc, &filename, args);
    out.push_str(&others(&all, Some(&chosen)));
    Ok(out)
}

/// The other transcripts the agent could ask for by `file`.
fn others(all: &[PathBuf], chosen: Option<&PathBuf>) -> String {
    let rest: Vec<String> = all
        .iter()
        .filter(|p| Some(*p) != chosen)
        .take(15)
        .filter_map(|p| p.file_name().and_then(|n| n.to_str()).map(str::to_string))
        .collect();
    if rest.is_empty() {
        String::new()
    } else {
        format!("\nOther transcripts (pass one as file): {}\n", rest.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_edit::actions::Editor;
    use serde_json::json;

    fn doc() -> Value {
        json!({
            "language": "en",
            "metadata": { "displayName": "Interview", "timelineName": "Timeline 1" },
            "speakers": [{ "name": "Alice" }, { "name": "" }],
            "segments": [
                { "start": 0.0, "end": 2.0, "text": "Hello  there", "speaker_id": "1",
                  "words": [{ "word": "Hello", "start": 0.0, "end": 0.5 }, { "word": "there", "start": 1.5, "end": 2.0 }] },
                { "start": 4.0, "end": 5.0, "text": "Bye", "speaker_id": "2",
                  "words": [{ "word": "Bye", "start": 4.0, "end": 5.0 }] }
            ]
        })
    }

    #[test]
    fn renders_segments_speakers_and_pauses() {
        let out = render(&doc(), "a.json", &TranscriptArgs { min_pause_sec: Some(0.8), words: true, ..Default::default() });
        assert!(out.contains("timeline: \"Timeline 1\""));
        assert!(out.contains("[0.00-2.00] Alice: Hello there"));
        assert!(out.contains("[4.00-5.00] Speaker 2: Bye"));
        assert!(out.contains("words: Hello@0.00-0.50 there@1.50-2.00"));
        assert!(out.contains("0.50-1.50 (1.00s)"));
        assert!(out.contains("2.00-4.00 (2.00s)"));
    }

    #[test]
    fn filters_by_range() {
        let out = render(&doc(), "a.json", &TranscriptArgs { from_sec: Some(3.0), ..Default::default() });
        assert!(!out.contains("Hello"));
        assert!(out.contains("Bye"));
        assert!(out.contains("1 in the requested range"));
    }

    #[test]
    fn picks_named_then_open_then_newest() {
        let dir = std::env::temp_dir().join(format!("autosubs-transcripts-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("old.json"), doc().to_string()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(dir.join("new.json"), json!({ "segments": [] }).to_string()).unwrap();
        std::fs::write(dir.join(INDEX_FILENAME), "[]").unwrap();
        let mut target = EditTarget { editor: Editor::Davinci, draft_id: None, transcript_file: None };

        let newest = get_transcript(&dir, &target, &TranscriptArgs::default()).unwrap();
        assert!(newest.contains("file: new.json"));
        assert!(newest.contains("Other transcripts (pass one as file): old.json"));

        target.transcript_file = Some("old.json".into());
        assert!(get_transcript(&dir, &target, &TranscriptArgs::default()).unwrap().contains("Alice"));

        let named = TranscriptArgs { file: Some("new.json".into()), ..Default::default() };
        assert!(get_transcript(&dir, &target, &named).unwrap().contains("file: new.json"));

        let escape = TranscriptArgs { file: Some("../secret.json".into()), ..Default::default() };
        assert!(get_transcript(&dir, &target, &escape).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
