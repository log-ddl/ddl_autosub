import { convertFileSrc, invoke } from "@tauri-apps/api/core"
import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { readTextFile } from "@tauri-apps/plugin-fs"
import { probeVideoMetadata } from "@/lib/media-probe"

export const IMAGE_EXTS = new Set([
  "jpg", "jpeg", "png", "gif", "bmp", "webp", "tif", "tiff", "heic", "avif",
])

export const VIDEO_EXTS = new Set([
  "mp4", "mov", "mkv", "avi", "webm", "m4v", "wmv", "mpg", "mpeg", "flv",
])

export const AUDIO_EXTS = new Set([
  "mp3", "wav", "m4a", "aac", "flac", "ogg", "opus",
])

// Shared across Download and Auto Edit workspaces so both remember the same folder.
export const DOWNLOAD_DIR_KEY = "autosubs.download.lastDir"

/** Returned by the Rust `scan_media` command (folder listing / file stat). */
export interface MediaFileInfo {
  path: string
  name: string
  kind: "image" | "video"
  createdMs: number
  modifiedMs: number
}

export interface MediaEntry {
  id: string
  path: string
  name: string
  kind: "image" | "video"
  /** File creation time (unix ms) for time-sorting; 0 when unknown. */
  createdMs: number
  /** The sentence spoken while this media shows. Filled from .txt import or manual input. */
  text: string
  /** Probed duration/dimensions, shown as a small info line under the name. */
  info?: { durationSecs?: number; width?: number; height?: number }
  /**
   * Optional section to use from this file, in seconds into the source. Set by
   * the "url start-end" import or manual trim inputs; both undefined means "use the whole clip".
   */
  srcIn?: number
  srcOut?: number
}

export type SortMode = "name" | "created" | "random"

/** A voice source chosen by the user (either a standalone file or a timeline audio track). */
export type VoiceSource =
  | { kind: "file"; path: string; name: string }
  | { kind: "track"; value: string; name: string }
  | null

let idSeq = 0
export const nextMediaId = () => `m${Date.now()}_${idSeq++}`

export function baseName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path
}

/**
 * Identity of a clip as it lands on the timeline: the ROW it came from plus the
 * section taken from it.
 */
export function placedKey(m: { id: string; srcIn?: number; srcOut?: number }): string {
  return `${m.id}|${m.srcIn ?? ""}|${m.srcOut ?? ""}`
}

/**
 * Identity of a clip as an entry in the list: the file plus the section taken
 * from it.
 */
export function entryKey(m: { path: string; srcIn?: number; srcOut?: number }): string {
  return `${m.path}|${m.srcIn ?? ""}|${m.srcOut ?? ""}`
}

/** "90", "1:30" or "1:02:03" -> seconds. Returns null when unparseable. */
export function parseTimecode(raw: string): number | null {
  const s = raw.trim()
  if (!s) return null
  const parts = s.split(":")
  if (parts.some((p) => p === "" || !/^\d+(\.\d+)?$/.test(p))) return null
  let secs = 0
  for (const p of parts) secs = secs * 60 + Number(p)
  return Number.isFinite(secs) ? secs : null
}

