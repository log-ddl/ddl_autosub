//! Download and image tools for the AI Edit agent: look at a video link,
//! download a video (or just a section of it), save a web article as text plus
//! images, and remove the background from an image. They run the Download tab's
//! own code (`media_download`, `article`) plus `bg_remove`.
//!
//! Files land in the conversation's project workspace: videos and cutout PNGs in
//! `ai-broll/`, articles in `articles/<slug>/`. None of these tools touch the
//! timeline, so they are available in Manual runs too.

use std::path::{Path, PathBuf};

use futures_util::stream::{self, StreamExt};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::ai_edit::mcp::tools::{assets, tool};
use crate::media::article;
use crate::media::bg_remove::{self, BgMode, RemoveBgOptions};
use crate::media::download::{self as media_download, DownloadRequest};

/// Most article text a `save_article` result carries; the file has all of it.
const ARTICLE_PREVIEW_CHARS: usize = 6000;

/// Most clips one `download_media` call takes, and how many run at once.
/// The agent CLIs run MCP calls one after another, so several clips only
/// download in parallel when they come in one call.
const MAX_DOWNLOADS: usize = 10;
const PARALLEL_DOWNLOADS: usize = 4;

pub fn tools() -> Vec<Value> {
    vec![
        tool(
            "inspect_media",
            "Look at a video link without downloading it: title, uploader, length and available \
             resolutions. Works for YouTube, TikTok, Facebook, Instagram, X, Vimeo, news sites and \
             most pages with an embedded video.",
            json!({
                "type": "object",
                "properties": { "url": { "type": "string" } },
                "required": ["url"]
            }),
        ),
        tool(
            "download_media",
            "Download videos into the project's ai-broll folder as MP4 and return a short id (m12) \
             and length for each, ready for build_storyboard. For B-roll pass startSec/endSec to fetch only that section: it is \
             much faster than the whole video. quality is a height such as 1080 (default best). For \
             several clips pass them all in items (up to 10) in ONE call: they download 4 at a time, \
             while separate calls run one after another. Only download what the user has the right \
             to use.",
            json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string" },
                    "startSec": { "type": "number", "description": "Section start inside the video, seconds" },
                    "endSec": { "type": "number", "description": "Section end inside the video, seconds" },
                    "quality": { "type": "string", "description": "\"best\" or a height like \"1080\"" },
                    "items": {
                        "type": "array",
                        "maxItems": MAX_DOWNLOADS,
                        "description": "Several clips at once, instead of url/startSec/endSec/quality",
                        "items": {
                            "type": "object",
                            "properties": {
                                "url": { "type": "string" },
                                "startSec": { "type": "number" },
                                "endSec": { "type": "number" },
                                "quality": { "type": "string" }
                            },
                            "required": ["url"]
                        }
                    }
                }
            }),
        ),
        tool(
            "save_article",
            "Save a web article (a news story, a blog post) into the project's articles folder: its \
             text as article.md and its images in images/. Returns the paths, the image list and the \
             start of the text, to research a topic or pick pictures for the video.",
            json!({
                "type": "object",
                "properties": { "url": { "type": "string" } },
                "required": ["url"]
            }),
        ),
        tool(
            "remove_background",
            "Remove the background from an image (person, object, character, logo or illustration) \
             and save a transparent PNG into the project's ai-broll folder, ready for build_storyboard. \
             mode: \"auto\" (default, uses the local RMBG-1.4 AI segmentation model), \"ai\" (force AI \
             model for photos and complex scenes), or \"solid\" (fast corner-sampled color keying for \
             flat-colored illustrations, stickmen or icons). Set cropToContent to trim transparent margins.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the source image" },
                    "outputPath": { "type": "string", "description": "Optional output PNG path; defaults to ai-broll/<stem>_nobg.png" },
                    "mode": { "type": "string", "enum": ["auto", "ai", "solid"], "description": "Segmentation mode (default \"auto\")" },
                    "cropToContent": { "type": "boolean", "description": "Trim transparent borders around the cutout (default false)" },
                    "padding": { "type": "integer", "minimum": 0, "description": "Transparent padding in pixels when cropToContent is true (default 8)" },
                    "tolerance": { "type": "number", "description": "Color tolerance (4..240) when mode is \"solid\" (default 38)" }
                },
                "required": ["path"]
            }),
        ),
    ]
}

