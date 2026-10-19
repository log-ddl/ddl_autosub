import {
  cancelDownload,
  downloadOne,
  downloadToolsReady,
  onDownloadProgress,
} from "@/api/media-download-api"
import {
  makeMediaEntryFromPath,
  parseTimecode,
  type MediaEntry,
} from "@/lib/media-import"

export { cancelDownload, downloadOne, downloadToolsReady, onDownloadProgress }

/**
 * How many links download at once. Kept small on purpose: YouTube throttles
 * parallel connections, and every yt-dlp spawns an ffmpeg to merge streams, so
 * a wide window costs CPU without buying much wall time.
 */
export const DOWNLOAD_CONCURRENCY = 2

/**
 * Idle gap between download chunks, in ms. Randomised so a long paste doesn't
 * hit the site on a fixed rhythm; yt-dlp adds its own per-video sleep on top.
 */
export const CHUNK_DELAY_MIN_MS = 2000
export const CHUNK_DELAY_MAX_MS = 6000

export const randomChunkDelayMs = () =>
  CHUNK_DELAY_MIN_MS + Math.random() * (CHUNK_DELAY_MAX_MS - CHUNK_DELAY_MIN_MS)

/** One link being downloaded right now, as shown in the progress list. */
export interface DownloadRow {
  jobId: string
  label: string
  percent: number | null
}

/** One pasted link, resolved against the default range boxes. */
export interface DownloadJob {
  /** Position in the pasted text, so grouping by URL doesn't reshuffle clips. */
  index: number
  url: string
  from?: number
  to?: number
}

/**
 * One URL to fetch, with every pasted line that wants a piece of it. Lines are
 * grouped this way so three sections of one video cost one download instead of
 * three, and each section still becomes its own clip.
 */
export interface DownloadTask {
  url: string
  jobs: DownloadJob[]
}

/**
 * One pasted line: a URL, optionally followed by a `start-end` range
 * ("https://… 0:30-1:20"). Either side of the range may be empty
 * ("30-" = from 0:30 to the end). No range at all means the whole clip.
 */
export function parseLinkLine(
  line: string,
): { url: string; from?: number; to?: number } | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  const parts = trimmed.split(/\s+/)
  const url = parts[0]
  if (!url) return null
  const range = parts[1]
  if (!range) return { url }
  // Split on the LAST dash so "1:00-2:00" works and a dash inside a timecode
  // never confuses it.
  const cut = range.lastIndexOf("-")
  if (cut < 0) return { url }
  const from = parseTimecode(range.slice(0, cut))
  const to = parseTimecode(range.slice(cut + 1))
  return { url, from: from ?? undefined, to: to ?? undefined }
}

/**
 * Parse a multiline string of links (`url` or `url start-end`), falling back to
 * `defaultFromRaw` and `defaultToRaw` when a line has no inline range.
 */
export function parseBatchLinkJobs(
  rawUrlsText: string,
  defaultFromRaw = "",
  defaultToRaw = "",
): DownloadJob[] {
  const defFrom = parseTimecode(defaultFromRaw) ?? undefined
  const defTo = parseTimecode(defaultToRaw) ?? undefined
  return rawUrlsText
    .split("\n")
    .map(parseLinkLine)
    .filter((j): j is { url: string; from?: number; to?: number } => j !== null)
    .map<DownloadJob>((j, index) => ({
      index,
      url: j.url,
      from: j.from ?? defFrom,
      to: j.to ?? defTo,
    }))
}

/**
 * Group pasted lines by URL, keeping first-appearance order for the URLs and
 * pasted order for the sections inside each one. An exact repeat (same URL,
 * same range) is dropped — that is the same clip twice, not two sections.
 */
export function groupDownloadJobs(jobs: DownloadJob[]): DownloadTask[] {
  const byUrl = new Map<string, DownloadTask>()
  const seen = new Set<string>()
  for (const job of jobs) {
    const key = `${job.url}|${job.from ?? ""}|${job.to ?? ""}`
    if (seen.has(key)) continue
    seen.add(key)
    const task = byUrl.get(job.url)
    if (task) task.jobs.push(job)
    else byUrl.set(job.url, { url: job.url, jobs: [job] })
  }
  return [...byUrl.values()]
}

/**
 * Wait `ms`, but wake early when `isCancelled()` becomes true so Stop stays
 * responsive during the gap. Returns false when cut short by cancellation.
 */
export function sleepUnlessCancelled(
  ms: number,
  isCancelled: () => boolean,
): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = window.setInterval(() => {
      if (isCancelled()) {
        window.clearInterval(tick)
        resolve(false)
      } else if (Date.now() - started >= ms) {
        window.clearInterval(tick)
        resolve(true)
      }
    }, 100)
  })
}

