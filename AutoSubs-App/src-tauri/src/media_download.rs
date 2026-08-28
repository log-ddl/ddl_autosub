// Downloads video from the web with yt-dlp.
//
// Mirrors the on-demand runtime pattern used by AutoEdit's Python install: the
// tools are not bundled with the installer. The first time the user opens the
// Download workspace we fetch, for their platform:
//   * the latest yt-dlp release, and
//   * a Deno runtime — yt-dlp needs a JavaScript runtime to solve YouTube's
//     player challenges (`--js-runtimes deno:<path>`); without it many YouTube
//     videos now fail to download.
// Both land in the app data dir and are reused forever. Merging the separate
// video/audio streams reuses the ffmpeg sidecar that ships with the app.
//
// v1 downloads video only (no audio/subtitle/thumbnail) and no login cookies,
// so only public URLs are supported.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;

use futures_util::StreamExt;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::fs;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};

const EVENT_SETUP_PROGRESS: &str = "media-download-setup-progress";
const EVENT_SETUP_DONE: &str = "media-download-setup-done";
const EVENT_PROGRESS: &str = "media-download-progress";

// Marker prefix printed by yt-dlp's `--print after_move:` so we can capture the
// final file path from the log stream regardless of the output template.
const FILE_MARKER: &str = "__AUTOSUBS_FILE__";

// Running download jobs keyed by the caller-supplied job id, so `cancel` can
// kill the child from a separate command invocation. The stdout/stderr handles
// are taken out before the child lands here, so the reader task owns them and
// this map only needs the handle for `start_kill`.
static JOBS: Lazy<Mutex<HashMap<String, Child>>> = Lazy::new(|| Mutex::new(HashMap::new()));

// A single install can be in flight; a second caller just watches the events.
static INSTALLING: Mutex<bool> = Mutex::new(false);

// ----------------------------------------------------------------------------
// Tool locations
// ----------------------------------------------------------------------------

fn ytdlp_name() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "yt-dlp.exe"
    }
    #[cfg(target_os = "macos")]
    {
        "yt-dlp_macos"
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        "yt-dlp"
    }
}

fn deno_name() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "deno.exe"
    }
    #[cfg(not(target_os = "windows"))]
    {
        "deno"
    }
}

fn ytdlp_url() -> String {
    format!(
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/{}",
        ytdlp_name()
    )
}

fn deno_triple() -> Result<&'static str, String> {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        Ok("x86_64-pc-windows-msvc")
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        Ok("aarch64-apple-darwin")
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        Ok("x86_64-apple-darwin")
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        Ok("aarch64-unknown-linux-gnu")
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        Ok("x86_64-unknown-linux-gnu")
    }
    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
        all(target_os = "linux", target_arch = "x86_64"),
    )))]
    {
        Err("Unsupported OS/architecture for the Deno runtime".to_string())
    }
}

fn deno_url() -> Result<String, String> {
    Ok(format!(
        "https://github.com/denoland/deno/releases/latest/download/deno-{}.zip",
        deno_triple()?
    ))
}

fn tools_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("tools"))
}

fn ytdlp_binary(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(tools_dir(app)?.join(ytdlp_name()))
}

fn deno_binary(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(tools_dir(app)?.join(deno_name()))
}

pub fn is_installed(app: &AppHandle) -> bool {
    ytdlp_binary(app).map(|p| p.exists()).unwrap_or(false)
        && deno_binary(app).map(|p| p.exists()).unwrap_or(false)
}

fn is_youtube(url: &str) -> bool {
    // Pull the host out of the URL without pulling in the `url` crate: drop the
    // scheme, then everything from the first '/', '?' or '#', and any userinfo
    // or port.
    let after_scheme = url.split("://").nth(1).unwrap_or(url);
    let authority = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("");
    let host = authority
        .rsplit('@')
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("")
        .to_lowercase();
    host == "youtu.be"
        || host.ends_with(".youtu.be")
        || host == "youtube.com"
        || host.ends_with(".youtube.com")
}

