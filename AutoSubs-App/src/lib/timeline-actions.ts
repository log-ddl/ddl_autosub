import type { StoryboardEffect } from "@/api/resolve-api"
import type { MediaEntry } from "@/lib/media-import"
import type { AlignedSpan, TimedWord } from "@/lib/slideshow-align"
import type { Speaker, Subtitle } from "@/types"
import { saveSubtitleDocument } from "@/lib/subtitle-documents"

/** One media clip in its timeline placement form. */
export interface BuildItem {
  /** The row this came from. Local bookkeeping only — never sent to the host. */
  id: string
  path: string
  start: number
  end: number
  /** Section within the source; see MediaEntry.srcIn/srcOut. */
  srcIn?: number
  srcOut?: number
  effect?: StoryboardEffect
}

/** Input shape for placing arbitrary text/subtitle cues onto the timeline. */
export interface TextCueInput {
  text: string
  start: number
  end: number
  speaker_id?: string
  words?: Array<{
    word: string
    start: number | string
    end: number | string
    line_number?: number
  }>
}

/**
 * Lay out media entries back-to-back starting at `startAt`.
 * Clips with a source range (`srcIn`/`srcOut`) or probed video duration use that
 * span when a range is specified; otherwise fallback to `secsPerImage`.
 */
export function buildSequentialItems(
  entries: MediaEntry[],
  secsPerImage = 3,
  startAt = 0,
): BuildItem[] {
  let cursor = startAt
  return entries.map((m) => {
    const rangeEnd = m.srcOut ?? m.info?.durationSecs
    const ranged =
      (m.srcIn != null || m.srcOut != null) && rangeEnd != null
        ? rangeEnd - (m.srcIn ?? 0)
        : undefined
    const dur = ranged && ranged > 0 ? ranged : secsPerImage
    const start = cursor
    cursor += dur
    return {
      id: m.id,
      path: m.path,
      start,
      end: start + dur,
      srcIn: m.srcIn,
      srcOut: m.srcOut,
    }
  })
}

/**
 * Place each media item where the voice actually speaks its aligned script line.
 * Each clip runs until the next sentence starts so pauses between sentences keep
 * showing the previous visual instead of leaving a black hole on the timeline.
 */
export function buildSyncedItems(
  entries: MediaEntry[],
  spans: AlignedSpan[],
): BuildItem[] {
  return spans
    .filter((s) => entries[s.lineIndex] !== undefined)
    .map((s, i, filtered) => {
      const entry = entries[s.lineIndex]
      const start = s.start
      const next = filtered[i + 1]
      const end = Math.max(start + 0.2, next ? next.start : s.end)
      return {
        id: entry.id,
        path: entry.path,
        start,
        end,
        srcIn: entry.srcIn,
        srcOut: entry.srcOut,
      }
    })
}

/**
 * Convert `AlignedSpan[]` (and optional `TimedWord[]` from ASR) into standard
 * `Subtitle[]` cues so script lines aligned to voice can be pushed directly onto
 * the timeline as captions/text.
 */
export function spansToSubtitles(
  spans: AlignedSpan[],
  words?: TimedWord[],
): Subtitle[] {
  return spans.map((s, idx) => {
    const spanWords = words
      ? words
          .filter((w) => w.start >= s.start - 0.05 && w.end <= s.end + 0.05)
          .map((w) => ({
            word: w.word,
            start: w.start,
            end: w.end,
            line_number: 0,
          }))
      : []
    return {
      id: idx,
      start: s.start,
      end: s.end,
      text: s.text,
      words: spanWords,
    }
  })
}

/**
 * Persist an arbitrary list of text/subtitle cues as a subtitle document file
 * and return its `filename`, ready to pass to `pushToTimeline`.
 */
export async function saveAdHocSubtitleDocument(
  cues: TextCueInput[],
  options: {
    filename?: string
    displayName?: string
    speakers?: Speaker[]
    timelineId?: string
    timelineName?: string
  } = {},
): Promise<string> {
  const filename =
    options.filename ?? `autoedit_cues_${Date.now()}.json`
  await saveSubtitleDocument(
    {
      segments: cues,
      originalSegments: cues,
      speakers: options.speakers ?? [],
    },
    filename,
    {
      metadata: {
        displayName: options.displayName ?? "Auto Edit Captions",
        timelineId: options.timelineId,
        timelineName: options.timelineName,
      },
    },
  )
  return filename
}
