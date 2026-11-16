import { useMemo, useState } from "react";
import {
  Download,
  Heart,
  Loader2,
  Play,
  Square,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GenderIcon, ProviderSelector } from "./provider-shared";
import { SonicVoiceSettings } from "./sonicvoice-settings";
import { filterVoices, voiceKey } from "./voice-catalog";
import type { TtsSplitMode } from "./types";
import type { TtsController } from "./use-tts-controller";
export { ProviderSelector } from "./provider-shared";
export function ProviderSettings({
  controller: c,
}: {
  controller: TtsController;
}) {
  if (c.provider === "sonicvoice") {
    return <SonicVoiceSettings controller={c} />;
  }
  return <CatalogProviderSettings controller={c} />;
}

function CatalogProviderSettings({
  controller: c,
}: {
  controller: TtsController;
}) {
  const { t, i18n } = useTranslation();
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const favoriteKeys = useMemo(
    () => new Set(c.favoriteVoiceKeys),
    [c.favoriteVoiceKeys],
  );
  const [query, setQuery] = useState("");
  const [language, setLanguage] = useState("all");
  const [gender, setGender] = useState("all");
  const [page, setPage] = useState(0);
  const languageName = (code: string) =>
    t(`tts.provider.languages.${code}`, { defaultValue: code });
  const languages = useMemo(
    () =>
      [...new Set(c.voices.map((v) => v.language))].sort((a, b) =>
        t(`tts.provider.languages.${a}`, { defaultValue: a }).localeCompare(
          t(`tts.provider.languages.${b}`, { defaultValue: b }),
          i18n.language,
        ),
      ),
    [c.voices, t, i18n.language],
  );
  const matches = useMemo(
    () =>
      filterVoices(
        c.voices,
        { language, gender, query, favoritesOnly },
        favoriteKeys,
      ),
    [c.voices, language, gender, query, favoritesOnly, favoriteKeys],
  );
  const safePage = Math.min(
    page,
    Math.max(0, Math.ceil(matches.length / 40) - 1),
  );
  return (
    <aside className="min-h-0 overflow-y-auto bg-card/30 p-5">
      <div className="space-y-5">
        <ProviderSelector controller={c} />
        <p className="text-xs text-muted-foreground">{c.currentModelLabel}</p>
        {c.provider === "vieneu" && c.selectedStatus?.status !== "ready" && (
          <Button disabled={c.busy} onClick={() => void c.installModel()}>
            <Download />
            {t("tts.provider.installVieneu")}
          </Button>
        )}
        {c.provider === "vieneu" && (
          <section className="space-y-2">
            <Label>{t("tts.profile.title")}</Label>
            <Select
              value={c.vieneuProfileId || "preset"}
              disabled={c.busy}
              onValueChange={(v) =>
                c.setVieneuProfile(v === "preset" ? undefined : v)
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="preset">
                  {t("tts.provider.presets")}
                </SelectItem>
                {c.compatibleProfiles.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              disabled={c.busy}
              onClick={() => c.setProfileOpen(true)}
            >
              {t("tts.profile.create")}
            </Button>
          </section>
        )}
        <section className="space-y-3">
          <Label htmlFor="tts-voice-search">{t("tts.provider.search")}</Label>
          <Input
            id="tts-voice-search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
            placeholder={t("tts.provider.searchHint")}
          />
          <div className="flex gap-2">
            <Select
              value={language}
              onValueChange={(v) => {
                setLanguage(v);
                setPage(0);
              }}
            >
              <SelectTrigger aria-label={t("tts.settings.language")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {t("tts.provider.allLanguages")}
                </SelectItem>
                {languages.map((l) => (
                  <SelectItem key={l} value={l}>
                    {languageName(l)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {c.provider === "elevenlabs" && (
              <Select
                value={gender}
                onValueChange={(v) => {
                  setGender(v);
                  setPage(0);
                }}
              >
                <SelectTrigger aria-label={t("tts.provider.gender")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["all", "male", "female"].map((g) => (
                    <SelectItem key={g} value={g}>
                      {t(`tts.provider.${g}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          {c.selectedVoice &&
            !(c.provider === "vieneu" && c.vieneuProfileId) && (
              <div className="rounded-lg border border-primary/40 bg-primary/5 p-3">
                <div className="flex items-center gap-2">
                  <GenderIcon gender={c.selectedVoice.gender} />
                  <p className="min-w-0 flex-1 truncate text-sm font-medium">
                    {c.selectedVoice.name}
                  </p>
                  <span
                    className="text-xs text-muted-foreground"
                    title={languageName(c.selectedVoice.language)}
                  >
                    {c.selectedVoice.language}
                  </span>
                </div>
              </div>
            )}
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {t("tts.provider.count", { count: matches.length })}
            </p>
            {c.previewVoiceKey && (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={t("tts.provider.stopPreview")}
                title={t("tts.provider.stopPreview")}
                onClick={c.stopPreview}
              >
                <Square className="size-3.5" />
              </Button>
            )}
            <Button
              size="sm"
              variant={favoritesOnly ? "secondary" : "ghost"}
              aria-pressed={favoritesOnly}
              onClick={() => {
                setFavoritesOnly(!favoritesOnly);
                setPage(0);
              }}
            >
              <Heart
                className={`size-3.5 ${favoritesOnly ? "fill-current" : ""}`}
              />
              {t("tts.provider.favorites")}
            </Button>
          </div>
          {c.catalogError && (
            <Button variant="outline" onClick={c.loadCatalog}>
              {t("tts.provider.reload")}
            </Button>
          )}
          <div
            className="max-h-80 space-y-1 overflow-y-auto"
            role="list"
            aria-label={t("tts.provider.chooseVoice")}
          >
            {matches.slice(safePage * 40, safePage * 40 + 40).map((v) => {
              const key = voiceKey(v);
              const selected =
                c.selectedVoice?.id === v.id &&
                c.selectedVoice?.language === v.language &&
                !(c.provider === "vieneu" && c.vieneuProfileId);
              const favorite = favoriteKeys.has(key);
              const previewing = c.previewVoiceKey === key;
              const previewLabel = t(
                previewing
                  ? "tts.provider.stopPreview"
                  : "tts.provider.preview",
              );
              return (
                <div
                  key={key}
                  role="listitem"
                  className={`flex items-center gap-1 rounded-lg border px-1 ${selected ? "border-primary bg-primary/10" : "border-transparent hover:bg-muted"}`}
                >
                  <button
                    type="button"
                    disabled={c.busy}
                    aria-pressed={selected}
                    onClick={() => {
                      c.setProviderVoice(`${v.language}:${v.id}`);
                      c.setVieneuProfile(undefined);
                      c.setLanguage(v.language);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    <GenderIcon gender={v.gender} />
                    <span className="min-w-0 truncate text-sm" title={v.name}>
                      {v.name}
                    </span>
                    <span
                      className="shrink-0 text-[11px] text-muted-foreground"
                      title={languageName(v.language)}
                    >
                      {v.language}
                    </span>
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-pressed={favorite}
                    aria-label={`${t(favorite ? "tts.provider.removeFavorite" : "tts.provider.addFavorite")}: ${v.name}`}
                    title={t(
                      favorite
                        ? "tts.provider.removeFavorite"
                        : "tts.provider.addFavorite",
                    )}
                    onClick={() => c.toggleFavoriteVoice(key)}
                  >
                    <Heart
                      className={`size-3.5 ${favorite ? "fill-rose-500 text-rose-500" : "text-muted-foreground"}`}
                    />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={c.busy && !previewing}
                    aria-label={`${previewLabel}: ${v.name}`}
                    title={previewLabel}
                    onClick={() => void c.previewVoice(v)}
                  >
                    {previewing && c.previewLoading ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : previewing ? (
                      <Square className="size-3.5" />
                    ) : (
                      <Play className="size-3.5" />
                    )}
                  </Button>
                </div>
              );
            })}
            {!matches.length && (
              <p className="p-3 text-sm text-muted-foreground">
                {t(
                  favoritesOnly
                    ? "tts.provider.noFavorites"
                    : "tts.provider.noResults",
                )}
              </p>
            )}
          </div>
          {matches.length > 40 && (
            <div className="flex items-center justify-between">
              <Button
                size="sm"
                variant="outline"
                disabled={!safePage}
                onClick={() => setPage(safePage - 1)}
              >
                {t("tts.provider.previous")}
              </Button>
              <span className="text-xs">
                {safePage + 1} / {Math.ceil(matches.length / 40)}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={(safePage + 1) * 40 >= matches.length}
                onClick={() => setPage(safePage + 1)}
              >
                {t("tts.provider.next")}
              </Button>
            </div>
          )}
        </section>
        <section className="space-y-3 border-t pt-4">
          <div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="tts-provider-speed">
                {t("tts.settings.speed")}
              </Label>
              <span className="text-xs font-medium text-primary">
                {c.speed.toFixed(2)}×
              </span>
            </div>
            <input
              id="tts-provider-speed"
              type="range"
              min="0.75"
              max="1.5"
              step="0.05"
              disabled={c.busy}
              value={c.speed}
              onChange={(e) => c.setSpeed(Number(e.target.value))}
              className="mt-3 w-full accent-primary disabled:opacity-50"
            />
          </div>
          <Label>{t("tts.splitMode.title")}</Label>
          <Select
            value={c.splitMode}
            disabled={c.busy}
            onValueChange={(v) => c.setSplitMode(v as TtsSplitMode)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["default", "line", "sentence"].map((v) => (
                <SelectItem key={v} value={v}>
                  {t(`tts.splitMode.${v}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </section>
      </div>
    </aside>
  );
}
