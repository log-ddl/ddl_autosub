// Client-side port of the Rust silence math (autoedit_silence.rs). Kept pure
// and synchronous so the AutoCut tab can recompute keep/cut spans instantly
// while the user drags the min-silence / padding sliders — VAD runs once in
// Rust, everything after is cheap arithmetic here.

export interface Span {
  start_secs: number;
  end_secs: number;
}

// Merge speech spans whose gap is shorter than `minSilence`, pad each merged
// span (by `paddingBefore` at the start and `paddingAfter` at the end), split
// any resulting overlap at the midpoint, then drop spans shorter than `minKeep`.
// `paddingAfter` defaults to `paddingBefore` when omitted (symmetric padding).
export function computeKeepSpans(
  speech: Span[],
  totalSecs: number,
  minSilence: number,
  paddingBefore: number,
  minKeep: number,
  paddingAfter: number = paddingBefore,
): Span[] {
  if (speech.length === 0) return [];

  const sorted = [...speech].sort((a, b) => a.start_secs - b.start_secs);

  const merged: Span[] = [];
  let cur = { ...sorted[0] };
  for (let i = 1; i < sorted.length; i++) {
    const s = sorted[i];
    if (s.start_secs - cur.end_secs < minSilence) {
      cur.end_secs = Math.max(cur.end_secs, s.end_secs);
    } else {
      merged.push(cur);
      cur = { ...s };
    }
  }
  merged.push(cur);

  const padded: Span[] = merged.map((m) => ({
    start_secs: Math.max(0, m.start_secs - paddingBefore),
    end_secs: Math.min(totalSecs, m.end_secs + paddingAfter),
  }));

  for (let i = 1; i < padded.length; i++) {
    if (padded[i].start_secs < padded[i - 1].end_secs) {
      const mid = (padded[i].start_secs + padded[i - 1].end_secs) * 0.5;
      padded[i - 1].end_secs = mid;
      padded[i].start_secs = mid;
    }
  }

  return padded.filter((k) => k.end_secs - k.start_secs >= minKeep);
}

// Complement of keep spans within [0, totalSecs] — the ranges to remove.
export function keepToCut(keep: Span[], totalSecs: number): Span[] {
  const cuts: Span[] = [];
  let prevEnd = 0;
  for (const k of keep) {
    if (k.start_secs > prevEnd) {
      cuts.push({ start_secs: prevEnd, end_secs: k.start_secs });
    }
    prevEnd = k.end_secs;
  }
  if (totalSecs > prevEnd) {
    cuts.push({ start_secs: prevEnd, end_secs: totalSecs });
  }
  return cuts;
}

export function sumSpans(spans: Span[]): number {
  return spans.reduce((acc, s) => acc + (s.end_secs - s.start_secs), 0);
}

// Sort and merge overlapping / touching spans into a minimal disjoint set.
// Used when the user un-checks some cuts (keeping those silences): the restored
// cut ranges are unioned back into the keep spans.
export function mergeSpans(spans: Span[]): Span[] {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((a, b) => a.start_secs - b.start_secs);
  const out: Span[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    const s = sorted[i];
    if (s.start_secs <= last.end_secs) {
      last.end_secs = Math.max(last.end_secs, s.end_secs);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}
