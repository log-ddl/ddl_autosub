import * as React from "react"
import { useTranslation } from "react-i18next"
import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Wand2 } from "lucide-react"
import { useAppModeStore } from "@/stores/app-mode-store"

interface ProgressPayload {
  ratio: number | null
  bytes: number
  total: number | null
  phase: "download" | "extract"
}

interface DonePayload {
  ok: boolean
  error: string | null
}

interface RuntimeStatus {
  installed: boolean
  installing: boolean
  version: string | null
}

const EVENT_PROGRESS = "autoedit-python-progress"
const EVENT_DONE = "autoedit-python-done"

function formatMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1) + " MB"
}

// Blocks the AutoEdit workspace behind the Python runtime install. On first
// entry it kicks off the download and streams progress; subsequent entries
// see the runtime already present and render children immediately.
export function AutoEditPythonSetup({
  children,
}: {
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  const resetMode = useAppModeStore((s) => s.resetMode)
  const [status, setStatus] = React.useState<
    "checking" | "installing" | "ready" | "error"
  >("checking")
  const [progress, setProgress] = React.useState<ProgressPayload | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const startInstall = React.useCallback(async () => {
    setError(null)
    setProgress(null)
    setStatus("installing")
    try {
      await invoke("install_python_runtime")
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setStatus("error")
    }
  }, [])

  // On mount: ask backend whether the runtime is already installed. If yes,
  // render children right away; if no, start the install and listen for
  // progress + completion.
  React.useEffect(() => {
    let cancelled = false
    let unlistenProgress: UnlistenFn | null = null
    let unlistenDone: UnlistenFn | null = null

    ;(async () => {
      unlistenProgress = await listen<ProgressPayload>(EVENT_PROGRESS, (event) => {
        if (cancelled) return
        setProgress(event.payload)
      })
      unlistenDone = await listen<DonePayload>(EVENT_DONE, (event) => {
        if (cancelled) return
        if (event.payload.ok) {
          setStatus("ready")
        } else {
          setError(event.payload.error ?? "Unknown error")
          setStatus("error")
        }
      })

      const initial = await invoke<RuntimeStatus>("python_runtime_status")
      if (cancelled) return
      if (initial.installed) {
        setStatus("ready")
        return
      }
      await startInstall()
    })().catch((err) => {
      if (cancelled) return
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
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
    <div className="flex flex-col h-full bg-background">
      <main className="flex-1 flex items-center justify-center px-6">
        <div className="w-full max-w-md text-center">
          <div className="size-16 rounded-xl bg-muted flex items-center justify-center mb-5 mx-auto">
            <Wand2 className="size-8" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight mb-2">
            {t("modePicker.autoedit.setup.title")}
          </h1>
          <p className="text-sm text-muted-foreground mb-8">
            {t("modePicker.autoedit.setup.description")}
          </p>

          {status === "error" ? (
            <div className="space-y-4">
              <div className="text-sm text-red-500 whitespace-pre-wrap">
                {t("modePicker.autoedit.setup.failed", { message: error ?? "" })}
              </div>
              <div className="flex gap-2 justify-center">
                <Button variant="outline" onClick={resetMode}>
                  {t("modePicker.autoedit.setup.cancel")}
                </Button>
                <Button onClick={startInstall}>
                  {t("modePicker.autoedit.setup.retry")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <Progress value={pctValue ?? 0} />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>
                  {progress?.phase === "extract"
                    ? t("modePicker.autoedit.setup.extracting")
                    : t("modePicker.autoedit.setup.downloading")}
                </span>
                <span>
                  {progress
                    ? `${formatMB(progress.bytes)}${
                        progress.total ? ` / ${formatMB(progress.total)}` : ""
                      }${pctValue != null ? ` · ${pctValue}%` : ""}`
                    : "…"}
                </span>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
