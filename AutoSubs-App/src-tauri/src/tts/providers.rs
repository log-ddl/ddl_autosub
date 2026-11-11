//! CapCut common_task transport, including its ElevenLabs voice route.
//! Protocol attribution: resources/tts/LICENSE-capcut-tts.txt (JutlyNe).
use super::paths::{app_data, output_root};
use super::{
    TtsGeneratePayload, TtsGenerateResult, allow_audio_file, emit_generate_progress,
    register_canceler, unregister_canceler,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use rand::{Rng, rngs::OsRng};
use rsa::{Pkcs1v15Encrypt, RsaPublicKey, pkcs8::DecodePublicKey};
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::AppHandle;
use uuid::Uuid;
const BASE: &str = "https://editor-api-sg.capcutapi.com";
const VERSION: &str = "8.7.0";
const AID: &str = "359289";
const MAX_AUDIO: usize = 20 * 1024 * 1024;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Voice {
    provider: String,
    id: String,
    resource_id: Option<String>,
    language: String,
}
pub fn catalog() -> Value {
    serde_json::from_str(include_str!("../../resources/tts/voices.json"))
        .expect("bundled voice catalog")
}
fn md5(s: &str) -> String {
    format!("{:x}", md5::compute(s))
}
fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
fn identity(app: &AppHandle) -> Result<Value, String> {
    let p = app_data(app)?.join("tts/capcut-installation.json");
    if p.is_file() {
        return serde_json::from_slice(&std::fs::read(p).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string());
    }
    let mut rng = rand::thread_rng();
    let mut id = || {
        format!(
            "7{}",
            (0..18)
                .map(|_| rng.gen_range(0..10).to_string())
                .collect::<String>()
        )
    };
    let value = json!({"deviceId":id(),"installId":id()});
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(p, value.to_string()).map_err(|e| e.to_string())?;
    Ok(value)
}
async fn post(
    client: &reqwest::Client,
    path: &str,
    body: Value,
    device: &Value,
    new: bool,
) -> Result<Value, String> {
    let did = device["deviceId"].as_str().ok_or("Invalid installation")?;
    let iid = device["installId"].as_str().ok_or("Invalid installation")?;
    let platform = if cfg!(target_os = "windows") {
        "windows"
    } else {
        "mac"
    };
    let mut url = reqwest::Url::parse(&format!("{BASE}{path}")).map_err(|e| e.to_string())?;
    url.query_pairs_mut().extend_pairs([
        ("app_name", "CapCut"),
        (
            "device_type",
            if platform == "mac" {
                "MacBookPro17,1"
            } else {
                "Windows"
            },
        ),
        (
            "device_brand",
            if platform == "mac" {
                "MacBookPro17,1"
            } else {
                "Windows"
            },
        ),
        (
            "os_version",
            if platform == "mac" {
                "15.7.4"
            } else {
                "10.0.22631"
            },
        ),
        ("channel", "capcutpc_google"),
        ("version_name", VERSION),
        ("version_code", VERSION),
        ("device_id", did),
        ("iid", iid),
        ("device_platform", platform),
        ("aid", AID),
    ]);
    if new {
        url.query_pairs_mut()
            .append_pair("region", "VN")
            .append_pair("babi_param", &feature().to_string());
    }
    let time = chrono::Utc::now().timestamp().to_string();
    let body = body.to_string();
    let sign = md5(&format!(
        "9e2c|{}|3|{VERSION}|{time}|{did}|11ac",
        &path[path.len() - 7..]
    ));
    let response = client
        .post(url)
        .header("content-type", "application/json")
        .header("appvr", VERSION)
        .header("ch", "capcutpc_google")
        .header("device-time", &time)
        .header("lan", "vi-VN")
        .header("loc", "VN")
        .header("pf", "3")
        .header("sign-ver", "1")
        .header("tdid", did)
        .header("x-ss-stub", md5(&body))
        .header("x-ss-dp", AID)
        .header("x-khronos", time)
        .header("appid", AID)
        .header("sign", sign)
        .header("store-country-code", "vn")
        .header("store-country-code-src", "did")
        .header("app-sdk-version", VERSION)
        .header("is-dispatch-us-ttp", "0")
        .header("is-app-region-us-ttp", "0")
        .header(
            "user-agent",
            "Cronet/TTNetVersion:1d7cc3b1 2025-07-16 QuicVersion:52c2b40d 2025-04-03",
        )
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("CapCut HTTP {}", response.status()));
    }
    if response.content_length().unwrap_or(0) > 4 * 1024 * 1024 {
        return Err("Provider response too large".into());
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("Provider response too large".into());
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if value["ret"] != 0 && value["ret"] != "0" {
        return Err(format!("CapCut: {} ({})", value["errmsg"], value["ret"]));
    }
    value["data"]["tasks"]
        .as_array()
        .and_then(|a| {
            if a.len() == 1 {
                a.first().cloned()
            } else {
                None
            }
        })
        .ok_or("Missing provider task".into())
}
fn feature() -> Value {
    json!({"feature_entrance":"editor","feature_entrance_detail":"editor-feature-text_to_speech","feature_key":"text_to_speech","scenario":"video_editor"})
}
fn safe_url(s: &str) -> bool {
    reqwest::Url::parse(s).ok().is_some_and(|u| {
        u.scheme() == "https"
            && u.username().is_empty()
            && u.password().is_none()
            && u.port_or_known_default() == Some(443)
            && u.host_str().is_some_and(|h| {
                [
                    "byteoversea.com",
                    "ibytedtos.com",
                    "ibyteimg.com",
                    "bytefcdn-oversea.com",
                    "capcutapi.com",
                    "tiktokcdn.com",
                ]
                .iter()
                .any(|d| h == *d || h.ends_with(&format!(".{d}")))
            })
    })
}
fn audio_url(v: &Value, depth: usize) -> Option<String> {
    if depth > 10 {
        return None;
    }
    match v {
        Value::String(s) if s.starts_with('{') || s.starts_with('[') => serde_json::from_str(s)
            .ok()
            .and_then(|v| audio_url(&v, depth + 1)),
        Value::Array(a) => a.iter().find_map(|v| audio_url(v, depth + 1)),
        Value::Object(o) => {
            for key in [
                "audio_url",
                "audio_url_v2",
                "download_url",
                "voice_url",
                "speech_url",
                "url",
            ] {
                if let Some(s) = o.get(key).and_then(Value::as_str) {
                    if safe_url(s) && (key != "url" || s.contains(".mp3")) {
                        return Some(s.into());
                    }
                }
            }
            [
                "payload",
                "result",
                "results",
                "data",
                "audio",
                "audios",
                "audio_list",
                "audio_subtitles",
                "voice_list",
                "utterances",
                "output",
                "outputs",
            ]
            .iter()
            .find_map(|k| o.get(*k).and_then(|v| audio_url(v, depth + 1)))
        }
        _ => None,
    }
}
fn submission(
    text: &str,
    speed: Option<f64>,
    voice: &Voice,
    device: &Value,
) -> Result<(Value, String), String> {
    let rid = voice
        .resource_id
        .as_deref()
        .ok_or("Missing voice resource")?;
    if text.trim().is_empty() || text.len() > 40000 {
        return Err("Text must contain 1 to 40000 UTF-8 bytes per part".into());
    }
    let platform = if voice.provider == "elevenlabs" {
        "11labs"
    } else {
        "sami"
    };
    let key = format!("{platform}_text_to_speech");
    let did = device["deviceId"].as_str().ok_or("Invalid installation")?;
    let ssml = format!(
        "<speak version=\"1.0\" xmlns=\"http://www.w3.org/2001/10/synthesis\" xml:lang=\"en-US\"><voice name=\"{}\" mock_tone_info=\"\" platform=\"{platform}\" resource_id=\"{rid}\" emotion=\"\" emotion_scale=\"0\" style=\"\" role=\"\" moyin_emotion=\"\" is_clone_tone=\"false\" need_subtitle_timestamp=\"false\"><prosody rate=\"{}\">{}</prosody></voice></speak>",
        xml(&voice.id),
        speed.unwrap_or(1.0).clamp(0.5, 2.0),
        xml(&text)
    );
    let extra = "{\"benefit_info\":{}}";
    let public =
        RsaPublicKey::from_public_key_pem(include_str!("../../resources/tts/capcut-public.pem"))
            .map_err(|e| e.to_string())?;
    let sign = STANDARD.encode(
        public
            .encrypt(
                &mut OsRng,
                Pkcs1v15Encrypt,
                format!(
                    "appid:{AID}&did:{did}&creditDisable:false&ssml:{}&extraInfo:{extra}",
                    md5(&ssml)
                )
                .as_bytes(),
            )
            .map_err(|e| e.to_string())?,
    );
    let payload = json!({"audio_format":"mp3","babi_param":feature().to_string(),"credit_disable":false,"extra_info":extra,"need_merge_voice":false,"need_subtitle_timestamp":false,"scene":"text_to_speech","ssml":ssml,"sign":sign});
    Ok((payload, key))
}
async fn online(app: &AppHandle, p: &TtsGeneratePayload) -> Result<TtsGenerateResult, String> {
    let provider = p.provider.as_deref().unwrap_or("omnivoice");
    let voices: Vec<Voice> = serde_json::from_str(include_str!("../../resources/tts/voices.json"))
        .map_err(|e| e.to_string())?;
    let voice = voices
        .iter()
        .find(|v| {
            v.provider == provider
                && Some(v.id.as_str()) == p.voice_id.as_deref()
                && Some(v.language.as_str()) == p.language.as_deref()
        })
        .ok_or("Select a voice from the catalog")?;
    let device = identity(app)?;
    let (payload, key) = submission(&p.text, p.speed, voice, &device)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    emit_generate_progress(
        app,
        &p.job_id,
        "submitting",
        Some(5.0),
        "tts.provider.submitting",
    );
    // Submit once only: transport uncertainty must not create a duplicate task.
    let task=post(&client,"/lv/v1/common_task/new",json!({"bind_id":Uuid::new_v4().to_string(),"can_queue":true,"enter_from":"text_to_speech","tasks":[{"context":Uuid::new_v4().to_string(),"payload":payload.to_string(),"req_key":key,"task_version":"v3"}]}),&device,true).await?;
    let id = task["id"]
        .as_str()
        .ok_or("Missing task ID; do not resubmit automatically")?;
    let token = task["token"].as_str().ok_or("Missing task token")?;
    loop {
        emit_generate_progress(
            app,
            &p.job_id,
            "processing",
            Some(30.0),
            "tts.provider.processing",
        );
        let task=post(&client,"/lv/v1/common_task/query",json!({"tasks":[{"bind_id":"","id":id,"token":token,"req_key":key,"task_version":"v3"}]}),&device,false).await?;
        if matches!(
            task["status"].as_str(),
            Some("failed" | "error" | "cancelled")
        ) || task
            .get("err_code")
            .is_some_and(|v| !v.is_null() && *v != 0 && *v != "0" && *v != "")
        {
            return Err("Provider could not generate this voice".into());
        }
        if let Some(url) = audio_url(&task, 0) {
            let response = client
                .get(url)
                .send()
                .await
                .map_err(|e| e.to_string())?
                .error_for_status()
                .map_err(|e| e.to_string())?;
            let mut stream = response.bytes_stream();
            use futures_util::StreamExt;
            let mut bytes = Vec::new();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| e.to_string())?;
                if bytes.len() + chunk.len() > MAX_AUDIO {
                    return Err("Audio exceeds 20 MB".into());
                }
                bytes.extend_from_slice(&chunk);
            }
            if bytes.len() < 4
                || !(bytes.starts_with(b"ID3") || bytes[0] == 255 && bytes[1] & 224 == 224)
            {
                return Err("Invalid MP3 response".into());
            }
            let dir = output_root(app)?;
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let output = dir.join(format!("{}.mp3", Uuid::new_v4()));
            std::fs::write(&output, bytes).map_err(|e| e.to_string())?;
            allow_audio_file(app, &output);
            let duration = crate::media::probe::duration_secs(&output);
            return Ok(TtsGenerateResult {
                success: true,
                output_path: Some(output.to_string_lossy().into()),
                sample_rate: None,
                duration_sec: duration,
                canceled: None,
                error: None,
                part_durations_sec: None,
                part_gap_sec: None,
            });
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}
pub async fn generate(app: &AppHandle, p: &TtsGeneratePayload) -> TtsGenerateResult {
    let cancel = register_canceler(&p.job_id);
    let result = tokio::select! { _=cancel=>TtsGenerateResult::canceled(), result=tokio::time::timeout(std::time::Duration::from_secs(180),online(app,p))=>match result {Ok(Ok(r))=>r,Ok(Err(e))=>TtsGenerateResult::err(e),Err(_)=>TtsGenerateResult::err("Provider timed out; task was not resubmitted")}};
    unregister_canceler(&p.job_id);
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn url_scope() {
        assert!(safe_url("https://v16m-default.tiktokcdn.com/a"));
        assert!(!safe_url("https://tiktokcdn.com.evil.test/a"));
        assert!(!safe_url("http://tiktokcdn.com/a"));
    }
    #[test]
    fn nested_result() {
        assert_eq!(
            audio_url(
                &json!({"payload":"{\"audio_url\":\"https://tiktokcdn.com/a\"}"}),
                0
            )
            .as_deref(),
            Some("https://tiktokcdn.com/a")
        );
    }
}

