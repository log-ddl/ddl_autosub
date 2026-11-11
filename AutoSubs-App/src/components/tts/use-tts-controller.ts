import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useTtsStore } from "@/stores/tts-store";
import { voiceKey } from "./voice-catalog";
import { voicePreviewText } from "./voice-preview-text";
import { createTtsJobId, toLocalTtsAudioUrl, ttsClient } from "./tts-client";
import {
  OMNIVOICE_MODEL,
  type TtsGeneratePayload,
  type CatalogVoice,
  type TtsGenerateResult,
  type TtsModelStatus,
  type TtsProgressEvent,
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

  const [selectedStatus, setSelectedStatus] = useState<TtsModelStatus>();
  const [hasLoadedStatus, setHasLoadedStatus] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [missingModelOpen, setMissingModelOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [referenceAudioPath, setReferenceAudioPath] = useState("");
  const [referenceText, setReferenceText] = useState("");
  const [activeJobId, setActiveJobId] = useState<string>();
  const [progress, setProgress] = useState<TtsProgressEvent>();
  const batchRunningRef = useRef(false);
  const previewAudio = useRef<HTMLAudioElement>();
  const previewJob = useRef<string>();
  const previewEpoch = useRef(0);
  const previewCache = useRef(new Map<string, string>());
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
  const voices = useMemo(
    () => catalog.filter((v) => v.provider === provider),
    [catalog, provider],
  );
  const selectedVoice = voices.find(
    (v) => `${v.language}:${v.id}` === store.providerVoiceIds[provider],
  );
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
        : t("tts.provider.viaCapcut");

  const statusRequest = useRef(0);
  const refreshStatuses = useCallback(async () => {
    const request = ++statusRequest.current;
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

  useEffect(() => {
    void refreshStatuses();
  }, [refreshStatuses]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    void ttsClient
      .onProgress((event) => {
        if (active) setProgress(event);
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

  const voiceLabel =
    provider === "vieneu" && vieneuProfile
      ? `VieNeu · ${vieneuProfile.name}`
      : provider !== "omnivoice"
        ? `${selectedModel.name} · ${selectedVoice?.name || ""} · ${selectedVoice?.id || ""}`
        : mode === "clone"
          ? selectedProfile?.name || t("tts.settings.cloneMode")
          : t(`tts.mode.${mode}`);

  const validateGeneration = useCallback((): string | null => {
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
    return null;
  }, [
    mode,
    selectedProfile,
    selectedStatus,
    store.instruction,
    provider,
    selectedVoice,
    selectedModel.id,
    vieneuProfile,
    t,
  ]);

  const buildGeneratePayload = useCallback(
    (jobId: string, text: string): TtsGeneratePayload => ({
      jobId,
      text,
      mode: provider === "omnivoice" ? mode : "auto",
      provider,
      voiceId: selectedVoice?.id,
      splitMode: store.splitMode,
      language: store.language,
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
    }),
    [
      mode,
      selectedProfile,
      store.advancedEnabled,
      store.advancedSettings,
      store.instruction,
      store.language,
      store.numStep,
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
        return await ttsClient.generate(buildGeneratePayload(jobId, text));
      } finally {
        setActiveJobId(undefined);
      }
    },
    [buildGeneratePayload, stopPreview, t],
  );

  const validateBatch = useCallback(() => {
    const invalid = validateGeneration();
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
      if (
        selectedStatus?.status !== "ready" ||
        selectedStatus.modelId !== voice.provider
      ) {
        toast.info(t("tts.provider.installFirst"));
        return;
      }
      stopPreview();
      const epoch = previewEpoch.current;
      setPreviewVoiceKey(key);
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
            });
            if (epoch !== previewEpoch.current) return;
            if (result.canceled) {
              stopPreview();
              return;
            }
            if (!result.success || !result.outputPath)
              throw new Error("preview-failed");
            path = result.outputPath;
            previewCache.current.set(key, path);
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
      } catch {
        if (epoch !== previewEpoch.current) return;
        previewCache.current.delete(key);
        stopPreview();
        toast.error(t("tts.provider.previewFailed"));
      }
    },
    [activeJobId, previewVoiceKey, selectedStatus, stopPreview, t],
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
    const invalid = validateGeneration();
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

  const closeMissingModelPrompt = useCallback(() => {
    store.markModelPromptSeen();
    setMissingModelOpen(false);
  }, [store.markModelPromptSeen]);

  const installSelectedModelFromPrompt = useCallback(() => {
    closeMissingModelPrompt();
    void installModel();
  }, [closeMissingModelPrompt, installModel]);

  return {
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
    closeMissingModelPrompt,
    installSelectedModelFromPrompt,
  };
}

export type TtsController = ReturnType<typeof useTtsController>;
