import * as React from "react"
import { Button } from "@/components/ui/button"
import {
  BookOpen,
  Captions,
  ClipboardList,
  Eraser,
  FileCode2,
  Library,
  ListOrdered,
  MapPin,
  Pause,
  Play,
  Plug,
  ScanSearch,
  Scissors,
  Settings2,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { InfoHint } from "@/components/ui/info-hint"
import { Label } from "@/components/ui/label"
import { useResolve } from "@/contexts/ResolveContext"
import { useTranslation } from "react-i18next"
import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { toast } from "sonner"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import {
  addMarkerAtPlayhead,
  clearTimelineMarkers,
  findTimelineGaps,
  getResolveInfo,
  getYoutubeChapters,
  markClipCuts,
  markersFromSubtitles,
  markSpeechGaps,
  ResolveApiError,
} from "@/api/resolve-api"
import { useSavedScripts } from "@/lib/saved-scripts"
import { TrackCard } from "@/components/autoedit/track-card"
import { runPythonScript } from "@/api/autoedit-api"

interface LogLine {
  stream: "stdout" | "stderr" | "system"
  line: string
}

interface RunnerOutputPayload {
  stream: "stdout" | "stderr"
  line: string
}

interface RunnerDonePayload {
  exit_code: number | null
  error: string | null
}

// Shared runner state — only one script may run at a time, all consumers see
// the same log stream so switching tabs mid-run doesn't lose output.
function useScriptRunner() {
  const { t } = useTranslation()
  const [logs, setLogs] = React.useState<LogLine[]>([])
  const [isRunning, setIsRunning] = React.useState(false)

  const appendError = React.useCallback((message: string) => {
    setLogs((prev) => [...prev, { stream: "stderr", line: message }])
  }, [])

  // Runs a user .py file with the app's bundled Python. The script imports our
  // stand-in DaVinciResolveScript module (see resources/autoedit-shim), which
  // proxies the Resolve API over to the Lua bridge running inside Resolve — the
  // free edition of Resolve refuses direct out-of-process scripting.
  const runScript = React.useCallback(
    async (scriptPath: string) => {
      if (isRunning) return

      setLogs([])
      setIsRunning(true)

      let unlistenOutput: UnlistenFn | null = null
      let unlistenDone: UnlistenFn | null = null

      const cleanup = () => {
        unlistenOutput?.()
        unlistenDone?.()
      }

      try {
        unlistenOutput = await listen<RunnerOutputPayload>(
          "autoedit-runner-output",
          (event) => setLogs((prev) => [...prev, event.payload]),
        )

        unlistenDone = await listen<RunnerDonePayload>(
          "autoedit-runner-done",
          (event) => {
            const { exit_code, error } = event.payload
            if (error) {
              appendError(error)
              toast.error(
                t("modePicker.autoedit.import.launchError", { message: error }),
              )
            } else if (exit_code === 0) {
              toast.success(t("modePicker.autoedit.import.exitOk"))
            } else {
              toast.error(
                t("modePicker.autoedit.import.exitFail", { code: exit_code ?? "?" }),
              )
            }
            setIsRunning(false)
            cleanup()
          },
        )

        await runPythonScript(scriptPath)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        appendError(message)
        toast.error(t("modePicker.autoedit.import.launchError", { message }))
        setIsRunning(false)
        cleanup()
      }
    },
    [appendError, isRunning, t],
  )

  // Runs a built-in action through the Lua bridge and renders the returned
  // lines into the shared log panel.
  const runAction = React.useCallback(
    async (action: () => Promise<string[]>) => {
      if (isRunning) return

      setLogs([])
      setIsRunning(true)
      try {
        const lines = await action()
        setLogs(lines.map((line) => ({ stream: "stdout" as const, line })))
        toast.success(t("modePicker.autoedit.import.exitOk"))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const detail = err instanceof ResolveApiError ? err.detail : undefined
        appendError(detail ? `${message}\n${detail}` : message)
        toast.error(message)
      } finally {
        setIsRunning(false)
      }
    },
    [appendError, isRunning, t],
  )

  const clearLogs = React.useCallback(() => setLogs([]), [])

  return { logs, isRunning, runScript, runAction, clearLogs }
}

function ScriptLogPanel({
  logs,
  isRunning,
  onClear,
}: {
  logs: LogLine[]
  isRunning: boolean
  onClear: () => void
}) {
  const { t } = useTranslation()
  const logEndRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: "end" })
  }, [logs])

  return (
    <div className="mt-6">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-medium">
          {t("modePicker.autoedit.import.logTitle")}
        </div>
        {logs.length > 0 && !isRunning && (
          <Button size="sm" variant="ghost" onClick={onClear}>
            {t("modePicker.autoedit.import.clearLog")}
          </Button>
        )}
      </div>
      <div className="rounded-lg border bg-muted/30 h-64 overflow-auto p-3 font-mono text-xs">
        {logs.length === 0 ? (
          <div className="text-muted-foreground italic">
            {t("modePicker.autoedit.import.logEmpty")}
          </div>
        ) : (
          <>
            {logs.map((entry, index) => (
              <div
                key={index}
                className={
                  entry.stream === "stderr"
                    ? "text-red-500 whitespace-pre-wrap break-words"
                    : "whitespace-pre-wrap break-words"
                }
              >
                {entry.line}
              </div>
            ))}
            <div ref={logEndRef} />
          </>
        )}
      </div>
    </div>
  )
}

