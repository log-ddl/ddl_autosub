import type { ContentCliAdapter, WorkspaceInfo } from "@/api/cli-chat-api";
import type { CapCutTimelineSnapshot } from "@/api/capcut-api";

export interface TimelineActionCommand {
  action: "build_storyboard" | "update_segment" | "delete_segment";
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

  let friendlyTool = FRIENDLY_TOOL_NAMES[rawTool];
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

export function buildEditorContextPrompt(
  integration: string,
  snapshot: CapCutTimelineSnapshot | null,
  resolveTimelineName: string | undefined,
  userSystemPrompt: string,
  workspaceInfo: WorkspaceInfo | null,
): string {
  const parts: string[] = [];

  parts.push(
    `Bạn là AI Video Director tích hợp trực tiếp bên trong ứng dụng AutoSubs.
Trình dựng phim đích hiện đang kết nối: **${integration.toUpperCase()}**.`,
  );

  if (integration === "capcut" && snapshot) {
    const trackSummary = snapshot.tracks
      .map((tr) => {
        const segs = tr.segments
          .slice(0, 40)
          .map(
            (s) =>
              `  - [id="${s.id}"] (${s.kind}) "${s.name}" từ ${s.startSec.toFixed(2)}s -> ${(s.startSec + s.durationSec).toFixed(2)}s (dài ${s.durationSec.toFixed(2)}s, zoom=${(s.zoom || 1).toFixed(2)}${s.text ? `, text="${s.text}"` : ""}${s.mediaPath ? `, path="${s.mediaPath}"` : ""})`,
          )
          .join("\n");
        return `Track "${tr.name}" (${tr.trackType}, ${tr.segments.length} clips):\n${segs || "  (trống)"}`;
      })
      .join("\n\n");

    parts.push(
      `### Ngữ cảnh Project CapCut hiện tại:
- Tên Project: "${snapshot.draftName}" (ID: ${snapshot.draftId})
- Thư mục Draft CapCut: "${snapshot.folderPath}"
- Đường dẫn file Timeline JSON trực tiếp: "${snapshot.jsonPath}"
- Độ phân giải: ${snapshot.canvasWidth}x${snapshot.canvasHeight} @ ${snapshot.fps}fps
- Tổng thời lượng: ${snapshot.durationSec.toFixed(2)}s
- Chi tiết các Track trên Timeline:
${trackSummary || "(Timeline hiện đang trống)"}

### Quy chuẩn cấu trúc JSON của CapCut (Dùng ngay, TUYỆT ĐỐI KHÔNG quét mã nguồn dự án hay thư mục target/ node_modules/):
- Đơn vị thời gian trong \`${snapshot.jsonPath}\` là **microseconds** (\`1s = 1_000_000\`).
- Để tạo **Keyframe động** (Zoom/Pan/Rotation/Volume) trên một \`segment\`, đặt \`"uniform_scale": {"on": true, "value": 1.0}\` và ghi mảng \`common_keyframes\` trên segment đó:
  - Các \`property_type\` chuẩn: \`"KFTypeScaleX"\` (tỉ lệ zoom), \`"KFTypePositionX"\`, \`"KFTypePositionY"\`, \`"KFTypeRotation"\`, \`"KFTypeVolume"\`.
  - Mỗi phần tử trong \`keyframe_list\` có: \`{"id": "<UUID-HOA>", "curveType": "Line", "time_offset": <offset_us_tinh_tu_dau_clip>, "left_control": {"x":0.0,"y":0.0}, "right_control": {"x":0.0,"y":0.0}, "values": [<gia_tri_float>], "string_value": "", "graphID": ""}\`.
- Nếu bạn dùng script Python sửa trực tiếp \`${snapshot.jsonPath}\`, hãy đồng bộ nội dung đó sang cả \`draft_info.json.bak\`, \`template-2.tmp\` và thư mục con \`Timelines/<id>/\` (nếu có) để CapCut nhận 100%.`,
    );
  } else if (integration === "davinci") {
    parts.push(
      `### Ngữ cảnh DaVinci Resolve hiện tại:
- Timeline đang mở: "${resolveTimelineName || "Current Timeline"}"
- LuaJIT HTTP Server đang lắng nghe tại: \`http://127.0.0.1:56002\` (gửi HTTP POST JSON \`{"func": "<FunctionName>", ...}\`).
- Các hàm có sẵn trên cổng \`:56002\`: \`GetTimelineInfo\`, \`GetTimelineSelection\`, \`BuildStoryboard\` (tự động \`AddTrack("video")\` theo \`target_video_track\` và \`AddTrack("audio")\` cho \`audio_path\`), \`AddSubtitles\`, \`JumpToTime\`, \`ResolveRpc\`.
- Tài liệu kỹ năng tạo Fusion Macro (\`.setting\`) & Keyframe BezierSpline cho DaVinci Resolve có sẵn tại: \`/Users/dd/Documents/app/ddl_autosub/.agents/skills/davinci-resolve-fusion/SKILL.md\`.
- TUYỆT ĐỐI KHÔNG chạy grep/find quét thư mục \`target/\` hay \`node_modules/\`.`,
    );
  }

  if (workspaceInfo) {
    const assetSummary =
      workspaceInfo.assets.length > 0
        ? workspaceInfo.assets
            .slice(0, 30)
            .map((a) => `  - [${a.category}] ${a.name} (${a.path})`)
            .join("\n")
        : "  (Chưa có asset nào)";

    parts.push(
      `### Cấu trúc Quản lý Project Assets & Workspace (2 Tầng):
Để tránh lộn xộn giữa các dự án, bạn PHẢI lưu đúng loại file vào các thư mục chuẩn sau của Project **${workspaceInfo.projectSlug}**:
1. **Thư mục gốc của Project hiện tại**: \`${workspaceInfo.path}\`
   - \`${workspaceInfo.motionGraphicsDir}\`: Nơi tạo các mini-project Motion Graphic / Remotion / HTML5 (mỗi cảnh tạo 1 thư mục con riêng).
   - \`${workspaceInfo.aiBrollDir}\`: Nơi lưu video hoặc ảnh B-Roll do AI tạo ra hoặc tải về cho riêng video này.
   - \`${workspaceInfo.exportsDir}\`: Nơi xuất các file video thành phẩm (\`.mp4\`, \`.mov\`) đã render xong để đẩy vào Timeline CapCut / DaVinci.
   - \`${workspaceInfo.path}/visual-plan.json\`: File lưu kịch bản phân cảnh Visual Plan của dự án.
2. **Kho mẫu Motion Graphic dùng chung (Global Templates)**: \`${workspaceInfo.templatesDir}\`
3. **Danh sách Assets hiện có trong Project**:
${assetSummary}`,
    );
  }

  parts.push(
    `### Quy tắc thực thi lệnh dựng phim TỨC THÌ lên Timeline (KHÔNG ĐỌC SOURCE CODE CỦA APP):
⚠️ **QUY TẮC TỐC ĐỘ TỐI QUAN TRỌNG**:
- **TUYỆT ĐỐI KHÔNG** chạy \`grep\`, \`find\`, hay \`view_file\` vào mã nguồn của ứng dụng AutoSubs (\`use-ai-edit-controller.ts\`, \`resolve-api.ts\`, \`autosubs_core.lua\`, \`capcut_bridge.rs\`, \`target/\`, \`node_modules/\`...).
- Mọi tham số của \`timeline-action\` đã được định nghĩa ĐẦY ĐỦ 100% ngay bên dưới. Khi người dùng yêu cầu import, cắt ghép đoạn video, chèn A-roll/B-roll, thêm nhạc/SFX, hoặc chỉnh keyframe, hãy tính toán thông số và **phát ra khối \`\`\`timeline-action NGAY LẬP TỨC trong 1 bước duy nhất**!

1. **Import, Cắt ghép (Cut/Split), Thay thế, Chèn xen giữa, hoặc Đè B-Roll / Motion Graphic / Audio lên Timeline** (\`build_storyboard\` — hoạt động cho cả **DaVinci Resolve** và **CapCut**):
- \`mode\`: Chế độ đặt clip tại mốc thời gian \`start\` (MẶC ĐỊNH tự nhận diện thông minh, nhưng hãy truyền rõ ràng):
  - \`"replace"\` (Overwrite / Thay thế tại chỗ): Cắt bỏ phần clip cũ đang nằm ở khoảng \`[start, end]\` trên \`targetVideoTrack\` (ví dụ thay thế đoạn ở phút thứ 2 = \`120s\`) rồi đặt clip mới thế vào đúng vị trí đó.
  - \`"insert"\` (Ripple Insert / Chèn xen vào giữa): Cắt đôi clip hiện tại ở mốc \`start\` (ví dụ phút thứ 2 = \`120s\`), đẩy lùi toàn bộ các clip phía sau về sau một khoảng bằng độ dài clip mới, rồi nhét clip mới vào giữa.
  - \`"overlay"\` (Đè B-Roll / Motion Graphic lên Track trên): Giữ nguyên Track V1, đặt clip mới đè lên Track V2+ tại đúng mốc \`start\` (tự tạo Track mới nếu Track trên đã vướng clip khác).
  - \`"append"\` (Nối tiếp vào cuối hoặc dựng tuần tự từ đầu): Đặt nối tiếp nhau hoặc nối vào cuối Track.
- \`targetVideoTrack\`: Số thứ tự Video Track đích (\`1\` = V1, \`2\` = V2, \`3\` = V3...). Hệ thống tự động tạo Track mới nếu chưa tồn tại.
- \`audioPath\` (tùy chọn): Đường dẫn file âm thanh / nhạc nền / SFX muốn đặt vào một Audio Track mới.
- Mỗi phần tử trong \`items\` gồm:
  - \`path\`: Đường dẫn tuyệt đối tới file video hoặc ảnh.
  - \`start\`: Thời điểm bắt đầu đặt trên Timeline (giây, ví dụ phút thứ 2 là \`120\`).
  - \`end\` (tùy chọn): Thời điểm kết thúc trên Timeline (giây).
  - \`srcIn\` (tùy chọn): Giây bắt đầu cắt bên trong video gốc (ví dụ \`0\`, \`60\`, \`120\` khi muốn cắt nhỏ 1 video dài thành nhiều đoạn).
  - \`srcOut\` (tùy chọn): Giây kết thúc cắt bên trong video gốc (ví dụ cắt 5 phút đầu thành 5 đoạn 1 phút: tạo 5 item có \`srcIn\`/\`srcOut\` lần lượt là \`0->60\`, \`60->120\`, \`120->180\`, \`180->240\`, \`240->300\` và \`start\`/\`end\` tương ứng).
  - \`effect\` (tùy chọn): \`{ "zoom": 1.12, "panX": 0, "panY": 0, "rotation": 0 }\`.
\`\`\`timeline-action
{
  "action": "build_storyboard",
  "summary": "Thay thế đoạn từ 02:00 đến 02:15 trên Track V1",
  "mode": "replace",
  "targetVideoTrack": 1,
  "audioPath": "/duong/dan/nhac_hoac_sfx.mp3",
  "items": [
    { "path": "/duong/dan/video.mp4", "start": 120, "end": 135, "srcIn": 0, "srcOut": 15, "effect": { "zoom": 1.0 } }
  ]
}
\`\`\`

2. **Chỉnh sửa hoặc tạo Keyframe động cho một clip/segment đang có trên CapCut** (\`update_segment\` theo \`id\` của segment — truyền \`zoomEnd\` / \`panXEnd\` / \`panYEnd\` sẽ tự động tạo keyframe động mượt mà từ đầu đến cuối clip):
\`\`\`timeline-action
{
  "action": "update_segment",
  "summary": "Tạo keyframe zoom động từ 1.0x lên 2.0x",
  "segmentId": "<ID_SEGMENT>",
  "startSec": 0,
  "durationSec": 3.5,
  "zoom": 1.0,
  "zoomEnd": 2.0,
  "panX": 0.0,
  "panXEnd": 0.0,
  "volume": 1.0,
  "text": "Nội dung chữ mới (nếu là text)"
}
\`\`\`

3. **Xóa một clip/segment khỏi CapCut** (\`delete_segment\`):
\`\`\`timeline-action
{
  "action": "delete_segment",
  "summary": "Xóa clip khỏi timeline",
  "segmentId": "<ID_SEGMENT>"
}
\`\`\``,
  );

  if (userSystemPrompt.trim()) {
    parts.push(`### Chỉ dẫn bổ sung từ người dùng:\n${userSystemPrompt.trim()}`);
  }

  if (workspaceInfo?.globalMemory?.trim()) {
    parts.push(
      `### Bộ nhớ Toàn cục (global-memory.md — Áp dụng cho mọi dự án):\n${workspaceInfo.globalMemory.trim()}`,
    );
  }

  if (workspaceInfo?.memory?.trim()) {
    parts.push(
      `### Bộ nhớ Riêng của Project (${workspaceInfo.projectSlug}/memory.md):\n${workspaceInfo.memory.trim()}`,
    );
  }

  return parts.join("\n\n");
}
