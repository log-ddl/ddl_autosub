import { useEffect, useMemo, useState } from "react";
import { Loader2, Play, Square, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { parseDialoguePreviewTurns } from "./dialogue-tags";
import { TTS_PROVIDERS } from "./provider-shared";
import type {
  CatalogVoice,
  SonicModel,
  SonicVoicesQuery,
  TtsProvider,
  TtsSpeakerVoiceConfig,
  VoiceProfile,
} from "./types";
import type { TtsController } from "./use-tts-controller";
import {
  DEFAULT_ELEVEN_MODELS,
  SONIC_SPOKEN_LANGUAGES,
  formatSonicApiLanguage,
  voiceKey,
} from "./voice-catalog";

const MAX_SELECT_VOICES = 80;

interface SpeakerRowProps {
  tag: string;
  turnCount: number;
  config: TtsSpeakerVoiceConfig;
  catalog: CatalogVoice[];
  voiceProfiles: VoiceProfile[];
  sonicModels: SonicModel[];
  defaultSonicModel: string;
  defaultLanguage: string;
  busy: boolean;
  isProviderReady: (p: TtsProvider) => boolean;
  onEnsureSonicVoices: (query: SonicVoicesQuery) => Promise<void>;
  previewVoiceKey?: string;
  previewLoading: boolean;
  onPreview: (voice: CatalogVoice) => void;
  onChange: (next: TtsSpeakerVoiceConfig) => void;
}

function SpeakerRow({
  tag,
  turnCount,
  config,
  catalog,
  voiceProfiles,
  sonicModels,
  defaultSonicModel,
  defaultLanguage,
  busy,
  isProviderReady,
  onEnsureSonicVoices,
  previewVoiceKey,
  previewLoading,
  onPreview,
  onChange,
}: SpeakerRowProps) {
  const { t, i18n } = useTranslation();
  const providerVoices = useMemo(
    () => catalog.filter((v) => v.provider === config.provider),
    [catalog, config.provider],
  );

  const availableLanguages = useMemo(() => {
    const codes = new Set(providerVoices.map((v) => v.language));
    if (config.provider === "sonicvoice") {
      for (const code of SONIC_SPOKEN_LANGUAGES) codes.add(code);
    }
    return [...codes].sort();
  }, [config.provider, providerVoices]);

  const selectedCatalogVoice = useMemo(
    () => providerVoices.find((v) => voiceKey(v) === config.voiceKey),
    [providerVoices, config.voiceKey],
  );

  const [langFilter, setLangFilter] = useState<string>(() => {
    if (selectedCatalogVoice) return selectedCatalogVoice.language;
    if (availableLanguages.includes(defaultLanguage)) return defaultLanguage;
    return "all";
  });
  const [search, setSearch] = useState("");

  const effectiveLang =
    langFilter !== "all" && availableLanguages.includes(langFilter)
      ? langFilter
      : "all";

  const providerReady = isProviderReady(config.provider);
  useEffect(() => {
    if (config.provider !== "sonicvoice" || !providerReady) return;
    const trimmed = search.trim();
    if (effectiveLang === "all" && !trimmed) return;
    const timer = window.setTimeout(() => {
      void onEnsureSonicVoices({
        language: effectiveLang === "all" ? undefined : effectiveLang,
        query: trimmed || undefined,
        limit: 200,
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [config.provider, effectiveLang, onEnsureSonicVoices, providerReady, search]);

  const filteredVoices = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = providerVoices.filter((v) => {
      if (effectiveLang !== "all" && v.language !== effectiveLang) return false;
      if (
        q &&
        !v.name.toLowerCase().includes(q) &&
        !v.id.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
    const sliced = list.slice(0, MAX_SELECT_VOICES);
    if (
      selectedCatalogVoice &&
      !sliced.some((v) => voiceKey(v) === voiceKey(selectedCatalogVoice))
    ) {
      sliced.unshift(selectedCatalogVoice);
    }
    return sliced;
  }, [effectiveLang, providerVoices, search, selectedCatalogVoice]);

  const omniProfiles = useMemo(
    () => voiceProfiles.filter((p) => p.referenceText.trim()),
    [voiceProfiles],
  );

  const handleProviderChange = (nextProvider: TtsProvider) => {
    if (nextProvider === "omnivoice") {
      const firstProf = omniProfiles[0];
      onChange(
        firstProf
          ? { provider: "omnivoice", mode: "clone", profileId: firstProf.id }
          : { provider: "omnivoice", mode: "auto" },
      );
      return;
    }
    const nextList = catalog.filter((v) => v.provider === nextProvider);
    const sameLang = nextList.filter((v) => v.language === defaultLanguage);
    const firstVoice = sameLang[0] ?? nextList[0];
    setLangFilter(firstVoice ? firstVoice.language : "all");
    setSearch("");
    onChange({
      provider: nextProvider,
      voiceKey: firstVoice ? voiceKey(firstVoice) : undefined,
      sonicProvider: firstVoice?.subProvider,
    });
  };

  const activePreview =
    selectedCatalogVoice && previewVoiceKey === voiceKey(selectedCatalogVoice);

  const languageName = (code: string) =>
    t(`tts.provider.languages.${code}`, { defaultValue: code });

  const sonicSpokenLanguages = useMemo(() => {
    const codes = new Set([
      ...SONIC_SPOKEN_LANGUAGES,
      ...(selectedCatalogVoice ? [selectedCatalogVoice.language] : []),
    ]);
    return [...codes].sort((a, b) =>
      languageName(a).localeCompare(languageName(b), i18n.language),
    );
  }, [i18n.language, selectedCatalogVoice]);

  const elevenModels = useMemo(() => {
    const fromApi = sonicModels.filter((m) => m.provider === "eleven");
    return fromApi.length > 0 ? fromApi : DEFAULT_ELEVEN_MODELS;
  }, [sonicModels]);

  const effectiveSonicSub =
    config.sonicProvider ?? selectedCatalogVoice?.subProvider;
  const effectiveSonicModel = config.sonicModel ?? defaultSonicModel;
  const effectiveSonicLangPref = config.language ?? "voice";
  const sonicApiLangPreview = useMemo(
    () =>
      formatSonicApiLanguage(
        effectiveSonicLangPref,
        selectedCatalogVoice?.language,
        effectiveSonicSub,
        effectiveSonicModel,
        sonicModels,
      ),
    [
      effectiveSonicLangPref,
      effectiveSonicModel,
      effectiveSonicSub,
      selectedCatalogVoice?.language,
      sonicModels,
    ],
  );

  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-background/70 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-1 font-mono text-xs font-semibold text-primary">
          [{tag}]
          <span className="font-sans text-[10px] font-normal text-muted-foreground">
            ×{turnCount}
          </span>
        </span>

        <Select
          value={config.provider}
          disabled={busy}
          onValueChange={(v) => handleProviderChange(v as TtsProvider)}
        >
          <SelectTrigger className="h-8 w-[125px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TTS_PROVIDERS.map(([id, label]) => (
              <SelectItem key={id} value={id}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {config.provider === "omnivoice" ? (
          <Select
            value={
              config.profileId ? `profile:${config.profileId}` : "mode:auto"
            }
            disabled={busy}
            onValueChange={(val) => {
              if (val.startsWith("profile:")) {
                onChange({
                  provider: "omnivoice",
                  mode: "clone",
                  profileId: val.slice("profile:".length),
                });
              } else {
                onChange({ provider: "omnivoice", mode: "auto" });
              }
            }}
          >
            <SelectTrigger className="h-8 min-w-[180px] flex-1 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mode:auto">
                OmniVoice ({t("tts.mode.auto")})
              </SelectItem>
              {omniProfiles.map((p) => (
                <SelectItem key={p.id} value={`profile:${p.id}`}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : config.provider === "vieneu" ? (
          <>
            <Select
              value={
                config.profileId
                  ? `profile:${config.profileId}`
                  : config.voiceKey
                    ? `voice:${config.voiceKey}`
                    : ""
              }
              disabled={busy}
              onValueChange={(val) => {
                if (val.startsWith("profile:")) {
                  onChange({
                    provider: "vieneu",
                    profileId: val.slice("profile:".length),
                  });
                } else if (val.startsWith("voice:")) {
                  onChange({
                    provider: "vieneu",
                    voiceKey: val.slice("voice:".length),
                  });
                }
              }}
            >
              <SelectTrigger className="h-8 min-w-[180px] flex-1 text-xs">
                <SelectValue placeholder={t("tts.provider.chooseVoice")} />
              </SelectTrigger>
              <SelectContent>
                {voiceProfiles.map((p) => (
                  <SelectItem key={p.id} value={`profile:${p.id}`}>
                    ★ {p.name}
                  </SelectItem>
                ))}
                {providerVoices.map((v) => {
                  const vk = voiceKey(v);
                  return (
                    <SelectItem key={vk} value={`voice:${vk}`}>
                      {v.name}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            {selectedCatalogVoice && !config.profileId && (
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-8 shrink-0"
                disabled={busy && !activePreview}
                onClick={() => onPreview(selectedCatalogVoice)}
                title={t("tts.provider.preview")}
              >
                {activePreview && previewLoading ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : activePreview ? (
                  <Square className="size-3.5" />
                ) : (
                  <Play className="size-3.5" />
                )}
              </Button>
            )}
          </>
        ) : (
          <>
            {availableLanguages.length > 1 && (
              <Select
                value={effectiveLang}
                disabled={busy}
                onValueChange={(nextLang) => {
                  setLangFilter(nextLang);
                  const candidates = providerVoices.filter(
                    (v) => nextLang === "all" || v.language === nextLang,
                  );
                  if (
                    candidates.length > 0 &&
                    (!selectedCatalogVoice ||
                      (nextLang !== "all" &&
                        selectedCatalogVoice.language !== nextLang))
                  ) {
                    onChange({
                      ...config,
                      voiceKey: voiceKey(candidates[0]),
                      sonicProvider: candidates[0].subProvider,
                    });
                  }
                }}
              >
                <SelectTrigger
                  className="h-8 w-[120px] text-xs"
                  aria-label={t("tts.sonic.filterAccent")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    {t("tts.sonic.filterShort", {
                      lang: t("tts.provider.allLanguages"),
                    })}
                  </SelectItem>
                  {availableLanguages.map((code) => (
                    <SelectItem key={code} value={code}>
                      {t("tts.sonic.filterShort", { lang: code.toUpperCase() })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            <Select
              value={config.voiceKey || ""}
              disabled={busy || filteredVoices.length === 0}
              onValueChange={(vk) => {
                const matched = providerVoices.find((v) => voiceKey(v) === vk);
                onChange({
                  ...config,
                  voiceKey: vk,
                  sonicProvider: matched?.subProvider,
                });
              }}
            >
              <SelectTrigger className="h-8 min-w-[170px] flex-1 text-xs">
                <SelectValue placeholder={t("tts.provider.chooseVoice")} />
              </SelectTrigger>
              <SelectContent>
                {filteredVoices.map((v) => {
                  const vk = voiceKey(v);
                  const label =
                    config.provider === "sonicvoice"
                      ? `${v.name} · ${v.owned ? t("tts.sonic.cloneBadge") : v.subProvider === "eleven" ? "11Labs" : "Mini"} (${v.language})`
                      : `${v.name} (${v.language})`;
                  return (
                    <SelectItem key={vk} value={vk}>
                      {label}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>

            {providerVoices.length > 40 && (
              <Input
                value={search}
                disabled={busy}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("tts.provider.search")}
                className="h-8 w-32 text-xs"
              />
            )}

            {selectedCatalogVoice && (
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-8 shrink-0"
                disabled={busy && !activePreview}
                onClick={() => onPreview(selectedCatalogVoice)}
                title={t("tts.provider.preview")}
              >
                {activePreview && previewLoading ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : activePreview ? (
                  <Square className="size-3.5" />
                ) : (
                  <Play className="size-3.5" />
                )}
              </Button>
            )}
          </>
        )}
      </div>

      {config.provider === "sonicvoice" && providerReady && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/50 pt-2 text-xs">
          <span className="text-[11px] text-muted-foreground">
            {t("tts.sonic.spokenLanguage")}
          </span>
          <Select
            value={effectiveSonicLangPref}
            disabled={busy}
            onValueChange={(val) => onChange({ ...config, language: val })}
          >
            <SelectTrigger className="h-7 w-auto min-w-[175px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="voice">
                {t("tts.sonic.matchVoiceShort", {
                  lang: selectedCatalogVoice
                    ? `${languageName(selectedCatalogVoice.language)} (${selectedCatalogVoice.language})`
                    : "auto",
                })}
              </SelectItem>
              <SelectItem value="auto">{t("tts.language.auto")}</SelectItem>
              {sonicSpokenLanguages.map((code) => (
                <SelectItem key={code} value={code}>
                  {languageName(code)} ({code})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            API: {sonicApiLangPreview}
          </span>

          {effectiveSonicSub === "eleven" && (
            <Select
              value={effectiveSonicModel}
              disabled={busy}
              onValueChange={(modelId) =>
                onChange({ ...config, sonicModel: modelId })
              }
            >
              <SelectTrigger
                className="h-7 w-auto min-w-[155px] text-xs"
                aria-label={t("tts.sonic.modelLabel")}
              >
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
          )}
        </div>
      )}

      {!providerReady && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          {config.provider === "sonicvoice"
            ? t("tts.sonic.missingKey")
            : t("tts.dialogue.speakerModelNotReady", { tag })}
        </p>
      )}
    </div>
  );
}

export function DialogueCastCard({
  controller: c,
}: {
  controller: TtsController;
}) {
  const { t } = useTranslation();
  const turns = useMemo(() => parseDialoguePreviewTurns(c.text), [c.text]);
  const countsByLower = useMemo(() => {
    const map = new Map<string, number>();
    for (const turn of turns) {
      if (turn.isNarrator) continue;
      const lower = turn.speaker.toLowerCase();
      map.set(lower, (map.get(lower) ?? 0) + 1);
    }
    return map;
  }, [turns]);

  if (c.dialogueTags.length === 0) return null;

  return (
    <div className="rounded-xl border border-primary/25 bg-card/70 p-4 shadow-2xs">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Users className="size-3.5" />
          </div>
          <div>
            <h2 className="text-sm font-semibold">{t("tts.dialogue.title")}</h2>
            <p className="text-xs text-muted-foreground">
              {t("tts.dialogue.hint")}
            </p>
          </div>
        </div>
        <span className="shrink-0 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
          {t("tts.dialogue.roleCount", { count: c.dialogueTags.length })}
        </span>
      </div>

      <div className="space-y-2">
        {c.dialogueTags.map((tag, index) => (
          <SpeakerRow
            key={tag.toLowerCase()}
            tag={tag}
            turnCount={countsByLower.get(tag.toLowerCase()) ?? 1}
            config={c.getSpeakerConfig(tag, index)}
            catalog={c.allCatalogVoices}
            voiceProfiles={c.voiceProfiles}
            sonicModels={c.sonicModels}
            defaultSonicModel={c.sonicModel}
            defaultLanguage={c.language}
            busy={c.busy}
            isProviderReady={c.isProviderReady}
            onEnsureSonicVoices={c.ensureSonicVoicesLoaded}
            previewVoiceKey={c.previewVoiceKey}
            previewLoading={c.previewLoading}
            onPreview={(v) => void c.previewVoice(v)}
            onChange={(next) => c.setSpeakerVoice(tag, next)}
          />
        ))}
      </div>
    </div>
  );
}