// "My scripts": import a .py once, and it's saved for re-running later. Files
// are kept as path references (not copied), matching how the runner resolves
// them at launch.
function MyScriptsTab({
  runner,
}: {
  runner: ReturnType<typeof useScriptRunner>
}) {
  const { t } = useTranslation()
  const { scripts, loaded, addScript, removeScript } = useSavedScripts()
  const [runningId, setRunningId] = React.useState<string | null>(null)

  const handleImport = async () => {
    const picked = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "Python", extensions: ["py"] }],
    })
    if (typeof picked === "string") await addScript(picked)
  }

  const runSaved = async (id: string, path: string) => {
    if (runner.isRunning) return
    setRunningId(id)
    try {
      await runner.runScript(path)
    } finally {
      setRunningId(null)
    }
  }

  return (
    <div className="max-w-2xl mx-auto w-full">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold mb-1">
            {t("modePicker.autoedit.myScripts.title", "My scripts")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("modePicker.autoedit.myScripts.description")}
          </p>
        </div>
        <Button onClick={handleImport} disabled={runner.isRunning} className="shrink-0 gap-1.5">
          <Upload className="size-4" />
          {t("modePicker.autoedit.myScripts.import", "Import script")}
        </Button>
      </div>

      {!loaded ? null : scripts.length === 0 ? (
        <div className="rounded-xl border border-dashed bg-muted/30 p-10 flex flex-col items-center gap-3 text-center">
          <div className="size-12 rounded-lg bg-background flex items-center justify-center">
            <FileCode2 className="size-6 text-muted-foreground" />
          </div>
          <p className="text-sm text-muted-foreground">
            {t("modePicker.autoedit.myScripts.empty")}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {scripts.map((s) => {
            const isThisRunning = runner.isRunning && runningId === s.id
            return (
              <div key={s.id} className="rounded-lg border bg-card p-3 flex items-center gap-3">
                <div className="size-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
                  <FileCode2 className="size-4.5 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{s.name}</div>
                  <div className="text-xs text-muted-foreground truncate" title={s.path}>
                    {s.path}
                  </div>
                </div>
                <Button
                  size="sm"
                  onClick={() => runSaved(s.id, s.path)}
                  disabled={runner.isRunning}
                  className="gap-1.5 shrink-0"
                >
                  <Play className="size-4" />
                  {isThisRunning
                    ? t("modePicker.autoedit.import.running")
                    : t("modePicker.autoedit.import.run")}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => removeScript(s.id)}
                  disabled={runner.isRunning}
                  aria-label={t("modePicker.autoedit.myScripts.remove", "Remove")}
                  className="shrink-0"
                >
                  <X className="size-4" />
                </Button>
              </div>
            )
          })}
        </div>
      )}

      <ScriptLogPanel
        logs={runner.logs}
        isRunning={runner.isRunning}
        onClear={runner.clearLogs}
      />
    </div>
  )
}

// A value the user picks before a script runs. Track pickers are filled from
// the live timeline; `seconds` is a free number with sane bounds.
type OptionSpec =
  | {
      key: string
      kind: "videoTrack" | "audioTrack" | "subtitleTrack"
      labelKey: string
      fallback: number
    }
  | {
      key: string
      kind: "seconds"
      labelKey: string
      hintKey: string
      fallback: number
      min: number
      max: number
      step: number
    }

type OptionValues = Record<string, number>

// Groups the built-in scripts by purpose so the list reads as a small toolbox
// rather than a flat pile. Order here is the order the sections render in.
type BuiltinCategory = "cut" | "markers" | "cleanup" | "info"

