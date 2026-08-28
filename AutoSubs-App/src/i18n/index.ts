import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import de from "./locales/de/translation.json";
import en from "./locales/en/translation.json";
import es from "./locales/es/translation.json";
import fr from "./locales/fr/translation.json";
import ja from "./locales/ja/translation.json";
import ko from "./locales/ko/translation.json";
import ru from "./locales/ru/translation.json";
import vi from "./locales/vi/translation.json";
import zh from "./locales/zh/translation.json";

export const DEFAULT_UI_LANGUAGE = "en";
export const SUPPORTED_UI_LANGUAGES = ["en", "de", "es", "fr", "ja", "ko", "ru", "vi", "zh"] as const;
export type SupportedUiLanguage = (typeof SUPPORTED_UI_LANGUAGES)[number];

export function normalizeUiLanguage(lang: string | null | undefined): SupportedUiLanguage {
  if (!lang) return DEFAULT_UI_LANGUAGE;
  const lc = lang.toLowerCase();

  if ((SUPPORTED_UI_LANGUAGES as readonly string[]).includes(lc)) {
    return lc as SupportedUiLanguage;
  }

  const base = lc.split("-")[0];
  if ((SUPPORTED_UI_LANGUAGES as readonly string[]).includes(base)) {
    return base as SupportedUiLanguage;
  }

  return DEFAULT_UI_LANGUAGE;
}

export function getPreferredUiLanguage(): SupportedUiLanguage {
  if (typeof navigator === "undefined") {
    return DEFAULT_UI_LANGUAGE;
  }

  const preferredLanguages = Array.isArray(navigator.languages) && navigator.languages.length > 0
    ? navigator.languages
    : [navigator.language];

  for (const language of preferredLanguages) {
    const normalized = normalizeUiLanguage(language);
    if (normalized !== DEFAULT_UI_LANGUAGE || language?.toLowerCase().startsWith(DEFAULT_UI_LANGUAGE)) {
      return normalized;
    }
  }

  return DEFAULT_UI_LANGUAGE;
}

const BUNDLES = { de, en, es, fr, ja, ko, ru, vi, zh } as const;

export function initI18n(uiLanguage: string) {
  const normalized = normalizeUiLanguage(uiLanguage);

  if (!i18n.isInitialized) {
    i18n
      .use(initReactI18next)
      .init({
        resources: Object.fromEntries(
          Object.entries(BUNDLES).map(([lng, bundle]) => [
            lng,
            { translation: bundle },
          ]),
        ),
        lng: normalized,
        fallbackLng: DEFAULT_UI_LANGUAGE,
        interpolation: {
          escapeValue: false,
        },
      });
  } else {
    // Re-inject bundles so HMR-updated JSON is picked up without a full
    // app restart. `deep: true, overwrite: true` merges new keys and
    // replaces stale values.
    for (const [lng, bundle] of Object.entries(BUNDLES)) {
      i18n.addResourceBundle(lng, "translation", bundle, true, true);
    }
    i18n.changeLanguage(normalized);
  }

  return i18n;
}

// Dev-time: when a translation JSON is edited, Vite invalidates this module.
// Re-inject the fresh bundles into the live i18n instance and nudge React by
// re-emitting the current language, so the running UI updates without a
// manual restart or language toggle.
if (import.meta.hot) {
  import.meta.hot.accept();
  if (i18n.isInitialized) {
    for (const [lng, bundle] of Object.entries(BUNDLES)) {
      i18n.addResourceBundle(lng, "translation", bundle, true, true);
    }
    void i18n.changeLanguage(i18n.language);
  }
}

export default i18n;
