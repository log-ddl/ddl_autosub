//! SonicVoice (`https://sonicvoice.pro/api`) online TTS, voice cloning, and batch synthesis.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use futures_util::stream::{self, StreamExt};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;
use uuid::Uuid;

use crate::media::probe::duration_secs;

use super::paths::output_root;
use super::split::{
    DEFAULT_GAP_SEC, cleanup_split_tracking, cleanup_temp_outputs, is_split_canceled,
    merge_audio_segments_in_dir, register_split_subjobs,
};
use super::{
    TtsActionOutcome, TtsGeneratePayload, TtsGenerateResult, allow_audio_file,
    emit_generate_progress, register_canceler, take_job_canceled, unregister_canceler,
};

const DEFAULT_BASE_URL: &str = "https://sonicvoice.pro/api";
const ENV_BASE_URL: &str = "SONICVOICE_BASE_URL";
const ENV_API_KEY: &str = "SONICVOICE_API_KEY";
const STORE_FILE: &str = "autosubs-store.json";
const STORE_KEY: &str = "settings";
const STORE_FIELD: &str = "sonicvoiceApiKey";

const MAX_AUDIO_BYTES: usize = 250 * 1024 * 1024;
const MAX_CLONE_FILE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_BATCH_ITEMS: usize = 200;
const JOB_TIMEOUT_SECS: u64 = 600;
const SONIC_SAMPLE_RATE: u32 = 44100;

static HTTP_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .pool_idle_timeout(Duration::from_secs(90))
        .tcp_keepalive(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("SonicVoice HTTP client")
});

static SONIC_VOICE_CACHE: Lazy<Mutex<HashMap<String, SonicVoiceItem>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static SONIC_MODELS_CACHE: Lazy<Mutex<Vec<SonicModelItem>>> = Lazy::new(|| Mutex::new(Vec::new()));
static ACTIVE_REMOTE_JOBS: Lazy<Mutex<HashMap<String, String>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SonicVoiceItem {
    pub provider: String,
    pub id: String,
    pub name: String,
    pub language: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gender: Option<String>,
    pub sub_provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub owned: bool,
    pub ready: bool,
    pub featured: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SonicModelItem {
    pub model_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub badge: Option<String>,
    pub credit_ratio: f64,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_chars: Option<usize>,
    pub languages: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SonicBalance {
    pub balance_chars: i64,
    pub reserved_chars: i64,
    pub available_chars: i64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SonicVoicesQuery {
    pub sub_provider: Option<String>,
    pub language: Option<String>,
    pub gender: Option<String>,
    pub query: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

pub fn base_url() -> String {
    std::env::var(ENV_BASE_URL)
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
}

/// Read the SonicVoice API key from Settings (`autosubs-store.json`), falling
/// back to `SONICVOICE_API_KEY`.
pub fn api_key(app: &AppHandle) -> Option<String> {
    app.store(STORE_FILE)
        .ok()
        .and_then(|s| s.get(STORE_KEY))
        .and_then(|v| {
            v.get(STORE_FIELD)
                .and_then(|k| k.as_str())
                .map(str::to_string)
        })
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
        .or_else(|| {
            std::env::var(ENV_API_KEY)
                .ok()
                .map(|k| k.trim().to_string())
                .filter(|k| !k.is_empty())
        })
}

fn require_api_key(app: &AppHandle) -> Result<String, String> {
    api_key(app)
        .ok_or_else(|| "Missing SonicVoice API key. Paste it in the TTS panel or Settings.".into())
}

pub fn cached_voice(voice_id: &str) -> Option<SonicVoiceItem> {
    SONIC_VOICE_CACHE.lock().unwrap().get(voice_id).cloned()
}

fn cache_voices(items: &[SonicVoiceItem]) {
    let mut cache = SONIC_VOICE_CACHE.lock().unwrap();
    for item in items {
        cache.insert(item.id.clone(), item.clone());
    }
}

fn normalize_sub_provider(id: &str, raw: Option<&str>) -> String {
    if id.starts_with("uv_") {
        return "mini".to_string();
    }
    if let Some(p) = raw.map(str::trim).filter(|s| !s.is_empty()) {
        let lower = p.to_ascii_lowercase();
        if lower == "eleven" || lower == "elevenlabs" {
            return "eleven".to_string();
        }
        if lower == "mini" || lower == "minimax" {
            return "mini".to_string();
        }
    }
    if id.len() == 20 && id.chars().all(|c| c.is_ascii_alphanumeric()) {
        "eleven".to_string()
    } else {
        "mini".to_string()
    }
}

fn is_safe_preview_url(url: &str, base: &str) -> bool {
    if url.starts_with("https://") {
        return true;
    }
    if base.starts_with("http://127.0.0.1") || base.starts_with("http://localhost") {
        return url.starts_with("http://127.0.0.1") || url.starts_with("http://localhost");
    }
    false
}

fn map_voice_json(v: &Value, default_owned: bool, base: &str) -> Option<SonicVoiceItem> {
    let id = v.get("id")?.as_str()?.trim().to_string();
    if id.is_empty() {
        return None;
    }
    let name = v
        .get("name")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&id)
        .to_string();
    let language = v
        .get("language")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("vi")
        .to_string();
    let gender = v
        .get("gender")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_ascii_lowercase());
    let raw_prov = v.get("provider").and_then(|x| x.as_str());
    let sub_provider = normalize_sub_provider(&id, raw_prov);
    let preview_url = v
        .get("preview_url")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty() && is_safe_preview_url(s, base))
        .map(String::from);
    let description = v
        .get("description")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    let owned = v
        .get("owned")
        .and_then(|x| x.as_bool())
        .unwrap_or(default_owned || id.starts_with("uv_"));
    let ready = v.get("ready").and_then(|x| x.as_bool()).unwrap_or(true);
    let featured = v.get("featured").and_then(|x| x.as_bool()).unwrap_or(false);

    Some(SonicVoiceItem {
        provider: "sonicvoice".to_string(),
        id,
        name,
        language,
        gender,
        sub_provider,
        preview_url,
        description,
        owned,
        ready,
        featured,
    })
}

fn extract_error_detail(body: &str) -> Option<String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
        if let Some(detail) = val.get("detail") {
            if let Some(s) = detail.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                return Some(s.chars().take(240).collect());
            }
            if let Some(arr) = detail.as_array() {
                let msgs: Vec<String> = arr
                    .iter()
                    .filter_map(|item| {
                        item.get("msg")
                            .and_then(|m| m.as_str())
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(String::from)
                    })
                    .collect();
                if !msgs.is_empty() {
                    return Some(msgs.join("; ").chars().take(240).collect());
                }
            }
        }
        for key in ["error", "message", "msg"] {
            if let Some(s) = val
                .get(key)
                .and_then(|x| x.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                return Some(s.chars().take(240).collect());
            }
        }
    }
    Some(trimmed.chars().take(200).collect())
}

fn format_http_error(status: reqwest::StatusCode, body: &str) -> String {
    let code = status.as_u16();
    match code {
        401 => "SonicVoice: API key không hợp lệ hoặc bị thiếu".to_string(),
        402 => "SonicVoice: Không đủ ký tự trong tài khoản".to_string(),
        429 => "SonicVoice: Vượt giới hạn request/phút (429)".to_string(),
        _ => {
            let detail = extract_error_detail(body)
                .unwrap_or_else(|| status.canonical_reason().unwrap_or("Request failed").into());
            if status.is_client_error() {
                format!("SonicVoice ({code}): {detail}")
            } else {
                format!("SonicVoice HTTP {code}: {detail}")
            }
        }
    }
}

async fn send_json_request(req: reqwest::RequestBuilder) -> Result<Value, String> {
    let resp = req.send().await.map_err(|e| format!("SonicVoice network error: {e}"))?;
    let status = resp.status();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("SonicVoice read error: {e}"))?;
    let text = String::from_utf8_lossy(&bytes);
    if !status.is_success() {
        return Err(format_http_error(status, &text));
    }
    serde_json::from_slice(&bytes).map_err(|e| format!("SonicVoice invalid JSON response: {e}"))
}

async fn fetch_balance_with_base(base: &str, key: &str) -> Result<SonicBalance, String> {
    let req = HTTP_CLIENT
        .get(format!("{base}/v1/me/balance"))
        .header("X-API-Key", key);
    let val = send_json_request(req).await?;
    Ok(SonicBalance {
        balance_chars: val
            .get("balance_chars")
            .and_then(|x| x.as_i64())
            .unwrap_or(0),
        reserved_chars: val
            .get("reserved_chars")
            .and_then(|x| x.as_i64())
            .unwrap_or(0),
        available_chars: val
            .get("available_chars")
            .and_then(|x| x.as_i64())
            .unwrap_or(0),
    })
}

