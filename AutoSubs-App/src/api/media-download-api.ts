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

/** A site the app can sign in to for downloads (YouTube, Instagram, ...). */
export interface SiteLogin {
  key: string
  name: string
}

export interface DownloadResult {
  success: boolean
  canceled: boolean
  filePath: string | null
  error: string | null
  /** Set when the failure was a login wall or bot check that signing in fixes. */
  loginSite?: SiteLogin | null
}

export interface DownloadOptions {
  /** Trim start, as seconds or "m:ss". Omitted means "from the beginning". */
  startTime?: string | null
  /** Trim end, same format. Omitted means "to the end". */
  endTime?: string | null
  /** "best" or a height like "1080". */
  quality?: string | null
}

/** Request body for `media_download_start`: one URL, or a batch file of URLs. */
export type DownloadRequest = {
  jobId: string
  outputDirectory: string
} & (
  | { url: string; startTime?: string | null; endTime?: string | null; quality?: string | null }
  | { batchFile: string }
)

/** Start a download job and resolve once yt-dlp has finished with it. */
export async function startDownload(request: DownloadRequest): Promise<DownloadResult> {
  return invoke<DownloadResult>("media_download_start", { request })
}

/** Download one URL and resolve once yt-dlp has finished with it. */
export async function downloadOne(
  jobId: string,
  url: string,
  outputDirectory: string,
  opts: DownloadOptions = {},
): Promise<DownloadResult> {
  return startDownload({
    jobId,
    url,
    outputDirectory,
    startTime: opts.startTime ?? null,
    endTime: opts.endTime ?? null,
    quality: opts.quality ?? null,
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

export interface DownloadToolsStatus {
  installed: boolean
  installing: boolean
}

export async function getDownloadToolsStatus(): Promise<DownloadToolsStatus> {
  return invoke<DownloadToolsStatus>("media_download_status")
}

/** Whether yt-dlp and ffmpeg are installed (the Download tab installs them). */
export async function downloadToolsReady(): Promise<boolean> {
  try {
    const status = await getDownloadToolsStatus()
    return Boolean(status?.installed)
  } catch {
    return false
  }
}

/** Start the one-time tools install; progress arrives as setup events. */
export async function installDownloadTools(): Promise<void> {
  await invoke("media_download_install")
}

export interface DownloaderVersionCheck {
  current: string
  latest: string | null
  updateAvailable: boolean
  error: string | null
}

export async function checkDownloaderVersion(): Promise<DownloaderVersionCheck> {
  return invoke<DownloaderVersionCheck>("media_download_version_check")
}

export async function updateDownloader(): Promise<string> {
  return invoke<string>("media_download_update")
}

/** The sites the app can sign in to for downloads. */
export async function listLoginSites(): Promise<SiteLogin[]> {
  return invoke<SiteLogin[]>("site_session_sites")
}

/** Open a site's sign-in window; downloads from it then use that account. */
export async function signInToSite(site: string): Promise<void> {
  await invoke("site_session_login", { site })
}

/** What `article_snapshot` saved: the article as markdown plus its images. */
export interface ArticleSnapshot {
  title: string
  folder: string
  markdownPath: string
  images: string[]
  textChars: number
  warnings: string[]
}

/** Save a web article (text as article.md, plus images/) in a new folder under `outputDirectory`. */
export async function saveArticle(url: string, outputDirectory: string): Promise<ArticleSnapshot> {
  return invoke<ArticleSnapshot>("article_snapshot", { url, outputDirectory })
}
