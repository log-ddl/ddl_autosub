//! Look inside a video without cutting it: where the shots change (ffmpeg's
//! scene score on a small copy of the picture) and contact sheets, grids of
//! frames with each tile's time drawn on it, so an agent that reads images can
//! see the footage and answer with in/out points. Nothing here writes video;
//! the editor trims the clip when it is placed (`srcIn`/`srcOut`).
//!
//! Results are cached next to the sheets, keyed by the file, its size and
//! date, and the options, so asking twice costs nothing.

use std::path::{Path, PathBuf};
use std::process::Command;

use image::{imageops, ImageFormat, Rgb, RgbImage};
use serde::{Deserialize, Serialize};

use crate::media::probe::ffmpeg_binary;
use crate::process_ext::HiddenConsole;

/// Most tiles over all sheets of one analysis, and per sheet.
const MAX_TILES: usize = 40;
const TILES_PER_SHEET: usize = 20;
/// A long shot gets a tile every this many seconds, not just one.
const SECONDS_PER_TILE: f64 = 6.0;
/// Shots shorter than this are a flash or a fade step, not a shot.
const MIN_SCENE: f64 = 0.4;
pub const DEFAULT_THRESHOLD: f64 = 0.3;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Options {
    pub from: Option<f64>,
    pub to: Option<f64>,
    /// Scene score that counts as a cut, 0..1 (lower finds more cuts).
    pub threshold: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Sheet {
    pub path: String,
    /// The time of each tile, in reading order (left to right, top to bottom).
    pub tiles: Vec<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Analysis {
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub fps: Option<f64>,
    /// Analysed range (the whole file unless from/to were given).
    pub from: f64,
    pub to: f64,
    /// Shots as (start, end) in seconds of the source file.
    pub scenes: Vec<(f64, f64)>,
    pub sheets: Vec<Sheet>,
}

/// Analyse `video`, writing the sheets into a folder under `out_root`.
/// Blocking: runs ffmpeg several times.
pub fn analyze(video: &Path, out_root: &Path, opts: &Options) -> Result<Analysis, String> {
    let meta = std::fs::metadata(video).map_err(|e| format!("Cannot read {}: {}", video.display(), e))?;
    let out_dir = out_root.join(cache_folder(video, &meta, opts));
    let cache = out_dir.join("analysis.json");
    if let Some(found) = std::fs::read_to_string(&cache).ok().and_then(|t| serde_json::from_str::<Analysis>(&t).ok()) {
        if found.sheets.iter().all(|s| Path::new(&s.path).is_file()) {
            return Ok(found);
        }
    }

    let info = probe(video)?;
    let from = opts.from.unwrap_or(0.0).clamp(0.0, info.duration);
    let to = opts.to.unwrap_or(info.duration).clamp(from, info.duration);
    if to - from < 0.1 {
        return Err("The range to analyse is empty.".into());
    }
    let cuts = scene_cuts(video, from, to, opts.threshold)?;
    let scenes = scenes_from_cuts(from, to, &cuts);
    let times = tile_times(&scenes);

    std::fs::create_dir_all(&out_dir).map_err(|e| format!("Could not create {}: {}", out_dir.display(), e))?;
    let portrait = info.height > info.width;
    let tile_w: u32 = if portrait { 200 } else { 320 };
    let mut frames = Vec::with_capacity(times.len());
    for &t in &times {
        frames.push((t, grab_frame(video, t, tile_w)?));
    }
    let cols = if portrait { 6 } else { 5 };
    let mut sheets = Vec::new();
    for (i, chunk) in frames.chunks(TILES_PER_SHEET).enumerate() {
        let path = out_dir.join(format!("sheet-{}.jpg", i + 1));
        compose_sheet(chunk, cols)
            .save_with_format(&path, ImageFormat::Jpeg)
            .map_err(|e| format!("Could not write {}: {}", path.display(), e))?;
        sheets.push(Sheet { path: path.to_string_lossy().into_owned(), tiles: chunk.iter().map(|(t, _)| *t).collect() });
    }

    let analysis = Analysis {
        duration: info.duration,
        width: info.width,
        height: info.height,
        fps: info.fps,
        from,
        to,
        scenes,
        sheets,
    };
    if let Ok(text) = serde_json::to_string(&analysis) {
        let _ = std::fs::write(&cache, text);
    }
    Ok(analysis)
}

/// `<stem>-<hash>`: a new folder when the file or the options change.
fn cache_folder(video: &Path, meta: &std::fs::Metadata, opts: &Options) -> String {
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let key = format!("{}|{}|{}|{:?}|{:?}|{:.3}", video.display(), meta.len(), modified, opts.from, opts.to, opts.threshold);
    let mut h: u64 = 0xcbf29ce484222325;
    for b in key.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    let stem: String = video
        .file_stem()
        .map(|s| s.to_string_lossy().chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(60).collect())
        .unwrap_or_default();
    format!("{}-{:08x}", if stem.is_empty() { "video" } else { &stem }, h as u32)
}

struct VideoInfo {
    duration: f64,
    width: u32,
    height: u32,
    fps: Option<f64>,
}

fn ffmpeg() -> Command {
    let mut c = Command::new(ffmpeg_binary());
    c.hidden();
    c
}

fn probe(video: &Path) -> Result<VideoInfo, String> {
    let out = ffmpeg()
        .args(["-hide_banner", "-i"])
        .arg(video)
        .output()
        .map_err(|e| format!("Could not run ffmpeg: {}", e))?;
    parse_probe(&String::from_utf8_lossy(&out.stderr)).ok_or_else(|| format!("{} has no video stream ffmpeg can read.", video.display()))
}

fn parse_probe(text: &str) -> Option<VideoInfo> {
    let rest = &text[text.find("Duration: ")? + 10..];
    let mut parts = rest.split(',').next()?.trim().split(':');
    let duration = parts.next()?.parse::<f64>().ok()? * 3600.0
        + parts.next()?.parse::<f64>().ok()? * 60.0
        + parts.next()?.parse::<f64>().ok()?;
    let line = text.lines().find(|l| l.contains("Video:"))?;
    let (width, height) = line.split([',', ' ']).find_map(|tok| {
        let (w, h) = tok.split_once('x')?;
        let (w, h) = (w.parse::<u32>().ok()?, h.parse::<u32>().ok()?);
        (w >= 16 && h >= 16).then_some((w, h))
    })?;
    let fps = line.split(',').find_map(|p| p.trim().strip_suffix(" fps")?.parse::<f64>().ok());
    Some(VideoInfo { duration, width, height, fps })
}

/// Times (seconds in the source) where ffmpeg's scene score passes `threshold`.
fn scene_cuts(video: &Path, from: f64, to: f64, threshold: f64) -> Result<Vec<f64>, String> {
    let filter = format!("scale=160:-2,select='gt(scene\\,{:.3})',showinfo", threshold.clamp(0.05, 0.9));
    let out = ffmpeg()
        .args(["-hide_banner", "-nostats", "-ss", &format!("{:.3}", from), "-to", &format!("{:.3}", to), "-i"])
        .arg(video)
        .args(["-an", "-sn", "-dn", "-vf", &filter, "-f", "null", "-"])
        .output()
        .map_err(|e| format!("Could not run ffmpeg: {}", e))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("ffmpeg could not read the video: {}", err.lines().last().unwrap_or("").trim()));
    }
    // Input seeking restarts timestamps at 0, so shift them back by `from`.
    Ok(parse_cuts(&String::from_utf8_lossy(&out.stderr)).into_iter().map(|t| t + from).collect())
}

