import * as React from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
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
import {
  DOWNLOAD_DIR_KEY,
  entryKey,
  formatClock,
  formatSecs,
  nextMediaId,
  parseTimecode,
  pickAndReadScriptLines,
  pickAndScanMediaFiles,
  pickAndScanMediaFolder,
  pickDownloadFolder,
  pickVoiceFile,
  placedKey,
  probeMediaInfo,
  sortEntries,
  trimHint,
  type MediaEntry,
  type MediaFileInfo,
  type SortMode,
  type VoiceSource,
} from "@/lib/media-import"
import {
  cancelDownload,
  DOWNLOAD_CONCURRENCY,
  downloadToolsReady,
  groupDownloadJobs,
  parseBatchLinkJobs,
  runBatchDownloads,
  type DownloadRow,
} from "@/lib/batch-downloader"
import {
  buildSequentialItems,
  buildSyncedItems,
  type BuildItem,
} from "@/lib/timeline-actions"
import {
  alignScriptToWords,
  flattenWords,
  transcribeVoiceSource,
  useVoiceTranscriber,
  type AlignedSpan,
  type TimedWord,
} from "@/lib/voice-pipeline"
import { TrackCard } from "@/components/autoedit/track-card"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import type { Track } from "@/types"

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

  // Clips already in the list, by `entryKey`. Mirrors `media`, but readable
  // synchronously so a batch of downloads can dedupe itself without waiting for
  // a re-render.
  const knownKeysRef = React.useRef<Set<string>>(new Set())
  React.useEffect(() => {
    knownKeysRef.current = new Set(media.map(entryKey))
  }, [media])

  // What this session has already pushed to the timeline, by `placedKey`.
  const placedKeysRef = React.useRef<Set<string>>(new Set())

  const audioTracks = timelineInfo.inputTracks ?? []

  const docWords = React.useMemo(() => flattenWords(subtitles), [subtitles])
  const words = voiceWords ?? docWords
  const hasVoice = words.length > 0
  const voiceLabel = voiceWords ? voiceName : currentSubtitleDocumentSourceName

  // The video tracks we can drop onto.
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

  // Live alignment, recomputed as media/text/voice change.
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
        const seen = new Set(prev.map(entryKey))
        return [
          ...prev,
          ...ordered
            .filter((x) => !seen.has(entryKey({ path: x.path })))
            .map<MediaEntry>((x) => ({
              id: nextMediaId(),
              path: x.path,
              name: x.name,
              kind: x.kind,
              createdMs: x.createdMs,
              text: "",
            })),
        ]
      })
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
    const infos = await pickAndScanMediaFiles()
    if (infos) addInfos(infos)
  }

  const handleImportFolder = async () => {
    const infos = await pickAndScanMediaFolder()
    if (infos) addInfos(infos)
  }

  // Commit a batch of downloaded entries, already in pasted order. Returns the
  // ones that were actually new, so the caller places exactly what it added.
  const commitDownloaded = React.useCallback((entries: MediaEntry[]): MediaEntry[] => {
    if (entries.length === 0) return []
    const fresh: MediaEntry[] = []
    for (const entry of entries) {
      const key = entryKey(entry)
      if (knownKeysRef.current.has(key)) continue
      knownKeysRef.current.add(key)
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
    const picked = await pickDownloadFolder()
    if (picked) setLinkDir(picked)
    return picked
  }

  const handleDownloadLinks = async (autoPlace = false) => {
    if (downloading) return
    const jobs = parseBatchLinkJobs(linkUrls, linkFrom, linkTo)
    if (jobs.length === 0) {
      toast.error(t("slideshow.link.noUrl", "Paste at least one link."))
      return
    }
    const tasks = groupDownloadJobs(jobs)
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
    setDlTotal(tasks.length)
    setDlDone(0)
    setDlActive([])
    let ok = 0
    let placedAny = false
    let placeCursor = 0
    try {
      await runBatchDownloads({
        tasks,
        dir,
        trimMode: linkTrim,
        concurrency: DOWNLOAD_CONCURRENCY,
        activeJobIds: dlJobsRef.current,
        isCancelled: () => dlCancelRef.current,
        onActiveRowsChange: setDlActive,
        onTaskProgress: (jobId, percent) => {
          setDlActive((rows) =>
            rows.map((r) => (r.jobId === jobId ? { ...r, percent } : r)),
          )
        },
        onTaskDone: () => setDlDone((n) => n + 1),
        onTaskError: (url, errorMessage) => {
          toast.error(t("slideshow.link.failed", "Could not download {{url}}", { url }), {
            description: errorMessage,
          })
        },
        onChunkEntries: async (orderedEntries) => {
          const fresh = commitDownloaded(orderedEntries)
          ok += fresh.length
          if (canPlace && fresh.length > 0 && !dlCancelRef.current) {
            const items = buildSequentialItems(fresh, secsPerImage, placeCursor)
            placeCursor = items[items.length - 1]?.end ?? placeCursor
            await runBuild({
              items,
              setBusy: setAddingMedia,
              onSuccess: () => {
                placedAny = true
              },
              quiet: true,
            })
          }
        },
      })
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
    const gone = media.find((m) => m.id === id)
    if (gone) placedKeysRef.current.delete(placedKey(gone))
    setMedia((prev) => prev.filter((m) => m.id !== id))
  }

  const setText = (id: string, text: string) => {
    setMedia((prev) => prev.map((m) => (m.id === id ? { ...m, text } : m)))
  }

  const [trimDrafts, setTrimDrafts] = React.useState<
    Record<string, { from: string; to: string }>
  >({})

  const trimDraftFor = (m: MediaEntry): { from: string; to: string } =>
    trimDrafts[m.id] ?? {
      from: m.srcIn != null ? formatClock(m.srcIn) : "",
      to: m.srcOut != null ? formatClock(m.srcOut) : "",
    }

  const applyTrim = (id: string, draft: { from: string; to: string }) => {
    const from = draft.from.trim() === "" ? undefined : parseTimecode(draft.from) ?? undefined
    let to = draft.to.trim() === "" ? undefined : parseTimecode(draft.to) ?? undefined
    if (to != null && from != null && to <= from) to = undefined
    setMedia((prev) => prev.map((m) => (m.id === id ? { ...m, srcIn: from, srcOut: to } : m)))
  }

  const setTrimField = (id: string, field: "from" | "to", raw: string) => {
    const current = media.find((m) => m.id === id)
    const base = current ? trimDraftFor(current) : { from: "", to: "" }
    const draft = { ...base, [field]: raw }
    setTrimDrafts((prev) => ({ ...prev, [id]: draft }))
    applyTrim(id, draft)
  }

  // Load a .txt where line N is the sentence for media N (blank lines allowed).
  const handleImportScript = async () => {
    try {
      const lines = await pickAndReadScriptLines()
      if (!lines) return
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

  // Pick a voice file — nothing heavy happens yet, just remember the choice.
  const handlePickVoiceFile = async () => {
    const picked = await pickVoiceFile()
    if (!picked) return
    setVoiceSource(picked)
    setVoiceWords(null)
  }

  // Run transcription on the chosen source.
  const handleTranscribe = async () => {
    if (!voiceSource || transcribing) return
    setTranscribing(true)
    try {
      const res = await transcribeVoiceSource(voiceSource, transcribe, getSourceAudio)
      if (!res) return
      if (res.words.length === 0) {
        toast.error(t("slideshow.voiceEmpty", "No speech was found in that file."))
        return
      }
      setVoiceWords(res.words)
      setVoiceName(res.name)
      toast.success(t("slideshow.voiceDone", "Transcribed {{n}} words.", { n: res.words.length }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error("Transcription failed:", err)
      toast.error(message)
    } finally {
      setTranscribing(false)
    }
  }

  const voiceFilePath = voiceSource?.kind === "file" ? voiceSource.path : null

  const runBuild = (opts: {
    items: BuildItem[]
    audioPath?: string
    setBusy: (b: boolean) => void
    onSuccess: () => void
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
        if (opts.items.length > 0 && res.appended === 0) {
          toast.warning(res.lines[0] ?? "Nothing was placed on the timeline.")
        } else {
          for (const it of opts.items) placedKeysRef.current.add(placedKey(it))
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

  const handleAddMedia = (all = false) => {
    if (media.length === 0) return
    const pending = all
      ? media
      : media.filter((m) => !placedKeysRef.current.has(placedKey(m)))
    if (pending.length === 0) {
      toast.info(
        t("slideshow.allPlaced", "Every clip is already on the timeline."),
        {
          action: {
            label: t("slideshow.placeAgain", "Place all again"),
            onClick: () => handleAddMedia(true),
          },
        },
      )
      return
    }
    void runBuild({
      items: buildSequentialItems(pending, secsPerImage),
      setBusy: setAddingMedia,
      onSuccess: () => setMediaAddCount((c) => c + 1),
    })
  }

  const handleAddAudio = () => {
    if (!voiceFilePath) return
    void runBuild({
      items: [],
      audioPath: voiceFilePath,
      setBusy: setAddingAudio,
      onSuccess: () => setAudioAddCount((c) => c + 1),
    })
  }

  const handleCutSync = () => {
    if (spans.length === 0) return
    void runBuild({
      items: buildSyncedItems(media, spans),
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
                  const trimDraft = trimDraftFor(m)
                  const trimNote =
                    m.kind === "video" ? trimHint(trimDraft, m.info?.durationSecs) : null
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
                      <div className="min-w-0 flex-1 space-y-1.5">
                        {/* What the file is, and — on the right — which part of
                            it to use. Both describe the clip, so they share a
                            line and leave the sentence below its own full width. */}
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
                          {/* Empty boxes read as "start" and "end", so a clip
                              with one bound filled in says what it does without
                              a sentence of explanation next to it. Stills have
                              no section to take, so they get no boxes. */}
                          {m.kind === "video" && (
                            <span className="ml-auto flex shrink-0 items-center gap-1">
                              <Input
                                value={trimDraft.from}
                                onChange={(e) => setTrimField(m.id, "from", e.target.value)}
                                placeholder={t("slideshow.trimFromShort", "start")}
                                className="h-6 w-16 border-transparent bg-muted/60 px-1 text-center font-mono text-[11px] shadow-none focus-visible:border-input focus-visible:bg-background"
                              />
                              <span className="text-[11px] text-muted-foreground">–</span>
                              <Input
                                value={trimDraft.to}
                                onChange={(e) => setTrimField(m.id, "to", e.target.value)}
                                placeholder={t("slideshow.trimToShort", "end")}
                                className="h-6 w-16 border-transparent bg-muted/60 px-1 text-center font-mono text-[11px] shadow-none focus-visible:border-input focus-visible:bg-background"
                              />
                            </span>
                          )}
                        </div>
                        <Input
                          value={m.text}
                          onChange={(e) => setText(m.id, e.target.value)}
                          placeholder={t("slideshow.linePlaceholder", "Sentence spoken while this shows…")}
                          className="h-8 w-full text-xs"
                        />
                        {trimNote && (
                          <p className="text-[11px] text-amber-600">
                            {trimNote === "badTime"
                              ? t("slideshow.trimBadTime", "Use 0:30, 1:20 or 1:02:03.")
                              : trimNote === "order"
                                ? t("slideshow.trimOrder", "The end has to come after the start.")
                                : t("slideshow.trimPastEnd", "That start is past the end of the clip.")}
                          </p>
                        )}
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
                  onClick={() => handleAddMedia()}
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
