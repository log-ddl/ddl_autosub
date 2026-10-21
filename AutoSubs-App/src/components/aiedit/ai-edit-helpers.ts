import i18n from "i18next";
import type { ContentCliAdapter } from "@/api/cli-chat-api";

export interface TimelineActionCommand {
  action:
    | "build_storyboard"
    | "add_marker"
    | "add_text"
    | "update_segment"
    | "delete_segment"
    | "split_clips"
    | "remove_ranges"
    | "remove_marker"
    | "add_effects"
    | "add_transitions";
  summary?: string;
  mode?: "replace" | "insert" | "overlay" | "append";
  targetVideoTrack?: number;
  audioPath?: string;
  items?: Array<{
    path: string;
    start: number;
    end?: number;
    srcIn?: number;
    srcOut?: number;
    effect?: {
      zoom?: number;
      panX?: number;
      panY?: number;
      rotation?: number;
    };
  }>;
  segmentId?: string;
  startSec?: number;
  durationSec?: number;
  zoom?: number;
  zoomEnd?: number;
  panX?: number;
  panXEnd?: number;
  panY?: number;
  panYEnd?: number;
  rotation?: number;
  volume?: number;
  text?: string;
  opacity?: number;
  segmentIds?: string[];
  ripple?: boolean;
  atSec?: number;
  ranges?: Array<{ start: number; end: number }>;
  template?: string;
  track?: string;
  texts?: Array<{ text: string; start: number; end: number }>;
  markers?: Array<{
    atSec: number;
    color?: string;
    name?: string;
    note?: string;
    durationSec?: number;
  }>;
}

/** Descriptions are `aiEdit.slash.<name>` in the locale files. */
export const AI_EDIT_SLASH_COMMANDS = [
  { name: "new" },
  { name: "clear" },
  { name: "assets" },
  { name: "memory" },
  { name: "folder" },
] as const;

/** Display name of an editor integration ("short" for compact badges). */
export function editorLabel(integration: string | null | undefined, short = false): string {
  switch (integration) {
    case "capcut":
      return "CapCut";
    case "premiere":
      return short ? "Premiere" : "Premiere Pro";
    case "aftereffects":
      return "After Effects";
    default:
      return short ? "DaVinci" : "DaVinci Resolve";
  }
}

export function cliLabel(adapter: ContentCliAdapter | string): string {
  switch (adapter) {
    case "claude":
      return "Claude Code";
    case "agy":
    default:
      return "Antigravity";
  }
}

