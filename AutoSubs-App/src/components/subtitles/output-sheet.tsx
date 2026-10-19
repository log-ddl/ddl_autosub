import * as React from "react";
import { AlertTriangle, ChevronLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SpeakerChips } from "@/components/subtitles/speaker-chips";
import { CaptionTemplateSelectionContent, type CreatePresetSession, type CreatePresetSubmit } from "@/components/dialogs/caption-style/template-selection";
import { type ConflictInfo } from "@/api/resolve-api";
import { usePresets } from "@/contexts/PresetsContext";
import { type OutputSection } from "@/stores/output-panel-store";
import type { Speaker, Template, TimelineInfo } from "@/types";
import { cn } from "@/lib/utils";

export interface OutputSheetProps {
  isConnected: boolean;
  isAdobe: boolean;
  closing: boolean;
  focusSection: OutputSection | null;
  onFocusHandled: () => void;
  /** Collapses the sheet and returns to the transcript. */
  onBack: () => void;
  outputTracks: TimelineInfo["outputTracks"];
  selectedOutputTrack: string;
  onOutputTrackChange: (value: string) => void;
  conflictInfo: ConflictInfo | null;
  captionMode: "regular" | "animated";
  onCaptionModeChange: (mode: "regular" | "animated") => void;
  selectedTemplate: Template;
  onTemplateChange: (value: string) => void;
  templates: Template[];
  templatesLoading: boolean;
  templatesLoaded: boolean;
  templateLoadError: string | null;
  presetId: string;
  onPresetChange: (id: string) => void;
  presets: ReturnType<typeof usePresets>["presets"];
  createSession: CreatePresetSession;
  onRequestCreate: () => void;
  onRequestEdit: (presetId: string) => void;
  onCreateFlowExit: () => void;
  onSubmitPreset: CreatePresetSubmit;
  editingPreset?: ReturnType<ReturnType<typeof usePresets>["getPreset"]>;
  onDeletePreset: (id: string) => Promise<void> | void;
  onDuplicatePreset: (id: string) => Promise<void> | void;
  onImportPreset: (json: string) => Promise<any>;
  onExportPreset: (id: string) => string;
  hasAnimatedTemplate: boolean;
  speakers: Speaker[];
  onSpeakerChange: (index: number, speaker: Speaker) => void;
}

export function OutputSheet(props: OutputSheetProps) {
  const { t } = useTranslation();
  const {
    closing,
    isConnected,
    isAdobe,
    focusSection,
    onFocusHandled,
    createSession,
    speakers,
  } = props;

  const trackRef = React.useRef<HTMLDivElement>(null);
  const styleRef = React.useRef<HTMLDivElement>(null);
  const speakersRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!focusSection) return;
    const target =
      focusSection === "track"
        ? trackRef.current
        : focusSection === "style"
          ? styleRef.current
          : focusSection === "speakers"
            ? speakersRef.current
            : null;
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
    onFocusHandled();
  }, [focusSection, onFocusHandled]);

  // The preset editor needs the whole sheet — it has its own action buttons.
  if (createSession.kind !== "closed") {
    return (
      <div className="absolute inset-0 z-10 overflow-y-auto bg-background px-3 pb-3">
        <CaptionTemplateSelectionContent
          mode="animated"
          onModeChange={() => {}}
          templateValue={props.selectedTemplate.value}
          onTemplateChange={props.onTemplateChange}
          templates={props.templates}
          templatesLoading={props.templatesLoading}
          templatesLoaded={props.templatesLoaded}
          templateLoadError={props.templateLoadError}
          presetId={props.presetId}
          onPresetChange={props.onPresetChange}
          animatedPresets={props.presets}
          createSession={createSession}
          onRequestCreate={props.onRequestCreate}
          onRequestEdit={(p) => props.onRequestEdit(p.id)}
          onCreateFlowExit={props.onCreateFlowExit}
          onSubmitPreset={props.onSubmitPreset}
          editingInitialSettings={props.editingPreset?.macroSettings}
          editingInitialName={props.editingPreset?.name}
          editingInitialDescription={props.editingPreset?.description}
          onDeletePreset={props.onDeletePreset}
          onDuplicatePreset={(p) => props.onDuplicatePreset(p.id)}
          onImportPreset={props.onImportPreset}
          onExportPreset={props.onExportPreset}
          hasAnimatedTemplate={props.hasAnimatedTemplate}
        />
      </div>
    );
  }

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

        {!isAdobe && (
          <section ref={trackRef} className="space-y-1.5">
            <Label className="pl-1 text-xs text-muted-foreground">
              {t("output.track.label")}
            </Label>
            <Select
              value={props.selectedOutputTrack}
              onValueChange={props.onOutputTrackChange}
            >
              <SelectTrigger className="bg-background">
                <SelectValue placeholder={t("output.track.placeholder")} />
              </SelectTrigger>
              <SelectContent>
                {props.outputTracks.map((track) => (
                  <SelectItem key={track.value} value={track.value}>
                    {track.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {props.conflictInfo?.hasConflicts && (
              <div className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-500">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span className="pl-1">{t("addToTimeline.conflict.hasConflicts")}</span>
              </div>
            )}
          </section>
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

        {/* Style last: it is the only section that grows, so it owns the
            page scroll instead of fighting a nested one. */}
        {!isAdobe && (
          <section ref={styleRef} className="space-y-4">
            <CaptionTemplateSelectionContent
              mode={props.captionMode}
              onModeChange={props.onCaptionModeChange}
              templateValue={props.selectedTemplate.value}
              onTemplateChange={props.onTemplateChange}
              templates={props.templates}
              templatesLoading={props.templatesLoading}
              templatesLoaded={props.templatesLoaded}
              templateLoadError={props.templateLoadError}
              presetId={props.presetId}
              onPresetChange={props.onPresetChange}
              animatedPresets={props.presets}
              createSession={createSession}
              onRequestCreate={props.onRequestCreate}
              onRequestEdit={(p) => props.onRequestEdit(p.id)}
              onCreateFlowExit={props.onCreateFlowExit}
              onSubmitPreset={props.onSubmitPreset}
              onDeletePreset={props.onDeletePreset}
              onDuplicatePreset={(p) => props.onDuplicatePreset(p.id)}
              onImportPreset={props.onImportPreset}
              onExportPreset={props.onExportPreset}
              hasAnimatedTemplate={props.hasAnimatedTemplate}
            />
          </section>
        )}

          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
