import * as React from "react"
import { Button } from "@/components/ui/button"
import { useTranslation } from "react-i18next"
import type { LogLine } from "@/components/autoedit/use-script-runner"

export function ScriptLogPanel({
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
