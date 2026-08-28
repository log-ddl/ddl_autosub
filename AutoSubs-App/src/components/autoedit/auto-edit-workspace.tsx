import { TooltipProvider } from "@/components/ui/tooltip"
import { SlideshowPanel } from "@/components/autoedit/slideshow-panel"
import { useIntegration } from "@/contexts/IntegrationContext"

/**
 * The "Auto Edit" workspace. It hosts the Slideshow tool — place voice-synced
 * media onto the Resolve timeline.
 *
 * `key={selectedIntegration}` remounts the panel whenever the target editor
 * changes, so no project state from a previous editor (media, voice, selected
 * track) ever leaks into the next one.
 */
export function AutoEditWorkspace() {
  const { selectedIntegration } = useIntegration()
  return (
    <TooltipProvider>
      <div className="mx-auto w-full max-w-3xl">
        <SlideshowPanel key={selectedIntegration} />
      </div>
    </TooltipProvider>
  )
}
