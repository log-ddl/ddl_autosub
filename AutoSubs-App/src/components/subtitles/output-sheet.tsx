import * as React from "react";
import { ChevronLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SpeakerChips } from "@/components/subtitles/speaker-chips";
import { type OutputSection } from "@/stores/output-panel-store";
import type { Speaker, TimelineInfo } from "@/types";
import { cn } from "@/lib/utils";

export interface OutputSheetProps {
  isConnected: boolean;
  closing: boolean;
  focusSection: OutputSection | null;
  onFocusHandled: () => void;
  /** Collapses the sheet and returns to the transcript. */
  onBack: () => void;
  outputTracks: TimelineInfo["outputTracks"];
  speakers: Speaker[];
  onSpeakerChange: (index: number, speaker: Speaker) => void;
}

export function OutputSheet(props: OutputSheetProps) {
  const { t } = useTranslation();
  const {
    closing,
    isConnected,
    focusSection,
    onFocusHandled,
    speakers,
  } = props;

  const speakersRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!focusSection) return;
    const target = focusSection === "speakers" ? speakersRef.current : null;
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
    onFocusHandled();
  }, [focusSection, onFocusHandled]);

  return (
    // A distinct surface, not a silent replacement of the transcript: the
    // header names where you are and how to get back, and the slide-up ties
    // the sheet to the pill that opened it.
    <div
      className={cn(
        "absolute inset-0 z-10 flex flex-col bg-background duration-200",
        closing
          ? "animate-out fade-out slide-out-to-bottom-2"
          : "animate-in fade-in slide-in-from-bottom-2",
      )}
    >
      {/* A plain back link rather than a bordered bar: a full-width strip
          implies something at each end, which is what made a lone button look
          unbalanced. It sits outside the section spacing so it reads as
          attached to the content below rather than as an abandoned row. */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-4 pb-4 pt-2">
          <Button
            type="button"
            variant="ghost"
            className="-ml-1.5 mb-2 h-7 gap-1 px-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
            onClick={props.onBack}
          >
            <ChevronLeft className="size-4" />
            {t("common.back")}
          </Button>
          <div className="space-y-4">
        {!isConnected && (
          <p className="px-1 text-xs text-muted-foreground">
            {t("output.notConnected")}
          </p>
        )}

        {speakers.length > 1 && (
          <section ref={speakersRef} className="space-y-1.5">
            <Label className="pl-1 text-xs text-muted-foreground">
              {t("output.speakers.label", { count: speakers.length })}
            </Label>
            <SpeakerChips
              speakers={speakers}
              onSpeakerChange={props.onSpeakerChange}
              tracks={props.outputTracks}
            />
          </section>
        )}

          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
