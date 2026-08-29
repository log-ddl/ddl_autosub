import { TooltipProvider } from "@/components/ui/tooltip"
import { DownloadSetup } from "@/components/download/download-setup"
import { DownloadUpdateGate } from "@/components/download/download-update-gate"
import { DownloadPanel } from "@/components/download/download-panel"

/**
 * The "Download" workspace: fetch a video from a URL with yt-dlp. The one-time
 * yt-dlp + Deno install is gated by DownloadSetup; DownloadUpdateGate then keeps
 * a stale yt-dlp from being used, since YouTube breaks old versions with no
 * useful error. Once both pass, DownloadPanel drives folder → trim → download.
 */
export function DownloadWorkspace() {
  return (
    <TooltipProvider>
      <DownloadSetup>
        <DownloadUpdateGate>
          <DownloadPanel />
        </DownloadUpdateGate>
      </DownloadSetup>
    </TooltipProvider>
  )
}