async fn fetch_models_with_base(base: &str, key: &str) -> Result<Vec<SonicModelItem>, String> {
    let req = HTTP_CLIENT
        .get(format!("{base}/v1/models"))
        .header("X-API-Key", key);
    let val = send_json_request(req).await?;
    let arr = val
        .as_array()
        .ok_or_else(|| "SonicVoice invalid models response".to_string())?;
    let mut models = Vec::with_capacity(arr.len());
    for item in arr {
        let Some(model_id) = item
            .get("model_id")
            .and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let name = item
            .get("name")
            .and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(model_id)
            .to_string();
        let languages = item
            .get("languages")
            .and_then(|x| x.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        models.push(SonicModelItem {
            model_id: model_id.to_string(),
            name,
            description: item
                .get("description")
                .and_then(|x| x.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from),
            badge: item
                .get("badge")
                .and_then(|x| x.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from),
            credit_ratio: item
                .get("credit_ratio")
                .and_then(|x| x.as_f64())
                .unwrap_or(1.0),
            provider: normalize_sub_provider(
                model_id,
                item.get("provider").and_then(|x| x.as_str()),
            ),
            max_chars: item
                .get("max_chars")
                .and_then(|x| x.as_u64())
                .map(|n| n as usize),
            languages,
        });
    }
    *SONIC_MODELS_CACHE.lock().unwrap() = models.clone();
    Ok(models)
}

async fn fetch_clones_with_base(base: &str, key: &str) -> Result<Vec<SonicVoiceItem>, String> {
    let req = HTTP_CLIENT
        .get(format!("{base}/v1/voices/mine/clones"))
        .header("X-API-Key", key);
    let val = send_json_request(req).await?;
    let arr = val
        .as_array()
        .ok_or_else(|| "SonicVoice invalid clones response".to_string())?;
    Ok(arr
        .iter()
        .filter_map(|item| map_voice_json(item, true, base))
        .collect())
}

async fn fetch_library_page_with_base(
    base: &str,
    key: &str,
    params: &[(&str, String)],
) -> Result<Vec<SonicVoiceItem>, String> {
    let req = HTTP_CLIENT
        .get(format!("{base}/v1/voices"))
        .header("X-API-Key", key)
        .query(params);
    let val = send_json_request(req).await?;
    let items = val
        .get("items")
        .and_then(|x| x.as_array())
        .ok_or_else(|| "SonicVoice invalid voices response".to_string())?;
    Ok(items
        .iter()
        .filter_map(|item| map_voice_json(item, false, base))
        .collect())
}

fn filter_items_locally(items: Vec<SonicVoiceItem>, query: &SonicVoicesQuery) -> Vec<SonicVoiceItem> {
    let lang = query
        .language
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("all"));
    let gender = query
        .gender
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("all"));
    let q = query
        .query
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase);

    items
        .into_iter()
        .filter(|v| {
            if let Some(l) = lang {
                if !v.language.eq_ignore_ascii_case(l) {
                    return false;
                }
            }
            if let Some(g) = gender {
                if !v
                    .gender
                    .as_deref()
                    .is_some_and(|vg| vg.eq_ignore_ascii_case(g))
                {
                    return false;
                }
            }
            if let Some(ref needle) = q {
                let hay_name = v.name.to_lowercase();
                let hay_id = v.id.to_lowercase();
                let hay_desc = v.description.as_deref().unwrap_or("").to_lowercase();
                if !hay_name.contains(needle) && !hay_id.contains(needle) && !hay_desc.contains(needle) {
                    return false;
                }
            }
            true
        })
        .collect()
}

fn dedup_voices(batches: Vec<Vec<SonicVoiceItem>>) -> Vec<SonicVoiceItem> {
    let mut seen = HashSet::new();
    let mut merged = Vec::new();
    for batch in batches {
        for item in batch {
            if seen.insert(item.id.clone()) {
                merged.push(item);
            }
        }
    }
    merged
}

async fn fetch_voices_with_base(
    base: &str,
    key: &str,
    query: &SonicVoicesQuery,
) -> Result<Vec<SonicVoiceItem>, String> {
    let sub_prov = query
        .sub_provider
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("all"))
        .map(str::to_ascii_lowercase);
    let lang = query
        .language
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("all"));
    let gender = query
        .gender
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("all"));
    let q = query
        .query
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let limit = query.limit.unwrap_or(200).clamp(1, 200);
    let offset = query.offset.unwrap_or(0);

    if sub_prov.as_deref() == Some("cloned") {
        let clones = fetch_clones_with_base(base, key).await?;
        let filtered = filter_items_locally(clones, query);
        let sliced: Vec<SonicVoiceItem> = filtered.into_iter().skip(offset).take(limit).collect();
        cache_voices(&sliced);
        return Ok(sliced);
    }

    let is_default_unfiltered = sub_prov.is_none()
        && lang.is_none()
        && gender.is_none()
        && q.is_none()
        && offset == 0;

    let is_eleven_unfiltered = sub_prov.as_deref() == Some("eleven")
        && lang.is_none()
        && gender.is_none()
        && q.is_none()
        && offset == 0;

    let merged = if is_default_unfiltered {
        let p_mini = vec![("provider", "mini".into()), ("limit", "200".into())];
        let p_eleven_vi = vec![
            ("provider", "eleven".into()),
            ("language", "vi".into()),
            ("limit", "200".into()),
        ];
        let p_eleven_trend = vec![
            ("provider", "eleven".into()),
            ("sort", "trending".into()),
            ("limit", "200".into()),
        ];
        let (clones_res, mini_res, eleven_vi_res, eleven_trend_res) = tokio::join!(
            fetch_clones_with_base(base, key),
            fetch_library_page_with_base(base, key, &p_mini),
            fetch_library_page_with_base(base, key, &p_eleven_vi),
            fetch_library_page_with_base(base, key, &p_eleven_trend),
        );
        dedup_voices(vec![
            clones_res?,
            mini_res?,
            eleven_vi_res?,
            eleven_trend_res?,
        ])
    } else if is_eleven_unfiltered {
        let p_eleven_vi = vec![
            ("provider", "eleven".into()),
            ("language", "vi".into()),
            ("limit", "200".into()),
        ];
        let p_eleven_trend = vec![
            ("provider", "eleven".into()),
            ("sort", "trending".into()),
            ("limit", "200".into()),
        ];
        let (eleven_vi_res, eleven_trend_res) = tokio::join!(
            fetch_library_page_with_base(base, key, &p_eleven_vi),
            fetch_library_page_with_base(base, key, &p_eleven_trend),
        );
        dedup_voices(vec![eleven_vi_res?, eleven_trend_res?])
    } else {
        let mut params = vec![
            ("limit", limit.to_string()),
            ("offset", offset.to_string()),
        ];
        if let Some(ref sp) = sub_prov {
            if sp == "mini" || sp == "eleven" {
                params.push(("provider", sp.clone()));
            }
        }
        if let Some(l) = lang {
            params.push(("language", l.to_string()));
        }
        if let Some(g) = gender {
            params.push(("gender", g.to_string()));
        }
        if let Some(qs) = q {
            params.push(("q", qs.to_string()));
        }

        if offset == 0 && sub_prov.as_deref() != Some("eleven") {
            let (clones_res, lib_res) = tokio::join!(
                fetch_clones_with_base(base, key),
                fetch_library_page_with_base(base, key, &params),
            );
            let clones = filter_items_locally(clones_res?, query);
            dedup_voices(vec![clones, lib_res?])
        } else {
            fetch_library_page_with_base(base, key, &params).await?
        }
    };

    cache_voices(&merged);
    Ok(merged)
}

pub async fn fetch_voices(
    app: &AppHandle,
    query: Option<SonicVoicesQuery>,
) -> Result<Vec<SonicVoiceItem>, String> {
    let key = require_api_key(app)?;
    let base = base_url();
    fetch_voices_with_base(&base, &key, &query.unwrap_or_default()).await
}

fn infer_audio_mime(path: &Path) -> (&'static str, String) {
    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.replace(['"', '\r', '\n'], "_"))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "sample.mp3".to_string());
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "ogg" => "audio/ogg",
        "webm" => "audio/webm",
        "flac" => "audio/flac",
        _ => "audio/mpeg",
    };
    (mime, filename)
}

fn append_text_part(body: &mut Vec<u8>, boundary: &str, name: &str, value: &str) {
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
    );
    body.extend_from_slice(value.as_bytes());
    body.extend_from_slice(b"\r\n");
}