export function formatModelParts(
  slug: string,
  adapter: ContentCliAdapter,
): { name: string; tier: string } {
  const effective =
    slug ||
    (adapter === "agy" ? "gemini-4-argon-medium" : "claude-opus-5-5");

  const map: Record<string, { name: string; tier: string }> = {
    // Antigravity (agy) models
    "gemini-4-argon-high": { name: "Gemini 4 Argon", tier: "High" },
    "gemini-4-argon-medium": { name: "Gemini 4 Argon", tier: "Medium" },
    "gemini-4-argon-low": { name: "Gemini 4 Argon", tier: "Low" },
    "gemini-3.8-flash-high": { name: "Gemini 3.8 Flash", tier: "High" },
    "gemini-3.8-flash-medium": { name: "Gemini 3.8 Flash", tier: "Medium" },
    "gemini-3.8-flash-low": { name: "Gemini 3.8 Flash", tier: "Low" },
    "claude-opus-5-5-high": { name: "Claude Opus 5.5", tier: "High" },
    "claude-opus-5-5-medium": { name: "Claude Opus 5.5", tier: "Medium" },
    "claude-opus-5-5-low": { name: "Claude Opus 5.5", tier: "Low" },
    "claude-sonnet-5-5-high": { name: "Claude Sonnet 5.5", tier: "High" },
    "claude-sonnet-5-5-medium": { name: "Claude Sonnet 5.5", tier: "Medium" },
    "claude-sonnet-5-5-low": { name: "Claude Sonnet 5.5", tier: "Low" },
    "gpt-oss-120b-medium": { name: "GPT-OSS 120B", tier: "Medium" },
    // Claude Code CLI models (v2.1.292+)
    "claude-opus-5-5": { name: "Claude Opus 5.5", tier: "Default" },
    "claude-opus-5-5[1m]": { name: "Claude Opus 5.5", tier: "1M Context" },
    "claude-sonnet-5-5": { name: "Claude Sonnet 5.5", tier: "" },
    "claude-sonnet-5-5[1m]": { name: "Claude Sonnet 5.5", tier: "1M Context" },
    "claude-opus-5": { name: "Claude Opus 5", tier: "" },
    "claude-sonnet-5": { name: "Claude Sonnet 5", tier: "" },
    "claude-opus-4-8": { name: "Claude Opus 4.8", tier: "" },
    "claude-opus-4-7": { name: "Claude Opus 4.7", tier: "" },
    "claude-opus-4-6": { name: "Claude Opus 4.6", tier: "" },
    "claude-opus-4-6[1m]": { name: "Claude Opus 4.6", tier: "1M Context" },
    "claude-sonnet-4-6": { name: "Claude Sonnet 4.6", tier: "" },
    "claude-sonnet-4-6[1m]": { name: "Claude Sonnet 4.6", tier: "1M Context" },
    "claude-haiku-4-5-20251001": { name: "Claude Haiku 4.5", tier: "Fast" },
    "claude-sonnet-4-5-20250929": { name: "Claude Sonnet 4.5", tier: "" },
  };

  if (map[effective]) return map[effective];

  const claudeMatch =
    /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?(?:-\d{8})?(\[1m\])?$/i.exec(
      effective,
    );
  if (claudeMatch) {
    const family =
      claudeMatch[1].charAt(0).toUpperCase() + claudeMatch[1].slice(1);
    const ver = claudeMatch[3]
      ? `${claudeMatch[2]}.${claudeMatch[3]}`
      : claudeMatch[2];
    const is1m = Boolean(claudeMatch[4]);
    return {
      name: `Claude ${family} ${ver}`,
      tier: is1m ? "1M Context" : "",
    };
  }

  return { name: effective, tier: "" };
}

// AutoSubs MCP tools, as the CLIs name them ("mcp__autosubs__add_marker",
// "autosubs/add_marker", ...); matched on the part after the server name.
// Labels are `aiEdit.steps.<name>` in the locale files.
const AUTOSUBS_TOOL_NAMES = new Set([
  "get_timeline",
  "get_transcript",
  "build_storyboard",
  "add_marker",
  "add_text",
  "update_clip",
  "delete_clips",
  "split_clips",
  "remove_ranges",
  "remove_marker",
  "add_effects",
  "add_transitions",
  "apply_actions",
  "render_motion",
  "list_media",
  "inspect_media",
  "download_media",
  "save_article",
  "remove_background",
]);

function autosubsToolLabel(rawTool: string): string | undefined {
  const m = /autosubs(?:__|\/|\.|:)([a-z_]+)$/.exec(rawTool);
  return m && AUTOSUBS_TOOL_NAMES.has(m[1])
    ? i18n.t(`aiEdit.steps.${m[1]}`)
    : undefined;
}

// CLI tool name -> `aiEdit.steps.<key>`.
const FRIENDLY_TOOL_KEYS: Record<string, string> = {
  thinking: "thinking",
  run_command: "runCommand",
  write_to_file: "writeFile",
  create_file: "createFile",
  replace_file_content: "editFile",
  edit_file: "editFile",
  multi_replace_file_content: "editMany",
  sed_file: "editFile",
  view_file: "readFile",
  list_dir: "listDir",
  list_directory: "listDir",
  find_by_name: "findFile",
  find_file: "findFile",
  grep_search: "searchCode",
  search_directory: "searchDir",
  search_web: "searchWeb",
  read_url_content: "readWeb",
  generate_image: "generateImage",
  invoke_subagent: "subagent",
  Bash: "runCommand",
  Write: "writeFile",
  Edit: "editFile",
  MultiEdit: "editFile",
  Read: "readFile",
  Glob: "findFile",
  Grep: "searchCode",
  LS: "listDir",
  WebSearch: "searchWeb",
  WebFetch: "readWeb",
};

