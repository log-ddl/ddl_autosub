import { invoke } from "@tauri-apps/api/core"

export interface MediaFileInfo {
  path: string
  name: string
  kind: "image" | "video"
  createdMs: number
  modifiedMs: number
}

/** Scan explicit paths, or every image/video in a folder, via Rust `scan_media`. */
export async function scanMedia(
  input: { paths: string[] } | { dir: string },
): Promise<MediaFileInfo[]> {
  return invoke<MediaFileInfo[]>("scan_media", { input })
}

/** Downsampled peak amplitudes for drawing a waveform with `count` bars. */
export async function extractAudioPeaks(input: string, count: number): Promise<number[]> {
  return invoke<number[]>("extract_audio_peaks", { input, count })
}
