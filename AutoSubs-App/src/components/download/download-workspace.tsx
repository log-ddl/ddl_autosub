import { TooltipProvider } from "@/components/ui/tooltip"
import { DownloadSetup } from "@/components/download/download-setup"
import { DownloadPanel } from "@/components/download/download-panel"

/**
 * The "Download" workspace: fetch a video from a URL with yt-dlp. The one-time
 * yt-dlp + Deno install is gated by DownloadSetup; once it passes,
 * DownloadPanel drives folder → trim → download. yt-dlp updates itself in the
 * background, and the panel has a corner button to check on demand.
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
