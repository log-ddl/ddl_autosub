import type { CatalogVoice, SonicModel, SonicSubProvider } from "./types";

export const SONIC_SPOKEN_LANGUAGES = [
  "vi",
  "en",
  "ja",
  "ko",
  "zh",
  "fr",
  "de",
  "es",
  "th",
  "id",
];

export const DEFAULT_ELEVEN_MODELS = [
  { modelId: "eleven_v3", name: "Eleven v3", creditRatio: 1.5 },
  { modelId: "eleven_v4", name: "Eleven v4", creditRatio: 1.5 },
  { modelId: "eleven_v4_turbo", name: "Eleven v4 Turbo", creditRatio: 1.0 },
  {
    modelId: "eleven_multilingual_v2",
    name: "Eleven Multilingual v2",
    creditRatio: 1.0,
  },
  { modelId: "eleven_flash_v2_5", name: "Eleven Flash v2.5", creditRatio: 0.5 },
  { modelId: "eleven_turbo_v2_5", name: "Eleven Turbo v2.5", creditRatio: 0.5 },
];

const MINI_LANGUAGE_NAMES: Record<string, string> = {
  vi: "Vietnamese",
  en: "English",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  fr: "French",
  de: "German",
  es: "Spanish",
  pt: "Portuguese",
  ru: "Russian",
  th: "Thai",
  id: "Indonesian",
  it: "Italian",
  ar: "Arabic",
  hi: "Hindi",
  tr: "Turkish",
  nl: "Dutch",
  pl: "Polish",
  uk: "Ukrainian",
  sv: "Swedish",
  da: "Danish",
  fi: "Finnish",
  cs: "Czech",
  ro: "Romanian",
  el: "Greek",
  bg: "Bulgarian",
  hr: "Croatian",
  sk: "Slovak",
  ms: "Malay",
  ta: "Tamil",
  fil: "Filipino",
};

export function formatSonicApiLanguage(
  preference: string,
  voiceLanguage: string | undefined,
  subProvider: SonicSubProvider | undefined,
  modelId?: string,
  models?: SonicModel[],
): string {
  const effective = preference === "voice" ? (voiceLanguage ?? "auto") : preference;
  const code = effective.trim().toLowerCase();
  if (!code || code === "auto") return "auto";
  if (subProvider === "eleven") {
    const m = models?.find((item) => item.modelId === modelId);
    if (
      m &&
      m.languages.length > 0 &&
      !m.languages.some((l) => l.toLowerCase() === code)
    ) {
      return "auto";
    }
    return code;
  }
  return MINI_LANGUAGE_NAMES[code] ?? "auto";
}

/** Provider and language matter: the same voice ID can occur in two catalogs. */
export function voiceKey(voice: CatalogVoice): string {
  return `${voice.provider}:${voice.language}:${voice.id}`;
}

export function filterVoices(
  voices: CatalogVoice[],
  filters: {
    language: string;
    gender: string;
    query: string;
    favoritesOnly: boolean;
  },
  favoriteKeys: ReadonlySet<string>,
): CatalogVoice[] {
  const query = filters.query.trim().normalize("NFC").toLocaleLowerCase();
  return voices.filter(
    (v) =>
      (filters.language === "all" || v.language === filters.language) &&
      (filters.gender === "all" || v.gender === filters.gender) &&
      (!filters.favoritesOnly || favoriteKeys.has(voiceKey(v))) &&
      `${v.name} ${v.id}`.normalize("NFC").toLocaleLowerCase().includes(query),
  );
}
