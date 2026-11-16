//! Multi-speaker dialogue parsing (`[A] ... [A]`, `[ID1] ... [ID1]`), cloned voice
//! profile persistence, mixed-provider synthesis, and `.srt` + turn timing generation.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::media::probe::duration_secs;

use super::paths::{output_root, profiles_file};
use super::split::{
    DEFAULT_GAP_SEC, OMNIVOICE_SAMPLE_RATE, cancel_split_job, cleanup_slot_outputs,
    cleanup_split_tracking, cleanup_temp_outputs, is_split_canceled, merge_audio_segments,
    register_split_subjobs, split_lines, split_sentences,
};
use super::{
    TtsGeneratePayload, TtsGenerateResult, allow_audio_file, emit_generate_progress,
    synthesize_single,
};

const MAX_ONLINE_TURN_CHARS: usize = 420;

const RESERVED_NON_SPEAKER_TAGS: &[&str] = &[
    "laugh",
    "laughs",
    "laughter",
    "chuckle",
    "sigh",
    "sighs",
    "gasp",
    "gasps",
    "cough",
    "coughs",
    "clears throat",
    "cry",
    "crying",
    "sob",
    "whisper",
    "whispers",
    "music",
    "pause",
    "silence",
    "breath",
    "breathes",
];

const NARRATOR_ALIASES: &[&str] = &[
    "narrator",
    "default",
    "vo",
    "voiceover",
    "dan_chuyen",
    "dẫn chuyện",
    "ke_chuyen",
    "kể chuyện",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedVoiceProfile {
    pub id: String,
    pub name: String,
    pub model_id: String,
    pub reference_audio_path: String,
    pub reference_text: String,
    #[serde(default)]
    pub created_at: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsSpeakerVoice {
    pub provider: Option<String>,
    pub voice_id: Option<String>,
    pub profile_id: Option<String>,
    pub reference_audio_path: Option<String>,
    pub reference_text: Option<String>,
    pub mode: Option<String>,
    pub language: Option<String>,
    pub speed: Option<f64>,
    pub instruction: Option<String>,
    #[serde(default)]
    pub sonic_provider: Option<String>,
    #[serde(default)]
    pub sonic_model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsDialogueTurn {
    pub speaker: Option<String>,
    pub text: String,
    pub gap_sec: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsTurnTiming {
    pub speaker: String,
    pub text: String,
    pub start_sec: f64,
    pub end_sec: f64,
    pub duration_sec: f64,
}

pub fn load_profiles(app: &AppHandle) -> Vec<SavedVoiceProfile> {
    profiles_file(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Vec<SavedVoiceProfile>>(&s).ok())
        .unwrap_or_default()
}

pub fn save_profiles(app: &AppHandle, profiles: &[SavedVoiceProfile]) -> Result<(), String> {
    let path = profiles_file(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(profiles).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

pub fn find_profile<'a>(
    profiles: &'a [SavedVoiceProfile],
    key: &str,
) -> Option<&'a SavedVoiceProfile> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return None;
    }
    profiles
        .iter()
        .find(|p| p.id == trimmed)
        .or_else(|| profiles.iter().find(|p| p.name.eq_ignore_ascii_case(trimmed)))
}

fn is_reserved_emotion_tag(tag: &str) -> bool {
    let lower = tag.trim().to_lowercase();
    RESERVED_NON_SPEAKER_TAGS.iter().any(|t| *t == lower)
}

pub fn is_narrator_tag(tag: &str) -> bool {
    let lower = tag.trim().to_lowercase();
    lower.is_empty() || NARRATOR_ALIASES.iter().any(|t| *t == lower)
}

#[derive(Debug, Clone)]
struct TagToken {
    start: usize,
    end: usize,
    tag: String,
    lower: String,
    is_slash_close: bool,
}

fn is_valid_speaker_tag_name(tag: &str) -> bool {
    !tag.is_empty()
        && tag.chars().count() <= 32
        && tag.chars().any(char::is_alphabetic)
        && !tag.contains([':', '[', ']', '=', '/', '\\'])
        && !is_reserved_emotion_tag(tag)
}

fn scan_tag_tokens(normalized: &str) -> Vec<TagToken> {
    let mut tokens = Vec::new();
    let mut idx = 0usize;
    while let Some(rel_open) = normalized[idx..].find('[') {
        let open = idx + rel_open;
        let after = &normalized[open + 1..];
        let next_close = after.find(']');
        let next_open = after.find('[');
        let next_nl = after.find('\n');

        let Some(rel_close) = next_close else {
            break;
        };
        if next_open.is_some_and(|o| o < rel_close) || next_nl.is_some_and(|n| n < rel_close) {
            idx = open + 1;
            continue;
        }

        let close = open + 1 + rel_close;
        let end = close + 1;
        let raw_inner = normalized[open + 1..close].trim();
        let is_slash_close = raw_inner.starts_with('/');
        let tag_name = raw_inner.trim_start_matches('/').trim();

        if is_valid_speaker_tag_name(tag_name) {
            tokens.push(TagToken {
                start: open,
                end,
                tag: tag_name.to_string(),
                lower: tag_name.to_lowercase(),
                is_slash_close,
            });
        }
        idx = end;
    }
    tokens
}

/// Extract distinct non-narrator speaker tags wrapped on both ends
/// (`[A] ... [A]` or `[A] ... [/A]`) in first-seen order.
pub fn extract_dialogue_tags(text: &str) -> Vec<String> {
    let normalized = text.replace("\r\n", "\n");
    let tokens = scan_tag_tokens(&normalized);
    let mut seen_lower = Vec::<String>::new();
    let mut tags = Vec::<String>::new();

    let mut i = 0usize;
    while i < tokens.len() {
        let tok = &tokens[i];
        if tok.is_slash_close {
            i += 1;
            continue;
        }
        if let Some(rel_j) = tokens[i + 1..].iter().position(|t| t.lower == tok.lower) {
            let j = i + 1 + rel_j;
            if !is_narrator_tag(&tok.tag) && !seen_lower.contains(&tok.lower) {
                seen_lower.push(tok.lower.clone());
                tags.push(tok.tag.clone());
            }
            i = j + 1;
        } else {
            i += 1;
        }
    }
    tags
}

fn canonical_speaker_key<'a>(
    tag: &str,
    speakers: &'a HashMap<String, TtsSpeakerVoice>,
) -> Option<&'a str> {
    if let Some((k, _)) = speakers.get_key_value(tag) {
        return Some(k.as_str());
    }
    speakers
        .keys()
        .find(|k| k.eq_ignore_ascii_case(tag))
        .map(String::as_str)
}

fn push_non_empty_turn(
    turns: &mut Vec<TtsDialogueTurn>,
    speaker: String,
    slice: &str,
    default_gap_sec: f64,
) {
    let trimmed = slice.trim();
    if !trimmed.is_empty() {
        turns.push(TtsDialogueTurn {
            speaker: Some(speaker),
            text: trimmed.to_string(),
            gap_sec: Some(default_gap_sec),
        });
    }
}

/// Parse script text with 2-ended speaker tags (`[A] ... [A]` or `[A] ... [/A]`):
/// - Text inside `[TAG] ... [TAG]` (inline or multi-line) uses `speakers[TAG]`.
/// - All text outside paired speaker tags automatically uses `"narrator"`.
pub fn parse_dialogue_script(
    text: &str,
    speakers: &HashMap<String, TtsSpeakerVoice>,
    default_gap_sec: f64,
) -> Result<Vec<TtsDialogueTurn>, String> {
    let normalized = text.replace("\r\n", "\n");
    let tokens = scan_tag_tokens(&normalized);

    let mut known_lowers: Vec<String> = speakers.keys().map(|k| k.to_lowercase()).collect();
    {
        let mut idx = 0usize;
        while idx < tokens.len() {
            if !tokens[idx].is_slash_close {
                if let Some(rel_j) = tokens[idx + 1..]
                    .iter()
                    .position(|t| t.lower == tokens[idx].lower)
                {
                    if !known_lowers.contains(&tokens[idx].lower) {
                        known_lowers.push(tokens[idx].lower.clone());
                    }
                    idx = idx + 1 + rel_j + 1;
                    continue;
                }
            }
            idx += 1;
        }
    }

    let mut turns = Vec::new();
    let mut cursor = 0usize;
    let mut i = 0usize;

    while i < tokens.len() {
        let tok = &tokens[i];
        if tok.is_slash_close {
            if known_lowers.contains(&tok.lower) || is_narrator_tag(&tok.tag) {
                return Err(format!(
                    "Unexpected closing tag [/{}]. Wrap spoken text on both ends: [{}] ... [{}].",
                    tok.tag, tok.tag, tok.tag
                ));
            }
            i += 1;
            continue;
        }

        if let Some(rel_j) = tokens[i + 1..].iter().position(|t| t.lower == tok.lower) {
            let j = i + 1 + rel_j;
            push_non_empty_turn(
                &mut turns,
                "narrator".to_string(),
                &normalized[cursor..tok.start],
                default_gap_sec,
            );

            let resolved_speaker = if is_narrator_tag(&tok.tag) {
                "narrator".to_string()
            } else if let Some(key) = canonical_speaker_key(&tok.tag, speakers) {
                key.to_string()
            } else {
                return Err(format!(
                    "Speaker tag [{}] has no assigned voice. Assign a voice for \"{}\" in speakers.",
                    tok.tag, tok.tag
                ));
            };

            let inner = normalized[tok.end..tokens[j].start].trim_start();
            let inner = inner
                .strip_prefix(':')
                .map(str::trim_start)
                .unwrap_or(inner);
            push_non_empty_turn(&mut turns, resolved_speaker, inner, default_gap_sec);

            cursor = tokens[j].end;
            i = j + 1;
        } else {
            if !is_narrator_tag(&tok.tag) && known_lowers.contains(&tok.lower) {
                return Err(format!(
                    "Unclosed speaker tag [{}]. Wrap spoken text on both ends: [{}] ... [{}].",
                    tok.tag, tok.tag, tok.tag
                ));
            }
            i += 1;
        }
    }

    push_non_empty_turn(
        &mut turns,
        "narrator".to_string(),
        &normalized[cursor..],
        default_gap_sec,
    );

    Ok(turns)
}

/// Apply cloned profile fields to a `TtsGeneratePayload` if `profile_id` is set and
/// `reference_audio_path` was not explicitly populated.
pub fn hydrate_payload_profile(payload: &mut TtsGeneratePayload, profiles: &[SavedVoiceProfile]) {
    if let Some(pid) = payload.profile_id.clone() {
        if let Some(prof) = find_profile(profiles, &pid) {
            payload.profile_id = Some(prof.id.clone());
            if payload
                .reference_audio_path
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
            {
                payload.reference_audio_path = Some(prof.reference_audio_path.clone());
            }
            if payload
                .reference_text
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
                && !prof.reference_text.trim().is_empty()
            {
                payload.reference_text = Some(prof.reference_text.clone());
            }
            if payload.provider.is_none() {
                payload.provider = Some(if prof.model_id == "vieneu" {
                    "vieneu".to_string()
                } else {
                    "omnivoice".to_string()
                });
            }
            if payload.provider.as_deref() == Some("omnivoice") && payload.mode != "clone" {
                payload.mode = "clone".to_string();
            }
        }
    }
}

fn build_turn_payload(
    base: &TtsGeneratePayload,
    speaker: &str,
    speakers: &HashMap<String, TtsSpeakerVoice>,
    profiles: &[SavedVoiceProfile],
    sub_job_id: String,
    text: String,
) -> Result<TtsGeneratePayload, String> {
    if is_narrator_tag(speaker) {
        let mut p = base.clone();
        p.job_id = sub_job_id;
        p.text = text;
        p.split_mode = Some("default".to_string());
        p.speakers = None;
        p.turns = None;
        hydrate_payload_profile(&mut p, profiles);
        return Ok(p);
    }

    let Some(key) = canonical_speaker_key(speaker, speakers) else {
        return Err(format!(
            "Speaker tag [{}] has no assigned voice. Assign a voice for \"{}\" in speakers.",
            speaker, speaker
        ));
    };
    let spec = &speakers[key];

    let provider = spec
        .provider
        .clone()
        .or_else(|| {
            spec.profile_id
                .as_deref()
                .and_then(|pid| find_profile(profiles, pid))
                .map(|prof| {
                    if prof.model_id == "vieneu" {
                        "vieneu".to_string()
                    } else {
                        "omnivoice".to_string()
                    }
                })
        })
        .or_else(|| base.provider.clone())
        .unwrap_or_else(|| "omnivoice".to_string());

    let mode = spec.mode.clone().unwrap_or_else(|| {
        if provider == "omnivoice" {
            if spec.profile_id.is_some() || spec.reference_audio_path.is_some() {
                "clone".to_string()
            } else if spec
                .instruction
                .as_deref()
                .is_some_and(|s| !s.trim().is_empty())
            {
                "design".to_string()
            } else {
                base.mode.clone()
            }
        } else {
            "auto".to_string()
        }
    });

    let mut p = TtsGeneratePayload {
        job_id: sub_job_id,
        text,
        mode,
        provider: Some(provider.clone()),
        voice_id: spec.voice_id.clone(),
        split_mode: Some("default".to_string()),
        language: spec.language.clone().or_else(|| base.language.clone()),
        speed: spec.speed.or(base.speed),
        num_step: base.num_step,
        advanced_settings: base.advanced_settings.clone(),
        instruction: spec.instruction.clone().or_else(|| {
            if provider == "omnivoice" {
                base.instruction.clone()
            } else {
                None
            }
        }),
        profile_id: spec.profile_id.clone(),
        reference_audio_path: spec.reference_audio_path.clone(),
        reference_text: spec.reference_text.clone(),
        speakers: None,
        turns: None,
        gap_sec: None,
        sonic_provider: if provider == "sonicvoice" {
            spec.sonic_provider.clone()
        } else {
            None
        },
        sonic_model: if provider == "sonicvoice" {
            spec.sonic_model.clone().or_else(|| base.sonic_model.clone())
        } else {
            None
        },
        sonic_pitch: None,
        sonic_stability: if provider == "sonicvoice" {
            base.sonic_stability
        } else {
            None
        },
        sonic_similarity: if provider == "sonicvoice" {
            base.sonic_similarity
        } else {
            None
        },
    };

    hydrate_payload_profile(&mut p, profiles);

    // If a speaker inherited the same provider as narrator and omitted voice/profile,
    // allow falling back ONLY when explicitly configured to narrator; otherwise validate!
    if provider != "omnivoice"
        && p.voice_id
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
        && !(provider == "vieneu"
            && p.reference_audio_path
                .as_deref()
                .is_some_and(|s| !s.trim().is_empty()))
    {
        return Err(format!(
            "Speaker [{}] ({}) requires a voiceId{}",
            key,
            provider,
            if provider == "vieneu" {
                " or profileId"
            } else {
                ""
            }
        ));
    }

    Ok(p)
}

fn provider_sample_rate(provider: Option<&str>) -> u32 {
    match provider {
        Some("capcut" | "elevenlabs" | "sonicvoice") => 44100,
        Some("vieneu") => 48000,
        _ => OMNIVOICE_SAMPLE_RATE,
    }
}

fn is_online_provider(provider: Option<&str>) -> bool {
    matches!(provider, Some("capcut" | "elevenlabs"))
}

fn round_ms(sec: f64) -> f64 {
    (sec * 1000.0).round() / 1000.0
}

fn format_srt_timestamp(seconds: f64) -> String {
    let total_ms = (seconds.max(0.0) * 1000.0).round() as u64;
    let ms = total_ms % 1000;
    let total_secs = total_ms / 1000;
    let s = total_secs % 60;
    let total_mins = total_secs / 60;
    let m = total_mins % 60;
    let h = total_mins / 60;
    format!("{:02}:{:02}:{:02},{:03}", h, m, s, ms)
}

pub fn build_turn_timings(
    items: &[(String, String, f64)],
    gaps: &[f64],
) -> Vec<TtsTurnTiming> {
    let mut cursor = 0.0;
    let mut out = Vec::with_capacity(items.len());
    for (idx, (speaker, text, dur)) in items.iter().enumerate() {
        let start = cursor;
        let end = start + dur;
        out.push(TtsTurnTiming {
            speaker: speaker.clone(),
            text: text.clone(),
            start_sec: round_ms(start),
            end_sec: round_ms(end),
            duration_sec: round_ms(*dur),
        });
        if idx + 1 < items.len() {
            cursor = end + gaps.get(idx).copied().unwrap_or(0.0).max(0.0);
        }
    }
    out
}

pub fn format_srt(timings: &[TtsTurnTiming]) -> String {
    let mut out = String::new();
    for (idx, item) in timings.iter().enumerate() {
        if idx > 0 {
            out.push('\n');
        }
        out.push_str(&format!(
            "{}\n{} --> {}\n{}\n",
            idx + 1,
            format_srt_timestamp(item.start_sec),
            format_srt_timestamp(item.end_sec),
            item.text.trim()
        ));
    }
    out
}

pub fn write_srt_file(path: &Path, timings: &[TtsTurnTiming]) -> Result<(), String> {
    if timings.is_empty() {
        return Ok(());
    }
    let content = format_srt(timings);
    std::fs::write(path, content).map_err(|e| e.to_string())
}

struct ExpandedSegment {
    speaker: String,
    text: String,
    gap_after_sec: f64,
}

fn expand_turns(
    raw_turns: Vec<TtsDialogueTurn>,
    split_mode: Option<&str>,
    default_gap_sec: f64,
    speakers: &HashMap<String, TtsSpeakerVoice>,
    base_provider: Option<&str>,
) -> Vec<ExpandedSegment> {
    let sentence_mode = split_mode == Some("sentence");
    let line_mode = split_mode == Some("line");
    let mut segments = Vec::new();

    for turn in raw_turns {
        let speaker = turn
            .speaker
            .as_deref()
            .filter(|s| !is_narrator_tag(s))
            .and_then(|s| canonical_speaker_key(s, speakers).or(Some(s)))
            .unwrap_or("narrator")
            .to_string();
        let turn_gap = turn
            .gap_sec
            .filter(|g| g.is_finite())
            .unwrap_or(default_gap_sec)
            .clamp(0.0, 5.0);

        let spk_provider = if speaker == "narrator" {
            base_provider
        } else {
            speakers
                .get(&speaker)
                .and_then(|s| s.provider.as_deref())
                .or(base_provider)
        };
        let needs_online_chunking =
            is_online_provider(spk_provider) && turn.text.chars().count() > MAX_ONLINE_TURN_CHARS;

        let parts = if sentence_mode || needs_online_chunking {
            split_sentences(&turn.text)
        } else if line_mode {
            split_lines(&turn.text)
        } else {
            let t = turn.text.trim();
            if t.is_empty() {
                Vec::new()
            } else {
                vec![t.to_string()]
            }
        };

        let count = parts.len();
        for (i, part) in parts.into_iter().enumerate() {
            let gap = if i + 1 < count {
                default_gap_sec.min(0.25)
            } else {
                turn_gap
            };
            segments.push(ExpandedSegment {
                speaker: speaker.clone(),
                text: part,
                gap_after_sec: gap,
            });
        }
    }

    if let Some(last) = segments.last_mut() {
        last.gap_after_sec = 0.0;
    }
    segments
}

/// Synthesize a multi-speaker dialogue (either explicit `turns` or `[ID1]`-tagged `text`),
/// stitch all segments in order with FFmpeg, and write `<job_id>.wav` + `<job_id>.srt`.
pub async fn generate_dialogue(app: &AppHandle, mut payload: TtsGeneratePayload) -> TtsGenerateResult {
    let profiles = load_profiles(app);
    hydrate_payload_profile(&mut payload, &profiles);

    let default_gap_sec = payload
        .gap_sec
        .filter(|g| g.is_finite())
        .unwrap_or(DEFAULT_GAP_SEC)
        .clamp(0.0, 5.0);
    let speakers = payload.speakers.clone().unwrap_or_default();

    let raw_turns = if let Some(explicit) = payload.turns.take().filter(|t| !t.is_empty()) {
        explicit
    } else {
        match parse_dialogue_script(&payload.text, &speakers, default_gap_sec) {
            Ok(t) => t,
            Err(e) => return TtsGenerateResult::err(e),
        }
    };

    let segments = expand_turns(
        raw_turns,
        payload.split_mode.as_deref(),
        default_gap_sec,
        &speakers,
        payload.provider.as_deref(),
    );
    if segments.is_empty() {
        return TtsGenerateResult::err("Dialogue has no spoken text");
    }

    let parent_job_id = payload.job_id.clone();
    let total = segments.len();
    let sub_ids: Vec<String> = (0..total)
        .map(|i| format!("{}-{}", parent_job_id, i))
        .collect();

    let mut sub_tasks = Vec::with_capacity(total);
    let mut target_sample_rate = OMNIVOICE_SAMPLE_RATE;
    for (idx, seg) in segments.iter().enumerate() {
        match build_turn_payload(
            &payload,
            &seg.speaker,
            &speakers,
            &profiles,
            sub_ids[idx].clone(),
            seg.text.clone(),
        ) {
            Ok(sub_payload) => {
                target_sample_rate =
                    target_sample_rate.max(provider_sample_rate(sub_payload.provider.as_deref()));
                sub_tasks.push((idx, sub_payload));
            }
            Err(e) => return TtsGenerateResult::err(e),
        }
    }

    let out_dir = match output_root(app) {
        Ok(d) => d,
        Err(e) => return TtsGenerateResult::err(e),
    };
    if let Err(e) = std::fs::create_dir_all(&out_dir) {
        return TtsGenerateResult::err(e.to_string());
    }

    register_split_subjobs(&parent_job_id, sub_ids);
    emit_generate_progress(
        app,
        &parent_job_id,
        "line-generating",
        Some(4.0),
        &format!("Synthesizing turn 1/{}...", total),
    );

    let mut slots: Vec<Option<(PathBuf, f64)>> = vec![None; total];
    let mut completed = 0usize;

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
            let speaker = &segments[index].speaker;
            let err_msg = result
                .error
                .unwrap_or_else(|| format!("Failed to synthesize turn {}", index + 1));
            return TtsGenerateResult::err(format!("[{}] {}", speaker, err_msg));
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
            "line-generating",
            Some(pct),
            &format!("Synthesizing turn {}/{}...", completed, total),
        );
    }

    let mut outputs = Vec::with_capacity(total);
    let mut part_durations = Vec::with_capacity(total);
    let mut timing_inputs = Vec::with_capacity(total);
    let mut gaps = Vec::with_capacity(total);

    for (idx, slot) in slots.into_iter().enumerate() {
        let Some((path, dur)) = slot else {
            cleanup_temp_outputs(&outputs);
            cleanup_split_tracking(&parent_job_id);
            return TtsGenerateResult::err("Missing dialogue audio segment");
        };
        outputs.push(path);
        part_durations.push(dur);
        timing_inputs.push((
            segments[idx].speaker.clone(),
            segments[idx].text.clone(),
            dur,
        ));
        gaps.push(segments[idx].gap_after_sec);
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

    let merged = merge_audio_segments(
        app,
        &parent_job_id,
        &outputs,
        &gaps,
        &final_output,
        target_sample_rate,
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
            Some(detail) => format!("Could not merge dialogue segments: {detail}"),
            None => "Could not merge dialogue segments".to_string(),
        });
    }

    allow_audio_file(app, &final_output);
    let total_duration = duration_secs(&final_output);
    let turn_timings = build_turn_timings(&timing_inputs, &gaps);

    let srt_path = out_dir.join(format!("{}.srt", parent_job_id));
    let srt_saved = if write_srt_file(&srt_path, &turn_timings).is_ok() {
        allow_audio_file(app, &srt_path);
        Some(srt_path.to_string_lossy().into_owned())
    } else {
        None
    };

    emit_generate_progress(app, &parent_job_id, "saving", Some(100.0), "Audio saved");

    TtsGenerateResult {
        success: true,
        output_path: Some(final_output.to_string_lossy().into_owned()),
        srt_path: srt_saved,
        sample_rate: Some(target_sample_rate),
        duration_sec: total_duration,
        canceled: None,
        error: None,
        part_durations_sec: Some(part_durations),
        part_gap_sec: Some(default_gap_sec),
        turns: Some(turn_timings),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_paired_speaker_tags_ignoring_single_brackets_and_emotions() {
        let script = "\
Đoàn người vừa đi qua sườn núi [sương mù dày đặc] theo báo cáo [1] và [1].

[A] Khoan đi tiếp đã! [A] [laugh] Hahaha!
[B] Cậu lúc nào cũng lo xa. [/B]
[a] Nghe kìa, có tiếng động! [a]
[narrator] Gió bỗng thổi mạnh. [narrator]";
        assert_eq!(extract_dialogue_tags(script), vec!["A", "B"]);
    }

    #[test]
    fn parses_inline_and_multiline_paired_tags_with_narrator_outside() {
        let mut speakers = HashMap::new();
        speakers.insert(
            "A".to_string(),
            TtsSpeakerVoice {
                provider: Some("capcut".into()),
                voice_id: Some("v1".into()),
                ..Default::default()
            },
        );
        speakers.insert(
            "B".to_string(),
            TtsSpeakerVoice {
                provider: Some("capcut".into()),
                voice_id: Some("v2".into()),
                ..Default::default()
            },
        );

        let script = "\
Đoàn người vừa đi qua sườn núi. Nam khẽ gọi: [A] Khoan đi tiếp đã! [A] Lan bật cười đáp: [b] Cậu lúc nào cũng lo xa. [/b]
[A]
Nghe kìa!
Có tiếng bước chân thật đấy!
[A]
Chưa dứt lời, có tiếng động lạ.";

        let turns = parse_dialogue_script(script, &speakers, 0.25).unwrap();
        let pairs: Vec<(&str, &str)> = turns
            .iter()
            .map(|t| (t.speaker.as_deref().unwrap_or(""), t.text.as_str()))
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("narrator", "Đoàn người vừa đi qua sườn núi. Nam khẽ gọi:"),
                ("A", "Khoan đi tiếp đã!"),
                ("narrator", "Lan bật cười đáp:"),
                ("B", "Cậu lúc nào cũng lo xa."),
                ("A", "Nghe kìa!\nCó tiếng bước chân thật đấy!"),
                ("narrator", "Chưa dứt lời, có tiếng động lạ."),
            ]
        );
    }

    #[test]
    fn rejects_unassigned_or_unclosed_speaker_tag() {
        let mut speakers = HashMap::new();
        let err = parse_dialogue_script("[ID1] Xin chào [ID1]", &speakers, 0.25).unwrap_err();
        assert!(err.contains("[ID1]"));

        speakers.insert(
            "A".to_string(),
            TtsSpeakerVoice {
                provider: Some("capcut".into()),
                voice_id: Some("v1".into()),
                ..Default::default()
            },
        );
        let unclosed =
            parse_dialogue_script("[A] Câu 1 [A] rồi [A] quên đóng thẻ", &speakers, 0.25)
                .unwrap_err();
        assert!(unclosed.contains("Unclosed speaker tag [A]"));
    }

    #[test]
    fn builds_accurate_srt_and_turn_timings() {
        let items = vec![
            ("narrator".to_string(), "Câu dẫn chuyện.".to_string(), 2.5),
            ("ID1".to_string(), "Chào cậu!".to_string(), 1.2),
            ("ID2".to_string(), "Chào nhé!".to_string(), 1.35),
        ];
        let gaps = vec![0.25, 0.30, 0.0];
        let timings = build_turn_timings(&items, &gaps);
        assert_eq!(timings[0].start_sec, 0.0);
        assert_eq!(timings[0].end_sec, 2.5);
        assert_eq!(timings[1].start_sec, 2.75);
        assert_eq!(timings[1].end_sec, 3.95);
        assert_eq!(timings[2].start_sec, 4.25);
        assert_eq!(timings[2].end_sec, 5.6);

        let srt = format_srt(&timings);
        assert!(srt.contains("1\n00:00:00,000 --> 00:00:02,500\nCâu dẫn chuyện.\n"));
        assert!(srt.contains("2\n00:00:02,750 --> 00:00:03,950\nChào cậu!\n"));
        assert!(srt.contains("3\n00:00:04,250 --> 00:00:05,600\nChào nhé!\n"));
    }
}
