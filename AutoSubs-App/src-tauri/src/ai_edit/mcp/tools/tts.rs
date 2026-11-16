//! TTS & multi-speaker dialogue MCP tools (`list_tts_voices`, `generate_speech`).
//!
//! Exposes AutoSubs's built-in TTS engines (`capcut`, `vieneu`, `omnivoice`,
//! `elevenlabs`, `sonicvoice`, plus user-cloned voice profiles) to both the in-app AI Edit
//! agent and external agents (`autosubs-app` on port `47185`).
//!
//! Supports single-voice narration, `[A] ... [A]` / `[ID1] ... [ID1]` wrapped
//! multi-speaker scripts (where all text outside paired tags uses the default
//! narrator voice), and structured `turns` arrays. Saves `<name>.wav` (or `.mp3`)
//! + `<name>.srt` into `<workspace>/media/audio/voice/` (with short media IDs `m12`
//! ready for `build_storyboard` and `get_transcript`) or `<studio_home>/voice/`
//! when no Premiere project is open.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::AppHandle;

use crate::ai_cli::workspace::VOICE_DIR;
use crate::ai_edit::mcp::external;
use crate::ai_edit::mcp::tools::{assets, tool};
use crate::tts;
use crate::tts::dialogue::{
    SavedVoiceProfile, TtsDialogueTurn, TtsSpeakerVoice, find_profile, load_profiles,
};

const DEFAULT_LIST_LIMIT: usize = 50;
const MAX_LIST_LIMIT: usize = 200;

