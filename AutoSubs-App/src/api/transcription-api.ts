import { invoke } from "@tauri-apps/api/core";
import type {
    EnsureModelsRequest,
    EnsureModelsResponse,
    TranscriptionOptions,
} from "@/types";

/**
 * Options for `transcribe_audio`. The Subtitles tab sends the full set; lighter
 * callers (Auto-cut filler pass, slideshow voice import) send only what they
 * need and the backend fills the rest with its defaults.
 */
export type TranscribeAudioOptions = Pick<TranscriptionOptions, "audioPath" | "model"> &
    Partial<TranscriptionOptions>;

/** Download (if needed) and resolve on-disk paths for the models a run needs. */
export async function ensureModels(request: EnsureModelsRequest): Promise<EnsureModelsResponse> {
    return invoke<EnsureModelsResponse>("ensure_models", { request });
}

export async function transcribeAudio<T = unknown>(options: TranscribeAudioOptions): Promise<T> {
    return invoke<T>("transcribe_audio", { options });
}

export async function cancelTranscription(): Promise<void> {
    await invoke("cancel_transcription");
}

export async function getDownloadedModels(): Promise<string[]> {
    return invoke<string[]>("get_downloaded_models");
}

export async function deleteModel(model: string): Promise<void> {
    await invoke("delete_model", { model });
}
