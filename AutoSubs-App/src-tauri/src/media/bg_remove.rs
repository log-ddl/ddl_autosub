//! Background removal for images (`remove_background` MCP tool).
//!
//! Supports three modes:
//! - `"auto"` (default): Inspects the 4 corners of the image. When the corners
//!   have a uniform solid color (spread <= 18), it uses the fast flood-fill
//!   solid color key so interior details (white eyes, shirts inside outlines)
//!   stay 100% intact and there is zero quantization noise on flat backdrops.
//!   When the background is complex (photos, gradients, scenes), it runs the
//!   `briaai/RMBG-1.4` ONNX segmentation model.
//! - `"solid"`: Fast border flood-fill color keying with soft edge feathering.
//!   Ideal for flat-colored illustrations, stickmen, icons, and logos.
//! - `"ai"`: Runs the `briaai/RMBG-1.4` quantized ONNX segmentation model
//!   (`model_quantized.onnx`, ~44 MB) via `ort`, with matte contrast cleanup.
//!   Downloaded once on first use into `<app_data_dir>/models/` and cached.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use futures_util::StreamExt;
use image::{DynamicImage, GenericImageView, ImageBuffer, Rgba, RgbaImage};
use once_cell::sync::Lazy;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;
use tauri::{AppHandle, Manager};
use tokio::fs;
use tokio::io::AsyncWriteExt;

const RMBG_MODEL_URL: &str =
    "https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model_quantized.onnx";
const RMBG_MODEL_FILENAME: &str = "rmbg-1.4-quantized.onnx";
const RMBG_INPUT_SIZE: usize = 1024;
/// Expected minimum size (~40 MB) so a truncated download is never mistaken for complete.
const MIN_MODEL_BYTES: u64 = 40 * 1024 * 1024;

static SESSION_CACHE: Lazy<Mutex<Option<Session>>> = Lazy::new(|| Mutex::new(None));
static DOWNLOAD_LOCK: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BgMode {
    Auto,
    Ai,
    Solid,
}

impl BgMode {
    pub fn from_str(s: Option<&str>) -> Result<Self, String> {
        match s.map(str::trim).filter(|s| !s.is_empty()) {
            None | Some("auto") => Ok(Self::Auto),
            Some("ai") => Ok(Self::Ai),
            Some("solid") => Ok(Self::Solid),
            Some(other) => Err(format!(
                "Invalid mode \"{}\": expected \"auto\", \"ai\", or \"solid\".",
                other
            )),
        }
    }
}

pub struct RemoveBgOptions<'a> {
    pub input_path: &'a Path,
    pub output_path: &'a Path,
    pub mode: BgMode,
    pub crop_to_content: bool,
    pub padding: u32,
    pub tolerance: f32,
}

pub struct RemoveBgOutcome {
    pub output_path: PathBuf,
    pub width: u32,
    pub height: u32,
    pub method_used: &'static str,
}

fn model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("models").join(RMBG_MODEL_FILENAME))
}

async fn ensure_model(app: &AppHandle) -> Result<PathBuf, String> {
    let dest = model_path(app)?;
    ensure_model_at(&dest).await
}

