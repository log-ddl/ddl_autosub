import * as React from "react"
import { useTranslation } from "react-i18next"
import { check, type Update } from "@tauri-apps/plugin-updater"
import { relaunch } from "@tauri-apps/plugin-process"
import { getVersion } from "@tauri-apps/api/app"
import { ArrowUpCircle, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"

/**
 * Blocks the whole app when a newer release exists, and installs it in place.
 *
 * The update is mandatory by design: there is no "later" button, because a user
 * left on an old build hits failures we have already fixed and has no way to
 * know why. Everything happens inside the app — download, install, relaunch —
 * so nobody has to visit GitHub.
 *
 * A failed *check* is not a failure: if GitHub is unreachable the app opens
 * normally, since being offline must not lock someone out of their own editor.
 * Only a failed *install* shows an escape hatch, so a broken release can't
 * strand them either.
 */

type Phase = "checking" | "clear" | "available" | "downloading" | "installing" | "failed"

export function AppUpdateGate({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  const [phase, setPhase] = React.useState<Phase>("checking")
  const [update, setUpdate] = React.useState<Update | null>(null)
  const [currentVersion, setCurrentVersion] = React.useState("")
  const [percent, setPercent] = React.useState<number | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [overridden, setOverridden] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const version = await getVersion()
        if (!cancelled) setCurrentVersion(version)
        const found = await check()
        if (cancelled) return
        if (found) {
          setUpdate(found)
          setPhase("available")
        } else {
          setPhase("clear")
        }
      } catch {
        // Offline, rate-limited, no release published yet — carry on.
        if (!cancelled) setPhase("clear")
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const install = async () => {
    if (!update) return
    setError(null)
    setPhase("downloading")
    try {
      let total = 0
      let received = 0
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0
          setPercent(total > 0 ? 0 : null)
        } else if (event.event === "Progress") {
          received += event.data.chunkLength
          if (total > 0) setPercent(Math.min(100, (received / total) * 100))
        } else if (event.event === "Finished") {
          setPercent(100)
          setPhase("installing")
        }
      })
      await relaunch()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase("failed")
    }
  }

  if (phase === "clear" || overridden) return <>{children}</>

  if (phase === "checking") {
    return (
      <div className="flex h-screen items-center justify-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        {t("appUpdate.checking", "Checking for updates…")}
      </div>
    )
  }

  const busy = phase === "downloading" || phase === "installing"

  return (
    <div className="flex h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-3">
          <ArrowUpCircle className="size-6 shrink-0 text-primary" />
          <div className="min-w-0">
            <h1 className="text-base font-semibold">
              {t("appUpdate.title", "A new version is available")}
            </h1>
            <p className="text-xs text-muted-foreground">
              {currentVersion} → {update?.version}
            </p>
          </div>
        </div>

        <p className="mt-4 text-sm text-muted-foreground">
          {t(
            "appUpdate.body",
            "This update installs itself and restarts AutoSubs. It only takes a moment.",
          )}
        </p>

        {update?.body && (
          <pre className="mt-3 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-2 text-[11px] text-muted-foreground">
            {update.body}
          </pre>
        )}

        {busy && (
          <div className="mt-4 space-y-1.5">
            <Progress value={percent ?? undefined} />
            <p className="text-[11px] text-muted-foreground">
              {phase === "installing"
                ? t("appUpdate.installing", "Installing, the app will restart…")
                : t("appUpdate.downloading", "Downloading…")}
              {percent != null && phase === "downloading" ? ` ${Math.round(percent)}%` : ""}
            </p>
          </div>
        )}

        {error && (
          <p className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
            {error}
          </p>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button onClick={() => void install()} disabled={busy} className="gap-2">
            {busy ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />}
            {t("appUpdate.action", "Update and restart")}
          </Button>
          {/* Only after an install has actually failed — the gate is otherwise
              not skippable. */}
          {phase === "failed" && (
            <Button variant="ghost" size="sm" onClick={() => setOverridden(true)}>
              {t("appUpdate.skip", "Continue on this version")}
            </Button>
          )}
        </div>

      </div>
    </div>
  )
}
