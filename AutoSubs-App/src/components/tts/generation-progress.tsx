import { Loader2, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { getTtsProgressLabel } from "./progress-label";
import type { TtsProgressEvent } from "./types";

interface GenerationProgressProps {
  progress: TtsProgressEvent;
  onCancel: () => void;
}

export function GenerationProgress({
  progress,
  onCancel,
}: GenerationProgressProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-2 rounded-xl border border-primary/25 bg-primary/5 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Loader2 className="size-4 animate-spin text-primary" />
            {getTtsProgressLabel(progress.stage, t)}
          </div>
          <p
            className="mt-1 truncate text-xs text-muted-foreground"
            title={
              progress.message.startsWith("tts.")
                ? t(progress.message)
                : progress.message
            }
          >
            {progress.message.startsWith("tts.")
              ? t(progress.message)
              : progress.message}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="text-sm font-semibold text-primary">
            {Math.round(progress.percent ?? 0)}%
          </span>
          <Button variant="outline" size="sm" onClick={onCancel}>
            <Square />
            {t("tts.action.cancel")}
          </Button>
        </div>
      </div>
      <Progress value={progress.percent ?? 20} />
    </div>
  );
}
