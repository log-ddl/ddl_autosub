import type { ContentCliAdapter } from "@/api/cli-chat-api";

export interface TimelineActionCommand {
  action:
    | "build_storyboard"
    | "add_marker"
    | "add_text"
    | "update_segment"
    | "delete_segment";
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

export const AI_EDIT_QUICK_STARTERS = [
  {
    title: "Phân tích Timeline hiện tại",
    prompt:
      "Hãy kiểm tra toàn bộ các track và clip đang có trên timeline hiện tại, nhận xét bố cục và đề xuất cách làm video cuốn hút hơn.",
  },
  {
    title: "Tạo hiệu ứng Punch-in Zoom",
    prompt:
      "Hãy giúp tôi zoom nhẹ (1.18x) vào clip đầu tiên trên timeline để tạo điểm nhấn mở đầu (hook).",
  },
  {
    title: "Chèn Motion Graphic 3s",
    prompt:
      "Tạo một Motion Graphic 3s hiện đại trong thư mục motion-graphics của project, xuất ra exports và chèn đè lên trên timeline tại giây đầu tiên.",
  },
  {
    title: "Lên kịch bản Visual Plan & B-Roll",
    prompt:
      "Hãy lập bảng Visual Plan (chọn câu nào dùng B-Roll, câu nào dùng HyperFrames, câu nào Punch-in Zoom) và lưu vào visual-plan.json của dự án này.",
  },
] as const;

export const AI_EDIT_SLASH_COMMANDS = [
  { name: "new", desc: "Tạo cuộc trò chuyện mới" },
  { name: "clear", desc: "Xóa lịch sử cuộc trò chuyện hiện tại" },
  { name: "assets", desc: "Quản lý Motion Graphics, B-Roll AI & Bộ nhớ Project" },
  { name: "memory", desc: "Mở và chỉnh sửa memory.md & global-memory.md" },
  { name: "folder", desc: "Chọn thư mục Workspace làm việc riêng" },
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
const AUTOSUBS_TOOL_NAMES: Record<string, string> = {
  get_timeline: "Đọc Timeline",
  build_storyboard: "Đặt clip lên Timeline",
  add_marker: "Đặt Marker",
  add_text: "Thêm chữ",
  update_clip: "Chỉnh clip",
  delete_clips: "Xóa clip",
};

function autosubsToolLabel(rawTool: string): string | undefined {
  const m = /autosubs(?:__|\/|\.|:)([a-z_]+)$/.exec(rawTool);
  return m ? AUTOSUBS_TOOL_NAMES[m[1]] : undefined;
}

const FRIENDLY_TOOL_NAMES: Record<string, string> = {
  thinking: "Suy luận",
  run_command: "Chạy lệnh Terminal",
  write_to_file: "Tạo / ghi file",
  create_file: "Tạo file",
  replace_file_content: "Chỉnh sửa file",
  edit_file: "Chỉnh sửa file",
  multi_replace_file_content: "Chỉnh sửa nhiều đoạn",
  sed_file: "Chỉnh sửa file (sed)",
  view_file: "Đọc file",
  list_dir: "Xem danh sách thư mục",
  list_directory: "Xem danh sách thư mục",
  find_by_name: "Tìm kiếm file",
  find_file: "Tìm kiếm file",
  grep_search: "Tìm kiếm trong code",
  search_directory: "Tìm kiếm trong thư mục",
  search_web: "Tìm kiếm trên Web",
  read_url_content: "Đọc trang Web",
  generate_image: "Tạo ảnh AI",
  invoke_subagent: "Gọi Subagent",
  Bash: "Chạy lệnh Bash",
  Write: "Ghi file",
  Edit: "Chỉnh sửa file",
  MultiEdit: "Chỉnh sửa file",
  Read: "Đọc file",
  Glob: "Tìm file",
  Grep: "Tìm trong code",
  LS: "Xem thư mục",
  WebSearch: "Tìm kiếm Web",
  WebFetch: "Đọc trang Web",
};

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
      label: detail || "Suy luận & lập kế hoạch",
    };
  }

  let friendlyTool = autosubsToolLabel(rawTool) ?? FRIENDLY_TOOL_NAMES[rawTool];
  if (!friendlyTool) {
    for (const [k, v] of Object.entries(FRIENDLY_TOOL_NAMES)) {
      if (rawTool.startsWith(k)) {
        friendlyTool = v + rawTool.slice(k.length);
        break;
      }
    }
  }
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
