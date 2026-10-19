import { invoke } from "@tauri-apps/api/core"

export type SecsSpan = { start_secs: number; end_secs: number }

export interface AnalyzeSilenceArgs {
  wav_path: string
  min_silence_secs: number
  padding_secs: number
  min_keep_secs: number
}

export interface AnalyzeSilenceResult {
  total_duration_secs: number
  speech_duration_secs: number
  raw_speech_spans: SecsSpan[]
  keep_spans: SecsSpan[]
  cut_spans: SecsSpan[]
}

/** Run VAD over an exported WAV and return the speech / cut spans. */
export async function analyzeWavSilences(args: AnalyzeSilenceArgs): Promise<AnalyzeSilenceResult> {
  return invoke<AnalyzeSilenceResult>("analyze_wav_silences", { args })
}

/** Run a bundled or user script against Resolve; output streams as events. */
export async function runPythonScript(scriptPath: string): Promise<void> {
  await invoke("run_python_script", { scriptPath })
}

export interface PythonRuntimeStatus {
  installed: boolean
  installing: boolean
  version: string | null
}

export async function getPythonRuntimeStatus(): Promise<PythonRuntimeStatus> {
  return invoke<PythonRuntimeStatus>("python_runtime_status")
}

/** Start the one-time Python install; progress arrives as setup events. */
export async function installPythonRuntime(): Promise<void> {
  await invoke("install_python_runtime")
}
