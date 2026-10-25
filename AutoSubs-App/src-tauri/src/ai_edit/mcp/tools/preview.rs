//! `preview_timeline`: what the edited timeline looks like. The editor writes
//! its own picture at a few times (Premiere through QE exportFramePNG), and
//! this lays them out as one contact sheet, each tile labelled with its time. The frames stay as files too, so
//! the agent can look at one up close. `grid` draws lines every tenth of the
//! frame, labelled 0.1 to 0.9: the same 0..1 fractions as Position, the
//! layout plan and list_media's figure boxes, so a misplaced character reads
//! off as a number.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use image::{imageops, RgbImage};
use serde_json::{json, Value};

use crate::ai_edit::actions::{EditTarget, Editor};
use crate::ai_edit::editors::premiere;
use crate::ai_edit::mcp::tools::tool;
use crate::media::analyze;

const MAX_FRAMES: usize = 12;
const DEFAULT_FRAMES: usize = 6;
/// How long to wait for a frame the editor writes after its call returns.
const FILE_WAIT: Duration = Duration::from_secs(10);

/// One frame an editor was asked for: where it may have landed, or why not.
pub struct FrameShot {
    pub sec: f64,
    pub candidates: Vec<PathBuf>,
    pub error: Option<String>,
}

pub fn supported(editor: Editor) -> bool {
    matches!(editor, Editor::Premiere)
}

pub fn preview_tool(editor: Editor) -> Value {
    tool(
        "preview_timeline",
        format!(
            "Look at the {} timeline as it plays: the editor exports its picture (every track, \
             effects and text) at a few times, laid out as one contact sheet with the time on each tile, \
             and the frames are kept as files to open one up close. atSec gives exact times (1 or 2 \
             give big tiles); otherwise frames spreads that many (default {}) between fromSec and toSec \
             (default the whole timeline). grid: true draws lines every 0.1 of the frame, labelled, in \
             the same 0..1 units as Position and list_media's figure boxes, to read off where things \
             are. Check each scene after placing it (feet on the ground, nothing floating or cut off, \
             text inside its box, nothing covering a face), fix, and look again.",
            editor.display_name(),
            DEFAULT_FRAMES
        ),
        json!({
            "type": "object",
            "properties": {
                "atSec": { "type": "array", "items": { "type": "number" }, "maxItems": MAX_FRAMES, "description": "Exact times, seconds from the timeline start" },
                "fromSec": { "type": "number" },
                "toSec": { "type": "number" },
                "frames": { "type": "integer", "minimum": 1, "maximum": MAX_FRAMES, "description": "How many frames between fromSec and toSec" },
                "grid": { "type": "boolean", "description": "Draw a 0.1 grid with labels" }
            }
        }),
    )
}

/// The times to export: `atSec` as given, else `frames` spread over
/// [fromSec, toSec] with a margin so the first and last are not on a cut.
fn times_from(args: &Value, duration: Option<f64>) -> Result<Vec<f64>, String> {
    if let Some(at) = args.get("atSec").and_then(|v| v.as_array()).filter(|a| !a.is_empty()) {
        return Ok(at.iter().filter_map(|t| t.as_f64()).filter(|t| *t >= 0.0).take(MAX_FRAMES).collect());
    }
    let from = args.get("fromSec").and_then(|v| v.as_f64()).unwrap_or(0.0).max(0.0);
    let to = match args.get("toSec").and_then(|v| v.as_f64()) {
        Some(t) => t,
        None => duration.ok_or("Give atSec, or fromSec and toSec.")?,
    };
    if to <= from {
        return Err(format!("toSec ({:.2}) must be after fromSec ({:.2}).", to, from));
    }
    let n = args.get("frames").and_then(|v| v.as_u64()).map(|n| n as usize).unwrap_or(DEFAULT_FRAMES).clamp(1, MAX_FRAMES);
    let step = (to - from) / n as f64;
    Ok((0..n).map(|i| ((from + step * (i as f64 + 0.5)) * 100.0).round() / 100.0).collect())
}

pub async fn call(target: &EditTarget, workspace: Option<&Path>, args: &Value, duration: Option<f64>) -> Result<String, String> {
    let workspace = workspace.ok_or("This run has no project workspace.")?;
    let times = times_from(args, duration)?;
    if times.is_empty() {
        return Err("No valid times in atSec.".into());
    }
    let dir = analyze::analysis_root(workspace).join("timeline");
    // Old frames would pass for new ones: the editors are only checked for
    // the file appearing.
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {}", dir.display(), e))?;

    let shots = match target.editor {
        Editor::Premiere => premiere::export_frames(&dir, &times).await?,
    };
    let grid = args.get("grid").and_then(|v| v.as_bool()).unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || lay_out(&dir, shots, grid))
        .await
        .map_err(|e| e.to_string())?
}

