//! Local OmniVoice TTS runtime, model manager, batch folder synthesis, and Tauri commands.

pub mod batch;
pub mod bootstrap;
pub mod dialogue;
pub mod managed_python;
pub mod paths;
pub mod providers;
pub mod sonicvoice;
pub mod split;
pub mod vieneu;
pub mod worker;

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

use self::batch::{
    TtsBatchSaveResult, TtsBatchScanResult, TtsBatchTextResult, read_batch_text, save_batch_output,
    scan_batch_folder,
};
use self::bootstrap::{ensure_runtime, has_nvidia_gpu, probe_runtime, run_step};
use self::paths::{
    OMNIVOICE_MODEL_ID, OMNIVOICE_REPOSITORY, is_model_installed, is_runtime_current, model_path,
    model_root, omnivoice_resource_dir, output_root, safe_profile_prompt_path, venv_python,
    worker_path,
};
use self::split::{
    cancel_all_splits, cancel_split_job, generate_split, split_lines, split_sentences,
};
use self::worker::{stop_worker, worker_request};

pub const EVENT_TTS_PROGRESS: &str = "tts-progress";

static CANCELED_JOBS: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));
static ACTIVE_CANCELERS: Lazy<Mutex<HashMap<String, oneshot::Sender<()>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

pub fn mark_job_canceled(job_id: &str) {
    CANCELED_JOBS.lock().unwrap().insert(job_id.to_string());
    if let Some(tx) = ACTIVE_CANCELERS.lock().unwrap().remove(job_id) {
        let _ = tx.send(());
    }
}

pub fn is_job_canceled(job_id: &str) -> bool {
    CANCELED_JOBS.lock().unwrap().contains(job_id)
}

pub fn take_job_canceled(job_id: &str) -> bool {
    CANCELED_JOBS.lock().unwrap().remove(job_id)
}

pub fn register_canceler(job_id: &str) -> oneshot::Receiver<()> {
    let (tx, rx) = oneshot::channel();
    ACTIVE_CANCELERS
        .lock()
        .unwrap()
        .insert(job_id.to_string(), tx);
    rx
}

pub fn unregister_canceler(job_id: &str) {
    ACTIVE_CANCELERS.lock().unwrap().remove(job_id);
}

pub fn allow_audio_file(app: &AppHandle, path: &Path) {
    let scope = app.asset_protocol_scope();
    let _ = scope.allow_file(path);
    if let Some(parent) = path.parent() {
        let _ = scope.allow_directory(parent, false);
    }
}

