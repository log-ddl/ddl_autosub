import type { TFunction } from "i18next";

const PROGRESS_KEYS: Record<string, string> = {
  submitting: "tts.provider.submitting",
  processing: "tts.provider.processing",
  "tts.provider.installing": "tts.provider.installing",
  starting: "tts.progress.starting",
  "runtime.python.download": "tts.progress.pythonDownload",
  "runtime.python.install": "tts.progress.pythonInstall",
  "runtime.venv": "tts.progress.venv",
  "runtime.pip": "tts.progress.pip",
  "runtime.dependencies": "tts.progress.dependencies",
  "runtime.accelerator": "tts.progress.accelerator",
  "model.download": "tts.progress.modelDownload",
  loading: "tts.progress.loading",
  "voice-prompt": "tts.progress.voicePrompt",
  generating: "tts.progress.generating",
  "line-generating": "tts.progress.lineGenerating",
  "sentence-generating": "tts.progress.sentenceGenerating",
  chunking: "tts.progress.chunking",
  merging: "tts.progress.merging",
  saving: "tts.progress.saving",
  done: "tts.progress.done",
};

export function getTtsProgressLabel(stage: string, t: TFunction): string {
  return t(PROGRESS_KEYS[stage] || "tts.progress.default");
}
