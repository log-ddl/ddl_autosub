import { History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SubtitleList } from "@/components/subtitles/subtitle-list";
import { TranscriptHistoryPopover } from "@/components/subtitles/transcript-history-popover";
import { type SubtitleDocumentListItem } from "@/lib/subtitle-documents";

export interface SubtitleContentProps {
  subtitlesLength: number;
  searchQuery: string;
  searchCaseSensitive: boolean;
  searchWholeWord: boolean;
  selectedIndex: number | null;
  onSelectedIndexChange: (index: number | null) => void;
  onJumpToTime: (seconds: number) => Promise<void>;
  onMatchCountChange: (count: number) => void;
  t: (key: string) => string;
  transcriptDocuments: SubtitleDocumentListItem[];
  isLoadingTranscriptDocuments: boolean;
  onTranscriptDocumentsRefresh: () => Promise<void>;
}

export function SubtitleContent({
  subtitlesLength,
  searchQuery,
  searchCaseSensitive,
  searchWholeWord,
  selectedIndex,
  onSelectedIndexChange,
  onJumpToTime,
  onMatchCountChange,
  t,
  transcriptDocuments,
  isLoadingTranscriptDocuments,
  onTranscriptDocumentsRefresh,
}: SubtitleContentProps) {
  const contentClassName =
    subtitlesLength > 0
      ? "flex-1 overflow-y-auto min-h-0 px-0 relative z-0"
      : "flex-1 overflow-hidden min-h-0 px-0 relative z-0";

  return (
    <div className={contentClassName}>
      {subtitlesLength > 0 ? (
        <SubtitleList
          searchQuery={searchQuery}
          searchCaseSensitive={searchCaseSensitive}
          searchWholeWord={searchWholeWord}
          selectedIndex={selectedIndex}
          onSelectedIndexChange={onSelectedIndexChange}
          onJumpToTime={onJumpToTime}
          onMatchCountChange={onMatchCountChange}
          itemClassName="hover:bg-muted dark:hover:bg-slate-900 transition-colors"
        />
      ) : (
        <div className="flex h-full min-h-0 flex-col items-center justify-center px-8 text-center">
          <p className="text-sm text-foreground">
            {t("subtitles.empty.noSubtitlesAvailable")}
          </p>
          <TranscriptHistoryPopover
            subtitleDocuments={transcriptDocuments}
            isLoading={isLoadingTranscriptDocuments}
            onTranscriptOpen={() => {}}
            onRefresh={onTranscriptDocumentsRefresh}
            align="center"
            side="top"
            trigger={
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-4"
                aria-label={t("subtitles.previousSubtitles")}
              >
                <History className="size-4" />
                {t("subtitles.previousSubtitles")}
              </Button>
            }
          />
        </div>
      )}
    </div>
  );
}
