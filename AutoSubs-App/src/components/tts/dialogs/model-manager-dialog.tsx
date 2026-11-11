import {
  CheckCircle2,
  Cpu,
  Download,
  HardDrive,
  Loader2,
  Square,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { getTtsProgressLabel } from "../progress-label";
import type { TtsController } from "../use-tts-controller";

export function ModelManagerDialog({
  controller,
}: {
  controller: TtsController;
}) {
  const { t } = useTranslation();
  const {
    managerOpen,
    setManagerOpen,
    selectedModel,
    selectedStatus,
    installModel,
    removeModel,
    busy,
    progress,
    cancelJob,
  } = controller;

  const ready = selectedStatus?.status === "ready";
  const installing = busy && progress?.kind === "install";
  const needsRepair =
    selectedStatus?.status === "incompatible" &&
    Boolean(selectedStatus.installedPath);

  return (
    <Dialog open={managerOpen} onOpenChange={setManagerOpen}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("tts.manager.title")}</DialogTitle>
          <DialogDescription>{t("tts.manager.description")}</DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border border-border/60 bg-card/70 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Cpu className="size-5" />
              </div>
              <div>
                <h3 className="font-semibold">{selectedModel.name}</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t(selectedModel.descriptionKey)}
                </p>
              </div>
            </div>
            {ready && (
              <Badge className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/15 dark:text-emerald-400">
                <CheckCircle2 className="size-3.5" />
                {t("tts.manager.ready")}
              </Badge>
            )}
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
            <div className="rounded-xl bg-muted/35 p-3">
              <p className="text-muted-foreground">
                {t("tts.manager.accelerator")}
              </p>
              <p className="mt-1 font-medium uppercase">
                {selectedStatus?.accelerator || "-"}
              </p>
            </div>
            <div className="rounded-xl bg-muted/35 p-3">
              <p className="text-muted-foreground">
                {t("tts.manager.downloadSize")}
              </p>
              <p className="mt-1 flex items-center gap-1 font-medium">
                <HardDrive className="size-3.5" />~
                {selectedModel.estimatedDownloadGb} GB
              </p>
            </div>
          </div>

          {selectedStatus?.messageKey && (
            <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
              {t(selectedStatus.messageKey)}
            </p>
          )}
          {selectedStatus?.message && (
            <p className="mt-3 text-xs text-destructive">
              {selectedStatus.message}
            </p>
          )}

          {installing && progress ? (
            <div className="mt-5 rounded-xl border border-primary/25 bg-primary/5 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <Loader2 className="size-4 animate-spin text-primary" />
                    {getTtsProgressLabel(progress.stage, t)}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {progress.message}
                  </p>
                </div>
                <span className="text-sm font-semibold text-primary">
                  {Math.round(progress.percent ?? 0)}%
                </span>
              </div>
              <Progress value={progress.percent ?? 2} className="mt-3" />
              <div className="mt-3 flex items-center justify-between gap-3">
                <p className="text-[11px] text-muted-foreground">
                  {t("tts.manager.installKeepOpen")}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void cancelJob()}
                >
                  <Square />
                  {t("tts.action.cancel")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-5 flex gap-2">
              {!ready ? (
                <Button
                  disabled={busy}
                  onClick={() => void installModel()}
                  className="flex-1"
                >
                  <Download />
                  {needsRepair
                    ? t("tts.manager.repairRuntime")
                    : t("tts.manager.download")}
                </Button>
              ) : (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="destructive"
                      disabled={busy}
                      className="flex-1"
                    >
                      <Trash2 />
                      {t("tts.manager.remove")}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        {t("tts.manager.confirmRemoveTitle")}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {t("tts.manager.confirmRemoveBody")}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>
                        {t("tts.action.cancel")}
                      </AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        onClick={() => void removeModel()}
                      >
                        {t("tts.manager.remove")}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setManagerOpen(false)}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