pub fn tools() -> Vec<Value> {
    let speaker_voice_schema = json!({
        "type": "object",
        "properties": {
            "provider": {
                "type": "string",
                "enum": ["capcut", "vieneu", "omnivoice", "elevenlabs", "sonicvoice"],
                "description": "TTS engine for this speaker (optional if voiceId or profileId identifies it)"
            },
            "voiceId": {
                "type": "string",
                "description": "Catalog voiceId from list_tts_voices (e.g. \"BV074_streaming\", \"Thiện Minh\", \"uv_...\")"
            },
            "sonicModel": {
                "type": "string",
                "description": "Optional SonicVoice ElevenLabs model id (e.g. \"eleven_v3\", \"eleven_v4\")"
            },
            "profileId": {
                "type": "string",
                "description": "Cloned voice profileId (or profile name) from list_tts_voices"
            },
            "mode": {
                "type": "string",
                "enum": ["clone", "design", "auto"],
                "description": "OmniVoice mode when using omnivoice without profileId"
            },
            "instruction": {
                "type": "string",
                "description": "Voice style prompt when provider is omnivoice and mode is design"
            },
            "language": {
                "type": "string",
                "description": "Language code such as \"vi\" or \"en\""
            },
            "speed": {
                "type": "number",
                "description": "Speaking speed from 0.75 to 1.5 (default 1.0)"
            }
        }
    });

    vec![
        tool(
            "list_tts_voices",
            "List available TTS voices, local model readiness, and the user's cloned voice profiles. \
             Filter by language (e.g. \"vi\", \"en\"), provider (\"capcut\", \"vieneu\", \"omnivoice\", \
             \"elevenlabs\", \"sonicvoice\", \"cloned\"), gender, or query. Note: for Vietnamese (\"vi\"), \
             use \"capcut\", \"vieneu\", \"omnivoice\", or \"sonicvoice\" (\"elevenlabs\" via CapCut uses \
             multilingual_v2 and has no Vietnamese).",
            json!({
                "type": "object",
                "properties": {
                    "language": {
                        "type": "string",
                        "description": "ISO language code filter, e.g. \"vi\", \"en\", \"ja\", \"zh\""
                    },
                    "provider": {
                        "type": "string",
                        "enum": ["capcut", "vieneu", "omnivoice", "elevenlabs", "sonicvoice", "cloned"],
                        "description": "Filter to one TTS engine or \"cloned\" for user-cloned voices"
                    },
                    "gender": {
                        "type": "string",
                        "enum": ["male", "female"],
                        "description": "Optional gender filter"
                    },
                    "query": {
                        "type": "string",
                        "description": "Search substring matching voice name or voiceId"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum voices to return (default 50, max 200)"
                    }
                }
            }),
        ),
        tool(
            "generate_speech",
            "Generate single-voice speech or multi-speaker dialogue audio + .srt subtitles using AutoSubs TTS. \
             Saves into media/audio/voice/ (or Video Studio voice/ when no Premiere project is open) and returns \
             short media ids (m12) for both the audio and .srt file plus exact per-turn timestamps.\n\
             Multi-speaker syntax: set the narrator's voice with provider/voiceId (or profileId), wrap each \
             character's spoken text on both ends with `[A] ... [A]` or `[ID1] ... [ID1]` (everything outside \
             paired tags uses the narrator voice), and map each tag in `speakers` (speakers can mix providers).",
            json!({
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "Script text. Wrap character lines on both ends like `[A] Hello! [A]` or `[ID1] Hello! [ID1]`; all text outside paired tags uses the narrator voice."
                    },
                    "turns": {
                        "type": "array",
                        "description": "Optional structured dialogue turns instead of `text`, allowing custom per-turn pauses",
                        "items": {
                            "type": "object",
                            "properties": {
                                "speaker": {
                                    "type": "string",
                                    "description": "\"narrator\" (default) or a key in `speakers` (e.g. \"ID1\")"
                                },
                                "text": { "type": "string" },
                                "gapSec": {
                                    "type": "number",
                                    "description": "Pause after this turn in seconds"
                                }
                            },
                            "required": ["text"]
                        }
                    },
                    "provider": {
                        "type": "string",
                        "enum": ["capcut", "vieneu", "omnivoice", "elevenlabs", "sonicvoice"],
                        "description": "Default/narrator TTS engine (auto-inferred when voiceId or profileId uniquely identifies it)"
                    },
                    "sonicModel": {
                        "type": "string",
                        "description": "Optional SonicVoice ElevenLabs model id (e.g. \"eleven_v3\", \"eleven_v4\")"
                    },
                    "voiceId": {
                        "type": "string",
                        "description": "Default/narrator catalog voiceId from list_tts_voices"
                    },
                    "profileId": {
                        "type": "string",
                        "description": "Default/narrator cloned voice profileId (or profile name)"
                    },
                    "mode": {
                        "type": "string",
                        "enum": ["clone", "design", "auto"],
                        "description": "OmniVoice mode when provider is omnivoice without profileId"
                    },
                    "instruction": {
                        "type": "string",
                        "description": "Voice description when provider is omnivoice and mode is design"
                    },
                    "language": {
                        "type": "string",
                        "description": "Language code (default \"vi\")"
                    },
                    "speed": {
                        "type": "number",
                        "description": "Default speaking speed from 0.75 to 1.5 (default 1.0)"
                    },
                    "speakers": {
                        "type": "object",
                        "description": "Voice mapping for dialogue tags such as {\"ID1\": {\"provider\": \"capcut\", \"voiceId\": \"BV075_streaming\"}, \"ID2\": {...}}",
                        "additionalProperties": speaker_voice_schema
                    },
                    "splitMode": {
                        "type": "string",
                        "enum": ["sentence", "line", "default"],
                        "description": "Chunking mode (defaults to \"sentence\" so long scripts produce sentence-level .srt timestamps)"
                    },
                    "gapSec": {
                        "type": "number",
                        "description": "Pause between sentences/turns in seconds (default 0.25)"
                    },
                    "fileName": {
                        "type": "string",
                        "description": "Optional base filename without extension, e.g. \"vo_scene_1\""
                    },
                    "outputDir": {
                        "type": "string",
                        "description": "Optional relative folder (e.g. \"projects/my-video/voice\" in Video Studio when no Premiere project is open)"
                    }
                }
            }),
        ),
    ]
}

pub async fn call(
    app: &AppHandle,
    workspace: Option<&Path>,
    name: &str,
    args: &Value,
) -> Option<Result<String, String>> {
    match name {
        "list_tts_voices" => Some(list_voices(app, args).await),
        "generate_speech" => Some(generate_speech(app, workspace, args).await),
        _ => None,
    }
}