const BUILTIN_CATEGORY_ORDER: BuiltinCategory[] = [
  "cut",
  "markers",
  "cleanup",
  "info",
]

interface BuiltinScript {
  id: string
  category: BuiltinCategory
  action: (values: OptionValues) => Promise<string[]>
  nameKey: string
  descriptionKey: string
  // Depicts what this script does; the description sits behind it on hover.
  icon: LucideIcon
  // Omitted for scripts that take no parameters; those run on the first click.
  options?: OptionSpec[]
}

// Built-in actions are implemented as endpoints on the AutoSubs Lua server
// (which runs inside Resolve), so they work on the free edition of Resolve
// and need no local Python at all.
const BUILTIN_SCRIPTS: BuiltinScript[] = [
  {
    id: "resolve-info",
    category: "info",
    icon: ClipboardList,
    action: getResolveInfo,
    nameKey: "modePicker.autoedit.builtin.resolveInfo.name",
    descriptionKey: "modePicker.autoedit.builtin.resolveInfo.description",
  },
  {
    id: "add-marker",
    category: "markers",
    icon: MapPin,
    action: addMarkerAtPlayhead,
    nameKey: "modePicker.autoedit.builtin.addMarker.name",
    descriptionKey: "modePicker.autoedit.builtin.addMarker.description",
  },
  {
    id: "youtube-chapters",
    category: "markers",
    icon: ListOrdered,
    action: getYoutubeChapters,
    nameKey: "modePicker.autoedit.builtin.chapters.name",
    descriptionKey: "modePicker.autoedit.builtin.chapters.description",
  },
  {
    id: "mark-cuts",
    category: "cut",
    icon: Scissors,
    action: (v) => markClipCuts(v.track),
    nameKey: "modePicker.autoedit.builtin.markCuts.name",
    descriptionKey: "modePicker.autoedit.builtin.markCuts.description",
    options: [
      {
        key: "track",
        kind: "videoTrack",
        labelKey: "modePicker.autoedit.options.videoTrack",
        fallback: 1,
      },
    ],
  },
  {
    id: "subtitle-markers",
    category: "markers",
    icon: Captions,
    action: (v) => markersFromSubtitles(v.track),
    nameKey: "modePicker.autoedit.builtin.subtitleMarkers.name",
    descriptionKey: "modePicker.autoedit.builtin.subtitleMarkers.description",
    options: [
      {
        key: "track",
        kind: "subtitleTrack",
        labelKey: "modePicker.autoedit.options.subtitleTrack",
        fallback: 1,
      },
    ],
  },
  {
    id: "speech-gaps",
    category: "cut",
    icon: Pause,
    action: (v) => markSpeechGaps(v.minSeconds, v.track),
    nameKey: "modePicker.autoedit.builtin.speechGaps.name",
    descriptionKey: "modePicker.autoedit.builtin.speechGaps.description",
    options: [
      {
        key: "track",
        kind: "subtitleTrack",
        labelKey: "modePicker.autoedit.options.subtitleTrack",
        fallback: 1,
      },
      {
        key: "minSeconds",
        kind: "seconds",
        labelKey: "modePicker.autoedit.options.minPause",
        hintKey: "modePicker.autoedit.options.minPauseHint",
        fallback: 2,
        min: 0.2,
        max: 60,
        step: 0.1,
      },
    ],
  },
  {
    id: "timeline-gaps",
    category: "cut",
    icon: ScanSearch,
    action: (v) => findTimelineGaps(v.track),
    nameKey: "modePicker.autoedit.builtin.timelineGaps.name",
    descriptionKey: "modePicker.autoedit.builtin.timelineGaps.description",
    options: [
      {
        key: "track",
        kind: "videoTrack",
        labelKey: "modePicker.autoedit.options.videoTrack",
        fallback: 1,
      },
    ],
  },
  {
    id: "clear-markers",
    category: "cleanup",
    icon: Eraser,
    action: () => clearTimelineMarkers(),
    nameKey: "modePicker.autoedit.builtin.clearMarkers.name",
    descriptionKey: "modePicker.autoedit.builtin.clearMarkers.description",
  },
]

function defaultValues(script: BuiltinScript): OptionValues {
  const values: OptionValues = {}
  for (const option of script.options ?? []) values[option.key] = option.fallback
  return values
}