// Resolve the ffmpeg sidecar path so yt-dlp can merge streams. Tauri places the
// external binary next to the app executable at runtime (base name, no target
// triple). Returns None when it can't be found, in which case yt-dlp falls back
// to any `ffmpeg` on PATH.
fn ffmpeg_location() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    #[cfg(target_os = "windows")]
    let candidate = dir.join("ffmpeg.exe");
    #[cfg(not(target_os = "windows"))]
    let candidate = dir.join("ffmpeg");
    candidate.exists().then_some(candidate)
}

// ----------------------------------------------------------------------------
// Events
// ----------------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct SetupProgress {
    label: String, // "yt-dlp" | "Deno runtime"
    ratio: Option<f64>,
    bytes: u64,
    total: Option<u64>,
}

#[derive(Clone, Serialize)]
struct SetupDone {
    ok: bool,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
struct DownloadProgress {
    #[serde(rename = "jobId")]
    job_id: String,
    stage: String, // "downloading" | "processing" | "done" | "error"
    percent: Option<f64>,
    message: String,
}

// ----------------------------------------------------------------------------
// Status + install
// ----------------------------------------------------------------------------

#[derive(Clone, Serialize)]
pub struct DownloadStatus {
    pub installed: bool,
    pub installing: bool,
}

#[tauri::command]
pub fn media_download_status(app: AppHandle) -> DownloadStatus {
    DownloadStatus {
        installed: is_installed(&app),
        installing: *INSTALLING.lock().unwrap(),
    }
}

async fn download_to(
    app: &AppHandle,
    url: &str,
    dest: &Path,
    label: &str,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .user_agent("autosubs-media-download")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("Download failed: HTTP {}", status));
    }

    let total = resp.content_length();
    let mut file = fs::File::create(dest)
        .await
        .map_err(|e| format!("Cannot create {}: {}", dest.display(), e))?;
    let mut downloaded: u64 = 0;
    let mut last_emit: u64 = 0;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Read chunk failed: {}", e))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Write failed: {}", e))?;
        downloaded += chunk.len() as u64;
        if downloaded - last_emit >= 256 * 1024 {
            last_emit = downloaded;
            let _ = app.emit(
                EVENT_SETUP_PROGRESS,
                SetupProgress {
                    label: label.to_string(),
                    ratio: total.map(|t| downloaded as f64 / t as f64),
                    bytes: downloaded,
                    total,
                },
            );
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    let _ = app.emit(
        EVENT_SETUP_PROGRESS,
        SetupProgress {
            label: label.to_string(),
            ratio: Some(1.0),
            bytes: downloaded,
            total,
        },
    );
    Ok(())
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)
        .map_err(|e| e.to_string())?
        .permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms).map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