fn omnivoice_ready(app: &AppHandle) -> bool {
    tts::paths::venv_python(app).is_ok_and(|p| p.is_file())
        && tts::paths::is_runtime_current(app)
        && tts::paths::is_model_installed(app, tts::paths::OMNIVOICE_MODEL_ID)
}

fn vieneu_ready(app: &AppHandle) -> bool {
    tts::vieneu::tts_vieneu_status(app.clone())
        .map(|s| s.runtime_ready)
        .unwrap_or(false)
}

fn matches_gender_filter(entry: &Value, gender_filter: &str) -> bool {
    if let Some(g) = entry.get("gender").and_then(|v| v.as_str()) {
        return g.eq_ignore_ascii_case(gender_filter);
    }
    let hay = format!(
        "{} {}",
        entry.get("id").and_then(|v| v.as_str()).unwrap_or(""),
        entry.get("name").and_then(|v| v.as_str()).unwrap_or("")
    )
    .to_lowercase();
    match gender_filter {
        "female" => {
            hay.contains("female")
                || hay.contains("girl")
                || hay.contains("nữ")
                || hay.contains("cô ")
                || hay.contains("chị")
                || hay.contains("nhỏ ")
        }
        "male" => {
            (hay.contains("male") && !hay.contains("female"))
                || hay.contains("boy")
                || hay.contains("nam")
                || hay.contains("anh")
                || hay.contains("thanh niên")
                || hay.contains("chú")
                || hay.contains("ông")
        }
        _ => true,
    }
}