async fn ensure_model_at(dest: &Path) -> Result<PathBuf, String> {
    let dest = dest.to_path_buf();
    if let Ok(meta) = fs::metadata(&dest).await {
        if meta.len() >= MIN_MODEL_BYTES {
            return Ok(dest);
        }
    }

    let _guard = DOWNLOAD_LOCK.lock().await;
    if let Ok(meta) = fs::metadata(&dest).await {
        if meta.len() >= MIN_MODEL_BYTES {
            return Ok(dest);
        }
    }

    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Could not create models directory: {}", e))?;
    }

    let tmp = dest.with_extension("onnx.part");
    let client = reqwest::Client::builder()
        .user_agent("autosubs-bg-remove")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(RMBG_MODEL_URL)
        .send()
        .await
        .map_err(|e| format!("Failed to download RMBG-1.4 model: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Failed to download RMBG-1.4 model: HTTP {}",
            resp.status()
        ));
    }

    let mut file = fs::File::create(&tmp)
        .await
        .map_err(|e| format!("Could not create {}: {}", tmp.display(), e))?;
    let mut stream = resp.bytes_stream();
    let mut written: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Error reading model stream: {}", e))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Error writing model file: {}", e))?;
        written += chunk.len() as u64;
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);

    if written < MIN_MODEL_BYTES {
        let _ = fs::remove_file(&tmp).await;
        return Err(format!(
            "Downloaded model is incomplete ({} bytes).",
            written
        ));
    }

    fs::rename(&tmp, &dest)
        .await
        .map_err(|e| format!("Could not finalize model file: {}", e))?;
    Ok(dest)
}

/// Run RMBG-1.4 inference on `img` and return a grayscale alpha mask `[orig_h * orig_w]`.
fn infer_rmbg_mask(model_file: &Path, img: &DynamicImage) -> Result<Vec<u8>, String> {
    let (orig_w, orig_h) = img.dimensions();
    let resized = img
        .resize_exact(
            RMBG_INPUT_SIZE as u32,
            RMBG_INPUT_SIZE as u32,
            image::imageops::FilterType::Triangle,
        )
        .to_rgb8();

    let plane = RMBG_INPUT_SIZE * RMBG_INPUT_SIZE;
    let mut input_data = vec![0.0f32; 3 * plane];
    for (i, pixel) in resized.pixels().enumerate() {
        input_data[i] = (pixel[0] as f32 / 255.0) - 0.5;
        input_data[plane + i] = (pixel[1] as f32 / 255.0) - 0.5;
        input_data[2 * plane + i] = (pixel[2] as f32 / 255.0) - 0.5;
    }

    let tensor = Tensor::from_array((
        [1usize, 3, RMBG_INPUT_SIZE, RMBG_INPUT_SIZE],
        input_data,
    ))
    .map_err(|e| format!("Failed to build input tensor: {}", e))?;

    let mut guard = SESSION_CACHE
        .lock()
        .map_err(|_| "Model session lock poisoned".to_string())?;
    if guard.is_none() {
        let session = Session::builder()
            .map_err(|e| format!("ONNX session builder failed: {}", e))?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| format!("ONNX optimization level failed: {}", e))?
            .commit_from_file(model_file)
            .map_err(|e| format!("Failed to load RMBG-1.4 ONNX model: {}", e))?;
        *guard = Some(session);
    }
    let session = guard.as_mut().unwrap();

    let outputs = session
        .run(ort::inputs![tensor])
        .map_err(|e| format!("RMBG-1.4 inference failed: {}", e))?;
    let (_, raw_mask) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("Failed to extract mask tensor: {}", e))?;

    if raw_mask.len() < plane {
        return Err(format!(
            "Unexpected mask tensor size: {} (expected at least {})",
            raw_mask.len(),
            plane
        ));
    }
    let slice = &raw_mask[..plane];
    let mut min_v = f32::INFINITY;
    let mut max_v = f32::NEG_INFINITY;
    for &v in slice {
        if v.is_finite() {
            if v < min_v {
                min_v = v;
            }
            if v > max_v {
                max_v = v;
            }
        }
    }
    let span = (max_v - min_v).max(1e-8);
    // Remap [0.06 .. 0.94] -> [0.0 .. 1.0] to crush low-amplitude quantization noise in the background
    // and solidify foreground interiors.
    let mask_1024: Vec<u8> = slice
        .iter()
        .map(|&v| {
            let norm = ((v - min_v) / span).clamp(0.0, 1.0);
            let clean = ((norm - 0.06) / 0.88).clamp(0.0, 1.0);
            (clean * 255.0).round() as u8
        })
        .collect();

    let mask_buf: ImageBuffer<image::Luma<u8>, Vec<u8>> = ImageBuffer::from_raw(
        RMBG_INPUT_SIZE as u32,
        RMBG_INPUT_SIZE as u32,
        mask_1024,
    )
    .ok_or("Could not construct mask buffer")?;

    let resized_mask = image::imageops::resize(
        &mask_buf,
        orig_w,
        orig_h,
        image::imageops::FilterType::Triangle,
    );
    Ok(resized_mask.into_raw())
}

