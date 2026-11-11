import { CheckCircle2, FolderOpen } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { TtsController } from "../use-tts-controller";

export function VoiceProfileDialog({
  controller,
}: {
  controller: TtsController;
}) {
  const { t } = useTranslation();
  const {
    profileOpen,
    setProfileOpen,
    selectedModel,
    profileName,
    setProfileName,
    referenceAudioPath,
    referenceText,
    setReferenceText,
    pickReferenceAudio,
    saveProfile,
  } = controller;

  return (
    <Dialog open={profileOpen} onOpenChange={setProfileOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("tts.profile.dialogTitle")}</DialogTitle>
          <DialogDescription>
            {t("tts.profile.compatibility", { model: selectedModel.name })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>{t("tts.profile.name")}</Label>
            <Input
              className="mt-2"
              value={profileName}
              onChange={(event) => setProfileName(event.target.value)}
              placeholder={t("tts.profile.namePlaceholder")}
            />
          </div>
          <div>
            <Label>{t("tts.profile.referenceAudio")}</Label>
            <div className="mt-2 flex gap-2">
              <Input
                readOnly
                value={referenceAudioPath}
                placeholder={t("tts.profile.audioPlaceholder")}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void pickReferenceAudio()}
              >
                <FolderOpen />
                {t("tts.profile.choose")}
              </Button>
            </div>
          </div>
          {controller.provider === "omnivoice" && (
            <div>
              <Label>{t("tts.profile.transcript")}</Label>
              <Textarea
                className="mt-2 min-h-28"
                value={referenceText}
                onChange={(event) => setReferenceText(event.target.value)}
                placeholder={t("tts.profile.transcriptPlaceholder")}
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setProfileOpen(false)}>
            {t("tts.action.cancel")}
          </Button>
          <Button onClick={saveProfile}>
            <CheckCircle2 />
            {t("tts.profile.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
