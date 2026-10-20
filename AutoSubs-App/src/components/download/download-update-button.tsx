import * as React from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { checkDownloaderVersion, updateDownloader } from "@/api/media-download-api"

/**
 * Small corner button: check yt-dlp against its newest release and update it
 * in one click. The app also updates yt-dlp quietly in the background once a
 * day, so this is for when a download fails right after YouTube changed
 * something, not a step before every download.
 */
export function DownloadUpdateButton() {
  const { t } = useTranslation()
  const [busy, setBusy] = React.useState(false)

  const run = async () => {
    setBusy(true)
    const id = toast.loading(t("download.update.checking", "Checking the downloader for updates…"))
    try {
      const check = await checkDownloaderVersion()
      if (check.error && !check.updateAvailable) {
        toast.error(t("download.update.checkFailed", "Could not check for updates"), {
          id,
          description: check.error,
        })
        return
      }
      if (!check.updateAvailable) {
        toast.success(
          t("download.update.current", "Downloader is up to date ({{version}})", { version: check.current }),
          { id },
        )
        return
      }
      toast.loading(t("download.update.updating", "Updating…"), { id })
      await updateDownloader()
      const after = await checkDownloaderVersion()
      toast.success(
        t("download.update.updated", "Downloader updated to {{version}}", { version: after.current }),
        { id },
      )
    } catch (err) {
      toast.error(t("download.update.failed", "Could not update the downloader"), {
        id,
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-muted-foreground"
          onClick={() => void run()}
          disabled={busy}
          aria-label={t("download.update.check", "Check for downloader updates")}
        >
          <RefreshCw className={busy ? "size-4 animate-spin" : "size-4"} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t("download.update.check", "Check for downloader updates")}</TooltipContent>
    </Tooltip>
  )
}
