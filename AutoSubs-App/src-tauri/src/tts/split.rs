//! Line-by-line and sentence-by-sentence synthesis and FFmpeg concatenation.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use tauri::AppHandle;
use tokio::process::Command;

use crate::media::probe::{duration_secs, ffmpeg_binary};
use crate::process_ext::HiddenConsole;

use super::paths::output_root;
use super::worker::stop_worker;
use super::{
    TtsGeneratePayload, TtsGenerateResult, allow_audio_file, emit_generate_progress,
    is_job_canceled, mark_job_canceled, register_canceler, synthesize_single, unregister_canceler,
};

pub(crate) const MAX_MERGE_INPUTS: usize = 60;
pub(crate) const DEFAULT_GAP_SEC: f64 = 0.25;
pub(crate) const OMNIVOICE_SAMPLE_RATE: u32 = 24000;

/// Active parent split job -> list of sub-job IDs so `cancel` stops every part.
static SPLIT_SUBJOBS: Lazy<Mutex<HashMap<String, Vec<String>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static CANCELED_SPLITS: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));

pub fn cancel_split_job(parent_job_id: &str) -> bool {
    let subs = SPLIT_SUBJOBS.lock().unwrap().get(parent_job_id).cloned();
    let Some(subs) = subs else {
        return false;
    };
    CANCELED_SPLITS
        .lock()
        .unwrap()
        .insert(parent_job_id.to_string());
    mark_job_canceled(parent_job_id);
    for sub in &subs {
        mark_job_canceled(sub);
        let _ = stop_worker(Some(sub));
    }
    true
}

pub fn cancel_all_splits() {
    let all_parents: Vec<String> = SPLIT_SUBJOBS.lock().unwrap().keys().cloned().collect();
    for parent in all_parents {
        let _ = cancel_split_job(&parent);
    }
}

pub(crate) fn register_split_subjobs(parent_job_id: &str, sub_ids: Vec<String>) {
    SPLIT_SUBJOBS
        .lock()
        .unwrap()
        .insert(parent_job_id.to_string(), sub_ids);
}

pub(crate) fn is_split_canceled(parent_job_id: &str) -> bool {
    is_job_canceled(parent_job_id) || CANCELED_SPLITS.lock().unwrap().contains(parent_job_id)
}

pub fn split_lines(text: &str) -> Vec<String> {
    text.replace("\r\n", "\n")
        .split('\n')
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

fn is_sentence_terminator(c: char) -> bool {
    matches!(c, '.' | '!' | '?' | '…' | '。' | '！' | '？')
}

/// Mirrors `text.replace(/\r\n/g, '\n').split(/(?<=[.!?…。！？])\s+|\n+/u)`
/// used by `TextEditorCard` so the preview breakdown matches synthesis 1:1.
pub fn split_sentences(text: &str) -> Vec<String> {
    let normalized = text.replace("\r\n", "\n");
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut chars = normalized.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '\n' {
            let trimmed = current.trim();
            if !trimmed.is_empty() {
                parts.push(trimmed.to_string());
            }
            current.clear();
            while chars.peek() == Some(&'\n') {
                chars.next();
            }
            continue;
        }
        current.push(ch);
        if is_sentence_terminator(ch) && chars.peek().is_some_and(|next| next.is_whitespace()) {
            let trimmed = current.trim();
            if !trimmed.is_empty() {
                parts.push(trimmed.to_string());
            }
            current.clear();
            while chars.peek().is_some_and(|next| next.is_whitespace()) {
                chars.next();
            }
        }
    }

    let trimmed = current.trim();
    if !trimmed.is_empty() {
        parts.push(trimmed.to_string());
    }
    parts
}

pub(crate) struct MergeStatus {
    pub ok: bool,
    pub canceled: bool,
    pub error: Option<String>,
}