fn url_arg(args: &Value) -> Result<String, String> {
    args.get("url")
        .and_then(|u| u.as_str())
        .map(str::trim)
        .filter(|u| u.starts_with("http://") || u.starts_with("https://"))
        .map(str::to_string)
        .ok_or_else(|| "url must be an http(s) link.".to_string())
}

fn fmt_duration(secs: f64) -> String {
    let s = secs.round() as u64;
    format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
}

/// Run one download or image tool. None when `name` is not one of them.
pub async fn call(app: &AppHandle, workspace: Option<&Path>, name: &str, args: &Value) -> Option<Result<String, String>> {
    let result = match name {
        "inspect_media" => inspect(app, args).await,
        "download_media" => download(app, workspace, args).await,
        "save_article" => save_article(workspace, args).await,
        "remove_background" => remove_background(app, workspace, args).await,
        _ => return None,
    };
    Some(result)
}

fn require_downloader(app: &AppHandle) -> Result<(), String> {
    if media_download::is_installed(app) {
        Ok(())
    } else {
        Err("The video downloader is not installed yet. Ask the user to open the Download tab once; \
             it installs itself there."
            .into())
    }
}

async fn inspect(app: &AppHandle, args: &Value) -> Result<String, String> {
    require_downloader(app)?;
    let url = url_arg(args)?;
    let info = media_download::media_download_analyze(app.clone(), url).await?;
    let mut out = format!("\"{}\"", info.title);
    if let Some(u) = info.uploader.filter(|u| !u.is_empty()) {
        out.push_str(&format!(" by {}", u));
    }
    if let Some(d) = info.duration {
        out.push_str(&format!(", {} long", fmt_duration(d)));
    }
    if let Some(e) = info.extractor {
        out.push_str(&format!(", from {}", e));
    }
    if !info.heights.is_empty() {
        let list: Vec<String> = info.heights.iter().map(|h| format!("{}p", h)).collect();
        out.push_str(&format!(". Resolutions: {}", list.join(", ")));
    }
    out.push_str(&format!(". Link: {}", info.webpage_url));
    Ok(out)
}

async fn download(app: &AppHandle, workspace: Option<&Path>, args: &Value) -> Result<String, String> {
    require_downloader(app)?;
    let dir = workspace.ok_or("This run has no project workspace to download into.")?.join("ai-broll");
    tokio::fs::create_dir_all(&dir).await.map_err(|e| format!("Could not create {}: {}", dir.display(), e))?;
    let items: Vec<&Value> = match args.get("items").and_then(|v| v.as_array()) {
        Some(list) if !list.is_empty() => list.iter().collect(),
        _ => vec![args],
    };
    if items.len() > MAX_DOWNLOADS {
        return Err(format!("download_media takes at most {} items; split them over several calls.", MAX_DOWNLOADS));
    }
    if items.len() == 1 {
        return download_one(app, &dir, items[0]).await;
    }

    // Owned futures: borrowing app/dir through the map closure trips the
    // Send check on the MCP server's spawned task.
    let jobs: Vec<_> = items
        .into_iter()
        .cloned()
        .map(|item| {
            let (app, dir) = (app.clone(), dir.clone());
            async move { download_one(&app, &dir, &item).await }
        })
        .collect();
    let results: Vec<Result<String, String>> = stream::iter(jobs).buffered(PARALLEL_DOWNLOADS).collect().await;
    let saved = results.iter().filter(|r| r.is_ok()).count();
    let lines: Vec<String> = results
        .iter()
        .enumerate()
        .map(|(i, r)| match r {
            Ok(msg) => format!("{}. {}", i + 1, msg),
            Err(e) => format!("{}. FAILED: {}", i + 1, e.replace('\n', " ")),
        })
        .collect();
    let report = format!("Downloaded {}/{} clip(s).\n{}", saved, results.len(), lines.join("\n"));
    if saved == 0 {
        Err(report)
    } else {
        Ok(report)
    }
}