#[cfg(test)]
mod protocol_tests {
    use super::*;
    #[test]
    fn voice_selection_and_escaped_text() {
        let voice = Voice {
            provider: "elevenlabs".into(),
            id: "IRHApOXLvnW57QJPQH2P".into(),
            resource_id: Some("7369525170723099153".into()),
            language: "en".into(),
        };
        let (payload, key) = submission(
            "A & B < C",
            Some(1.0),
            &voice,
            &json!({"deviceId":"7000000000000000001"}),
        )
        .unwrap();
        assert_eq!(key, "11labs_text_to_speech");
        let ssml = payload["ssml"].as_str().unwrap();
        assert!(ssml.contains("name=\"IRHApOXLvnW57QJPQH2P\""));
        assert!(ssml.contains("platform=\"11labs\""));
        assert!(ssml.contains("A &amp; B &lt; C"));
        assert_eq!(
            STANDARD
                .decode(payload["sign"].as_str().unwrap())
                .unwrap()
                .len(),
            256
        );
    }
    #[test]
    fn bundled_catalog_is_selectable() {
        let voices: Vec<Voice> = serde_json::from_value(catalog()).unwrap();
        assert_eq!(
            voices.iter().filter(|v| v.provider == "elevenlabs").count(),
            9437
        );
        let mut seen = std::collections::HashSet::new();
        for voice in &voices {
            assert!(seen.insert((&voice.provider, &voice.language, &voice.id)));
        }
    }
    // Explicitly opt in: submits two short live provider requests, never runs in CI.
    #[tokio::test]
    #[ignore]
    async fn live_online_routes() {
        let voices: Vec<Voice> = serde_json::from_value(catalog()).unwrap();
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let device = json!({"deviceId":format!("7{:018}",rand::thread_rng().gen_range(0..1_000_000_000_000_000_000u64)),"installId":format!("7{:018}",rand::thread_rng().gen_range(0..1_000_000_000_000_000_000u64))});
        for (provider, id, lang, text) in [
            (
                "elevenlabs",
                "IRHApOXLvnW57QJPQH2P",
                "en",
                "Hello, this is a short voice test.",
            ),
            (
                "capcut",
                "BV074_streaming",
                "vi",
                "Xin chào, đây là bài thử giọng ngắn.",
            ),
        ] {
            let voice = voices
                .iter()
                .find(|v| v.provider == provider && v.id == id && v.language == lang)
                .unwrap();
            let (payload, key) = submission(text, Some(1.0), voice, &device).unwrap();
            let accepted=post(&client,"/lv/v1/common_task/new",json!({"bind_id":Uuid::new_v4().to_string(),"can_queue":true,"enter_from":"text_to_speech","tasks":[{"context":Uuid::new_v4().to_string(),"payload":payload.to_string(),"req_key":key,"task_version":"v3"}]}),&device,true).await.unwrap();
            let id = accepted["id"].as_str().unwrap();
            let token = accepted["token"].as_str().unwrap();
            let audio=tokio::time::timeout(std::time::Duration::from_secs(60),async {
                loop {
                    let task=post(&client,"/lv/v1/common_task/query",json!({"tasks":[{"bind_id":"","id":id,"token":token,"req_key":key,"task_version":"v3"}]}),&device,false).await.unwrap();
                    assert!(!matches!(task["status"].as_str(),Some("failed"|"error")),"Provider rejected voice");
                    if let Some(url)=audio_url(&task,0) {break client.get(url).send().await.unwrap().error_for_status().unwrap().bytes().await.unwrap();}
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
            }).await.unwrap();
            assert!(audio.len() > 1000);
            assert!(audio.starts_with(b"ID3") || audio[0] == 255 && audio[1] & 224 == 224);
            println!("{provider}: received {} audio bytes", audio.len());
        }
    }
}
