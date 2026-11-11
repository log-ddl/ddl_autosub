import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  TtsAdvancedSettings,
  TtsHistoryItem,
  TtsMode,
  TtsProvider,
  TtsSavedLanguage,
  TtsSplitMode,
  VoiceProfile,
} from "@/components/tts/types";

export const DEFAULT_TTS_ADVANCED_SETTINGS: TtsAdvancedSettings = {
  audioChunkDuration: 15,
  audioChunkThreshold: 30,
  guidanceScale: 2,
  tShift: 0.1,
  positionTemperature: 5,
  classTemperature: 0,
  layerPenaltyFactor: 5,
  denoise: true,
  preprocessPrompt: true,
  postprocessOutput: true,
  padDuration: 0.1,
  fadeDuration: 0.1,
};

interface TtsState {
  favoriteVoiceKeys: string[];
  toggleFavoriteVoice: (key: string) => void;
  vieneuProfileId?: string;
  setVieneuProfile: (id?: string) => void;
  provider: TtsProvider;
  providerVoiceIds: Partial<Record<TtsProvider, string>>;
  setProvider: (provider: TtsProvider) => void;
  setProviderVoice: (id: string) => void;
  text: string;
  instruction: string;
  mode: TtsMode;
  language: string;
  savedLanguages: TtsSavedLanguage[];
  speed: number;
  numStep: number;
  splitMode: TtsSplitMode;
  advancedEnabled: boolean;
  advancedSettings: TtsAdvancedSettings;
  selectedProfileId?: string;
  voiceProfiles: VoiceProfile[];
  history: TtsHistoryItem[];
  hasSeenModelPrompt: boolean;
  setText: (value: string) => void;
  setInstruction: (value: string) => void;
  setMode: (value: TtsMode) => void;
  setLanguage: (value: string) => void;
  addSavedLanguage: (language: TtsSavedLanguage) => void;
  removeSavedLanguage: (code: string) => void;
  setSpeed: (value: number) => void;
  setNumStep: (value: number) => void;
  setSplitMode: (value: TtsSplitMode) => void;
  setAdvancedEnabled: (value: boolean) => void;
  setAdvancedSetting: <K extends keyof TtsAdvancedSettings>(
    key: K,
    value: TtsAdvancedSettings[K],
  ) => void;
  resetAdvancedSettings: () => void;
  setSelectedProfileId: (value?: string) => void;
  addVoiceProfile: (profile: VoiceProfile) => void;
  removeVoiceProfile: (id: string) => void;
  addHistory: (item: TtsHistoryItem) => void;
  renameHistory: (id: string, name: string) => void;
  removeHistory: (id: string) => void;
  markModelPromptSeen: () => void;
}

export const useTtsStore = create<TtsState>()(
  persist(
    (set) => ({
      favoriteVoiceKeys: [],
      toggleFavoriteVoice: (key) =>
        set((state) => ({
          favoriteVoiceKeys: state.favoriteVoiceKeys.includes(key)
            ? state.favoriteVoiceKeys.filter((k) => k !== key)
            : [...state.favoriteVoiceKeys, key],
        })),
      vieneuProfileId: undefined,
      setVieneuProfile: (vieneuProfileId) => set({ vieneuProfileId }),
      provider: "omnivoice",
      providerVoiceIds: {},
      setProvider: (provider) => set({ provider }),
      setProviderVoice: (id) =>
        set((state) => ({
          providerVoiceIds: { ...state.providerVoiceIds, [state.provider]: id },
        })),
      text: "",
      instruction: "",
      mode: "clone",
      language: "vi",
      savedLanguages: [],
      speed: 1,
      numStep: 24,
      splitMode: "default",
      advancedEnabled: false,
      advancedSettings: { ...DEFAULT_TTS_ADVANCED_SETTINGS },
      selectedProfileId: undefined,
      voiceProfiles: [],
      history: [],
      hasSeenModelPrompt: false,
      setText: (text) => set({ text }),
      setInstruction: (instruction) => set({ instruction }),
      setMode: (mode) => set({ mode }),
      setLanguage: (language) => set({ language }),
      addSavedLanguage: (language) =>
        set((state) => ({
          savedLanguages: [
            ...state.savedLanguages.filter(
              (item) => item.code !== language.code,
            ),
            language,
          ].sort((left, right) => left.name.localeCompare(right.name)),
        })),
      removeSavedLanguage: (code) =>
        set((state) => ({
          savedLanguages: state.savedLanguages.filter(
            (language) => language.code !== code,
          ),
          language: state.language === code ? "auto" : state.language,
        })),
      setSpeed: (speed) => set({ speed }),
      setNumStep: (numStep) => set({ numStep }),
      setSplitMode: (splitMode) => set({ splitMode }),
      setAdvancedEnabled: (advancedEnabled) =>
        set((state) => ({
          advancedEnabled,
          numStep: !advancedEnabled && state.numStep < 16 ? 16 : state.numStep,
        })),
      setAdvancedSetting: (key, value) =>
        set((state) => ({
          advancedSettings: { ...state.advancedSettings, [key]: value },
        })),
      resetAdvancedSettings: () =>
        set({ advancedSettings: { ...DEFAULT_TTS_ADVANCED_SETTINGS } }),
      setSelectedProfileId: (selectedProfileId) => set({ selectedProfileId }),
      addVoiceProfile: (profile) =>
        set((state) => ({
          voiceProfiles: [
            profile,
            ...state.voiceProfiles.filter((item) => item.id !== profile.id),
          ],
          selectedProfileId: profile.id,
        })),
      removeVoiceProfile: (id) =>
        set((state) => ({
          voiceProfiles: state.voiceProfiles.filter((item) => item.id !== id),
          selectedProfileId:
            state.selectedProfileId === id
              ? undefined
              : state.selectedProfileId,
        })),
      addHistory: (item) =>
        set((state) => ({
          history: [
            item,
            ...state.history.filter((existing) => existing.id !== item.id),
          ].slice(0, 100),
        })),
      renameHistory: (id, name) =>
        set((state) => ({
          history: state.history.map((item) =>
            item.id === id ? { ...item, name } : item,
          ),
        })),
      removeHistory: (id) =>
        set((state) => ({
          history: state.history.filter((item) => item.id !== id),
        })),
      markModelPromptSeen: () => set({ hasSeenModelPrompt: true }),
    }),
    {
      name: "autosubs-tts-store-v1",
      version: 1,
    },
  ),
);