async fn run_merge_pass_once(
    job_id: &str,
    inputs: &[PathBuf],
    gaps: &[f64],
    output_path: &Path,
    sample_rate: u32,
) -> MergeStatus {
    if is_split_canceled(job_id) {
        return MergeStatus {
            ok: false,
            canceled: true,
            error: None,
        };
    }

    let mut graph_parts = Vec::with_capacity(inputs.len());
    let mut concat_inputs = String::new();
    for index in 0..inputs.len() {
        let gap = gaps.get(index).copied().unwrap_or(0.0);
        let pad = if gap > 0.0005 {
            format!(",apad=pad_dur={:.4}", gap)
        } else {
            String::new()
        };
        graph_parts.push(format!(
            "[{}:a]aresample={},aformat=sample_fmts=s16:channel_layouts=mono{}[a{}]",
            index, sample_rate, pad, index
        ));
        concat_inputs.push_str(&format!("[a{}]", index));
    }
    let filter_script = format!(
        "{};{}concat=n={}:v=0:a=1[out]",
        graph_parts.join(";"),
        concat_inputs,
        inputs.len()
    );

    let mut cmd = Command::new(ffmpeg_binary());
    cmd.args(["-hide_banner", "-nostats", "-loglevel", "error", "-y"]);
    for input in inputs {
        cmd.arg("-i").arg(input);
    }
    cmd.arg("-filter_complex")
        .arg(&filter_script)
        .args(["-map", "[out]", "-c:a", "pcm_s16le"])
        .arg(output_path)
        .hidden()
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return MergeStatus {
                ok: false,
                canceled: false,
                error: Some(format!("Could not start ffmpeg: {e}")),
            };
        }
    };

    let mut stderr_pipe = child.stderr.take();
    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(mut pipe) = stderr_pipe.take() {
            let _ = tokio::io::AsyncReadExt::read_to_end(&mut pipe, &mut buf).await;
        }
        String::from_utf8_lossy(&buf).trim().to_string()
    });

    let cancel_rx = register_canceler(job_id);
    let wait_res = tokio::select! {
        status = child.wait() => Some(status),
        _ = cancel_rx => {
            let _ = child.kill().await;
            None
        }
    };
    unregister_canceler(job_id);
    let stderr_text = stderr_task.await.unwrap_or_default();

    match wait_res {
        None => MergeStatus {
            ok: false,
            canceled: true,
            error: None,
        },
        Some(Ok(status)) if status.success() => MergeStatus {
            ok: true,
            canceled: false,
            error: None,
        },
        Some(_) => MergeStatus {
            ok: false,
            canceled: is_split_canceled(job_id),
            error: if stderr_text.is_empty() {
                None
            } else {
                Some(stderr_text)
            },
        },
    }
}

async fn run_merge_pass(
    job_id: &str,
    inputs: &[PathBuf],
    gaps: &[f64],
    output_path: &Path,
    sample_rate: u32,
) -> MergeStatus {
    for attempt in 0..=super::MAX_TTS_RETRIES {
        let res = run_merge_pass_once(job_id, inputs, gaps, output_path, sample_rate).await;
        if res.ok || res.canceled || attempt == super::MAX_TTS_RETRIES {
            return res;
        }
        if !super::cancelable_sleep(job_id, super::random_retry_delay()).await {
            return MergeStatus {
                ok: false,
                canceled: true,
                error: None,
            };
        }
    }
    MergeStatus {
        ok: false,
        canceled: is_split_canceled(job_id),
        error: None,
    }
}

pub(crate) async fn merge_audio_segments_in_dir(
    out_dir: &Path,
    job_id: &str,
    inputs: &[PathBuf],
    gaps: &[f64],
    output_path: &Path,
    sample_rate: u32,
) -> MergeStatus {
    let mut scratch = Vec::new();

    let mut files: Vec<PathBuf> = inputs.to_vec();
    let mut current_gaps: Vec<f64> = (0..inputs.len())
        .map(|i| {
            if i + 1 < inputs.len() {
                gaps.get(i).copied().unwrap_or(0.0).max(0.0)
            } else {
                0.0
            }
        })
        .collect();
    let mut level = 0usize;
    let status = 'outer: loop {
        if files.len() <= MAX_MERGE_INPUTS {
            break run_merge_pass(
                job_id,
                &files,
                &current_gaps,
                output_path,
                sample_rate,
            )
            .await;
        }

        let mut next_files = Vec::new();
        let mut next_gaps = Vec::new();
        for (file_batch, gap_batch) in files
            .chunks(MAX_MERGE_INPUTS)
            .zip(current_gaps.chunks(MAX_MERGE_INPUTS))
        {
            if file_batch.len() == 1 {
                next_files.push(file_batch[0].clone());
                next_gaps.push(gap_batch[0]);
                continue;
            }
            let batch_out = out_dir.join(format!(
                "{}-merge-l{}-c{}.wav",
                job_id,
                level,
                next_files.len()
            ));
            let res = run_merge_pass(
                job_id,
                file_batch,
                gap_batch,
                &batch_out,
                sample_rate,
            )
            .await;
            if !res.ok {
                break 'outer res;
            }
            scratch.push(batch_out.clone());
            next_files.push(batch_out);
            next_gaps.push(0.0);
        }
        files = next_files;
        current_gaps = next_gaps;
        level += 1;
    };

    for file in scratch {
        let _ = std::fs::remove_file(file);
    }
    status
}

