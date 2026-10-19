//! Silence analysis for AutoEdit's "remove silences" workflow.
//!
//! Takes a WAV path exported by Resolve (via the existing `ExportAudio` Lua
//! command), normalizes it to mono 16 kHz i16 with ffmpeg, then runs the same
//! Silero VAD the transcription pipeline uses to detect speech segments.
//! Returns keep-spans + cut-spans in audio-relative seconds — the caller
//! (TypeScript orchestrator) maps them back to source frames per clip and
//! sends them to `ApplyKeepSegments` on the Lua bridge.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use transcription_engine::{self as te, ModelManager};

use crate::audio_preprocess;
use crate::models::get_cache_dir;

#[derive(Deserialize)]
pub struct AnalyzeSilenceArgs {
    /// Absolute path to a WAV exported by Resolve. Any sample rate / channels
    /// is fine — this command normalizes to mono 16 kHz internally.
    pub wav_path: String,
    /// Minimum silence duration to treat as removable (seconds). Silences
    /// shorter than this are folded into the adjacent speech.
    pub min_silence_secs: f64,
    /// Extra padding kept around every speech segment (seconds), to avoid
    /// clipping the onset/offset of a word.
    pub padding_secs: f64,
    /// Reject keep-segments shorter than this (seconds) — avoids fragments
    /// that would produce a stuttery timeline.
    pub min_keep_secs: f64,
}

#[derive(Serialize, Clone)]
pub struct Span {
    pub start_secs: f64,
    pub end_secs: f64,
}

#[derive(Serialize)]
pub struct AnalyzeSilenceResult {
    pub total_duration_secs: f64,
    pub speech_duration_secs: f64,
    /// Raw padded speech spans straight from VAD, before any min-silence
    /// merging. The frontend recomputes keep/cut spans from these when the
    /// user drags the min-silence / padding sliders, so VAD only runs once.
    pub raw_speech_spans: Vec<Span>,
    /// Ranges to keep, in ascending time order (using the request's defaults).
    pub keep_spans: Vec<Span>,
    /// Ranges to remove (complement of `keep_spans` within the audio).
    pub cut_spans: Vec<Span>,
}

// Merge adjacent speech segments whose gap is shorter than `min_silence_secs`,
// then add `padding_secs` around each merged span and drop any span shorter
// than `min_keep_secs`.
fn compact_speech_to_keep_spans(
    speech: &[(f64, f64)],
    total_secs: f64,
    min_silence_secs: f64,
    padding_secs: f64,
    min_keep_secs: f64,
) -> Vec<Span> {
    if speech.is_empty() {
        return vec![];
    }

    let mut merged: Vec<(f64, f64)> = Vec::with_capacity(speech.len());
    let (mut cur_s, mut cur_e) = speech[0];
    for &(s, e) in speech.iter().skip(1) {
        if s - cur_e < min_silence_secs {
            cur_e = cur_e.max(e);
        } else {
            merged.push((cur_s, cur_e));
            cur_s = s;
            cur_e = e;
        }
    }
    merged.push((cur_s, cur_e));

    let mut padded: Vec<Span> = merged
        .into_iter()
        .map(|(s, e)| Span {
            start_secs: (s - padding_secs).max(0.0),
            end_secs: (e + padding_secs).min(total_secs),
        })
        .collect();

    // Padding can push adjacent spans into overlap; if so, split the overlap
    // at the midpoint so spans stay disjoint and the "cut" complement is
    // well defined.
    for i in 1..padded.len() {
        if padded[i].start_secs < padded[i - 1].end_secs {
            let mid = (padded[i].start_secs + padded[i - 1].end_secs) * 0.5;
            padded[i - 1].end_secs = mid;
            padded[i].start_secs = mid;
        }
    }

    padded
        .into_iter()
        .filter(|k| k.end_secs - k.start_secs >= min_keep_secs)
        .collect()
}

fn keep_to_cut(keep: &[Span], total_secs: f64) -> Vec<Span> {
    let mut cuts = vec![];
    let mut prev_end = 0.0_f64;
    for k in keep {
        if k.start_secs > prev_end {
            cuts.push(Span {
                start_secs: prev_end,
                end_secs: k.start_secs,
            });
        }
        prev_end = k.end_secs;
    }
    if total_secs > prev_end {
        cuts.push(Span {
            start_secs: prev_end,
            end_secs: total_secs,
        });
    }
    cuts
}

