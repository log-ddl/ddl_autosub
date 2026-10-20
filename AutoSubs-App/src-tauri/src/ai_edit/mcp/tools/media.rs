//! Download tools for the AI Edit agent: look at a video link, download a
//! video (or just a section of it), and save a web article as text plus
//! images. They run the Download tab's own code (`media_download`,
//! `article`), so they get the same yt-dlp, site sessions and fixes.
//!
//! Files land in the conversation's project workspace: videos in
//! `ai-broll/`, articles in `articles/<slug>/`. None of these tools touch the
//! timeline, so they are available in Manual runs too.

use std::path::Path;

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::ai_edit::mcp::tools::tool;
use crate::media::article;
use crate::media::download::{self as media_download, DownloadRequest};

/// Most article text a `save_article` result carries; the file has all of it.
const ARTICLE_PREVIEW_CHARS: usize = 6000;

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
            "Download a video into the project's ai-broll folder as MP4 and return its path, ready \
             for build_storyboard. For B-roll pass startSec/endSec to fetch only that section: it is \
             much faster than the whole video. quality is a height such as 1080 (default best). \
             Only download what the user has the right to use.",
            json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string" },
                    "startSec": { "type": "number", "description": "Section start inside the video, seconds" },
                    "endSec": { "type": "number", "description": "Section end inside the video, seconds" },
                    "quality": { "type": "string", "description": "\"best\" or a height like \"1080\"" }
                },
                "required": ["url"]
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

/// Run one download tool. None when `name` is not one of them.
pub async fn call(app: &AppHandle, workspace: Option<&Path>, name: &str, args: &Value) -> Option<Result<String, String>> {
    let result = match name {
        "inspect_media" => inspect(app, args).await,
        "download_media" => download(app, workspace, args).await,
        "save_article" => save_article(workspace, args).await,
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
    let url = url_arg(args)?;
    let dir = workspace.ok_or("This run has no project workspace to download into.")?.join("ai-broll");
    tokio::fs::create_dir_all(&dir).await.map_err(|e| format!("Could not create {}: {}", dir.display(), e))?;
    let secs = |key: &str| args.get(key).and_then(|v| v.as_f64()).filter(|v| *v >= 0.0).map(|v| format!("{}", v));
    let request = DownloadRequest {
        job_id: format!("agent-{}", uuid::Uuid::new_v4().simple()),
        url,
        batch_file: None,
        output_directory: dir.to_string_lossy().to_string(),
        quality: args.get("quality").and_then(|q| q.as_str()).map(str::to_string),
        start_time: secs("startSec"),
        end_time: secs("endSec"),
    };
    let result = media_download::media_download_start(app.clone(), request).await?;
    if result.success {
        return result.file_path.map(|p| format!("Saved {}", p)).ok_or_else(|| "The download finished without a file.".into());
    }
    let mut err = result.error.unwrap_or_else(|| "Download failed".into());
    if let Some(site) = result.login_site {
        err.push_str(&format!("\nAsk the user to sign in to {}, then retry.", site.name));
    } else if err.contains("Unsupported URL") {
        err.push_str("\nThere is no video at this link. If it is an article, use save_article instead.");
    }
    Err(err)
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
    fn names_the_three_tools() {
        let names: Vec<String> = tools().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names, ["inspect_media", "download_media", "save_article"]);
    }
}