/// Wait for the frames, write the sheet, and say where everything is.
fn lay_out(dir: &Path, shots: Vec<FrameShot>, grid: bool) -> Result<String, String> {
    let deadline = Instant::now() + FILE_WAIT;
    let mut frames: Vec<(f64, PathBuf, RgbImage)> = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    for shot in shots {
        let found = loop {
            if let Some(p) = shot.candidates.iter().find(|p| p.is_file()) {
                // A file still being written decodes as truncated; give it a moment.
                if let Ok(img) = image::open(p) {
                    break Some((p.clone(), img.to_rgb8()));
                }
            }
            if Instant::now() >= deadline || shot.candidates.is_empty() {
                break None;
            }
            std::thread::sleep(Duration::from_millis(150));
        };
        match found {
            Some((path, img)) => frames.push((shot.sec, path, img)),
            None => missing.push(match shot.error {
                Some(e) => format!("{:.2}s: {}", shot.sec, e),
                None => format!("{:.2}s: the editor wrote no frame", shot.sec),
            }),
        }
    }
    if frames.is_empty() {
        return Err(format!("No frame came back. {}", missing.join("; ")));
    }

    let (w, h) = (frames[0].2.width(), frames[0].2.height());
    let mut out = format!("{} frame(s), {}x{}.", frames.len(), w, h);
    // Big tiles for one or two frames, small ones for a sheet.
    let tile_w = if frames.len() <= 2 { 960 } else { 480 };
    let mut tiles = Vec::with_capacity(frames.len());
    out.push_str("\nFrames:");
    for (i, (sec, path, img)) in frames.iter().enumerate() {
        let mut shown = path.clone();
        if grid {
            let mut full = img.clone();
            draw_grid(&mut full);
            shown = dir.join(format!("frame-{}-grid.jpg", i + 1));
            full.save_with_format(&shown, image::ImageFormat::Jpeg)
                .map_err(|e| format!("Could not write {}: {}", shown.display(), e))?;
        }
        out.push_str(&format!("\n- {:.2}s {}", sec, shown.display()));
        let th = (tile_w as f64 * img.height() as f64 / img.width().max(1) as f64).round().max(1.0) as u32;
        let mut tile = imageops::resize(img, tile_w, th, imageops::FilterType::Triangle);
        if grid {
            draw_grid(&mut tile);
        }
        tiles.push((*sec, tile));
    }
    if tiles.len() > 1 {
        let cols = if tiles.len() <= 2 { 1 } else if h > w { 6 } else { 3 };
        let sheet_path = dir.join("sheet.jpg");
        analyze::compose_sheet(&tiles, cols)
            .save_with_format(&sheet_path, image::ImageFormat::Jpeg)
            .map_err(|e| format!("Could not write {}: {}", sheet_path.display(), e))?;
        out.push_str(&format!("\nSheet: {}", sheet_path.display()));
    }
    if !missing.is_empty() {
        out.push_str(&format!("\nMissing: {}", missing.join("; ")));
    }
    Ok(out)
}

/// Lines every tenth of the frame (the middle ones brighter), labelled with
/// their fraction along the top and the left edge.
pub fn draw_grid(img: &mut RgbImage) {
    let (w, h) = img.dimensions();
    let thick = (w / 960).max(1);
    let blend = |img: &mut RgbImage, x: u32, y: u32, strong: bool| {
        let p = img.get_pixel_mut(x, y);
        let (c, a) = if strong { ([255.0, 230.0, 0.0], 0.8) } else { ([0.0, 230.0, 255.0], 0.55) };
        for k in 0..3 {
            p[k] = (p[k] as f32 * (1.0 - a) + c[k] * a).round() as u8;
        }
    };
    for i in 1..10u32 {
        let strong = i == 5;
        let gx = w * i / 10;
        let gy = h * i / 10;
        for y in 0..h {
            for dx in 0..thick {
                if gx + dx < w {
                    blend(img, gx + dx, y, strong);
                }
            }
        }
        for x in 0..w {
            for dy in 0..thick {
                if gy + dy < h {
                    blend(img, x, gy + dy, strong);
                }
            }
        }
        let label = format!("0.{}", i);
        analyze::draw_label(img, (gx + 2).min(w.saturating_sub(1)), 2, &label);
        analyze::draw_label(img, 2, (gy + 2).min(h.saturating_sub(1)), &label);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;

    #[test]
    fn spreads_frames_or_takes_exact_times() {
        assert_eq!(times_from(&json!({ "atSec": [1.5, 3] }), None).unwrap(), vec![1.5, 3.0]);
        assert_eq!(times_from(&json!({ "fromSec": 0, "toSec": 4, "frames": 4 }), None).unwrap(), vec![0.5, 1.5, 2.5, 3.5]);
        assert_eq!(times_from(&json!({ "frames": 2 }), Some(10.0)).unwrap(), vec![2.5, 7.5]);
        assert!(times_from(&json!({}), None).is_err());
        assert!(times_from(&json!({ "fromSec": 5, "toSec": 2 }), None).is_err());
    }

    #[test]
    fn lays_out_frames_and_a_gridded_sheet() {
        let dir = tempfile::tempdir().unwrap();
        let mut shots = Vec::new();
        for (i, sec) in [1.0, 2.0, 3.0].iter().enumerate() {
            let p = dir.path().join(format!("frame-{}.png", i + 1));
            RgbImage::from_pixel(192, 108, Rgb([40, 40, 40])).save(&p).unwrap();
            // Premiere's "path without .png" case: the second candidate exists.
            shots.push(FrameShot { sec: *sec, candidates: vec![dir.path().join("nope.png"), p], error: None });
        }
        shots.push(FrameShot { sec: 4.0, candidates: vec![], error: Some("QE failed".into()) });
        let text = lay_out(dir.path(), shots, true).unwrap();
        assert!(text.starts_with("3 frame(s), 192x108."), "{}", text);
        assert!(text.contains("frame-1-grid.jpg") && text.contains("sheet.jpg"), "{}", text);
        assert!(text.contains("Missing: 4.00s: QE failed"), "{}", text);
        assert!(dir.path().join("sheet.jpg").is_file());
        // The grid's middle line is drawn.
        let g = image::open(dir.path().join("frame-1-grid.jpg")).unwrap().to_rgb8();
        assert!(g.get_pixel(96, 80)[0] > 150, "{:?}", g.get_pixel(96, 80));
    }
}
