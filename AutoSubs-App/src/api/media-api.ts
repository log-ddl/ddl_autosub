import { invoke } from "@tauri-apps/api/core"

/** Downsampled peak amplitudes for drawing a waveform with `count` bars. */
export async function extractAudioPeaks(input: string, count: number): Promise<number[]> {
  return invoke<number[]>("extract_audio_peaks", { input, count })
}