export interface RunSingleDownloadTaskOptions {
  task: DownloadTask
  jobId: string
  dir: string
  trimMode: "download" | "timeline"
  activeJobIds?: Set<string>
  onProgress?: (jobId: string, percent: number | null) => void
  onError?: (url: string, errorMessage?: string) => void
  onTaskSettled?: (jobId: string) => void
}

/**
 * Download one URL task (which may produce multiple clipped `MediaEntry` items
 * if the same URL was pasted with different ranges). Never rejects: a dead link
 * resolves to an empty list so it can't take the rest of its chunk down.
 */
export async function runSingleDownloadTask({
  task,
  jobId,
  dir,
  trimMode,
  activeJobIds,
  onProgress,
  onError,
  onTaskSettled,
}: RunSingleDownloadTaskOptions): Promise<Array<{ index: number; entry: MediaEntry }>> {
  activeJobIds?.add(jobId)
  const unlisten = await onDownloadProgress(jobId, (p) => {
    onProgress?.(jobId, p.percent)
  })
  try {
    const first = task.jobs[0]
    const hasRange = first.from != null || first.to != null
    // Cutting at download hands yt-dlp the section; cutting on the timeline
    // pulls the whole clip and carries the range through to the editor instead.
    // Several sections of one URL always cut on the timeline: there is one file,
    // and yt-dlp can only carve one piece out of it.
    const cutAtDownload = trimMode === "download" && hasRange && task.jobs.length === 1
    const res = await downloadOne(jobId, task.url, dir, {
      startTime: cutAtDownload ? String(first.from ?? 0) : null,
      endTime: cutAtDownload && first.to != null ? String(first.to) : null,
    })
    if (res.canceled) return []
    if (!res.success || !res.filePath) {
      onError?.(task.url, res.error ?? undefined)
      return []
    }
    const entries: Array<{ index: number; entry: MediaEntry }> = []
    for (const job of task.jobs) {
      entries.push({
        index: job.index,
        entry: await makeMediaEntryFromPath(
          res.filePath,
          cutAtDownload || (job.from == null && job.to == null)
            ? undefined
            : { srcIn: job.from, srcOut: job.to },
        ),
      })
    }
    return entries
  } catch (err) {
    onError?.(task.url, err instanceof Error ? err.message : String(err))
    return []
  } finally {
    unlisten()
    activeJobIds?.delete(jobId)
    onTaskSettled?.(jobId)
  }
}

export interface RunBatchDownloadsOptions {
  tasks: DownloadTask[]
  dir: string
  trimMode: "download" | "timeline"
  concurrency?: number
  activeJobIds?: Set<string>
  isCancelled: () => boolean
  onActiveRowsChange?: (rows: DownloadRow[]) => void
  onTaskProgress?: (jobId: string, percent: number | null) => void
  onTaskDone?: () => void
  onTaskError?: (url: string, errorMessage?: string) => void
  /**
   * Called after each chunk settles with the entries in original paste order.
   * May be async (e.g. to place the chunk onto the timeline before starting the next chunk).
   */
  onChunkEntries?: (entries: MediaEntry[]) => void | Promise<void>
}

/**
 * Orchestrates downloading `tasks` in chunks of `concurrency`, preserving paste
 * order within each chunk and pausing randomly between chunks.
 */
export async function runBatchDownloads({
  tasks,
  dir,
  trimMode,
  concurrency = DOWNLOAD_CONCURRENCY,
  activeJobIds,
  isCancelled,
  onActiveRowsChange,
  onTaskProgress,
  onTaskDone,
  onTaskError,
  onChunkEntries,
}: RunBatchDownloadsOptions): Promise<void> {
  for (let i = 0; i < tasks.length; i += concurrency) {
    if (isCancelled()) break
    if (i > 0 && !(await sleepUnlessCancelled(randomChunkDelayMs(), isCancelled))) {
      break
    }
    const chunk = tasks
      .slice(i, i + concurrency)
      .map((task) => ({ task, jobId: crypto.randomUUID() }))

    onActiveRowsChange?.(
      chunk.map(({ task, jobId }) => ({ jobId, label: task.url, percent: null })),
    )

    const results = await Promise.all(
      chunk.map(({ task, jobId }) =>
        runSingleDownloadTask({
          task,
          jobId,
          dir,
          trimMode,
          activeJobIds,
          onProgress: onTaskProgress,
          onError: onTaskError,
          onTaskSettled: () => onTaskDone?.(),
        }),
      ),
    )

    const orderedEntries = results
      .flat()
      .sort((a, b) => a.index - b.index)
      .map((r) => r.entry)

    if (orderedEntries.length > 0 && onChunkEntries) {
      await onChunkEntries(orderedEntries)
    }
  }
}
