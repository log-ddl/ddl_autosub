//! Separate CPU runtime: VieNeu must not change OmniVoice dependencies.
use super::{
    TtsActionOutcome, TtsGeneratePayload, TtsGenerateResult, TtsModelStatus, allow_audio_file,
    emit_generate_progress, paths::app_data, paths::output_root, register_canceler,
    unregister_canceler,
};
use crate::process_ext::HiddenConsole;
use serde_json::{Value, json};
use std::{path::PathBuf, process::Stdio};
use tauri::{AppHandle, Manager};
use tokio::{io::AsyncWriteExt, process::Command};
fn root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join("runtimes/vieneu"))
}
fn python(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(root(app)?.join(if cfg!(windows) {
        ".venv/Scripts/python.exe"
    } else {
        ".venv/bin/python"
    }))
}
fn worker(app: &AppHandle) -> Result<PathBuf, String> {
    let mut dirs = vec![PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/tts")];
    if let Ok(res) = app.path().resource_dir() {
        dirs.insert(0, res.join("resources/tts"));
        dirs.push(res.join("tts"));
    }
    dirs.into_iter()
        .map(|d| d.join("vieneu_worker.py"))
        .find(|p| p.is_file())
        .ok_or("VieNeu worker missing".into())
}
#[tauri::command]
pub fn tts_vieneu_status(app: AppHandle) -> Result<TtsModelStatus, String> {
    let ready = root(&app)?.join(".ready").is_file() && python(&app)?.is_file();
    Ok(TtsModelStatus {
        model_id: "vieneu".into(),
        status: if ready { "ready" } else { "not-installed" }.into(),
        installed_path: None,
        runtime_ready: ready,
        python_available: python(&app)?.is_file(),
        cuda_available: Some(false),
        accelerator: Some("cpu".into()),
        message: None,
        message_key: None,
    })
}
async fn run(app: &AppHandle, job: &str, req: Value) -> Result<Value, String> {
    let home = root(app)?.join("models");
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    let mut child = Command::new(python(app)?)
        .arg(worker(app)?)
        .env("HF_HOME", home)
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .hidden()
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut input = child.stdin.take().ok_or("Worker stdin unavailable")?;
    input
        .write_all(req.to_string().as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    drop(input);
    let cancel = register_canceler(job);
    let result = tokio::select! {_=cancel=>Err("Canceled".into()), out=child.wait_with_output()=>{let out=out.map_err(|e|e.to_string())?;let data:Value=serde_json::from_slice(&out.stdout).map_err(|_|"VieNeu worker did not return a result".to_string())?;if data["success"]==true{Ok(data)}else{Err(data["error"].as_str().unwrap_or("VieNeu failed").into())}}};
    unregister_canceler(job);
    result
}
#[tauri::command]
pub async fn tts_install_vieneu(
    app: AppHandle,
    job_id: String,
) -> Result<TtsActionOutcome, String> {
    let base = super::managed_python::ensure_managed_python(&app, &job_id).await?;
    let dir = root(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    super::bootstrap::run_step(
        &app,
        &job_id,
        &base.to_string_lossy(),
        &[
            "-m".into(),
            "venv".into(),
            dir.join(".venv").to_string_lossy().into(),
        ],
        "tts.provider.installing",
        5.0,
    )
    .await?;
    super::bootstrap::run_step(
        &app,
        &job_id,
        &python(&app)?.to_string_lossy(),
        &[
            "-m".into(),
            "pip".into(),
            "install".into(),
            "vieneu==3.8.3".into(),
        ],
        "tts.provider.installing",
        15.0,
    )
    .await?;
    run(&app, &job_id, json!({"install":true})).await?;
    std::fs::write(dir.join(".ready"), "3.8.3").map_err(|e| e.to_string())?;
    Ok(TtsActionOutcome {
        success: true,
        canceled: None,
        error: None,
        file_path: None,
    })
}
pub async fn generate(
    app: &AppHandle,
    p: &TtsGeneratePayload,
    emit_events: bool,
) -> TtsGenerateResult {
    let result: Result<Value, String> = async {
        if !root(app)?.join(".ready").is_file() {
            return Err("Install VieNeu first".into());
        }
        let out = output_root(app)?;
        std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        let path = out.join(format!("{}.wav", uuid::Uuid::new_v4()));
        if emit_events {
            emit_generate_progress(
                app,
                &p.job_id,
                "generating",
                Some(10.0),
                "tts.provider.processing",
            );
        }
        let data=run(app,&p.job_id,json!({"text":p.text,"voiceId":p.voice_id,"referenceAudioPath":p.reference_audio_path,"outputPath":path})).await?;
        // Keep the speed control meaningful for this CPU model too.
        let speed=p.speed.unwrap_or(1.0).clamp(0.75,1.5);
        if (speed-1.0).abs()>0.001 {
            let temp=path.with_extension("speed.wav");
            let status=Command::new(crate::media::probe::ffmpeg_binary()).args(["-y","-i"]).arg(&path).args(["-af",&format!("atempo={speed}")]).arg(&temp).hidden().kill_on_drop(true).status().await.map_err(|e|e.to_string())?;
            if !status.success(){return Err("Audio speed adjustment failed".into());}std::fs::rename(temp,&path).map_err(|e|e.to_string())?;
        }
        allow_audio_file(app,&path);Ok(data)
    }.await;
    match result {
        Ok(v) => TtsGenerateResult {
            success: true,
            output_path: v["outputPath"].as_str().map(Into::into),
            srt_path: None,
            sample_rate: v["sampleRate"].as_u64().map(|n| n as u32),
            duration_sec: v["durationSec"]
                .as_f64()
                .map(|n| n / p.speed.unwrap_or(1.0).clamp(0.75, 1.5)),
            canceled: None,
            error: None,
            part_durations_sec: None,
            part_gap_sec: None,
            turns: None,
        },
        Err(e) if e == "Canceled" => TtsGenerateResult::canceled(),
        Err(e) => TtsGenerateResult::err(e),
    }
}
