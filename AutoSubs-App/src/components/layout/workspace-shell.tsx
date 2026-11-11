import * as React from "react"
import { platform } from "@tauri-apps/plugin-os"
import { useTranslation } from "react-i18next"
import { motion } from "motion/react"
import { cn } from "@/lib/utils"
import { spring } from "@/lib/motion-tokens"
import { IntegrationStatus } from "@/components/layout/integration-status"
import { SettingsDropdown } from "@/components/transcription/settings-dropdown"
import { ExternalAgentDot } from "@/components/external-agent/external-agent-badge"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  CaptionsIcon,
  type CaptionsIconHandle,
} from "@/components/ui/icons/captions"
import {
  SparklesIcon,
  type SparklesIconHandle,
} from "@/components/ui/icons/sparkles"
import {
  DownloadIcon,
  type DownloadIconHandle,
} from "@/components/ui/icons/download"
import {
  AudioLinesIcon,
  type AudioLinesIconHandle,
} from "@/components/ui/icons/audio-lines"
import { useAppModeStore, type AppMode } from "@/stores/app-mode-store"

interface AnimatableIconHandle {
  startAnimation: () => void
  stopAnimation: () => void
}

// Shared top chrome for the whole app: a horizontal tab bar that switches
// between the Subtitles, AI Edit, TTS and Download workspaces, plus the language
// and theme controls on the right. Replaces the old mode-picker landing screen.
export function WorkspaceShell({
  subtitles,
  aiedit,
  tts,
  download,
}: {
  subtitles: React.ReactNode
  aiedit: React.ReactNode
  tts: React.ReactNode
  download: React.ReactNode
}) {
  const { t } = useTranslation()
  const mode = useAppModeStore((s) => s.mode)
  const setMode = useAppModeStore((s) => s.setMode)
  const [isMacOs, setIsMacOs] = React.useState(true)

  const captionsIconRef = React.useRef<CaptionsIconHandle>(null)
  const sparklesIconRef = React.useRef<SparklesIconHandle>(null)
  const audioLinesIconRef = React.useRef<AudioLinesIconHandle>(null)
  const downloadIconRef = React.useRef<DownloadIconHandle>(null)

  const tabs: {
    id: AppMode
    labelKey: string
    fallback: string
    iconRef: React.RefObject<AnimatableIconHandle | null>
    icon: React.ReactNode
  }[] = [
    {
      id: "autosub",
      labelKey: "shell.tabs.subtitles",
      fallback: "Subtitles",
      iconRef: captionsIconRef,
      icon: <CaptionsIcon ref={captionsIconRef} size={15} />,
    },
    {
      id: "aiedit",
      labelKey: "shell.tabs.aiEdit",
      fallback: "AI Edit",
      iconRef: sparklesIconRef,
      icon: <SparklesIcon ref={sparklesIconRef} size={15} />,
    },
    {
      id: "tts",
      labelKey: "shell.tabs.tts",
      fallback: "TTS",
      iconRef: audioLinesIconRef,
      icon: <AudioLinesIcon ref={audioLinesIconRef} size={15} />,
    },
    {
      id: "download",
      labelKey: "shell.tabs.download",
      fallback: "Download",
      iconRef: downloadIconRef,
      icon: <DownloadIcon ref={downloadIconRef} size={15} />,
    },
  ]

  const [aiEditMounted, setAiEditMounted] = React.useState(false)
  React.useEffect(() => {
    if (mode === "aiedit") setAiEditMounted(true)
  }, [mode])

  const [ttsMounted, setTtsMounted] = React.useState(false)
  React.useEffect(() => {
    if (mode === "tts") setTtsMounted(true)
  }, [mode])

  // Download is gated behind a one-time yt-dlp + Deno download, so only mount
  // it once the user has actually opened the tab (then keep it mounted).
  const [downloadMounted, setDownloadMounted] = React.useState(false)
  React.useEffect(() => {
    if (mode === "download") setDownloadMounted(true)
  }, [mode])

  React.useEffect(() => {
    try {
      setIsMacOs(platform() === "macos")
    } catch {
      setIsMacOs(true)
    }
  }, [])

  return (
    <TooltipProvider>
      <div className="flex flex-col h-screen bg-background">
        <header
          className={cn(
            "flex h-12 shrink-0 items-center justify-between border-b border-border/80 bg-card/50 backdrop-blur-md pr-3 gap-3",
            isMacOs ? "pl-20" : "pl-3.5",
          )}
          data-tauri-drag-region={isMacOs ? true : undefined}
        >
          <nav
            className="flex items-center gap-0.5 min-w-0 rounded-xl border border-border/60 bg-muted/60 p-1"
            data-tauri-drag-region={isMacOs ? "false" : undefined}
          >
            {tabs.map((tab) => {
              const active = mode === tab.id
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    setMode(tab.id)
                    tab.iconRef.current?.startAnimation()
                  }}
                  onMouseEnter={() => tab.iconRef.current?.startAnimation()}
                  onMouseLeave={() => tab.iconRef.current?.stopAnimation()}
                  className={cn(
                    "relative flex items-center gap-1.5 rounded-lg px-3 h-7 text-xs font-semibold transition-colors duration-150 active:scale-[0.97] outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                    active
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {active && (
                    <motion.span
                      layoutId="workspace-nav-pill"
                      transition={spring.selection}
                      className="absolute inset-0 rounded-lg border border-border/70 bg-card shadow-2xs dark:border-white/10 dark:bg-accent"
                    />
                  )}
                  <span
                    className={cn(
                      "relative z-10 flex items-center justify-center transition-colors",
                      active ? "text-primary" : "text-current",
                    )}
                  >
                    {tab.icon}
                  </span>
                  <span className="relative z-10">
                    {t(tab.labelKey, tab.fallback)}
                  </span>
                </button>
              )
            })}
          </nav>
          <div
            className="flex items-center gap-1.5 shrink-0"
            data-tauri-drag-region={isMacOs ? "false" : undefined}
          >
            <IntegrationStatus />
            <ExternalAgentDot />
            <SettingsDropdown />
          </div>
        </header>

        <main className="flex-1 min-h-0 overflow-hidden">
          {/* All tabs stay mounted (hidden when inactive) so switching never
              drops in-progress work or event listeners. AI Edit and Download
              mount lazily. */}
          <div className={cn("h-full", mode === "autosub" ? "block" : "hidden")}>
            {subtitles}
          </div>
          <div className={cn("h-full", mode === "aiedit" ? "block" : "hidden")}>
            {aiEditMounted ? aiedit : null}
          </div>
          <div className={cn("h-full", mode === "tts" ? "block" : "hidden")}>
            {ttsMounted ? tts : null}
          </div>
          <div className={cn("h-full", mode === "download" ? "block" : "hidden")}>
            <div className="h-full overflow-auto px-6 py-7">
              {downloadMounted ? download : null}
            </div>
          </div>
        </main>
      </div>
    </TooltipProvider>
  )
}
