import { Button } from "@/components/ui/button"
import {
    Item,
    ItemContent,
    ItemDescription,
    ItemFooter,
    ItemTitle,
} from "@/components/ui/item"
import { Download, FileText, Send, VolumeX } from "lucide-react"
import { ExportPopover } from "@/components/common/export-popover"
import { TimelineInfo } from "@/types"
import { useSubtitleDocument } from "@/contexts/SubtitleDocumentContext"
import { useOutputPanelStore } from "@/stores/output-panel-store"
import { useTranslation } from "react-i18next"

export interface CompletionStepProps {
    onExportToFile: () => void;
    onViewSubtitles?: () => void;
    isSubtitleViewerOpen?: boolean;
    timelineInfo: TimelineInfo;
}

export function CompletionStepItem({
    onViewSubtitles,
    isSubtitleViewerOpen = false,
    timelineInfo,
}: CompletionStepProps) {
    const { t } = useTranslation()
    const openOutputPanel = useOutputPanelStore((s) => s.open)
    const {
        subtitles,
        speakers,
        exportSubtitlesAs,
    } = useSubtitleDocument()

    const isConnected = Boolean(timelineInfo?.timelineId)
    const hasSubtitles = subtitles.length > 0

    // Sending happens in the viewer's output sheet, where the settings are
    // visible. This button navigates there rather than committing, so it is
    // labelled for what it actually does.
    function handleReviewAndSend() {
        openOutputPanel()
        onViewSubtitles?.()
    }

    return (
        <div className="flex w-full flex-col gap-2">
            <Item variant="default" className="bg-muted/30 border-muted-foreground/20">
                <ItemContent className="px-2">
                    <ItemTitle>
                        {t("completion.processingComplete")}
                    </ItemTitle>
                    <ItemDescription>
                        {hasSubtitles ? (
                            t("completion.subtitlesReady")
                        ) : (
                            <span className="flex items-center gap-2">
                                <VolumeX className="size-4 shrink-0 text-muted-foreground" />
                                {t("completion.noSpeechDetected")}
                            </span>
                        )}
                    </ItemDescription>
                </ItemContent>
                {hasSubtitles && (
                    <ItemFooter>
                        <div className="flex gap-2">
                            {onViewSubtitles && !isSubtitleViewerOpen && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={onViewSubtitles}
                                  className="flex items-center gap-2"
                                >
                                  <FileText />
                                  {t("completion.viewSubtitles")}
                                </Button>
                            )}
                            <ExportPopover
                                onExport={(format) => exportSubtitlesAs(format, subtitles, speakers)}
                                hasSubtitles={hasSubtitles}
                                trigger={
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="flex items-center gap-2"
                                    >
                                        <Download />
                                        {t("completion.exportToFile")}
                                    </Button>
                                }
                            />
                            {isConnected && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="flex items-center gap-2"
                                    onClick={handleReviewAndSend}
                                >
                                    <Send />
                                    {t("output.reviewAndSend")}
                                </Button>
                            )}
                        </div>
                    </ItemFooter>
                )}
            </Item>
        </div>
    )
}
