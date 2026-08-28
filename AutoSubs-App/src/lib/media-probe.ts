import { convertFileSrc } from "@tauri-apps/api/core"

export interface VideoProbe {
  durationSecs: number
  width: number
  height: number
}

/**
 * Read the duration and dimensions of a local media file through a temporary
 * `<video>` element over Tauri's asset protocol. Resolves to `null` when the
 * file is not a playable video (e.g. an audio-only source) or the probe fails.
 */
export function probeVideoMetadata(path: string): Promise<VideoProbe | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video")
    video.preload = "metadata"
    video.muted = true
    video.src = convertFileSrc(path)

    let settled = false
    const finish = (result: VideoProbe | null) => {
      if (settled) return
      settled = true
      video.removeAttribute("src")
      resolve(result)
    }

    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0
      const width = video.videoWidth || 0
      const height = video.videoHeight || 0
      if (duration > 0 && width > 0 && height > 0) {
        finish({ durationSecs: duration, width, height })
      } else {
        finish(null)
      }
    }
    video.onerror = () => finish(null)
    // Safety net: some codecs never fire loadedmetadata.
    window.setTimeout(() => finish(null), 8000)
  })
}
