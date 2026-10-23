//! Where the picture actually is inside an image file. A cut-out character is
//! a figure on a big transparent canvas, and the editors only know the
//! canvas, so placing two poses "at the same zoom and pan" still moves the
//! character and leaves its feet floating. The alpha channel tells the rest:
//! the tight box around the visible pixels and the feet (the middle of the
//! lowest visible band), as fractions of the canvas so they work directly as
//! `update_clip` `anchor` values and for working out zoom and position.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use image::RgbaImage;
use once_cell::sync::Lazy;

/// Alpha above this counts as visible (soft edges and leftover haze below it do not).
const VISIBLE_ALPHA: u8 = 24;
/// Rows and columns with fewer visible pixels than canvas/this are specks, not the figure.
const SPECK_DIVISOR: u32 = 500;
/// The feet are the visible pixels in this share of the figure's height at its bottom.
const FEET_BAND: f64 = 0.03;

const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"];

#[derive(Clone, Debug, PartialEq)]
pub struct Figure {
    pub width: u32,
    pub height: u32,
    pub alpha: Alpha,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Alpha {
    /// No transparent pixels: a background, or a cut-out still on its flat background.
    None,
    /// Every pixel transparent.
    Empty,
    /// Visible box (left, top, right, bottom) and feet (x, y), as fractions of the canvas.
    Cutout { bx: [f64; 4], feet: [f64; 2] },
}

pub fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| IMAGE_EXTS.iter().any(|m| e.eq_ignore_ascii_case(m)))
}

type Key = (PathBuf, u64, Option<SystemTime>);

/// Decoding a 4K PNG takes a moment, and list_media lists the same folder many times.
static CACHE: Lazy<Mutex<HashMap<Key, Figure>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Size and visible area of an image, or None when it is not one or cannot be read.
pub fn measure(path: &Path) -> Option<Figure> {
    if !is_image(path) {
        return None;
    }
    let meta = std::fs::metadata(path).ok()?;
    let key = (path.to_path_buf(), meta.len(), meta.modified().ok());
    if let Some(f) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return Some(f.clone());
    }
    let img = image::ImageReader::open(path).ok()?.with_guessed_format().ok()?.decode().ok()?;
    let figure = if img.color().has_alpha() {
        of_rgba(&img.to_rgba8())
    } else {
        Figure { width: img.width(), height: img.height(), alpha: Alpha::None }
    };
    CACHE.lock().unwrap_or_else(|e| e.into_inner()).insert(key, figure.clone());
    Some(figure)
}

pub fn of_rgba(img: &RgbaImage) -> Figure {
    let (w, h) = img.dimensions();
    let mut rows = vec![0u32; h as usize];
    let mut cols = vec![0u32; w as usize];
    let mut transparent = false;
    for (x, y, p) in img.enumerate_pixels() {
        if p[3] > VISIBLE_ALPHA {
            rows[y as usize] += 1;
            cols[x as usize] += 1;
        }
        if p[3] < 255 {
            transparent = true;
        }
    }
    let alpha = if !transparent {
        Alpha::None
    } else {
        let span = |counts: &[u32], min: u32| {
            let first = counts.iter().position(|&n| n >= min)?;
            let last = counts.iter().rposition(|&n| n >= min)?;
            Some((first as u32, last as u32))
        };
        let rows_span = span(&rows, (w / SPECK_DIVISOR).max(1));
        let cols_span = span(&cols, (h / SPECK_DIVISOR).max(1));
        match (rows_span, cols_span) {
            (Some((top, bottom)), Some((left, right))) => {
                // Feet: the mean x of the visible pixels in the bottom band,
                // inside the box (two feet apart give the point between them).
                let band = ((bottom - top + 1) as f64 * FEET_BAND).ceil().max(1.0) as u32;
                let (mut sum, mut n) = (0u64, 0u64);
                for y in bottom + 1 - band.min(bottom + 1 - top)..=bottom {
                    for x in left..=right {
                        if img.get_pixel(x, y)[3] > VISIBLE_ALPHA {
                            sum += x as u64;
                            n += 1;
                        }
                    }
                }
                let feet_x = if n > 0 { sum as f64 / n as f64 + 0.5 } else { (left + right + 1) as f64 / 2.0 };
                let (fw, fh) = (w as f64, h as f64);
                Alpha::Cutout {
                    bx: [left as f64 / fw, top as f64 / fh, (right + 1) as f64 / fw, (bottom + 1) as f64 / fh],
                    feet: [feet_x / fw, (bottom + 1) as f64 / fh],
                }
            }
            _ => Alpha::Empty,
        }
    };
    Figure { width: w, height: h, alpha }
}