pub(crate) async fn merge_audio_segments(
    app: &AppHandle,
    job_id: &str,
    inputs: &[PathBuf],
    gaps: &[f64],
    output_path: &Path,
    sample_rate: u32,
) -> MergeStatus {
    let out_dir = match output_root(app) {
        Ok(d) => d,
        Err(e) => {
            return MergeStatus {
                ok: false,
                canceled: false,
                error: Some(e),
            };
        }
    };
    merge_audio_segments_in_dir(&out_dir, job_id, inputs, gaps, output_path, sample_rate).await
}

async fn merge_line_audios(
    app: &AppHandle,
    job_id: &str,
    inputs: &[PathBuf],
    output_path: &Path,
    gap_sec: f64,
    sample_rate: u32,
) -> MergeStatus {
    let gaps = vec![gap_sec; inputs.len().saturating_sub(1)];
    merge_audio_segments(app, job_id, inputs, &gaps, output_path, sample_rate).await
}

pub async fn generate_split(
    app: &AppHandle,
    payload: TtsGeneratePayload,
    parts: Vec<String>,
) -> TtsGenerateResult {
    if payload.provider.as_deref() == Some("sonicvoice") {
        return super::sonicvoice::generate_batch_split(app, payload, parts).await;
    }
    let sample_rate = match payload.provider.as_deref() {
        Some("capcut" | "elevenlabs" | "sonicvoice") => 44100,
        Some("vieneu") => 48000,
        _ => OMNIVOICE_SAMPLE_RATE,
    };
    let parent_job_id = payload.job_id.clone();
    let is_line = payload.split_mode.as_deref() == Some("line");
    let stage = if is_line {
        "line-generating"
    } else {
        "sentence-generating"
    };
    let unit = if is_line { "line" } else { "sentence" };
    let gap_sec = payload
        .gap_sec
        .filter(|g| g.is_finite())
        .unwrap_or(DEFAULT_GAP_SEC)
        .clamp(0.0, 5.0);

    let sub_ids: Vec<String> = (0..parts.len())
        .map(|i| format!("{}-{}", parent_job_id, i))
        .collect();
    SPLIT_SUBJOBS
        .lock()
        .unwrap()
        .insert(parent_job_id.clone(), sub_ids.clone());

    let out_dir = match output_root(app) {
        Ok(d) => d,
        Err(e) => {
            cleanup_split_tracking(&parent_job_id);
            return TtsGenerateResult::err(e);
        }
    };
    if let Err(e) = std::fs::create_dir_all(&out_dir) {
        cleanup_split_tracking(&parent_job_id);
        return TtsGenerateResult::err(e.to_string());
    }

    let total = parts.len();
    let mut slots: Vec<Option<(PathBuf, f64)>> = vec![None; total];
    let mut completed = 0usize;

    emit_generate_progress(
        app,
        &parent_job_id,
        stage,
        Some(4.0),
        &format!("Synthesizing {} 1/{}...", unit, total),
    );

    let sub_tasks: Vec<(usize, TtsGeneratePayload)> = parts
        .iter()
        .enumerate()
        .map(|(index, part_text)| {
            let mut sub_payload = payload.clone();
            sub_payload.job_id = sub_ids[index].clone();
            sub_payload.text = part_text.clone();
            sub_payload.split_mode = Some("default".to_string());
            (index, sub_payload)
        })
        .collect();

    for (index, sub_payload) in sub_tasks {
        if is_split_canceled(&parent_job_id) {
            let _ = cancel_split_job(&parent_job_id);
            cleanup_slot_outputs(&slots);
            cleanup_split_tracking(&parent_job_id);
            return TtsGenerateResult::canceled();
        }

        let result = synthesize_single(app, sub_payload, false).await;

        if is_split_canceled(&parent_job_id) || result.canceled == Some(true) {
            if let Some(p) = result.output_path.as_deref() {
                let _ = std::fs::remove_file(p);
            }
            let _ = cancel_split_job(&parent_job_id);
            cleanup_slot_outputs(&slots);
            cleanup_split_tracking(&parent_job_id);
            return TtsGenerateResult::canceled();
        }
        if !result.success || result.output_path.is_none() {
            let _ = cancel_split_job(&parent_job_id);
            cleanup_slot_outputs(&slots);
            cleanup_split_tracking(&parent_job_id);
            return TtsGenerateResult::err(
                result
                    .error
                    .unwrap_or_else(|| format!("Failed to synthesize {} {}", unit, index + 1)),
            );
        }

        let part_path = PathBuf::from(result.output_path.unwrap());
        let dur = duration_secs(&part_path)
            .or(result.duration_sec)
            .unwrap_or(0.0);
        slots[index] = Some((part_path, dur));
        completed += 1;

        let pct = (4.0 + (completed as f64 / total as f64) * 86.0).round();
        emit_generate_progress(
            app,
            &parent_job_id,
            stage,
            Some(pct),
            &format!("Synthesizing {} {}/{}...", unit, completed, total),
        );
    }

    let mut outputs: Vec<PathBuf> = Vec::with_capacity(total);
    let mut part_durations: Vec<f64> = Vec::with_capacity(total);
    for slot in slots.into_iter().flatten() {
        outputs.push(slot.0);
        part_durations.push(slot.1);
    }

    if is_split_canceled(&parent_job_id) {
        cleanup_temp_outputs(&outputs);
        cleanup_split_tracking(&parent_job_id);
        return TtsGenerateResult::canceled();
    }

    let final_output = out_dir.join(format!("{}.wav", parent_job_id));
    emit_generate_progress(
        app,
        &parent_job_id,
        "merging",
        Some(94.0),
        "Merging audio segments...",
    );

    let merged = merge_line_audios(
        app,
        &parent_job_id,
        &outputs,
        &final_output,
        gap_sec,
        sample_rate,
    )
    .await;

    cleanup_temp_outputs(&outputs);
    cleanup_split_tracking(&parent_job_id);

    if !merged.ok {
        let _ = std::fs::remove_file(&final_output);
        if merged.canceled {
            return TtsGenerateResult::canceled();
        }
        return TtsGenerateResult::err(match merged.error {
            Some(detail) => format!("Could not merge audio segments: {detail}"),
            None => "Could not merge audio segments".to_string(),
        });
    }

    allow_audio_file(app, &final_output);
    let total_duration = duration_secs(&final_output);
    emit_generate_progress(app, &parent_job_id, "saving", Some(100.0), "Audio saved");

    let all_measured =
        part_durations.len() == parts.len() && part_durations.iter().all(|v| *v > 0.0);

    let (srt_path, turns) = if all_measured {
        let timing_inputs: Vec<(String, String, f64)> = parts
            .iter()
            .zip(part_durations.iter())
            .map(|(text, dur)| ("narrator".to_string(), text.clone(), *dur))
            .collect();
        let gaps = vec![gap_sec; parts.len().saturating_sub(1)];
        let timings = super::dialogue::build_turn_timings(&timing_inputs, &gaps);
        let srt_file = out_dir.join(format!("{}.srt", parent_job_id));
        let saved = if super::dialogue::write_srt_file(&srt_file, &timings).is_ok() {
            allow_audio_file(app, &srt_file);
            Some(srt_file.to_string_lossy().into_owned())
        } else {
            None
        };
        (saved, Some(timings))
    } else {
        (None, None)
    };

    TtsGenerateResult {
        success: true,
        output_path: Some(final_output.to_string_lossy().into_owned()),
        srt_path,
        sample_rate: Some(sample_rate),
        duration_sec: total_duration,
        canceled: None,
        error: None,
        part_durations_sec: if all_measured {
            Some(part_durations)
        } else {
            None
        },
        part_gap_sec: if all_measured { Some(gap_sec) } else { None },
        turns,
    }
}

