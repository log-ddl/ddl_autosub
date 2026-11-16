import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Field, FieldGroup } from "@/components/ui/field";
import { useSettingsStore } from "@/stores/settings-store";

const SONICVOICE_KEY_DOCS_URL = "https://sonicvoice.pro/api-docs#api-keys";

/**
 * Settings section for the SonicVoice TTS API key. The backend reads it from
 * the settings store when generating speech or browsing SonicVoice voices.
 */
export function SonicVoiceKeySetting() {
  const { t } = useTranslation();
  const sonicvoiceApiKey = useSettingsStore((s) => s.sonicvoiceApiKey);
  const updateSetting = useSettingsStore((s) => s.updateSetting);

  return (
    <div className="space-y-3">
      <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {t("settings.sections.ttsVoice")}
      </h4>

      <FieldGroup className="gap-3">
        <Field>
          <Item variant="outline" size="sm">
            <ItemContent>
              <ItemTitle>{t("settings.sonicvoice.keyTitle")}</ItemTitle>
              <ItemDescription className="text-xs leading-tight line-clamp-1">
                {t("settings.sonicvoice.keyDescription")}
              </ItemDescription>
            </ItemContent>
            <ItemActions className="w-[200px] shrink-0 justify-end gap-1">
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={sonicvoiceApiKey ?? ""}
                placeholder={t("settings.sonicvoice.placeholder")}
                onChange={(e) => updateSetting("sonicvoiceApiKey", e.target.value.trim())}
                aria-label={t("settings.sonicvoice.keyTitle")}
              />
              <Button
                variant="ghost"
                size="icon"
                className="size-9 shrink-0"
                onClick={() => void openUrl(SONICVOICE_KEY_DOCS_URL)}
                title={t("settings.sonicvoice.getKey")}
                aria-label={t("settings.sonicvoice.getKey")}
              >
                <ExternalLink className="size-4" />
              </Button>
            </ItemActions>
          </Item>
        </Field>
      </FieldGroup>
    </div>
  );
}
