import * as React from "react"
import { Button } from "@/components/ui/button"
import { Play, Settings2 } from "lucide-react"
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
import { TrackCard } from "@/components/autoedit/track-card"
import {
  BUILTIN_CATEGORY_ORDER,
  BUILTIN_SCRIPTS,
  defaultValues,
  type BuiltinScript,
  type OptionSpec,
  type OptionValues,
} from "@/components/autoedit/builtin-scripts"
import { ScriptLogPanel } from "@/components/autoedit/script-log-panel"
import { useScriptRunner } from "@/components/autoedit/use-script-runner"

// Prompts for a script's parameters. Track lists come from the timeline the
// app already polls, so the picker only ever offers tracks that exist.
export function ScriptOptionsDialog({
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

export function BuiltinScriptsTab({
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