/// The way list_media reports an image: `1920x1080, opaque` or
/// `2000x2000, figure x 0.31-0.70 y 0.09-0.97 (780x1760 px), feet 0.50,0.97`.
pub fn summary(f: &Figure) -> String {
    match &f.alpha {
        Alpha::None => format!("{}x{}, opaque", f.width, f.height),
        Alpha::Empty => format!("{}x{}, fully transparent", f.width, f.height),
        Alpha::Cutout { bx, feet } => format!(
            "{}x{}, figure x {:.2}-{:.2} y {:.2}-{:.2} ({}x{} px), feet {:.2},{:.2}",
            f.width,
            f.height,
            bx[0],
            bx[2],
            bx[1],
            bx[3],
            ((bx[2] - bx[0]) * f.width as f64).round(),
            ((bx[3] - bx[1]) * f.height as f64).round(),
            feet[0],
            feet[1]
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn canvas(w: u32, h: u32) -> RgbaImage {
        RgbaImage::from_pixel(w, h, Rgba([0, 0, 0, 0]))
    }

    fn fill(img: &mut RgbaImage, x0: u32, y0: u32, x1: u32, y1: u32) {
        for y in y0..y1 {
            for x in x0..x1 {
                img.put_pixel(x, y, Rgba([200, 50, 50, 255]));
            }
        }
    }

    #[test]
    fn finds_the_figure_and_its_feet() {
        // A body 200..300 x 100..800 on a 1000x1000 canvas, legs apart at the
        // bottom: left foot 180..220, right foot 300..340, rows 800..900.
        let mut img = canvas(1000, 1000);
        fill(&mut img, 200, 100, 300, 800);
        fill(&mut img, 180, 800, 220, 900);
        fill(&mut img, 300, 800, 340, 900);
        // A stray speck far away is ignored.
        img.put_pixel(950, 20, Rgba([0, 0, 0, 255]));
        let f = of_rgba(&img);
        let Alpha::Cutout { bx, feet } = f.alpha else { panic!("{:?}", f) };
        assert_eq!(bx, [0.18, 0.1, 0.34, 0.9]);
        assert!((feet[0] - 0.26).abs() < 0.005, "{:?}", feet);
        assert_eq!(feet[1], 0.9);
        assert_eq!(summary(&of_rgba(&img)), "1000x1000, figure x 0.18-0.34 y 0.10-0.90 (160x800 px), feet 0.26,0.90");
    }

    #[test]
    fn opaque_and_empty_images() {
        let mut img = RgbaImage::from_pixel(40, 20, Rgba([1, 2, 3, 255]));
        assert_eq!(of_rgba(&img).alpha, Alpha::None);
        assert_eq!(summary(&of_rgba(&img)), "40x20, opaque");
        for p in img.pixels_mut() {
            p[3] = 0;
        }
        assert_eq!(of_rgba(&img).alpha, Alpha::Empty);
    }

    #[test]
    fn measures_files_and_skips_non_images() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("char.png");
        let mut img = canvas(100, 100);
        fill(&mut img, 40, 20, 60, 90);
        img.save(&png).unwrap();
        let f = measure(&png).unwrap();
        assert_eq!((f.width, f.height), (100, 100));
        assert!(matches!(f.alpha, Alpha::Cutout { .. }));
        std::fs::write(dir.path().join("a.wav"), b"x").unwrap();
        assert!(measure(&dir.path().join("a.wav")).is_none());
    }
}
