import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useTtsStore } from "@/stores/tts-store";
import { useSettingsStore } from "@/stores/settings-store";
import {
  extractDialogueTags,
  findUnclosedDialogueTag,
  parseDialoguePreviewTurns,
} from "./dialogue-tags";
import { voiceKey } from "./voice-catalog";
import { voicePreviewText } from "./voice-preview-text";
import { createTtsJobId, toLocalTtsAudioUrl, ttsClient } from "./tts-client";
import {
  OMNIVOICE_MODEL,
  type TtsGeneratePayload,
  type CatalogVoice,
  type SonicBalance,
  type SonicModel,
  type SonicVoicesQuery,
  type TtsGenerateResult,
  type TtsModelStatus,
  type TtsProgressEvent,
  type TtsProvider,
  type TtsSpeakerVoiceConfig,
  type TtsSpeakerVoicePayload,
  type VoiceProfile,
} from "./types";
import { useTtsBatch } from "./use-tts-batch";

const MODEL_NOT_READY = "__tts-model-not-ready__";

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

export function useTtsController() {
  const { t } = useTranslation();
  const store = useTtsStore();
  const sonicvoiceApiKey = useSettingsStore((s) => s.sonicvoiceApiKey);
  const updateSetting = useSettingsStore((s) => s.updateSetting);

  const [selectedStatus, setSelectedStatus] = useState<TtsModelStatus>();
  const [hasLoadedStatus, setHasLoadedStatus] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [missingModelOpen, setMissingModelOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [referenceAudioPath, setReferenceAudioPath] = useState("");
  const [referenceText, setReferenceText] = useState("");
  const [activeJobId, setActiveJobId] = useState<string>();
  const activeJobIdRef = useRef<string>();
  activeJobIdRef.current = activeJobId;
  const [progress, setProgress] = useState<TtsProgressEvent>();
  const batchRunningRef = useRef(false);
  const previewAudio = useRef<HTMLAudioElement>();
  const previewJob = useRef<string>();
  const previewEpoch = useRef(0);
  const previewCache = useRef(new Map<string, string>());
  const failedPreviewUrls = useRef(new Set<string>());
  const [previewVoiceKey, setPreviewVoiceKey] = useState<string>();
  const [previewLoading, setPreviewLoading] = useState(false);

  const stopPreview = useCallback(() => {
    ++previewEpoch.current;
    const job = previewJob.current;
    if (job) {
      previewJob.current = undefined;
      void ttsClient.cancelJob(job).catch(() => undefined);
    }
    if (previewAudio.current) {
      previewAudio.current.onended = null;
      previewAudio.current.onerror = null;
      previewAudio.current.pause();
      previewAudio.current.removeAttribute("src");
      previewAudio.current.load();
      previewAudio.current = undefined;
    }
    setPreviewVoiceKey(undefined);
    setPreviewLoading(false);
  }, []);
  useEffect(() => stopPreview, [store.provider, stopPreview]);

  const provider = store.provider;
  const [catalog, setCatalog] = useState<CatalogVoice[]>([]);
  const [catalogError, setCatalogError] = useState(false);
  const loadCatalog = useCallback(() => {
    setCatalogError(false);
    void ttsClient
      .getCatalog()
      .then(setCatalog)
      .catch(() => setCatalogError(true));
  }, []);
  useEffect(loadCatalog, [loadCatalog]);

  const [sonicVoices, setSonicVoices] = useState<CatalogVoice[]>([]);
  const [sonicKnownVoices, setSonicKnownVoices] = useState<Record<string, CatalogVoice>>({});
  const [sonicModels, setSonicModels] = useState<SonicModel[]>([]);
  const [sonicBalance, setSonicBalance] = useState<SonicBalance>();
  const [sonicLoading, setSonicLoading] = useState(false);
  const [sonicCloning, setSonicCloning] = useState(false);
  const [sonicError, setSonicError] = useState<string>();
  const [sonicHasEnvKey, setSonicHasEnvKey] = useState(false);
  const sonicSearchReqRef = useRef(0);
  const sonicFetchedQueriesRef = useRef(new Set<string>());

  const hasSonicKey = Boolean(sonicvoiceApiKey.trim()) || sonicHasEnvKey;

  useEffect(() => {
    sonicFetchedQueriesRef.current.clear();
  }, [sonicvoiceApiKey]);

  const rememberSonicVoices = useCallback((items: CatalogVoice[]) => {
    if (!items.length) return;
    setSonicKnownVoices((prev) => {
      const next = { ...prev };
      for (const item of items) {
        next[`${item.language}:${item.id}`] = item;
      }
      return next;
    });
  }, []);

  const ensureSonicVoicesLoaded = useCallback(
    async (query: SonicVoicesQuery) => {
      if (!hasSonicKey) return;
      const cacheKey = JSON.stringify({
        subProvider: query.subProvider ?? "all",
        language: query.language ?? "all",
        gender: query.gender ?? "all",
        query: query.query ?? "",
        limit: query.limit ?? 200,
      });
      if (sonicFetchedQueriesRef.current.has(cacheKey)) return;
      sonicFetchedQueriesRef.current.add(cacheKey);
      try {
        const items = await ttsClient.getSonicVoices(query);
        rememberSonicVoices(items);
      } catch {
        sonicFetchedQueriesRef.current.delete(cacheKey);
      }
    },
    [hasSonicKey, rememberSonicVoices],
  );

  const refreshSonicBalance = useCallback(async () => {
    try {
      const bal = await ttsClient.getSonicBalance();
      setSonicBalance(bal);
      setSonicHasEnvKey(true);
      return bal;
    } catch {
      return undefined;
    }
  }, []);

  const searchSonicVoices = useCallback(
    async (query?: SonicVoicesQuery) => {
      const reqId = ++sonicSearchReqRef.current;
      setSonicLoading(true);
      setSonicError(undefined);
      try {
        const items = await ttsClient.getSonicVoices(query);
        if (reqId !== sonicSearchReqRef.current) return;
        setSonicHasEnvKey(true);
        setSonicVoices(items);
        rememberSonicVoices(items);
      } catch (error) {
        if (reqId !== sonicSearchReqRef.current) return;
        const msg = errorMessage(error, t("tts.sonic.loadError"));
        if (msg.includes("Missing SonicVoice API key")) {
          setSonicHasEnvKey(false);
          setSonicVoices([]);
          setSonicBalance(undefined);
          setSonicError(undefined);
        } else {
          setSonicError(msg);
        }
      } finally {
        if (reqId === sonicSearchReqRef.current) {
          setSonicLoading(false);
        }
      }
    },
    [rememberSonicVoices, t],
  );

  const refreshSonicAll = useCallback(
    async (query?: SonicVoicesQuery) => {
      const reqId = ++sonicSearchReqRef.current;
      setSonicLoading(true);
      setSonicError(undefined);
      try {
        const [bal, models, items] = await Promise.all([
          ttsClient.getSonicBalance(),
          ttsClient.getSonicModels(),
          ttsClient.getSonicVoices(query),
        ]);
        if (reqId !== sonicSearchReqRef.current) return;
        setSonicHasEnvKey(true);
        setSonicBalance(bal);
        setSonicModels(models);
        setSonicVoices(items);
        rememberSonicVoices(items);
      } catch (error) {
        if (reqId !== sonicSearchReqRef.current) return;
        const msg = errorMessage(error, t("tts.sonic.loadError"));
        if (msg.includes("Missing SonicVoice API key")) {
          setSonicHasEnvKey(false);
          setSonicBalance(undefined);
          setSonicModels([]);
          setSonicVoices([]);
          setSonicError(undefined);
        } else {
          setSonicError(msg);
        }
      } finally {
        if (reqId === sonicSearchReqRef.current) {
          setSonicLoading(false);
        }
      }
    },
    [rememberSonicVoices, t],
  );

  const setSonicvoiceApiKey = useCallback(
    (key: string) => {
      updateSetting("sonicvoiceApiKey", key);
    },
    [updateSetting],
  );

  const cloneSonicVoice = useCallback(
    async (params: {
      audioPath: string;
      name: string;
      language?: string;
      gender?: string;
      needNoiseReduction?: boolean;
    }): Promise<CatalogVoice | undefined> => {
      setSonicCloning(true);
      try {
        const created = await ttsClient.cloneSonicVoice(params);
        setSonicVoices((prev) => [
          created,
          ...prev.filter((v) => v.id !== created.id),
        ]);
        rememberSonicVoices([created]);
        store.setProvider("sonicvoice");
        store.setProviderVoice(`${created.language}:${created.id}`);
        toast.success(t("tts.sonic.cloneSuccess"));
        return created;
      } catch (error) {
        toast.error(errorMessage(error, t("tts.sonic.cloneError")));
        return undefined;
      } finally {
        setSonicCloning(false);
      }
    },
    [rememberSonicVoices, store, t],
  );

  const deleteSonicVoice = useCallback(
    async (voiceId: string): Promise<boolean> => {
      try {
        await ttsClient.deleteSonicVoice(voiceId);
        setSonicVoices((prev) => prev.filter((v) => v.id !== voiceId));
        setSonicKnownVoices((prev) => {
          const next = { ...prev };
          for (const k of Object.keys(next)) {
            if (next[k].id === voiceId) delete next[k];
          }
          return next;
        });
        if (
          provider === "sonicvoice" &&
          store.providerVoiceIds.sonicvoice?.endsWith(`:${voiceId}`)
        ) {
          store.setProviderVoice("");
        }
        toast.success(t("tts.sonic.deleteSuccess"));
        return true;
      } catch (error) {
        toast.error(errorMessage(error, t("tts.sonic.deleteError")));
        return false;
      }
    },
    [provider, store, t],
  );

  useEffect(() => {
    const trimmed = sonicvoiceApiKey.trim();
    if (!trimmed && provider !== "sonicvoice") return;
    void refreshSonicAll({
      subProvider: store.sonicSubFilter,
    });
  }, [provider, refreshSonicAll, sonicvoiceApiKey, store.sonicSubFilter]);

  const allCatalogVoices = useMemo(() => {
    const known = Object.values(sonicKnownVoices);
    if (!known.length) return catalog;
    return [...catalog, ...known];
  }, [catalog, sonicKnownVoices]);

  const voices = useMemo(
    () =>
      provider === "sonicvoice"
        ? sonicVoices
        : catalog.filter((v) => v.provider === provider),
    [catalog, provider, sonicVoices],
  );

  const selectedVoice = useMemo(() => {
    const sel = store.providerVoiceIds[provider];
    if (!sel) return undefined;
    if (provider === "sonicvoice") {
      return (
        sonicVoices.find((v) => `${v.language}:${v.id}` === sel) ??
        sonicKnownVoices[sel]
      );
    }
    return voices.find((v) => `${v.language}:${v.id}` === sel);
  }, [provider, sonicKnownVoices, sonicVoices, store.providerVoiceIds, voices]);

  const vieneuProfile = store.voiceProfiles.find(
    (p) => p.id === store.vieneuProfileId,
  );
  const selectedModel =
    provider === "omnivoice"
      ? OMNIVOICE_MODEL
      : {
          ...OMNIVOICE_MODEL,
          id: provider,
          name:
            provider === "vieneu"
              ? "VieNeu"
              : provider === "capcut"
                ? "CapCut"
                : provider === "sonicvoice"
                  ? "SonicVoice"
                  : "ElevenLabs",
          parameterSize:
            provider === "vieneu" ? "CPU" : t("tts.provider.online"),
        };
  const mode = store.mode;
  const compatibleProfiles =
    provider === "omnivoice"
      ? store.voiceProfiles.filter((p) => p.referenceText.trim())
      : store.voiceProfiles;
  const selectedProfile = useMemo(
    () =>
      compatibleProfiles.find(
        (profile) => profile.id === store.selectedProfileId,
      ),
    [compatibleProfiles, store.selectedProfileId],
  );
  const currentModelLabel =
    provider === "omnivoice"
      ? `${selectedModel.parameterSize} · ${t(`tts.mode.${mode}`)}`
      : provider === "vieneu"
        ? t("tts.provider.local")
        : provider === "sonicvoice"
          ? t("tts.sonic.subtitle")
          : t("tts.provider.viaCapcut");

  const [omniReady, setOmniReady] = useState(false);
  const [vieneuReady, setVieneuReady] = useState(false);

  useEffect(() => {
    void ttsClient.syncProfiles(store.voiceProfiles).catch(() => undefined);
  }, [store.voiceProfiles]);

  const statusRequest = useRef(0);
  const refreshStatuses = useCallback(async () => {
    const request = ++statusRequest.current;
    void ttsClient
      .getVieneuStatus()
      .then((s) => setVieneuReady(s.status === "ready"))
      .catch(() => setVieneuReady(false));
    if (provider !== "omnivoice") {
      void ttsClient
        .getStatus()
        .then((s) => setOmniReady(s.status === "ready"))
        .catch(() => setOmniReady(false));
    }
    try {
      const result =
        provider === "omnivoice"
          ? await ttsClient.getStatus()
          : provider === "vieneu"
            ? await ttsClient.getVieneuStatus()
            : {
                modelId: provider,
                status: "ready" as const,
                runtimeReady: true,
                pythonAvailable: true,
              };
      if (provider === "omnivoice") setOmniReady(result.status === "ready");
      if (provider === "vieneu") setVieneuReady(result.status === "ready");
      if (request === statusRequest.current) setSelectedStatus(result);
    } catch (error) {
      const msg = errorMessage(error, t("tts.toast.statusFailed"));
      if (request !== statusRequest.current) return;
      setSelectedStatus({
        modelId: selectedModel.id,
        status: "not-installed",
        runtimeReady: false,
        pythonAvailable: false,
        message: msg,
      });
      toast.error(msg);
    } finally {
      setHasLoadedStatus(true);
    }
  }, [selectedModel.id, provider, t]);

  const isProviderReady = useCallback(
    (targetProvider: TtsProvider): boolean => {
      if (targetProvider === "capcut" || targetProvider === "elevenlabs") {
        return true;
      }
      if (targetProvider === "sonicvoice") {
        return hasSonicKey;
      }
      if (targetProvider === provider && selectedStatus) {
        return selectedStatus.status === "ready";
      }
      return targetProvider === "vieneu" ? vieneuReady : omniReady;
    },
    [hasSonicKey, omniReady, provider, selectedStatus, vieneuReady],
  );

  useEffect(() => {
    void refreshStatuses();
  }, [refreshStatuses]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    void ttsClient
      .onProgress((event) => {
        if (
          active &&
          (!activeJobIdRef.current || event.jobId === activeJobIdRef.current)
        ) {
          setProgress(event);
        }
      })
      .then((fn) => {
        if (active) unlisten = fn;
        else fn();
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (
      store.selectedProfileId &&
      !compatibleProfiles.some(
        (profile) => profile.id === store.selectedProfileId,
      )
    ) {
      store.setSelectedProfileId(undefined);
    }
  }, [compatibleProfiles, store.selectedProfileId, store.setSelectedProfileId]);

  useEffect(() => {
    if (
      hasLoadedStatus &&
      provider === "omnivoice" &&
      !store.hasSeenModelPrompt &&
      selectedStatus?.status !== "ready"
    ) {
      setMissingModelOpen(true);
    }
  }, [
    hasLoadedStatus,
    selectedStatus?.status,
    store.hasSeenModelPrompt,
    provider,
  ]);

  const installModel = useCallback(async () => {
    if (activeJobId || batchRunningRef.current) {
      toast.info(t("tts.toast.jobBusy"));
      return;
    }

    const jobId = createTtsJobId("install");
    setActiveJobId(jobId);
    setProgress({
      jobId,
      kind: "install",
      stage: "starting",
      percent: 1,
      message: t("tts.toast.preparing"),
    });
    setSelectedStatus((current) => ({
      ...(current || {
        modelId: selectedModel.id,
        runtimeReady: false,
        pythonAvailable: false,
      }),
      status: "downloading",
    }));

    try {
      const result =
        provider === "vieneu"
          ? await ttsClient.installVieneu(jobId)
          : await ttsClient.installModel(jobId);
      if (result.success) {
        toast.success(t("tts.toast.modelReady", { model: selectedModel.name }));
      } else if (!result.canceled) {
        toast.error(result.error || t("tts.toast.downloadFailed"));
      }
    } catch (error) {
      toast.error(errorMessage(error, t("tts.toast.downloadFailed")));
    } finally {
      setActiveJobId(undefined);
      await refreshStatuses();
    }
  }, [
    activeJobId,
    refreshStatuses,
    selectedModel.id,
    selectedModel.name,
    provider,
    t,
  ]);

  const removeModel = useCallback(async () => {
    if (activeJobId || batchRunningRef.current) {
      toast.info(t("tts.toast.jobBusy"));
      return;
    }
    try {
      const result = await ttsClient.removeModel();
      if (result.success) toast.success(t("tts.toast.modelRemoved"));
      else toast.error(result.error || t("tts.toast.removeFailed"));
    } catch (error) {
      toast.error(errorMessage(error, t("tts.toast.removeFailed")));
    } finally {
      await refreshStatuses();
    }
  }, [activeJobId, refreshStatuses, t]);

  const pickReferenceAudio = useCallback(async () => {
    try {
      const result = await ttsClient.pickReferenceAudio(
        t("tts.native.selectReferenceAudio"),
      );
      if (result.path) setReferenceAudioPath(result.path);
    } catch (error) {
      toast.error(errorMessage(error, t("tts.toast.profileRequiredFields")));
    }
  }, [t]);

  const saveProfile = useCallback(() => {
    if (
      !profileName.trim() ||
      !referenceAudioPath ||
      (provider === "omnivoice" && !referenceText.trim())
    ) {
      toast.error(t("tts.toast.profileRequiredFields"));
      return;
    }
    const profile: VoiceProfile = {
      id: createTtsJobId("voice"),
      name: profileName.trim(),
      modelId: selectedModel.id,
      referenceAudioPath,
      referenceText: referenceText.trim(),
      createdAt: Date.now(),
    };
    store.addVoiceProfile(profile);
    if (provider === "vieneu") store.setVieneuProfile(profile.id);
    setProfileOpen(false);
    setProfileName("");
    setReferenceAudioPath("");
    setReferenceText("");
    toast.success(t("tts.toast.profileSaved"));
  }, [
    profileName,
    referenceAudioPath,
    referenceText,
    selectedModel.id,
    store.addVoiceProfile,
    store.setVieneuProfile,
    provider,
    t,
  ]);

  const removeVoiceProfile = useCallback(
    (id: string) => {
      store.removeVoiceProfile(id);
      void ttsClient.removeVoicePrompt(id).catch(() => undefined);
    },
    [store.removeVoiceProfile],
  );

  const dialogueTags = useMemo(
    () => extractDialogueTags(store.text),
    [store.text],
  );

  const getSpeakerConfig = useCallback(
    (tag: string, index = 0): TtsSpeakerVoiceConfig => {
      const savedKey = Object.keys(store.speakerVoices).find(
        (k) => k.toLowerCase() === tag.toLowerCase(),
      );
      if (savedKey && store.speakerVoices[savedKey]) {
        return store.speakerVoices[savedKey];
      }

      const preferredLang =
        provider === "omnivoice"
          ? store.language
          : (selectedVoice?.language ?? store.language);
      const fallbackProvider: TtsProvider =
        provider === "capcut" ||
        provider === "elevenlabs" ||
        (provider === "sonicvoice" && hasSonicKey) ||
        (provider === "vieneu" && isProviderReady("vieneu"))
          ? provider
          : catalog.some(
                (v) => v.provider === "capcut" && v.language === preferredLang,
              )
            ? "capcut"
            : provider;

      if (fallbackProvider === "omnivoice") {
        const otherProfile = compatibleProfiles.find(
          (p) => p.id !== store.selectedProfileId,
        );
        return otherProfile
          ? { provider: "omnivoice", mode: "clone", profileId: otherProfile.id }
          : { provider: "omnivoice", mode: "auto" };
      }

      const providerCatalog = allCatalogVoices.filter(
        (v) => v.provider === fallbackProvider,
      );
      const sameLang = providerCatalog.filter(
        (v) => v.language === preferredLang,
      );
      const pool = sameLang.length > 0 ? sameLang : providerCatalog;
      const nonNarratorPool =
        selectedVoice && fallbackProvider === provider
          ? pool.filter((v) => v.id !== selectedVoice.id)
          : pool;
      const pickFrom = nonNarratorPool.length > 0 ? nonNarratorPool : pool;
      const picked =
        pickFrom.length > 0 ? pickFrom[index % pickFrom.length] : undefined;

      return {
        provider: fallbackProvider,
        voiceKey: picked ? voiceKey(picked) : undefined,
        sonicProvider: picked?.subProvider,
      };
    },
    [
      allCatalogVoices,
      catalog,
      compatibleProfiles,
      hasSonicKey,
      isProviderReady,
      provider,
      selectedVoice,
      store.language,
      store.selectedProfileId,
      store.speakerVoices,
    ],
  );

  const resolveSpeakersForText = useCallback(
    (
      text: string,
    ): {
      speakers?: Record<string, TtsSpeakerVoicePayload>;
      error?: string;
    } => {
      const tags = extractDialogueTags(text);
      if (tags.length === 0) return {};

      const speakers: Record<string, TtsSpeakerVoicePayload> = {};
      for (let i = 0; i < tags.length; i++) {
        const tag = tags[i];
        const cfg = getSpeakerConfig(tag, i);
        if (!isProviderReady(cfg.provider)) {
          return {
            error: t("tts.dialogue.speakerModelNotReady", { tag }),
          };
        }

        if (cfg.provider === "omnivoice") {
          const spkMode = cfg.profileId ? "clone" : (cfg.mode ?? "auto");
          if (spkMode === "clone") {
            const prof = store.voiceProfiles.find(
              (p) => p.id === cfg.profileId && p.referenceText.trim(),
            );
            if (!prof) {
              return { error: t("tts.dialogue.chooseSpeakerVoice", { tag }) };
            }
            speakers[tag] = {
              provider: "omnivoice",
              mode: "clone",
              profileId: prof.id,
              referenceAudioPath: prof.referenceAudioPath,
              referenceText: prof.referenceText,
              language: store.language,
              speed: cfg.speed ?? store.speed,
            };
          } else {
            speakers[tag] = {
              provider: "omnivoice",
              mode: "auto",
              language: store.language,
              speed: cfg.speed ?? store.speed,
            };
          }
          continue;
        }

        if (cfg.provider === "vieneu" && cfg.profileId) {
          const prof = store.voiceProfiles.find((p) => p.id === cfg.profileId);
          if (!prof) {
            return { error: t("tts.dialogue.chooseSpeakerVoice", { tag }) };
          }
          speakers[tag] = {
            provider: "vieneu",
            profileId: prof.id,
            referenceAudioPath: prof.referenceAudioPath,
            language: "vi",
            speed: cfg.speed ?? store.speed,
          };
          continue;
        }

        const matchedVoice = allCatalogVoices.find(
          (v) => v.provider === cfg.provider && voiceKey(v) === cfg.voiceKey,
        );
        if (!matchedVoice) {
          return { error: t("tts.dialogue.chooseSpeakerVoice", { tag }) };
        }
        const subProv =
          cfg.provider === "sonicvoice"
            ? (cfg.sonicProvider ?? matchedVoice.subProvider)
            : undefined;
        const spkLangPref = cfg.language ?? "voice";
        const resolvedSpkLang =
          cfg.provider === "sonicvoice"
            ? spkLangPref === "voice"
              ? matchedVoice.language
              : spkLangPref
            : matchedVoice.language;
        speakers[tag] = {
          provider: cfg.provider,
          voiceId: matchedVoice.id,
          language: resolvedSpkLang,
          speed: cfg.speed ?? store.speed,
          sonicProvider: subProv,
          sonicModel:
            cfg.provider === "sonicvoice" && subProv === "eleven"
              ? (cfg.sonicModel ?? store.sonicModel)
              : undefined,
        };
      }

      return { speakers };
    },
    [
      allCatalogVoices,
      getSpeakerConfig,
      isProviderReady,
      store.language,
      store.sonicModel,
      store.speed,
      store.voiceProfiles,
      t,
    ],
  );

  const baseVoiceLabel =
    provider === "vieneu" && vieneuProfile
      ? `VieNeu · ${vieneuProfile.name}`
      : provider !== "omnivoice"
        ? `${selectedModel.name} · ${selectedVoice?.name || ""} · ${selectedVoice?.id || ""}`
        : mode === "clone"
          ? selectedProfile?.name || t("tts.settings.cloneMode")
          : t(`tts.mode.${mode}`);

  const voiceLabel =
    dialogueTags.length > 0
      ? `${baseVoiceLabel} + [${dialogueTags.join(", ")}]`
      : baseVoiceLabel;

  const validateGeneration = useCallback(
    (targetText?: string): string | null => {
      const textToCheck = targetText ?? store.text;
      const tags = extractDialogueTags(textToCheck);
      const unclosed = findUnclosedDialogueTag(textToCheck, tags);
      if (unclosed) {
        return t("tts.dialogue.unclosedHint", { tag: unclosed.tag });
      }

      const previewTurns =
        tags.length > 0 ? parseDialoguePreviewTurns(textToCheck) : [];
      const hasNarratorTurn =
        tags.length === 0 || previewTurns.some((turn) => turn.isNarrator);

      if (hasNarratorTurn) {
        if (provider === "sonicvoice" && !hasSonicKey) {
          return t("tts.sonic.missingKey");
        }
        if (
          provider !== "omnivoice" &&
          !selectedVoice &&
          !(provider === "vieneu" && vieneuProfile)
        )
          return t("tts.provider.chooseVoice");
        if (provider === "vieneu" && selectedStatus?.status !== "ready")
          return t("tts.provider.installFirst");
        if (
          selectedStatus?.status !== "ready" ||
          selectedStatus.modelId !== selectedModel.id
        ) {
          if (provider === "omnivoice") setMissingModelOpen(true);
          return MODEL_NOT_READY;
        }
        if (provider === "omnivoice" && mode === "clone" && !selectedProfile) {
          return t("tts.toast.profileRequired");
        }
        if (
          provider === "omnivoice" &&
          mode === "design" &&
          !store.instruction.trim()
        ) {
          return t("tts.toast.instructionRequired");
        }
      }

      const resolved = resolveSpeakersForText(textToCheck);
      if (resolved.error) {
        return resolved.error;
      }
      return null;
    },
    [
      hasSonicKey,
      mode,
      resolveSpeakersForText,
      selectedProfile,
      selectedStatus,
      store.instruction,
      store.text,
      provider,
      selectedVoice,
      selectedModel.id,
      vieneuProfile,
      t,
    ],
  );

  const buildGeneratePayload = useCallback(
    (jobId: string, text: string): TtsGeneratePayload => {
      const { speakers } = resolveSpeakersForText(text);
      const isSonicEleven =
        provider === "sonicvoice" && selectedVoice?.subProvider === "eleven";
      const resolvedSonicLang =
        store.sonicLanguage === "voice"
          ? (selectedVoice?.language ?? "auto")
          : store.sonicLanguage;
      return {
        jobId,
        text,
        mode: provider === "omnivoice" ? mode : "auto",
        provider,
        voiceId: selectedVoice?.id,
        splitMode: store.splitMode,
        language:
          provider === "omnivoice"
            ? store.language
            : provider === "sonicvoice"
              ? resolvedSonicLang
              : (selectedVoice?.language ?? store.language),
        speed: store.speed,
        numStep: store.numStep,
        advancedSettings: store.advancedEnabled
          ? store.advancedSettings
          : undefined,
        instruction: mode === "design" ? store.instruction.trim() : undefined,
        profileId:
          provider === "omnivoice" && mode === "clone"
            ? selectedProfile?.id
            : undefined,
        referenceAudioPath:
          provider === "vieneu"
            ? vieneuProfile?.referenceAudioPath
            : provider === "omnivoice" && mode === "clone"
              ? selectedProfile?.referenceAudioPath
              : undefined,
        referenceText:
          provider === "omnivoice" && mode === "clone"
            ? selectedProfile?.referenceText
            : undefined,
        speakers,
        sonicProvider:
          provider === "sonicvoice" ? selectedVoice?.subProvider : undefined,
        sonicModel: isSonicEleven ? store.sonicModel : undefined,
        sonicPitch:
          provider === "sonicvoice" && !isSonicEleven
            ? store.sonicPitch
            : undefined,
        sonicStability: isSonicEleven ? store.sonicStability : undefined,
        sonicSimilarity: isSonicEleven ? store.sonicSimilarity : undefined,
      };
    },
    [
      mode,
      resolveSpeakersForText,
      selectedProfile,
      store.advancedEnabled,
      store.advancedSettings,
      store.instruction,
      store.language,
      store.numStep,
      store.sonicLanguage,
      store.sonicModel,
      store.sonicPitch,
      store.sonicSimilarity,
      store.sonicStability,
      store.speed,
      store.splitMode,
      provider,
      selectedVoice,
      vieneuProfile,
    ],
  );

  const runGeneration = useCallback(
    async (jobId: string, text: string): Promise<TtsGenerateResult> => {
      stopPreview();
      setActiveJobId(jobId);
      setProgress({
        jobId,
        kind: "generate",
        stage: "starting",
        percent: 2,
        message: t("tts.toast.preparing"),
      });
      try {
        const res = await ttsClient.generate(buildGeneratePayload(jobId, text));
        if (res.success && provider === "sonicvoice") {
          void refreshSonicBalance();
        }
        return res;
      } finally {
        setActiveJobId(undefined);
      }
    },
    [buildGeneratePayload, provider, refreshSonicBalance, stopPreview, t],
  );

  const validateBatch = useCallback(() => {
    const invalid = validateGeneration("");
    return invalid === MODEL_NOT_READY ? t("tts.batch.modelNotReady") : invalid;
  }, [t, validateGeneration]);

  const batch = useTtsBatch({ validate: validateBatch, runGeneration });
  batchRunningRef.current = batch.running;
  const busy = Boolean(activeJobId) || batch.running;

  const previewVoice = useCallback(
    async (voice: CatalogVoice) => {
      const key = voiceKey(voice);
      if (key === previewVoiceKey) {
        stopPreview();
        return;
      }
      if (activeJobId || previewJob.current || batchRunningRef.current) return;
      if (!isProviderReady(voice.provider)) {
        toast.info(
          voice.provider === "sonicvoice"
            ? t("tts.sonic.missingKey")
            : t("tts.provider.installFirst"),
        );
        return;
      }
      stopPreview();
      const epoch = previewEpoch.current;
      setPreviewVoiceKey(key);

      const directUrl =
        voice.previewUrl &&
        !failedPreviewUrls.current.has(key) &&
        (voice.previewUrl.startsWith("https://") ||
          voice.previewUrl.startsWith("http://127.0.0.1"))
          ? voice.previewUrl
          : undefined;

      if (directUrl) {
        try {
          const audio = new Audio(directUrl);
          previewAudio.current = audio;
          audio.onended = () => {
            if (epoch === previewEpoch.current) stopPreview();
          };
          audio.onerror = () => {
            if (epoch !== previewEpoch.current) return;
            failedPreviewUrls.current.add(key);
            stopPreview();
            toast.error(t("tts.provider.previewFailed"));
          };
          await audio.play();
          return;
        } catch {
          if (epoch !== previewEpoch.current) return;
          failedPreviewUrls.current.add(key);
        }
      }

      let path = previewCache.current.get(key);
      try {
        if (!path) {
          const jobId = createTtsJobId("preview");
          previewJob.current = jobId;
          setActiveJobId(jobId);
          setPreviewLoading(true);
          setProgress({
            jobId,
            kind: "generate",
            stage: "starting",
            percent: 2,
            message: t("tts.provider.previewPreparing"),
          });
          try {
            const result = await ttsClient.generate({
              jobId,
              provider: voice.provider,
              voiceId: voice.id,
              text: voicePreviewText(voice.language),
              mode: "auto",
              splitMode: "default",
              language: voice.language,
              speed: 1,
              sonicProvider: voice.subProvider,
              sonicModel:
                voice.provider === "sonicvoice" && voice.subProvider === "eleven"
                  ? store.sonicModel
                  : undefined,
            });
            if (epoch !== previewEpoch.current) return;
            if (result.canceled) {
              stopPreview();
              return;
            }
            if (!result.success || !result.outputPath)
              throw new Error(result.error || t("tts.provider.previewFailed"));
            path = result.outputPath;
            previewCache.current.set(key, path);
            if (voice.provider === "sonicvoice") {
              void refreshSonicBalance();
            }
          } finally {
            if (previewJob.current === jobId) previewJob.current = undefined;
            setActiveJobId((current) =>
              current === jobId ? undefined : current,
            );
            if (epoch === previewEpoch.current) setPreviewLoading(false);
          }
        }
        if (epoch !== previewEpoch.current || !path) return;
        const audio = new Audio(toLocalTtsAudioUrl(path));
        previewAudio.current = audio;
        audio.onended = () => {
          if (epoch === previewEpoch.current) stopPreview();
        };
        audio.onerror = () => {
          if (epoch !== previewEpoch.current) return;
          previewCache.current.delete(key);
          stopPreview();
          toast.error(t("tts.provider.previewFailed"));
        };
        await audio.play();
      } catch (err) {
        if (epoch !== previewEpoch.current) return;
        previewCache.current.delete(key);
        stopPreview();
        toast.error(errorMessage(err, t("tts.provider.previewFailed")));
      }
    },
    [
      activeJobId,
      isProviderReady,
      previewVoiceKey,
      refreshSonicBalance,
      stopPreview,
      store.sonicModel,
      t,
    ],
  );

  const cancelJob = useCallback(async () => {
    stopPreview();
    batch.requestStop();
    if (!activeJobId) return;
    await ttsClient.cancelJob(activeJobId).catch(() => undefined);
    setActiveJobId(undefined);
    await refreshStatuses();
    toast.info(t("tts.toast.cancelRequested"));
  }, [activeJobId, batch.requestStop, refreshStatuses, stopPreview, t]);

  const generate = useCallback(async () => {
    const text = store.text.trim();
    if (!text) {
      toast.error(t("tts.toast.textRequired"));
      return;
    }
    const invalid = validateGeneration(text);
    if (invalid) {
      if (invalid !== MODEL_NOT_READY) toast.error(invalid);
      return;
    }

    const jobId = createTtsJobId("generate");
    let result: TtsGenerateResult;
    try {
      result = await runGeneration(jobId, text);
    } catch (error) {
      toast.error(errorMessage(error, t("tts.toast.generateFailed")));
      return;
    }

    if (!result.success || !result.outputPath) {
      if (!result.canceled) {
        toast.error(result.error || t("tts.toast.generateFailed"));
      }
      return;
    }

    store.addHistory({
      id: jobId,
      name: text.slice(0, 80),
      modelId: selectedModel.id,
      text,
      mode,
      voiceLabel,
      outputPath: result.outputPath,
      srtPath: result.srtPath,
      createdAt: Date.now(),
    });
    store.setText("");
    toast.success(t("tts.toast.audioCreated"));
  }, [
    mode,
    runGeneration,
    selectedModel.id,
    store.addHistory,
    store.setText,
    store.text,
    t,
    validateGeneration,
    voiceLabel,
  ]);

  const revealAudio = useCallback(async (filePath: string) => {
    try {
      const result = await ttsClient.revealAudio(filePath);
      if (!result.success && result.error) toast.error(result.error);
    } catch (error) {
      toast.error(errorMessage(error, "Could not reveal audio file"));
    }
  }, []);

  const exportAudio = useCallback(
    async (sourcePath: string) => {
      try {
        const result = await ttsClient.exportAudio(
          sourcePath,
          t("tts.native.exportAudio"),
        );
        if (result.success) {
          toast.success(t("tts.toast.audioExported"));
        } else if (!result.canceled && result.error) {
          toast.error(result.error);
        }
      } catch (error) {
        toast.error(errorMessage(error, "Could not export audio"));
      }
    },
    [t],
  );

  const exportSrt = useCallback(
    async (srtPath: string) => {
      try {
        const result = await ttsClient.exportAudio(
          srtPath,
          t("tts.native.exportSrt"),
        );
        if (result.success) {
          toast.success(t("tts.toast.srtExported"));
        } else if (!result.canceled && result.error) {
          toast.error(result.error);
        }
      } catch (error) {
        toast.error(errorMessage(error, "Could not export SRT"));
      }
    },
    [t],
  );

  const closeMissingModelPrompt = useCallback(() => {
    store.markModelPromptSeen();
    setMissingModelOpen(false);
  }, [store.markModelPromptSeen]);

  const installSelectedModelFromPrompt = useCallback(() => {
    closeMissingModelPrompt();
    void installModel();
  }, [closeMissingModelPrompt, installModel]);

  return {
    catalog,
    allCatalogVoices,
    sonicvoiceApiKey,
    setSonicvoiceApiKey,
    hasSonicKey,
    sonicVoices,
    sonicModels,
    sonicBalance,
    sonicLoading,
    sonicCloning,
    sonicError,
    sonicSubFilter: store.sonicSubFilter,
    setSonicSubFilter: store.setSonicSubFilter,
    sonicModel: store.sonicModel,
    setSonicModel: store.setSonicModel,
    sonicLanguage: store.sonicLanguage,
    setSonicLanguage: store.setSonicLanguage,
    sonicPitch: store.sonicPitch,
    setSonicPitch: store.setSonicPitch,
    sonicStability: store.sonicStability,
    setSonicStability: store.setSonicStability,
    sonicSimilarity: store.sonicSimilarity,
    setSonicSimilarity: store.setSonicSimilarity,
    refreshSonicBalance,
    searchSonicVoices,
    ensureSonicVoicesLoaded,
    refreshSonicAll,
    cloneSonicVoice,
    deleteSonicVoice,
    voiceProfiles: store.voiceProfiles,
    dialogueTags,
    getSpeakerConfig,
    setSpeakerVoice: store.setSpeakerVoice,
    isProviderReady,
    favoriteVoiceKeys: store.favoriteVoiceKeys,
    toggleFavoriteVoice: store.toggleFavoriteVoice,
    previewVoiceKey,
    previewLoading,
    previewVoice,
    stopPreview,
    vieneuProfileId: store.vieneuProfileId,
    setVieneuProfile: store.setVieneuProfile,
    provider,
    setProvider: store.setProvider,
    voices,
    selectedVoice,
    setProviderVoice: store.setProviderVoice,
    catalogError,
    loadCatalog,
    selectedModel,
    selectedStatus,
    currentModelLabel,
    mode,
    setMode: store.setMode,
    compatibleProfiles,
    selectedProfile,
    selectedProfileId: store.selectedProfileId,
    setSelectedProfileId: store.setSelectedProfileId,
    removeVoiceProfile,
    activeJobId,
    progress,
    busy,
    batch,
    managerOpen,
    setManagerOpen,
    missingModelOpen,
    setMissingModelOpen,
    profileOpen,
    setProfileOpen,
    profileName,
    setProfileName,
    referenceAudioPath,
    referenceText,
    setReferenceText,
    text: store.text,
    setText: store.setText,
    instruction: store.instruction,
    setInstruction: store.setInstruction,
    language: store.language,
    setLanguage: store.setLanguage,
    savedLanguages: store.savedLanguages,
    addSavedLanguage: store.addSavedLanguage,
    removeSavedLanguage: store.removeSavedLanguage,
    speed: store.speed,
    setSpeed: store.setSpeed,
    numStep: store.numStep,
    setNumStep: store.setNumStep,
    splitMode: store.splitMode,
    setSplitMode: store.setSplitMode,
    advancedEnabled: store.advancedEnabled,
    setAdvancedEnabled: store.setAdvancedEnabled,
    advancedSettings: store.advancedSettings,
    setAdvancedSetting: store.setAdvancedSetting,
    resetAdvancedSettings: store.resetAdvancedSettings,
    history: store.history,
    renameHistory: store.renameHistory,
    removeHistory: store.removeHistory,
    installModel,
    removeModel,
    cancelJob,
    pickReferenceAudio,
    saveProfile,
    generate,
    revealAudio,
    exportAudio,
    exportSrt,
    closeMissingModelPrompt,
    installSelectedModelFromPrompt,
  };
}

export type TtsController = ReturnType<typeof useTtsController>;
