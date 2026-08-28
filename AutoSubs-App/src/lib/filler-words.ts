import type { Span } from "./silence-math"

// Conservative multi-language filler set. Kept tight (clear disfluencies only,
// no ambiguous real words like "so"/"like") so we never cut meaningful speech.
// Matched case-insensitively after stripping surrounding punctuation.
const FILLERS = new Set<string>([
  // English
  "um", "umm", "uhm", "uh", "uhh", "erm", "er", "err", "hmm", "hm", "mmm",
  "mhm", "ah", "ahh", "huh", "eh", "uhhuh",
  // Vietnamese
  "à", " à", "ừm", "ờ", "ừ", "ờm", "ừa", "á", "ạ", "ừ ừ",
])

function normalize(word: string): string {
  return word
    .toLowerCase()
    .replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "")
    .trim()
}

export interface WordLike {
  word: string
  start: number
  end: number
}
export interface SegmentLike {
  words?: WordLike[] | null
}
export interface TranscriptLike {
  segments?: SegmentLike[]
  originalSegments?: SegmentLike[]
}

// Extract filler-word spans (audio-relative seconds) from a transcript. Uses
// the untouched `originalSegments` word data when present so punctuation/case
// formatting doesn't hide a filler.
export function detectFillerSpans(transcript: TranscriptLike): Span[] {
  const segments = transcript.originalSegments?.length
    ? transcript.originalSegments
    : transcript.segments ?? []

  const spans: Span[] = []
  for (const seg of segments) {
    for (const w of seg.words ?? []) {
      if (w.end > w.start && FILLERS.has(normalize(w.word))) {
        spans.push({ start_secs: w.start, end_secs: w.end })
      }
    }
  }
  return spans
}
