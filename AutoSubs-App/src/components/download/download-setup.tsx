import * as React from "react"
import { useTranslation } from "react-i18next"
import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Download } from "lucide-react"

interface SetupProgress {
  label: string
  ratio: number | null
  bytes: number
  total: number | null
}

interface SetupDone {
  ok: boolean
  error: string | null
}

interface DownloadStatus {
  installed: boolean
  installing: boolean
}

const EVENT_PROGRESS = "media-download-setup-progress"
const EVENT_DONE = "media-download-setup-done"

function formatMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1) + " MB"
}

// Blocks the Download workspace behind the one-time yt-dlp + Deno install. On
// first entry it kicks off the download and streams progress; once the tools
// are present it renders children immediately.
export function DownloadSetup({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  const [status, setStatus] = React.useState<
    "checking" | "installing" | "ready" | "error"
  >("checking")
  const [progress, setProgress] = React.useState<SetupProgress | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const startInstall = React.useCallback(async () => {
    setError(null)
    setProgress(null)
    setStatus("installing")
    try {
      await invoke("media_download_install")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStatus("error")
    }
  }, [])

  React.useEffect(() => {
    let cancelled = false
    let unlistenProgress: UnlistenFn | null = null
    let unlistenDone: UnlistenFn | null = null

    ;(async () => {
      unlistenProgress = await listen<SetupProgress>(EVENT_PROGRESS, (e) => {
        if (!cancelled) setProgress(e.payload)
      })
      unlistenDone = await listen<SetupDone>(EVENT_DONE, (e) => {
        if (cancelled) return
        if (e.payload.ok) {
          setStatus("ready")
        } else {
          setError(e.payload.error ?? "Unknown error")
          setStatus("error")
        }
      })

      const initial = await invoke<DownloadStatus>("media_download_status")
      if (cancelled) return
      if (initial.installed) {
        setStatus("ready")
        return
      }
      await startInstall()
    })().catch((err) => {
      if (cancelled) return
      setError(err instanceof Error ? err.message : String(err))
      setStatus("error")
    })

    return () => {
      cancelled = true
      unlistenProgress?.()
      unlistenDone?.()
    }
  }, [startInstall])

  if (status === "ready") {
    return <>{children}</>
  }

  const ratio =
    progress?.ratio != null ? Math.max(0, Math.min(1, progress.ratio)) : null
  const pctValue = ratio != null ? Math.round(ratio * 100) : undefined

  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-5 flex size-16 items-center justify-center rounded-xl bg-muted">
          <Download className="size-7 text-muted-foreground" />
        </div>
        <h2 className="text-lg font-semibold">
          {t("download.setup.title", "Setting up the downloader")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            "download.setup.subtitle",
            "A one-time download of yt-dlp and a small JavaScript runtime so every video can be fetched.",
          )}
        </p>

        {status === "error" ? (
          <div className="mt-6">
            <p className="mb-4 text-sm text-destructive break-words">{error}</p>
            <Button onClick={startInstall}>
              {t("download.setup.retry", "Try again")}
            </Button>
          </div>
        ) : (
          <div className="mt-6">
            <Progress value={pctValue} className="h-2" />
            <p className="mt-2 text-xs text-muted-foreground">
              {progress
                ? `${progress.label} — ${formatMB(progress.bytes)}${
                    progress.total ? ` / ${formatMB(progress.total)}` : ""
                  }`
                : t("download.setup.starting", "Starting…")}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
