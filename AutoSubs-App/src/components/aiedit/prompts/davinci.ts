import type { WorkspaceInfo } from "@/api/cli-chat-api";
import {
  actionsSection,
  intro,
  STORYBOARD_DOC,
  toolsSection,
  userAndMemorySections,
  workspaceSection,
} from "./shared";

// System prompt for a conversation bound to DaVinci Resolve.

const DAVINCI_MARKER_DOC = `**Đặt Marker lên Timeline** (\`add_marker\`):
- \`markers\`: danh sách marker, mỗi phần tử gồm:
  - \`atSec\`: Vị trí marker, tính bằng giây từ đầu timeline (ví dụ phút thứ 2 là \`120\`).
  - \`color\` (tùy chọn, mặc định \`"Blue"\`): một trong \`Blue\`, \`Cyan\`, \`Green\`, \`Yellow\`, \`Red\`, \`Pink\`, \`Purple\`, \`Fuchsia\`, \`Rose\`, \`Lavender\`, \`Sky\`, \`Mint\`, \`Lemon\`, \`Sand\`, \`Cocoa\`, \`Cream\`.
  - \`name\` (tùy chọn): Tiêu đề ngắn của marker.
  - \`note\` (tùy chọn): Ghi chú chi tiết.
  - \`durationSec\` (tùy chọn): Độ dài vùng marker (giây). Bỏ trống là marker 1 frame.
- Mỗi frame chỉ có 1 marker; marker trùng vị trí với marker cũ sẽ bị bỏ qua.
\`\`\`timeline-action
{
  "action": "add_marker",
  "summary": "Đánh dấu 2 điểm cần chèn B-roll",
  "markers": [
    { "atSec": 12.5, "color": "Red", "name": "Chèn B-roll", "note": "Cảnh xe chạy" },
    { "atSec": 45, "color": "Green", "name": "Hook 2" }
  ]
}
\`\`\``;

const DAVINCI_ADD_TEXT_DOC = `**Thêm chữ / tiêu đề lên Timeline DaVinci** (\`add_text\`):
- \`texts\`: danh sách đoạn chữ, mỗi phần tử gồm \`text\`, \`start\`, \`end\` (giây từ đầu timeline).
- \`template\` (tùy chọn): tên một Text+ trong Media Pool. \`"AutoSubs Caption"\` là chữ động hiện từng từ; mặc định là \`"Default Template"\`.
- \`track\` (tùy chọn): số Video Track đặt chữ, \`"0"\` hoặc bỏ trống là tạo track mới.
\`\`\`timeline-action
{
  "action": "add_text",
  "summary": "Thêm tiêu đề mở đầu",
  "template": "AutoSubs Caption",
  "texts": [
    { "text": "5 SỰ THẬT BẠN CHƯA BIẾT", "start": 0, "end": 3 }
  ]
}
\`\`\``;

const DAVINCI_UPDATE_DOC = `**Chỉnh một clip trên DaVinci** (\`update_segment\` theo \`id\` trong danh sách clip ở trên):
- Chỉ đổi được: \`zoom\`, \`panX\`, \`panY\`, \`rotation\`, \`opacity\` (0-100) và \`text\` (nội dung chữ của clip Text+).
- API của Resolve **không** dời hay đổi độ dài clip, không tạo keyframe, không đổi âm lượng. Muốn dời clip, hãy xóa rồi đặt lại bằng \`build_storyboard\`.
\`\`\`timeline-action
{
  "action": "update_segment",
  "summary": "Zoom nhẹ clip mở đầu",
  "segmentId": "<ID_CLIP>",
  "zoom": 1.15
}
\`\`\``;

const DAVINCI_DELETE_DOC = `**Xóa clip khỏi DaVinci** (\`delete_segment\`):
- \`segmentId\` hoặc \`segmentIds\` (danh sách id trong danh sách clip ở trên).
- \`ripple\` (tùy chọn): \`true\` để dồn các clip phía sau lấp chỗ trống.
\`\`\`timeline-action
{
  "action": "delete_segment",
  "summary": "Xóa 2 clip thừa",
  "segmentIds": ["<ID_CLIP_1>", "<ID_CLIP_2>"],
  "ripple": true
}
\`\`\``;