/// Sample the 4 corners of `rgba` to estimate the background RGB color and
/// corner spread (max Manhattan distance from median in the corners).
fn sample_corner_background(rgba: &RgbaImage) -> ([f32; 3], f32) {
    let (w, h) = rgba.dimensions();
    let patch_w = (w / 25).clamp(1, 20);
    let patch_h = (h / 25).clamp(1, 20);

    let mut rs = Vec::new();
    let mut gs = Vec::new();
    let mut bs = Vec::new();

    let corners = [
        (0, 0),
        (w.saturating_sub(patch_w), 0),
        (0, h.saturating_sub(patch_h)),
        (w.saturating_sub(patch_w), h.saturating_sub(patch_h)),
    ];
    for (x0, y0) in corners {
        for y in y0..(y0 + patch_h).min(h) {
            for x in x0..(x0 + patch_w).min(w) {
                let p = rgba.get_pixel(x, y);
                rs.push(p[0] as f32);
                gs.push(p[1] as f32);
                bs.push(p[2] as f32);
            }
        }
    }
    rs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    gs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    bs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid = rs.len() / 2;
    let bg = [
        rs.get(mid).copied().unwrap_or(255.0),
        gs.get(mid).copied().unwrap_or(255.0),
        bs.get(mid).copied().unwrap_or(255.0),
    ];

    // 90th percentile deviation in corners to measure whether corners are uniform.
    let mut diffs: Vec<f32> = (0..rs.len())
        .map(|i| (rs[i] - bg[0]).abs() + (gs[i] - bg[1]).abs() + (bs[i] - bg[2]).abs())
        .collect();
    diffs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let p90 = diffs
        .get(diffs.len() * 9 / 10)
        .copied()
        .unwrap_or(0.0);
    (bg, p90)
}

/// Remove solid background by flood-filling from the border and applying soft
/// alpha ramp on edge pixels so interior pixels (e.g. white eyes or shirt
/// inside a dark outline) are never made transparent.
fn solid_color_mask(rgba: &RgbaImage, tolerance: f32) -> Vec<u8> {
    let (w, h) = rgba.dimensions();
    let (bg, _) = sample_corner_background(rgba);
    // Manhattan distance threshold in RGB [0..765]. Default tolerance 38.0 (~5% per channel).
    let low = tolerance.clamp(4.0, 240.0);
    let high = (low * 1.65).max(low + 12.0);

    let len = (w * h) as usize;
    let mut visited = vec![false; len];
    let mut is_bg = vec![false; len];
    let mut queue = std::collections::VecDeque::new();

    let dist_at = |x: u32, y: u32| -> f32 {
        let p = rgba.get_pixel(x, y);
        (p[0] as f32 - bg[0]).abs() + (p[1] as f32 - bg[1]).abs() + (p[2] as f32 - bg[2]).abs()
    };

    // Seed flood-fill from all 4 image edges.
    for x in 0..w {
        for y in [0, h.saturating_sub(1)] {
            let idx = (y * w + x) as usize;
            if !visited[idx] && dist_at(x, y) < high {
                visited[idx] = true;
                queue.push_back((x, y));
            }
        }
    }
    for y in 0..h {
        for x in [0, w.saturating_sub(1)] {
            let idx = (y * w + x) as usize;
            if !visited[idx] && dist_at(x, y) < high {
                visited[idx] = true;
                queue.push_back((x, y));
            }
        }
    }

    while let Some((x, y)) = queue.pop_front() {
        let idx = (y * w + x) as usize;
        is_bg[idx] = true;
        // Only continue expanding outward through pixels within the solid background band (`<= low` or `< high`).
        if dist_at(x, y) <= low * 1.25 {
            let neighbors = [
                (x.wrapping_sub(1), y),
                (x + 1, y),
                (x, y.wrapping_sub(1)),
                (x, y + 1),
            ];
            for (nx, ny) in neighbors {
                if nx < w && ny < h {
                    let nidx = (ny * w + nx) as usize;
                    if !visited[nidx] && dist_at(nx, ny) < high {
                        visited[nidx] = true;
                        queue.push_back((nx, ny));
                    }
                }
            }
        }
    }

    let mut mask = vec![255u8; len];
    for y in 0..h {
        for x in 0..w {
            let idx = (y * w + x) as usize;
            let p = rgba.get_pixel(x, y);
            let orig_a = p[3] as f32 / 255.0;
            let alpha_factor = if is_bg[idx] {
                let d = dist_at(x, y);
                if d <= low {
                    0.0
                } else {
                    ((d - low) / (high - low)).clamp(0.0, 1.0)
                }
            } else {
                1.0
            };
            mask[idx] = ((alpha_factor * orig_a).clamp(0.0, 1.0) * 255.0).round() as u8;
        }
    }
    mask
}