async fn extract_zip(archive: &Path, dest_dir: &Path) -> Result<(), String> {
    // GNU tar can't read zip, so use `unzip` on unix and bsdtar (`tar`, ships
    // with Windows 10+) on Windows.
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("tar");
        c.arg("-xf").arg(archive).arg("-C").arg(dest_dir);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new("unzip");
        c.arg("-o").arg(archive).arg("-d").arg(dest_dir);
        c
    };
    let output = cmd
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("Failed to extract Deno: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "Deno extraction failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

async fn install_ytdlp(app: &AppHandle) -> Result<(), String> {
    let dest = ytdlp_binary(app)?;
    if dest.exists() {
        return Ok(());
    }
    let temp = dest.with_extension("download");
    download_to(app, &ytdlp_url(), &temp, "yt-dlp").await?;
    make_executable(&temp)?;
    fs::rename(&temp, &dest)
        .await
        .map_err(|e| format!("Cannot finalize yt-dlp: {}", e))?;
    Ok(())
}

async fn install_deno(app: &AppHandle) -> Result<(), String> {
    let dest = deno_binary(app)?;
    if dest.exists() {
        return Ok(());
    }
    let dir = tools_dir(app)?;
    let archive = dir.join("deno.zip.download");
    download_to(app, &deno_url()?, &archive, "Deno runtime").await?;
    let result = extract_zip(&archive, &dir).await;
    let _ = fs::remove_file(&archive).await;
    result?;
    if !dest.exists() {
        return Err("Deno executable was not found after extraction".to_string());
    }
    make_executable(&dest)?;
    Ok(())
}

async fn do_install(app: &AppHandle) -> Result<(), String> {
    let dir = tools_dir(app)?;
    fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Cannot create {}: {}", dir.display(), e))?;
    install_ytdlp(app).await?;
    install_deno(app).await?;
    Ok(())
}

#[tauri::command]
pub async fn media_download_install(app: AppHandle) -> Result<(), String> {
    if is_installed(&app) {
        let _ = app.emit(EVENT_SETUP_DONE, SetupDone { ok: true, error: None });
        return Ok(());
    }
    {
        let mut installing = INSTALLING.lock().unwrap();
        if *installing {
            return Ok(()); // in-flight task will emit the done event
        }
        *installing = true;
    }

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = do_install(&app_clone).await;
        *INSTALLING.lock().unwrap() = false;
        let done = match result {
            Ok(()) => SetupDone { ok: true, error: None },
            Err(e) => {
                // Leave no half-written temp behind.
                if let Ok(dir) = tools_dir(&app_clone) {
                    let _ = fs::remove_file(dir.join("deno.zip.download")).await;
                    if let Ok(dest) = ytdlp_binary(&app_clone) {
                        let _ = fs::remove_file(dest.with_extension("download")).await;
                    }
                }
                SetupDone { ok: false, error: Some(e) }
            }
        };
        let _ = app_clone.emit(EVENT_SETUP_DONE, done);
    });
    Ok(())
}

// ----------------------------------------------------------------------------
// Analyze
// ----------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSourceInfo {
    pub id: String,
    pub title: String,
    pub uploader: Option<String>,
    pub duration: Option<f64>,
    pub thumbnail: Option<String>,
    pub extractor: Option<String>,
    // Distinct video heights available, descending (e.g. [2160, 1080, 720]).
    pub heights: Vec<u32>,
    pub webpage_url: String,
}

fn parse_heights(data: &serde_json::Value) -> Vec<u32> {
    let mut heights: Vec<u32> = Vec::new();
    if let Some(formats) = data.get("formats").and_then(|v| v.as_array()) {
        for f in formats {
            let has_video = f
                .get("vcodec")
                .and_then(|v| v.as_str())
                .map(|c| c != "none")
                .unwrap_or(false);
            if !has_video {
                continue;
            }
            if let Some(h) = f.get("height").and_then(|v| v.as_u64()) {
                if h > 0 {
                    heights.push(h as u32);
                }
            }
        }
    }
    heights.sort_unstable();
    heights.dedup();
    heights.reverse();
    heights
}

#[tauri::command]
pub async fn media_download_analyze(
    app: AppHandle,
    url: String,
) -> Result<MediaSourceInfo, String> {
    let binary = ytdlp_binary(&app)?;
    if !binary.exists() {
        return Err("yt-dlp is not installed yet".to_string());
    }
    let mut args: Vec<String> = vec![
        "--dump-single-json".into(),
        "--no-playlist".into(),
        "--no-warnings".into(),
    ];
    if is_youtube(&url) {
        if let Ok(deno) = deno_binary(&app) {
            if deno.exists() {
                args.push("--js-runtimes".into());
                args.push(format!("deno:{}", deno.to_string_lossy()));
            }
        }
    }
    args.push(url.clone());

    let output = Command::new(&binary)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("Failed to run yt-dlp: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(if stderr.trim().is_empty() {
            "Could not analyze this URL".to_string()
        } else {
            stderr.trim().to_string()
        });
    }
    let data: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|e| format!("Bad yt-dlp output: {}", e))?;

    Ok(MediaSourceInfo {
        id: data.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        title: data
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("Untitled media")
            .to_string(),
        uploader: data.get("uploader").and_then(|v| v.as_str()).map(String::from),
        duration: data.get("duration").and_then(|v| v.as_f64()),
        thumbnail: data.get("thumbnail").and_then(|v| v.as_str()).map(String::from),
        extractor: data.get("extractor_key").and_then(|v| v.as_str()).map(String::from),
        heights: parse_heights(&data),
        webpage_url: data
            .get("webpage_url")
            .and_then(|v| v.as_str())
            .unwrap_or(&url)
            .to_string(),
    })
}

