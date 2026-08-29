import * as React from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { convertFileSrc, invoke } from "@tauri-apps/api/core"
import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { readTextFile } from "@tauri-apps/plugin-fs"
import {
  ArrowDown,
  ArrowUp,
  AudioLines,
  Download,
  FileAudio,
  FileText,
  Film,
  FolderOpen,
  Image as ImageIcon,
  Link as LinkIcon,
  Loader2,
  Play,
  Scissors,
  Upload,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { useSubtitleDocument } from "@/contexts/SubtitleDocumentContext"
import { ResolveApiError } from "@/api/resolve-api"
import { useTimelineHost } from "@/lib/use-timeline-host"
import { probeVideoMetadata } from "@/lib/media-probe"
import {
  cancelDownload,
  downloadOne,
  downloadToolsReady,
  onDownloadProgress,
} from "@/lib/media-download"
import { TrackCard } from "@/components/autoedit/track-card"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import type { Track } from "@/types"
import {
  alignScriptToWords,
  flattenWords,
  type AlignedSpan,
  type TimedWord,
} from "@/lib/slideshow-align"
import { useVoiceTranscriber } from "@/lib/slideshow-transcribe"

const IMAGE_EXTS = new Set([
  "jpg", "jpeg", "png", "gif", "bmp", "webp", "tif", "tiff", "heic", "avif",
])
const VIDEO_EXTS = new Set([
  "mp4", "mov", "mkv", "avi", "webm", "m4v", "wmv", "mpg", "mpeg", "flv",
])

// Shared with the Download workspace so both remember the same folder.
const DOWNLOAD_DIR_KEY = "autosubs.download.lastDir"

/**
 * How many links download at once. Kept small on purpose: YouTube throttles
 * parallel connections, and every yt-dlp spawns an ffmpeg to merge streams, so
 * a wide window costs CPU without buying much wall time.
 */
const DOWNLOAD_CONCURRENCY = 2

// Returned by the Rust `scan_media` command (folder listing / file stat).
interface MediaFileInfo {
  path: string
  name: string
  kind: "image" | "video"
  createdMs: number
  modifiedMs: number
}

interface MediaEntry {
  id: string
  path: string
  name: string
  kind: "image" | "video"
  /** File creation time (unix ms) for time-sorting; 0 when unknown. */
  createdMs: number
  /** The sentence spoken while this media shows. Filled from the .txt import. */
  text: string
  /** Probed duration/dimensions, shown as a small info line under the name. */
  info?: { durationSecs?: number; width?: number; height?: number }
  /**
   * Optional section to use from this file, in seconds into the source. Set by
   * the "url start-end" import; both undefined means "use the whole clip".
   */
  srcIn?: number
  srcOut?: number
}

/** Read an image's intrinsic dimensions through an <img> element. */
function probeImageDims(path: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => resolve(null)
    img.src = convertFileSrc(path)
    window.setTimeout(() => resolve(null), 8000)
  })
}

/** Probe a media entry's duration (videos) and dimensions (both kinds). */
const probeMediaInfo = async (m: MediaEntry): Promise<MediaEntry> => {
  try {
    if (m.kind === "video") {
      const probe = await probeVideoMetadata(m.path)
      if (!probe) return m
      return { ...m, info: { durationSecs: probe.durationSecs, width: probe.width, height: probe.height } }
    }
    const dims = await probeImageDims(m.path)
    if (!dims) return m
    return { ...m, info: { width: dims.width, height: dims.height } }
  } catch {
    return m
  }
}

type SortMode = "name" | "created" | "random"

// A voice the user has chosen but not necessarily transcribed yet. Picking is
// kept separate from running so selecting a file never kicks off a long job.
type VoiceSource =
  | { kind: "file"; path: string; name: string }
  | { kind: "track"; value: string; name: string }
  | null

// One media clip in its build form: just where it sits on the timeline.
interface BuildItem {
  path: string
  start: number
  end: number
  /** Section within the source; see MediaEntry.srcIn/srcOut. */
  srcIn?: number
  srcOut?: number
}

/** One link being downloaded right now, as shown in the progress list. */
interface DownloadRow {
  jobId: string
  label: string
  percent: number | null
}

/** One pasted link, resolved against the default range boxes. */
interface DownloadJob {
  url: string
  from?: number
  to?: number
}

/** "90", "1:30" or "1:02:03" -> seconds. Returns null when unparseable. */
function parseTimecode(raw: string): number | null {
  const s = raw.trim()
  if (!s) return null
  const parts = s.split(":")
  if (parts.some((p) => p === "" || !/^\d+(\.\d+)?$/.test(p))) return null
  let secs = 0
  for (const p of parts) secs = secs * 60 + Number(p)
  return Number.isFinite(secs) ? secs : null
}

/**
 * One pasted line: a URL, optionally followed by a `start-end` range
 * ("https://… 0:30-1:20"). Either side of the range may be empty
 * ("30-" = from 0:30 to the end). No range at all means the whole clip.
 */
function parseLinkLine(line: string): { url: string; from?: number; to?: number } | null {
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

function baseName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path
}

function sortEntries<T extends { name: string; createdMs: number }>(
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

// Natural sort so "img2" precedes "img10" — the order a human expects.
const naturalCompare = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })

let idSeq = 0
const nextId = () => `m${Date.now()}_${idSeq++}`

