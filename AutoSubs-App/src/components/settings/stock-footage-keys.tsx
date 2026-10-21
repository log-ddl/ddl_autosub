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

const SITES = [
  { key: "pexelsApiKey", name: "Pexels", signup: "https://www.pexels.com/api/" },
  { key: "pixabayApiKey", name: "Pixabay", signup: "https://pixabay.com/api/docs/" },
] as const;

/**
 * Settings section for the free stock footage keys. The backend reads them
 * from the settings store when the AI Edit agent calls search_media.
 */
export function StockFootageKeys() {
  const { t } = useTranslation();
  const pexelsApiKey = useSettingsStore((s) => s.pexelsApiKey);
  const pixabayApiKey = useSettingsStore((s) => s.pixabayApiKey);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const values = { pexelsApiKey, pixabayApiKey };

  return (
    <div className="space-y-3">
      <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {t("settings.sections.stockFootage")}
      </h4>

      <FieldGroup className="gap-3">
        {SITES.map((site) => (
          <Field key={site.key}>
            <Item variant="outline" size="sm">
              <ItemContent>
                <ItemTitle>{t("settings.stockFootage.keyTitle", { site: site.name })}</ItemTitle>
                <ItemDescription className="text-xs leading-tight line-clamp-1">
                  {t("settings.stockFootage.keyDescription")}
                </ItemDescription>
              </ItemContent>
              <ItemActions className="w-[200px] shrink-0 justify-end gap-1">
                <Input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={values[site.key] ?? ""}
                  placeholder={t("settings.stockFootage.placeholder")}
                  onChange={(e) => updateSetting(site.key, e.target.value.trim())}
                  aria-label={t("settings.stockFootage.keyTitle", { site: site.name })}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-9 shrink-0"
                  onClick={() => void openUrl(site.signup)}
                  title={t("settings.stockFootage.getKey")}
                  aria-label={t("settings.stockFootage.getKey")}
                >
                  <ExternalLink className="size-4" />
                </Button>
              </ItemActions>
            </Item>
          </Field>
        ))}
      </FieldGroup>
    </div>
  );
}
