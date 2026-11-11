import languageMapSource from "./data/lang_id_name_map.tsv?raw";

export interface OmniVoiceLanguage {
  code: string;
  name: string;
  iso6393: string;
}

export const OMNIVOICE_LANGUAGES: OmniVoiceLanguage[] = languageMapSource
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .map((line) => {
    const [code, name, iso6393] = line.split("\t");
    return { code, name, iso6393 };
  })
  .filter((language) => Boolean(language.code && language.name));

export const OMNIVOICE_LANGUAGE_COUNT = OMNIVOICE_LANGUAGES.length;

export function searchOmniVoiceLanguages(
  query: string,
  limit = 60,
): OmniVoiceLanguage[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const popularCodes = [
    "vi",
    "en",
    "zh",
    "ja",
    "ko",
    "fr",
    "de",
    "es",
    "pt",
    "ru",
    "th",
    "id",
  ];

  if (!normalizedQuery) {
    return popularCodes
      .map((code) =>
        OMNIVOICE_LANGUAGES.find((language) => language.code === code),
      )
      .filter((language): language is OmniVoiceLanguage => Boolean(language));
  }

  return OMNIVOICE_LANGUAGES.filter(
    (language) =>
      language.code.toLocaleLowerCase().includes(normalizedQuery) ||
      language.iso6393.toLocaleLowerCase().includes(normalizedQuery) ||
      language.name.toLocaleLowerCase().includes(normalizedQuery),
  ).slice(0, limit);
}

