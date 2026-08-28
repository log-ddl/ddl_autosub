import * as React from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { revealItemInDir } from "@tauri-apps/plugin-opener"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { CheckCircle2, Download, FileText, FolderOpen, X } from "lucide-react"

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

interface DownloadProgress {
  jobId: string
  stage: "downloading" | "processing" | "done" | "error"
  percent: number | null
  message: string
}

interface DownloadResult {
  success: boolean
  canceled: boolean
  filePath: string | null
  error: string | null
}

const EVENT_PROGRESS = "media-download-progress"
const LAST_DIR_KEY = "autosubs.download.lastDir"

// The Download workspace body (rendered once the tools are installed). Paste a
// URL, optionally trim, pick a folder, then download the best-quality MP4 in one
// click — no separate analyze step.
export function DownloadPanel() {
  const { t } = useTranslation()
  const [url, setUrl] = React.useState("")
  const [outputDir, setOutputDir] = React.useState<string>(
    () => localStorage.getItem(LAST_DIR_KEY) ?? "",
  )
  const [startTime, setStartTime] = React.useState("")
  const [endTime, setEndTime] = React.useState("")
  const [batchFile, setBatchFile] = React.useState<string | null>(null)
  const [downloading, setDownloading] = React.useState(false)
  const [progress, setProgress] = React.useState<DownloadProgress | null>(null)
  const [donePath, setDonePath] = React.useState<string | null>(null)
  const jobIdRef = React.useRef<string>("")

  const pickFolder = React.useCallback(async () => {
    const picked = await openDialog({ directory: true, multiple: false })
    if (typeof picked === "string") {
      setOutputDir(picked)
      localStorage.setItem(LAST_DIR_KEY, picked)
    }
    return typeof picked === "string" ? picked : null
  }, [])

  const pickBatchFile = React.useCallback(async () => {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "Text", extensions: ["txt"] }],
    })
    if (typeof picked === "string") setBatchFile(picked)
  }, [])

  const startDownload = React.useCallback(async () => {
    if (downloading) return
    const trimmed = url.trim()
    if (!trimmed && !batchFile) {
      toast.error(t("download.error.noUrl", "Paste a video link first"))
      return
    }
    let dir = outputDir
    if (!dir) {
      dir = (await pickFolder()) ?? ""
      if (!dir) return
    }
    const jobId = crypto.randomUUID()
    jobIdRef.current = jobId
    setDownloading(true)
    setProgress(null)
    setDonePath(null)
    try {
      const result = await invoke<DownloadResult>("media_download_start", {
        request: batchFile
          ? { jobId, batchFile, outputDirectory: dir }
          : {
              jobId,
              url: trimmed,
              outputDirectory: dir,
              startTime: startTime.trim() || null,
              endTime: endTime.trim() || null,
            },
      })
      if (result.canceled) {
        toast.info(t("download.canceled", "Download canceled"))
      } else if (result.success) {
        setDonePath(result.filePath)
        toast.success(t("download.done", "Download complete"))
      } else {
        toast.error(t("download.error.failed", "Download failed"), {
          description: result.error ?? undefined,
        })
      }
    } catch (err) {
      toast.error(t("download.error.failed", "Download failed"), {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setDownloading(false)
      setProgress(null)
    }
  }, [downloading, url, batchFile, outputDir, startTime, endTime, pickFolder, t])

  const cancel = React.useCallback(async () => {
    if (jobIdRef.current) {
      await invoke("media_download_cancel", { jobId: jobIdRef.current })
    }
  }, [])

  // Listen for progress on the active job only.
  React.useEffect(() => {
    let unlisten: UnlistenFn | null = null
    ;(async () => {
      unlisten = await listen<DownloadProgress>(EVENT_PROGRESS, (e) => {
        if (e.payload.jobId === jobIdRef.current) setProgress(e.payload)
      })
    })()
    return () => {
      unlisten?.()
    }
  }, [])

  const pctValue =
    progress?.percent != null ? Math.round(progress.percent) : undefined
  const stageLabel =
    progress?.stage === "processing"
      ? t("download.stage.processing", "Merging video and audio…")
      : t("download.stage.downloading", "Downloading…")

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">
          {t("download.title", "Download video")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("download.subtitle", "Paste a video link and save an MP4.")}
        </p>
      </div>

      {/* URL */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="download-url" className="text-xs">
          {t("download.urlLabel", "Video URL")}
        </Label>
        <Input
          id="download-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void startDownload()
          }}
          placeholder="https://www.youtube.com/watch?v=…"
          className="h-10"
          disabled={downloading}
        />
      </div>

      {/* Save to */}
      <div className="mt-4 flex flex-col gap-1.5">
        <Label className="text-xs">{t("download.folder", "Save to")}</Label>
        <Button
          variant="outline"
          onClick={() => void pickFolder()}
          disabled={downloading}
          className="h-10 justify-start gap-2 font-normal"
        >
          <FolderOpen className="size-4 shrink-0" />
          <span className="truncate">
            {outputDir || t("download.chooseFolder", "Choose a folder…")}
          </span>
        </Button>
      </div>

      {/* Optional trim */}
      <div className="mt-4 flex flex-col gap-1.5">
        <Label className="text-xs">
          {t("download.trim", "Trim (optional)")}
        </Label>
        <div className="flex items-center gap-2">
          <Input
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            placeholder={t("download.from", "From (e.g. 0:30)")}
            className="h-10"
            disabled={downloading}
          />
          <span className="text-muted-foreground">→</span>
          <Input
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            placeholder={t("download.to", "To (e.g. 1:20)")}
            className="h-10"
            disabled={downloading}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {t(
            "download.trimHint",
            "Leave both empty to download the whole video.",
          )}
        </p>
      </div>

      {/* Batch from a .txt of URLs */}
      <div className="mt-4 flex flex-col gap-1.5">
        <Label className="text-xs">
          {t("download.batch", "Batch download (.txt, one URL per line)")}
        </Label>
        {batchFile ? (
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 h-10">
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm">{baseName(batchFile)}</span>
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto size-6 shrink-0"
              onClick={() => setBatchFile(null)}
              disabled={downloading}
            >
              <X className="size-4" />
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            onClick={() => void pickBatchFile()}
            disabled={downloading}
            className="h-10 justify-start gap-2 font-normal"
          >
            <FileText className="size-4 shrink-0" />
            {t("download.pickBatch", "Choose a .txt file…")}
          </Button>
        )}
        {batchFile && (
          <p className="text-xs text-muted-foreground">
            {t(
              "download.batchHint",
              "Every link in the file downloads at best quality. The single URL and trim above are ignored.",
            )}
          </p>
        )}
      </div>

      {/* Action / progress */}
      <div className="mt-6">
        {downloading ? (
          <div>
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner className="size-4" />
                {stageLabel}
                {pctValue != null ? ` ${pctValue}%` : ""}
              </span>
              <Button variant="ghost" size="sm" onClick={() => void cancel()}>
                <X className="size-4" />
                {t("download.cancel", "Cancel")}
              </Button>
            </div>
            <Progress value={pctValue} className="mt-2 h-2" />
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <Button
              onClick={() => void startDownload()}
              disabled={!url.trim() && !batchFile}
              className="w-full gap-2"
              size="lg"
            >
              <Download className="size-4" />
              {t("download.start", "Download")}
            </Button>
            {donePath && (
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-sm text-green-600 dark:text-green-500">
                  <CheckCircle2 className="size-4" />
                  {t("download.savedTo", "Saved")}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void revealItemInDir(donePath)}
                >
                  <FolderOpen className="size-4" />
                  {t("download.showInFolder", "Show in folder")}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
