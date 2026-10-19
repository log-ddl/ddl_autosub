import type { VoiceSource } from "@/lib/media-import"
import {
  alignScriptToWords,
  flattenWords,
  type AlignedSpan,
  type TimedWord,
} from "@/lib/slideshow-align"
import { useVoiceTranscriber } from "@/lib/slideshow-transcribe"
import type { Subtitle } from "@/types"

export { alignScriptToWords, flattenWords, useVoiceTranscriber }
export type { AlignedSpan, TimedWord }

export interface VoiceTranscriptionResult {
  words: TimedWord[]
  segments: Subtitle[]
  offsetSecs: number
  name: string
}

/**
 * Flatten ASR segments and shift word timestamps by `offsetSecs` into the
 * timeline domain (0 = timeline start).
 */
export function extractShiftedWords(
  segments: Parameters<typeof flattenWords>[0],
  offsetSecs = 0,
): TimedWord[] {
  const flat = flattenWords(segments)
  if (offsetSecs === 0) return flat
  return flat.map((w) => ({
    ...w,
    start: w.start + offsetSecs,
    end: w.end + offsetSecs,
  }))
}

/**
 * Transcribe a `VoiceSource` (standalone file or timeline audio track) and return
 * timeline-shifted `TimedWord[]` and `Subtitle[]`. Returns `null` if export was
 * cancelled.
 */
export async function transcribeVoiceSource(
  source: NonNullable<VoiceSource>,
  transcribeFile: (audioPath: string) => Promise<Subtitle[]>,
  getSourceAudio: (
    audioInputMode: "file" | "timeline",
    fileInput: string | null,
    inputTracks: string[],
  ) => Promise<{ path: string; offset: number } | null>,
): Promise<VoiceTranscriptionResult | null> {
  if (source.kind === "file") {
    const segments = await transcribeFile(source.path)
    const words = extractShiftedWords(segments, 0)
    return {
      words,
      segments,
      offsetSecs: 0,
      name: source.name,
    }
  }

  const audio = await getSourceAudio("timeline", null, [source.value])
  if (!audio || !audio.path) return null
  const offsetSecs = audio.offset || 0
  const rawSegments = await transcribeFile(audio.path)
  const words = extractShiftedWords(rawSegments, offsetSecs)
  const segments: Subtitle[] =
    offsetSecs === 0
      ? rawSegments
      : rawSegments.map((seg) => ({
          ...seg,
          start: seg.start + offsetSecs,
          end: seg.end + offsetSecs,
          words: seg.words?.map((w) => ({
            ...w,
            start: w.start + offsetSecs,
            end: w.end + offsetSecs,
          })),
        }))
  return {
    words,
    segments,
    offsetSecs,
    name: source.name,
  }
}