pub(crate) fn cleanup_temp_outputs(outputs: &[PathBuf]) {
    for p in outputs {
        let _ = std::fs::remove_file(p);
    }
}

pub(crate) fn cleanup_slot_outputs(slots: &[Option<(PathBuf, f64)>]) {
    for (p, _) in slots.iter().flatten() {
        let _ = std::fs::remove_file(p);
    }
}

pub(crate) fn cleanup_split_tracking(parent_job_id: &str) {
    SPLIT_SUBJOBS.lock().unwrap().remove(parent_job_id);
    CANCELED_SPLITS.lock().unwrap().remove(parent_job_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_lines_cleanly() {
        assert_eq!(
            split_lines("  First line \r\n\n Second line\n  "),
            vec!["First line", "Second line"]
        );
    }

    #[test]
    fn splits_sentences_matching_frontend_preview() {
        assert_eq!(
            split_sentences("Xin chào... thế giới! Số pi là 3.14.\nDòng tiếp theo? Đúng vậy."),
            vec![
                "Xin chào...",
                "thế giới!",
                "Số pi là 3.14.",
                "Dòng tiếp theo?",
                "Đúng vậy."
            ]
        );
    }

    #[test]
    fn queue_and_retry_delays_stay_within_configured_random_bounds() {
        for _ in 0..128 {
            let q = super::super::random_queue_delay().as_millis() as u64;
            assert!(
                (super::super::QUEUE_DELAY_MIN_MS..=super::super::QUEUE_DELAY_MAX_MS).contains(&q),
                "queue delay {q}ms out of 500..=1500ms"
            );
            let r = super::super::random_retry_delay().as_millis() as u64;
            assert!(
                (super::super::RETRY_DELAY_MIN_MS..=super::super::RETRY_DELAY_MAX_MS).contains(&r),
                "retry delay {r}ms out of 4500..=5500ms"
            );
        }
    }

    #[tokio::test]
    async fn run_merge_pass_merges_audio_with_gaps_on_current_ffmpeg() {
        fn write_test_wav(path: &Path, sample_rate: u32, duration_ms: u32) {
            let num_samples = (sample_rate * duration_ms) / 1000;
            let data_size = num_samples * 2;
            let mut bytes = Vec::with_capacity(44 + data_size as usize);
            bytes.extend_from_slice(b"RIFF");
            bytes.extend_from_slice(&(36 + data_size).to_le_bytes());
            bytes.extend_from_slice(b"WAVEfmt ");
            bytes.extend_from_slice(&16u32.to_le_bytes());
            bytes.extend_from_slice(&1u16.to_le_bytes());
            bytes.extend_from_slice(&1u16.to_le_bytes());
            bytes.extend_from_slice(&sample_rate.to_le_bytes());
            bytes.extend_from_slice(&(sample_rate * 2).to_le_bytes());
            bytes.extend_from_slice(&2u16.to_le_bytes());
            bytes.extend_from_slice(&16u16.to_le_bytes());
            bytes.extend_from_slice(b"data");
            bytes.extend_from_slice(&data_size.to_le_bytes());
            bytes.resize(44 + data_size as usize, 0u8);
            std::fs::write(path, bytes).unwrap();
        }

        let dir = std::env::temp_dir().join(format!("autosubs-merge-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let a = dir.join("a.wav");
        let b = dir.join("b.wav");
        let out = dir.join("out.wav");
        write_test_wav(&a, 24000, 400);
        write_test_wav(&b, 44100, 300);

        let status = run_merge_pass("test-merge-job", &[a, b], &[0.25, 0.0], &out, 44100).await;
        assert!(status.ok, "ffmpeg merge failed: {:?}", status.error);
        let merged_dur = duration_secs(&out).unwrap_or(0.0);
        assert!(
            (merged_dur - 0.95).abs() < 0.05,
            "unexpected merged duration: {merged_dur}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