/// Apply `mask` to `rgba`, and optionally crop to the non-transparent bounding box.
fn apply_mask_and_crop(
    mut rgba: RgbaImage,
    mask: &[u8],
    crop_to_content: bool,
    padding: u32,
) -> RgbaImage {
    for (p, &m) in rgba.pixels_mut().zip(mask.iter()) {
        let combined = ((p[3] as u16 * m as u16) + 127) / 255;
        p[3] = combined as u8;
        if p[3] == 0 {
            p[0] = 0;
            p[1] = 0;
            p[2] = 0;
        }
    }

    if !crop_to_content {
        return rgba;
    }

    let (w, h) = rgba.dimensions();
    let mut min_x = w;
    let mut min_y = h;
    let mut max_x = 0u32;
    let mut max_y = 0u32;
    let mut found = false;

    for y in 0..h {
        for x in 0..w {
            if rgba.get_pixel(x, y)[3] > 12 {
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x);
                max_y = max_y.max(y);
                found = true;
            }
        }
    }

    if !found {
        return rgba;
    }

    let x0 = min_x.saturating_sub(padding);
    let y0 = min_y.saturating_sub(padding);
    let x1 = (max_x + 1 + padding).min(w);
    let y1 = (max_y + 1 + padding).min(h);
    let cw = (x1 - x0).max(1);
    let ch = (y1 - y0).max(1);

    let mut out = RgbaImage::from_pixel(cw, ch, Rgba([0, 0, 0, 0]));
    for y in 0..ch {
        for x in 0..cw {
            out.put_pixel(x, y, *rgba.get_pixel(x0 + x, y0 + y));
        }
    }
    out
}

