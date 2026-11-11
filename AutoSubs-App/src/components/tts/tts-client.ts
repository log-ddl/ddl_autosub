import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  TtsActionOutcome,
  CatalogVoice,
  TtsBatchSaveResult,
  TtsBatchScanResult,
  TtsBatchTextResult,
  TtsGeneratePayload,
  TtsGenerateResult,
  TtsModelStatus,
  TtsProgressEvent,
} from "./types";

export function createTtsJobId(
  prefix: "install" | "generate" | "voice" | "preview",
): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now()}-${random}`;
}

export function toLocalTtsAudioUrl(filePath: string): string {
  return convertFileSrc(filePath);
}

export const ttsClient = {
  getCatalog(): Promise<CatalogVoice[]> {
    return invoke("tts_voice_catalog");
  },
  getVieneuStatus(): Promise<TtsModelStatus> {
    return invoke("tts_vieneu_status");
  },
  installVieneu(jobId: string): Promise<TtsActionOutcome> {
    return invoke("tts_install_vieneu", { jobId });
  },
  getStatus(): Promise<TtsModelStatus> {
    return invoke<TtsModelStatus>("tts_get_status");
  },
  installModel(jobId: string): Promise<TtsActionOutcome> {
    return invoke<TtsActionOutcome>("tts_install_model", { jobId });
  },
  removeModel(): Promise<TtsActionOutcome> {
    return invoke<TtsActionOutcome>("tts_remove_model");
  },
  removeVoicePrompt(profileId: string): Promise<TtsActionOutcome> {
    return invoke<TtsActionOutcome>("tts_remove_voice_prompt", { profileId });
  },
  generate(payload: TtsGeneratePayload): Promise<TtsGenerateResult> {
    return invoke<TtsGenerateResult>("tts_generate", { payload });
  },
  cancelJob(jobId: string): Promise<{ canceled: boolean }> {
    return invoke<{ canceled: boolean }>("tts_cancel_job", { jobId });
  },
  pickReferenceAudio(title?: string): Promise<{ path: string | null }> {
    return invoke<{ path: string | null }>("tts_pick_reference_audio", {
      title,
    });
  },
  exportAudio(sourcePath: string, title?: string): Promise<TtsActionOutcome> {
    return invoke<TtsActionOutcome>("tts_export_audio", { sourcePath, title });
  },
  revealAudio(filePath: string): Promise<TtsActionOutcome> {
    return invoke<TtsActionOutcome>("tts_reveal_audio", { filePath });
  },
  pickBatchFolder(title?: string): Promise<{ path: string | null }> {
    return invoke<{ path: string | null }>("tts_pick_batch_folder", { title });
  },
  scanBatchFolder(folderPath: string): Promise<TtsBatchScanResult> {
    return invoke<TtsBatchScanResult>("tts_scan_batch_folder", { folderPath });
  },
  readBatchText(filePath: string): Promise<TtsBatchTextResult> {
    return invoke<TtsBatchTextResult>("tts_read_batch_text", { filePath });
  },
  saveBatchOutput(
    sourcePath: string,
    textFilePath: string,
  ): Promise<TtsBatchSaveResult> {
    return invoke<TtsBatchSaveResult>("tts_save_batch_output", {
      sourcePath,
      textFilePath,
    });
  },
  openBatchFolder(folderPath: string): Promise<TtsActionOutcome> {
    return invoke<TtsActionOutcome>("tts_open_batch_folder", { folderPath });
  },
  onProgress(handler: (event: TtsProgressEvent) => void): Promise<UnlistenFn> {
    return listen<TtsProgressEvent>("tts-progress", (event) => {
      handler(event.payload);
    });
  },
};
