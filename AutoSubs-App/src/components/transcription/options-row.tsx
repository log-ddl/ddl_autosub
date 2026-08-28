import * as React from "react";
import { AlignLeft, ScrollText, Speech } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { SpeakerSelector } from "@/components/settings/diarize-selector";
import { TextFormattingPanel } from "@/components/settings/text-formatting-panel";
import { useSettingsStore } from "@/stores/settings-store";
import { migrateCustomPrompt } from "./utils";

export function OptionsRow() {
  const { t } = useTranslation();
  const enableDiarize = useSettingsStore((s) => s.enableDiarize);
  const maxSpeakers = useSettingsStore((s) => s.maxSpeakers);
  const customPrompt = useSettingsStore((s) => s.customPrompt);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const [openSpeakerPopover, setOpenSpeakerPopover] = React.useState(false);
  const [openTextFormattingPopover, setOpenTextFormattingPopover] =
    React.useState(false);
  const [openCustomPromptPopover, setOpenCustomPromptPopover] =
    React.useState(false);

  const diarizeLabel = enableDiarize
    ? maxSpeakers === null
      ? t("actionBar.common.auto")
      : maxSpeakers
    : t("actionBar.common.off");

  return (
    <div className="grid grid-cols-3 gap-2">
      <Popover
        open={openSpeakerPopover}
        onOpenChange={setOpenSpeakerPopover}
      >
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="default"
            aria-haspopup="listbox"
            className="group h-10 min-w-0 justify-center gap-1.5 rounded-lg bg-muted/35 px-2 dark:bg-muted"
            aria-expanded={openSpeakerPopover}
            aria-label={`${t("actionBar.speakers.title", "Speakers")}: ${diarizeLabel}`}
            title={`${t("actionBar.speakers.title", "Speakers")}: ${diarizeLabel}`}
          >
            <Speech className="size-4 shrink-0 text-muted-foreground group-hover:text-primary transition-colors" />
            <span className="min-w-0 truncate text-sm font-semibold leading-none group-hover:text-primary transition-colors">
              {diarizeLabel}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="center" side="top">
          <SpeakerSelector />
        </PopoverContent>
      </Popover>

      <Popover
        open={openTextFormattingPopover}
        onOpenChange={setOpenTextFormattingPopover}
      >
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="default"
            aria-haspopup="listbox"
            className="group h-10 min-w-0 justify-center gap-1.5 rounded-lg bg-muted/35 px-2 dark:bg-muted"
            aria-expanded={openTextFormattingPopover}
            aria-label={t("actionBar.format.title", "Text")}
            title={t("actionBar.format.title", "Text")}
          >
            <AlignLeft className="size-4 shrink-0 text-muted-foreground group-hover:text-primary transition-colors" />
            <span className="min-w-0 truncate text-sm font-semibold leading-none group-hover:text-primary transition-colors">
              {t("actionBar.format.title", "Text")}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-80 p-0"
          align="center"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <TextFormattingPanel />
        </PopoverContent>
      </Popover>

      <CustomPromptPopover
        open={openCustomPromptPopover}
        onOpenChange={setOpenCustomPromptPopover}
        customPrompt={customPrompt}
        onCustomPromptChange={(value) => updateSetting("customPrompt", value)}
      />
    </div>
  );
}

interface CustomPromptPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customPrompt: string;
  onCustomPromptChange: (value: string) => void;
}

function CustomPromptPopover({
  open,
  onOpenChange,
  customPrompt,
  onCustomPromptChange,
}: CustomPromptPopoverProps) {
  const { t } = useTranslation();
  const [localPrompt, setLocalPrompt] = React.useState("");

  // Sync local state when popover opens, migrating any legacy two-section format
  React.useEffect(() => {
    if (open) {
      setLocalPrompt(migrateCustomPrompt(customPrompt));
    }
  }, [open, customPrompt]);

  // Sync to settings when popover closes
  React.useEffect(() => {
    if (open) return;
    if (localPrompt === customPrompt) return;
    onCustomPromptChange(localPrompt);
  }, [open, localPrompt, customPrompt, onCustomPromptChange]);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="default"
          aria-haspopup="listbox"
          className="group relative h-10 min-w-0 justify-center gap-1.5 rounded-lg bg-muted/35 px-2 dark:bg-muted"
          aria-expanded={open}
          aria-label={t("actionBar.format.customPromptTitle")}
          title={t("actionBar.format.customPromptTitle")}
        >
          <ScrollText className="size-4 shrink-0 text-muted-foreground group-hover:text-primary transition-colors" />
          <span className="min-w-0 truncate text-sm font-semibold leading-none group-hover:text-primary transition-colors">
            {t("actionBar.format.customPromptButton", "Prompt")}
          </span>
          {customPrompt.trim() ? (
            <span className="absolute right-2 top-2 size-1.5 rounded-full bg-primary" />
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-80 p-0"
        side="top"
        align="center"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="px-4 py-3.5 space-y-3">
          <div className="space-y-0.5">
            <Label className="text-sm font-medium">
              {t("actionBar.format.customPromptTitle")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("actionBar.format.customPromptDescription")}
            </p>
          </div>
          <Textarea
            value={localPrompt}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
              setLocalPrompt(e.target.value)
            }
            placeholder={t("actionBar.format.customPromptPlaceholder")}
            className="min-h-[100px] resize-none text-sm"
          />
          <p className="text-xs text-muted-foreground">
            {t("actionBar.format.customPromptFooter")}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