#[tauri::command]
pub async fn analyze_wav_silences<R: Runtime>(
    app: AppHandle<R>,
    args: AnalyzeSilenceArgs,
) -> Result<AnalyzeSilenceResult, String> {
    let src = PathBuf::from(&args.wav_path);
    if !src.exists() {
        return Err(format!("Audio file not found: {}", src.display()));
    }

    // Resolve's ExportAudio emits 44.1 kHz 24-bit stereo — normalize to mono
    // 16 kHz i16 for VAD.
    let tmp_dir = std::env::temp_dir();
    let tmp = tmp_dir.join(format!(
        "autoedit-vad-{}-{}.wav",
        std::process::id(),
        chrono_like_stamp()
    ));

    audio_preprocess::normalize(app.clone(), src, tmp.clone(), None)
        .await
        .map_err(|e| format!("Failed to normalize audio for VAD: {}", e))?;

    let cache_dir = get_cache_dir(app.clone())?;
    let manager = ModelManager::new(cache_dir);
    let vad_path = manager
        .ensure_vad_model(None, None)
        .await
        .map_err(|e| format!("Could not load Silero VAD model: {}", e))?;

    let samples = te::audio::read_wav(tmp.to_string_lossy().as_ref())
        .map_err(|e| format!("Could not read normalized audio: {}", e))?;
    let total_secs = samples.len() as f64 / 16_000.0;

    // VAD is blocking (whisper.cpp C++). Move it off the async runtime so a
    // long clip doesn't stall the Tauri worker.
    let vad_path_str = vad_path.to_string_lossy().to_string();
    let segments = tokio::task::spawn_blocking(move || {
        te::get_segments(&vad_path_str, &samples)
    })
    .await
    .map_err(|e| format!("VAD task join error: {}", e))?
    .map_err(|e| format!("VAD failed: {}", e))?;

    let _ = std::fs::remove_file(&tmp);

    let speech: Vec<(f64, f64)> = segments.iter().map(|s| (s.start, s.end)).collect();
    let speech_duration_secs: f64 = speech.iter().map(|(s, e)| e - s).sum();

    let raw_speech_spans: Vec<Span> = speech
        .iter()
        .map(|&(s, e)| Span { start_secs: s, end_secs: e })
        .collect();

    let keep_spans = compact_speech_to_keep_spans(
        &speech,
        total_secs,
        args.min_silence_secs.max(0.05),
        args.padding_secs.max(0.0),
        args.min_keep_secs.max(0.1),
    );
    let cut_spans = keep_to_cut(&keep_spans, total_secs);

    Ok(AnalyzeSilenceResult {
        total_duration_secs: total_secs,
        speech_duration_secs,
        raw_speech_spans,
        keep_spans,
        cut_spans,
    })
}

// A unique-enough stamp for a temp filename without pulling `chrono` in.
fn chrono_like_stamp() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx_eq(a: f64, b: f64) -> bool { (a - b).abs() < 1e-9 }

    #[test]
    fn merges_close_speech_and_keeps_gaps_above_threshold() {
        let speech = [(0.0, 1.0), (1.2, 2.0), (5.0, 6.0)];
        let keep = compact_speech_to_keep_spans(&speech, 7.0, 0.5, 0.0, 0.0);
        // First two merge (gap 0.2s < 0.5s min); third stays separate.
        assert_eq!(keep.len(), 2);
        assert!(approx_eq(keep[0].start_secs, 0.0));
        assert!(approx_eq(keep[0].end_secs, 2.0));
        assert!(approx_eq(keep[1].start_secs, 5.0));
    }

    #[test]
    fn padding_stays_disjoint() {
        let speech = [(1.0, 2.0), (2.1, 3.0)];
        // 0.2s padding would overlap; expect them split at midpoint.
        let keep = compact_speech_to_keep_spans(&speech, 5.0, 0.05, 0.2, 0.0);
        assert!(keep[0].end_secs <= keep[1].start_secs + 1e-9);
    }

    #[test]
    fn cut_spans_complement_keep_spans() {
        let keep = vec![
            Span { start_secs: 1.0, end_secs: 2.0 },
            Span { start_secs: 4.0, end_secs: 6.0 },
        ];
        let cuts = keep_to_cut(&keep, 8.0);
        assert_eq!(cuts.len(), 3);
        assert!(approx_eq(cuts[0].start_secs, 0.0));
        assert!(approx_eq(cuts[0].end_secs, 1.0));
        assert!(approx_eq(cuts[1].start_secs, 2.0));
        assert!(approx_eq(cuts[1].end_secs, 4.0));
        assert!(approx_eq(cuts[2].start_secs, 6.0));
        assert!(approx_eq(cuts[2].end_secs, 8.0));
    }
}
