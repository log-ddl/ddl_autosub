import { useState } from "react";
import {
  Captions,
  Check,
  Download,
  FileAudio,
  FolderOpen,
  Pencil,
  Trash2,
  X,
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AudioWaveformPlayer } from "./audio-waveform-player";
import { toLocalTtsAudioUrl } from "./tts-client";
import { OMNIVOICE_MODEL, type TtsHistoryItem } from "./types";

interface AudioHistoryItemProps {
  item: TtsHistoryItem;
  onRename: (id: string, name: string) => void;
  onRemove: (id: string) => void;
  onReveal: (filePath: string) => void;
  onExport: (filePath: string) => void;
  onExportSrt?: (srtPath: string) => void;
}

export function AudioHistoryItem({
  item,
  onRename,
  onRemove,
  onReveal,
  onExport,
  onExportSrt,
}: AudioHistoryItemProps) {
  const { t, i18n } = useTranslation();
  const displayName = item.name?.trim() || item.text.slice(0, 80);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(displayName);
  const modelName =
    item.modelId === OMNIVOICE_MODEL.id ? OMNIVOICE_MODEL.name : item.modelId;

  const saveName = () => {
    const nextName = draftName.trim();
    if (!nextName) return;
    onRename(item.id, nextName);
    setEditing(false);
  };

  const cancelEditing = () => {
    setDraftName(displayName);
    setEditing(false);
  };

  return (
    <article className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card/70 p-3">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-emerald-500/10 p-2 text-emerald-600 dark:text-emerald-400">
          <FileAudio className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="flex items-center gap-1.5">
              <Input
                autoFocus
                value={draftName}
                maxLength={120}
                onChange={(event) => setDraftName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") saveName();
                  if (event.key === "Escape") cancelEditing();
                }}
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={saveName}
                disabled={!draftName.trim()}
                title={t("tts.history.saveName")}
              >
                <Check />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={cancelEditing}
                title={t("tts.action.cancel")}
              >
                <X />
              </Button>
            </div>
          ) : (
            <div className="flex items-start gap-2">
              <h3
                className="min-w-0 flex-1 truncate text-sm font-medium"
                title={displayName}
              >
                {displayName}
              </h3>
            </div>
          )}
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t("tts.history.voice", { voice: item.voiceLabel })} ·{" "}
            {t("tts.history.model", { model: modelName })} ·{" "}
            {new Date(item.createdAt).toLocaleString(i18n.language)}
          </p>
        </div>
        {!editing && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setEditing(true)}
            title={t("tts.history.rename")}
          >
            <Pencil />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onReveal(item.outputPath)}
          title={t("tts.history.openFolder")}
        >
          <FolderOpen />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onExport(item.outputPath)}
          title={t("tts.history.exportWav")}
        >
          <Download />
        </Button>
        {item.srtPath && onExportSrt && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onExportSrt(item.srtPath!)}
            title={t("tts.history.exportSrt")}
          >
            <Captions />
          </Button>
        )}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              title={t("tts.history.remove")}
            >
              <Trash2 />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("tts.history.deleteTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("tts.history.deleteDescription", { name: displayName })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("tts.action.cancel")}</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => onRemove(item.id)}
              >
                {t("tts.history.confirmDelete")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      <AudioWaveformPlayer source={toLocalTtsAudioUrl(item.outputPath)} />
    </article>
  );
}

