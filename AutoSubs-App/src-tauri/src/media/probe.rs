//! How long a media file plays, without an AppHandle: WAV from its header
//! (instant, and most sound effect packs are WAV), anything else from
//! `ffmpeg -i` (the bundled sidecar next to the app, else the one on PATH).

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::process_ext::HiddenConsole;

/// Seconds of playback, or None when it cannot be read.
pub fn duration_secs(path: &Path) -> Option<f64> {
    let is_wav = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("wav") || e.eq_ignore_ascii_case("wave"));
    if is_wav {
        if let Some(d) = wav_duration(path) {
            return Some(d);
        }
    }
    ffmpeg_duration(path)
}

/// `data` chunk size / byte rate from the RIFF header.
fn wav_duration(path: &Path) -> Option<f64> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut head = [0u8; 12];
    f.read_exact(&mut head).ok()?;
    if &head[0..4] != b"RIFF" || &head[8..12] != b"WAVE" {
        return None;
    }
    let mut byte_rate: Option<u32> = None;
    // Walk the chunks; real files put LIST/bext/etc. between fmt and data.
    for _ in 0..64 {
        let mut ch = [0u8; 8];
        f.read_exact(&mut ch).ok()?;
        let size = u32::from_le_bytes([ch[4], ch[5], ch[6], ch[7]]);
        match &ch[0..4] {
            b"fmt " => {
                let mut fmt = vec![0u8; size as usize];
                f.read_exact(&mut fmt).ok()?;
                if fmt.len() >= 12 {
                    byte_rate = Some(u32::from_le_bytes([fmt[8], fmt[9], fmt[10], fmt[11]]));
                }
                if size % 2 == 1 {
                    f.read_exact(&mut [0u8; 1]).ok()?;
                }
            }
            b"data" => {
                let rate = byte_rate.filter(|r| *r > 0)?;
                return Some(size as f64 / rate as f64);
            }
            _ => {
                let skip = size as u64 + (size as u64 % 2);
                std::io::copy(&mut (&mut f).take(skip), &mut std::io::sink()).ok()?;
            }
        }
    }
    None
}

fn ffmpeg_binary() -> PathBuf {
    let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.join(name)))
        .filter(|p| p.exists())
        .unwrap_or_else(|| PathBuf::from(name))
}

/// Parse "Duration: 00:00:01.23" from `ffmpeg -i`'s banner.
fn ffmpeg_duration(path: &Path) -> Option<f64> {
    let out = Command::new(ffmpeg_binary())
        .args(["-hide_banner", "-i"])
        .arg(path)
        .hidden()
        .output()
        .ok()?;
    parse_ffmpeg_duration(&String::from_utf8_lossy(&out.stderr))
}

fn parse_ffmpeg_duration(text: &str) -> Option<f64> {
    let rest = &text[text.find("Duration: ")? + 10..];
    let stamp = rest.split(',').next()?.trim();
    let mut parts = stamp.split(':');
    let h: f64 = parts.next()?.parse().ok()?;
    let m: f64 = parts.next()?.parse().ok()?;
    let s: f64 = parts.next()?.parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_wav_headers() {
        // 1 s of 8 kHz mono 16-bit: byte rate 16000, data 16000 bytes, with
        // a LIST chunk in between like real exports have.
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&0u32.to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
        wav.extend_from_slice(&1u16.to_le_bytes()); // mono
        wav.extend_from_slice(&8000u32.to_le_bytes());
        wav.extend_from_slice(&16000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"LIST");
        wav.extend_from_slice(&3u32.to_le_bytes());
        wav.extend_from_slice(b"abc\0");
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&16000u32.to_le_bytes());
        wav.extend(std::iter::repeat(0u8).take(16000));
        let path = std::env::temp_dir().join(format!("probe-{}.wav", uuid::Uuid::new_v4().simple()));
        std::fs::write(&path, &wav).unwrap();
        assert_eq!(duration_secs(&path), Some(1.0));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn parses_ffmpeg_banner() {
        let text = "Input #0, wav\n  Duration: 00:01:02.50, bitrate: 1411 kb/s";
        assert_eq!(parse_ffmpeg_duration(text), Some(62.5));
        assert_eq!(parse_ffmpeg_duration("nothing"), None);
    }
}
