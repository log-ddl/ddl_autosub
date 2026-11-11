const RESERVED_NON_SPEAKER_TAGS = new Set([
  "laugh",
  "laughs",
  "laughter",
  "chuckle",
  "sigh",
  "sighs",
  "gasp",
  "gasps",
  "cough",
  "coughs",
  "clears throat",
  "cry",
  "crying",
  "sob",
  "whisper",
  "whispers",
  "music",
  "pause",
  "silence",
  "breath",
  "breathes",
]);

const NARRATOR_ALIASES = new Set([
  "narrator",
  "default",
  "vo",
  "voiceover",
  "dan_chuyen",
  "dẫn chuyện",
  "ke_chuyen",
  "kể chuyện",
]);

const LETTER_RE = /\p{L}/u;
const FORBIDDEN_TAG_CHARS_RE = /[:[\]=/\\]/;

export function isNarratorTag(tag: string): boolean {
  const lower = tag.trim().toLowerCase();
  return !lower || NARRATOR_ALIASES.has(lower);
}

interface TagToken {
  start: number;
  end: number;
  tag: string;
  lower: string;
  isSlashClose: boolean;
  atLineStart: boolean;
}

function isValidSpeakerTagName(tag: string): boolean {
  return (
    tag.length > 0 &&
    Array.from(tag).length <= 32 &&
    LETTER_RE.test(tag) &&
    !FORBIDDEN_TAG_CHARS_RE.test(tag) &&
    !RESERVED_NON_SPEAKER_TAGS.has(tag.toLowerCase())
  );
}

function scanTagTokens(normalized: string): TagToken[] {
  const tokens: TagToken[] = [];
  let idx = 0;

  while (idx < normalized.length) {
    const open = normalized.indexOf("[", idx);
    if (open === -1) break;

    const close = normalized.indexOf("]", open + 1);
    if (close === -1) break;

    const nextOpen = normalized.indexOf("[", open + 1);
    const nextNl = normalized.indexOf("\n", open + 1);
    if (
      (nextOpen !== -1 && nextOpen < close) ||
      (nextNl !== -1 && nextNl < close)
    ) {
      idx = open + 1;
      continue;
    }

    const end = close + 1;
    const rawInner = normalized.slice(open + 1, close).trim();
    const isSlashClose = rawInner.startsWith("/");
    const tagName = rawInner.replace(/^\/+/, "").trim();

    if (isValidSpeakerTagName(tagName)) {
      const prevNl = normalized.lastIndexOf("\n", open - 1);
      const beforeOnLine = normalized.slice(prevNl + 1, open);
      tokens.push({
        start: open,
        end,
        tag: tagName,
        lower: tagName.toLowerCase(),
        isSlashClose,
        atLineStart: beforeOnLine.trim().length === 0,
      });
    }

    idx = end;
  }

  return tokens;
}

/**
 * Extract distinct non-narrator speaker tags wrapped on both ends
 * (`[A] ... [A]` or `[A] ... [/A]`) in first-seen order.
 * Mirrors `tts::dialogue::extract_dialogue_tags` on the Rust backend 1:1.
 */
export function extractDialogueTags(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const tokens = scanTagTokens(normalized);
  const seenLower = new Set<string>();
  const tags: string[] = [];

  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.isSlashClose) {
      i += 1;
      continue;
    }
    let matchIdx = -1;
    for (let j = i + 1; j < tokens.length; j++) {
      if (tokens[j].lower === tok.lower) {
        matchIdx = j;
        break;
      }
    }
    if (matchIdx !== -1) {
      if (!isNarratorTag(tok.tag) && !seenLower.has(tok.lower)) {
        seenLower.add(tok.lower);
        tags.push(tok.tag);
      }
      i = matchIdx + 1;
    } else {
      i += 1;
    }
  }

  return tags;
}

export interface DialoguePreviewTurn {
  speaker: string;
  isNarrator: boolean;
  text: string;
}

