import { useMemo, useState } from "react";
import { Check, Plus, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  OMNIVOICE_LANGUAGE_COUNT,
  searchOmniVoiceLanguages,
} from "../omnivoice-languages";
import type { TtsSavedLanguage } from "../types";

interface LanguagePickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  savedLanguages: TtsSavedLanguage[];
  onAdd: (language: TtsSavedLanguage) => void;
  onRemove: (code: string) => void;
}

export function LanguagePickerDialog({
  open,
  onOpenChange,
  savedLanguages,
  onAdd,
  onRemove,
}: LanguagePickerDialogProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const savedCodes = useMemo(
    () =>
      new Set([
        "vi",
        "en",
        ...savedLanguages.map((language) => language.code),
      ]),
    [savedLanguages],
  );
  const results = useMemo(() => searchOmniVoiceLanguages(query), [query]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("tts.languagePicker.title")}</DialogTitle>
          <DialogDescription>
            {t("tts.languagePicker.description", {
              count: OMNIVOICE_LANGUAGE_COUNT,
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("tts.languagePicker.searchPlaceholder")}
            className="pl-9"
            autoFocus
          />
        </div>

        {savedLanguages.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-semibold">
              {t("tts.languagePicker.saved")}
            </p>
            <div className="flex flex-wrap gap-2">
              {savedLanguages.map((language) => (
                <div
                  key={language.code}
                  className="flex items-center gap-1 rounded-full border border-border bg-muted/40 py-1 pl-3 pr-1 text-xs"
                >
                  <span>
                    {language.name} · {language.code}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 rounded-full p-0"
                    onClick={() => onRemove(language.code)}
                    aria-label={t("tts.languagePicker.remove", {
                      language: language.name,
                    })}
                  >
                    <X className="size-3" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="max-h-72 overflow-y-auto rounded-xl border border-border/60">
          {results.map((language) => {
            const saved = savedCodes.has(language.code);
            return (
              <button
                key={language.code}
                type="button"
                disabled={saved}
                onClick={() =>
                  onAdd({ code: language.code, name: language.name })
                }
                className="flex w-full items-center gap-3 border-b border-border/60 px-3 py-2.5 text-left last:border-b-0 hover:bg-muted/50 disabled:cursor-default disabled:opacity-60"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {language.name}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {t("tts.languagePicker.modelCode")}: {language.code}
                    {language.iso6393 !== language.code
                      ? ` · ISO 639-3: ${language.iso6393}`
                      : ""}
                  </p>
                </div>
                {saved ? (
                  <Check className="size-4 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <Plus className="size-4 text-primary" />
                )}
              </button>
            );
          })}
          {results.length === 0 && (
            <p className="p-6 text-center text-sm text-muted-foreground">
              {t("tts.languagePicker.empty")}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

