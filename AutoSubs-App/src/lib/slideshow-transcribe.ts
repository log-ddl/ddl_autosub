import * as React from "react"
import { invoke } from "@tauri-apps/api/core"
import { useModels } from "@/contexts/ModelsContext"
import { useSettingsStore } from "@/stores/settings-store"
import type { Subtitle } from "@/types"

/**
 * Transcribe an arbitrary audio/video file into word-timed segments, reusing the
 * app's existing ASR pipeline (same `ensure_models` + `transcribe_audio` commands
 * the Subtitles tab and Auto-cut use). Kept as a tiny standalone hook so the
 * slideshow can offer "import a voice file → auto-sub" without dragging the whole
 * transcription panel along.
 *
 * `offset` is 0: a standalone voice file starts at its own beginning, which is
 * exactly the domain the slideshow places media in (timeline start = time 0).
 * DTW is on for word timestamps; forced alignment is off to avoid pulling an
 * extra aligner model download for what is a lightweight, in-dialog action.
 */
export function useVoiceTranscriber() {
  const { modelsState } = useModels()

  const transcribe = React.useCallback(
    async (audioPath: string): Promise<Subtitle[]> => {
      const s = useSettingsStore.getState()
      const model = modelsState[s.model]?.value ?? modelsState[0]?.value
      if (!model) throw new Error("No transcription model is available.")

      const modelPaths = await invoke<{
        asr_model_path: string
        vad_model_path?: string
      }>("ensure_models", {
        request: {
          model,
          enable_vad: true,
          enable_diarize: false,
          enable_forced_alignment: false,
        },
      })

      const transcript = await invoke<{ segments?: Subtitle[] }>(
        "transcribe_audio",
        {
          options: {
            audioPath,
            offset: 0,
            model,
            lang: s.language,
            enableDtw: true,
            enableForcedAlignment: false,
            enableGpu: s.enableGpu,
            enableDiarize: false,
            asrModelPath: modelPaths.asr_model_path,
            vadModelPath: modelPaths.vad_model_path,
          },
        },
      )

      return transcript?.segments ?? []
    },
    [modelsState],
  )

  return { transcribe }
}