/// Download one clip. yt-dlp names the file after the video only, so two
/// sections of one video would collide (the second is skipped as "already
/// downloaded"). Each clip therefore lands in its own temp folder and moves
/// into ai-broll/ under a name carrying its section, without the brackets
/// shells read as glob patterns.
async fn download_one(app: &AppHandle, dir: &Path, args: &Value) -> Result<String, String> {
    let url = url_arg(args)?;
    let sec = |key: &str| args.get(key).and_then(|v| v.as_f64()).filter(|v| *v >= 0.0);
    let (start, end) = (sec("startSec"), sec("endSec"));
    let job = uuid::Uuid::new_v4().simple().to_string();
    let tmp = dir.join(format!(".part-{}", job));
    tokio::fs::create_dir_all(&tmp).await.map_err(|e| format!("Could not create {}: {}", tmp.display(), e))?;
    let request = DownloadRequest {
        job_id: format!("agent-{}", job),
        url,
        batch_file: None,
        output_directory: tmp.to_string_lossy().to_string(),
        quality: args.get("quality").and_then(|q| q.as_str()).map(str::to_string),
        start_time: start.map(|v| v.to_string()),
        end_time: end.map(|v| v.to_string()),
    };
    let result = media_download::media_download_start(app.clone(), request).await;
    let outcome = match result {
        Ok(r) if r.success => match r.file_path {
            Some(p) => {
                let from = PathBuf::from(&p);
                let to = dir.join(clip_file_name(&from, start, end));
                match tokio::fs::rename(&from, &to).await {
                    // dir is <workspace>/ai-broll.
                    Ok(()) => Ok(format!("Saved {}", assets::describe(dir.parent().unwrap_or(dir), &to))),
                    Err(e) => Err(format!("Downloaded {} but could not move it into ai-broll: {}", p, e)),
                }
            }
            None => Err("The download finished without a file.".into()),
        },
        Ok(r) => {
            let mut err = r.error.unwrap_or_else(|| "Download failed".into());
            if let Some(site) = r.login_site {
                err.push_str(&format!("\nAsk the user to sign in to {}, then retry.", site.name));
            } else if err.contains("Unsupported URL") {
                err.push_str("\nThere is no video at this link. If it is an article, use save_article instead.");
            }
            Err(err)
        }
        Err(e) => Err(e),
    };
    let _ = tokio::fs::remove_dir_all(&tmp).await;
    outcome
}

/// `Title [id].mp4` from yt-dlp becomes `Title_id_60-70s.mp4`.
fn clip_file_name(downloaded: &Path, start: Option<f64>, end: Option<f64>) -> String {
    let stem = downloaded.file_stem().and_then(|s| s.to_str()).unwrap_or("clip");
    let ext = downloaded.extension().and_then(|s| s.to_str()).unwrap_or("mp4");
    let mut name: String = stem.replace(" [", "_").replace(['[', ']'], "").replace(' ', "_");
    if start.is_some() || end.is_some() {
        let fmt = |v: f64| {
            let s = format!("{:.2}", v);
            s.trim_end_matches('0').trim_end_matches('.').to_string()
        };
        match end {
            Some(e) => name.push_str(&format!("_{}-{}s", fmt(start.unwrap_or(0.0)), fmt(e))),
            None => name.push_str(&format!("_from{}s", fmt(start.unwrap_or(0.0)))),
        }
    }
    format!("{}.{}", name, ext)
}

