import { ProviderSelector, ProviderSettings } from "./provider-settings";
import { useState } from "react";
import {
  ChevronDown,
  Cpu,
  Download,
  Gauge,
  Languages,
  Mic2,
  RotateCcw,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  UserRoundPlus,
  WandSparkles,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { LanguagePickerDialog } from "./dialogs/language-picker-dialog";
import { ModelStatusBadge } from "./model-status-badge";
import type { TtsMode, TtsSplitMode } from "./types";
import type { TtsController } from "./use-tts-controller";

interface VoiceSettingsPanelProps {
  controller: TtsController;
}

const MODES: Array<{ id: TtsMode; icon: typeof Mic2; labelKey: string }> = [
  { id: "clone", icon: Mic2, labelKey: "tts.mode.clone" },
  { id: "design", icon: WandSparkles, labelKey: "tts.mode.design" },
  { id: "auto", icon: Sparkles, labelKey: "tts.mode.auto" },
];

function NumberSetting({
  label,
  description,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/55 p-2.5">
      <div className="flex items-center justify-between gap-3">
        <Label className={`text-xs ${disabled ? "text-muted-foreground" : ""}`}>
          {label}
        </Label>
        <Input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) {
              onChange(Math.min(max, Math.max(min, next)));
            }
          }}
          className="h-7 w-16 bg-background px-2 text-right text-xs"
        />
      </div>
      <p className="mt-1 text-[11px] leading-3.5 text-muted-foreground">
        {description}
      </p>
    </div>
  );
}

