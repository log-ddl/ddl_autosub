import { useMemo } from "react";
import { AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  extractDialogueTags,
  findUnclosedDialogueTag,
  formatDialogueTag,
  parseDialoguePreviewTurns,
} from "./dialogue-tags";
import type { TtsSplitMode } from "./types";

interface TextEditorCardProps {
  value: string;
  onChange: (value: string) => void;
  splitMode: TtsSplitMode;
}

function splitLines(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split(/(?<=[.!?…。！？])\s+|\n+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function TextEditorCard({
  value,
  onChange,
  splitMode,
}: TextEditorCardProps) {
  const { t } = useTranslation();

  const tags = useMemo(() => extractDialogueTags(value), [value]);
  const unclosedTag = useMemo(
    () => findUnclosedDialogueTag(value, tags),
    [tags, value],
  );
  const dialogueTurns = useMemo(
    () => (tags.length > 0 ? parseDialoguePreviewTurns(value) : []),
    [tags.length, value],
  );

  const handleAutoCloseTag = () => {
    if (!unclosedTag) return;
    const normalized = value.replace(/\r\n/g, "\n");
    const before = normalized.slice(0, unclosedTag.lineEndOffset).trimEnd();
    const after = normalized.slice(unclosedTag.lineEndOffset);
    const nextText = `${before} {${unclosedTag.tag}}${after}`;
    onChange(nextText);
  };

  const isLine = splitMode === "line";
  const parts =
    tags.length === 0 && splitMode !== "default"
      ? isLine
        ? splitLines(value)
        : splitSentences(value)
      : [];
  const previewTitle = isLine
    ? t("tts.splitMode.linePreviewTitle")
    : t("tts.splitMode.sentencePreviewTitle");

  return (
    <div className="rounded-xl border border-border/60 bg-card/70 p-5 shadow-2xs">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold">{t("tts.text.title")}</h2>
          <p className="text-xs text-muted-foreground">
            {t("tts.text.savedWithoutModel")}
          </p>
        </div>
        <span className="text-xs text-muted-foreground">
          {t("tts.text.characters", { count: value.length })}
        </span>
      </div>
      <Textarea
        data-tts-main-editor
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t("tts.text.placeholder")}
        className="min-h-[260px] resize-y bg-background/70 leading-6"
      />
      {unclosedTag && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <span className="flex items-center gap-1.5">
            <AlertCircle className="size-3.5 shrink-0" />
            {t("tts.dialogue.unclosedHint", {
              tag: formatDialogueTag(unclosedTag.tag),
            })}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-2 font-mono text-[11px]"
            onClick={handleAutoCloseTag}
          >
            {t("tts.dialogue.closeTagButton", {
              tag: formatDialogueTag(unclosedTag.tag),
            })}
          </Button>
        </div>
      )}
      {tags.length > 0 ? (
        <div className="mt-3 rounded-xl border border-primary/20 bg-primary/5 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-primary">
              {t("tts.dialogue.previewTitle")}
            </p>
            <span className="text-xs text-muted-foreground">
              {t("tts.splitMode.previewCount", { count: dialogueTurns.length })}
            </span>
          </div>
          <ol className="mt-2 max-h-40 space-y-1 overflow-y-auto text-xs">
            {dialogueTurns.map((turn, index) => (
              <li
                key={index}
                className="flex items-baseline gap-2 rounded-lg bg-background/70 px-2 py-1"
              >
                <span className="shrink-0 font-medium text-muted-foreground">
                  {index + 1}.
                </span>
                <span
                  className={
                    turn.isNarrator
                      ? "shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                      : "shrink-0 rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary"
                  }
                >
                  {turn.isNarrator
                    ? t("tts.dialogue.narrator")
                    : formatDialogueTag(turn.speaker)}
                </span>
                <span className="min-w-0 truncate text-foreground">
                  {turn.text}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        splitMode !== "default" && (
          <div className="mt-3 rounded-xl border border-primary/20 bg-primary/5 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-primary">{previewTitle}</p>
              {parts.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  {t("tts.splitMode.previewCount", { count: parts.length })}
                </span>
              )}
            </div>
            {parts.length > 0 ? (
              <ol className="mt-2 max-h-40 space-y-1 overflow-y-auto text-xs">
                {parts.map((part, index) => (
                  <li
                    key={index}
                    className="flex items-baseline gap-2 rounded-lg bg-background/70 px-2 py-1"
                  >
                    <span className="shrink-0 font-medium text-muted-foreground">
                      {index + 1}.
                    </span>
                    <span className="min-w-0 truncate text-foreground">
                      {part}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
                {t("tts.splitMode.previewEmpty")}
              </p>
            )}
          </div>
        )
      )}
    </div>
  );
}