/** Clock form for a cut range: "0:30", "1:02:03". No decimals. */
export function formatClock(s: number): string {
  const total = Math.max(0, Math.round(s))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = total % 60
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m)
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`
}

export function formatSecs(s: number): string {
  if (!Number.isFinite(s)) return "—"
  const total = Math.max(0, s)
  const mm = Math.floor(total / 60)
  const ss = total - mm * 60
  return `${mm}:${ss.toFixed(1).padStart(4, "0")}`
}

/**
 * Why a typed trim can't be used, or null when it can.
 */
export function trimHint(
  draft: { from: string; to: string },
  durationSecs?: number,
): "badTime" | "order" | "pastEnd" | null {
  const fromRaw = draft.from.trim()
  const toRaw = draft.to.trim()
  const from = fromRaw === "" ? null : parseTimecode(fromRaw)
  const to = toRaw === "" ? null : parseTimecode(toRaw)
  if ((fromRaw !== "" && from == null) || (toRaw !== "" && to == null)) return "badTime"
  if (from != null && to != null && to <= from) return "order"
  if (durationSecs != null && from != null && from >= durationSecs) return "pastEnd"
  return null
}

/** Natural sort so "img2" precedes "img10". */
export const naturalCompare = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })

export function sortEntries<T extends { name: string; createdMs: number }>(
  entries: T[],
  mode: SortMode,
): T[] {
  const arr = [...entries]
  if (mode === "name") arr.sort((a, b) => naturalCompare(a.name, b.name))
  else if (mode === "created") arr.sort((a, b) => a.createdMs - b.createdMs)
  else {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[arr[i], arr[j]] = [arr[j], arr[i]]
    }
  }
  return arr
}

/** Read an image's intrinsic dimensions through an <img> element. */
export function probeImageDims(path: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => resolve(null)
    img.src = convertFileSrc(path)
    window.setTimeout(() => resolve(null), 8000)
  })
}

/** Probe a media entry's duration (videos) and dimensions (both kinds). */
export async function probeMediaInfo(m: MediaEntry): Promise<MediaEntry> {
  try {
    if (m.kind === "video") {
      const probe = await probeVideoMetadata(m.path)
      if (!probe) return m
      return {
        ...m,
        info: { durationSecs: probe.durationSecs, width: probe.width, height: probe.height },
      }
    }
    const dims = await probeImageDims(m.path)
    if (!dims) return m
    return { ...m, info: { width: dims.width, height: dims.height } }
  } catch {
    return m
  }
}

/** Scan specific file paths via Rust `scan_media`. */
export async function scanMediaPaths(paths: string[]): Promise<MediaFileInfo[]> {
  if (paths.length === 0) return []
  return invoke<MediaFileInfo[]>("scan_media", { input: { paths } })
}

/** Scan an entire directory via Rust `scan_media`. */
export async function scanMediaDir(dir: string): Promise<MediaFileInfo[]> {
  if (!dir) return []
  return invoke<MediaFileInfo[]>("scan_media", { input: { dir } })
}

/** Open file picker for images/videos and scan them via Rust `scan_media`. */
export async function pickAndScanMediaFiles(): Promise<MediaFileInfo[] | null> {
  const picked = await openDialog({
    multiple: true,
    directory: false,
    filters: [{ name: "Media", extensions: [...IMAGE_EXTS, ...VIDEO_EXTS] }],
  })
  const paths = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : []
  if (paths.length === 0) return null
  return scanMediaPaths(paths)
}

/** Open folder picker and scan all supported media inside via Rust `scan_media`. */
export async function pickAndScanMediaFolder(): Promise<MediaFileInfo[] | null> {
  const picked = await openDialog({ multiple: false, directory: true })
  if (typeof picked !== "string") return null
  return scanMediaDir(picked)
}

/** Open folder picker for downloads and persist in localStorage. */
export async function pickDownloadFolder(): Promise<string> {
  const picked = await openDialog({ directory: true, multiple: false })
  if (typeof picked !== "string") return ""
  localStorage.setItem(DOWNLOAD_DIR_KEY, picked)
  return picked
}

/** Open file picker for a voice/audio/video file. */
export async function pickVoiceFile(): Promise<{ kind: "file"; path: string; name: string } | null> {
  const picked = await openDialog({
    multiple: false,
    directory: false,
    filters: [
      { name: "Audio/Video", extensions: [...AUDIO_EXTS, ...VIDEO_EXTS] },
    ],
  })
  if (typeof picked !== "string") return null
  return { kind: "file", path: picked, name: baseName(picked) }
}

/** Open file picker for a `.txt` script file and return its lines. */
export async function pickAndReadScriptLines(): Promise<string[] | null> {
  const picked = await openDialog({
    multiple: false,
    directory: false,
    filters: [{ name: "Text", extensions: ["txt"] }],
  })
  if (typeof picked !== "string") return null
  const raw = await readTextFile(picked)
  return raw.replace(/\r\n?/g, "\n").split("\n")
}

/** Turn a single file on disk (e.g. a downloaded video) into a `MediaEntry`. */
export async function makeMediaEntryFromPath(
  filePath: string,
  range?: { srcIn?: number; srcOut?: number },
): Promise<MediaEntry> {
  let info: MediaFileInfo | undefined
  try {
    const scanned = await scanMediaPaths([filePath])
    info = scanned[0]
  } catch {
    // scan_media only classifies the file; fall back to the extension.
  }
  const name = info?.name ?? baseName(filePath)
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  return {
    id: nextMediaId(),
    path: filePath,
    name,
    kind: info?.kind ?? (IMAGE_EXTS.has(ext) ? "image" : "video"),
    createdMs: info?.createdMs ?? Date.now(),
    text: "",
    srcIn: range?.srcIn,
    srcOut: range?.srcOut,
  }
}