function BooleanSetting({
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-border/60 bg-background/55 p-2.5">
      <div>
        <Label className={`text-xs ${disabled ? "text-muted-foreground" : ""}`}>
          {label}
        </Label>
        <p className="mt-1 text-[11px] leading-3.5 text-muted-foreground">
          {description}
        </p>
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

export function VoiceSettingsPanel({ controller }: VoiceSettingsPanelProps) {
  const { t } = useTranslation();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [languagePickerOpen, setLanguagePickerOpen] = useState(false);

  const {
    selectedModel,
    selectedStatus,
    currentModelLabel,
    installModel,
    setManagerOpen,
    busy,
    mode,
    setMode,
    instruction,
    setInstruction,
    compatibleProfiles,
    selectedProfile,
    selectedProfileId,
    setSelectedProfileId,
    removeVoiceProfile,
    setProfileOpen,
    language,
    setLanguage,
    speed,
    setSpeed,
    numStep,
    setNumStep,
    splitMode,
    setSplitMode,
    savedLanguages,
    addSavedLanguage,
    removeSavedLanguage,
    advancedEnabled,
    setAdvancedEnabled,
    advancedSettings,
    setAdvancedSetting,
    resetAdvancedSettings,
  } = controller;

  const needsRepair =
    selectedStatus?.status === "incompatible" &&
    Boolean(selectedStatus.installedPath);

  if (controller.provider !== "omnivoice")
    return (
      <ProviderSettings key={controller.provider} controller={controller} />
    );

  return (
    <aside className="min-h-0 overflow-y-auto bg-card/30 p-5">
      <div className="space-y-5">
        <ProviderSelector controller={controller} />
        <section className="rounded-xl border border-border/60 bg-card/70 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Cpu className="size-4 shrink-0 text-primary" />
                <span>{selectedModel.name}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {currentModelLabel}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <ModelStatusBadge status={selectedStatus} />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => setManagerOpen(true)}
                title={t("tts.modelManager")}
              >
                <Settings2 className="size-3.5" />
              </Button>
            </div>
          </div>
          {selectedStatus?.status !== "ready" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3 w-full"
              disabled={busy}
              onClick={() => void installModel()}
            >
              <Download />
              {needsRepair
                ? t("tts.manager.repairRuntime")
                : t("tts.manager.download")}
            </Button>
          )}
        </section>

        <section>
          <Label>{t("tts.settings.voiceMode")}</Label>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {MODES.map(({ id, icon: Icon, labelKey }) => (
              <button
                key={id}
                type="button"
                onClick={() => setMode(id)}
                className={`rounded-xl border px-2 py-3 text-xs transition-colors ${
                  mode === id
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border/60 bg-background/60 text-muted-foreground hover:border-primary/40 hover:text-foreground"
                }`}
              >
                <Icon className="mx-auto mb-1.5 size-4" />
                {t(labelKey)}
              </button>
            ))}
          </div>
        </section>

        <section className="space-y-3 border-t border-border/60 pt-5">
          <div>
            <Label>{t("tts.splitMode.title")}</Label>
            <Select
              value={splitMode}
              onValueChange={(value) => setSplitMode(value as TtsSplitMode)}
            >
              <SelectTrigger className="mt-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">
                  {t("tts.splitMode.default")}
                </SelectItem>
                <SelectItem value="line">{t("tts.splitMode.line")}</SelectItem>
                <SelectItem value="sentence">
                  {t("tts.splitMode.sentence")}
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
              {t("tts.splitMode.hint")}
            </p>
          </div>
        </section>

        <section className="border-t border-border/60 pt-5">
          {mode === "clone" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2">
                <Label>{t("tts.profile.title")}</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setProfileOpen(true)}
                >
                  <UserRoundPlus />
                  {t("tts.profile.create")}
                </Button>
              </div>
              {compatibleProfiles.length > 0 ? (
                <Select
                  value={selectedProfileId ?? ""}
                  onValueChange={setSelectedProfileId}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("tts.profile.select")} />
                  </SelectTrigger>
                  <SelectContent>
                    {compatibleProfiles.map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>
                        {profile.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <button
                  type="button"
                  onClick={() => setProfileOpen(true)}
                  className="w-full rounded-xl border border-dashed border-border p-6 text-center transition-colors hover:bg-muted/30"
                >
                  <Mic2 className="mx-auto size-6 text-muted-foreground" />
                  <p className="mt-2 text-sm font-medium">
                    {t("tts.profile.empty")}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("tts.profile.emptyHint")}
                  </p>
                </button>
              )}
              {selectedProfile && (
                <div className="rounded-xl border border-border/60 bg-card/60 p-3 text-xs">
                  <p className="font-medium">{selectedProfile.name}</p>
                  <p
                    className="mt-1 truncate text-muted-foreground"
                    title={selectedProfile.referenceAudioPath}
                  >
                    {selectedProfile.referenceAudioPath}
                  </p>
                  <p className="mt-2 line-clamp-3 text-muted-foreground">
                    {selectedProfile.referenceText}
                  </p>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    className="mt-3"
                    onClick={() => removeVoiceProfile(selectedProfile.id)}
                  >
                    <Trash2 />
                    {t("tts.profile.remove")}
                  </Button>
                </div>
              )}
            </div>
          )}

          {mode === "design" && (
            <div>
              <Label>{t("tts.settings.designPrompt")}</Label>
              <Textarea
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                placeholder={t("tts.settings.designPlaceholder")}
                className="mt-2 min-h-28 bg-background"
              />
              {language === "vi" && (
                <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
                  {t("tts.settings.designVietnameseWarning")}
                </p>
              )}
            </div>
          )}

          {mode === "auto" && (
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm">
              <div className="flex items-center gap-2 font-medium">
                <Sparkles className="size-4 text-primary" />
                {t("tts.mode.auto")}
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                {t("tts.settings.autoDescription")}
              </p>
            </div>
          )}
        </section>

        <section className="space-y-4 border-t border-border/60 pt-5">
          <div>
            <Label>{t("tts.settings.language")}</Label>
            <Select value={language} onValueChange={setLanguage}>
              <SelectTrigger className="mt-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="vi">{t("tts.language.vi")}</SelectItem>
                <SelectItem value="en">{t("tts.language.en")}</SelectItem>
                {savedLanguages
                  .filter((item) => item.code !== "vi" && item.code !== "en")
                  .map((item) => (
                    <SelectItem key={item.code} value={item.code}>
                      {item.name} ({item.code})
                    </SelectItem>
                  ))}
                <SelectItem value="auto">{t("tts.language.auto")}</SelectItem>
              </SelectContent>
            </Select>
            <div className="mt-2 flex items-center justify-between gap-2">
              <p className="text-[11px] leading-4 text-muted-foreground">
                {t("tts.language.supportedCount")}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => setLanguagePickerOpen(true)}
              >
                <Languages className="size-3.5" />
                {t("tts.language.add")}
              </Button>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between gap-3">
              <Label>{t("tts.settings.speed")}</Label>
              <span className="text-xs font-medium text-primary">
                {speed.toFixed(2)}×
              </span>
            </div>
            <input
              type="range"
              min="0.75"
              max="1.5"
              step="0.05"
              value={speed}
              onChange={(event) => setSpeed(Number(event.target.value))}
              className="mt-3 w-full accent-primary"
            />
          </div>

          <div>
            <Label className="flex items-center gap-2">
              <Gauge className="size-3.5" />
              {t("tts.settings.quality")}
            </Label>
            <Select
              value={String(numStep)}
              onValueChange={(value) => setNumStep(Number(value))}
            >
              <SelectTrigger className="mt-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {advancedEnabled && (
                  <SelectItem value="8">{t("tts.quality.preview")}</SelectItem>
                )}
                {advancedEnabled && (
                  <SelectItem value="12">{t("tts.quality.draft")}</SelectItem>
                )}
                <SelectItem value="16">{t("tts.quality.fast")}</SelectItem>
                <SelectItem value="24">{t("tts.quality.balanced")}</SelectItem>
                <SelectItem value="32">{t("tts.quality.high")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </section>

        <section className="border-t border-border/60 pt-5">
          <Collapsible
            open={advancedOpen}
            onOpenChange={setAdvancedOpen}
            className="rounded-xl border border-border/60 bg-card/55"
          >
            <div className="flex items-center justify-between gap-3 p-3.5">
              <div>
                <Label
                  htmlFor="tts-advanced"
                  className="flex items-center gap-2 text-sm"
                >
                  <SlidersHorizontal className="size-4 text-primary" />
                  {t("tts.advanced.title")}
                </Label>
                <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                  {advancedEnabled
                    ? t("tts.advanced.enabledHint")
                    : t("tts.advanced.disabledHint")}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <CollapsibleTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0"
                    aria-label={
                      advancedOpen
                        ? t("tts.advanced.collapse")
                        : t("tts.advanced.expand")
                    }
                  >
                    <ChevronDown
                      className={`size-4 text-muted-foreground transition-transform duration-200 ${advancedOpen ? "rotate-180" : ""}`}
                    />
                  </Button>
                </CollapsibleTrigger>
                <Switch
                  id="tts-advanced"
                  checked={advancedEnabled}
                  onCheckedChange={(checked) => {
                    setAdvancedEnabled(checked);
                    if (checked) setAdvancedOpen(true);
                  }}
                  aria-label={t("tts.advanced.title")}
                />
              </div>
            </div>

            <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-2">
              <div className="space-y-3 border-t border-border/60 p-3">
                <div>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold">
                      {t("tts.advanced.performance")}
                    </p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={!advancedEnabled}
                      onClick={resetAdvancedSettings}
                      className="h-7 px-2 text-[11px]"
                    >
                      <RotateCcw className="size-3" />
                      {t("tts.advanced.reset")}
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <NumberSetting
                      label={t("tts.advanced.chunkDuration")}
                      description={t("tts.advanced.chunkDurationHint")}
                      value={advancedSettings.audioChunkDuration}
                      min={5}
                      max={60}
                      step={1}
                      disabled={!advancedEnabled}
                      onChange={(value) =>
                        setAdvancedSetting("audioChunkDuration", value)
                      }
                    />
                    <NumberSetting
                      label={t("tts.advanced.chunkThreshold")}
                      description={t("tts.advanced.chunkThresholdHint")}
                      value={advancedSettings.audioChunkThreshold}
                      min={5}
                      max={120}
                      step={1}
                      disabled={!advancedEnabled}
                      onChange={(value) =>
                        setAdvancedSetting("audioChunkThreshold", value)
                      }
                    />
                  </div>
                  <p className="mt-1.5 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-4 text-amber-700 dark:text-amber-400">
                    {t("tts.advanced.lowVramHint")}
                  </p>
                </div>

                <div>
                  <p className="mb-2 text-xs font-semibold">
                    {t("tts.advanced.voiceBehavior")}
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <NumberSetting
                      label={t("tts.advanced.guidanceScale")}
                      description={t("tts.advanced.guidanceScaleHint")}
                      value={advancedSettings.guidanceScale}
                      min={0}
                      max={5}
                      step={0.1}
                      disabled={!advancedEnabled}
                      onChange={(value) =>
                        setAdvancedSetting("guidanceScale", value)
                      }
                    />
                    <NumberSetting
                      label={t("tts.advanced.tShift")}
                      description={t("tts.advanced.tShiftHint")}
                      value={advancedSettings.tShift}
                      min={0}
                      max={1}
                      step={0.05}
                      disabled={!advancedEnabled}
                      onChange={(value) => setAdvancedSetting("tShift", value)}
                    />
                    <NumberSetting
                      label={t("tts.advanced.positionTemperature")}
                      description={t("tts.advanced.positionTemperatureHint")}
                      value={advancedSettings.positionTemperature}
                      min={0}
                      max={10}
                      step={0.5}
                      disabled={!advancedEnabled}
                      onChange={(value) =>
                        setAdvancedSetting("positionTemperature", value)
                      }
                    />
                    <NumberSetting
                      label={t("tts.advanced.classTemperature")}
                      description={t("tts.advanced.classTemperatureHint")}
                      value={advancedSettings.classTemperature}
                      min={0}
                      max={10}
                      step={0.5}
                      disabled={!advancedEnabled}
                      onChange={(value) =>
                        setAdvancedSetting("classTemperature", value)
                      }
                    />
                    <NumberSetting
                      label={t("tts.advanced.layerPenalty")}
                      description={t("tts.advanced.layerPenaltyHint")}
                      value={advancedSettings.layerPenaltyFactor}
                      min={0}
                      max={10}
                      step={0.5}
                      disabled={!advancedEnabled}
                      onChange={(value) =>
                        setAdvancedSetting("layerPenaltyFactor", value)
                      }
                    />
                    <BooleanSetting
                      label={t("tts.advanced.denoise")}
                      description={t("tts.advanced.denoiseHint")}
                      checked={advancedSettings.denoise}
                      disabled={!advancedEnabled}
                      onCheckedChange={(value) =>
                        setAdvancedSetting("denoise", value)
                      }
                    />
                  </div>
                </div>

                <div>
                  <p className="mb-2 text-xs font-semibold">
                    {t("tts.advanced.output")}
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <BooleanSetting
                      label={t("tts.advanced.preprocess")}
                      description={t("tts.advanced.preprocessHint")}
                      checked={advancedSettings.preprocessPrompt}
                      disabled={!advancedEnabled}
                      onCheckedChange={(value) =>
                        setAdvancedSetting("preprocessPrompt", value)
                      }
                    />
                    <BooleanSetting
                      label={t("tts.advanced.postprocess")}
                      description={t("tts.advanced.postprocessHint")}
                      checked={advancedSettings.postprocessOutput}
                      disabled={!advancedEnabled}
                      onCheckedChange={(value) =>
                        setAdvancedSetting("postprocessOutput", value)
                      }
                    />
                    <NumberSetting
                      label={t("tts.advanced.padDuration")}
                      description={t("tts.advanced.padDurationHint")}
                      value={advancedSettings.padDuration}
                      min={0}
                      max={2}
                      step={0.05}
                      disabled={!advancedEnabled}
                      onChange={(value) =>
                        setAdvancedSetting("padDuration", value)
                      }
                    />
                    <NumberSetting
                      label={t("tts.advanced.fadeDuration")}
                      description={t("tts.advanced.fadeDurationHint")}
                      value={advancedSettings.fadeDuration}
                      min={0}
                      max={2}
                      step={0.05}
                      disabled={!advancedEnabled}
                      onChange={(value) =>
                        setAdvancedSetting("fadeDuration", value)
                      }
                    />
                  </div>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </section>
      </div>

      <LanguagePickerDialog
        open={languagePickerOpen}
        onOpenChange={setLanguagePickerOpen}
        savedLanguages={savedLanguages}
        onAdd={(nextLanguage) => {
          addSavedLanguage(nextLanguage);
          setLanguage(nextLanguage.code);
          setLanguagePickerOpen(false);
        }}
        onRemove={removeSavedLanguage}
      />
    </aside>
  );
}
