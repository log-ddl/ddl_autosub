import * as React from "react";
import { platform } from "@tauri-apps/plugin-os";
import { FileUp, History, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type ExportFormat } from "@/components/common/export-popover";
import { OutputPanel } from "@/components/subtitles/output-panel";
import { TranscriptStatusRow } from "@/components/subtitles/transcript-status-row";
import { TranscriptHistoryPopover } from "@/components/subtitles/transcript-history-popover";
import { useSubtitleDocument } from "@/contexts/SubtitleDocumentContext";
import { useAdobe } from "@/contexts/AdobeContext";
import { useSettingsStore } from "@/stores/settings-store";
import { useOutputPanelStore } from "@/stores/output-panel-store";
import { useAudioPreview } from "@/contexts/AudioPreviewContext";
import { useErrorDialog } from "@/contexts/ErrorDialogContext";
import { describeError } from "@/components/transcription/utils";
import { useTranslation } from "react-i18next";
import { type SubtitleDocumentListItem, type TimelineLanguageMode } from "@/lib/subtitle-documents";
import { SearchSection } from "@/components/subtitles/search-section";
import { SubtitleContent } from "@/components/subtitles/subtitle-content";

interface SubtitleViewerPanelProps {
  isOpen?: boolean;
  isFullScreen?: boolean;
  onClose?: () => void;
  transcriptDocuments: SubtitleDocumentListItem[];
  isLoadingTranscriptDocuments: boolean;
  onTranscriptDocumentsRefresh: () => Promise<void>;
}

