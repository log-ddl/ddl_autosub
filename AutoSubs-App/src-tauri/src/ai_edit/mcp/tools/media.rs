//! Download and image tools for the AI Edit agent: look at a video link,
//! download a video (or just a section of it), save a web article as text plus
//! images, and cut a flat background out of an image. They run the Download
//! tab's own code (`media_download`, `article`) plus `bg_remove`.
//!
//! Files land in the conversation's project workspace: videos in `media/video/`,
//! cutout PNGs in `media/images/`, articles in `articles/<slug>/`. None of these tools touch the
//! timeline, so they are available in Manual runs too.

use std::path::{Path, PathBuf};

use crate::ai_cli::workspace::{IMAGES_DIR, VIDEO_DIR};

use futures_util::stream::{self, StreamExt};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::ai_edit::mcp::tools::{assets, tool};
use crate::media::article;
use crate::media::bg_remove::{self, RemoveBgOptions};
use crate::media::download::{self as media_download, DownloadRequest};

/// Most article text a `save_article` result carries; the file has all of it.
const ARTICLE_PREVIEW_CHARS: usize = 6000;

/// Most clips one `download_media` call takes, and how many run at once.
/// The agent CLIs run MCP calls one after another, so several clips only
/// download in parallel when they come in one call.
const MAX_DOWNLOADS: usize = 10;
const PARALLEL_DOWNLOADS: usize = 4;

/// Low-resolution copies to look at before choosing a section.
pub const PREVIEW_DIR: &str = "media/preview";
const PREVIEW_QUALITY: &str = "360";

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
            "Download videos into the project's media/video folder as MP4 and return a short id (m12) \
             and length for each, ready for build_storyboard. For B-roll pass startSec/endSec to fetch only that section: it is \
             much faster than the whole video. quality is a height such as 1080 (default best). For \
             several clips pass them all in items (up to 10) in ONE call: they download 4 at a time, \
             while separate calls run one after another. Only download what the user has the right \
             to use. preview: true fetches a small 360p copy into media/preview to look at with \
             analyze_media before choosing a section; download the chosen section afterwards.",
            json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string" },
                    "startSec": { "type": "number", "description": "Section start inside the video, seconds" },
                    "endSec": { "type": "number", "description": "Section end inside the video, seconds" },
                    "quality": { "type": "string", "description": "\"best\" or a height like \"1080\"" },
                    "preview": { "type": "boolean", "description": "Small 360p copy for analyze_media, into media/preview" },
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
                                "quality": { "type": "string" },
                                "preview": { "type": "boolean" }
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
            "Cut a flat background (white or one colour, like a scanned drawing or a sticker on white) \
             out of an image and save a transparent PNG in media/images. Use it ONLY when the user asks to \
             remove a background; never on your own as a step before placing an image. Only for an image that has such a \
             background: a PNG that is already transparent needs nothing and is returned as is. It fills \
             from the image's edges up to the outline, so white inside the outline stays. Photos and busy \
             backgrounds come out poorly. Raise tolerance (default 38) when background is left around the \
             edges, lower it when the outline gets eaten. cropToContent trims the transparent margins.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "The image, or its media id" },
                    "outputPath": { "type": "string", "description": "Default media/images/<name>_nobg.png" },
                    "tolerance": { "type": "number", "description": "4-240, default 38" },
                    "cropToContent": { "type": "boolean" },
                    "padding": { "type": "integer", "minimum": 0, "description": "Pixels kept around the picture with cropToContent, default 8" }
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
        "remove_background" => remove_background(workspace, args).await,
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
    let workspace = workspace.ok_or("This run has no project workspace to download into.")?;
    let items: Vec<&Value> = match args.get("items").and_then(|v| v.as_array()) {
        Some(list) if !list.is_empty() => list.iter().collect(),
        _ => vec![args],
    };
    if items.len() > MAX_DOWNLOADS {
        return Err(format!("download_media takes at most {} items; split them over several calls.", MAX_DOWNLOADS));
    }
    if items.len() == 1 {
        return download_one(app, workspace, items[0]).await;
    }

    // Owned futures: borrowing app through the map closure trips the Send
    // check on the MCP server's spawned task.
    let jobs: Vec<_> = items
        .into_iter()
        .cloned()
        .map(|item| {
            let app = app.clone();
            async move { download_one(&app, workspace, &item).await }
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
/// into media/video/ under a name carrying its section, without the brackets
/// shells read as glob patterns.
async fn download_one(app: &AppHandle, workspace: &Path, args: &Value) -> Result<String, String> {
    let url = url_arg(args)?;
    let preview = args.get("preview").and_then(|v| v.as_bool()).unwrap_or(false);
    let dir = workspace.join(if preview { PREVIEW_DIR } else { VIDEO_DIR });
    let dir = dir.as_path();
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
        quality: match args.get("quality").and_then(|q| q.as_str()) {
            Some(q) => Some(q.to_string()),
            None if preview => Some(PREVIEW_QUALITY.to_string()),
            None => None,
        },
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
                    Ok(()) => Ok(format!("Saved {}", assets::describe(workspace, &to))),
                    Err(e) => Err(format!("Downloaded {} but could not move it into {}: {}", p, dir.display(), e)),
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

async fn remove_background(workspace: Option<&Path>, args: &Value) -> Result<String, String> {
    let input = args
        .get("path")
        .and_then(|p| p.as_str())
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .ok_or("path is required.")?;
    let output = match args.get("outputPath").and_then(|p| p.as_str()).map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => {
            let dir = match workspace {
                Some(ws) => ws.join(IMAGES_DIR),
                None => input.parent().map(Path::to_path_buf).unwrap_or_else(std::env::temp_dir),
            };
            let stem = input.file_stem().and_then(|s| s.to_str()).filter(|s| !s.is_empty()).unwrap_or("image");
            dir.join(format!("{}_nobg.png", stem))
        }
    };
    let tolerance = args.get("tolerance").and_then(|v| v.as_f64()).unwrap_or(38.0) as f32;
    let crop_to_content = args.get("cropToContent").and_then(|v| v.as_bool()).unwrap_or(false);
    let padding = args.get("padding").and_then(|v| v.as_u64()).unwrap_or(8) as u32;

    let outcome = tokio::task::spawn_blocking(move || {
        bg_remove::remove_background(RemoveBgOptions {
            input_path: &input,
            output_path: &output,
            crop_to_content,
            padding,
            tolerance,
        })
    })
    .await
    .map_err(|e| e.to_string())??;

    let saved = match workspace {
        Some(ws) => assets::describe(ws, &outcome.output_path),
        None => outcome.output_path.display().to_string(),
    };
    if outcome.skipped {
        return Ok(format!("{} is already transparent; use it as it is.", saved));
    }
    let mut text = format!("Saved transparent PNG {} ({}x{}).", saved, outcome.width, outcome.height);
    if outcome.busy_background {
        text.push_str(
            " The corners are not one flat colour, so the cut may leave background or eat into the picture; \
             look at it before using it.",
        );
    }
    Ok(text)
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