async fn list_voices(app: &AppHandle, args: &Value) -> Result<String, String> {
    let language = args
        .get("language")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("all"));
    let provider = args
        .get("provider")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("all"));
    let gender = args
        .get("gender")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("all"))
        .map(str::to_lowercase);
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase);
    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|n| (n as usize).clamp(1, MAX_LIST_LIMIT))
        .unwrap_or(DEFAULT_LIST_LIMIT);

    let omni_ok = omnivoice_ready(app);
    let vieneu_ok = vieneu_ready(app);
    let sonic_ok = tts::sonicvoice::api_key(app).is_some();
    let profiles = load_profiles(app);

    let mut out = String::new();
    out.push_str(&format!(
        "Providers:\n\
         - capcut: ready (online, supports \"vi\" + multilingual)\n\
         - vieneu: {} (local CPU Vietnamese + voice cloning)\n\
         - omnivoice: {} (local omnilingual clone/design/auto)\n\
         - elevenlabs: ready (online multilingual_v2; does NOT support Vietnamese \"vi\")\n\
         - sonicvoice: {} (online Minimax + ElevenLabs + voice cloning, supports \"vi\" + multilingual)\n",
        if vieneu_ok { "ready" } else { "not-installed" },
        if omni_ok { "ready" } else { "not-installed" },
        if sonic_ok { "ready" } else { "missing-api-key" },
    ));

    if provider == Some("sonicvoice") {
        if !sonic_ok {
            out.push_str(
                "\nSonicVoice API key is missing. Ask the user to paste it in the TTS tab or Settings.\n",
            );
            return Ok(out.trim_end().to_string());
        }
        let sonic_query = tts::sonicvoice::SonicVoicesQuery {
            sub_provider: None,
            language: language.map(String::from),
            gender: gender.clone(),
            query: query.clone(),
            limit: Some(limit),
            offset: None,
        };
        let sonic_voices = tts::sonicvoice::fetch_voices(app, Some(sonic_query)).await?;
        out.push_str(&format!("\nSonicVoice voices ({} matched):\n", sonic_voices.len()));
        for v in sonic_voices.into_iter().take(limit) {
            let g = v.gender.as_deref().unwrap_or("-");
            out.push_str(&format!(
                "- sonicvoice ({}) | voiceId=\"{}\" | lang={} | gender={} | {}\n",
                v.sub_provider, v.id, v.language, g, v.name
            ));
        }
        return Ok(out.trim_end().to_string());
    }

    let include_cloned = matches!(
        provider,
        None | Some("cloned") | Some("omnivoice") | Some("vieneu")
    );
    if include_cloned && !profiles.is_empty() {
        let matched_profiles: Vec<&SavedVoiceProfile> = profiles
            .iter()
            .filter(|p| {
                query.as_ref().is_none_or(|q| {
                    p.name.to_lowercase().contains(q) || p.id.to_lowercase().contains(q)
                })
            })
            .collect();
        if !matched_profiles.is_empty() {
            out.push_str("\nCloned voice profiles (pass `profileId` to generate_speech):\n");
            for p in matched_profiles {
                let engines = if p.reference_text.trim().is_empty() {
                    "vieneu"
                } else {
                    "omnivoice, vieneu"
                };
                out.push_str(&format!(
                    "- profileId=\"{}\" | name=\"{}\" | engines={}\n",
                    p.id, p.name, engines
                ));
            }
        }
    }

    if provider == Some("cloned") {
        if profiles.is_empty() {
            out.push_str("\nNo cloned voice profiles saved yet in AutoSubs TTS Studio.\n");
        }
        return Ok(out.trim_end().to_string());
    }

    if provider == Some("omnivoice") {
        out.push_str(
            "\nOmniVoice has no fixed catalog IDs: use `profileId` (mode=\"clone\"), \
             `mode=\"design\"` with `instruction`, or `mode=\"auto\"`.\n",
        );
        return Ok(out.trim_end().to_string());
    }

    let catalog = tts::providers::catalog();
    let entries = catalog.as_array().map(Vec::as_slice).unwrap_or(&[]);

    let filtered: Vec<&Value> = entries
        .iter()
        .filter(|v| {
            if let Some(prov) = provider {
                let vp = v.get("provider").and_then(|x| x.as_str()).unwrap_or("");
                if !vp.eq_ignore_ascii_case(prov) {
                    return false;
                }
            }
            if let Some(lang) = language {
                let vl = v.get("language").and_then(|x| x.as_str()).unwrap_or("");
                if !vl.eq_ignore_ascii_case(lang) {
                    return false;
                }
            }
            if let Some(ref g) = gender {
                if !matches_gender_filter(v, g) {
                    return false;
                }
            }
            if let Some(ref q) = query {
                let id = v
                    .get("id")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_lowercase();
                let name = v
                    .get("name")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_lowercase();
                if !id.contains(q) && !name.contains(q) {
                    return false;
                }
            }
            true
        })
        .collect();

    let total = filtered.len();
    out.push_str(&format!(
        "\nCatalog voices ({} matched{}):\n",
        total,
        if total > limit {
            format!(", showing first {}", limit)
        } else {
            String::new()
        }
    ));

    for v in filtered.into_iter().take(limit) {
        let prov = v.get("provider").and_then(|x| x.as_str()).unwrap_or("");
        let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
        let lang = v.get("language").and_then(|x| x.as_str()).unwrap_or("");
        let g = v.get("gender").and_then(|x| x.as_str()).unwrap_or("-");
        let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("");
        out.push_str(&format!(
            "- {} | voiceId=\"{}\" | lang={} | gender={} | {}\n",
            prov, id, lang, g, name
        ));
    }

    if provider.is_none() && sonic_ok {
        let sonic_query = tts::sonicvoice::SonicVoicesQuery {
            sub_provider: None,
            language: language.map(String::from),
            gender: gender.clone(),
            query: query.clone(),
            limit: Some(limit.min(30)),
            offset: None,
        };
        if let Ok(sonic_voices) = tts::sonicvoice::fetch_voices(app, Some(sonic_query)).await {
            if !sonic_voices.is_empty() {
                out.push_str(&format!("\nSonicVoice voices (showing {}):\n", sonic_voices.len().min(30)));
                for v in sonic_voices.into_iter().take(30) {
                    let g = v.gender.as_deref().unwrap_or("-");
                    out.push_str(&format!(
                        "- sonicvoice ({}) | voiceId=\"{}\" | lang={} | gender={} | {}\n",
                        v.sub_provider, v.id, v.language, g, v.name
                    ));
                }
            }
        }
    }

    Ok(out.trim_end().to_string())
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerateSpeechArgs {
    text: Option<String>,
    turns: Option<Vec<TtsDialogueTurn>>,
    provider: Option<String>,
    voice_id: Option<String>,
    profile_id: Option<String>,
    mode: Option<String>,
    instruction: Option<String>,
    language: Option<String>,
    speed: Option<f64>,
    speakers: Option<HashMap<String, TtsSpeakerVoice>>,
    split_mode: Option<String>,
    gap_sec: Option<f64>,
    file_name: Option<String>,
    output_dir: Option<String>,
    sonic_model: Option<String>,
}