// Prompts for a script's parameters. Track lists come from the timeline the
// app already polls, so the picker only ever offers tracks that exist.
function ScriptOptionsDialog({
  script,
  onCancel,
  onConfirm,
}: {
  script: BuiltinScript | null
  onCancel: () => void
  onConfirm: (values: OptionValues) => void
}) {
  const { t } = useTranslation()
  const { timelineInfo } = useResolve()
  const [values, setValues] = React.useState<OptionValues>({})

  React.useEffect(() => {
    if (script) setValues(defaultValues(script))
  }, [script])

  // `outputTracks` carries a synthetic "Add to New Track" entry (value "0")
  // for the subtitle workflow; AutoEdit only ever targets real tracks.
  const videoTracks = (timelineInfo.outputTracks ?? []).filter(
    (track) => track.value !== "0",
  )
  const audioTracks = timelineInfo.inputTracks ?? []
  const subtitleTracks = timelineInfo.subtitleTracks ?? []

  const tracksFor = (kind: OptionSpec["kind"]) => {
    if (kind === "videoTrack") return videoTracks
    if (kind === "audioTrack") return audioTracks
    return subtitleTracks
  }

  const missingTrack = (script?.options ?? []).some(
    (option) => option.kind !== "seconds" && tracksFor(option.kind).length === 0,
  )

  return (
    <Dialog open={script !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{script ? t(script.nameKey) : ""}</DialogTitle>
          <DialogDescription>
            {script ? t(script.descriptionKey) : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {(script?.options ?? []).map((option) => {
            if (option.kind === "seconds") {
              return (
                <div key={option.key} className="space-y-1.5">
                  <Label htmlFor={option.key}>{t(option.labelKey)}</Label>
                  <Input
                    id={option.key}
                    type="number"
                    min={option.min}
                    max={option.max}
                    step={option.step}
                    value={values[option.key] ?? option.fallback}
                    onChange={(e) => {
                      const next = Number(e.target.value)
                      setValues((prev) => ({
                        ...prev,
                        [option.key]: Number.isFinite(next)
                          ? next
                          : option.fallback,
                      }))
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t(option.hintKey)}
                  </p>
                </div>
              )
            }

            const tracks = tracksFor(option.kind)
            const trackKind =
              option.kind === "videoTrack"
                ? "video"
                : option.kind === "audioTrack"
                ? "audio"
                : "subtitle"
            const emptyLabel =
              option.kind === "subtitleTrack"
                ? t("modePicker.autoedit.options.noSubtitleTracks")
                : option.kind === "audioTrack"
                ? t("modePicker.autoedit.options.noAudioTracks")
                : t("modePicker.autoedit.options.noVideoTracks")
            return (
              <TrackCard
                key={option.key}
                mode="single"
                kind={trackKind}
                title={t(option.labelKey)}
                tracks={tracks}
                value={[String(values[option.key] ?? option.fallback)]}
                onChange={(v) =>
                  setValues((prev) => ({
                    ...prev,
                    [option.key]: Number(v[0]),
                  }))
                }
                emptyLabel={emptyLabel}
              />
            )
          })}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t("common.cancel", "Cancel")}
          </Button>
          <Button
            onClick={() => onConfirm(values)}
            disabled={missingTrack}
            className="gap-1.5"
          >
            <Play className="size-4" />
            {t("modePicker.autoedit.import.run")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BuiltinScriptsTab({
  runner,
}: {
  runner: ReturnType<typeof useScriptRunner>
}) {
  const { t } = useTranslation()
  const [pendingId, setPendingId] = React.useState<string | null>(null)
  const [configuring, setConfiguring] = React.useState<BuiltinScript | null>(null)

  const runWith = async (script: BuiltinScript, values: OptionValues) => {
    if (runner.isRunning) return
    setPendingId(script.id)
    try {
      await runner.runAction(() => script.action(values))
    } finally {
      setPendingId(null)
    }
  }

  const handleRun = (script: BuiltinScript) => {
    if (runner.isRunning) return
    // Parameterised scripts ask first; the rest run straight away.
    if (script.options?.length) {
      setConfiguring(script)
      return
    }
    void runWith(script, {})
  }

  return (
    <div className="max-w-2xl mx-auto w-full">
      <div className="mb-6">
        <h2 className="text-lg font-semibold mb-1">
          {t("modePicker.autoedit.builtin.title")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("modePicker.autoedit.builtin.description")}
        </p>
      </div>

      <div className="space-y-6">
        {BUILTIN_CATEGORY_ORDER.map((category) => {
          const scripts = BUILTIN_SCRIPTS.filter((s) => s.category === category)
          if (scripts.length === 0) return null
          return (
            <section key={category}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t(`modePicker.autoedit.builtin.categories.${category}`)}
              </h3>
              <div className="space-y-3">
                {scripts.map((script) => {
                  const isThisRunning =
                    runner.isRunning && pendingId === script.id
                  return (
                    <div
                      key={script.id}
                      className="rounded-lg border bg-card px-3 py-2.5 flex items-center gap-3"
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <InfoHint
                          icon={script.icon}
                          text={t(script.descriptionKey)}
                        />
                        <span className="truncate text-sm font-semibold">
                          {t(script.nameKey)}
                        </span>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => handleRun(script)}
                        disabled={runner.isRunning}
                        className="gap-1.5 shrink-0"
                      >
                        {script.options?.length ? (
                          <Settings2 className="size-4" />
                        ) : (
                          <Play className="size-4" />
                        )}
                        {isThisRunning
                          ? t("modePicker.autoedit.import.running")
                          : t("modePicker.autoedit.import.run")}
                      </Button>
                    </div>
                  )
                })}
              </div>
            </section>
          )
        })}
      </div>

      <ScriptOptionsDialog
        script={configuring}
        onCancel={() => setConfiguring(null)}
        onConfirm={(values) => {
          const script = configuring
          setConfiguring(null)
          if (script) void runWith(script, values)
        }}
      />

      <ScriptLogPanel
        logs={runner.logs}
        isRunning={runner.isRunning}
        onClear={runner.clearLogs}
      />
    </div>
  )
}

function PlaceholderTab({
  icon,
  title,
  description,
  empty,
}: {
  icon: React.ReactNode
  title: string
  description: string
  empty: string
}) {
  return (
    <div className="max-w-2xl mx-auto w-full">
      <div className="mb-6">
        <h2 className="text-lg font-semibold mb-1">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="rounded-xl border border-dashed bg-muted/30 p-10 flex flex-col items-center justify-center gap-3 text-center">
        <div className="size-12 rounded-lg bg-background flex items-center justify-center text-muted-foreground">
          {icon}
        </div>
        <p className="text-sm text-muted-foreground">{empty}</p>
      </div>
    </div>
  )
}

// The "Scripts" workspace tab: the Python/Lua script tooling that used to live
// under AutoEdit. Rendered inside the shared WorkspaceShell (which owns the
// top window chrome), so this component provides only the inner sub-tabs.
export function ScriptsPanel() {
  const { t } = useTranslation()
  // Single shared runner: only one script can execute at a time regardless of
  // which tab launched it, so tab switches don't drop the log stream.
  const runner = useScriptRunner()

  return (
    <TooltipProvider>
      <Tabs defaultValue="mine" className="h-full flex flex-col">
        <div className="flex justify-center px-4 pt-4">
          <TabsList>
            <TabsTrigger value="mine" className="gap-1.5">
              <Upload className="size-4" />
              {t("modePicker.autoedit.tabs.mine", "My scripts")}
            </TabsTrigger>
            <TabsTrigger value="builtin" className="gap-1.5">
              <Library className="size-4" />
              {t("modePicker.autoedit.tabs.builtin")}
            </TabsTrigger>
            <TabsTrigger value="mcp" className="gap-1.5">
              <Plug className="size-4" />
              {t("modePicker.autoedit.tabs.mcp")}
            </TabsTrigger>
            <TabsTrigger value="tutorial" className="gap-1.5">
              <BookOpen className="size-4" />
              {t("modePicker.autoedit.tabs.tutorial")}
            </TabsTrigger>
          </TabsList>
        </div>

        <div className="flex-1 min-h-0 overflow-auto px-6 py-8">
          <TabsContent value="mine" className="mt-0">
            <MyScriptsTab runner={runner} />
          </TabsContent>
          <TabsContent value="builtin" className="mt-0">
            <BuiltinScriptsTab runner={runner} />
          </TabsContent>
          <TabsContent value="mcp" className="mt-0">
            <PlaceholderTab
              icon={<Plug className="size-6" />}
              title={t("modePicker.autoedit.mcp.title")}
              description={t("modePicker.autoedit.mcp.description")}
              empty={t("modePicker.autoedit.mcp.empty")}
            />
          </TabsContent>
          <TabsContent value="tutorial" className="mt-0">
            <PlaceholderTab
              icon={<BookOpen className="size-6" />}
              title={t("modePicker.autoedit.tutorial.title")}
              description={t("modePicker.autoedit.tutorial.description")}
              empty={t("modePicker.autoedit.tutorial.empty")}
            />
          </TabsContent>
        </div>
      </Tabs>
    </TooltipProvider>
  )
}
