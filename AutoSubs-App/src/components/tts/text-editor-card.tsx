import { useTranslation } from "react-i18next";
import { Textarea } from "@/components/ui/textarea";
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
  const isLine = splitMode === "line";
  const parts =
    splitMode !== "default"
      ? isLine
        ? splitLines(value)
        : splitSentences(value)
      : [];
  const previewTitle = isLine
    ? t("tts.splitMode.linePreviewTitle")
    : t("tts.splitMode.sentencePreviewTitle");

  return (
    <div className="rounded-xl border border-border/60 bg-card/70 p-5 shadow-2xs">
      <div className="mb-3 flex items-center justify-between gap-3">
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
      {splitMode !== "default" && (
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
      )}
    </div>
  );
}

