export type TtsProvider = "omnivoice" | "capcut" | "elevenlabs" | "vieneu";
export interface CatalogVoice {
  provider: TtsProvider;
  id: string;
  name: string;
  language: string;
  gender?: string;
  resourceId?: string;
}
export type TtsMode = "clone" | "design" | "auto";
export type TtsSplitMode = "default" | "line" | "sentence";
export type TtsModelStatusValue =
  | "not-installed"
  | "downloading"
  | "ready"
  | "incompatible"
  | "error";

export interface TtsSavedLanguage {
  code: string;
  name: string;
}

export interface TtsAdvancedSettings {
  audioChunkDuration: number;
  audioChunkThreshold: number;
  guidanceScale: number;
  tShift: number;
  positionTemperature: number;
  classTemperature: number;
  layerPenaltyFactor: number;
  denoise: boolean;
  preprocessPrompt: boolean;
  postprocessOutput: boolean;
  padDuration: number;
  fadeDuration: number;
}

export interface TtsModelDefinition {
  id: string;
  repository: string;
  name: string;
  descriptionKey: string;
  parameterSize: string;
  estimatedDownloadGb: number;
}

export const OMNIVOICE_MODEL: TtsModelDefinition = {
  id: "omnivoice-main",
  repository: "k2-fsa/OmniVoice",
  name: "OmniVoice",
  descriptionKey: "tts.model.omnivoice",
  parameterSize: "Omnilingual",
  estimatedDownloadGb: 3.3,
};

export interface TtsModelStatus {
  modelId: string;
  status: TtsModelStatusValue;
  installedPath?: string;
  runtimeReady: boolean;
  pythonAvailable: boolean;
  cudaAvailable?: boolean;
  accelerator?: string;
  message?: string;
  messageKey?: string;
}

export interface TtsProgressEvent {
  jobId: string;
  kind: "install" | "generate";
  stage: string;
  percent?: number;
  message: string;
}

export interface TtsSpeakerVoicePayload {
  provider?: TtsProvider;
  voiceId?: string;
  profileId?: string;
  referenceAudioPath?: string;
  referenceText?: string;
  mode?: TtsMode;
  language?: string;
  speed?: number;
  instruction?: string;
}

export interface TtsSpeakerVoiceConfig {
  provider: TtsProvider;
  voiceKey?: string;
  profileId?: string;
  mode?: TtsMode;
  instruction?: string;
  speed?: number;
}

export interface TtsTurnTiming {
  speaker: string;
  text: string;
  startSec: number;
  endSec: number;
  durationSec: number;
}

export interface TtsGeneratePayload {
  provider?: TtsProvider;
  voiceId?: string;
  jobId: string;
  text: string;
  mode: TtsMode;
  splitMode?: TtsSplitMode;
  language?: string;
  speed?: number;
  numStep?: number;
  advancedSettings?: TtsAdvancedSettings;
  instruction?: string;
  profileId?: string;
  referenceAudioPath?: string;
  referenceText?: string;
  speakers?: Record<string, TtsSpeakerVoicePayload>;
  gapSec?: number;
}

export interface TtsGenerateResult {
  success: boolean;
  outputPath?: string;
  srtPath?: string;
  sampleRate?: number;
  durationSec?: number;
  canceled?: boolean;
  error?: string;
  partDurationsSec?: number[];
  partGapSec?: number;
  turns?: TtsTurnTiming[];
}

export interface TtsActionOutcome {
  success: boolean;
  canceled?: boolean;
  error?: string;
  filePath?: string;
}

export interface TtsBatchScanFile {
  path: string;
  name: string;
  chars: number;
  existingAudioPath?: string;
}

export interface TtsBatchScanResult {
  success: boolean;
  files: TtsBatchScanFile[];
  truncated: boolean;
  error?: string;
}

export interface TtsBatchTextResult {
  success: boolean;
  text?: string;
  error?: string;
}

export interface TtsBatchSaveResult {
  success: boolean;
  outputPath?: string;
  error?: string;
}

export interface VoiceProfile {
  id: string;
  name: string;
  modelId: string;
  referenceAudioPath: string;
  referenceText: string;
  createdAt: number;
}

export type TtsBatchStatus =
  | "pending"
  | "skipped"
  | "running"
  | "done"
  | "error";

export interface TtsBatchItem {
  path: string;
  name: string;
  /** -1 when character count could not be read (corrupt or oversized file). */
  chars: number;
  status: TtsBatchStatus;
  outputPath?: string;
  error?: string;
}

export interface TtsHistoryItem {
  id: string;
  name?: string;
  modelId: string;
  text: string;
  mode: TtsMode;
  voiceLabel: string;
  outputPath: string;
  srtPath?: string;
  createdAt: number;
}