export function parseDialoguePreviewTurns(text: string): DialoguePreviewTurn[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const tokens = scanTagTokens(normalized);
  const canonical = new Map<string, string>();
  for (const tag of extractDialogueTags(normalized)) {
    canonical.set(tag.toLowerCase(), tag);
  }

  const turns: DialoguePreviewTurn[] = [];
  const pushTurn = (speaker: string, slice: string) => {
    const trimmed = slice.trim();
    if (!trimmed) return;
    turns.push({
      speaker,
      isNarrator: speaker === "narrator",
      text: trimmed,
    });
  };

  let cursor = 0;
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.isSlashClose) {
      i += 1;
      continue;
    }
    let matchIdx = -1;
    for (let j = i + 1; j < tokens.length; j++) {
      if (tokens[j].lower === tok.lower) {
        matchIdx = j;
        break;
      }
    }
    if (matchIdx !== -1) {
      pushTurn("narrator", normalized.slice(cursor, tok.start));
      const speaker = isNarratorTag(tok.tag)
        ? "narrator"
        : (canonical.get(tok.lower) ?? tok.tag);
      let inner = normalized.slice(tok.end, tokens[matchIdx].start).trimStart();
      if (inner.startsWith(":")) {
        inner = inner.slice(1).trimStart();
      }
      pushTurn(speaker, inner);
      cursor = tokens[matchIdx].end;
      i = matchIdx + 1;
    } else {
      i += 1;
    }
  }

  pushTurn("narrator", normalized.slice(cursor));
  return turns;
}

export interface UnclosedDialogueTag {
  tag: string;
  lineEndOffset: number;
}

/**
 * Detect an unclosed `[TAG]` when `TAG` is already used as a speaker or placed at the
 * start of a line (e.g. user typed `[A] Xin chào` and forgot closing `[A]`).
 */
export function findUnclosedDialogueTag(
  text: string,
  knownTags: string[] = [],
): UnclosedDialogueTag | null {
  const normalized = text.replace(/\r\n/g, "\n");
  const tokens = scanTagTokens(normalized);
  const knownLower = new Set<string>(knownTags.map((k) => k.toLowerCase()));
  for (const paired of extractDialogueTags(normalized)) {
    knownLower.add(paired.toLowerCase());
  }

  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.isSlashClose) {
      i += 1;
      continue;
    }
    let matchIdx = -1;
    for (let j = i + 1; j < tokens.length; j++) {
      if (tokens[j].lower === tok.lower) {
        matchIdx = j;
        break;
      }
    }
    if (matchIdx !== -1) {
      i = matchIdx + 1;
      continue;
    }
    if (
      !isNarratorTag(tok.tag) &&
      (knownLower.has(tok.lower) || tok.atLineStart)
    ) {
      const nl = normalized.indexOf("\n", tok.end);
      const lineEndOffset = nl === -1 ? normalized.length : nl;
      return { tag: tok.tag, lineEndOffset };
    }
    i += 1;
  }

  return null;
}

/**
 * Wrap the current selection as `[TAG] selected [TAG]`, or insert `[TAG]  [TAG]`
 * with the cursor positioned right in the middle ready to type.
 */
export function insertDialogueTagAtCursor(
  text: string,
  tag: string,
  selectionStart?: number | null,
  selectionEnd?: number | null,
): { text: string; cursor: number } {
  const start =
    typeof selectionStart === "number" &&
    selectionStart >= 0 &&
    selectionStart <= text.length
      ? selectionStart
      : text.length;
  const end =
    typeof selectionEnd === "number" &&
    selectionEnd >= start &&
    selectionEnd <= text.length
      ? selectionEnd
      : start;

  const before = text.slice(0, start);
  const selected = text.slice(start, end);
  const after = text.slice(end);

  if (selected.length > 0) {
    const trimmedSel = selected.trim();
    const wrapped = `[${tag}] ${trimmedSel} [${tag}]`;
    return {
      text: `${before}${wrapped}${after}`,
      cursor: before.length + wrapped.length,
    };
  }

  const needLeadingSpace =
    before.length > 0 && !/\s$/.test(before);
  const needTrailingSpace =
    after.length > 0 && !/^\s/.test(after);
  const openPart = `${needLeadingSpace ? " " : ""}[${tag}] `;
  const closePart = ` [${tag}]${needTrailingSpace ? " " : ""}`;
  return {
    text: `${before}${openPart}${closePart}${after}`,
    cursor: before.length + openPart.length,
  };
}