/** Clock form for a cut range: "0:30", "1:02:03". No decimals. */
function formatClock(s: number): string {
  const total = Math.max(0, Math.round(s))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = total % 60
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m)
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`
}

/** The "0:30-1:45" label for a media entry, or null when it plays whole. */
function rangeLabel(m: { srcIn?: number; srcOut?: number }): string | null {
  if (m.srcIn == null && m.srcOut == null) return null
  return `${formatClock(m.srcIn ?? 0)}-${m.srcOut != null ? formatClock(m.srcOut) : "…"}`
}

function formatSecs(s: number): string {
  if (!Number.isFinite(s)) return "—"
  const total = Math.max(0, s)
  const mm = Math.floor(total / 60)
  const ss = total - mm * 60
  return `${mm}:${ss.toFixed(1).padStart(4, "0")}`
}

/**
 * "Slideshow from voice" — an Auto Edit tool. Import ordered media, optionally
 * tag each with the sentence it belongs to and transcribe a voice-over, then
 * place everything onto the active editor timeline — synced to the voice when
 * there's a script, otherwise stitched sequentially. The target editor (Resolve
 * or Premiere) follows the app's selected integration; see `useTimelineHost`.
 */
export function SlideshowPanel() {
  const { t } = useTranslation()
  const { timelineInfo, getSourceAudio, buildStoryboard, isConnected, kind } =
    useTimelineHost()
  const { subtitles, currentSubtitleDocumentSourceName } = useSubtitleDocument()
  const { transcribe } = useVoiceTranscriber()

  const [media, setMedia] = React.useState<MediaEntry[]>([])
  const [sortBy, setSortBy] = React.useState<SortMode>("name")
  const [videoTargetVal, setVideoTargetVal] = React.useState("")
  const [secsPerImage] = React.useState(3)
  // Words already transcribed inside this dialog. Takes priority over the
  // current transcript so the user never has to leave here.
  const [voiceWords, setVoiceWords] = React.useState<TimedWord[] | null>(null)
  const [voiceName, setVoiceName] = React.useState<string | null>(null)
  const [transcribing, setTranscribing] = React.useState(false)
  const [addingMedia, setAddingMedia] = React.useState(false)
  const [addingAudio, setAddingAudio] = React.useState(false)
  const [cutting, setCutting] = React.useState(false)
  // How many times each has been pushed to the timeline (shown as "(n)").
  const [mediaAddCount, setMediaAddCount] = React.useState(0)
  const [audioAddCount, setAudioAddCount] = React.useState(0)
  // What the user has chosen as the voice — not run until they press Transcribe.
  const [voiceSource, setVoiceSource] = React.useState<VoiceSource>(null)

  // "Add from link": download clips with yt-dlp, then treat them as normal media.
  const [linkOpen, setLinkOpen] = React.useState(false)
  const [linkUrls, setLinkUrls] = React.useState("")
  // Where downloads land. Shared with the Download workspace so both tabs keep
  // using the same folder once the user has picked one.
  const [linkDir, setLinkDir] = React.useState<string>(
    () => localStorage.getItem(DOWNLOAD_DIR_KEY) ?? "",
  )
  // Default range for lines that don't carry their own. Blank = whole clip.
  const [linkFrom, setLinkFrom] = React.useState("")
  const [linkTo, setLinkTo] = React.useState("")
  // Where the range is cut. "download" hands yt-dlp a section (small file, but
  // it can only cut on keyframes); "timeline" keeps the whole file and cuts the
  // clip in the editor (frame-accurate, and re-editable later).
  const [linkTrim, setLinkTrim] = React.useState<"download" | "timeline">("timeline")
  const [downloading, setDownloading] = React.useState(false)
  const [dlDone, setDlDone] = React.useState(0)
  const [dlTotal, setDlTotal] = React.useState(0)
  // The links currently in flight, in paste order — one progress row each.
  const [dlActive, setDlActive] = React.useState<DownloadRow[]>([])
  // Every job id still running, so Cancel can kill the whole batch and not just
  // whichever one happened to start last.
  const dlJobsRef = React.useRef<Set<string>>(new Set())
  const dlCancelRef = React.useRef(false)
  // Set the moment Cancel is pressed. yt-dlp takes a beat to die and a placement
  // already in flight has to finish, so the button reports "stopping" rather
  // than looking like it did nothing.
  const [dlCanceling, setDlCanceling] = React.useState(false)

  // Paths already in the list. Mirrors `media`, but readable synchronously so a
  // batch of downloads can dedupe itself without waiting for a re-render.
  const knownPathsRef = React.useRef<Set<string>>(new Set())
  React.useEffect(() => {
    knownPathsRef.current = new Set(media.map((m) => m.path))
  }, [media])

  const audioTracks = timelineInfo.inputTracks ?? []

  const docWords = React.useMemo(() => flattenWords(subtitles), [subtitles])
  const words = voiceWords ?? docWords
  const hasVoice = words.length > 0
  const voiceLabel = voiceWords ? voiceName : currentSubtitleDocumentSourceName

  // The video tracks we can drop onto. (outputTracks carries a value-"0" pseudo
  // entry we filter out here.) Resolve can create a fresh track above the
  // existing ones, so it gets a synthetic "New track" option that never
  // overwrites the user's clips; Premiere can't add tracks from a script, so it
  // only lists the real ones.
  const isResolveHost = kind === "davinci"
  const realVideoTracks = (timelineInfo.outputTracks ?? []).filter(
    (tr) => tr.value !== "0",
  )
  const newTrackValue = String(realVideoTracks.length + 1)
  const videoTrackOptions: Track[] = isResolveHost
    ? [...realVideoTracks, { value: newTrackValue, label: t("slideshow.newTrack", "New track") }]
    : realVideoTracks
  // Default target: a fresh track on Resolve, the top existing track on Premiere.
  const defaultTargetVal = isResolveHost
    ? newTrackValue
    : realVideoTracks[realVideoTracks.length - 1]?.value ?? "1"
  React.useEffect(() => {
    if (!videoTargetVal) setVideoTargetVal(defaultTargetVal)
  }, [defaultTargetVal, videoTargetVal])

  // Live alignment, recomputed as media/text/voice change. There is no "align"
  // button: the per-media times below update on the fly, and Place uses these.
  const spans = React.useMemo<AlignedSpan[]>(() => {
    if (!hasVoice || media.length === 0) return []
    const result = alignScriptToWords(media.map((m) => m.text), words)
    const byLine = new Map(result.map((s) => [s.lineIndex, s]))
    return media
      .map((_, i) => byLine.get(i))
      .filter((s): s is AlignedSpan => s !== undefined)
  }, [media, words, hasVoice])

  // Add scanned files to the list, applying the current sort to just the new
  // batch (existing manual ordering above is preserved; new items append).
  const addInfos = React.useCallback(
    (infos: MediaFileInfo[]) => {
      if (infos.length === 0) {
        toast.info(t("slideshow.noSupportedMedia", "No supported images or videos found."))
        return
      }
      const ordered = sortEntries(infos, sortBy)
      setMedia((prev) => {
        const seen = new Set(prev.map((m) => m.path))
        return [
          ...prev,
          ...ordered
            .filter((x) => !seen.has(x.path))
            .map<MediaEntry>((x) => ({
              id: nextId(),
              path: x.path,
              name: x.name,
              kind: x.kind,
              createdMs: x.createdMs,
              text: "",
            })),
        ]
      })
      // Probe duration/dimensions in the background; dedupe by path so an
      // already-imported file just refreshes its own info.
      for (const x of ordered) {
        const stub: MediaEntry = {
          id: "",
          path: x.path,
          name: x.name,
          kind: x.kind,
          createdMs: x.createdMs,
          text: "",
        }
        void probeMediaInfo(stub).then((updated) => {
          if (!updated.info) return
          setMedia((prev) =>
            prev.map((m) => (m.path === updated.path ? { ...m, info: updated.info } : m)),
          )
        })
      }
    },
    [sortBy, t],
  )

  const handleImportFiles = async () => {
    const picked = await openDialog({
      multiple: true,
      directory: false,
      filters: [{ name: "Media", extensions: [...IMAGE_EXTS, ...VIDEO_EXTS] }],
    })
    const paths = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : []
    if (paths.length === 0) return
    const infos = await invoke<MediaFileInfo[]>("scan_media", { input: { paths } })
    addInfos(infos)
  }

  const handleImportFolder = async () => {
    const picked = await openDialog({ multiple: false, directory: true })
    if (typeof picked !== "string") return
    const infos = await invoke<MediaFileInfo[]>("scan_media", { input: { dir: picked } })
    addInfos(infos)
  }

  // Turn a downloaded file into a media entry. Deliberately free of state
  // updates: downloads finish out of order, so the caller collects a whole
  // batch and commits it in the pasted order instead.
  const makeDownloadedEntry = React.useCallback(
    async (filePath: string, range?: { srcIn?: number; srcOut?: number }) => {
      let info: MediaFileInfo | undefined
      try {
        const scanned = await invoke<MediaFileInfo[]>("scan_media", {
          input: { paths: [filePath] },
        })
        info = scanned[0]
      } catch {
        // scan_media only classifies the file; fall back to the extension.
      }
      const name = info?.name ?? baseName(filePath)
      const ext = name.split(".").pop()?.toLowerCase() ?? ""
      const entry: MediaEntry = {
        id: nextId(),
        path: filePath,
        name,
        kind: info?.kind ?? (IMAGE_EXTS.has(ext) ? "image" : "video"),
        createdMs: info?.createdMs ?? Date.now(),
        text: "",
        srcIn: range?.srcIn,
        srcOut: range?.srcOut,
      }
      return entry
    },
    [],
  )

  // Commit a batch of downloaded entries, already in pasted order. Returns the
  // ones that were actually new, so the caller places exactly what it added.
  const commitDownloaded = React.useCallback((entries: MediaEntry[]): MediaEntry[] => {
    if (entries.length === 0) return []
    // Dedupe against the list and within the batch itself. A dropped entry
    // takes its timeline slot with it, exactly like a failed link does.
    // `knownPaths` is a ref rather than `media` so two chunks committed before
    // the next render still see each other.
    const fresh: MediaEntry[] = []
    for (const entry of entries) {
      if (knownPathsRef.current.has(entry.path)) continue
      knownPathsRef.current.add(entry.path)
      fresh.push(entry)
    }
    if (fresh.length === 0) return []
    setMedia((prev) => [...prev, ...fresh])
    for (const entry of fresh) {
      void probeMediaInfo(entry).then((updated) => {
        if (!updated.info) return
        setMedia((prev) =>
          prev.map((m) => (m.path === updated.path ? { ...m, info: updated.info } : m)),
        )
      })
    }
    return fresh
  }, [])

  // Ask for the download folder and remember it. Returns "" if cancelled.
  const pickDownloadDir = async (): Promise<string> => {
    const picked = await openDialog({ directory: true, multiple: false })
    if (typeof picked !== "string") return ""
    setLinkDir(picked)
    localStorage.setItem(DOWNLOAD_DIR_KEY, picked)
    return picked
  }

  // Download one link. Never rejects: a dead link resolves to null so it can't
  // take the rest of its chunk down with it.
  const runDownloadJob = async (
    job: DownloadJob,
    jobId: string,
    dir: string,
  ): Promise<MediaEntry | null> => {
    dlJobsRef.current.add(jobId)
    const unlisten = await onDownloadProgress(jobId, (p) => {
      setDlActive((rows) =>
        rows.map((r) => (r.jobId === jobId ? { ...r, percent: p.percent } : r)),
      )
    })
    try {
      const hasRange = job.from != null || job.to != null
      // Cutting at download hands yt-dlp the section; cutting on the timeline
      // pulls the whole clip and carries the range through to the editor
      // instead.
      const cutAtDownload = linkTrim === "download" && hasRange
      const res = await downloadOne(jobId, job.url, dir, {
        startTime: cutAtDownload ? String(job.from ?? 0) : null,
        endTime: cutAtDownload && job.to != null ? String(job.to) : null,
      })
      if (res.canceled) return null
      if (!res.success || !res.filePath) {
        toast.error(t("slideshow.link.failed", "Could not download {{url}}", { url: job.url }), {
          description: res.error ?? undefined,
        })
        return null
      }
      return await makeDownloadedEntry(
        res.filePath,
        // yt-dlp already cut it, so the file *is* the section.
        !cutAtDownload && hasRange ? { srcIn: job.from, srcOut: job.to } : undefined,
      )
    } catch (err) {
      toast.error(t("slideshow.link.failed", "Could not download {{url}}", { url: job.url }), {
        description: err instanceof Error ? err.message : String(err),
      })
      return null
    } finally {
      unlisten()
      dlJobsRef.current.delete(jobId)
      setDlDone((n) => n + 1)
    }
  }

  /**
   * Download the pasted links `DOWNLOAD_CONCURRENCY` at a time, committing each
   * chunk before starting the next. Order is safe because a chunk is only
   * committed once every link in it has settled — `Promise.all` hands the
   * results back in the pasted order regardless of who finished first — and a
   * link that fails simply gives up its slot, so the next clip butts straight
   * against the previous one instead of leaving a hole.
   */
  const handleDownloadLinks = async (autoPlace = false) => {
    if (downloading) return
    // Each line is "url" or "url start-end"; the boxes above supply the range
    // for any line that doesn't carry one. No range anywhere = whole clip.
    const defFrom = parseTimecode(linkFrom) ?? undefined
    const defTo = parseTimecode(linkTo) ?? undefined
    const jobs = linkUrls
      .split("\n")
      .map(parseLinkLine)
      .filter((j): j is { url: string; from?: number; to?: number } => j !== null)
      .map<DownloadJob>((j) => ({
        url: j.url,
        from: j.from ?? defFrom,
        to: j.to ?? defTo,
      }))
    if (jobs.length === 0) {
      toast.error(t("slideshow.link.noUrl", "Paste at least one link."))
      return
    }
    if (!(await downloadToolsReady())) {
      toast.error(
        t("slideshow.link.toolsMissing", "Open the Download tab once to install the downloader."),
      )
      return
    }

    const dir = linkDir || (await pickDownloadDir())
    if (!dir) return

    let canPlace = autoPlace
    if (autoPlace && !isConnected) {
      toast.error(t("slideshow.connectResolve", "Connect an editor timeline to add."))
      canPlace = false
    }

    dlCancelRef.current = false
    dlJobsRef.current.clear()
    setDlCanceling(false)
    setDownloading(true)
    setDlTotal(jobs.length)
    setDlDone(0)
    setDlActive([])
    let ok = 0
    let placedAny = false
    // Where the next chunk starts, so chunk 2 lands after chunk 1 instead of
    // back at the top of the timeline.
    let placeCursor = 0
    try {
      for (let i = 0; i < jobs.length; i += DOWNLOAD_CONCURRENCY) {
        if (dlCancelRef.current) break
        const chunk = jobs
          .slice(i, i + DOWNLOAD_CONCURRENCY)
          .map((job) => ({ job, jobId: crypto.randomUUID() }))
        setDlActive(chunk.map(({ job, jobId }) => ({ jobId, label: job.url, percent: null })))
        const results = await Promise.all(
          chunk.map(({ job, jobId }) => runDownloadJob(job, jobId, dir)),
        )
        const fresh = commitDownloaded(results.filter((e): e is MediaEntry => e !== null))
        ok += fresh.length
        // Cancelling stops new placements but keeps the files already fetched:
        // they stay in the list for the user to place by hand.
        if (canPlace && fresh.length > 0 && !dlCancelRef.current) {
          const items = sequentialItems(fresh, placeCursor)
          placeCursor = items[items.length - 1]?.end ?? placeCursor
          await runBuild({
            items,
            setBusy: setAddingMedia,
            onSuccess: () => {
              placedAny = true
            },
            // One summary toast for the whole run, not one per chunk.
            quiet: true,
          })
        }
      }
      if (placedAny) setMediaAddCount((c) => c + 1)
      if (dlCancelRef.current) {
        toast.info(
          t("slideshow.link.stopped", "Stopped. Kept {{n}} clips already downloaded.", { n: ok }),
        )
      } else if (ok > 0) {
        setLinkUrls("")
        toast.success(t("slideshow.link.done", "Added {{n}} downloaded clips.", { n: ok }))
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setDownloading(false)
      setDlCanceling(false)
      setDlActive([])
      dlJobsRef.current.clear()
    }
  }

  // Stop the whole run: kill every link currently downloading, and stop the
  // chunk loop so nothing further is downloaded or placed. Files already
  // finished stay in the list — they're on disk either way.
  const handleCancelDownload = async () => {
    if (dlCancelRef.current) return
    dlCancelRef.current = true
    setDlCanceling(true)
    await Promise.all([...dlJobsRef.current].map((id) => cancelDownload(id)))
  }

  const applySort = (mode: SortMode) => {
    setSortBy(mode)
    setMedia((prev) => sortEntries(prev, mode))
  }

  const move = (index: number, dir: -1 | 1) => {
    setMedia((prev) => {
      const next = [...prev]
      const j = index + dir
      if (j < 0 || j >= next.length) return prev
      ;[next[index], next[j]] = [next[j], next[index]]
      return next
    })
  }

  const remove = (id: string) => {
    setMedia((prev) => prev.filter((m) => m.id !== id))
  }

  const setText = (id: string, text: string) => {
    setMedia((prev) => prev.map((m) => (m.id === id ? { ...m, text } : m)))
  }

  // Load a .txt where line N is the sentence for media N (blank lines allowed).
  const handleImportScript = async () => {
    const picked = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "Text", extensions: ["txt"] }],
    })
    if (typeof picked !== "string") return
    try {
      const raw = await readTextFile(picked)
      const lines = raw.replace(/\r\n?/g, "\n").split("\n")
      setMedia((prev) => prev.map((m, i) => ({ ...m, text: (lines[i] ?? "").trim() })))
      toast.success(
        t("slideshow.scriptLoaded", "Loaded {{n}} lines from the script.", {
          n: Math.min(lines.length, media.length),
        }),
      )
    } catch (err) {
      console.error("Failed to read script:", err)
      toast.error(t("slideshow.scriptError", "Could not read the script file."))
    }
  }

  // Shared tail for both voice sources: flatten, shift word times into the
  // timeline domain (0 = timeline start), and stash them. `offsetSecs` is how
  // far into the timeline the transcribed audio begins — 0 for a standalone
  // file, the track's export offset for a timeline track — so `buildStoryboard`
  // (which adds the timeline start itself) lands each clip in the right place.
  const applyTranscript = (
    segments: Parameters<typeof flattenWords>[0],
    offsetSecs: number,
    name: string,
  ): boolean => {
    const flat = flattenWords(segments)
    if (flat.length === 0) {
      toast.error(t("slideshow.voiceEmpty", "No speech was found in that file."))
      return false
    }
    const shifted =
      offsetSecs === 0
        ? flat
        : flat.map((w) => ({ ...w, start: w.start + offsetSecs, end: w.end + offsetSecs }))
    setVoiceWords(shifted)
    setVoiceName(name)
    toast.success(t("slideshow.voiceDone", "Transcribed {{n}} words.", { n: shifted.length }))
    return true
  }

  // Pick a voice file — nothing heavy happens yet, just remember the choice.
  const handlePickVoiceFile = async () => {
    const picked = await openDialog({
      multiple: false,
      directory: false,
      filters: [
        { name: "Audio/Video", extensions: ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", ...VIDEO_EXTS] },
      ],
    })
    if (typeof picked !== "string") return
    setVoiceSource({ kind: "file", path: picked, name: baseName(picked) })
    setVoiceWords(null) // a new source supersedes any earlier transcription
  }

  // Run transcription on the chosen source. Separate from picking so the long
  // job only starts when the user explicitly asks for it.
  const handleTranscribe = async () => {
    if (!voiceSource || transcribing) return
    setTranscribing(true)
    try {
      if (voiceSource.kind === "file") {
        const segments = await transcribe(voiceSource.path)
        applyTranscript(segments, 0, voiceSource.name)
      } else {
        // Export the track, transcribe the WAV, then shift by the export offset
        // so timings are timeline-absolute.
        const audio = await getSourceAudio("timeline", null, [voiceSource.value])
        if (!audio || !audio.path) return // cancelled / failed (export reports its own errors)
        const segments = await transcribe(audio.path)
        applyTranscript(segments, audio.offset || 0, voiceSource.name)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error("Transcription failed:", err)
      toast.error(message)
    } finally {
      setTranscribing(false)
    }
  }

  // A voice imported as a FILE can also be dropped onto the timeline as its own
  // audio track. A voice taken from a timeline track is already there, so it is
  // never re-added.
  const voiceFilePath = voiceSource?.kind === "file" ? voiceSource.path : null

  // Shared timeline push used by both the Media and Audio buttons. Media and
  // audio are added independently so each can be re-run on its own; a success
  // bumps the caller's counter (shown as "(n)" on the button).
  // Returns a promise so a caller placing several batches in a row can wait for
  // one to land before sending the next — the host APIs don't take concurrent
  // edits. Callers that fire and forget can ignore it.
  const runBuild = (opts: {
    items: BuildItem[]
    audioPath?: string
    setBusy: (b: boolean) => void
    onSuccess: () => void
    /** Skip the success toast — for batched pushes that report once at the end. */
    quiet?: boolean
  }): Promise<void> => {
    opts.setBusy(true)
    return (async () => {
      try {
        const res = await buildStoryboard({
          targetVideoTrack: Number(videoTargetVal) || Number(defaultTargetVal) || 1,
          defaultStillSecs: secsPerImage,
          items: opts.items.map((it) => ({
            path: it.path,
            start: it.start,
            end: it.end,
            srcIn: it.srcIn,
            srcOut: it.srcOut,
          })),
          audioPath: opts.audioPath,
        })
        if (res.lines.length) console.log("[slideshow]\n" + res.lines.join("\n"))
        // The host can report success yet land nothing (import/placement failed
        // on its side). Surface the first reason instead of a misleading toast,
        // and don't bump the "(n)" counter for a no-op.
        if (opts.items.length > 0 && res.appended === 0) {
          toast.warning(res.lines[0] ?? "Nothing was placed on the timeline.")
        } else {
          opts.onSuccess()
          if (!opts.quiet) toast.success(t("slideshow.addedOk", "Added to the timeline."))
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const detail = err instanceof ResolveApiError ? err.detail : undefined
        console.error("Build failed:", err, detail)
        toast.error(message)
      } finally {
        opts.setBusy(false)
      }
    })()
  }

  // Media laid out back-to-back, `secsPerImage` each. No voice involved.
  // `startAt` lets a caller append after what it already placed, which is how
  // the chunked link download keeps its later batches off the earlier ones.
  const sequentialItems = (entries: MediaEntry[] = media, startAt = 0): BuildItem[] => {
    // Clips with a source range take that long, so the slots aren't uniform.
    let cursor = startAt
    return entries.map((m) => {
      const ranged =
        m.srcIn != null && m.srcOut != null ? m.srcOut - m.srcIn : undefined
      const dur = ranged && ranged > 0 ? ranged : secsPerImage
      const start = cursor
      cursor += dur
      return {
        path: m.path,
        start,
        end: start + dur,
        srcIn: m.srcIn,
        srcOut: m.srcOut,
      }
    })
  }

  // Media cut to the span of the sentence each one belongs to, laid back-to-back:
  // each item starts exactly where the previous one ended. Durations are
  // preserved; only the first start is kept from the alignment.
  const syncedItems = (): BuildItem[] => {
    const starts: number[] = []
    let cursor = spans[0].start
    for (const s of spans) {
      starts.push(cursor)
      cursor += Math.max(0.2, s.end - s.start)
    }
    return spans.map((s, i) => {
      const start = starts[i]
      const end = start + Math.max(0.2, s.end - s.start)
      return {
        path: media[s.lineIndex].path,
        start,
        end,
        srcIn: media[s.lineIndex].srcIn,
        srcOut: media[s.lineIndex].srcOut,
      }
    })
  }

  // Plain add: "just put my images on the timeline".
  const handleAddMedia = () => {
    if (media.length === 0) return
    runBuild({
      items: sequentialItems(),
      setBusy: setAddingMedia,
      onSuccess: () => setMediaAddCount((c) => c + 1),
    })
  }

  // Drop just the voice-over audio file onto a new audio track.
  const handleAddAudio = () => {
    if (!voiceFilePath) return
    runBuild({
      items: [],
      audioPath: voiceFilePath,
      setBusy: setAddingAudio,
      onSuccess: () => setAudioAddCount((c) => c + 1),
    })
  }

  // The real work: cut each media to the span of the sentence it belongs to and
  // lay them out against the transcribed voice. Needs both a voice and a script.
  const handleCutSync = () => {
    if (spans.length === 0) return
    runBuild({
      items: syncedItems(),
      setBusy: setCutting,
      onSuccess: () => {},
    })
  }

  const spanByLine = React.useMemo(
    () => new Map(spans.map((s) => [s.lineIndex, s])),
    [spans],
  )

  return (
    <div className="flex flex-col">
        <div className="space-y-5">
          {/* Step 1 — media */}
          <section>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">
                {t("slideshow.mediaTitle", "1. Media")}
              </h3>
              {media.length > 1 && (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">
                    {t("slideshow.sortBy", "Sort")}
                  </span>
                  <select
                    value={sortBy}
                    onChange={(e) => applySort(e.target.value as SortMode)}
                    className="h-7 rounded-md border border-input bg-transparent px-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="name">{t("slideshow.sortName", "Name")}</option>
                    <option value="created">{t("slideshow.sortCreated", "Date created")}</option>
                    <option value="random">{t("slideshow.sortRandom", "Random")}</option>
                  </select>
                </div>
              )}
            </div>
            <div className="space-y-2">
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={handleImportFiles}
                  className="flex items-center gap-2.5 rounded-2xl border px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
                >
                  <Upload className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">
                      {t("slideshow.addFiles", "Add files")}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {t("slideshow.addFilesHint", "Images or clips")}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={handleImportFolder}
                  className="flex items-center gap-2.5 rounded-2xl border px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
                >
                  <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">
                      {t("slideshow.addFolder", "Add folder")}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {t("slideshow.addFolderHint", "All media inside")}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setLinkOpen((v) => !v)}
                  className={cn(
                    "flex items-center gap-2.5 rounded-2xl border px-3 py-2.5 text-left transition-colors",
                    linkOpen ? "bg-card shadow-sm" : "hover:bg-muted/50",
                  )}
                >
                  <LinkIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">
                      {t("slideshow.addLink", "Add from link")}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {t("slideshow.addLinkHint", "Download, then place")}
                    </span>
                  </span>
                </button>
              </div>

              {/* Paste links, download them, and drop the files into the list
                  above. The clips then behave exactly like imported files. */}
              {linkOpen && (
                <div className="space-y-3 rounded-2xl border bg-card p-3">
                  <textarea
                    value={linkUrls}
                    onChange={(e) => setLinkUrls(e.target.value)}
                    disabled={downloading}
                    rows={3}
                    placeholder={t(
                      "slideshow.link.placeholder",
                      "One link per line — add a range to cut it:\nhttps://…  0:30-1:20",
                    )}
                    className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
                  />
                  {/* Where the files land — the same folder the Download tab
                      uses, shown here so it is never a mystery. */}
                  <div className="flex items-center gap-2 rounded-lg border border-dashed px-2.5 py-1.5">
                    <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={linkDir}>
                      {linkDir || t("slideshow.link.dirNone", "No folder chosen yet")}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 shrink-0 px-2 text-[11px]"
                      disabled={downloading}
                      onClick={pickDownloadDir}
                    >
                      {linkDir
                        ? t("slideshow.link.dirChange", "Change")
                        : t("slideshow.link.dirPick", "Choose folder")}
                    </Button>
                  </div>

                  {/* Two settings on one row, actions on their own below. The
                      buttons used to share this row and squeezed the select down
                      to its arrow once the labels were translated. */}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="ss-link-from" className="text-xs">
                        {t("slideshow.link.range", "Trim (optional)")}
                      </Label>
                      <div className="flex items-center gap-1.5">
                        <Input
                          id="ss-link-from"
                          value={linkFrom}
                          disabled={downloading}
                          onChange={(e) => setLinkFrom(e.target.value)}
                          placeholder={t("slideshow.link.from", "From (e.g. 0:30)")}
                          className="h-8 min-w-0 flex-1"
                        />
                        <span className="shrink-0 text-xs text-muted-foreground">→</span>
                        <Input
                          id="ss-link-to"
                          value={linkTo}
                          disabled={downloading}
                          onChange={(e) => setLinkTo(e.target.value)}
                          placeholder={t("slideshow.link.to", "To (e.g. 1:20)")}
                          className="h-8 min-w-0 flex-1"
                        />
                      </div>
                    </div>
                    <div className="min-w-0 space-y-1.5">
                      <Label htmlFor="ss-link-trim" className="text-xs">
                        {t("slideshow.link.trim", "Cut where")}
                      </Label>
                      <select
                        id="ss-link-trim"
                        value={linkTrim}
                        disabled={downloading}
                        onChange={(e) => setLinkTrim(e.target.value as "download" | "timeline")}
                        className="flex h-8 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
                      >
                        <option value="timeline">
                          {t("slideshow.link.trimTimeline", "On the timeline (exact)")}
                        </option>
                        <option value="download">
                          {t("slideshow.link.trimDownload", "While downloading (smaller file)")}
                        </option>
                      </select>
                    </div>
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    {t("slideshow.link.rangeHint", "No range = the whole clip.")}{" "}
                    {linkTrim === "timeline"
                      ? t("slideshow.link.trimTimelineHint", "Keeps the whole file so you can re-trim later.")
                      : t("slideshow.link.trimDownloadHint", "Faster and smaller, but cuts on keyframes so the start can drift.")}
                  </p>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {downloading ? (
                      <Button
                        onClick={handleCancelDownload}
                        disabled={dlCanceling}
                        variant="destructive"
                        size="sm"
                        className="gap-1.5"
                      >
                        <X className="size-4" />
                        {dlCanceling
                          ? t("slideshow.link.stopping", "Stopping…")
                          : t("slideshow.link.stopAll", "Stop everything")}
                      </Button>
                    ) : (
                      <>
                        <Button
                          onClick={() => handleDownloadLinks(false)}
                          variant="outline"
                          size="sm"
                          className="gap-1.5"
                        >
                          <Download className="size-4" />
                          {t("slideshow.link.download", "Download")}
                        </Button>
                        <Button
                          onClick={() => handleDownloadLinks(true)}
                          disabled={!isConnected}
                          size="sm"
                          title={
                            isConnected
                              ? undefined
                              : t("slideshow.connectResolve", "Connect an editor timeline to add.")
                          }
                          className="gap-1.5"
                        >
                          <Play className="size-4" />
                          {t("slideshow.link.downloadPlace", "Download + place")}
                        </Button>
                      </>
                    )}
                  </div>
                  {/* One row per link in flight — up to DOWNLOAD_CONCURRENCY of
                      them, listed in the order they were pasted. */}
                  {downloading && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                        <span>
                          {t("slideshow.link.progress", "Downloading {{n}} at a time", {
                            n: DOWNLOAD_CONCURRENCY,
                          })}
                        </span>
                        <span className="shrink-0 tabular-nums">
                          {dlDone}/{dlTotal}
                        </span>
                      </div>
                      {dlActive.map((row) => (
                        <div key={row.jobId} className="space-y-1">
                          <Progress value={row.percent ?? undefined} />
                          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                            <span className="min-w-0 truncate">{row.label}</span>
                            <span className="shrink-0 tabular-nums">
                              {row.percent != null ? `${Math.round(row.percent)}%` : "…"}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="max-h-[320px] space-y-2 overflow-y-auto pr-1">
              {media.map((m, i) => {
                  const span = spanByLine.get(i)
                  return (
                    <div key={m.id} className="rounded-2xl border bg-card p-2.5 flex items-center gap-3">
                      <div className="flex flex-col items-center gap-1 pt-0.5">
                        <span className="text-xs font-mono text-muted-foreground w-5 text-center">
                          {i + 1}
                        </span>
                        <div className="flex flex-col">
                          <button
                            className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                            onClick={() => move(i, -1)}
                            disabled={i === 0}
                            aria-label={t("slideshow.moveUp", "Move up")}
                          >
                            <ArrowUp className="size-3.5" />
                          </button>
                          <button
                            className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                            onClick={() => move(i, 1)}
                            disabled={i === media.length - 1}
                            aria-label={t("slideshow.moveDown", "Move down")}
                          >
                            <ArrowDown className="size-3.5" />
                          </button>
                        </div>
                      </div>
                      <div className="size-9 rounded-md bg-muted flex items-center justify-center shrink-0 mt-0.5">
                        {m.kind === "image" ? (
                          <ImageIcon className="size-4.5 text-muted-foreground" />
                        ) : (
                          <Film className="size-4.5 text-muted-foreground" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <div className="flex min-w-0 max-w-[45%] shrink-0 flex-col">
                            <div className="flex min-w-0 items-baseline gap-1.5">
                              <span className="truncate text-sm font-medium" title={m.path}>
                                {m.name}
                              </span>
                              {m.info && (m.info.durationSecs != null || (m.info.width && m.info.height)) && (
                                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                                  {m.info.durationSecs != null ? formatSecs(m.info.durationSecs) : null}
                                  {m.info.durationSecs != null && m.info.width && m.info.height ? " · " : null}
                                  {m.info.width && m.info.height ? `${m.info.width}×${m.info.height}` : null}
                                </span>
                              )}
                            </div>
                            {/* Only rendered for clips the user asked to cut, so
                                a plain import keeps its single-line row. */}
                            {rangeLabel(m) && (
                              <span className="flex items-center gap-1 font-mono text-[11px] text-primary">
                                <Scissors className="size-3" />
                                {rangeLabel(m)}
                              </span>
                            )}
                          </div>
                          <Input
                            value={m.text}
                            onChange={(e) => setText(m.id, e.target.value)}
                            placeholder={t("slideshow.linePlaceholder", "Sentence spoken while this shows…")}
                            className="h-8 min-w-0 flex-1 text-xs"
                          />
                        </div>
                        {span && (
                          <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                            <span className="font-mono">
                              {formatSecs(span.start)} → {formatSecs(span.end)}
                            </span>
                            <span>({(span.end - span.start).toFixed(1)}s)</span>
                            {span.approximate ? (
                              <Badge variant="outline" className="h-4 px-1 text-[10px] text-amber-600 border-amber-300">
                                {t("slideshow.approx", "estimated")}
                              </Badge>
                            ) : span.confidence < 0.5 ? (
                              <Badge variant="outline" className="h-4 px-1 text-[10px] text-amber-600 border-amber-300">
                                {t("slideshow.lowMatch", "low match")}
                              </Badge>
                            ) : null}
                          </div>
                        )}
                      </div>
                      <button
                        className="text-muted-foreground hover:text-destructive shrink-0 mt-0.5"
                        onClick={() => remove(m.id)}
                        aria-label={t("common.remove", "Remove")}
                      >
                        <X className="size-4" />
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>

            {media.length > 0 && (
              <div className="mt-3 flex items-center justify-end gap-3">
                <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                  {isConnected
                    ? t("slideshow.willStitch", "Sequential — {{s}}s each", { s: secsPerImage })
                    : t("slideshow.connectResolve", "Connect a Resolve timeline to add.")}
                </span>
                <Button
                  variant="outline"
                  onClick={handleAddMedia}
                  disabled={!isConnected || addingMedia}
                  className="shrink-0 gap-1.5"
                >
                  {addingMedia ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Play className="size-4" />
                  )}
                  {t("slideshow.addMedia", "Add to timeline")}
                  {mediaAddCount > 0 ? ` (${mediaAddCount})` : ""}
                </Button>
              </div>
            )}
          </section>

          {/* Step 2 — script */}
          <section>
            <div className="flex items-center justify-between gap-2 mb-1">
              <h3 className="text-sm font-semibold">
                {t("slideshow.scriptTitle", "2. Script (optional)")}
              </h3>
              <Button size="sm" variant="outline" onClick={handleImportScript} disabled={media.length === 0} className="gap-1.5">
                <FileText className="size-4" />
                {t("slideshow.importScript", "Load .txt")}
              </Button>
            </div>
          </section>

          {/* Step 3 — voice (optional). Pick a source, then transcribe. Skip
              it entirely to just stitch the media into a video. */}
          <section>
            <h3 className="text-sm font-semibold mb-2">
              {t("slideshow.voiceTitle", "3. Voice (optional)")}
            </h3>

            {/* Choose a source: a file, or (when connected) a timeline track. */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={handlePickVoiceFile}
                disabled={transcribing}
                className={cn(
                  "flex items-center gap-2.5 rounded-2xl border px-3 py-2.5 text-left transition-colors disabled:opacity-60",
                  voiceSource?.kind === "file" ? "bg-card shadow-sm" : "hover:bg-muted/50",
                )}
              >
                <FileAudio className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">
                    {t("slideshow.voiceFile", "Voice file")}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {voiceSource?.kind === "file"
                      ? voiceSource.name
                      : t("slideshow.voiceFilePick", "Choose an audio or video file")}
                  </span>
                </span>
              </button>

              {isConnected && audioTracks.length > 0 ? (
                <TrackCard
                  mode="single"
                  kind="audio"
                  title={t("slideshow.voiceTrack", "Timeline audio track")}
                  tracks={audioTracks}
                  value={voiceSource?.kind === "track" ? [voiceSource.value] : []}
                  onChange={(v) => {
                    const value = v[0]
                    if (!value) return
                    const label = audioTracks.find((tr) => tr.value === value)?.label ?? "Track"
                    setVoiceSource({ kind: "track", value, name: label })
                    setVoiceWords(null)
                  }}
                  emptyLabel={t("modePicker.autoedit.options.noAudioTracks")}
                  disabled={transcribing}
                />
              ) : (
                <div className="flex items-center rounded-2xl border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
                  {t("slideshow.voiceTrackConnect", "Connect Resolve to use a timeline track")}
                </div>
              )}
            </div>

            {/* Transcribe the chosen source (or show the result). */}
            <div className="mt-3 flex items-center gap-3">
              <Button
                onClick={handleTranscribe}
                disabled={!voiceSource || transcribing}
                className="gap-1.5"
              >
                {transcribing ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <AudioLines className="size-4" />
                )}
                {transcribing
                  ? t("slideshow.transcribing", "Transcribing…")
                  : t("slideshow.transcribe", "Transcribe voice")}
              </Button>
              <span className="min-w-0 flex-1 truncate text-xs">
                {hasVoice ? (
                  <span className="text-green-600 dark:text-green-400">
                    {t("slideshow.voiceReady", "Ready")}
                    {voiceLabel ? ` — ${voiceLabel}` : ""}{" "}
                    ({words.length} {t("slideshow.words", "words")})
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    {t("slideshow.voiceNotYet", "No voice transcribed yet")}
                  </span>
                )}
              </span>
              {/* Add just the audio file onto the timeline (a track source is
                  already there, so it's only offered for a picked file). */}
              {voiceFilePath && (
                <Button
                  variant="outline"
                  onClick={handleAddAudio}
                  disabled={!isConnected || addingAudio}
                  className="shrink-0 gap-1.5"
                >
                  {addingAudio ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Play className="size-4" />
                  )}
                  {t("slideshow.addAudio", "Add to timeline")}
                  {audioAddCount > 0 ? ` (${audioAddCount})` : ""}
                </Button>
              )}
            </div>
          </section>

          {/* Which video track the media lands on. */}
          {isConnected && videoTrackOptions.length > 0 && (
            <section>
              <TrackCard
                mode="single"
                kind="video"
                title={t("slideshow.targetTrack", "Place on video track")}
                tracks={videoTrackOptions}
                value={videoTargetVal ? [videoTargetVal] : []}
                onChange={(v) => setVideoTargetVal(v[0] ?? "")}
                emptyLabel={t("modePicker.autoedit.options.noVideoTracks")}
              />
            </section>
          )}

        </div>

        {/* The main action: cut the media to the voice and place it on the
            Resolve timeline. Needs both a transcript and per-media sentences;
            the plain "add" buttons above cover everything else. */}
        <div className="mt-6 flex flex-col gap-2 border-t pt-4">
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 flex-1 text-xs text-muted-foreground">
              {!isConnected
                ? t("slideshow.connectResolve", "Connect a Resolve timeline to add.")
                : media.length === 0
                  ? t("slideshow.cutNeedsMedia", "Add media first.")
                  : spans.length > 0
                    ? t("slideshow.willSync", "Synced to voice ({{n}})", { n: spans.length })
                    : !hasVoice
                      ? t("slideshow.cutNeedsVoice", "Transcribe a voice to cut against.")
                      : t("slideshow.cutNeedsScript", "Write a sentence under each media.")}
            </span>
            <Button
              onClick={handleCutSync}
              disabled={!isConnected || cutting || spans.length === 0}
              className="shrink-0 gap-1.5"
            >
              {cutting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Scissors className="size-4" />
              )}
              {t("slideshow.cutSync", "Cut & sync to timeline")}
            </Button>
          </div>
        </div>
    </div>
  )
}