export function SubtitleViewerPanel({
  isOpen = true,
  isFullScreen = false,
  onClose,
  transcriptDocuments,
  isLoadingTranscriptDocuments,
  onTranscriptDocumentsRefresh,
}: SubtitleViewerPanelProps) {
  const [searchQuery, setSearchQuery] = React.useState("");
  const [searchCaseSensitive, setSearchCaseSensitive] = React.useState(false);
  const [searchWholeWord, setSearchWholeWord] = React.useState(false);
  const [showReplace, setShowReplace] = React.useState(false);
  const [replaceValue, setReplaceValue] = React.useState("");
  const [selectedIndex, setSelectedIndex] = React.useState<number | null>(null);
  const [showReformat, setShowReformat] = React.useState(false);
  const [matchCount, setMatchCount] = React.useState(0);
  const [isAddingToTimeline, setIsAddingToTimeline] = React.useState(false);
  const [justSent, setJustSent] = React.useState(false);
  const [isMacOs, setIsMacOs] = React.useState(true);
  const searchInputRef = React.useRef<HTMLInputElement>(null);

  const {
    subtitles,
    currentSubtitleDocumentFilename,
    currentSubtitleDocumentSourceName,
    updateSubtitles,
    flushPendingSubtitleSave,
    exportSubtitlesAs,
    importSubtitles,
    reformatSubtitles,
    speakers,
    hasSourceLanguage,
  } = useSubtitleDocument();

  const {
    timelineInfo,
    isConnected: isIntegrationConnected,
    pushToTimeline,
    jumpToTime,
  } = useAdobe();

  // The store keeps `expanded` true through the sheet's exit animation, but
  // the viewer's chrome — title, document actions, header rule — should revert
  // as soon as the close starts, otherwise it reads as lag.
  const outputActive = useOutputPanelStore((s) => s.expanded && !s.closing);
  const requestCloseOutputPanel = useOutputPanelStore((s) => s.requestClose);
  const resetOutputPanel = useOutputPanelStore((s) => s.reset);

  const { seekToTime: seekAudioPreview } = useAudioPreview();
  const { showError } = useErrorDialog();

  // When a timestamp is clicked, jump the connected timeline AND seek the
  // local audio preview (if one is loaded) to the same position.
  const handleJumpToTime = React.useCallback(
    async (seconds: number) => {
      seekAudioPreview(seconds);
      await jumpToTime(seconds);
    },
    [jumpToTime, seekAudioPreview],
  );

  const { t } = useTranslation();
  const hasSubtitles = subtitles.length > 0;

  React.useEffect(() => {
    setJustSent(false);
  }, [subtitles]);

  React.useEffect(() => {
    try {
      setIsMacOs(platform() === "macos");
    } catch {
      setIsMacOs(true);
    }
  }, []);

  // Reopening the viewer should always land on the transcript, never on a
  // sheet left expanded from a previous session.
  React.useEffect(() => resetOutputPanel, [resetOutputPanel]);

  React.useEffect(() => {
    if (!isOpen || !onClose) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Escape backs out of the output sheet first; only a second press
        // closes the whole panel.
        if (useOutputPanelStore.getState().expanded) {
          requestCloseOutputPanel();
          return;
        }
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose, requestCloseOutputPanel]);

  

  const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const buildFindRegExp = React.useCallback(() => {
    const q = (searchQuery ?? "").trim();
    if (!q) return null;
    const escaped = escapeRegExp(q);
    const pattern = searchWholeWord ? `\\b${escaped}\\b` : escaped;
    const flags = searchCaseSensitive ? "g" : "gi";
    return new RegExp(pattern, flags);
  }, [searchCaseSensitive, searchQuery, searchWholeWord]);

  const canReplace = Boolean(searchQuery.trim());
  const shellClassName = "flex h-full min-h-0 flex-col overflow-hidden";
  const headerClassName = "shrink-0 p-3 pt-0 pb-1";

  const handleReplaceAll = () => {
    const re = buildFindRegExp();
    if (!re) return;
    const next = subtitles.map((s) => ({
      ...s,
      text: (s.text ?? "").replace(re, replaceValue),
    }));
    updateSubtitles(next);
  };

  const handleApplyReformat = async () => {
    await flushPendingSubtitleSave();
    const timelineId = timelineInfo?.timelineId || "";
    await reformatSubtitles(useSettingsStore.getState(), null, timelineId);
    setShowReformat(false);
  };

  const handleAddToTimeline = async (languageMode?: TimelineLanguageMode) => {
    try {
      if (!currentSubtitleDocumentFilename) {
        console.error("No active subtitle document to add to timeline");
        return;
      }

      // Flush any debounced subtitle edits to disk before the SRT is written
      // from it.
      await flushPendingSubtitleSave();

      setIsAddingToTimeline(true);
      await pushToTimeline(currentSubtitleDocumentFilename, languageMode);
      setJustSent(true);
    } catch (error) {
      console.error("Failed to add to timeline:", error);
      const { title, message, detail } = describeError(
        error,
        t("errorDialog.addToTimelineFailed", "Couldn't add subtitles to timeline"),
      );
      showError({ title, message, detail });
    } finally {
      setIsAddingToTimeline(false);
    }
  };

  const handleExport = React.useCallback(
    async (format: ExportFormat) => {
      await exportSubtitlesAs(format, subtitles, speakers);
    },
    [exportSubtitlesAs, subtitles, speakers],
  );

  if (!isOpen) return null;

  return (
    <div className={shellClassName}>
      <div
        className={`flex h-12 shrink-0 items-center justify-between gap-3 border-b pr-2 transition-colors duration-150 ${outputActive ? "border-border" : "border-transparent"} ${isFullScreen && isMacOs ? "pl-24" : "pl-4"}`}
        data-tauri-drag-region={isMacOs ? true : undefined}
      >
        <div className="min-w-0">
          {/* The drag attribute has to be on the element the pointer actually
              lands on, so it belongs on the heading itself — a mousedown on
              the text hits the h2, not its wrapper. */}
          <h2
            className="font-semibold select-none truncate"
            data-tauri-drag-region={isMacOs ? true : undefined}
          >
            {outputActive ? t("output.title") : t("subtitles.title")}
          </h2>
        </div>
        <div
          className="z-20 flex items-center"
          data-tauri-drag-region={isMacOs ? "false" : undefined}
        >
          {/* Document actions belong to the transcript, so they go away while
              the output sheet is up. That leaves only the panel close here,
              which reinforces that the sheet is a different mode — and stops
              these being clicked in a context where they don't apply. */}
          {!outputActive && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => importSubtitles(useSettingsStore.getState(), null, "")}
                  >
                    <FileUp />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {t("importExport.importTab")}
                </TooltipContent>
              </Tooltip>
              <TranscriptHistoryPopover
                subtitleDocuments={transcriptDocuments}
                isLoading={isLoadingTranscriptDocuments}
                onTranscriptOpen={() => {}}
                onRefresh={onTranscriptDocumentsRefresh}
                tooltipLabel={t("subtitles.previousSubtitles")}
                trigger={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("subtitles.previousSubtitles")}
                  >
                    <History />
                  </Button>
                }
              />
            </>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            disabled={!onClose}
          >
            <X />
          </Button>
        </div>
      </div>

      {/* The transcript is handed to OutputPanel so the settings sheet can
          overlay it rather than replace it — it stays mounted (keeping scroll
          position) and is already on screen as the sheet animates away. */}
      <OutputPanel
        timelineInfo={timelineInfo}
        isConnected={isIntegrationConnected}
        onAddToTimeline={handleAddToTimeline}
        hasSourceLanguage={hasSourceLanguage}
        onExport={handleExport}
        isAdding={isAddingToTimeline}
        justSent={justSent}
      >
        {hasSubtitles && (
          <SearchSection
            headerClassName={headerClassName}
            t={t}
            searchQuery={searchQuery}
            replaceValue={replaceValue}
            searchCaseSensitive={searchCaseSensitive}
            searchWholeWord={searchWholeWord}
            showReplace={showReplace}
            canReplace={canReplace}
            searchInputRef={searchInputRef}
            onSearchQueryChange={setSearchQuery}
            onReplaceValueChange={setReplaceValue}
            onToggleCaseSensitive={() =>
              setSearchCaseSensitive((value) => !value)
            }
            onToggleWholeWord={() => setSearchWholeWord((value) => !value)}
            onToggleReplace={() => setShowReplace((value) => !value)}
            onReplaceAll={handleReplaceAll}
            searchPlaceholder={t("subtitles.searchPlaceholder")}
            searchAriaLabel={t("subtitles.searchAria")}
          />
        )}

        {hasSubtitles && (
          <TranscriptStatusRow
            sourceName={currentSubtitleDocumentSourceName}
            subtitleCount={subtitles.length}
            matchCount={searchQuery.trim() ? matchCount : null}
            showReformat={showReformat}
            onReformatOpenChange={setShowReformat}
            onApplyReformat={handleApplyReformat}
          />
        )}

        <SubtitleContent
          subtitlesLength={subtitles.length}
          searchQuery={searchQuery}
          searchCaseSensitive={searchCaseSensitive}
          searchWholeWord={searchWholeWord}
          selectedIndex={selectedIndex}
          onSelectedIndexChange={setSelectedIndex}
          onJumpToTime={handleJumpToTime}
          onMatchCountChange={setMatchCount}
          t={t}
          transcriptDocuments={transcriptDocuments}
          isLoadingTranscriptDocuments={isLoadingTranscriptDocuments}
          onTranscriptDocumentsRefresh={onTranscriptDocumentsRefresh}
        />
      </OutputPanel>
    </div>
  );
}
