import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"

/**
 * Thin wrapper over the `media_download_*` Tauri commands, shared by the
 * Download workspace and the slideshow's "add from link" import. Keeping the
 * event name and payload shapes in one place stops the two callers drifting.
 */

export const DOWNLOAD_PROGRESS_EVENT = "media-download-progress"

export interface DownloadProgress {
  jobId: string
  stage: "downloading" | "processing" | "done" | "error"
  percent: number | null
  message: string
}

export interface DownloadResult {
  success: boolean
  canceled: boolean
  filePath: string | null
  error: string | null
}

export interface DownloadOptions {
  /** Trim start, as seconds or "m:ss". Omitted means "from the beginning". */
  startTime?: string | null
  /** Trim end, same format. Omitted means "to the end". */
  endTime?: string | null
  /** "best" or a height like "1080". */
  quality?: string | null
}

/** Download one URL and resolve once yt-dlp has finished with it. */
export async function downloadOne(
  jobId: string,
  url: string,
  outputDirectory: string,
  opts: DownloadOptions = {},
): Promise<DownloadResult> {
  return invoke<DownloadResult>("media_download_start", {
    request: {
      jobId,
      url,
      outputDirectory,
      startTime: opts.startTime ?? null,
      endTime: opts.endTime ?? null,
      quality: opts.quality ?? null,
    },
  })
}

export async function cancelDownload(jobId: string): Promise<void> {
  await invoke("media_download_cancel", { jobId })
}

/** Subscribe to progress for one job id. Returns the unlisten function. */
export async function onDownloadProgress(
  jobId: string,
  handler: (p: DownloadProgress) => void,
): Promise<UnlistenFn> {
  return listen<DownloadProgress>(DOWNLOAD_PROGRESS_EVENT, (e) => {
    if (e.payload.jobId === jobId) handler(e.payload)
  })
}

/** Whether yt-dlp and ffmpeg are installed (the Download tab installs them). */
export async function downloadToolsReady(): Promise<boolean> {
  try {
    const status = await invoke<{ installed: boolean; installing: boolean }>(
      "media_download_status",
    )
    return Boolean(status?.installed)
  } catch {
    return false
  }
}
