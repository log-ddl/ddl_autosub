import { PanelRight, Type } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useOutputPanelStore } from "@/stores/output-panel-store";
import { useSubtitleDocument } from "@/contexts/SubtitleDocumentContext";

interface TranscriptionHeaderProps {
  onViewSubtitles?: () => void;
  isSubtitleViewerOpen?: boolean;
}

// AutoSubs sub-toolbar. The Resolve/Premiere/After Effects picker and the app
// settings menu now live in the shared WorkspaceShell header above, so this row
// only carries the source panel title plus the AutoSubs-specific caption-style
// and view-subtitles toggles. It always renders (even when the toggles are
// hidden) so the left column's top bar stays aligned with the subtitle viewer
// header on the right.
export function TranscriptionHeader({
  onViewSubtitles,
  isSubtitleViewerOpen = false,
}: TranscriptionHeaderProps) {
  const { t } = useTranslation();
  const { subtitles } = useSubtitleDocument();
  const openOutputPanel = useOutputPanelStore((s) => s.open);
  const hasSubtitles = subtitles.length > 0;

  const showStyle = hasSubtitles;
  const showViewer = Boolean(onViewSubtitles) && !isSubtitleViewerOpen;

  // No AutoSubs-specific toggle to show (integration + settings moved to the
  // shell): render nothing so the source panel starts at the top with no empty
  // toolbar band above it.
  if (!showStyle && !showViewer) return null;

  return (
    <div className="flex h-11 shrink-0 items-center justify-end gap-1 px-2 pt-1">
      <div className="flex items-center gap-1">
      {showStyle && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("actionBar.subtitleStyle", "Caption Style")}
              onClick={() => {
                onViewSubtitles?.();
                openOutputPanel("style");
              }}
            >
              <Type />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t("actionBar.subtitleStyle", "Caption Style")}
          </TooltipContent>
        </Tooltip>
      )}
      {showViewer && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("completion.viewSubtitles", "View Subtitles")}
              onClick={onViewSubtitles}
            >
              <PanelRight />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t("completion.viewSubtitles", "View Subtitles")}
          </TooltipContent>
        </Tooltip>
      )}
      </div>
    </div>
  );
}
