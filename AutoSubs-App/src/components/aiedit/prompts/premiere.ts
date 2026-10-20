import type { WorkspaceInfo } from "@/api/cli-chat-api";
import {
  actionsSection,
  intro,
  STORYBOARD_DOC,
  toolsSection,
  userAndMemorySections,
  workspaceSection,
} from "./shared";

// System prompt for a conversation bound to Adobe Premiere Pro.

const PREMIERE_STORYBOARD_NOTE = `- **Giới hạn của Premiere**: clip luôn được đặt nối tiếp sau clip cuối cùng trên track (\`mode\` được coi là \`"append"\`), và \`effect\` không được áp khi đặt clip. Muốn zoom/pan thì gọi \`update_segment\` sau khi đặt.`;

const PREMIERE_MARKER_DOC = `**Đặt Marker lên Sequence Premiere** (\`add_marker\`):
- \`markers\`: danh sách marker, mỗi phần tử gồm:
  - \`atSec\`: Vị trí marker, tính bằng giây từ đầu sequence (ví dụ phút thứ 2 là \`120\`).
  - \`color\` (tùy chọn): một trong \`Green\`, \`Red\`, \`Purple\`, \`Orange\`, \`Yellow\`, \`White\`, \`Blue\`, \`Cyan\`.
  - \`name\` (tùy chọn): Tiêu đề ngắn của marker.
  - \`note\` (tùy chọn): Ghi chú, được ghi vào ô Comments của marker.
  - \`durationSec\` (tùy chọn): Độ dài vùng marker (giây). Bỏ trống là marker 1 điểm.
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

const PREMIERE_ADD_TEXT_DOC = `**Thêm chữ lên Sequence Premiere** (\`add_text\`):
- \`texts\`: danh sách đoạn chữ, mỗi phần tử gồm \`text\`, \`start\`, \`end\` (giây từ đầu sequence).
- Premiere không cho script tạo title, nên chữ được thêm thành một **Caption Track** mới (mỗi phần tử là một caption).
\`\`\`timeline-action
{
  "action": "add_text",
  "summary": "Thêm tiêu đề mở đầu",
  "texts": [
    { "text": "5 SỰ THẬT BẠN CHƯA BIẾT", "start": 0, "end": 3 }
  ]
}
\`\`\``;

const PREMIERE_UPDATE_DOC = `**Chỉnh một clip trên Premiere** (\`update_segment\` theo \`id\` trong danh sách clip ở trên):
- Đổi được: \`startSec\` (dời clip), \`durationSec\` (đổi độ dài), \`zoom\` (1.0 = 100%), \`panX\` / \`panY\` (-1..1, 0 = giữa khung), \`rotation\` (độ), \`opacity\` (0-100).
- Truyền \`zoomEnd\` / \`panXEnd\` / \`panYEnd\` để tạo keyframe động từ đầu đến cuối clip.
- Không đổi được âm lượng và nội dung caption.
\`\`\`timeline-action
{
  "action": "update_segment",
  "summary": "Zoom chậm từ 100% lên 120%",
  "segmentId": "<ID_CLIP>",
  "zoom": 1.0,
  "zoomEnd": 1.2
}
\`\`\``;

const PREMIERE_DELETE_DOC = `**Xóa clip khỏi Premiere** (\`delete_segment\`):
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

/** What GetTimelineSnapshot (ppro/ai-edit.ts) returns for the active sequence. */
export interface PremiereTimelineSnapshot {
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
      path?: string;
    }>;
  }>;
  markers: Array<{ atSec: number; color: string; name: string; durationSec: number }>;
}

function premiereTimelineSummary(snapshot: PremiereTimelineSnapshot): string {
  const tracks = (snapshot.tracks ?? [])
    .map((tr) => {
      const clips = (tr.clips ?? [])
        .slice(0, 40)
        .map(
          (c) =>
            `  - [id="${c.id}"] "${c.name}" từ ${c.startSec.toFixed(2)}s -> ${(c.startSec + c.durationSec).toFixed(2)}s (dài ${c.durationSec.toFixed(2)}s${c.zoom != null ? `, zoom=${c.zoom.toFixed(2)}` : ""}${c.path ? `, path="${c.path}"` : ""})`,
        )
        .join("\n");
      const label = tr.trackType === "video" ? "V" : "A";
      return `Track ${label}${tr.index}${tr.name ? ` "${tr.name}"` : ""} (${tr.trackType}, ${(tr.clips ?? []).length} clips):\n${clips || "  (trống)"}`;
    })
    .join("\n\n");
  const markers = (snapshot.markers ?? [])
    .map((m) => `  - [${m.color}] "${m.name}" tại ${m.atSec.toFixed(2)}s`)
    .join("\n");
  return `- ${snapshot.fps}fps, tổng thời lượng ${snapshot.durationSec.toFixed(2)}s
- Chi tiết các Track trên Sequence:
${tracks || "(Sequence hiện đang trống)"}
- Marker đang có trên Sequence:
${markers || "  (Chưa có marker nào)"}`;
}

function premiereContext(
  sequenceName: string | undefined,
  snapshot: PremiereTimelineSnapshot | null,
): string {
  return `### Ngữ cảnh Premiere Pro hiện tại:
- Sequence đang mở: "${snapshot?.name || sequenceName || "Active Sequence"}"
${snapshot ? premiereTimelineSummary(snapshot) : "- (Chưa đọc được danh sách clip của sequence. Hãy kiểm tra panel AutoSubs trong Premiere đã mở chưa.)"}`;
}

/** Prompt for a conversation bound to Premiere Pro. */
export function buildPremierePrompt(
  sequenceName: string | undefined,
  snapshot: PremiereTimelineSnapshot | null,
  userSystemPrompt: string,
  workspaceInfo: WorkspaceInfo | null,
  useTools: boolean,
): string {
  return [
    intro("PREMIERE PRO"),
    premiereContext(sequenceName, snapshot),
    ...workspaceSection(workspaceInfo),
    useTools
      ? toolsSection("Premiere Pro")
      : actionsSection([
          `${STORYBOARD_DOC}\n${PREMIERE_STORYBOARD_NOTE}`,
          PREMIERE_MARKER_DOC,
          PREMIERE_ADD_TEXT_DOC,
          PREMIERE_UPDATE_DOC,
          PREMIERE_DELETE_DOC,
        ]),
    ...userAndMemorySections(userSystemPrompt, workspaceInfo),
  ].join("\n\n");
}