fn allow_output_dir(app: &AppHandle) {
    if let Ok(dir) = output_root(app) {
        let _ = std::fs::create_dir_all(&dir);
        let _ = app.asset_protocol_scope().allow_directory(&dir, true);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsProgressEvent {
    pub job_id: String,
    pub kind: String,
    pub stage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    pub message: String,
}

pub fn emit_install_progress(
    app: &AppHandle,
    job_id: &str,
    stage: &str,
    percent: Option<f64>,
    message: &str,
) {
    let _ = app.emit(
        EVENT_TTS_PROGRESS,
        TtsProgressEvent {
            job_id: job_id.to_string(),
            kind: "install".to_string(),
            stage: stage.to_string(),
            percent,
            message: message.to_string(),
        },
    );
}

pub fn emit_generate_progress(
    app: &AppHandle,
    job_id: &str,
    stage: &str,
    percent: Option<f64>,
    message: &str,
) {
    let _ = app.emit(
        EVENT_TTS_PROGRESS,
        TtsProgressEvent {
            job_id: job_id.to_string(),
            kind: "generate".to_string(),
            stage: stage.to_string(),
            percent,
            message: message.to_string(),
        },
    );
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsModelStatus {
    pub model_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_path: Option<String>,
    pub runtime_ready: bool,
    pub python_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cuda_available: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accelerator: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_key: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsAdvancedSettings {
    pub audio_chunk_duration: Option<f64>,
    pub audio_chunk_threshold: Option<f64>,
    pub guidance_scale: Option<f64>,
    pub t_shift: Option<f64>,
    pub position_temperature: Option<f64>,
    pub class_temperature: Option<f64>,
    pub layer_penalty_factor: Option<f64>,
    pub denoise: Option<bool>,
    pub preprocess_prompt: Option<bool>,
    pub postprocess_output: Option<bool>,
    pub pad_duration: Option<f64>,
    pub fade_duration: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsGeneratePayload {
    pub job_id: String,
    pub text: String,
    pub mode: String,
    pub provider: Option<String>,
    pub voice_id: Option<String>,
    pub split_mode: Option<String>,
    pub language: Option<String>,
    pub speed: Option<f64>,
    pub num_step: Option<u32>,
    pub advanced_settings: Option<TtsAdvancedSettings>,
    pub instruction: Option<String>,
    pub profile_id: Option<String>,
    pub reference_audio_path: Option<String>,
    pub reference_text: Option<String>,
    pub speakers: Option<HashMap<String, dialogue::TtsSpeakerVoice>>,
    pub turns: Option<Vec<dialogue::TtsDialogueTurn>>,
    pub gap_sec: Option<f64>,
    #[serde(default)]
    pub sonic_provider: Option<String>,
    #[serde(default)]
    pub sonic_model: Option<String>,
    #[serde(default)]
    pub sonic_pitch: Option<f64>,
    #[serde(default)]
    pub sonic_stability: Option<f64>,
    #[serde(default)]
    pub sonic_similarity: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsGenerateResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub srt_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_rate: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_sec: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canceled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part_durations_sec: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part_gap_sec: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turns: Option<Vec<dialogue::TtsTurnTiming>>,
}

impl TtsGenerateResult {
    pub fn err(msg: impl Into<String>) -> Self {
        Self {
            success: false,
            output_path: None,
            srt_path: None,
            sample_rate: None,
            duration_sec: None,
            canceled: None,
            error: Some(msg.into()),
            part_durations_sec: None,
            part_gap_sec: None,
            turns: None,
        }
    }

    pub fn canceled() -> Self {
        Self {
            success: false,
            output_path: None,
            srt_path: None,
            sample_rate: None,
            duration_sec: None,
            canceled: Some(true),
            error: None,
            part_durations_sec: None,
            part_gap_sec: None,
            turns: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsActionOutcome {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canceled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsPickedPath {
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsCancelResult {
    pub canceled: bool,
}

pub const QUEUE_DELAY_MIN_MS: u64 = 500;
pub const QUEUE_DELAY_MAX_MS: u64 = 1500;
pub const RETRY_DELAY_MIN_MS: u64 = 4500;
pub const RETRY_DELAY_MAX_MS: u64 = 5500;
pub const MAX_TTS_RETRIES: usize = 3;

static TTS_QUEUE: Lazy<tokio::sync::Mutex<Option<Instant>>> =
    Lazy::new(|| tokio::sync::Mutex::new(None));

pub fn random_queue_delay() -> Duration {
    Duration::from_millis(rand::thread_rng().gen_range(QUEUE_DELAY_MIN_MS..=QUEUE_DELAY_MAX_MS))
}

pub fn random_retry_delay() -> Duration {
    Duration::from_millis(rand::thread_rng().gen_range(RETRY_DELAY_MIN_MS..=RETRY_DELAY_MAX_MS))
}

pub async fn cancelable_sleep(job_id: &str, duration: Duration) -> bool {
    if duration.is_zero() {
        return !is_job_canceled(job_id);
    }
    if is_job_canceled(job_id) {
        return false;
    }
    let cancel = register_canceler(job_id);
    if is_job_canceled(job_id) {
        unregister_canceler(job_id);
        return false;
    }
    let completed = tokio::select! {
        _ = cancel => false,
        _ = tokio::time::sleep(duration) => !is_job_canceled(job_id),
    };
    unregister_canceler(job_id);
    completed
}

async fn acquire_tts_queue(
    job_id: &str,
) -> Option<tokio::sync::MutexGuard<'static, Option<Instant>>> {
    if is_job_canceled(job_id) {
        return None;
    }
    let cancel = register_canceler(job_id);
    if is_job_canceled(job_id) {
        unregister_canceler(job_id);
        return None;
    }
    let guard = tokio::select! {
        _ = cancel => None,
        g = TTS_QUEUE.lock() => {
            if is_job_canceled(job_id) {
                None
            } else {
                Some(g)
            }
        }
    };
    unregister_canceler(job_id);
    guard
}

fn is_non_retryable_tts_error(err: Option<&str>) -> bool {
    let Some(msg) = err else {
        return false;
    };
    let prefixes = [
        "Select a voice from the catalog",
        "Missing voice resource",
        "Text must contain 1 to 40000 UTF-8 bytes per part",
        "Unknown TTS provider",
        "Model is not installed",
        "OmniVoice runtime path unavailable",
        "OmniVoice Python runtime is not installed",
        "Install VieNeu first",
        "Voice Clone requires",
        "Voice Design requires",
        "Missing SonicVoice API key",
        "SonicVoice: API key",
        "SonicVoice: Không đủ ký tự",
        "SonicVoice (4",
    ];
    let substrings = [
        "Nội dung bị đánh dấu nhạy cảm",
        "Mẫu giọng này không dùng được",
        "Giọng đọc này hiện không dùng được",
        "Giọng này là giọng Professional",
    ];
    prefixes.iter().any(|prefix| msg.starts_with(prefix))
        || substrings.iter().any(|sub| msg.contains(sub))
}

fn clamp(val: Option<f64>, min: f64, max: f64, fallback: f64) -> f64 {
    let v = val.filter(|x| x.is_finite()).unwrap_or(fallback);
    v.clamp(min, max)
}

async fn synthesize_single_once(
    app: &AppHandle,
    payload: &TtsGeneratePayload,
    emit_events: bool,
) -> TtsGenerateResult {
    match payload.provider.as_deref().unwrap_or("omnivoice") {
        "capcut" | "elevenlabs" => return providers::generate(app, payload, emit_events).await,
        "sonicvoice" => return sonicvoice::generate(app, payload, emit_events).await,
        "vieneu" => return vieneu::generate(app, payload, emit_events).await,
        "omnivoice" => {}
        _ => return TtsGenerateResult::err("Unknown TTS provider"),
    }
    if !is_model_installed(app, OMNIVOICE_MODEL_ID) {
        return TtsGenerateResult::err("Model is not installed");
    }
    let Ok(py) = venv_python(app) else {
        return TtsGenerateResult::err("OmniVoice runtime path unavailable");
    };
    if !py.is_file() {
        return TtsGenerateResult::err("OmniVoice Python runtime is not installed");
    }

    if payload.mode == "clone" {
        let has_audio = payload
            .reference_audio_path
            .as_deref()
            .is_some_and(|s| !s.trim().is_empty() && Path::new(s).is_file());
        let has_text = payload
            .reference_text
            .as_deref()
            .is_some_and(|s| !s.trim().is_empty());
        if !has_audio || !has_text {
            return TtsGenerateResult::err(
                "Voice Clone requires an existing reference audio file and transcript",
            );
        }
    }
    if payload.mode == "design"
        && !payload
            .instruction
            .as_deref()
            .is_some_and(|s| !s.trim().is_empty())
    {
        return TtsGenerateResult::err("Voice Design requires a voice description");
    }

    let out_dir = match output_root(app) {
        Ok(d) => d,
        Err(e) => return TtsGenerateResult::err(e),
    };
    if let Err(e) = std::fs::create_dir_all(&out_dir) {
        return TtsGenerateResult::err(e.to_string());
    }
    let out_path = out_dir.join(format!("{}.wav", payload.job_id));
    let m_path = match model_path(app, OMNIVOICE_MODEL_ID) {
        Ok(p) => p,
        Err(e) => return TtsGenerateResult::err(e),
    };

    let adv_json = payload.advanced_settings.as_ref().map(|adv| {
        let chunk_dur = clamp(adv.audio_chunk_duration, 5.0, 60.0, 15.0);
        let mut chunk_thresh = clamp(adv.audio_chunk_threshold, 5.0, 120.0, 30.0);
        if chunk_thresh < chunk_dur {
            chunk_thresh = chunk_dur;
        }
        json!({
            "audioChunkDuration": chunk_dur,
            "audioChunkThreshold": chunk_thresh,
            "guidanceScale": clamp(adv.guidance_scale, 0.0, 5.0, 2.0),
            "tShift": clamp(adv.t_shift, 0.0, 1.0, 0.1),
            "positionTemperature": clamp(adv.position_temperature, 0.0, 10.0, 5.0),
            "classTemperature": clamp(adv.class_temperature, 0.0, 10.0, 0.0),
            "layerPenaltyFactor": clamp(adv.layer_penalty_factor, 0.0, 10.0, 5.0),
            "denoise": adv.denoise.unwrap_or(true),
            "preprocessPrompt": adv.preprocess_prompt.unwrap_or(true),
            "postprocessOutput": adv.postprocess_output.unwrap_or(true),
            "padDuration": clamp(adv.pad_duration, 0.0, 2.0, 0.1),
            "fadeDuration": clamp(adv.fade_duration, 0.0, 2.0, 0.1),
        })
    });

    let language_val = match payload.language.as_deref() {
        Some("auto") => serde_json::Value::Null,
        Some(code) if !code.trim().is_empty() => serde_json::Value::String(code.to_string()),
        _ => serde_json::Value::String("vi".to_string()),
    };

    let speed = clamp(payload.speed, 0.75, 1.5, 1.0);
    let num_step = match payload.num_step {
        Some(s) if [8, 12, 16, 24, 32].contains(&s) => s,
        _ => 24,
    };
    let prompt_path = safe_profile_prompt_path(app, payload.profile_id.as_deref())
        .map(|p| p.to_string_lossy().into_owned());

    let req = json!({
        "command": "generate",
        "modelPath": m_path.to_string_lossy(),
        "outputPath": out_path.to_string_lossy(),
        "promptPath": prompt_path,
        "text": payload.text,
        "mode": payload.mode,
        "language": language_val,
        "speed": speed,
        "numStep": num_step,
        "advancedSettings": adv_json,
        "instruction": payload.instruction,
        "referenceAudioPath": payload.reference_audio_path,
        "referenceText": payload.reference_text,
    });

    let res = worker_request(app, &payload.job_id, req, emit_events).await;
    let success = res
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !success {
        let canceled = res
            .get("canceled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
            || take_job_canceled(&payload.job_id);
        if canceled {
            return TtsGenerateResult::canceled();
        }
        let err = res
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("Failed to generate speech")
            .to_string();
        return TtsGenerateResult::err(err);
    }

    allow_audio_file(app, &out_path);

    TtsGenerateResult {
        success: true,
        output_path: Some(out_path.to_string_lossy().into_owned()),
        srt_path: None,
        sample_rate: res
            .get("sampleRate")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32),
        duration_sec: res.get("durationSec").and_then(|v| v.as_f64()),
        canceled: None,
        error: None,
        part_durations_sec: None,
        part_gap_sec: None,
        turns: None,
    }
}

pub async fn synthesize_single(
    app: &AppHandle,
    payload: TtsGeneratePayload,
    emit_events: bool,
) -> TtsGenerateResult {
    let Some(mut queue_guard) = acquire_tts_queue(&payload.job_id).await else {
        let _ = take_job_canceled(&payload.job_id);
        return TtsGenerateResult::canceled();
    };

    if let Some(prev) = *queue_guard {
        let target_gap = random_queue_delay();
        let elapsed = prev.elapsed();
        if elapsed < target_gap {
            if !cancelable_sleep(&payload.job_id, target_gap - elapsed).await {
                let _ = take_job_canceled(&payload.job_id);
                return TtsGenerateResult::canceled();
            }
        }
    }

    for attempt in 0..=MAX_TTS_RETRIES {
        let res = synthesize_single_once(app, &payload, emit_events).await;
        *queue_guard = Some(Instant::now());

        if res.success {
            return res;
        }
        if res.canceled == Some(true) || take_job_canceled(&payload.job_id) {
            return TtsGenerateResult::canceled();
        }
        if is_non_retryable_tts_error(res.error.as_deref()) || attempt == MAX_TTS_RETRIES {
            return res;
        }

        let backoff = random_retry_delay();
        tracing::warn!(
            job_id = %payload.job_id,
            attempt = attempt + 1,
            max_retries = MAX_TTS_RETRIES,
            delay_ms = backoff.as_millis() as u64,
            error = res.error.as_deref().unwrap_or("unknown"),
            "TTS call failed; backing off before retry"
        );
        if emit_events {
            emit_generate_progress(
                app,
                &payload.job_id,
                "retrying",
                None,
                &format!("Retrying ({}/{})...", attempt + 1, MAX_TTS_RETRIES),
            );
        }
        if !cancelable_sleep(&payload.job_id, backoff).await {
            let _ = take_job_canceled(&payload.job_id);
            return TtsGenerateResult::canceled();
        }
        *queue_guard = Some(Instant::now());
    }

    TtsGenerateResult::err("Failed to generate speech")
}

/// Terminate any active worker or background TTS child processes when the app exits.
pub fn shutdown(app: &AppHandle) {
    sonicvoice::cancel_all_remote_jobs(app);
    cancel_all_splits();
    let cancelers: Vec<(String, oneshot::Sender<()>)> =
        ACTIVE_CANCELERS.lock().unwrap().drain().collect();
    for (jid, tx) in cancelers {
        CANCELED_JOBS.lock().unwrap().insert(jid);
        let _ = tx.send(());
    }
    let _ = stop_worker(None);
}

// ============================================================================
// Tauri Commands
// ============================================================================

#[tauri::command]
pub async fn tts_get_status(app: AppHandle) -> Result<TtsModelStatus, String> {
    allow_output_dir(&app);

    let py_exists = venv_python(&app).map(|p| p.is_file()).unwrap_or(false);
    let runtime_ready = py_exists && is_runtime_current(&app);
    let (probe, nvidia_available) = tokio::join!(
        async {
            if runtime_ready {
                probe_runtime(&app).await
            } else {
                None
            }
        },
        has_nvidia_gpu()
    );

    let runtime_needs_repair = !runtime_ready
        || (nvidia_available && probe.as_ref().map(|p| p.backend.as_str()) != Some("cuda"));
    let installed = is_model_installed(&app, OMNIVOICE_MODEL_ID);
    let installed_path = if installed {
        model_path(&app, OMNIVOICE_MODEL_ID)
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
    } else {
        None
    };

    let status = if installed {
        if runtime_needs_repair {
            "incompatible"
        } else {
            "ready"
        }
    } else {
        "not-installed"
    };

    let message_key = if installed && runtime_needs_repair {
        Some("tts.runtime.repairRequired".to_string())
    } else if probe.as_ref().map(|p| p.backend.as_str()) == Some("mps") {
        Some("tts.runtime.mpsExperimental".to_string())
    } else if runtime_ready && probe.as_ref().map(|p| p.backend.as_str()) == Some("cpu") {
        Some("tts.runtime.cpuOnly".to_string())
    } else {
        None
    };

    Ok(TtsModelStatus {
        model_id: OMNIVOICE_MODEL_ID.to_string(),
        status: status.to_string(),
        installed_path,
        runtime_ready,
        python_available: true,
        cuda_available: probe.as_ref().map(|p| p.backend == "cuda"),
        accelerator: probe.map(|p| p.backend),
        message: None,
        message_key,
    })
}

#[tauri::command]
pub async fn tts_install_model(app: AppHandle, job_id: String) -> Result<TtsActionOutcome, String> {
    let result: Result<(), String> = async {
        let _ = omnivoice_resource_dir(&app)?;
        ensure_runtime(&app, &job_id).await?;

        let root = model_root(&app)?;
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let target_dir = model_path(&app, OMNIVOICE_MODEL_ID)?;
        let py = venv_python(&app)?.to_string_lossy().into_owned();
        let worker = worker_path(&app)?.to_string_lossy().into_owned();

        run_step(
            &app,
            &job_id,
            &py,
            &[
                "-X".into(),
                "utf8".into(),
                worker,
                "download".into(),
                "--repository".into(),
                OMNIVOICE_REPOSITORY.into(),
                "--output".into(),
                target_dir.to_string_lossy().into_owned(),
            ],
            "model.download",
            50.0,
        )
        .await?;

        std::fs::write(
            target_dir.join(".model-ready"),
            format!("{}\n", OMNIVOICE_REPOSITORY),
        )
        .map_err(|e| e.to_string())?;

        emit_install_progress(&app, &job_id, "done", Some(100.0), "OmniVoice is ready");
        Ok(())
    }
    .await;

    match result {
        Ok(()) => {
            let _ = take_job_canceled(&job_id);
            Ok(TtsActionOutcome {
                success: true,
                canceled: None,
                error: None,
                file_path: None,
            })
        }
        Err(err) => {
            let canceled = take_job_canceled(&job_id) || err == "Canceled";
            Ok(TtsActionOutcome {
                success: false,
                canceled: Some(canceled),
                error: if canceled { None } else { Some(err) },
                file_path: None,
            })
        }
    }
}

#[tauri::command]
pub async fn tts_remove_model(app: AppHandle) -> Result<TtsActionOutcome, String> {
    let _ = stop_worker(None);
    let target = model_path(&app, OMNIVOICE_MODEL_ID)?;
    if target.exists() {
        std::fs::remove_dir_all(&target).map_err(|e| e.to_string())?;
    }
    Ok(TtsActionOutcome {
        success: true,
        canceled: None,
        error: None,
        file_path: None,
    })
}

#[tauri::command]
pub async fn tts_remove_voice_prompt(
    app: AppHandle,
    profile_id: String,
) -> Result<TtsActionOutcome, String> {
    if let Some(prompt_file) = safe_profile_prompt_path(&app, Some(&profile_id)) {
        if prompt_file.is_file() {
            let _ = std::fs::remove_file(prompt_file);
        }
    }
    Ok(TtsActionOutcome {
        success: true,
        canceled: None,
        error: None,
        file_path: None,
    })
}

pub async fn run_tts_generate(
    app: &AppHandle,
    mut payload: TtsGeneratePayload,
) -> Result<TtsGenerateResult, String> {
    allow_output_dir(app);
    if payload.job_id.is_empty()
        || payload.job_id.len() > 120
        || !payload
            .job_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid job ID".into());
    }

    let profiles = dialogue::load_profiles(app);
    dialogue::hydrate_payload_profile(&mut payload, &profiles);

    let has_explicit_turns = payload.turns.as_ref().is_some_and(|t| !t.is_empty());
    let has_dialogue_tags = !dialogue::extract_dialogue_tags(&payload.text).is_empty();
    let has_speakers_map = payload.speakers.as_ref().is_some_and(|s| !s.is_empty());
    if has_explicit_turns || has_dialogue_tags || has_speakers_map {
        return Ok(dialogue::generate_dialogue(app, payload).await);
    }

    if let Some(mode) = payload.split_mode.as_deref() {
        if mode != "default" {
            let parts = if mode == "line" {
                split_lines(&payload.text)
            } else {
                split_sentences(&payload.text)
            };
            if parts.len() > 1 {
                return Ok(generate_split(app, payload, parts).await);
            }
        }
    }

    let is_preview = payload.job_id.starts_with("preview-");
    let spoken_text = payload.text.trim().to_string();
    let job_id = payload.job_id.clone();
    let mut res = synthesize_single(app, payload, true).await;
    if res.success && !is_preview && !spoken_text.is_empty() {
        if let Some(out_str) = res.output_path.clone() {
            let out_p = Path::new(&out_str);
            let dur = res
                .duration_sec
                .or_else(|| crate::media::probe::duration_secs(out_p))
                .unwrap_or(0.0);
            res.duration_sec = if dur > 0.0 { Some(dur) } else { res.duration_sec };
            if dur > 0.0 {
                let timings = dialogue::build_turn_timings(
                    &[("narrator".to_string(), spoken_text, dur)],
                    &[],
                );
                if let Ok(out_dir) = output_root(app) {
                    let srt_file = out_dir.join(format!("{}.srt", job_id));
                    if dialogue::write_srt_file(&srt_file, &timings).is_ok() {
                        allow_audio_file(app, &srt_file);
                        res.srt_path = Some(srt_file.to_string_lossy().into_owned());
                    }
                }
                res.turns = Some(timings);
            }
        }
    }
    Ok(res)
}

#[tauri::command]
pub async fn tts_generate(
    app: AppHandle,
    payload: TtsGeneratePayload,
) -> Result<TtsGenerateResult, String> {
    run_tts_generate(&app, payload).await
}

#[tauri::command]
pub fn tts_sync_profiles(
    app: AppHandle,
    profiles: Vec<dialogue::SavedVoiceProfile>,
) -> Result<(), String> {
    dialogue::save_profiles(&app, &profiles)
}

#[tauri::command]
pub fn tts_cancel_job(app: AppHandle, job_id: String) -> TtsCancelResult {
    sonicvoice::cancel_remote_job(&app, &job_id);
    if cancel_split_job(&job_id) {
        return TtsCancelResult { canceled: true };
    }
    let had_canceler = ACTIVE_CANCELERS.lock().unwrap().contains_key(&job_id);
    mark_job_canceled(&job_id);
    let stopped_worker = stop_worker(Some(&job_id));
    TtsCancelResult {
        canceled: had_canceler || stopped_worker,
    }
}

#[tauri::command]
pub async fn tts_pick_reference_audio(
    app: AppHandle,
    title: Option<String>,
) -> Result<TtsPickedPath, String> {
    let (tx, rx) = oneshot::channel();
    let mut builder = app
        .dialog()
        .file()
        .add_filter("Audio", &["wav", "mp3", "m4a", "aac", "flac", "ogg"]);
    if let Some(t) = title.filter(|s| !s.is_empty()) {
        builder = builder.set_title(t);
    }
    builder.pick_file(move |picked| {
        let _ = tx.send(picked.and_then(|f| f.into_path().ok()));
    });
    let path = rx
        .await
        .ok()
        .flatten()
        .map(|p| p.to_string_lossy().into_owned());
    Ok(TtsPickedPath { path })
}

#[tauri::command]
pub async fn tts_export_audio(
    app: AppHandle,
    source_path: String,
    title: Option<String>,
) -> Result<TtsActionOutcome, String> {
    let src = Path::new(&source_path);
    if !src.is_file() {
        return Ok(TtsActionOutcome {
            success: false,
            canceled: None,
            error: Some("Audio file not found".to_string()),
            file_path: None,
        });
    }
    let raw_ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("wav");
    let (ext, filter_label) = if raw_ext.eq_ignore_ascii_case("mp3") {
        ("mp3", "MP3 audio")
    } else if raw_ext.eq_ignore_ascii_case("srt") {
        ("srt", "SRT subtitle")
    } else {
        ("wav", "WAV audio")
    };
    let default_name = src
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("speech.wav")
        .to_string();

    let (tx, rx) = oneshot::channel();
    let mut builder = app
        .dialog()
        .file()
        .set_file_name(default_name)
        .add_filter(filter_label, &[ext]);
    if let Some(t) = title.filter(|s| !s.is_empty()) {
        builder = builder.set_title(t);
    }
    builder.save_file(move |picked| {
        let _ = tx.send(picked.and_then(|f| f.into_path().ok()));
    });

    let Some(dest) = rx.await.ok().flatten() else {
        return Ok(TtsActionOutcome {
            success: false,
            canceled: Some(true),
            error: None,
            file_path: None,
        });
    };

    std::fs::copy(src, &dest).map_err(|e| e.to_string())?;
    Ok(TtsActionOutcome {
        success: true,
        canceled: None,
        error: None,
        file_path: Some(dest.to_string_lossy().into_owned()),
    })
}

#[tauri::command]
pub fn tts_reveal_audio(app: AppHandle, file_path: String) -> TtsActionOutcome {
    let p = Path::new(&file_path);
    if !p.exists() {
        return TtsActionOutcome {
            success: false,
            canceled: None,
            error: Some("Audio file not found".to_string()),
            file_path: None,
        };
    }
    match app.opener().reveal_item_in_dir(p) {
        Ok(()) => TtsActionOutcome {
            success: true,
            canceled: None,
            error: None,
            file_path: None,
        },
        Err(e) => TtsActionOutcome {
            success: false,
            canceled: None,
            error: Some(e.to_string()),
            file_path: None,
        },
    }
}

#[tauri::command]
pub async fn tts_pick_batch_folder(
    app: AppHandle,
    title: Option<String>,
) -> Result<TtsPickedPath, String> {
    let (tx, rx) = oneshot::channel();
    let mut builder = app.dialog().file();
    if let Some(t) = title.filter(|s| !s.is_empty()) {
        builder = builder.set_title(t);
    }
    builder.pick_folder(move |picked| {
        let _ = tx.send(picked.and_then(|f| f.into_path().ok()));
    });
    let path = rx
        .await
        .ok()
        .flatten()
        .map(|p| p.to_string_lossy().into_owned());
    Ok(TtsPickedPath { path })
}

#[tauri::command]
pub fn tts_scan_batch_folder(app: AppHandle, folder_path: String) -> TtsBatchScanResult {
    scan_batch_folder(&app, &folder_path)
}

#[tauri::command]
pub fn tts_read_batch_text(file_path: String) -> TtsBatchTextResult {
    read_batch_text(&file_path)
}

#[tauri::command]
pub fn tts_save_batch_output(
    app: AppHandle,
    source_path: String,
    text_file_path: String,
) -> TtsBatchSaveResult {
    save_batch_output(&app, &source_path, &text_file_path)
}

#[tauri::command]
pub fn tts_open_batch_folder(app: AppHandle, folder_path: String) -> TtsActionOutcome {
    let p = Path::new(&folder_path);
    if !p.is_dir() {
        return TtsActionOutcome {
            success: false,
            canceled: None,
            error: Some("Folder not found".to_string()),
            file_path: None,
        };
    }
    match app.opener().open_path(&folder_path, None::<&str>) {
        Ok(()) => TtsActionOutcome {
            success: true,
            canceled: None,
            error: None,
            file_path: None,
        },
        Err(e) => TtsActionOutcome {
            success: false,
            canceled: None,
            error: Some(e.to_string()),
            file_path: None,
        },
    }
}

#[tauri::command]
pub fn tts_voice_catalog() -> serde_json::Value {
    providers::catalog()
}