// ----------------------------------------------------------------------------
// Download
// ----------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub job_id: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub batch_file: Option<String>, // path to a .txt of URLs (one per line)
    pub output_directory: String,
    #[serde(default)]
    pub quality: Option<String>, // "best" or a height like "1080"
    #[serde(default)]
    pub start_time: Option<String>, // e.g. "0:30" — optional trim start
    #[serde(default)]
    pub end_time: Option<String>, // e.g. "1:20" — optional trim end
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub success: bool,
    pub canceled: bool,
    pub file_path: Option<String>,
    pub error: Option<String>,
}

fn output_template(directory: &str) -> String {
    PathBuf::from(directory)
        .join("%(title).150B [%(id)s].%(ext)s")
        .to_string_lossy()
        .to_string()
}

fn build_args(app: &AppHandle, req: &DownloadRequest) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "--no-playlist".into(),
        "--no-simulate".into(),
        "--newline".into(),
        "--progress".into(),
        "--print".into(),
        format!("after_move:{}%(filepath)s", FILE_MARKER),
        "-o".into(),
        output_template(&req.output_directory),
    ];

    if let Some(loc) = ffmpeg_location() {
        args.push("--ffmpeg-location".into());
        args.push(loc.to_string_lossy().to_string());
    }
    // Enable the Deno JS runtime for YouTube. For a batch file the URLs live in
    // the file, so we can't sniff them here — enable it whenever a batch runs.
    if req.batch_file.is_some() || is_youtube(&req.url) {
        if let Ok(deno) = deno_binary(app) {
            if deno.exists() {
                args.push("--js-runtimes".into());
                args.push(format!("deno:{}", deno.to_string_lossy()));
            }
        }
    }

    let height = req.quality.as_deref().filter(|q| *q != "best" && !q.is_empty());
    // Prefer H.264 (avc1) video + AAC (mp4a) audio so the file imports cleanly
    // into editors that reject AV1/Opus, falling back to any codec otherwise.
    let format = match height {
        Some(h) => format!(
            "bv*[vcodec^=avc1][height<={h}]+ba[acodec^=mp4a]/bv*[height<={h}]+ba/b[height<={h}]"
        ),
        None => "bv*[vcodec^=avc1]+ba[acodec^=mp4a]/bv*+ba/b".to_string(),
    };
    args.push("-f".into());
    args.push(format);
    args.push("--merge-output-format".into());
    args.push("mp4".into());

    if let Some(batch) = req.batch_file.as_deref().filter(|s| !s.is_empty()) {
        // Batch mode: read every URL from the file. Trim is meaningless across
        // many videos, so it's skipped here.
        args.push("--batch-file".into());
        args.push(batch.to_string());
    } else {
        // Optional trim: download only the *start-end* section, cutting at
        // keyframes so the piece plays cleanly.
        let start = req.start_time.as_deref().map(str::trim).filter(|s| !s.is_empty());
        let end = req.end_time.as_deref().map(str::trim).filter(|s| !s.is_empty());
        if start.is_some() || end.is_some() {
            args.push("--download-sections".into());
            args.push(format!("*{}-{}", start.unwrap_or("0"), end.unwrap_or("inf")));
            args.push("--force-keyframes-at-cuts".into());
        }
        args.push(req.url.clone());
    }
    args
}