fn infer_catalog_voice(voice_id: &str, preferred_lang: Option<&str>) -> Option<(String, String)> {
    let target = voice_id.trim();
    if target.is_empty() {
        return None;
    }
    if target.starts_with("uv_") {
        return Some(("sonicvoice".to_string(), "vi".to_string()));
    }
    if let Some(sonic) = tts::sonicvoice::cached_voice(target) {
        return Some(("sonicvoice".to_string(), sonic.language));
    }
    let catalog = tts::providers::catalog();
    let entries = catalog.as_array()?;
    if let Some(lang) = preferred_lang {
        if let Some(hit) = entries.iter().find(|v| {
            v.get("id")
                .and_then(|x| x.as_str())
                .is_some_and(|id| id.eq_ignore_ascii_case(target))
                && v.get("language")
                    .and_then(|x| x.as_str())
                    .is_some_and(|l| l.eq_ignore_ascii_case(lang))
        }) {
            return Some((
                hit["provider"].as_str()?.to_string(),
                hit["language"].as_str()?.to_string(),
            ));
        }
    }
    let hit = entries.iter().find(|v| {
        v.get("id")
            .and_then(|x| x.as_str())
            .is_some_and(|id| id.eq_ignore_ascii_case(target))
    })?;
    Some((
        hit["provider"].as_str()?.to_string(),
        hit["language"].as_str()?.to_string(),
    ))
}

fn sanitize_stem(raw: Option<&str>) -> String {
    let fallback = || {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        format!("vo_{}", ts)
    };
    let Some(name) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return fallback();
    };
    let stem = Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(name);
    let clean: String = stem
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .chars()
        .take(64)
        .collect();
    if clean.is_empty() { fallback() } else { clean }
}

fn resolve_target_dir(
    app: &AppHandle,
    workspace: Option<&Path>,
    output_dir: Option<&str>,
) -> Result<PathBuf, String> {
    let studio_home = external::home(app);
    let Some(custom) = output_dir.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(match workspace {
            Some(ws) => ws.join(VOICE_DIR),
            None => studio_home.join("voice"),
        });
    };

    let custom_path = Path::new(custom);
    if custom_path
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err("outputDir cannot contain '..'".into());
    }

    if custom_path.is_absolute() {
        if workspace.is_some_and(|ws| custom_path.starts_with(ws))
            || custom_path.starts_with(&studio_home)
        {
            return Ok(custom_path.to_path_buf());
        }
        return Err(
            "Absolute outputDir must be inside the open project workspace or Video Studio folder."
                .into(),
        );
    }

    // Relative path starting with `projects/` targets a Video Studio code project.
    if custom.starts_with("projects/") || custom.starts_with("projects\\") || workspace.is_none() {
        return Ok(studio_home.join(custom_path));
    }
    Ok(workspace.unwrap().join(custom_path))
}

fn unique_dest_pair(dir: &Path, stem: &str, audio_ext: &str) -> (PathBuf, PathBuf) {
    let first_audio = dir.join(format!("{}.{}", stem, audio_ext));
    let first_srt = dir.join(format!("{}.srt", stem));
    if !first_audio.exists() && !first_srt.exists() {
        return (first_audio, first_srt);
    }
    for n in 2..10000 {
        let a = dir.join(format!("{}_{}.{}", stem, n, audio_ext));
        let s = dir.join(format!("{}_{}.srt", stem, n));
        if !a.exists() && !s.exists() {
            return (a, s);
        }
    }
    (first_audio, first_srt)
}

