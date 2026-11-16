import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  CheckCircle2,
  ExternalLink,
  FolderOpen,
  Heart,
  KeyRound,
  Loader2,
  Play,
  RefreshCw,
  Square,
  Trash2,
  UserRoundPlus,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { GenderIcon, ProviderSelector } from "./provider-shared";
import { ttsClient } from "./tts-client";
import type { SonicSubFilter, TtsSplitMode } from "./types";
import type { TtsController } from "./use-tts-controller";
import {
  DEFAULT_ELEVEN_MODELS,
  SONIC_SPOKEN_LANGUAGES,
  filterVoices,
  formatSonicApiLanguage,
  voiceKey,
} from "./voice-catalog";

const SONIC_DOCS_URL = "https://sonicvoice.pro/api-docs#api-keys";
const CLONE_LANGUAGES = ["vi", "en", "ja", "ko", "zh", "fr", "de", "es"];

export function SonicVoiceSettings({
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
  const [languageFilter, setLanguageFilter] = useState("all");
  const [genderFilter, setGenderFilter] = useState("all");
  const [page, setPage] = useState(0);

  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneName, setCloneName] = useState("");
  const [cloneAudioPath, setCloneAudioPath] = useState("");
  const [cloneLanguage, setCloneLanguage] = useState("vi");
  const [cloneGender, setCloneGender] = useState("female");
  const [cloneNoiseReduction, setCloneNoiseReduction] = useState(true);

  const skipInitialSearch = useRef(true);
  useEffect(() => {
    if (!c.hasSonicKey) return;
    if (skipInitialSearch.current) {
      skipInitialSearch.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      void c.searchSonicVoices({
        subProvider: c.sonicSubFilter,
        language: languageFilter === "all" ? undefined : languageFilter,
        gender: genderFilter === "all" ? undefined : genderFilter,
        query: query.trim() || undefined,
        limit: 200,
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [
    c.hasSonicKey,
    c.sonicSubFilter,
    c.searchSonicVoices,
    genderFilter,
    languageFilter,
    query,
  ]);

  const languageName = (code: string) =>
    t(`tts.provider.languages.${code}`, { defaultValue: code });

  const filterLanguages = useMemo(() => {
    const codes = new Set([
      ...SONIC_SPOKEN_LANGUAGES,
      ...c.voices.map((v) => v.language),
      ...(c.selectedVoice ? [c.selectedVoice.language] : []),
    ]);
    return [...codes].sort((a, b) =>
      languageName(a).localeCompare(languageName(b), i18n.language),
    );
  }, [c.selectedVoice, c.voices, i18n.language]);

  const matches = useMemo(
    () =>
      filterVoices(
        c.voices,
        {
          language: languageFilter,
          gender: genderFilter,
          query,
          favoritesOnly,
        },
        favoriteKeys,
      ),
    [c.voices, languageFilter, genderFilter, query, favoritesOnly, favoriteKeys],
  );

  const safePage = Math.min(
    page,
    Math.max(0, Math.ceil(matches.length / 40) - 1),
  );

  const isEleven = c.selectedVoice?.subProvider === "eleven";
  const elevenModels = useMemo(() => {
    const fromApi = c.sonicModels.filter((m) => m.provider === "eleven");
    return fromApi.length > 0 ? fromApi : DEFAULT_ELEVEN_MODELS;
  }, [c.sonicModels]);

  const apiLanguagePreview = useMemo(
    () =>
      formatSonicApiLanguage(
        c.sonicLanguage,
        c.selectedVoice?.language,
        c.selectedVoice?.subProvider,
        c.sonicModel,
        c.sonicModels,
      ),
    [
      c.selectedVoice?.language,
      c.selectedVoice?.subProvider,
      c.sonicLanguage,
      c.sonicModel,
      c.sonicModels,
    ],
  );

  const speedMin = isEleven ? 0.7 : 0.5;
  const speedMax = isEleven ? 1.2 : 2.0;
  const clampedSpeed = Math.min(speedMax, Math.max(speedMin, c.speed));

  const subBadgeLabel = (sub?: string, owned?: boolean) => {
    if (owned) return t("tts.sonic.cloneBadge");
    return sub === "eleven" ? "11Labs" : "Mini";
  };

  const handlePickCloneAudio = async () => {
    const res = await ttsClient
      .pickReferenceAudio(t("tts.native.selectReferenceAudio"))
      .catch(() => ({ path: null }));
    if (res.path) setCloneAudioPath(res.path);
  };

  const handleSubmitClone = async () => {
    if (!cloneName.trim() || !cloneAudioPath) return;
    const created = await c.cloneSonicVoice({
      audioPath: cloneAudioPath,
      name: cloneName.trim(),
      language: cloneLanguage,
      gender: cloneGender,
      needNoiseReduction: cloneNoiseReduction,
    });
    if (created) {
      setCloneOpen(false);
      setCloneName("");
      setCloneAudioPath("");
      setCloneNoiseReduction(true);
    }
  };

  return (
    <aside className="min-h-0 overflow-y-auto bg-card/30 p-5">
      <div className="space-y-5">
        <ProviderSelector controller={c} />

        <section className="space-y-3 rounded-xl border border-border/60 bg-card/70 p-3.5">
          <div className="flex items-center justify-between gap-2">
            <Label
              htmlFor="sonicvoice-api-key"
              className="flex items-center gap-1.5 text-xs font-semibold"
            >
              <KeyRound className="size-3.5 text-primary" />
              {t("tts.sonic.apiKeyTitle")}
            </Label>
            <div className="flex items-center gap-1">
              {c.sonicBalance && (
                <Badge
                  variant="secondary"
                  className="font-mono text-[11px]"
                  title={t("tts.sonic.balanceTooltip", {
                    reserved: c.sonicBalance.reservedChars.toLocaleString(),
                  })}
                >
                  {t("tts.sonic.balanceChars", {
                    count: c.sonicBalance.availableChars.toLocaleString(),
                  })}
                </Badge>
              )}
              {c.hasSonicKey && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={c.sonicLoading}
                  onClick={() =>
                    void c.refreshSonicAll({
                      subProvider: c.sonicSubFilter,
                      language:
                        languageFilter === "all" ? undefined : languageFilter,
                      gender: genderFilter === "all" ? undefined : genderFilter,
                      query: query.trim() || undefined,
                      limit: 200,
                    })
                  }
                  title={t("tts.sonic.refresh")}
                  aria-label={t("tts.sonic.refresh")}
                >
                  <RefreshCw
                    className={`size-3.5 ${c.sonicLoading ? "animate-spin" : ""}`}
                  />
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => void openUrl(SONIC_DOCS_URL)}
                title={t("settings.sonicvoice.getKey")}
                aria-label={t("settings.sonicvoice.getKey")}
              >
                <ExternalLink className="size-3.5" />
              </Button>
            </div>
          </div>
          <Input
            id="sonicvoice-api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={c.busy}
            value={c.sonicvoiceApiKey}
            onChange={(e) => c.setSonicvoiceApiKey(e.target.value.trim())}
            placeholder={t("settings.sonicvoice.placeholder")}
          />
          {!c.hasSonicKey && (
            <p className="text-[11px] leading-4 text-muted-foreground">
              {t("tts.sonic.enterKeyHint")}
            </p>
          )}
          {c.sonicError && (
            <p className="text-[11px] leading-4 text-destructive">
              {c.sonicError}
            </p>
          )}
        </section>

        <section className="space-y-3 rounded-xl border border-primary/25 bg-card/70 p-3.5">
          <Label className="text-xs font-semibold">
            {t("tts.sonic.selectedVoiceTitle")}
          </Label>

          {c.selectedVoice ? (
            <div className="rounded-lg border border-primary/35 bg-primary/5 p-2.5">
              <div className="flex items-center gap-2">
                <GenderIcon gender={c.selectedVoice.gender} />
                <p className="min-w-0 flex-1 truncate text-sm font-medium">
                  {c.selectedVoice.name}
                </p>
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  {subBadgeLabel(
                    c.selectedVoice.subProvider,
                    c.selectedVoice.owned,
                  )}
                </Badge>
                <Badge variant="secondary" className="shrink-0 text-[10px]">
                  {t("tts.sonic.voiceOrigin", {
                    lang: c.selectedVoice.language.toUpperCase(),
                  })}
                </Badge>
              </div>
              {c.selectedVoice.description && (
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {c.selectedVoice.description}
                </p>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
              {t("tts.provider.chooseVoice")}
            </div>
          )}

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs">{t("tts.sonic.spokenLanguage")}</Label>
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                API: {apiLanguagePreview}
              </span>
            </div>
            <Select
              value={c.sonicLanguage}
              disabled={c.busy}
              onValueChange={c.setSonicLanguage}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="voice">
                  {t("tts.sonic.matchVoiceLang", {
                    lang: c.selectedVoice
                      ? `${languageName(c.selectedVoice.language)} (${c.selectedVoice.language})`
                      : "auto",
                  })}
                </SelectItem>
                <SelectItem value="auto">{t("tts.language.auto")}</SelectItem>
                {filterLanguages.map((code) => (
                  <SelectItem key={code} value={code}>
                    {languageName(code)} ({code})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {isEleven && (
            <div className="space-y-1.5">
              <Label className="text-xs">{t("tts.sonic.modelLabel")}</Label>
              <Select
                value={c.sonicModel}
                disabled={c.busy}
                onValueChange={c.setSonicModel}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {elevenModels.map((m) => (
                    <SelectItem key={m.modelId} value={m.modelId}>
                      {m.name} ({m.creditRatio}×)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </section>

        <section className="space-y-3">
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label>{t("tts.sonic.sourceLabel")}</Label>
              <Select
                value={c.sonicSubFilter}
                disabled={c.busy || !c.hasSonicKey}
                onValueChange={(v) => {
                  c.setSonicSubFilter(v as SonicSubFilter);
                  setPage(0);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("tts.sonic.sourceAll")}</SelectItem>
                  <SelectItem value="mini">Minimax</SelectItem>
                  <SelectItem value="eleven">ElevenLabs</SelectItem>
                  <SelectItem value="cloned">
                    {t("tts.sonic.sourceCloned")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={c.busy || !c.hasSonicKey}
              onClick={() => setCloneOpen(true)}
            >
              <UserRoundPlus className="size-4" />
              {t("tts.sonic.cloneButton")}
            </Button>
          </div>
        </section>

        <section className="space-y-3">
          <Label htmlFor="tts-sonic-search">{t("tts.provider.search")}</Label>
          <Input
            id="tts-sonic-search"
            disabled={!c.hasSonicKey}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
            placeholder={t("tts.sonic.searchHint")}
          />
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">
                {t("tts.sonic.filterAccent")}
              </Label>
              <Select
                value={languageFilter}
                disabled={!c.hasSonicKey}
                onValueChange={(v) => {
                  setLanguageFilter(v);
                  setPage(0);
                }}
              >
                <SelectTrigger aria-label={t("tts.sonic.filterAccent")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    {t("tts.provider.allLanguages")}
                  </SelectItem>
                  {filterLanguages.map((l) => (
                    <SelectItem key={l} value={l}>
                      {languageName(l)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">
                {t("tts.sonic.filterGender")}
              </Label>
              <Select
                value={genderFilter}
                disabled={!c.hasSonicKey}
                onValueChange={(v) => {
                  setGenderFilter(v);
                  setPage(0);
                }}
              >
                <SelectTrigger aria-label={t("tts.sonic.filterGender")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["all", "male", "female", "neutral"].map((g) => (
                    <SelectItem key={g} value={g}>
                      {g === "neutral"
                        ? t("tts.sonic.neutral")
                        : t(`tts.provider.${g}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

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

          <div
            className="max-h-72 space-y-1 overflow-y-auto"
            role="list"
            aria-label={t("tts.provider.chooseVoice")}
          >
            {matches.slice(safePage * 40, safePage * 40 + 40).map((v) => {
              const key = voiceKey(v);
              const selected =
                c.selectedVoice?.id === v.id &&
                c.selectedVoice?.language === v.language;
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
                    onClick={() => c.setProviderVoice(`${v.language}:${v.id}`)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    <GenderIcon gender={v.gender} />
                    <span className="min-w-0 flex-1 truncate text-sm" title={v.name}>
                      {v.name}
                    </span>
                    <Badge
                      variant="secondary"
                      className="shrink-0 px-1.5 py-0 text-[10px]"
                    >
                      {subBadgeLabel(v.subProvider, v.owned)}
                    </Badge>
                    <span
                      className="shrink-0 text-[11px] text-muted-foreground"
                      title={languageName(v.language)}
                    >
                      {v.language}
                    </span>
                  </button>
                  {v.owned && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={c.busy}
                      aria-label={t("tts.sonic.deleteClone")}
                      title={t("tts.sonic.deleteClone")}
                      onClick={() => void c.deleteSonicVoice(v.id)}
                    >
                      <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
                    </Button>
                  )}
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
                {!c.hasSonicKey
                  ? t("tts.sonic.missingKey")
                  : c.sonicLoading
                    ? t("tts.progress.starting")
                    : t(
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

        <section className="space-y-4 border-t pt-4">
          <div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="tts-sonic-speed">
                {t("tts.settings.speed")}
              </Label>
              <span className="text-xs font-medium text-primary">
                {clampedSpeed.toFixed(2)}×
              </span>
            </div>
            <input
              id="tts-sonic-speed"
              type="range"
              min={speedMin}
              max={speedMax}
              step="0.05"
              disabled={c.busy}
              value={clampedSpeed}
              onChange={(e) => c.setSpeed(Number(e.target.value))}
              className="mt-3 w-full accent-primary disabled:opacity-50"
            />
          </div>

          {isEleven ? (
            c.sonicModel === "eleven_v3" ? (
              <div className="space-y-2">
                <Label>{t("tts.sonic.stabilityLabel")}</Label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { value: 0, labelKey: "tts.sonic.stabilityCreative" },
                    { value: 0.5, labelKey: "tts.sonic.stabilityNatural" },
                    { value: 1, labelKey: "tts.sonic.stabilityRobust" },
                  ].map((opt) => {
                    const active =
                      Math.abs(c.sonicStability - opt.value) < 0.25;
                    return (
                      <Button
                        key={opt.value}
                        type="button"
                        size="sm"
                        disabled={c.busy}
                        variant={active ? "secondary" : "outline"}
                        onClick={() => c.setSonicStability(opt.value)}
                      >
                        {t(opt.labelKey)}
                      </Button>
                    );
                  })}
                </div>
              </div>
            ) : c.sonicModel !== "eleven_flash_v2" &&
              c.sonicModel !== "eleven_turbo_v2" ? (
              <div className="space-y-3">
                <div>
                  <div className="flex items-center justify-between gap-3">
                    <Label htmlFor="tts-sonic-stability">
                      {t("tts.sonic.stabilityLabel")}
                    </Label>
                    <span className="text-xs font-medium text-primary">
                      {c.sonicStability.toFixed(2)}
                    </span>
                  </div>
                  <input
                    id="tts-sonic-stability"
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    disabled={c.busy}
                    value={c.sonicStability}
                    onChange={(e) => c.setSonicStability(Number(e.target.value))}
                    className="mt-2 w-full accent-primary disabled:opacity-50"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between gap-3">
                    <Label htmlFor="tts-sonic-similarity">
                      {t("tts.sonic.similarityLabel")}
                    </Label>
                    <span className="text-xs font-medium text-primary">
                      {c.sonicSimilarity.toFixed(2)}
                    </span>
                  </div>
                  <input
                    id="tts-sonic-similarity"
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    disabled={c.busy}
                    value={c.sonicSimilarity}
                    onChange={(e) =>
                      c.setSonicSimilarity(Number(e.target.value))
                    }
                    className="mt-2 w-full accent-primary disabled:opacity-50"
                  />
                </div>
              </div>
            ) : null
          ) : (
            <div>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="tts-sonic-pitch">
                  {t("tts.sonic.pitchLabel")}
                </Label>
                <span className="text-xs font-medium text-primary">
                  {c.sonicPitch > 0 ? `+${c.sonicPitch}` : c.sonicPitch} st
                </span>
              </div>
              <input
                id="tts-sonic-pitch"
                type="range"
                min="-12"
                max="12"
                step="1"
                disabled={c.busy}
                value={c.sonicPitch}
                onChange={(e) => c.setSonicPitch(Number(e.target.value))}
                className="mt-2 w-full accent-primary disabled:opacity-50"
              />
            </div>
          )}

          <div className="space-y-1.5">
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
          </div>
        </section>
      </div>

      <Dialog open={cloneOpen} onOpenChange={setCloneOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("tts.sonic.cloneTitle")}</DialogTitle>
            <DialogDescription>
              {t("tts.sonic.cloneDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>{t("tts.profile.name")}</Label>
              <Input
                className="mt-2"
                maxLength={80}
                value={cloneName}
                onChange={(e) => setCloneName(e.target.value)}
                placeholder={t("tts.profile.namePlaceholder")}
              />
            </div>
            <div>
              <Label>{t("tts.profile.referenceAudio")}</Label>
              <div className="mt-2 flex gap-2">
                <Input
                  readOnly
                  value={cloneAudioPath}
                  placeholder={t("tts.profile.audioPlaceholder")}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handlePickCloneAudio()}
                >
                  <FolderOpen />
                  {t("tts.profile.choose")}
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{t("tts.settings.language")}</Label>
                <Select value={cloneLanguage} onValueChange={setCloneLanguage}>
                  <SelectTrigger className="mt-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CLONE_LANGUAGES.map((code) => (
                      <SelectItem key={code} value={code}>
                        {languageName(code)} ({code})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>{t("tts.provider.gender")}</Label>
                <Select value={cloneGender} onValueChange={setCloneGender}>
                  <SelectTrigger className="mt-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="female">
                      {t("tts.provider.female")}
                    </SelectItem>
                    <SelectItem value="male">
                      {t("tts.provider.male")}
                    </SelectItem>
                    <SelectItem value="neutral">
                      {t("tts.sonic.neutral")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 p-3">
              <Label htmlFor="sonic-noise-reduction" className="text-xs">
                {t("tts.sonic.noiseReduction")}
              </Label>
              <Switch
                id="sonic-noise-reduction"
                checked={cloneNoiseReduction}
                onCheckedChange={setCloneNoiseReduction}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={c.sonicCloning}
              onClick={() => setCloneOpen(false)}
            >
              {t("tts.action.cancel")}
            </Button>
            <Button
              disabled={
                c.sonicCloning || !cloneName.trim() || !cloneAudioPath
              }
              onClick={() => void handleSubmitClone()}
            >
              {c.sonicCloning ? (
                <Loader2 className="animate-spin" />
              ) : (
                <CheckCircle2 />
              )}
              {t("tts.sonic.cloneSubmit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