async fn save_article(workspace: Option<&Path>, args: &Value) -> Result<String, String> {
    let url = url_arg(args)?;
    let dir = workspace.ok_or("This run has no project workspace to save into.")?.join("articles");
    let saved = article::snapshot(&url, &dir).await?;
    let text = tokio::fs::read_to_string(&saved.markdown_path).await.unwrap_or_default();
    let mut out = format!(
        "Saved \"{}\" to {} ({} characters of text, {} images).",
        saved.title,
        saved.markdown_path,
        saved.text_chars,
        saved.images.len()
    );
    for w in &saved.warnings {
        out.push_str(&format!("\nWarning: {}", w));
    }
    if !saved.images.is_empty() {
        out.push_str("\nImages:");
        for img in &saved.images {
            out.push_str(&format!("\n- {}", img));
        }
    }
    let preview: String = text.chars().take(ARTICLE_PREVIEW_CHARS).collect();
    out.push_str(&format!("\n\n{}", preview));
    if text.chars().count() > ARTICLE_PREVIEW_CHARS {
        out.push_str("\n\n[... the rest is in article.md]");
    }
    Ok(out)
}

async fn remove_background(
    app: &AppHandle,
    workspace: Option<&Path>,
    args: &Value,
) -> Result<String, String> {
    let raw_path = args
        .get("path")
        .and_then(|p| p.as_str())
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .ok_or("path is required and must be a non-empty file path.")?;
    let input_path = PathBuf::from(raw_path);

    let output_path = match args
        .get("outputPath")
        .and_then(|p| p.as_str())
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        Some(custom) => PathBuf::from(custom),
        None => {
            let dir = match workspace {
                Some(ws) => ws.join("ai-broll"),
                None => input_path
                    .parent()
                    .map(Path::to_path_buf)
                    .unwrap_or_else(std::env::temp_dir),
            };
            let stem = input_path
                .file_stem()
                .and_then(|s| s.to_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("image");
            dir.join(format!("{}_nobg.png", stem))
        }
    };

    let mode = BgMode::from_str(args.get("mode").and_then(|m| m.as_str()))?;
    let crop_to_content = args
        .get("cropToContent")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let padding = args
        .get("padding")
        .and_then(|v| v.as_u64())
        .map(|v| v as u32)
        .unwrap_or(8);
    let tolerance = args
        .get("tolerance")
        .and_then(|v| v.as_f64())
        .map(|v| v as f32)
        .unwrap_or(38.0);

    let outcome = bg_remove::remove_background(
        app,
        RemoveBgOptions {
            input_path: &input_path,
            output_path: &output_path,
            mode,
            crop_to_content,
            padding,
            tolerance,
        },
    )
    .await?;

    let saved = match workspace {
        Some(ws) => assets::describe(ws, &outcome.output_path),
        None => outcome.output_path.display().to_string(),
    };
    Ok(format!("Saved transparent PNG {} ({}x{}, {})", saved, outcome.width, outcome.height, outcome.method_used))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_urls_and_formats_lengths() {
        assert!(url_arg(&json!({ "url": " https://x.com/a " })).is_ok());
        assert!(url_arg(&json!({ "url": "file:///etc/passwd" })).is_err());
        assert!(url_arg(&json!({})).is_err());
        assert_eq!(fmt_duration(3725.4), "1:02:05");
    }

    #[test]
    fn names_clips_by_section() {
        let p = Path::new("/x/Big_Buck_Bunny [aqz-KE-bpKQ].mp4");
        assert_eq!(clip_file_name(p, Some(60.0), Some(70.0)), "Big_Buck_Bunny_aqz-KE-bpKQ_60-70s.mp4");
        assert_eq!(clip_file_name(p, Some(1.5), None), "Big_Buck_Bunny_aqz-KE-bpKQ_from1.5s.mp4");
        assert_eq!(clip_file_name(p, None, None), "Big_Buck_Bunny_aqz-KE-bpKQ.mp4");
    }

    #[test]
    fn names_the_media_tools() {
        let names: Vec<String> = tools().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(
            names,
            ["inspect_media", "download_media", "save_article", "remove_background"]
        );
    }
}