async fn generate_speech(
    app: &AppHandle,
    workspace: Option<&Path>,
    raw_args: &Value,
) -> Result<String, String> {
    let mut parsed: GenerateSpeechArgs = serde_json::from_value(raw_args.clone())
        .map_err(|e| format!("Invalid arguments for generate_speech: {}", e))?;

    let text = parsed.text.take().unwrap_or_default();
    let has_turns = parsed.turns.as_ref().is_some_and(|t| !t.is_empty());
    if text.trim().is_empty() && !has_turns {
        return Err("Provide non-empty `text` or `turns`.".into());
    }

    let profiles = load_profiles(app);

    // Infer narrator provider/language when voiceId or profileId is given without provider.
    if parsed.provider.is_none() {
        if let Some(ref pid) = parsed.profile_id {
            if let Some(prof) = find_profile(&profiles, pid) {
                parsed.provider = Some(if prof.model_id == "vieneu" {
                    "vieneu".to_string()
                } else {
                    "omnivoice".to_string()
                });
            }
        } else if let Some(ref vid) = parsed.voice_id {
            if let Some((prov, lang)) = infer_catalog_voice(vid, parsed.language.as_deref()) {
                parsed.provider = Some(prov);
                if parsed.language.is_none() {
                    parsed.language = Some(lang);
                }
            }
        }
    }

    // Also infer speaker providers from their voiceId/profileId when omitted.
    if let Some(ref mut map) = parsed.speakers {
        for spec in map.values_mut() {
            if spec.provider.is_none() {
                if let Some(ref pid) = spec.profile_id {
                    if let Some(prof) = find_profile(&profiles, pid) {
                        spec.provider = Some(if prof.model_id == "vieneu" {
                            "vieneu".to_string()
                        } else {
                            "omnivoice".to_string()
                        });
                    }
                } else if let Some(ref vid) = spec.voice_id {
                    if let Some((prov, lang)) = infer_catalog_voice(
                        vid,
                        spec.language.as_deref().or(parsed.language.as_deref()),
                    ) {
                        spec.provider = Some(prov);
                        if spec.language.is_none() {
                            spec.language = Some(lang);
                        }
                    }
                }
            }
            if spec.provider.as_deref() == Some("sonicvoice") && spec.sonic_provider.is_none() {
                if let Some(ref vid) = spec.voice_id {
                    spec.sonic_provider = tts::sonicvoice::cached_voice(vid).map(|v| v.sub_provider);
                }
            }
        }
    }

    // Pick a sensible default narrator voice if neither provider nor voiceId/profileId was passed.
    let lang = parsed
        .language
        .clone()
        .unwrap_or_else(|| "vi".to_string());
    let provider = parsed.provider.clone().unwrap_or_else(|| {
        if lang.eq_ignore_ascii_case("vi") {
            "capcut".to_string()
        } else if omnivoice_ready(app) {
            "omnivoice".to_string()
        } else {
            "capcut".to_string()
        }
    });
    if parsed.voice_id.is_none() && parsed.profile_id.is_none() && provider == "capcut" {
        if lang.eq_ignore_ascii_case("vi") {
            parsed.voice_id = Some("BV074_streaming".to_string());
        }
    }

    let mode = parsed.mode.unwrap_or_else(|| {
        if provider == "omnivoice" {
            if parsed.profile_id.is_some() {
                "clone".to_string()
            } else if parsed
                .instruction
                .as_deref()
                .is_some_and(|s| !s.trim().is_empty())
            {
                "design".to_string()
            } else {
                "auto".to_string()
            }
        } else {
            "auto".to_string()
        }
    });

    let split_mode = parsed
        .split_mode
        .unwrap_or_else(|| "sentence".to_string());
    let dest_dir = resolve_target_dir(app, workspace, parsed.output_dir.as_deref())?;
    std::fs::create_dir_all(&dest_dir)
        .map_err(|e| format!("Could not create {}: {}", dest_dir.display(), e))?;

    let sonic_provider = if provider == "sonicvoice" {
        parsed
            .voice_id
            .as_deref()
            .and_then(tts::sonicvoice::cached_voice)
            .map(|v| v.sub_provider)
    } else {
        None
    };

    let job_id = format!("mcp-tts-{}", uuid::Uuid::new_v4().simple());
    let payload = tts::TtsGeneratePayload {
        job_id,
        text,
        mode,
        provider: Some(provider.clone()),
        voice_id: parsed.voice_id,
        split_mode: Some(split_mode),
        language: Some(lang),
        speed: parsed.speed,
        num_step: None,
        advanced_settings: None,
        instruction: parsed.instruction,
        profile_id: parsed.profile_id,
        reference_audio_path: None,
        reference_text: None,
        speakers: parsed.speakers,
        turns: parsed.turns,
        gap_sec: parsed.gap_sec,
        sonic_provider,
        sonic_model: if provider == "sonicvoice" {
            parsed.sonic_model
        } else {
            None
        },
        sonic_pitch: None,
        sonic_stability: None,
        sonic_similarity: None,
    };

    let result = tts::run_tts_generate(app, payload).await?;
    if !result.success {
        return Err(result
            .error
            .unwrap_or_else(|| "TTS generation failed".to_string()));
    }
    let src_audio_str = result
        .output_path
        .ok_or_else(|| "TTS completed without an output file".to_string())?;
    let src_audio = PathBuf::from(&src_audio_str);
    let audio_ext = src_audio
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("wav");

    let stem = sanitize_stem(parsed.file_name.as_deref());
    let (dest_audio, dest_srt) = unique_dest_pair(&dest_dir, &stem, audio_ext);

    std::fs::copy(&src_audio, &dest_audio)
        .map_err(|e| format!("Could not save {}: {}", dest_audio.display(), e))?;
    let _ = std::fs::remove_file(&src_audio);

    let has_srt = if let Some(ref src_srt_str) = result.srt_path {
        let src_srt = Path::new(src_srt_str);
        if src_srt.is_file() {
            let copied = std::fs::copy(src_srt, &dest_srt).is_ok();
            let _ = std::fs::remove_file(src_srt);
            copied
        } else {
            false
        }
    } else {
        false
    };

    let in_workspace = workspace.filter(|ws| dest_audio.starts_with(ws));
    let audio_id = in_workspace.map(|ws| assets::id_for(ws, &dest_audio));
    let srt_id = if has_srt {
        in_workspace.map(|ws| assets::id_for(ws, &dest_srt))
    } else {
        None
    };

    let total_dur = result
        .duration_sec
        .or_else(|| crate::media::probe::duration_secs(&dest_audio))
        .unwrap_or(0.0);

    let mut summary = String::new();
    match audio_id {
        Some(id) => summary.push_str(&format!(
            "audio: {} ({}, {:.2}s)\n",
            id,
            dest_audio.display(),
            total_dur
        )),
        None => summary.push_str(&format!(
            "audio: {} ({:.2}s)\n",
            dest_audio.display(),
            total_dur
        )),
    }
    if has_srt {
        match srt_id {
            Some(id) => summary.push_str(&format!("srt: {} ({})\n", id, dest_srt.display())),
            None => summary.push_str(&format!("srt: {}\n", dest_srt.display())),
        }
    }
    if let Some(turns) = result.turns.as_ref().filter(|t| !t.is_empty()) {
        summary.push_str(&format!("turns ({}):\n", turns.len()));
        for (i, t) in turns.iter().enumerate() {
            summary.push_str(&format!(
                "  {}. {:.2}-{:.2}s [{}] {}\n",
                i + 1,
                t.start_sec,
                t.end_sec,
                t.speaker,
                t.text
            ));
        }
    }

    Ok(summary.trim_end().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn infers_provider_and_language_from_catalog_voice_id() {
        assert_eq!(
            infer_catalog_voice("BV074_streaming", None),
            Some(("capcut".to_string(), "vi".to_string()))
        );
        assert_eq!(
            infer_catalog_voice("Thiện Minh", None),
            Some(("vieneu".to_string(), "vi".to_string()))
        );
        assert_eq!(
            infer_catalog_voice("uv_10_abc", None),
            Some(("sonicvoice".to_string(), "vi".to_string()))
        );
    }

    #[test]
    fn sanitizes_filenames_safely() {
        assert_eq!(sanitize_stem(Some("vo_canh_1.wav")), "vo_canh_1");
        assert_eq!(sanitize_stem(Some("../bad/path/intro!.mp3")), "intro");
    }
}