async fn clone_voice_with_base(
    base: &str,
    key: &str,
    audio_path: &str,
    name: &str,
    language: Option<&str>,
    gender: Option<&str>,
    need_noise_reduction: bool,
) -> Result<SonicVoiceItem, String> {
    let clean_name = name.trim();
    let char_count = clean_name.chars().count();
    if char_count == 0 || char_count > 80 {
        return Err("SonicVoice: Tên giọng phải từ 1 đến 80 ký tự".into());
    }
    let path = Path::new(audio_path);
    if !path.is_file() {
        return Err("SonicVoice: Không tìm thấy file mẫu giọng".into());
    }
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_CLONE_FILE_BYTES {
        return Err("SonicVoice: File mẫu giọng vượt quá 20 MB".into());
    }
    if let Some(dur) = duration_secs(path) {
        if !(10.0..=300.0).contains(&dur) {
            return Err("SonicVoice: Mẫu giọng cần dài từ 10 đến 300 giây".into());
        }
    }

    let file_bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let (mime, filename) = infer_audio_mime(path);
    let lang = language
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("auto"))
        .unwrap_or("vi");
    let g = gender
        .map(str::trim)
        .filter(|s| matches!(*s, "female" | "male" | "neutral"))
        .unwrap_or("female");

    let boundary = format!("----autosubs-{}", Uuid::new_v4().simple());
    let mut body = Vec::with_capacity(file_bytes.len() + 1024);
    append_text_part(&mut body, &boundary, "name", clean_name);
    append_text_part(&mut body, &boundary, "language", lang);
    append_text_part(&mut body, &boundary, "gender", g);
    append_text_part(
        &mut body,
        &boundary,
        "need_noise_reduction",
        if need_noise_reduction { "true" } else { "false" },
    );
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        format!(
            "Content-Disposition: form-data; name=\"audio\"; filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(&file_bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    let req = HTTP_CLIENT
        .post(format!("{base}/v1/voices/clone"))
        .header("X-API-Key", key)
        .header("Content-Type", format!("multipart/form-data; boundary={boundary}"))
        .body(body);

    let val = send_json_request(req).await?;
    let item = map_voice_json(&val, true, base)
        .ok_or_else(|| "SonicVoice: Không đọc được kết quả nhân bản giọng".to_string())?;
    SONIC_VOICE_CACHE
        .lock()
        .unwrap()
        .insert(item.id.clone(), item.clone());
    Ok(item)
}

async fn delete_voice_with_base(base: &str, key: &str, voice_id: &str) -> Result<(), String> {
    let clean_id = voice_id.trim();
    if clean_id.is_empty()
        || !clean_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("SonicVoice: voice_id không hợp lệ".into());
    }
    let resp = HTTP_CLIENT
        .delete(format!("{base}/v1/voices/{clean_id}"))
        .header("X-API-Key", key)
        .send()
        .await
        .map_err(|e| format!("SonicVoice network error: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format_http_error(status, &text));
    }
    SONIC_VOICE_CACHE.lock().unwrap().remove(clean_id);
    Ok(())
}

fn mini_language_name(raw: Option<&str>) -> Option<&'static str> {
    let code = raw?.trim().to_ascii_lowercase();
    if code.is_empty() || code == "auto" {
        return None;
    }
    match code.as_str() {
        "vi" | "vietnamese" => Some("Vietnamese"),
        "en" | "english" => Some("English"),
        "ja" | "japanese" => Some("Japanese"),
        "ko" | "korean" => Some("Korean"),
        "zh" | "chinese" | "cmn" => Some("Chinese"),
        "fr" | "french" => Some("French"),
        "de" | "german" => Some("German"),
        "es" | "spanish" => Some("Spanish"),
        "pt" | "portuguese" => Some("Portuguese"),
        "ru" | "russian" => Some("Russian"),
        "th" | "thai" => Some("Thai"),
        "id" | "indonesian" => Some("Indonesian"),
        "it" | "italian" => Some("Italian"),
        "ar" | "arabic" => Some("Arabic"),
        "hi" | "hindi" => Some("Hindi"),
        "tr" | "turkish" => Some("Turkish"),
        "nl" | "dutch" => Some("Dutch"),
        "pl" | "polish" => Some("Polish"),
        "uk" | "ukrainian" => Some("Ukrainian"),
        "sv" | "swedish" => Some("Swedish"),
        "da" | "danish" => Some("Danish"),
        "fi" | "finnish" => Some("Finnish"),
        "cs" | "czech" => Some("Czech"),
        "ro" | "romanian" => Some("Romanian"),
        "el" | "greek" => Some("Greek"),
        "bg" | "bulgarian" => Some("Bulgarian"),
        "hr" | "croatian" => Some("Croatian"),
        "sk" | "slovak" => Some("Slovak"),
        "ms" | "malay" => Some("Malay"),
        "ta" | "tamil" => Some("Tamil"),
        "fil" | "filipino" | "tl" => Some("Filipino"),
        _ => None,
    }
}

fn normalize_iso_code(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "vietnamese" => "vi".into(),
        "english" => "en".into(),
        "japanese" => "ja".into(),
        "korean" => "ko".into(),
        "chinese" => "zh".into(),
        "french" => "fr".into(),
        "german" => "de".into(),
        "spanish" => "es".into(),
        "portuguese" => "pt".into(),
        "russian" => "ru".into(),
        "thai" => "th".into(),
        "indonesian" => "id".into(),
        "italian" => "it".into(),
        "arabic" => "ar".into(),
        "hindi" => "hi".into(),
        "turkish" => "tr".into(),
        "dutch" => "nl".into(),
        "polish" => "pl".into(),
        "ukrainian" => "uk".into(),
        other => other.to_string(),
    }
}

fn eleven_language_code(raw: Option<&str>, model_id: &str) -> Option<String> {
    let raw = raw?.trim();
    if raw.is_empty() || raw.eq_ignore_ascii_case("auto") {
        return None;
    }
    let code = normalize_iso_code(raw);
    let cache = SONIC_MODELS_CACHE.lock().unwrap();
    if let Some(model) = cache.iter().find(|m| m.model_id == model_id) {
        if !model.languages.is_empty()
            && !model
                .languages
                .iter()
                .any(|l| l.eq_ignore_ascii_case(&code))
        {
            return None;
        }
    }
    Some(code)
}

fn resolve_sub_provider(p: &TtsGeneratePayload, voice_id: &str) -> (String, bool) {
    if let Some(explicit) = p
        .sonic_provider
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return (normalize_sub_provider(voice_id, Some(explicit)), false);
    }
    if let Some(cached) = cached_voice(voice_id) {
        return (cached.sub_provider, false);
    }
    if voice_id.starts_with("uv_") {
        return ("mini".to_string(), false);
    }
    let guess = if voice_id.len() == 20 && voice_id.chars().all(|c| c.is_ascii_alphanumeric()) {
        "eleven".to_string()
    } else {
        "mini".to_string()
    };
    (guess, true)
}

fn snap_v3_stability(val: f64) -> f64 {
    if val < 0.25 {
        0.0
    } else if val < 0.75 {
        0.5
    } else {
        1.0
    }
}

fn build_job_body(
    p: &TtsGeneratePayload,
    voice_id: &str,
    sub_provider: &str,
    batch_texts: Option<&[String]>,
    batch_filenames: Option<&[String]>,
) -> Value {
    let mut obj = serde_json::Map::new();
    if let Some(texts) = batch_texts {
        obj.insert("kind".into(), json!("batch"));
        obj.insert("texts".into(), json!(texts));
        if let Some(names) = batch_filenames {
            obj.insert("filenames".into(), json!(names));
        }
    } else {
        obj.insert("kind".into(), json!("single"));
        obj.insert("text".into(), json!(p.text));
    }
    obj.insert("provider".into(), json!(sub_provider));
    obj.insert("voice_id".into(), json!(voice_id));

    if sub_provider == "eleven" {
        let model_id = p
            .sonic_model
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("eleven_v3");
        obj.insert("model".into(), json!(model_id));

        let speed = (p.speed.unwrap_or(1.0).clamp(0.7, 1.2) * 100.0).round() / 100.0;
        obj.insert("speed".into(), json!(speed));

        if let Some(lang) = eleven_language_code(p.language.as_deref(), model_id) {
            obj.insert("language".into(), json!(lang));
        }

        if model_id != "eleven_flash_v2" && model_id != "eleven_turbo_v2" {
            let raw_stab = p.sonic_stability.unwrap_or(0.5).clamp(0.0, 1.0);
            let stability = if model_id == "eleven_v3" {
                snap_v3_stability(raw_stab)
            } else {
                (raw_stab * 100.0).round() / 100.0
            };
            obj.insert("stability".into(), json!(stability));

            if model_id != "eleven_v3" {
                let sim = (p.sonic_similarity.unwrap_or(0.75).clamp(0.0, 1.0) * 100.0).round() / 100.0;
                obj.insert("similarity_boost".into(), json!(sim));
            }
        }
    } else {
        let speed = (p.speed.unwrap_or(1.0).clamp(0.5, 2.0) * 100.0).round() / 100.0;
        obj.insert("speed".into(), json!(speed));

        if let Some(pitch) = p.sonic_pitch.filter(|v| v.is_finite() && v.abs() > 0.01) {
            let clamped = (pitch.clamp(-12.0, 12.0) * 10.0).round() / 10.0;
            obj.insert("pitch".into(), json!(clamped));
        }
        if let Some(lang) = mini_language_name(p.language.as_deref()) {
            obj.insert("language".into(), json!(lang));
        }
    }

    Value::Object(obj)
}

