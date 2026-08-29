import * as React from "react"
import { useTranslation } from "react-i18next"
import { invoke } from "@tauri-apps/api/core"
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

/**
 * Blocks the Download workspace while yt-dlp is out of date.
 *
 * YouTube changes how it serves video every few months; yt-dlp follows within
 * days. An outdated copy doesn't warn — downloads simply start failing with
 * opaque extractor errors — so the check happens up front and the user is asked
 * to update before they hit that wall.
 *
 * The gate only closes on a *confirmed* update: if the version check can't run
 * (offline, GitHub rate-limited) the workspace opens as normal, because the
 * installed binary still works and a network hiccup must not lock the feature.
 */

interface VersionCheck {
  current: string
  latest: string | null
  updateAvailable: boolean
  error: string | null
}

export function DownloadUpdateGate({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  const [check, setCheck] = React.useState<VersionCheck | null>(null)
  const [checking, setChecking] = React.useState(true)
  const [updating, setUpdating] = React.useState(false)
  const [failed, setFailed] = React.useState<string | null>(null)
  // Set once an update fails, so a broken GitHub can't strand the user with a
  // workspace they can never open.
  const [overridden, setOverridden] = React.useState(false)

  const runCheck = React.useCallback(async () => {
    setChecking(true)
    try {
      setCheck(await invoke<VersionCheck>("media_download_version_check"))
    } catch {
      // The command itself failing is treated like an unavailable check.
      setCheck(null)
    } finally {
      setChecking(false)
    }
  }, [])

  React.useEffect(() => {
    void runCheck()
  }, [runCheck])

  const handleUpdate = async () => {
    setUpdating(true)
    setFailed(null)
    try {
      await invoke<string>("media_download_update")
      await runCheck()
    } catch (err) {
      setFailed(err instanceof Error ? err.message : String(err))
    } finally {
      setUpdating(false)
    }
  }

  if (checking) {
    return (
      <div className="mx-auto flex w-full max-w-2xl items-center gap-2 py-10 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        {t("download.update.checking", "Checking the downloader for updates…")}
      </div>
    )
  }

  if (!check?.updateAvailable || overridden) {
    return (
      <>
        {children}
        {check?.current && !check.error && (
          <div className="mx-auto mt-6 w-full max-w-2xl">
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <CheckCircle2 className="size-3.5 text-green-600 dark:text-green-500" />
              {t("download.update.current", "Downloader is up to date ({{version}})", {
                version: check.current,
              })}
            </p>
          </div>
        )}
      </>
    )
  }

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div className="rounded-2xl border border-amber-500/40 bg-amber-500/5 p-5">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-500" />
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">
              {t("download.update.title", "The downloader needs updating")}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t(
                "download.update.body",
                "YouTube changes how it serves video every few months. An out-of-date downloader stops working without a clear reason, so update it before downloading.",
              )}
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-md border bg-background px-2 py-1 font-mono">
                {t("download.update.installed", "Installed")}: {check.current || "—"}
              </span>
              <span className="text-muted-foreground">→</span>
              <span className="rounded-md border border-amber-500/40 bg-background px-2 py-1 font-mono">
                {t("download.update.available", "New")}: {check.latest}
              </span>
            </div>

            {failed && (
              <p className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                {failed}
              </p>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button onClick={() => void handleUpdate()} disabled={updating} className="gap-2">
                {updating ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />}
                {updating
                  ? t("download.update.updating", "Updating…")
                  : t("download.update.action", "Update now")}
              </Button>
              {/* Only offered once an update has actually failed — otherwise the
                  gate is not skippable. */}
              {failed && (
                <Button variant="ghost" size="sm" onClick={() => setOverridden(true)}>
                  {t("download.update.skip", "Continue without updating")}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
