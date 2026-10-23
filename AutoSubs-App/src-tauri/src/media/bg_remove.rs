//! Background removal for images on one flat colour (`remove_background` MCP
//! tool): white or coloured backdrops behind illustrations, stickmen, icons
//! and logos. It flood-fills from the image's edges through pixels close to
//! the corner colour, so the fill stops at the outline and white inside it
//! (eyes, a shirt) stays; pixels near the edge of the fill get a soft alpha
//! ramp so the cut is not jagged.
//!
//! There is no AI model: photos and busy backgrounds come back poor, which
//! the result says. An image that is already transparent is left alone, since
//! its hidden colour under alpha 0 (often black) would eat a dark outline.

use std::path::{Path, PathBuf};

use image::{Rgba, RgbaImage};

pub struct RemoveBgOptions<'a> {
    pub input_path: &'a Path,
    pub output_path: &'a Path,
    pub crop_to_content: bool,
    pub padding: u32,
    pub tolerance: f32,
}

pub struct RemoveBgOutcome {
    pub output_path: PathBuf,
    pub width: u32,
    pub height: u32,
    /// Already transparent: nothing written, `output_path` is the input.
    pub skipped: bool,
    /// The corners differ too much to be one flat colour.
    pub busy_background: bool,
}

/// Corner spread above which the background is not one flat colour.
const FLAT_SPREAD: f32 = 18.0;