function friendlyToolLabel(rawTool: string): string | undefined {
  const key = FRIENDLY_TOOL_KEYS[rawTool];
  if (key) return i18n.t(`aiEdit.steps.${key}`);
  for (const [k, v] of Object.entries(FRIENDLY_TOOL_KEYS)) {
    if (rawTool.startsWith(k)) {
      return i18n.t(`aiEdit.steps.${v}`) + rawTool.slice(k.length);
    }
  }
  return undefined;
}

/**
 * Parse a step string emitted by `ai_cli/chat.rs`:
 * New format: `"{state}#{step_id}:{tool_name}||{detail}"`
 * Legacy format: `"{state}:{tool_name}"`
 */
export function formatStepLabel(raw: string): {
  id: string;
  state: string;
  toolName: string;
  detail: string;
  label: string;
} {
  const colonIdx = raw.indexOf(":");
  const header = colonIdx > 0 ? raw.slice(0, colonIdx) : "ACTIVE";
  const body = colonIdx > 0 ? raw.slice(colonIdx + 1) : raw;

  const hashIdx = header.indexOf("#");
  const state = hashIdx > 0 ? header.slice(0, hashIdx) : header;
  const id = hashIdx > 0 ? header.slice(hashIdx + 1) : body.split(" ")[0];

  const sepIdx = body.indexOf("||");
  const rawTool = (sepIdx >= 0 ? body.slice(0, sepIdx) : body).trim();
  const detail = (sepIdx >= 0 ? body.slice(sepIdx + 2) : "").trim();

  if (rawTool === "thinking") {
    return {
      id,
      state,
      toolName: "thinking",
      detail,
      label: detail || i18n.t("aiEdit.steps.planning"),
    };
  }

  const friendlyTool = autosubsToolLabel(rawTool) ?? friendlyToolLabel(rawTool);
  const baseLabel = friendlyTool || rawTool;
  const label = detail ? `${baseLabel}: ${detail}` : baseLabel;

  return {
    id,
    state,
    toolName: rawTool,
    detail,
    label,
  };
}

/** Merge a newly arrived step event into the existing step list by step ID (`#index`). */
export function mergeStepEvent(existing: string[], incoming: string): string[] {
  const parsedNew = formatStepLabel(incoming);
  const idx = existing.findIndex((item) => {
    const p = formatStepLabel(item);
    return p.id === parsedNew.id;
  });
  if (idx >= 0) {
    const next = [...existing];
    next[idx] = incoming;
    return next;
  }
  return [...existing, incoming];
}

export function workspaceShortLabel(path?: string | null): string {
  if (!path) return "Workspace theo Project";
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 2) return normalized;
  return `…/${parts.slice(-2).join("/")}`;
}

/** Extract ```timeline-action ... ``` JSON blocks from an AI message. */
export function extractTimelineActions(
  content: string,
): TimelineActionCommand[] {
  const results: TimelineActionCommand[] = [];
  const regex = /```timeline-action\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item.action === "string") results.push(item);
        }
      } else if (parsed && typeof parsed.action === "string") {
        results.push(parsed);
      }
    } catch {
      // ignore malformed JSON while streaming
    }
  }
  return results;
}

/** Strip completed ```timeline-action ... ``` blocks from visible text so the UI stays clean. */
export function stripTimelineActionBlocks(content: string): string {
  return content.replace(/```timeline-action\s*[\s\S]*?```/g, "").trim();
}
