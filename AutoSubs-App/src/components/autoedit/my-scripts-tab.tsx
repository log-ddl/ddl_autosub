import * as React from "react"
import { Button } from "@/components/ui/button"
import {
  FileCode2,
  Play,
  Upload,
  X,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { useSavedScripts } from "@/lib/saved-scripts"
import { ScriptLogPanel } from "@/components/autoedit/script-log-panel"
import { useScriptRunner } from "@/components/autoedit/use-script-runner"

// "My scripts": import a .py once, and it's saved for re-running later. Files
// are kept as path references (not copied), matching how the runner resolves
// them at launch.
export function MyScriptsTab({
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
