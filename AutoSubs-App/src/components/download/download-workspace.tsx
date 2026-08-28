import { TooltipProvider } from "@/components/ui/tooltip"
import { DownloadSetup } from "@/components/download/download-setup"
import { DownloadPanel } from "@/components/download/download-panel"

/**
 * The "Download" workspace: fetch a video from a URL with yt-dlp. The one-time
 * yt-dlp + Deno install is gated by DownloadSetup; once ready, DownloadPanel
 * drives analyze → pick quality/folder → download.
 */
export function DownloadWorkspace() {
  return (
    <TooltipProvider>
      <DownloadSetup>
        <DownloadPanel />
      </DownloadSetup>
    </TooltipProvider>
  )
}
