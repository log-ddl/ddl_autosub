import { PanelRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface TranscriptionHeaderProps {
  onViewSubtitles?: () => void;
  isSubtitleViewerOpen?: boolean;
}

// AutoSubs sub-toolbar. The Premiere status and the app settings menu live in
// the shared WorkspaceShell header above, so this row only carries the
// view-subtitles toggle.
export function TranscriptionHeader({
  onViewSubtitles,
  isSubtitleViewerOpen = false,
}: TranscriptionHeaderProps) {
  const { t } = useTranslation();
  const showViewer = Boolean(onViewSubtitles) && !isSubtitleViewerOpen;

  // Nothing to show: render nothing so the source panel starts at the top
  // with no empty toolbar band above it.
  if (!showViewer) return null;

  return (
    <div className="flex h-11 shrink-0 items-center justify-end gap-1 px-2 pt-1">
      <div className="flex items-center gap-1">
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