/** What GetTimelineSnapshot (ai_edit.lua) returns for the open Resolve timeline. */
export interface DavinciTimelineSnapshot {
  name: string;
  fps: number;
  durationSec: number;
  tracks: Array<{
    trackType: string;
    index: number;
    name: string;
    clips: Array<{
      id: string;
      name: string;
      startSec: number;
      durationSec: number;
      zoom?: number;
    }>;
  }>;
  markers: Array<{ atSec: number; color: string; name: string; durationSec: number }>;
}

function davinciTimelineSummary(snapshot: DavinciTimelineSnapshot): string {
  const tracks = (snapshot.tracks ?? [])
    .map((tr) => {
      const clips = (tr.clips ?? [])
        .slice(0, 40)
        .map(
          (c) =>
            `  - [id="${c.id}"] "${c.name}" từ ${c.startSec.toFixed(2)}s -> ${(c.startSec + c.durationSec).toFixed(2)}s (dài ${c.durationSec.toFixed(2)}s${c.zoom != null ? `, zoom=${c.zoom.toFixed(2)}` : ""})`,
        )
        .join("\n");
      const label = tr.trackType === "video" ? "V" : tr.trackType === "audio" ? "A" : "S";
      return `Track ${label}${tr.index}${tr.name ? ` "${tr.name}"` : ""} (${tr.trackType}, ${(tr.clips ?? []).length} clips):\n${clips || "  (trống)"}`;
    })
    .join("\n\n");
  const markers = (snapshot.markers ?? [])
    .map((m) => `  - [${m.color}] "${m.name}" tại ${m.atSec.toFixed(2)}s`)
    .join("\n");
  return `- ${snapshot.fps}fps, tổng thời lượng ${snapshot.durationSec.toFixed(2)}s
- Chi tiết các Track trên Timeline:
${tracks || "(Timeline hiện đang trống)"}
- Marker đang có trên Timeline:
${markers || "  (Chưa có marker nào)"}`;
}

function davinciContext(
  resolveTimelineName: string | undefined,
  snapshot: DavinciTimelineSnapshot | null,
  useTools: boolean,
): string {
  return `### Ngữ cảnh DaVinci Resolve hiện tại:
- Timeline đang mở: "${snapshot?.name || resolveTimelineName || "Current Timeline"}"
${snapshot ? davinciTimelineSummary(snapshot) : "- (Chưa đọc được danh sách clip của timeline)"}${useTools ? "" : `
${DAVINCI_HTTP_NOTES}`}`;
}

const DAVINCI_HTTP_NOTES = `- Cổng HTTP của AutoSubs (app chuyển tiếp vào script AutoSubs đang chạy trong Resolve): \`http://127.0.0.1:56002\` (gửi HTTP POST JSON \`{"func": "<FunctionName>", ...}\`).
- Các hàm có sẵn trên cổng \`:56002\`: \`GetTimelineSnapshot\`, \`GetTimelineInfo\`, \`GetTimelineSelection\`, \`BuildStoryboard\`, \`AddMarkers\`, \`AddSubtitles\`, \`UpdateClip\`, \`DeleteClips\`, \`JumpToTime\`, \`ResolveRpc\`.
- TUYỆT ĐỐI KHÔNG chạy grep/find quét thư mục \`target/\` hay \`node_modules/\`.`;

/** Prompt for a conversation bound to DaVinci Resolve. */
export function buildDavinciPrompt(
  timelineName: string | undefined,
  snapshot: DavinciTimelineSnapshot | null,
  userSystemPrompt: string,
  workspaceInfo: WorkspaceInfo | null,
  useTools: boolean,
): string {
  return [
    intro("DAVINCI"),
    davinciContext(timelineName, snapshot, useTools),
    ...workspaceSection(workspaceInfo),
    useTools
      ? toolsSection("DaVinci Resolve")
      : actionsSection([
          STORYBOARD_DOC,
          DAVINCI_MARKER_DOC,
          DAVINCI_ADD_TEXT_DOC,
          DAVINCI_UPDATE_DOC,
          DAVINCI_DELETE_DOC,
        ]),
    ...userAndMemorySections(userSystemPrompt, workspaceInfo),
  ].join("\n\n");
}