fn poll_delay_ms(attempt: usize) -> u64 {
    match attempt {
        0 => 1000,
        1 => 1200,
        2 => 1500,
        3 => 1800,
        _ => 2200,
    }
}

fn is_transient_poll_error(err: &str) -> bool {
    err.starts_with("SonicVoice network error")
        || err.starts_with("SonicVoice read error")
        || err.starts_with("SonicVoice HTTP 5")
        || err.contains("(429)")
}

fn resolve_api_path_url(base: &str, rel_or_url: &str) -> Result<String, String> {
    let trimmed = rel_or_url.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let parsed = reqwest::Url::parse(trimmed).map_err(|e| format!("Invalid audio URL: {e}"))?;
        let base_parsed = reqwest::Url::parse(base).map_err(|e| format!("Invalid base URL: {e}"))?;
        if parsed.scheme() != "https" && parsed.host_str() != base_parsed.host_str() {
            return Err("SonicVoice: Unsafe non-HTTPS download redirect".into());
        }
        return Ok(trimmed.to_string());
    }
    let clean = if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    };
    if base.ends_with("/api") && clean.starts_with("/api/") {
        Ok(format!("{}{}", base.trim_end_matches("/api"), clean))
    } else {
        Ok(format!("{base}{clean}"))
    }
}

fn detect_audio_extension(bytes: &[u8], content_type: Option<&str>) -> Option<&'static str> {
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        return Some("wav");
    }
    if bytes.len() >= 4
        && (bytes.starts_with(b"ID3") || (bytes[0] == 0xFF && (bytes[1] & 0xE0) == 0xE0))
    {
        return Some("mp3");
    }
    if bytes.len() >= 4 && bytes.starts_with(b"OggS") {
        return Some("ogg");
    }
    if bytes.len() >= 4 && bytes.starts_with(b"fLaC") {
        return Some("flac");
    }
    if let Some(ct) = content_type.map(|s| s.to_ascii_lowercase()) {
        if ct.contains("json") || ct.contains("html") || ct.contains("text/plain") {
            return None;
        }
        if ct.contains("mpeg") || ct.contains("mp3") {
            return Some("mp3");
        }
        if ct.contains("wav") {
            return Some("wav");
        }
        if ct.contains("ogg") {
            return Some("ogg");
        }
        if ct.contains("flac") {
            return Some("flac");
        }
    }
    if bytes.starts_with(b"{") || bytes.starts_with(b"<") {
        return None;
    }
    Some("wav")
}

async fn download_sonic_binary(
    base: &str,
    key: &str,
    relative_path: &str,
) -> Result<(Vec<u8>, &'static str), String> {
    let url = resolve_api_path_url(base, relative_path)?;
    let base_parsed = reqwest::Url::parse(base).map_err(|e| e.to_string())?;
    let mut resp = HTTP_CLIENT
        .get(&url)
        .header("X-API-Key", key)
        .send()
        .await
        .map_err(|e| format!("SonicVoice download error: {e}"))?;

    if resp.status().is_redirection() {
        let loc = resp
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| "SonicVoice redirect missing Location".to_string())?
            .to_string();
        let target = reqwest::Url::parse(&url)
            .and_then(|u| u.join(&loc))
            .map_err(|e| format!("Invalid redirect URL: {e}"))?;
        let is_local_test = base.starts_with("http://127.0.0.1") || base.starts_with("http://localhost");
        if target.scheme() != "https" && !is_local_test {
            return Err("SonicVoice: Refusing non-HTTPS audio redirect".into());
        }
        let same_origin = target.host_str() == base_parsed.host_str()
            && target.port_or_known_default() == base_parsed.port_or_known_default();
        let mut req = HTTP_CLIENT.get(target);
        if same_origin {
            req = req.header("X-API-Key", key);
        }
        resp = req
            .send()
            .await
            .map_err(|e| format!("SonicVoice redirect download error: {e}"))?;
    }

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format_http_error(status, &text));
    }

    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(String::from);

    let mut stream = resp.bytes_stream();
    let mut buf = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("SonicVoice stream error: {e}"))?;
        if buf.len() + chunk.len() > MAX_AUDIO_BYTES {
            return Err("SonicVoice: Audio file exceeds 250 MB limit".into());
        }
        buf.extend_from_slice(&chunk);
    }

    if buf.len() < 16 {
        return Err("SonicVoice: Empty audio response".into());
    }
    let ext = detect_audio_extension(&buf, content_type.as_deref())
        .ok_or_else(|| "SonicVoice: Invalid audio response format".to_string())?;
    Ok((buf, ext))
}

fn spawn_remote_delete(base: String, key: String, remote_id: String) {
    let send = async move {
        let _ = HTTP_CLIENT
            .delete(format!("{base}/v1/tts/jobs/{remote_id}"))
            .header("X-API-Key", key)
            .send()
            .await;
    };
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(send);
    } else {
        std::thread::spawn(move || {
            if let Ok(rt) = tokio::runtime::Runtime::new() {
                rt.block_on(send);
            }
        });
    }
}

/// Request remote cancellation for a SonicVoice job (and any matching subjobs)
/// so SonicVoice refunds characters not yet synthesized.
pub fn cancel_remote_job(app: &AppHandle, local_job_id: &str) {
    let prefix = format!("{local_job_id}-");
    let removed: Vec<String> = {
        let mut map = ACTIVE_REMOTE_JOBS.lock().unwrap();
        let keys: Vec<String> = map
            .keys()
            .filter(|k| *k == local_job_id || k.starts_with(&prefix))
            .cloned()
            .collect();
        keys.into_iter().filter_map(|k| map.remove(&k)).collect()
    };
    if removed.is_empty() {
        return;
    }
    let Some(key) = api_key(app) else {
        return;
    };
    let base = base_url();
    for remote_id in removed {
        spawn_remote_delete(base.clone(), key.clone(), remote_id);
    }
}

pub fn cancel_all_remote_jobs(app: &AppHandle) {
    let removed: Vec<String> = {
        let mut map = ACTIVE_REMOTE_JOBS.lock().unwrap();
        map.drain().map(|(_, v)| v).collect()
    };
    if removed.is_empty() {
        return;
    }
    let Some(key) = api_key(app) else {
        return;
    };
    let base = base_url();
    for remote_id in removed {
        spawn_remote_delete(base.clone(), key.clone(), remote_id);
    }
}

fn cancel_tracked_with_base(base: &str, key: &str, local_job_id: &str) {
    let remote = ACTIVE_REMOTE_JOBS.lock().unwrap().remove(local_job_id);
    if let Some(remote_id) = remote {
        spawn_remote_delete(base.to_string(), key.to_string(), remote_id);
    }
}

async fn submit_job_with_fallback(
    base: &str,
    key: &str,
    p: &TtsGeneratePayload,
    voice_id: &str,
    batch_texts: Option<&[String]>,
    batch_filenames: Option<&[String]>,
) -> Result<Value, String> {
    let (sub_provider, is_guessed) = resolve_sub_provider(p, voice_id);
    let body = build_job_body(p, voice_id, &sub_provider, batch_texts, batch_filenames);
    let req = HTTP_CLIENT
        .post(format!("{base}/v1/tts/jobs"))
        .header("X-API-Key", key)
        .json(&body);

    match send_json_request(req).await {
        Ok(val) => {
            if is_guessed {
                SONIC_VOICE_CACHE.lock().unwrap().entry(voice_id.to_string()).or_insert(
                    SonicVoiceItem {
                        provider: "sonicvoice".into(),
                        id: voice_id.to_string(),
                        name: voice_id.to_string(),
                        language: p.language.clone().unwrap_or_else(|| "vi".into()),
                        gender: None,
                        sub_provider,
                        preview_url: None,
                        description: None,
                        owned: voice_id.starts_with("uv_"),
                        ready: true,
                        featured: false,
                    },
                );
            }
            Ok(val)
        }
        Err(err) if is_guessed && err.contains("422") && err.contains("Không tìm thấy giọng đọc") => {
            let alt = if sub_provider == "eleven" { "mini" } else { "eleven" };
            let alt_body = build_job_body(p, voice_id, alt, batch_texts, batch_filenames);
            let alt_req = HTTP_CLIENT
                .post(format!("{base}/v1/tts/jobs"))
                .header("X-API-Key", key)
                .json(&alt_body);
            let val = send_json_request(alt_req).await?;
            SONIC_VOICE_CACHE.lock().unwrap().insert(
                voice_id.to_string(),
                SonicVoiceItem {
                    provider: "sonicvoice".into(),
                    id: voice_id.to_string(),
                    name: voice_id.to_string(),
                    language: p.language.clone().unwrap_or_else(|| "vi".into()),
                    gender: None,
                    sub_provider: alt.to_string(),
                    preview_url: None,
                    description: None,
                    owned: voice_id.starts_with("uv_"),
                    ready: true,
                    featured: false,
                },
            );
            Ok(val)
        }
        Err(err) => Err(err),
    }
}

