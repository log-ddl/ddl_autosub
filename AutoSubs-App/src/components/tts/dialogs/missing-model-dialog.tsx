import { Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { TtsController } from "../use-tts-controller";

export function MissingModelDialog({
  controller,
}: {
  controller: TtsController;
}) {
  const { t } = useTranslation();
  const {
    missingModelOpen,
    setMissingModelOpen,
    selectedModel,
    closeMissingModelPrompt,
    installSelectedModelFromPrompt,
  } = controller;

  return (
    <Dialog
      open={missingModelOpen}
      onOpenChange={(open) =>
        open ? setMissingModelOpen(true) : closeMissingModelPrompt()
      }
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("tts.missing.title")}</DialogTitle>
          <DialogDescription>{t("tts.missing.description")}</DialogDescription>
        </DialogHeader>
        <div className="rounded-xl border border-border bg-card p-3 text-sm">
          <p className="font-medium">{selectedModel.name}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("tts.missing.size", {
              size: selectedModel.estimatedDownloadGb,
            })}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={closeMissingModelPrompt}>
            {t("tts.manager.later")}
          </Button>
          <Button onClick={installSelectedModelFromPrompt}>
            <Download />
            {t("tts.manager.download")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