fn parse_cuts(text: &str) -> Vec<f64> {
    text.lines()
        .filter(|l| l.contains("Parsed_showinfo"))
        .filter_map(|l| {
            let rest = &l[l.find("pts_time:")? + 9..];
            rest.split_whitespace().next()?.parse::<f64>().ok()
        })
        .collect()
}

/// Shots between `from`, each cut and `to`, with flashes folded into the
/// shot before them.
fn scenes_from_cuts(from: f64, to: f64, cuts: &[f64]) -> Vec<(f64, f64)> {
    let mut bounds = vec![from];
    for &c in cuts {
        if c - bounds.last().copied().unwrap_or(from) >= MIN_SCENE && to - c >= MIN_SCENE {
            bounds.push(c);
        }
    }
    bounds.push(to);
    bounds.windows(2).map(|w| (round2(w[0]), round2(w[1]))).collect()
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

/// A tile in the middle of every shot, and more in long ones, thinned out
/// evenly when there are too many.
fn tile_times(scenes: &[(f64, f64)]) -> Vec<f64> {
    let mut times = Vec::new();
    for &(s, e) in scenes {
        let n = ((e - s) / SECONDS_PER_TILE).ceil().max(1.0) as usize;
        for i in 0..n {
            times.push(round2(s + (e - s) * (i as f64 + 0.5) / n as f64));
        }
    }
    if times.len() <= MAX_TILES {
        return times;
    }
    let step = times.len() as f64 / MAX_TILES as f64;
    (0..MAX_TILES).map(|i| times[(i as f64 * step) as usize]).collect()
}

fn grab_frame(video: &Path, t: f64, width: u32) -> Result<RgbImage, String> {
    let out = ffmpeg()
        .args(["-hide_banner", "-loglevel", "error", "-ss", &format!("{:.3}", t), "-i"])
        .arg(video)
        .args(["-frames:v", "1", "-vf", &format!("scale={}:-2", width), "-f", "image2pipe", "-c:v", "png", "-"])
        .output()
        .map_err(|e| format!("Could not run ffmpeg: {}", e))?;
    if out.stdout.is_empty() {
        return Err(format!("ffmpeg returned no frame at {:.2}s", t));
    }
    image::load_from_memory(&out.stdout).map(|img| img.to_rgb8()).map_err(|e| format!("Bad frame at {:.2}s: {}", t, e))
}

/// A grid of `frames`, each with its time in the top-left corner.
pub(crate) fn compose_sheet(frames: &[(f64, RgbImage)], cols: usize) -> RgbImage {
    let (tw, th) = frames.iter().fold((0, 0), |(w, h), (_, f)| (w.max(f.width()), h.max(f.height())));
    let gap = 4;
    let cols = cols.min(frames.len()).max(1) as u32;
    let rows = (frames.len() as u32).div_ceil(cols);
    let mut sheet = RgbImage::from_pixel(cols * (tw + gap) + gap, rows * (th + gap) + gap, Rgb([24, 24, 24]));
    for (i, (t, frame)) in frames.iter().enumerate() {
        let (x, y) = (gap + (i as u32 % cols) * (tw + gap), gap + (i as u32 / cols) * (th + gap));
        imageops::replace(&mut sheet, frame, x as i64, y as i64);
        draw_label(&mut sheet, x + 3, y + 3, &time_label(*t));
    }
    sheet
}

/// `12.5s` under a minute, `1:02.5` above.
fn time_label(t: f64) -> String {
    if t < 60.0 {
        format!("{:.1}s", t)
    } else {
        let tenths = (t * 10.0).round() as u64;
        format!("{}:{:02}.{}", tenths / 600, tenths / 10 % 60, tenths % 10)
    }
}

/// 5x7 glyphs for the characters a time label uses.
fn glyph(c: char) -> [u8; 7] {
    match c {
        '0' => [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
        '1' => [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
        '2' => [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
        '3' => [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
        '4' => [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
        '5' => [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
        '6' => [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
        '7' => [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
        '8' => [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
        '9' => [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
        ':' => [0b00000, 0b01100, 0b01100, 0b00000, 0b01100, 0b01100, 0b00000],
        '.' => [0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b01100, 0b01100],
        's' => [0b00000, 0b00000, 0b01110, 0b10000, 0b01110, 0b00001, 0b11110],
        _ => [0; 7],
    }
}

/// White text on a black box, each glyph pixel drawn 2x2.
pub(crate) fn draw_label(img: &mut RgbImage, x: u32, y: u32, text: &str) {
    const SCALE: u32 = 2;
    let (w, h) = (text.chars().count() as u32 * 6 * SCALE + 2 * SCALE, 7 * SCALE + 4 * SCALE);
    for dy in 0..h {
        for dx in 0..w {
            if x + dx < img.width() && y + dy < img.height() {
                img.put_pixel(x + dx, y + dy, Rgb([0, 0, 0]));
            }
        }
    }
    for (i, c) in text.chars().enumerate() {
        let gx = x + 2 * SCALE + i as u32 * 6 * SCALE;
        for (row, bits) in glyph(c).iter().enumerate() {
            for col in 0..5 {
                if bits & (0b10000 >> col) == 0 {
                    continue;
                }
                for sy in 0..SCALE {
                    for sx in 0..SCALE {
                        let (px, py) = (gx + col * SCALE + sx, y + 2 * SCALE + row as u32 * SCALE + sy);
                        if px < img.width() && py < img.height() {
                            img.put_pixel(px, py, Rgb([255, 255, 255]));
                        }
                    }
                }
            }
        }
    }
}

/// Where sheets go inside a project workspace.
pub const ANALYSIS_DIR: &str = "analysis";

/// The workspace's analysis folder.
pub fn analysis_root(workspace: &Path) -> PathBuf {
    workspace.join(ANALYSIS_DIR)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_ffmpeg_banner() {
        let text = "  Duration: 00:01:04.00, start: 0.000000, bitrate: 1658 kb/s\n    Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x804 [SAR 1:1 DAR 160:67], 1521 kb/s, 23.98 fps, 24 tbr";
        let info = parse_probe(text).unwrap();
        assert_eq!(info.duration, 64.0);
        assert_eq!((info.width, info.height), (1920, 804));
        assert_eq!(info.fps, Some(23.98));
    }

    #[test]
    fn reads_cuts_and_folds_flashes() {
        let text = "[Parsed_showinfo_2 @ 0x1] n:   0 pts:  12288 pts_time:1.5   duration:512\n\
                    [Parsed_showinfo_2 @ 0x1] n:   1 pts:  12800 pts_time:1.7 duration:512\n\
                    other line pts_time:9\n\
                    [Parsed_showinfo_2 @ 0x1] n:   2 pts:  40000 pts_time:4.88 duration:512";
        let cuts: Vec<f64> = parse_cuts(text).into_iter().map(|t| t + 10.0).collect();
        assert_eq!(cuts.len(), 3);
        assert_eq!(scenes_from_cuts(10.0, 20.0, &cuts), vec![(10.0, 11.5), (11.5, 14.88), (14.88, 20.0)]);
    }

    #[test]
    fn spreads_tiles_over_long_shots_and_caps_them() {
        assert_eq!(tile_times(&[(0.0, 4.0), (4.0, 16.0)]), vec![2.0, 7.0, 13.0]);
        let many: Vec<(f64, f64)> = (0..100).map(|i| (i as f64, i as f64 + 1.0)).collect();
        let t = tile_times(&many);
        assert_eq!(t.len(), MAX_TILES);
        assert!(t.windows(2).all(|w| w[0] < w[1]));
    }

    /// Needs ffmpeg on PATH: `cargo test analyze -- --ignored`.
    #[test]
    #[ignore]
    fn finds_the_shots_of_a_generated_video() {
        let dir = tempfile::tempdir().unwrap();
        let video = dir.path().join("three shots.mp4");
        // Black 3 s, white 4 s, gray 5 s: plain colors only cut where the brightness changes.
        let status = std::process::Command::new(ffmpeg_binary())
            .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=black:s=640x360:d=3:r=25"])
            .args(["-f", "lavfi", "-i", "color=white:s=640x360:d=4:r=25", "-f", "lavfi", "-i", "color=gray:s=640x360:d=5:r=25"])
            .args(["-filter_complex", "[0][1][2]concat=n=3:v=1:a=0", "-pix_fmt", "yuv420p"])
            .arg(&video)
            .status()
            .unwrap();
        assert!(status.success());
        let opts = Options { threshold: DEFAULT_THRESHOLD, ..Default::default() };
        let a = analyze(&video, dir.path(), &opts).unwrap();
        assert_eq!(a.scenes.len(), 3, "{:?}", a.scenes);
        assert!((a.scenes[1].0 - 3.0).abs() < 0.1 && (a.scenes[2].0 - 7.0).abs() < 0.1, "{:?}", a.scenes);
        assert_eq!(a.sheets.len(), 1);
        assert!(Path::new(&a.sheets[0].path).is_file());
        // A second call is served from the cache.
        let again = analyze(&video, dir.path(), &opts).unwrap();
        assert_eq!(again.sheets[0].path, a.sheets[0].path);
        std::fs::copy(&a.sheets[0].path, std::env::temp_dir().join("autosubs-analyze-test-sheet.jpg")).unwrap();
    }

    #[test]
    fn labels_times() {
        assert_eq!(time_label(12.46), "12.5s");
        assert_eq!(time_label(62.5), "1:02.5");
    }
}
