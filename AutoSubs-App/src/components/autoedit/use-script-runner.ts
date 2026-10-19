import * as React from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { ResolveApiError } from "@/api/resolve-api"
import { runPythonScript } from "@/api/autoedit-api"

export interface LogLine {
  stream: "stdout" | "stderr" | "system"
  line: string
}

export interface RunnerOutputPayload {
  stream: "stdout" | "stderr"
  line: string
}

export interface RunnerDonePayload {
  exit_code: number | null
  error: string | null
}

// Shared runner state — only one script may run at a time, all consumers see
// the same log stream so switching tabs mid-run doesn't lose output.
export function useScriptRunner() {
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
