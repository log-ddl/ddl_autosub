import type { CatalogVoice } from "./types";

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