async fn poll_remote_job(
    base: &str,
    key: &str,
    remote_id: &str,
    app: Option<&AppHandle>,
    local_job_id: &str,
    emit_events: bool,
    progress_range: (f64, f64),
    is_batch: bool,
) -> Result<Value, String> {
    let mut attempt = 0usize;
    let mut transient_failures = 0u8;
    let mut skip_sleep = false;

    loop {
        if (is_batch && is_split_canceled(local_job_id)) || super::is_job_canceled(local_job_id) {
            cancel_tracked_with_base(base, key, local_job_id);
            return Err("Canceled".into());
        }
        if !skip_sleep {
            tokio::time::sleep(Duration::from_millis(poll_delay_ms(attempt))).await;
        }
        skip_sleep = false;
        attempt += 1;

        if (is_batch && is_split_canceled(local_job_id)) || super::is_job_canceled(local_job_id) {
            cancel_tracked_with_base(base, key, local_job_id);
            return Err("Canceled".into());
        }

        let req = HTTP_CLIENT
            .get(format!("{base}/v1/tts/jobs/{remote_id}"))
            .header("X-API-Key", key);
        let job = match send_json_request(req).await {
            Ok(j) => {
                transient_failures = 0;
                j
            }
            Err(err) if transient_failures < 3 && is_transient_poll_error(&err) => {
                transient_failures += 1;
                tokio::time::sleep(super::random_retry_delay()).await;
                skip_sleep = true;
                continue;
            }
            Err(err) => return Err(err),
        };

        let status = job["status"].as_str().unwrap_or("");
        if emit_events {
            if let Some(app_handle) = app {
                let done = job["progress_done"].as_f64().unwrap_or(0.0);
                let total = job["progress_total"].as_f64().unwrap_or(0.0);
                let (lo, hi) = progress_range;
                let pct = if total > 0.0 {
                    (lo + (done / total).clamp(0.0, 1.0) * (hi - lo)).min(hi)
                } else {
                    (lo + (attempt as f64 * 6.0)).min(hi)
                };
                emit_generate_progress(
                    app_handle,
                    local_job_id,
                    "processing",
                    Some(pct),
                    "tts.provider.processing",
                );
            }
        }

        match status {
            "admitted" | "running" => continue,
            "succeeded" => return Ok(job),
            "cancelled" | "canceled" => return Err("Canceled".into()),
            other => {
                let detail = job["error"]
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| format!("SonicVoice: {s}"))
                    .unwrap_or_else(|| format!("SonicVoice: Tạo giọng thất bại ({other})"));
                return Err(detail);
            }
        }
    }
}

