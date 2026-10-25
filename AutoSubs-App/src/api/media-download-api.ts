import { invoke } from "@tauri-apps/api/core"

/**
 * Thin wrapper over the `media_download_*` Tauri commands used by the
 * Download workspace. Keeps the event name and payload shapes in one place.
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

export async function cancelDownload(jobId: string): Promise<void> {
  await invoke("media_download_cancel", { jobId })
}

export interface DownloadToolsStatus {
  installed: boolean
  installing: boolean
}

export async function getDownloadToolsStatus(): Promise<DownloadToolsStatus> {
  return invoke<DownloadToolsStatus>("media_download_status")
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