/// Whether a good part of the image's border is already see-through.
fn already_transparent(rgba: &RgbaImage) -> bool {
    let (w, h) = rgba.dimensions();
    if w == 0 || h == 0 {
        return false;
    }
    let mut border = 0u32;
    let mut clear = 0u32;
    let mut look = |x: u32, y: u32| {
        border += 1;
        if rgba.get_pixel(x, y)[3] < 250 {
            clear += 1;
        }
    };
    for x in 0..w {
        look(x, 0);
        look(x, h - 1);
    }
    for y in 0..h {
        look(0, y);
        look(w - 1, y);
    }
    clear * 20 > border
}

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
/// alpha ramp + color decontamination on edge pixels so interior pixels (e.g.
/// white eyes, fur collar, or shirt inside a dark outline) are never made
/// transparent and dark outlines have zero white halo.
fn solid_color_mask(rgba: &RgbaImage, tolerance: f32) -> (Vec<u8>, [f32; 3]) {
    let (w, h) = rgba.dimensions();
    let (bg, _) = sample_corner_background(rgba);
    // Manhattan distance threshold in RGB [0..765]. Default tolerance 38.0 -> low ~45 (lum >= 240 on white).
    let low = tolerance.max(45.0).clamp(12.0, 240.0);
    let high = (low * 1.65).max(low + 18.0);
    let bg_is_light = (bg[0] + bg[1] + bg[2]) / 3.0 >= 200.0;

    let len = (w * h) as usize;
    let mut visited = vec![false; len];
    let mut is_bg = vec![false; len];
    let mut queue = std::collections::VecDeque::new();

    let pixel_info = |x: u32, y: u32| -> (f32, f32, u8) {
        let p = rgba.get_pixel(x, y);
        let r = p[0];
        let g = p[1];
        let b = p[2];
        let dist = (r as f32 - bg[0]).abs() + (g as f32 - bg[1]).abs() + (b as f32 - bg[2]).abs();
        let lum = ((r as u32 + g as u32 + b as u32) / 3) as f32;
        let chroma = r.max(g).max(b) - r.min(g).min(b);
        (dist, lum, chroma)
    };

    // Whether a neighbor pixel can be entered by the border flood-fill:
    // - Either it's within the background tolerance band (`dist < high`),
    // - Or, on a light backdrop, it's an achromatic anti-aliased edge pixel outside a dark outline (`chroma <= 40 && lum > 40`).
    let can_enter = |x: u32, y: u32| -> bool {
        let (dist, lum, chroma) = pixel_info(x, y);
        dist < high || (bg_is_light && chroma <= 40 && lum > 40.0)
    };

    // Whether flood-fill should keep expanding outward from `(x, y)`:
    // Stop expanding once we hit the dark outline core (`lum < 100`) so we never leak across outlines.
    let can_expand = |x: u32, y: u32| -> bool {
        let (dist, lum, chroma) = pixel_info(x, y);
        dist <= low * 1.25 || (bg_is_light && chroma <= 40 && lum >= 100.0)
    };

    // Seed flood-fill from all 4 image edges.
    for x in 0..w {
        for y in [0, h.saturating_sub(1)] {
            let idx = (y * w + x) as usize;
            if !visited[idx] && can_enter(x, y) {
                visited[idx] = true;
                queue.push_back((x, y));
            }
        }
    }
    for y in 0..h {
        for x in [0, w.saturating_sub(1)] {
            let idx = (y * w + x) as usize;
            if !visited[idx] && can_enter(x, y) {
                visited[idx] = true;
                queue.push_back((x, y));
            }
        }
    }

    while let Some((x, y)) = queue.pop_front() {
        let idx = (y * w + x) as usize;
        is_bg[idx] = true;
        if can_expand(x, y) {
            let neighbors = [
                (x.wrapping_sub(1), y),
                (x + 1, y),
                (x, y.wrapping_sub(1)),
                (x, y + 1),
            ];
            for (nx, ny) in neighbors {
                if nx < w && ny < h {
                    let nidx = (ny * w + nx) as usize;
                    if !visited[nidx] && can_enter(nx, ny) {
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
            if is_bg[idx] {
                let p = rgba.get_pixel(x, y);
                let orig_a = p[3] as f32 / 255.0;
                let (d, lum, chroma) = pixel_info(x, y);
                let alpha_factor = if d <= low || (bg_is_light && lum >= 240.0) {
                    0.0
                } else if bg_is_light && chroma <= 40 {
                    ((255.0 - lum) / 240.0).clamp(0.0, 1.0)
                } else {
                    ((d - low) / (high - low)).clamp(0.0, 1.0)
                };
                mask[idx] = ((alpha_factor * orig_a).clamp(0.0, 1.0) * 255.0).round() as u8;
            }
        }
    }
    (mask, bg)
}

/// Apply `mask` to `rgba`, decontaminate background color from semi-transparent
/// edge pixels, and optionally crop to the non-transparent bounding box.
fn apply_mask_and_crop(
    mut rgba: RgbaImage,
    mask: &[u8],
    bg: [f32; 3],
    crop_to_content: bool,
    padding: u32,
) -> RgbaImage {
    let bg_is_light = (bg[0] + bg[1] + bg[2]) / 3.0 >= 200.0;
    for (p, &m) in rgba.pixels_mut().zip(mask.iter()) {
        let combined = ((p[3] as u16 * m as u16) + 127) / 255;
        p[3] = combined as u8;
        if p[3] == 0 {
            p[0] = 0;
            p[1] = 0;
            p[2] = 0;
        } else if p[3] < 255 {
            let r = p[0];
            let g = p[1];
            let b = p[2];
            let chroma = r.max(g).max(b) - r.min(g).min(b);
            if bg_is_light && chroma <= 40 {
                // Dark outline anti-aliased edge pixel: clamp RGB to black so there is zero white halo
                p[0] = 0;
                p[1] = 0;
                p[2] = 0;
            } else {
                // General unpremultiply / color decontamination against background color
                let a = p[3] as f32 / 255.0;
                for c in 0..3 {
                    let fg = (p[c] as f32 - (1.0 - a) * bg[c]) / a;
                    p[c] = fg.round().clamp(0.0, 255.0) as u8;
                }
            }
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

/// Cut the flat background out of one image and save it as PNG.
pub fn remove_background(opts: RemoveBgOptions<'_>) -> Result<RemoveBgOutcome, String> {
    let input = opts.input_path;
    if !input.is_file() {
        return Err(format!("Image file not found: {}", input.display()));
    }
    let img = image::ImageReader::open(input)
        .map_err(|e| format!("Could not open {}: {}", input.display(), e))?
        .with_guessed_format()
        .map_err(|e| format!("Could not read {}: {}", input.display(), e))?
        .decode()
        .map_err(|e| format!("Unsupported or corrupt image {}: {}", input.display(), e))?;
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    if already_transparent(&rgba) {
        return Ok(RemoveBgOutcome {
            output_path: input.to_path_buf(),
            width: w,
            height: h,
            skipped: true,
            busy_background: false,
        });
    }

    let (_, spread) = sample_corner_background(&rgba);
    let (mask, bg) = solid_color_mask(&rgba, opts.tolerance);
    let out = apply_mask_and_crop(rgba, &mask, bg, opts.crop_to_content, opts.padding);
    if let Some(parent) = opts.output_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not create {}: {}", parent.display(), e))?;
    }
    out.save_with_format(opts.output_path, image::ImageFormat::Png)
        .map_err(|e| format!("Could not save PNG to {}: {}", opts.output_path.display(), e))?;
    let (width, height) = out.dimensions();
    Ok(RemoveBgOutcome {
        output_path: opts.output_path.to_path_buf(),
        width,
        height,
        skipped: false,
        busy_background: spread > FLAT_SPREAD,
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
        let (mask, bg) = solid_color_mask(&img, 38.0);
        // Corner pixel should be transparent (0), center pixel should be opaque (255).
        assert_eq!(mask[0], 0);
        assert_eq!(mask[30 * 60 + 30], 255);

        let cropped = apply_mask_and_crop(img, &mask, bg, true, 2);
        // 20x20 + 2px padding on each side = 24x24
        assert_eq!(cropped.dimensions(), (24, 24));
        // Border padding pixel is transparent
        assert_eq!(cropped.get_pixel(0, 0)[3], 0);
        // Inner square pixel is opaque
        assert_eq!(cropped.get_pixel(10, 10)[3], 255);
    }

    #[test]
    fn keeps_white_inside_the_outline() {
        // White background, a black ring, white inside it.
        let mut img = RgbaImage::from_pixel(40, 40, Rgba([255, 255, 255, 255]));
        for y in 10..30 {
            for x in 10..30 {
                let ring = x == 10 || x == 29 || y == 10 || y == 29;
                if ring {
                    img.put_pixel(x, y, Rgba([0, 0, 0, 255]));
                }
            }
        }
        let (mask, _) = solid_color_mask(&img, 38.0);
        assert_eq!(mask[0], 0);
        assert_eq!(mask[20 * 40 + 20], 255);
    }

    #[test]
    fn decontaminates_antialiased_grey_halo_outside_black_outline() {
        // White background with a black box at 10..30 and an anti-aliased grey halo (180,180,180) at x=9.
        let mut img = RgbaImage::from_pixel(40, 40, Rgba([255, 255, 255, 255]));
        for y in 10..30 {
            img.put_pixel(9, y, Rgba([180, 180, 180, 255]));
            for x in 10..30 {
                img.put_pixel(x, y, Rgba([0, 0, 0, 255]));
            }
        }
        let (mask, bg) = solid_color_mask(&img, 38.0);
        let out = apply_mask_and_crop(img, &mask, bg, false, 0);
        let edge_px = out.get_pixel(9, 15);
        // RGB is decontaminated to black (0,0,0) with partial alpha instead of leaving a bright grey halo
        assert_eq!((edge_px[0], edge_px[1], edge_px[2]), (0, 0, 0));
        assert!(edge_px[3] > 0 && edge_px[3] < 120);
    }

    #[test]
    fn leaves_transparent_images_alone() {
        let mut img = RgbaImage::from_pixel(20, 20, Rgba([0, 0, 0, 0]));
        img.put_pixel(10, 10, Rgba([0, 0, 0, 255]));
        assert!(already_transparent(&img));
        assert!(!already_transparent(&RgbaImage::from_pixel(20, 20, Rgba([255, 255, 255, 255]))));
    }
}