fn parse_percent(line: &str) -> Option<f64> {
    // Matches yt-dlp's "[download]   42.3% of ..." progress lines.
    let idx = line.find('%')?;
    let start = line[..idx]
        .rfind(|c: char| !(c.is_ascii_digit() || c == '.'))
        .map(|i| i + 1)
        .unwrap_or(0);
    line[start..idx].parse::<f64>().ok()
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            while let Some(&n) = chars.peek() {
                chars.next();
                if n.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[tauri::command]
pub async fn media_download_start(
    app: AppHandle,
    request: DownloadRequest,
) -> Result<DownloadResult, String> {
    let binary = ytdlp_binary(&app)?;
    if !binary.exists() {
        return Err("yt-dlp is not installed yet".to_string());
    }
    let job_id = request.job_id.clone();
    let directory = request.output_directory.clone();
    let args = build_args(&app, &request);

    let mut child = Command::new(&binary)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run yt-dlp: {}", e))?;

    let stdout = child.stdout.take().ok_or("Cannot read yt-dlp output")?;
    let mut stderr = child.stderr.take().ok_or("Cannot read yt-dlp output")?;

    // Register so `cancel` can kill this child. Reader owns the pipes.
    JOBS.lock().unwrap().insert(job_id.clone(), child);

    // Drain stderr concurrently so a full pipe never blocks the child.
    let stderr_task = tokio::spawn(async move {
        let mut buf = String::new();
        let _ = stderr.read_to_string(&mut buf).await;
        buf
    });

    let mut file_path = String::new();
    let mut reader = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = reader.next_line().await {
        if let Some(i) = line.find(FILE_MARKER) {
            file_path = line[i + FILE_MARKER.len()..].trim().to_string();
            continue;
        }
        let processing = line.contains("[Merger]")
            || line.contains("[VideoConvertor]")
            || line.contains("[Fixup");
        let _ = app.emit(
            EVENT_PROGRESS,
            DownloadProgress {
                job_id: job_id.clone(),
                stage: if processing { "processing".into() } else { "downloading".into() },
                percent: parse_percent(&line),
                message: strip_ansi(&line),
            },
        );
    }

    // Reader hit EOF: take the child back to learn its exit status. If it's
    // already gone from the map, `cancel` removed and killed it.
    let child = JOBS.lock().unwrap().remove(&job_id);
    let Some(mut child) = child else {
        return Ok(DownloadResult {
            success: false,
            canceled: true,
            file_path: None,
            error: None,
        });
    };
    let status = child
        .wait()
        .await
        .map_err(|e| format!("yt-dlp did not exit cleanly: {}", e))?;
    let stderr_text = stderr_task.await.unwrap_or_default();

    if !status.success() {
        let msg = stderr_text.trim().to_string();
        let _ = app.emit(
            EVENT_PROGRESS,
            DownloadProgress {
                job_id: job_id.clone(),
                stage: "error".into(),
                percent: None,
                message: msg.clone(),
            },
        );
        return Ok(DownloadResult {
            success: false,
            canceled: false,
            file_path: None,
            error: Some(if msg.is_empty() { "Download failed".into() } else { msg }),
        });
    }

    let _ = app.emit(
        EVENT_PROGRESS,
        DownloadProgress {
            job_id: job_id.clone(),
            stage: "done".into(),
            percent: Some(100.0),
            message: "Download complete".into(),
        },
    );

    Ok(DownloadResult {
        success: true,
        canceled: false,
        file_path: Some(if file_path.is_empty() { directory } else { file_path }),
        error: None,
    })
}

#[tauri::command]
pub async fn media_download_cancel(job_id: String) -> bool {
    let child = JOBS.lock().unwrap().remove(&job_id);
    if let Some(mut child) = child {
        let _ = child.start_kill();
        true
    } else {
        false
    }
}
