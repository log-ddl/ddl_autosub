// Aligns a user-written script (one line per media item, in order) against the
// word-level timings of a transcript of the same voice-over. The user reads the
// script aloud, so the two token streams are near-identical; we only need to
// find where each line's words fall on the timeline to know when to show its
// image.
//
// The matcher is monotonic (line i can only start after line i-1 ended) and
// degrades to a proportional split when a line has no matchable anchor, so a
// misheard word or a "1" vs "one" mismatch never derails the whole alignment.

export interface TimedWord {
  word: string;
  start: number;
  end: number;
}

export interface AlignedSpan {
  /** Index into the ORIGINAL scriptLines array (blank lines are skipped). */
  lineIndex: number;
  text: string;
  start: number;
  end: number;
  /** matched tokens / line tokens, 0..1. Low values want a human eye. */
  confidence: number;
  /** True when this span was placed by proportional fallback, not by anchors. */
  approximate: boolean;
}

// Strip to a comparable token: lowercased, letters/digits only (Unicode-aware).
// Everything else (punctuation, spaces) is dropped so "Hello," == "hello".
function normalizeToken(raw: string): string {
  return raw.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function tokenize(line: string): string[] {
  return line
    .split(/\s+/)
    .map(normalizeToken)
    .filter((t) => t.length > 0);
}

export interface AlignOptions {
  /** How far ahead (in ASR words) to look for a line's first-token anchor. */
  anchorWindow?: number;
  /** How far ahead to look when matching subsequent tokens within a line. */
  matchWindow?: number;
}

const DEFAULT_ANCHOR_WINDOW = 12;
const DEFAULT_MATCH_WINDOW = 6;

/**
 * Produce one span per non-empty script line. `words` are the flattened,
 * time-ordered transcript words. Returns [] when there are no usable words or
 * no non-empty lines.
 */
export function alignScriptToWords(
  scriptLines: string[],
  words: TimedWord[],
  options: AlignOptions = {},
): AlignedSpan[] {
  const anchorWindow = options.anchorWindow ?? DEFAULT_ANCHOR_WINDOW;
  const matchWindow = options.matchWindow ?? DEFAULT_MATCH_WINDOW;

  // Precompute normalized ASR tokens alongside their source index.
  const asr = words.map((w) => ({ ...w, norm: normalizeToken(w.word) }));

  // Keep original indices so we can report which line each span came from.
  const lines = scriptLines
    .map((text, lineIndex) => ({ lineIndex, text, tokens: tokenize(text) }))
    .filter((l) => l.tokens.length > 0);

  if (lines.length === 0 || asr.length === 0) return [];

  const spans: AlignedSpan[] = [];
  let cursor = 0; // next unconsumed ASR index

  for (let li = 0; li < lines.length; li++) {
    const { lineIndex, text, tokens } = lines[li];

    // 1) Anchor: find the line's first token at/after the cursor.
    let startIdx = -1;
    const anchorEnd = Math.min(asr.length, cursor + anchorWindow);
    for (let j = cursor; j < anchorEnd; j++) {
      if (asr[j].norm === tokens[0]) {
        startIdx = j;
        break;
      }
    }

    if (startIdx === -1) {
      // No anchor — fall back to a proportional slice below. Record a marker
      // span using the cursor position; refined in the fallback pass.
      spans.push({
        lineIndex,
        text,
        start: NaN,
        end: NaN,
        confidence: 0,
        approximate: true,
      });
      continue;
    }

    // 2) Walk the rest of the line, matching in order with a small skip window
    //    (the read may insert/drop a word here and there).
    let matched = 1;
    let endIdx = startIdx;
    let probe = startIdx + 1;
    for (let ti = 1; ti < tokens.length; ti++) {
      const searchEnd = Math.min(asr.length, probe + matchWindow);
      let found = -1;
      for (let j = probe; j < searchEnd; j++) {
        if (asr[j].norm === tokens[ti]) {
          found = j;
          break;
        }
      }
      if (found !== -1) {
        matched++;
        endIdx = found;
        probe = found + 1;
      }
      // On a miss we leave `probe` where it is: the next token gets a chance to
      // resync without the whole line collapsing.
    }

    spans.push({
      lineIndex,
      text,
      start: asr[startIdx].start,
      end: asr[endIdx].end,
      confidence: matched / tokens.length,
      approximate: false,
    });
    cursor = endIdx + 1;
  }

  // 3) Fill any proportional-fallback gaps (spans with NaN times) by splitting
  //    the interval between their nearest resolved neighbours in proportion to
  //    token counts, so unmatched lines still land in a sensible place.
  fillApproximateSpans(spans, lines, asr);

  // 4) Enforce monotonic, non-overlapping order. Overlaps would make Resolve
  //    reject the second clip at AppendToTimeline.
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].start < spans[i - 1].end) {
      spans[i].start = spans[i - 1].end;
    }
    if (spans[i].end < spans[i].start) {
      spans[i].end = spans[i].start;
    }
  }

  return spans;
}

// Resolves spans left with NaN start/end (no anchor found) by interpolating
// between the surrounding resolved spans, weighted by each line's token count.
function fillApproximateSpans(
  spans: AlignedSpan[],
  lines: { tokens: string[] }[],
  asr: TimedWord[],
): void {
  const timelineStart = asr[0].start;
  const timelineEnd = asr[asr.length - 1].end;

  let i = 0;
  while (i < spans.length) {
    if (!Number.isNaN(spans[i].start)) {
      i++;
      continue;
    }
    // Find the run [i, j) of consecutive unresolved spans.
    let j = i;
    while (j < spans.length && Number.isNaN(spans[j].start)) j++;

    const from = i > 0 ? spans[i - 1].end : timelineStart;
    const to = j < spans.length ? spans[j].start : timelineEnd;
    const runTokens = lines
      .slice(i, j)
      .reduce((sum, l) => sum + Math.max(1, l.tokens.length), 0);

    let t = from;
    const span = Math.max(0, to - from);
    for (let k = i; k < j; k++) {
      const weight = Math.max(1, lines[k].tokens.length) / runTokens;
      const dur = span * weight;
      spans[k].start = t;
      spans[k].end = t + dur;
      t += dur;
    }
    i = j;
  }
}

/** Flatten transcript segments (each with word timings) into one ordered list. */
export function flattenWords(
  segments: Array<{ words?: TimedWord[] }>,
): TimedWord[] {
  const out: TimedWord[] = [];
  for (const seg of segments) {
    for (const w of seg.words ?? []) {
      if (
        typeof w.start === "number" &&
        typeof w.end === "number" &&
        w.end >= w.start
      ) {
        out.push({ word: w.word, start: w.start, end: w.end });
      }
    }
  }
  return out;
}
