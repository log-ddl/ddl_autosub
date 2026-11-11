import { AudioLines, Download, Play, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { AudioHistory } from "./audio-history";
import { BatchFolderCard } from "./batch-folder-card";
import { DialogueCastCard } from "./dialogue-cast-card";
import { MissingModelDialog } from "./dialogs/missing-model-dialog";
import { ModelManagerDialog } from "./dialogs/model-manager-dialog";
import { VoiceProfileDialog } from "./dialogs/voice-profile-dialog";
import { GenerationProgress } from "./generation-progress";
import { ModelStatusBadge } from "./model-status-badge";
import { TextEditorCard } from "./text-editor-card";
import { useTtsController } from "./use-tts-controller";
import { VoiceSettingsPanel } from "./voice-settings-panel";

export function TtsWorkspace() {
  const controller = useTtsController();
  const { t } = useTranslation();

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border/60 bg-card/60 px-5 backdrop-blur-md">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <AudioLines className="size-4" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold leading-tight">
              {t("tts.title")}
            </h1>
            <p className="truncate text-[11px] text-muted-foreground">
              {t("tts.subtitle")}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ModelStatusBadge status={controller.selectedStatus} />
          {controller.provider === "omnivoice" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => controller.setManagerOpen(true)}
            >
              <Settings2 />
              {t("tts.modelManager")}
            </Button>
          )}
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden xl:grid-cols-[minmax(420px,1.25fr)_minmax(340px,0.75fr)]">
        <section className="min-h-0 overflow-y-auto border-border/60 p-4 sm:p-5 xl:border-r">
          <div className="w-full space-y-4">
            <TextEditorCard
              value={controller.text}
              onChange={controller.setText}
              splitMode={controller.splitMode}
            />

            <DialogueCastCard controller={controller} />

            {controller.busy && controller.progress && (
              <GenerationProgress
                progress={controller.progress}
                onCancel={() => void controller.cancelJob()}
              />
            )}

            <div className="flex justify-end">
              <Button
                size="lg"
                disabled={controller.busy}
                onClick={() => void controller.generate()}
                className="min-w-48"
              >
                {controller.selectedStatus?.status === "ready" ? (
                  <>
                    <Play />
                    {t("tts.action.generate")}
                  </>
                ) : (
                  <>
                    <Download />
                    {t("tts.action.downloadToGenerate")}
                  </>
                )}
              </Button>
            </div>

            <BatchFolderCard
              batch={controller.batch}
              disabled={controller.busy && !controller.batch.running}
              onStop={() => void controller.cancelJob()}
            />

            <AudioHistory
              items={controller.history}
              onRename={controller.renameHistory}
              onRemove={controller.removeHistory}
              onReveal={(filePath) => void controller.revealAudio(filePath)}
              onExport={(filePath) => void controller.exportAudio(filePath)}
              onExportSrt={(srtPath) => void controller.exportSrt(srtPath)}
            />
          </div>
        </section>

        <VoiceSettingsPanel controller={controller} />
      </div>

      <ModelManagerDialog controller={controller} />
      <MissingModelDialog controller={controller} />
      <VoiceProfileDialog controller={controller} />
    </div>
  );
}