async fn synthesize_single_with_base(
    app: Option<&AppHandle>,
    base: &str,
    key: &str,
    out_dir: &Path,
    p: &TtsGeneratePayload,
    emit_events: bool,
) -> Result<TtsGenerateResult, String> {
    let voice_id = p
        .voice_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Select a voice from the catalog".to_string())?;
    if p.text.trim().is_empty() {
        return Err("Text must contain 1 to 40000 UTF-8 bytes per part".into());
    }

    if emit_events {
        if let Some(app_handle) = app {
            emit_generate_progress(
                app_handle,
                &p.job_id,
                "submitting",
                Some(6.0),
                "tts.provider.submitting",
            );
        }
    }

    let created = submit_job_with_fallback(base, key, p, voice_id, None, None).await?;
    let remote_id = created["id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "SonicVoice: Missing job ID".to_string())?
        .to_string();

    ACTIVE_REMOTE_JOBS
        .lock()
        .unwrap()
        .insert(p.job_id.clone(), remote_id.clone());

    if super::is_job_canceled(&p.job_id) {
        cancel_tracked_with_base(base, key, &p.job_id);
        return Err("Canceled".into());
    }

    let poll_res = poll_remote_job(
        base,
        key,
        &remote_id,
        app,
        &p.job_id,
        emit_events,
        (12.0, 86.0),
        false,
    )
    .await;
    ACTIVE_REMOTE_JOBS.lock().unwrap().remove(&p.job_id);
    poll_res?;

    if emit_events {
        if let Some(app_handle) = app {
            emit_generate_progress(app_handle, &p.job_id, "saving", Some(92.0), "tts.progress.saving");
        }
    }

    let (bytes, ext) =
        download_sonic_binary(base, key, &format!("/v1/tts/jobs/{remote_id}/audio")).await?;
    std::fs::create_dir_all(out_dir).map_err(|e| e.to_string())?;
    let output = out_dir.join(format!("{}.{ext}", Uuid::new_v4()));
    std::fs::write(&output, bytes).map_err(|e| e.to_string())?;
    if let Some(app_handle) = app {
        allow_audio_file(app_handle, &output);
    }
    let duration = duration_secs(&output);

    Ok(TtsGenerateResult {
        success: true,
        output_path: Some(output.to_string_lossy().into_owned()),
        srt_path: None,
        sample_rate: Some(SONIC_SAMPLE_RATE),
        duration_sec: duration,
        canceled: None,
        error: None,
        part_durations_sec: None,
        part_gap_sec: None,
        turns: None,
    })
}

pub async fn generate(
    app: &AppHandle,
    p: &TtsGeneratePayload,
    emit_events: bool,
) -> TtsGenerateResult {
    let key = match require_api_key(app) {
        Ok(k) => k,
        Err(e) => return TtsGenerateResult::err(e),
    };
    let out_dir = match output_root(app) {
        Ok(d) => d,
        Err(e) => return TtsGenerateResult::err(e),
    };
    let base = base_url();
    let cancel = register_canceler(&p.job_id);
    if take_job_canceled(&p.job_id) {
        unregister_canceler(&p.job_id);
        cancel_tracked_with_base(&base, &key, &p.job_id);
        return TtsGenerateResult::canceled();
    }

    let result = tokio::select! {
        _ = cancel => {
            cancel_tracked_with_base(&base, &key, &p.job_id);
            TtsGenerateResult::canceled()
        }
        res = tokio::time::timeout(
            Duration::from_secs(JOB_TIMEOUT_SECS),
            synthesize_single_with_base(Some(app), &base, &key, &out_dir, p, emit_events),
        ) => match res {
            Ok(Ok(r)) => r,
            Ok(Err(e)) if e == "Canceled" => {
                cancel_tracked_with_base(&base, &key, &p.job_id);
                TtsGenerateResult::canceled()
            }
            Ok(Err(e)) => TtsGenerateResult::err(e),
            Err(_) => {
                cancel_tracked_with_base(&base, &key, &p.job_id);
                TtsGenerateResult::err("SonicVoice timed out; task was cancelled")
            }
        }
    };
    unregister_canceler(&p.job_id);
    result
}

fn validate_artifact_path(url: &str) -> bool {
    url.starts_with("/v1/tts/jobs/") || url.starts_with("/api/v1/tts/jobs/")
}

async fn batch_split_with_base(
    app: Option<&AppHandle>,
    base: &str,
    key: &str,
    out_dir: &Path,
    payload: &TtsGeneratePayload,
    parts: &[String],
) -> TtsGenerateResult {
    let parent_job_id = payload.job_id.clone();
    let voice_id = match payload
        .voice_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(v) => v.to_string(),
        None => return TtsGenerateResult::err("Select a voice from the catalog"),
    };
    let gap_sec = payload
        .gap_sec
        .filter(|g| g.is_finite())
        .unwrap_or(DEFAULT_GAP_SEC)
        .clamp(0.0, 5.0);

    if let Err(e) = std::fs::create_dir_all(out_dir) {
        return TtsGenerateResult::err(e.to_string());
    }
    register_split_subjobs(&parent_job_id, vec![]);

    let total_parts = parts.len();
    let mut downloaded_parts: Vec<PathBuf> = Vec::with_capacity(total_parts);
    let mut part_durations: Vec<f64> = Vec::with_capacity(total_parts);

    let chunks: Vec<&[String]> = parts.chunks(MAX_BATCH_ITEMS).collect();
    let chunk_count = chunks.len();
    let mut global_offset = 0usize;

    for (chunk_idx, chunk) in chunks.into_iter().enumerate() {
        if is_split_canceled(&parent_job_id) {
            cleanup_temp_outputs(&downloaded_parts);
            cleanup_split_tracking(&parent_job_id);
            return TtsGenerateResult::canceled();
        }

        if let Some(app_handle) = app {
            let pct = 4.0 + (chunk_idx as f64 / chunk_count as f64) * 70.0;
            emit_generate_progress(
                app_handle,
                &parent_job_id,
                "submitting",
                Some(pct),
                "tts.provider.submitting",
            );
        }

        let filenames: Vec<String> = (0..chunk.len())
            .map(|i| format!("part_{}", global_offset + i + 1))
            .collect();

        let created = match submit_job_with_fallback(
            base,
            key,
            payload,
            &voice_id,
            Some(chunk),
            Some(&filenames),
        )
        .await
        {
            Ok(v) => v,
            Err(e) => {
                cleanup_temp_outputs(&downloaded_parts);
                cleanup_split_tracking(&parent_job_id);
                return TtsGenerateResult::err(e);
            }
        };

        let remote_id = match created["id"].as_str().filter(|s| !s.is_empty()) {
            Some(id) => id.to_string(),
            None => {
                cleanup_temp_outputs(&downloaded_parts);
                cleanup_split_tracking(&parent_job_id);
                return TtsGenerateResult::err("SonicVoice: Missing batch job ID");
            }
        };

        ACTIVE_REMOTE_JOBS
            .lock()
            .unwrap()
            .insert(parent_job_id.clone(), remote_id.clone());

        if is_split_canceled(&parent_job_id) {
            cancel_tracked_with_base(base, key, &parent_job_id);
            cleanup_temp_outputs(&downloaded_parts);
            cleanup_split_tracking(&parent_job_id);
            return TtsGenerateResult::canceled();
        }

        let lo = 6.0 + (chunk_idx as f64 / chunk_count as f64) * 70.0;
        let hi = 6.0 + ((chunk_idx + 1) as f64 / chunk_count as f64) * 70.0;

        let cancel_rx = register_canceler(&parent_job_id);
        let poll_res = tokio::select! {
            _ = cancel_rx => {
                cancel_tracked_with_base(base, key, &parent_job_id);
                Err("Canceled".to_string())
            }
            res = tokio::time::timeout(
                Duration::from_secs(JOB_TIMEOUT_SECS),
                poll_remote_job(base, key, &remote_id, app, &parent_job_id, true, (lo, hi), true),
            ) => match res {
                Ok(r) => r,
                Err(_) => {
                    cancel_tracked_with_base(base, key, &parent_job_id);
                    Err("SonicVoice batch job timed out; task was cancelled".to_string())
                }
            }
        };
        unregister_canceler(&parent_job_id);
        ACTIVE_REMOTE_JOBS.lock().unwrap().remove(&parent_job_id);

        let job = match poll_res {
            Ok(j) => j,
            Err(e) => {
                cleanup_temp_outputs(&downloaded_parts);
                cleanup_split_tracking(&parent_job_id);
                if e == "Canceled" {
                    return TtsGenerateResult::canceled();
                }
                return TtsGenerateResult::err(e);
            }
        };

        let mut items = job["items"].as_array().cloned().unwrap_or_default();
        items.sort_by_key(|it| it["index"].as_u64().unwrap_or(0));
        if items.len() != chunk.len() {
            cleanup_temp_outputs(&downloaded_parts);
            cleanup_split_tracking(&parent_job_id);
            return TtsGenerateResult::err(format!(
                "SonicVoice: Batch output mismatch (expected {}, got {})",
                chunk.len(),
                items.len()
            ));
        }

        let mut artifact_urls = Vec::with_capacity(items.len());
        for item in &items {
            let url_opt = item["artifact_url"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty() && validate_artifact_path(s))
                .map(String::from)
                .or_else(|| {
                    item["artifact_node_id"]
                        .as_str()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(|nid| format!("/v1/tts/jobs/{remote_id}/artifacts/{nid}"))
                });
            let Some(url) = url_opt else {
                cleanup_temp_outputs(&downloaded_parts);
                cleanup_split_tracking(&parent_job_id);
                return TtsGenerateResult::err("SonicVoice: Missing batch artifact URL");
            };
            artifact_urls.push(url);
        }

        if let Some(app_handle) = app {
            emit_generate_progress(
                app_handle,
                &parent_job_id,
                "saving",
                Some(82.0),
                "tts.progress.saving",
            );
        }

        let base_owned = base.to_string();
        let key_owned = key.to_string();
        let downloads: Vec<(usize, Result<(Vec<u8>, &'static str), String>)> =
            stream::iter(artifact_urls.into_iter().enumerate())
                .map(|(i, url)| {
                    let b = base_owned.clone();
                    let k = key_owned.clone();
                    async move { (i, download_sonic_binary(&b, &k, &url).await) }
                })
                .buffer_unordered(4)
                .collect()
                .await;

        let mut ordered_files: Vec<Option<(Vec<u8>, &'static str)>> = vec![None; chunk.len()];
        for (i, res) in downloads {
            match res {
                Ok(data) => ordered_files[i] = Some(data),
                Err(e) => {
                    cleanup_temp_outputs(&downloaded_parts);
                    cleanup_split_tracking(&parent_job_id);
                    return TtsGenerateResult::err(e);
                }
            }
        }

        for (i, entry) in ordered_files.into_iter().enumerate() {
            let Some((bytes, ext)) = entry else {
                cleanup_temp_outputs(&downloaded_parts);
                cleanup_split_tracking(&parent_job_id);
                return TtsGenerateResult::err("SonicVoice: Missing downloaded part");
            };
            let part_path = out_dir.join(format!("{}-part-{}.{}", parent_job_id, global_offset + i, ext));
            if let Err(e) = std::fs::write(&part_path, bytes) {
                cleanup_temp_outputs(&downloaded_parts);
                cleanup_split_tracking(&parent_job_id);
                return TtsGenerateResult::err(e.to_string());
            }
            let dur = duration_secs(&part_path).unwrap_or(0.0);
            downloaded_parts.push(part_path);
            part_durations.push(dur);
        }
        global_offset += chunk.len();
    }

    if is_split_canceled(&parent_job_id) {
        cleanup_temp_outputs(&downloaded_parts);
        cleanup_split_tracking(&parent_job_id);
        return TtsGenerateResult::canceled();
    }

    let final_output = out_dir.join(format!("{}.wav", parent_job_id));
    if let Some(app_handle) = app {
        emit_generate_progress(
            app_handle,
            &parent_job_id,
            "merging",
            Some(94.0),
            "Merging audio segments...",
        );
    }

    let gaps = vec![gap_sec; downloaded_parts.len().saturating_sub(1)];
    let merged = merge_audio_segments_in_dir(
        out_dir,
        &parent_job_id,
        &downloaded_parts,
        &gaps,
        &final_output,
        SONIC_SAMPLE_RATE,
    )
    .await;

    cleanup_temp_outputs(&downloaded_parts);
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

    if let Some(app_handle) = app {
        allow_audio_file(app_handle, &final_output);
        emit_generate_progress(app_handle, &parent_job_id, "saving", Some(100.0), "Audio saved");
    }

    let total_duration = duration_secs(&final_output);
    let all_measured =
        part_durations.len() == parts.len() && part_durations.iter().all(|v| *v > 0.0);

    let (srt_path, turns) = if all_measured {
        let timing_inputs: Vec<(String, String, f64)> = parts
            .iter()
            .zip(part_durations.iter())
            .map(|(text, dur)| ("narrator".to_string(), text.clone(), *dur))
            .collect();
        let timings = super::dialogue::build_turn_timings(&timing_inputs, &gaps);
        let srt_file = out_dir.join(format!("{}.srt", parent_job_id));
        let saved = if super::dialogue::write_srt_file(&srt_file, &timings).is_ok() {
            if let Some(app_handle) = app {
                allow_audio_file(app_handle, &srt_file);
            }
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
        sample_rate: Some(SONIC_SAMPLE_RATE),
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

pub async fn generate_batch_split(
    app: &AppHandle,
    payload: TtsGeneratePayload,
    parts: Vec<String>,
) -> TtsGenerateResult {
    let key = match require_api_key(app) {
        Ok(k) => k,
        Err(e) => return TtsGenerateResult::err(e),
    };
    let out_dir = match output_root(app) {
        Ok(d) => d,
        Err(e) => return TtsGenerateResult::err(e),
    };
    let base = base_url();
    batch_split_with_base(Some(app), &base, &key, &out_dir, &payload, &parts).await
}

// ============================================================================
// Tauri Commands
// ============================================================================

#[tauri::command]
pub async fn tts_sonicvoice_balance(app: AppHandle) -> Result<SonicBalance, String> {
    let key = require_api_key(&app)?;
    fetch_balance_with_base(&base_url(), &key).await
}

#[tauri::command]
pub async fn tts_sonicvoice_models(app: AppHandle) -> Result<Vec<SonicModelItem>, String> {
    let key = require_api_key(&app)?;
    fetch_models_with_base(&base_url(), &key).await
}

#[tauri::command]
pub async fn tts_sonicvoice_voices(
    app: AppHandle,
    query: Option<SonicVoicesQuery>,
) -> Result<Vec<SonicVoiceItem>, String> {
    fetch_voices(&app, query).await
}

#[tauri::command]
pub async fn tts_sonicvoice_clone_voice(
    app: AppHandle,
    audio_path: String,
    name: String,
    language: Option<String>,
    gender: Option<String>,
    need_noise_reduction: Option<bool>,
) -> Result<SonicVoiceItem, String> {
    let key = require_api_key(&app)?;
    clone_voice_with_base(
        &base_url(),
        &key,
        &audio_path,
        &name,
        language.as_deref(),
        gender.as_deref(),
        need_noise_reduction.unwrap_or(true),
    )
    .await
}

#[tauri::command]
pub async fn tts_sonicvoice_delete_voice(
    app: AppHandle,
    voice_id: String,
) -> Result<TtsActionOutcome, String> {
    let key = require_api_key(&app)?;
    delete_voice_with_base(&base_url(), &key, &voice_id).await?;
    Ok(TtsActionOutcome {
        success: true,
        canceled: None,
        error: None,
        file_path: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn make_test_wav(duration_ms: u32) -> Vec<u8> {
        let sample_rate: u32 = 24000;
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
        bytes
    }

    async fn read_http_request(
        stream: &mut tokio::net::TcpStream,
    ) -> (String, String, HashMap<String, String>, Vec<u8>) {
        let mut buf = Vec::new();
        let mut tmp = [0u8; 4096];
        let header_end;
        loop {
            let n = stream.read(&mut tmp).await.unwrap();
            if n == 0 {
                panic!("unexpected EOF reading request");
            }
            buf.extend_from_slice(&tmp[..n]);
            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                header_end = pos + 4;
                break;
            }
        }
        let head_str = String::from_utf8_lossy(&buf[..header_end]).to_string();
        let mut lines = head_str.split("\r\n");
        let first = lines.next().unwrap_or("");
        let mut parts = first.split_whitespace();
        let method = parts.next().unwrap_or("").to_string();
        let target = parts.next().unwrap_or("").to_string();
        let mut headers = HashMap::new();
        for line in lines {
            if let Some((k, v)) = line.split_once(':') {
                headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
            }
        }
        let content_len: usize = headers
            .get("content-length")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        while buf.len() < header_end + content_len {
            let n = stream.read(&mut tmp).await.unwrap();
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&tmp[..n]);
        }
        let body = buf[header_end..header_end + content_len].to_vec();
        (method, target, headers, body)
    }

    async fn write_http_response(
        stream: &mut tokio::net::TcpStream,
        status: &str,
        content_type: &str,
        body: &[u8],
    ) {
        let header = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(header.as_bytes()).await.unwrap();
        stream.write_all(body).await.unwrap();
    }

    async fn spawn_mock_server<F, Fut>(handler: F) -> String
    where
        F: Fn(String, String, HashMap<String, String>, Vec<u8>) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = (&'static str, &'static str, Vec<u8>)> + Send,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handler = Arc::new(handler);
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let h = handler.clone();
                tokio::spawn(async move {
                    let (method, target, headers, body) = read_http_request(&mut stream).await;
                    let (status, ct, resp_body) = h(method, target, headers, body).await;
                    write_http_response(&mut stream, status, ct, &resp_body).await;
                });
            }
        });
        format!("http://{addr}")
    }

    fn base_payload(job_id: &str, voice_id: &str) -> TtsGeneratePayload {
        TtsGeneratePayload {
            job_id: job_id.into(),
            text: "Xin chào thế giới".into(),
            mode: "auto".into(),
            provider: Some("sonicvoice".into()),
            voice_id: Some(voice_id.into()),
            split_mode: Some("default".into()),
            language: Some("vi".into()),
            speed: Some(1.0),
            num_step: None,
            advanced_settings: None,
            instruction: None,
            profile_id: None,
            reference_audio_path: None,
            reference_text: None,
            speakers: None,
            turns: None,
            gap_sec: None,
            sonic_provider: None,
            sonic_model: None,
            sonic_pitch: None,
            sonic_stability: None,
            sonic_similarity: None,
        }
    }

    #[test]
    fn maps_languages_and_v3_stability_according_to_api_spec() {
        assert_eq!(mini_language_name(Some("vi")), Some("Vietnamese"));
        assert_eq!(mini_language_name(Some("en")), Some("English"));
        assert_eq!(mini_language_name(Some("auto")), None);

        assert_eq!(eleven_language_code(Some("auto"), "eleven_v3"), None);
        assert_eq!(
            eleven_language_code(Some("Vietnamese"), "eleven_v3").as_deref(),
            Some("vi")
        );

        let mut p = base_payload("j1", "elevenVoiceId1234567");
        p.sonic_provider = Some("eleven".into());
        p.sonic_model = Some("eleven_v3".into());
        p.sonic_stability = Some(0.8);
        p.speed = Some(1.8);
        let eleven_body = build_job_body(&p, "elevenVoiceId1234567", "eleven", None, None);
        assert_eq!(eleven_body["provider"], "eleven");
        assert_eq!(eleven_body["model"], "eleven_v3");
        assert_eq!(eleven_body["language"], "vi");
        assert_eq!(eleven_body["speed"], 1.2);
        assert_eq!(eleven_body["stability"], 1.0);
        assert!(eleven_body.get("similarity_boost").is_none());

        p.sonic_provider = Some("mini".into());
        p.sonic_pitch = Some(3.0);
        p.speed = Some(1.5);
        let mini_body = build_job_body(&p, "uv_10_abc", "mini", None, None);
        assert_eq!(mini_body["provider"], "mini");
        assert_eq!(mini_body["language"], "Vietnamese");
        assert_eq!(mini_body["speed"], 1.5);
        assert_eq!(mini_body["pitch"], 3.0);
    }

    #[tokio::test]
    async fn fetches_balance_models_and_normalizes_voices_with_dedup() {
        let base = spawn_mock_server(|method, target, headers, _| async move {
            assert_eq!(headers.get("x-api-key").map(String::as_str), Some("wp_test"));
            match (method.as_str(), target.as_str()) {
                ("GET", "/v1/me/balance") => (
                    "200 OK",
                    "application/json",
                    json!({"balance_chars": 5000, "reserved_chars": 200, "available_chars": 4800})
                        .to_string()
                        .into_bytes(),
                ),
                ("GET", "/v1/models") => (
                    "200 OK",
                    "application/json",
                    json!([
                        {
                            "model_id": "eleven_v3",
                            "name": "Eleven v3",
                            "credit_ratio": 1.5,
                            "provider": "eleven",
                            "max_chars": 50000,
                            "languages": ["vi", "en"]
                        },
                        {
                            "model_id": "speech-02-hd",
                            "name": "Speech 02 HD",
                            "credit_ratio": 1.0,
                            "provider": "minimax",
                            "languages": null
                        }
                    ])
                    .to_string()
                    .into_bytes(),
                ),
                ("GET", "/v1/voices/mine/clones") => (
                    "200 OK",
                    "application/json",
                    json!([
                        {
                            "id": "uv_1_mine",
                            "name": "My Clone",
                            "gender": "male",
                            "language": "vi",
                            "ready": true
                        }
                    ])
                    .to_string()
                    .into_bytes(),
                ),
                ("GET", t) if t.starts_with("/v1/voices?provider=mini") => (
                    "200 OK",
                    "application/json",
                    json!({
                        "items": [
                            {
                                "id": "uv_1_mine",
                                "name": "My Clone Dup",
                                "gender": "male",
                                "language": "vi",
                                "provider": "minimax"
                            },
                            {
                                "id": "mini_sarah",
                                "name": "Sarah",
                                "gender": "female",
                                "language": "vi",
                                "provider": "minimax",
                                "preview_url": "https://cdn.example.com/sarah.mp3"
                            }
                        ]
                    })
                    .to_string()
                    .into_bytes(),
                ),
                ("GET", t) if t.starts_with("/v1/voices?provider=eleven&language=vi") => (
                    "200 OK",
                    "application/json",
                    json!({
                        "items": [
                            {
                                "id": "ELVN1234567890ABCDEF",
                                "name": "Eleven Vi",
                                "gender": "female",
                                "language": "vi",
                                "provider": "eleven",
                                "preview_url": "https://cdn.example.com/el.mp3"
                            }
                        ]
                    })
                    .to_string()
                    .into_bytes(),
                ),
                ("GET", t) if t.starts_with("/v1/voices?provider=eleven") => (
                    "200 OK",
                    "application/json",
                    json!({
                        "items": [
                            {
                                "id": "ELVN1234567890ABCDEF",
                                "name": "Eleven Vi",
                                "gender": "female",
                                "language": "vi",
                                "provider": "eleven",
                                "preview_url": "https://cdn.example.com/el.mp3"
                            },
                            {
                                "id": "ELVNTREND12345678901",
                                "name": "Eleven Trending EN",
                                "gender": "male",
                                "language": "en",
                                "provider": "eleven"
                            }
                        ]
                    })
                    .to_string()
                    .into_bytes(),
                ),
                _ => ("404 Not Found", "application/json", b"{}".to_vec()),
            }
        })
        .await;

        let bal = fetch_balance_with_base(&base, "wp_test").await.unwrap();
        assert_eq!(bal.available_chars, 4800);

        let models = fetch_models_with_base(&base, "wp_test").await.unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[1].provider, "mini");
        assert!(models[1].languages.is_empty());

        let voices = fetch_voices_with_base(&base, "wp_test", &SonicVoicesQuery::default())
            .await
            .unwrap();
        assert_eq!(voices.len(), 4);
        assert_eq!(voices[0].id, "uv_1_mine");
        assert!(voices[0].owned);
        assert_eq!(voices[1].sub_provider, "mini");
        assert_eq!(voices[2].sub_provider, "eleven");
        assert_eq!(voices[3].id, "ELVNTREND12345678901");

        let eleven_only = fetch_voices_with_base(
            &base,
            "wp_test",
            &SonicVoicesQuery {
                sub_provider: Some("eleven".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(eleven_only.len(), 2);
        assert_eq!(eleven_only[0].id, "ELVN1234567890ABCDEF");
        assert_eq!(eleven_only[1].id, "ELVNTREND12345678901");
    }

    #[tokio::test]
    async fn clones_voice_via_multipart_form_data() {
        let dir = std::env::temp_dir().join(format!("sonic-clone-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let sample = dir.join("sample.wav");
        std::fs::write(&sample, make_test_wav(11_000)).unwrap();

        let base = spawn_mock_server(|method, target, headers, body| async move {
            assert_eq!(method, "POST");
            assert_eq!(target, "/v1/voices/clone");
            let ct = headers.get("content-type").cloned().unwrap_or_default();
            assert!(ct.starts_with("multipart/form-data; boundary="));
            let text = String::from_utf8_lossy(&body);
            assert!(text.contains("name=\"name\"\r\n\r\nGiọng Test"));
            assert!(text.contains("name=\"language\"\r\n\r\nvi"));
            assert!(text.contains("filename=\"sample.wav\""));
            (
                "200 OK",
                "application/json",
                json!({
                    "id": "uv_99_cloned",
                    "name": "Giọng Test",
                    "gender": "male",
                    "language": "vi",
                    "ready": true
                })
                .to_string()
                .into_bytes(),
            )
        })
        .await;

        let cloned = clone_voice_with_base(
            &base,
            "wp_test",
            sample.to_str().unwrap(),
            "Giọng Test",
            Some("vi"),
            Some("male"),
            true,
        )
        .await
        .unwrap();
        assert_eq!(cloned.id, "uv_99_cloned");
        assert!(cloned.owned);
        assert_eq!(cloned.sub_provider, "mini");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn single_job_fallback_polls_downloads_and_batch_merges() {
        let calls = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
        let poll_counts = Arc::new(Mutex::new(HashMap::<String, usize>::new()));
        let wav_bytes = Arc::new(make_test_wav(350));

        let calls_ref = calls.clone();
        let polls_ref = poll_counts.clone();
        let wav_ref = wav_bytes.clone();

        let base = spawn_mock_server(move |method, target, _, body| {
            let calls_ref = calls_ref.clone();
            let polls_ref = polls_ref.clone();
            let wav_ref = wav_ref.clone();
            async move {
                calls_ref
                    .lock()
                    .unwrap()
                    .push((method.clone(), target.clone()));
                match (method.as_str(), target.as_str()) {
                    ("POST", "/v1/tts/jobs") => {
                        let req_json: Value = serde_json::from_slice(&body).unwrap();
                        if req_json["kind"] == "single" && req_json["provider"] == "mini" {
                            return (
                                "422 Unprocessable Entity",
                                "application/json",
                                json!({"detail": "Không tìm thấy giọng đọc"}).to_string().into_bytes(),
                            );
                        }
                        if req_json["kind"] == "batch" {
                            return (
                                "200 OK",
                                "application/json",
                                json!({"id": "job-batch-1", "status": "admitted"})
                                    .to_string()
                                    .into_bytes(),
                            );
                        }
                        (
                            "200 OK",
                            "application/json",
                            json!({"id": "job-single-1", "status": "admitted"})
                                .to_string()
                                .into_bytes(),
                        )
                    }
                    ("GET", "/v1/tts/jobs/job-single-1") => {
                        let mut counts = polls_ref.lock().unwrap();
                        let c = counts.entry("single".into()).or_insert(0);
                        *c += 1;
                        let st = if *c == 1 { "running" } else { "succeeded" };
                        (
                            "200 OK",
                            "application/json",
                            json!({"id": "job-single-1", "status": st, "progress_done": 1, "progress_total": 1})
                                .to_string()
                                .into_bytes(),
                        )
                    }
                    ("GET", "/v1/tts/jobs/job-single-1/audio") => {
                        ("200 OK", "audio/wav", wav_ref.as_ref().clone())
                    }
                    ("GET", "/v1/tts/jobs/job-batch-1") => (
                        "200 OK",
                        "application/json",
                        json!({
                            "id": "job-batch-1",
                            "status": "succeeded",
                            "progress_done": 2,
                            "progress_total": 2,
                            "items": [
                                {"index": 0, "artifact_url": "/v1/tts/jobs/job-batch-1/artifacts/n0"},
                                {"index": 1, "artifact_url": "/v1/tts/jobs/job-batch-1/artifacts/n1"}
                            ]
                        })
                        .to_string()
                        .into_bytes(),
                    ),
                    ("GET", "/v1/tts/jobs/job-batch-1/artifacts/n0")
                    | ("GET", "/v1/tts/jobs/job-batch-1/artifacts/n1") => {
                        ("200 OK", "audio/wav", wav_ref.as_ref().clone())
                    }
                    ("DELETE", "/v1/tts/jobs/job-cancel-1") => (
                        "200 OK",
                        "application/json",
                        json!({"id": "job-cancel-1", "status": "cancelled"})
                            .to_string()
                            .into_bytes(),
                    ),
                    _ => ("404 Not Found", "application/json", b"{}".to_vec()),
                }
            }
        })
        .await;

        let out_dir = std::env::temp_dir().join(format!("sonic-gen-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&out_dir);

        // 1) Cold voice_id guessed as "mini" fails 422 "Không tìm thấy giọng đọc" and retries as "eleven"
        let p_single = base_payload("test-single-1", "cold_unknown_id");
        let res = synthesize_single_with_base(None, &base, "wp_test", &out_dir, &p_single, false)
            .await
            .unwrap();
        assert!(res.success);
        assert!(Path::new(res.output_path.as_ref().unwrap()).is_file());
        assert_eq!(cached_voice("cold_unknown_id").unwrap().sub_provider, "eleven");

        // 2) Batch split submits kind="batch", downloads artifacts, merges with FFmpeg, and writes .srt
        let mut p_batch = base_payload("test-batch-1", "cold_unknown_id");
        p_batch.gap_sec = Some(0.2);
        let parts = vec!["Câu thứ nhất.".to_string(), "Câu thứ hai.".to_string()];
        let batch_res = batch_split_with_base(None, &base, "wp_test", &out_dir, &p_batch, &parts).await;
        assert!(batch_res.success, "batch failed: {:?}", batch_res.error);
        assert!(Path::new(batch_res.output_path.as_ref().unwrap()).is_file());
        assert!(Path::new(batch_res.srt_path.as_ref().unwrap()).is_file());
        assert_eq!(batch_res.turns.as_ref().unwrap().len(), 2);

        // 3) Cancel dispatches DELETE /v1/tts/jobs/{id}
        ACTIVE_REMOTE_JOBS
            .lock()
            .unwrap()
            .insert("local-cancel".into(), "job-cancel-1".into());
        cancel_tracked_with_base(&base, "wp_test", "local-cancel");
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert!(
            calls
                .lock()
                .unwrap()
                .iter()
                .any(|(m, t)| m == "DELETE" && t == "/v1/tts/jobs/job-cancel-1")
        );

        let _ = std::fs::remove_dir_all(&out_dir);
    }
}
