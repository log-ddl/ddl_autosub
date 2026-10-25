import * as React from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  Loader,
  Send,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { useSubtitleDocument } from "@/contexts/SubtitleDocumentContext";
import { OUTPUT_SHEET_ANIMATION_MS, useOutputPanelStore } from "@/stores/output-panel-store";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ExportPopover, type ExportFormat } from "@/components/common/export-popover";
import type { Speaker, TimelineInfo } from "@/types";
import type { TimelineLanguageMode } from "@/lib/subtitle-documents";
import { OutputSheet } from "@/components/subtitles/output-sheet";

interface OutputPanelProps {
  timelineInfo?: TimelineInfo;
  isConnected: boolean;
  onAddToTimeline: (languageMode?: TimelineLanguageMode) => Promise<void>;
  hasSourceLanguage: boolean;
  onExport: (format: ExportFormat) => Promise<void>;
  isAdding: boolean;
  /** True once a send has completed for the current transcript. */
  justSent: boolean;
  /**
   * The transcript region. It is passed in rather than rendered as a sibling
   * so the sheet can sit on top of it as a real overlay — that keeps the
   * transcript mounted, so it is already there the instant the sheet starts
   * animating away, and the two can never fight over the same flex space.
   */
  children?: React.ReactNode;
}

/**
 * Bottom-anchored output configuration. Renders as two pieces:
 *
 *  - the sheet (only while expanded), which the viewer places in the region
 *    the transcript normally occupies so it gets the full panel height;
 *  - the summary bar + primary action, which is always visible.
 *
 * The summary bar is the whole reason this works: it states what pressing the
 * button will do, so the button can commit immediately instead of opening a
 * confirmation step.
 */
export function OutputPanel({
  timelineInfo,
  isConnected,
  onAddToTimeline,
  hasSourceLanguage,
  onExport,
  isAdding,
  justSent,
  children,
}: OutputPanelProps) {
  const { t } = useTranslation();

  const { subtitles, speakers, updateSpeakers } = useSubtitleDocument();

  const {
    expanded,
    closing,
    focusSection,
    requestClose,
    finishClose,
    toggle,
    clearFocusSection,
  } = useOutputPanelStore(
    useShallow((s) => ({
      expanded: s.expanded,
      closing: s.closing,
      focusSection: s.focusSection,
      requestClose: s.requestClose,
      finishClose: s.finishClose,
      toggle: s.toggle,
      clearFocusSection: s.clearFocusSection,
    })),
  );

  // Tear the sheet down only after its exit animation has run. `expanded`
  // stays true throughout, which is what keeps the transcript from popping in
  // behind the sheet mid-slide.
  React.useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(finishClose, OUTPUT_SHEET_ANIMATION_MS);
    return () => clearTimeout(timer);
  }, [closing, finishClose]);

  const [languageMenuOpen, setLanguageMenuOpen] = React.useState(false);

  const outputTracks = timelineInfo?.outputTracks ?? [];
  const hasSubtitles = subtitles.length > 0;

  // ── Derived state ───────────────────────────────────────────────────────
  const summaryParts: string[] = ["Premiere Pro"];
  if (speakers.length > 1) {
    summaryParts.push(t("output.speakerCount", { count: speakers.length }));
  }

  // ── Actions ─────────────────────────────────────────────────────────────
  function handleToggle() {
    toggle();
  }

  function handleSpeakerChange(index: number, updated: Speaker) {
    const next = [...speakers];
    next[index] = updated;
    updateSpeakers(next);
  }

  async function handlePrimaryAction(mode: TimelineLanguageMode = "translated") {
    setLanguageMenuOpen(false);
    requestClose();
    onAddToTimeline(mode).catch((err) => {
      console.error("Failed to add to timeline:", err);
    });
  }

  const actionDisabled = isAdding || !hasSubtitles;
  // The extension imports one SRT per caption track, so "both" simply runs
  // the import twice (see AdobeContext.pushToTimeline).
  const canChooseLanguage = hasSourceLanguage && !actionDisabled;

  let actionLabel: React.ReactNode;
  if (isAdding) {
    actionLabel = (
      <>
        <Loader className="size-4 animate-spin will-change-transform" />
        {t("addToTimeline.adding")}
      </>
    );
  } else if (!hasSubtitles) {
    actionLabel = t("output.noSubtitles");
  } else if (justSent) {
    // Sending is cheap to repeat and cheap to undo, so confirm what happened
    // and stay ready rather than locking the button.
    actionLabel = (
      <>
        <Check className="size-4" />
        {t("output.sentAgain")}
      </>
    );
  } else {
    actionLabel = (
      <>
        <Send className="size-4" />
        {t("subtitles.addToTimeline")}
      </>
    );
  }

  return (
    <>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {children}
        {expanded && (
          <OutputSheet
            closing={closing}
            isConnected={isConnected}
            focusSection={focusSection}
            onFocusHandled={clearFocusSection}
            onBack={handleToggle}
            outputTracks={outputTracks}
            speakers={speakers}
            onSpeakerChange={handleSpeakerChange}
          />
        )}
      </div>

      {/* Summary + primary action. */}
      <div className="shrink-0 border-t bg-card">
        {/* Without an editor there is nothing to summarise; the row is only
            kept so an expanded sheet still has a way to collapse. */}
        {isConnected && (!expanded || closing) && (
          <div className="px-3 pt-3">
            <button
              type="button"
              onClick={handleToggle}
              aria-expanded={expanded}
              className="flex w-full items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs transition-colors hover:bg-muted/70"
            >
              <span className="min-w-0 flex-1 truncate text-left text-muted-foreground">
                {isConnected ? summaryParts.join(" · ") : t("output.notConnected")}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {expanded ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronUp className="size-3.5" />
                )}
              </span>
            </button>
          </div>
        )}

        <div className="flex justify-end gap-2 p-3">
          {isConnected && !canChooseLanguage && (
            <Button
              type="button"
              variant="secondary"
              className="w-full"
              disabled={actionDisabled}
              onClick={() => handlePrimaryAction()}
            >
              {actionLabel}
            </Button>
          )}

          {/* When the transcript carries both languages, asking here beats
              hiding the choice in the settings sheet: it is the moment the
              answer matters, and each option commits straight away. */}
          {isConnected && canChooseLanguage && (
            <Popover open={languageMenuOpen} onOpenChange={setLanguageMenuOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="secondary"
                  className="w-full"
                  disabled={actionDisabled}
                >
                  {actionLabel}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" side="top" className="w-64 p-1">
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  {t("output.language.prompt")}
                </p>
                {(
                  [
                    ["translated", t("output.language.translated")],
                    ["source", t("output.language.source")],
                    ["both", t("output.language.both")],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => void handlePrimaryAction(mode)}
                    className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                  >
                    <span>{label}</span>
                    {mode === "both" && (
                      <span className="text-xs text-muted-foreground">
                        {t("output.language.bothHint")}
                      </span>
                    )}
                  </button>
                ))}
              </PopoverContent>
            </Popover>
          )}
          <ExportPopover
            onExport={onExport}
            hasSubtitles={hasSubtitles}
            trigger={
              isConnected ? (
                <Button
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  title={t("importExport.exportTab")}
                >
                  <Download />
                </Button>
              ) : (
                <Button variant="secondary" size="default" className="w-full">
                  <Download className="size-4" />
                  {t("importExport.exportTab")}
                </Button>
              )
            }
          />
        </div>
      </div>
    </>
  );
}