pub async fn remove_background(
    app: &AppHandle,
    opts: RemoveBgOptions<'_>,
) -> Result<RemoveBgOutcome, String> {
    if !opts.input_path.is_file() {
        return Err(format!(
            "Image file not found: {}",
            opts.input_path.display()
        ));
    }

    let input_path = opts.input_path.to_path_buf();
    let img = tokio::task::spawn_blocking(move || {
        image::ImageReader::open(&input_path)
            .map_err(|e| format!("Could not open {}: {}", input_path.display(), e))?
            .with_guessed_format()
            .map_err(|e| format!("Could not read {}: {}", input_path.display(), e))?
            .decode()
            .map_err(|e| format!("Unsupported or corrupt image {}: {}", input_path.display(), e))
    })
    .await
    .map_err(|e| format!("Image load task failed: {}", e))??;

    let (mask, method_used) = match opts.mode {
        BgMode::Solid => {
            let rgba = img.to_rgba8();
            let tol = opts.tolerance;
            let m = tokio::task::spawn_blocking(move || solid_color_mask(&rgba, tol))
                .await
                .map_err(|e| e.to_string())?;
            (m, "solid color key")
        }
        BgMode::Ai => {
            let model_file = ensure_model(app).await?;
            let img_clone = img.clone();
            let m = tokio::task::spawn_blocking(move || infer_rmbg_mask(&model_file, &img_clone))
                .await
                .map_err(|e| format!("AI segmentation task panicked: {}", e))??;
            (m, "RMBG-1.4 AI model")
        }
        BgMode::Auto => {
            let rgba = img.to_rgba8();
            let (_, corner_spread) = sample_corner_background(&rgba);
            if corner_spread <= 18.0 {
                let tol = opts.tolerance;
                let m = tokio::task::spawn_blocking(move || solid_color_mask(&rgba, tol))
                    .await
                    .map_err(|e| e.to_string())?;
                (m, "solid color key (auto-detected uniform backdrop)")
            } else {
                let model_file = ensure_model(app).await?;
                let img_clone = img.clone();
                let m = tokio::task::spawn_blocking(move || {
                    infer_rmbg_mask(&model_file, &img_clone)
                })
                .await
                .map_err(|e| format!("AI segmentation task panicked: {}", e))??;
                (m, "RMBG-1.4 AI model")
            }
        }
    };

    let output_path = opts.output_path.to_path_buf();
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Could not create {}: {}", parent.display(), e))?;
    }

    let crop = opts.crop_to_content;
    let pad = opts.padding;
    let out_clone = output_path.clone();
    let (width, height) = tokio::task::spawn_blocking(move || -> Result<(u32, u32), String> {
        let rgba = img.to_rgba8();
        let final_img = apply_mask_and_crop(rgba, &mask, crop, pad);
        let dims = final_img.dimensions();
        final_img
            .save_with_format(&out_clone, image::ImageFormat::Png)
            .map_err(|e| format!("Could not save PNG to {}: {}", out_clone.display(), e))?;
        Ok(dims)
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(RemoveBgOutcome {
        output_path,
        width,
        height,
        method_used,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solid_color_key_removes_uniform_background_and_crops() {
        // 60x60 white background with a 20x20 red square at (20..40, 20..40).
        let mut img = RgbaImage::from_pixel(60, 60, Rgba([255, 255, 255, 255]));
        for y in 20..40 {
            for x in 20..40 {
                img.put_pixel(x, y, Rgba([220, 30, 30, 255]));
            }
        }
        let mask = solid_color_mask(&img, 38.0);
        // Corner pixel should be transparent (0), center pixel should be opaque (255).
        assert_eq!(mask[0], 0);
        assert_eq!(mask[30 * 60 + 30], 255);

        let cropped = apply_mask_and_crop(img, &mask, true, 2);
        // 20x20 + 2px padding on each side = 24x24
        assert_eq!(cropped.dimensions(), (24, 24));
        // Border padding pixel is transparent
        assert_eq!(cropped.get_pixel(0, 0)[3], 0);
        // Inner square pixel is opaque
        assert_eq!(cropped.get_pixel(10, 10)[3], 255);
    }

    #[test]
    fn parses_bg_modes() {
        assert_eq!(BgMode::from_str(None).unwrap(), BgMode::Auto);
        assert_eq!(BgMode::from_str(Some("auto")).unwrap(), BgMode::Auto);
        assert_eq!(BgMode::from_str(Some("ai")).unwrap(), BgMode::Ai);
        assert_eq!(BgMode::from_str(Some("solid")).unwrap(), BgMode::Solid);
        assert!(BgMode::from_str(Some("unknown")).is_err());
    }
}
