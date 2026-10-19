// App.tsx
import { ThemeProvider, useTheme } from "@/components/providers/theme-provider"
import { Moon, Sun } from "lucide-react"
import { Button } from "@/components/ui/button"
import React from "react"
import { TranscriptionPanel } from "@/components/transcription/transcription-panel"
import { SubtitleViewerPanel } from "@/components/subtitles/subtitle-viewer-panel"
import { DraftTranscriptPanel } from "@/components/subtitles/draft-transcript-panel"
import { useBlurSwap } from "@/hooks/use-blur-swap"
import { useProgress } from "@/contexts/ProgressContext"
import { useTranslation } from "react-i18next"
import { TooltipProvider } from "@/components/ui/tooltip"
import { completeFirstRun } from "@/lib/first-run"
import { useSettingsStore } from "@/stores/settings-store"
import { EditorWorkspaceProviders } from "@/contexts/GlobalProvider"
import { useSubtitleDocument } from "@/contexts/SubtitleDocumentContext"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"
import {
  listSubtitleDocumentIndex,
  type SubtitleDocumentListItem,
} from "@/lib/subtitle-documents"
import { WorkspaceShell } from "@/components/layout/workspace-shell"
import { AppUpdateGate } from "@/components/dialogs/app-update-gate"
import { ScriptsPanel } from "@/components/autoedit/autoedit-panel"
import { AutoEditWorkspace } from "@/components/autoedit/auto-edit-workspace"
import { AutoEditPythonSetup } from "@/components/autoedit/autoedit-python-setup"
import { DownloadWorkspace } from "@/components/download/download-workspace"
import { AiEditWorkspace } from "@/components/aiedit/ai-edit-workspace"

const MIN_TRANSCRIPTION_PANEL_WIDTH = 370
const MIN_SUBTITLE_PANEL_WIDTH = 280
const PANEL_GAP = 16
const SUBTITLE_VIEWER_EXIT_ANIMATION_MS = 180

export function ThemeToggle() {
  const { setTheme, theme } = useTheme()
  const { t } = useTranslation()

  const handleToggle = () => {
    setTheme(theme === "dark" ? "light" : "dark")
  }

  return (
    <Button variant="ghost" size="icon" onClick={handleToggle} className="rounded-full">
      <Sun className="rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0 size-5" />
      <Moon className="absolute rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100 size-5" />
      <span className="sr-only">{t("theme.toggle")}</span>
    </Button>
  )
}

