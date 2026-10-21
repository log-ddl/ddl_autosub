//! `analyze_media`: shots and contact sheets of downloaded videos (see
//! `media::analyze`), so the agent can pick the section to use and pass it
//! to build_storyboard as srcIn/srcOut. Several videos in one call run at
//! once; nothing is cut or re-encoded.

use std::path::{Path, PathBuf};

use futures_util::stream::{self, StreamExt};
use serde_json::{json, Value};

use crate::ai_edit::mcp::tools::{assets, tool};
use crate::media::analyze::{self, Analysis, Options, DEFAULT_THRESHOLD};

const MAX_VIDEOS: usize = 10;
const PARALLEL: usize = 3;
/// Most shots listed per video; the sheets still cover the whole range.
const MAX_LISTED_SCENES: usize = 120;

pub fn tools() -> Vec<Value> {
    vec![tool(
        "analyze_media",
        "Look inside downloaded videos to choose which section to use: the shots (where the picture \
         cuts) and contact sheets, JPEG grids of frames with each tile's time printed on it. Open the \
         sheets to see the footage, then place the section you want with build_storyboard \
         srcIn/srcOut (the editor trims it; never cut files yourself). For a long video, analyse a \
         preview (download_media preview: true) and download only the chosen section in full \
         quality afterwards; fromSec/toSec limit the analysis to part of a file. Pass several videos \
         in items (up to 10) in ONE call: they run at once. Results are cached.",
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Media id (m12) or absolute path" },
                "fromSec": { "type": "number" },
                "toSec": { "type": "number" },
                "sensitivity": { "type": "number", "description": "Cut threshold 0.05..0.9 (default 0.3); lower finds more cuts" },
                "items": {
                    "type": "array",
                    "maxItems": MAX_VIDEOS,
                    "description": "Several videos at once, instead of path/fromSec/toSec",
                    "items": {
                        "type": "object",
                        "properties": {
                            "path": { "type": "string" },
                            "fromSec": { "type": "number" },
                            "toSec": { "type": "number" }
                        },
                        "required": ["path"]
                    }
                }
            }
        }),
    )]
}

pub async fn call(workspace: Option<&Path>, name: &str, args: &Value) -> Option<Result<String, String>> {
    if name != "analyze_media" {
        return None;
    }
    Some(match workspace {
        Some(ws) => analyze_all(ws, args).await,
        None => Err("This run has no project workspace.".into()),
    })
}

async fn analyze_all(workspace: &Path, args: &Value) -> Result<String, String> {
    let items: Vec<Value> = match args.get("items").and_then(|v| v.as_array()) {
        Some(list) if !list.is_empty() => list.clone(),
        _ => vec![args.clone()],
    };
    if items.len() > MAX_VIDEOS {
        return Err(format!("analyze_media takes at most {} videos; split them over several calls.", MAX_VIDEOS));
    }
    let threshold = args.get("sensitivity").and_then(|v| v.as_f64()).unwrap_or(DEFAULT_THRESHOLD);
    let jobs: Vec<_> = items
        .into_iter()
        .map(|item| {
            let workspace = workspace.to_path_buf();
            async move { analyze_one(workspace, item, threshold).await }
        })
        .collect();
    let results: Vec<Result<String, String>> = stream::iter(jobs).buffered(PARALLEL).collect().await;
    let ok = results.iter().filter(|r| r.is_ok()).count();
    let blocks: Vec<String> = results
        .into_iter()
        .map(|r| r.unwrap_or_else(|e| format!("FAILED: {}", e.replace('\n', " "))))
        .collect();
    let text = blocks.join("\n\n");
    if ok == 0 {
        Err(text)
    } else {
        Ok(text)
    }
}

async fn analyze_one(workspace: PathBuf, item: Value, threshold: f64) -> Result<String, String> {
    let raw = item
        .get("path")
        .and_then(|p| p.as_str())
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .ok_or("path is required (a media id like m12 or an absolute path).")?;
    let video = PathBuf::from(raw);
    if !video.is_file() {
        return Err(format!("{} is not a file.", raw));
    }
    let sec = |key: &str| item.get(key).and_then(|v| v.as_f64()).filter(|v| *v >= 0.0);
    let opts = Options { from: sec("fromSec"), to: sec("toSec"), threshold };
    let out_root = analyze::analysis_root(&workspace);
    let (v, ws) = (video.clone(), workspace.clone());
    let analysis = tauri::async_runtime::spawn_blocking(move || analyze::analyze(&v, &out_root, &opts))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{}: {}", raw, e))?;
    Ok(report(&assets::describe(&ws, &video), &analysis))
}

fn report(name: &str, a: &Analysis) -> String {
    let mut out = format!("{}: {}x{}", name, a.width, a.height);
    if let Some(fps) = a.fps {
        out.push_str(&format!(", {} fps", fps));
    }
    if a.from > 0.0 || a.to < a.duration {
        out.push_str(&format!(", analysed {:.1}-{:.1}s", a.from, a.to));
    }
    out.push_str(&format!(". {} shot(s):\n", a.scenes.len()));
    let listed: Vec<String> = a.scenes.iter().take(MAX_LISTED_SCENES).map(|(s, e)| format!("{:.1}-{:.1}", s, e)).collect();
    out.push_str(&listed.join(", "));
    if a.scenes.len() > MAX_LISTED_SCENES {
        out.push_str(&format!(", ... ({} more)", a.scenes.len() - MAX_LISTED_SCENES));
    }
    out.push_str("\nContact sheets (tile times in seconds of the source):");
    for s in &a.sheets {
        let (first, last) = (s.tiles.first().copied().unwrap_or(0.0), s.tiles.last().copied().unwrap_or(0.0));
        out.push_str(&format!("\n- {} ({} tiles, {:.1}s to {:.1}s)", s.path, s.tiles.len(), first, last));
    }
    out
}
