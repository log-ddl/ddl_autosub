import * as React from "react"
import { platform } from "@tauri-apps/plugin-os"
import { useTranslation } from "react-i18next"
import { Captions, Download, Scissors, Sparkles, SquareTerminal } from "lucide-react"
import { cn } from "@/lib/utils"
import { IntegrationStatus } from "@/components/layout/integration-status"
import { SettingsDropdown } from "@/components/transcription/settings-dropdown"
import { ExternalAgentDot } from "@/components/external-agent/external-agent-badge"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useAppModeStore, type AppMode } from "@/stores/app-mode-store"

interface TabDef {
  id: AppMode
  labelKey: string
  fallback: string
  icon: React.ReactNode
  /**
   * Kept out of the tab bar while still wired up behind it. The workspace and
   * everything it talks to stay in the build, so putting the tab back is this
   * one flag — nothing has been deleted.
   */
  hidden?: boolean
}

const TABS: TabDef[] = [
  { id: "autocut", labelKey: "shell.tabs.autoEdit", fallback: "Auto Edit", icon: <Scissors className="size-4" /> },
  { id: "autosub", labelKey: "shell.tabs.subtitles", fallback: "Subtitles", icon: <Captions className="size-4" /> },
  { id: "aiedit", labelKey: "shell.tabs.aiEdit", fallback: "AI EDIT", icon: <Sparkles className="size-4" /> },
  { id: "scripts", labelKey: "shell.tabs.scripts", fallback: "Scripts", icon: <SquareTerminal className="size-4" />, hidden: true },
  { id: "download", labelKey: "shell.tabs.download", fallback: "Download", icon: <Download className="size-4" /> },
]

// Shared top chrome for the whole app: a horizontal tab bar that switches
// between the AutoCut, Subtitles and Scripts workspaces, plus the language and
// theme controls on the right. Replaces the old mode-picker landing screen.
export function WorkspaceShell({
  autocut,
  subtitles,
  aiedit,
  scripts,
  download,
}: {
  autocut: React.ReactNode
  subtitles: React.ReactNode
  aiedit: React.ReactNode
  scripts: React.ReactNode
  download: React.ReactNode
}) {
  const { t } = useTranslation()
  const mode = useAppModeStore((s) => s.mode)
  const setMode = useAppModeStore((s) => s.setMode)
  const [isMacOs, setIsMacOs] = React.useState(true)

  const [aiEditMounted, setAiEditMounted] = React.useState(false)
  React.useEffect(() => {
    if (mode === "aiedit") setAiEditMounted(true)
  }, [mode])

  // Scripts is gated behind a one-time Python download, so only mount it once
  // the user has actually opened the tab (then keep it mounted).
  const [scriptsMounted, setScriptsMounted] = React.useState(false)
  React.useEffect(() => {
    if (mode === "scripts") setScriptsMounted(true)
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
          "flex h-12 shrink-0 items-center justify-between border-b pr-2 gap-2",
          isMacOs ? "pl-20" : "pl-3",
        )}
        data-tauri-drag-region={isMacOs ? true : undefined}
      >
        <nav
          className="flex items-center gap-1 min-w-0"
          data-tauri-drag-region={isMacOs ? "false" : undefined}
        >
          {TABS.filter((tab) => !tab.hidden).map((tab) => {
            const active = mode === tab.id
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setMode(tab.id)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 h-8 text-sm font-medium transition-colors",
                  active
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
                )}
              >
                {tab.icon}
                {t(tab.labelKey, tab.fallback)}
              </button>
            )
          })}
        </nav>
        <div
          className="flex items-center gap-1 shrink-0"
          data-tauri-drag-region={isMacOs ? "false" : undefined}
        >
          <IntegrationStatus />
          <ExternalAgentDot />
          <SettingsDropdown />
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-hidden">
        {/* All tabs stay mounted (hidden when inactive) so switching never
            drops in-progress work or event listeners. Scripts mounts lazily. */}
        <div className={cn("h-full", mode === "autocut" ? "block" : "hidden")}>
          <div className="h-full overflow-auto px-6 py-8">{autocut}</div>
        </div>
        <div className={cn("h-full", mode === "autosub" ? "block" : "hidden")}>
          {subtitles}
        </div>
        <div className={cn("h-full", mode === "aiedit" ? "block" : "hidden")}>
          {aiEditMounted ? aiedit : null}
        </div>
        <div className={cn("h-full", mode === "scripts" ? "block" : "hidden")}>
          {scriptsMounted ? scripts : null}
        </div>
        <div className={cn("h-full", mode === "download" ? "block" : "hidden")}>
          <div className="h-full overflow-auto px-6 py-8">
            {downloadMounted ? download : null}
          </div>
        </div>
      </main>
    </div>
    </TooltipProvider>
  )
}