function AppContentBody() {
  const [showSubtitleViewer, setShowSubtitleViewer] = React.useState(() => {
    // Open by default on desktop if there's enough screen space
    const minRequiredWidth = MIN_TRANSCRIPTION_PANEL_WIDTH + MIN_SUBTITLE_PANEL_WIDTH + PANEL_GAP
    const hasEnoughSpace = typeof window !== 'undefined' && window.innerWidth >= minRequiredWidth
    return hasEnoughSpace
  })
  const [isSubtitleViewerExpanded, setIsSubtitleViewerExpanded] =
    React.useState(() => {
      const minRequiredWidth = MIN_TRANSCRIPTION_PANEL_WIDTH + MIN_SUBTITLE_PANEL_WIDTH + PANEL_GAP
      const hasEnoughSpace = typeof window !== 'undefined' && window.innerWidth >= minRequiredWidth
      return hasEnoughSpace
    })
  const [isSubtitleViewerClosing, setIsSubtitleViewerClosing] =
    React.useState(false)
  const [isSubtitleViewerResizing, setIsSubtitleViewerResizing] =
    React.useState(false)
  const [isSubtitleViewerResizeHovered, setIsSubtitleViewerResizeHovered] =
    React.useState(false)
  const [subtitlePanelWidth, setSubtitlePanelWidth] = React.useState(340)
  const [transcriptDocuments, setTranscriptDocuments] = React.useState<
    SubtitleDocumentListItem[]
  >([])
  const [hasLoadedTranscriptDocuments, setHasLoadedTranscriptDocuments] =
    React.useState(false)
  const { processingSteps, isRunActive, livePreviewSegments } = useProgress()
  const onboardingCompleted = useSettingsStore((s) => s.onboardingCompleted)
  const isHydrated = useSettingsStore((s) => s.isHydrated)
  const { subtitles } = useSubtitleDocument()
  const isMobile = useIsMobile()
  const mainContentRef = React.useRef<HTMLDivElement>(null)
  const subtitleViewerCloseTimeoutRef = React.useRef<number | null>(null)
  const subtitleViewerOpenTimeoutRef = React.useRef<number | null>(null)
  const wasMobileRef = React.useRef(false)

  const loadTranscriptDocuments = React.useCallback(async () => {
    try {
      setTranscriptDocuments(await listSubtitleDocumentIndex())
    } catch (error) {
      console.error("Failed to load subtitle documents:", error)
    } finally {
      setHasLoadedTranscriptDocuments(true)
    }
  }, [])

  React.useEffect(() => {
    void loadTranscriptDocuments()
  }, [loadTranscriptDocuments])

  // First launch has no welcome screen: the setup it used to ask for is applied
  // in the background the moment settings are hydrated.
  React.useEffect(() => {
    if (!isHydrated || onboardingCompleted) return
    void completeFirstRun()
  }, [isHydrated, onboardingCompleted])

  const handleCloseSubtitleViewer = React.useCallback(() => {
    if (!showSubtitleViewer || isSubtitleViewerClosing) return

    if (subtitleViewerOpenTimeoutRef.current !== null) {
      window.clearTimeout(subtitleViewerOpenTimeoutRef.current)
      subtitleViewerOpenTimeoutRef.current = null
    }

    setIsSubtitleViewerClosing(true)
    setIsSubtitleViewerExpanded(false)
    subtitleViewerCloseTimeoutRef.current = window.setTimeout(() => {
      setShowSubtitleViewer(false)
      setIsSubtitleViewerClosing(false)
      subtitleViewerCloseTimeoutRef.current = null
    }, SUBTITLE_VIEWER_EXIT_ANIMATION_MS)
  }, [isSubtitleViewerClosing, showSubtitleViewer])

  const handleOpenSubtitleViewer = React.useCallback(() => {
    if (
      showSubtitleViewer &&
      isSubtitleViewerExpanded &&
      !isSubtitleViewerClosing
    ) {
      return
    }

    if (subtitleViewerCloseTimeoutRef.current !== null) {
      window.clearTimeout(subtitleViewerCloseTimeoutRef.current)
      subtitleViewerCloseTimeoutRef.current = null
    }
    if (subtitleViewerOpenTimeoutRef.current !== null) {
      window.clearTimeout(subtitleViewerOpenTimeoutRef.current)
      subtitleViewerOpenTimeoutRef.current = null
    }

    setIsSubtitleViewerClosing(false)
    setIsSubtitleViewerExpanded(false)
    setShowSubtitleViewer(true)

    subtitleViewerOpenTimeoutRef.current = window.setTimeout(() => {
      setIsSubtitleViewerExpanded(true)
      subtitleViewerOpenTimeoutRef.current = null
    }, 20)
  }, [
    handleCloseSubtitleViewer,
    isMobile,
    isSubtitleViewerClosing,
    isSubtitleViewerExpanded,
    showSubtitleViewer,
    subtitles.length,
  ])

  React.useEffect(() => {
    return () => {
      if (subtitleViewerCloseTimeoutRef.current !== null) {
        window.clearTimeout(subtitleViewerCloseTimeoutRef.current)
      }
      if (subtitleViewerOpenTimeoutRef.current !== null) {
        window.clearTimeout(subtitleViewerOpenTimeoutRef.current)
      }
    }
  }, [])

  // Reopen the subtitle viewer when the viewport grows past the mobile breakpoint.
  React.useEffect(() => {
    if (wasMobileRef.current && !isMobile) {
      handleOpenSubtitleViewer()
    }
    wasMobileRef.current = isMobile
  }, [isMobile, handleOpenSubtitleViewer])

  const handleTranscriptCreated = React.useCallback(async () => {
    await loadTranscriptDocuments()
  }, [loadTranscriptDocuments])

  // While a run is in progress the right panel shows the live draft instead of
  // the previous, unrelated transcript. Showing a stale transcript during
  // processing was actively misleading — it looked like the result.
  //
  // Keyed on the run, not on "some step is active": steps hand over with a gap,
  // and during that gap no step is active, which would blur the panel back to
  // the old transcript and straight out again between every single step.
  const isDraftMode = isRunActive

  // The hairline tracks the running step. Between steps there is nothing to
  // track, so hold the last value rather than letting it snap back to zero.
  const activeStepProgress = processingSteps.find((step) => step.isActive)?.progress
  const heldProgressRef = React.useRef(0)
  if (!isDraftMode) heldProgressRef.current = 0
  else if (activeStepProgress !== undefined) heldProgressRef.current = activeStepProgress

  // Formatting re-segments the whole transcript, so the draft list is replaced
  // wholesale rather than refined in place. Hold the draft for one blur-out,
  // swap under cover of it, and blur back in on the final subtitles.
  const { displayed: showDraftPanel, className: panelSwapClassName } =
    useBlurSwap(isDraftMode)

  // A run implies the user wants to watch it, so surface the panel if it is shut,
  // but only when the viewport is wide enough to show both panels side-by-side.
  React.useEffect(() => {
    const minRequiredWidth = MIN_TRANSCRIPTION_PANEL_WIDTH + MIN_SUBTITLE_PANEL_WIDTH + PANEL_GAP
    if (
      isDraftMode &&
      !showSubtitleViewer &&
      typeof window !== "undefined" &&
      window.innerWidth >= minRequiredWidth
    ) {
      handleOpenSubtitleViewer()
    }
  }, [isDraftMode, showSubtitleViewer, handleOpenSubtitleViewer])

  const getMaxSubtitlePanelWidth = React.useCallback(() => {
    const containerWidth = mainContentRef.current?.getBoundingClientRect().width ?? window.innerWidth
    return Math.max(
      MIN_SUBTITLE_PANEL_WIDTH,
      containerWidth - MIN_TRANSCRIPTION_PANEL_WIDTH - PANEL_GAP,
    )
  }, [])

  const handleSubtitleResizeStart = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (isMobile) return

    event.preventDefault()
    setIsSubtitleViewerResizing(true)

    const startX = event.clientX
    const startWidth = subtitlePanelWidth

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextWidth = startWidth + startX - moveEvent.clientX
      setSubtitlePanelWidth(
        Math.min(
          getMaxSubtitlePanelWidth(),
          Math.max(MIN_SUBTITLE_PANEL_WIDTH, nextWidth),
        ),
      )
    }

    const handlePointerUp = () => {
      setIsSubtitleViewerResizing(false)
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerup", handlePointerUp)
      window.removeEventListener("pointercancel", handlePointerUp)
    }

    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerup", handlePointerUp)
    window.addEventListener("pointercancel", handlePointerUp)
  }, [getMaxSubtitlePanelWidth, isMobile, subtitlePanelWidth])

  // Adjust subtitle panel width when window is resized
  React.useEffect(() => {
    if (isMobile) return

    const handleResize = () => {
      const maxWidth = getMaxSubtitlePanelWidth()
      if (subtitlePanelWidth > maxWidth) {
        setSubtitlePanelWidth(maxWidth)
      }
    }

    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [getMaxSubtitlePanelWidth, subtitlePanelWidth, isMobile])

  const subtitleViewerClassName = isMobile
    ? `${isSubtitleViewerClosing ? "animate-subtitle-sidebar-out" : "animate-subtitle-sidebar-in"} absolute inset-0 z-50 min-h-0 overflow-hidden bg-card`
    : `${isSubtitleViewerClosing ? "animate-subtitle-sidebar-out" : "animate-subtitle-sidebar-in"} ${isSubtitleViewerResizing ? "subtitle-sidebar-shell-resizing" : "subtitle-sidebar-shell"} ${isSubtitleViewerResizing || isSubtitleViewerResizeHovered ? "border-foreground/30 dark:border-foreground/25" : "border-border"} relative min-h-0 shrink-0 overflow-hidden border-l transition-color bg-card`

  return (
    <TooltipProvider>
      <div className="flex flex-col h-full overflow-hidden bg-background relative">
          {/* Main Content Area with Resizable Panels */}
          <div ref={mainContentRef} className="flex-1 min-h-0 pb-0 relative">
            <div className="flex h-full min-w-0">
              <div className="min-h-0 min-w-[370px] flex-1 overflow-hidden">
                <TranscriptionPanel
                  onViewSubtitles={handleOpenSubtitleViewer}
                  onTranscriptCreated={handleTranscriptCreated}
                  isSubtitleViewerOpen={
                    showSubtitleViewer && !isSubtitleViewerClosing
                  }
                />
              </div>
              {showSubtitleViewer && (
                <div
                  className={subtitleViewerClassName}
                  style={{
                    width: isMobile
                      ? "100%"
                      : isSubtitleViewerExpanded
                        ? subtitlePanelWidth
                        : 0,
                  }}
                >
                  {!isMobile && (
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      aria-label="Resize subtitles panel"
                      className="group absolute inset-y-0 -left-2 z-30 flex w-5 cursor-col-resize touch-none items-center justify-center"
                      onPointerDown={handleSubtitleResizeStart}
                      onPointerEnter={() => setIsSubtitleViewerResizeHovered(true)}
                      onPointerLeave={() => setIsSubtitleViewerResizeHovered(false)}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "h-8 w-[3px] rounded-full transition-all",
                          isSubtitleViewerResizing || isSubtitleViewerResizeHovered
                            ? "bg-foreground/40 h-12"
                            : "bg-foreground/15",
                        )}
                      />
                    </div>
                  )}
                  <div className={`h-full min-h-0 ${panelSwapClassName}`}>
                    {showDraftPanel ? (
                      <DraftTranscriptPanel
                        segments={livePreviewSegments}
                        isComplete={!isDraftMode}
                        progress={heldProgressRef.current}
                        isFullScreen={isMobile}
                        onClose={handleCloseSubtitleViewer}
                      />
                    ) : (
                      <SubtitleViewerPanel
                        isFullScreen={isMobile}
                        onClose={handleCloseSubtitleViewer}
                        transcriptDocuments={transcriptDocuments}
                        isLoadingTranscriptDocuments={!hasLoadedTranscriptDocuments}
                        onTranscriptDocumentsRefresh={loadTranscriptDocuments}
                      />
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

      </div>
    </TooltipProvider>
  )
}

function AppRouter() {
  // One set of editor providers (Resolve bridge, subtitle document, progress,
  // presets, ...) wraps all three workspace tabs so switching tabs never tears
  // down the Resolve connection or an in-progress transcription.
  return (
    <EditorWorkspaceProviders>
      <WorkspaceShell
        autocut={<AutoEditWorkspace />}
        subtitles={<AppContentBody />}
        aiedit={<AiEditWorkspace />}
        scripts={
          <AutoEditPythonSetup>
            <ScriptsPanel />
          </AutoEditPythonSetup>
        }
        download={<DownloadWorkspace />}
      />
    </EditorWorkspaceProviders>
  )
}

function App() {
  return (
    <ThemeProvider defaultTheme="system" storageKey="vite-ui-theme">
      {/* Outermost on purpose: an out-of-date build hits bugs already fixed, so
          nothing else loads until the update is installed. */}
      <AppUpdateGate>
        <AppRouter />
      </AppUpdateGate>
    </ThemeProvider>
  );
}

export default App;
