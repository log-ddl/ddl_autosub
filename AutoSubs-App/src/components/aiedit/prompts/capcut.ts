import type { WorkspaceInfo } from "@/api/cli-chat-api";
import type { CapCutTimelineSnapshot } from "@/api/capcut-api";
import {
  actionsSection,
  intro,
  REMOVE_RANGES_DOC,
  SPLIT_DOC,
  STORYBOARD_DOC,
  timelineBrief,
  toolsSection,
  userAndMemorySections,
  workspaceSection,
} from "./shared";

// System prompt for a conversation bound to CapCut.

const CAPCUT_MARKER_DOC = `**Đặt Marker lên Timeline CapCut** (\`add_marker\`):
- \`markers\`: danh sách marker, mỗi phần tử gồm:
  - \`atSec\`: Vị trí marker, tính bằng giây từ đầu timeline (ví dụ phút thứ 2 là \`120\`).
  - \`color\` (tùy chọn): CapCut chỉ có 2 màu: \`"Red"\` (đỏ) hoặc mặc định (xanh cyan).
  - \`name\` (tùy chọn): Tiêu đề của marker. CapCut không có ô ghi chú riêng, hãy đưa nội dung cần ghi vào \`name\`.
  - \`durationSec\` (tùy chọn): Độ dài vùng marker (giây). Bỏ trống là marker 1 điểm.
- Marker trùng frame với marker đã có sẽ bị bỏ qua.
\`\`\`timeline-action
{
  "action": "add_marker",
  "summary": "Đánh dấu 2 điểm cần chèn B-roll",
  "markers": [
    { "atSec": 12.5, "color": "Red", "name": "Chèn B-roll: cảnh xe chạy" },
    { "atSec": 45, "name": "Hook 2" }
  ]
}
\`\`\``;

const UPDATE_SEGMENT_DOC = `**Chỉnh sửa hoặc tạo Keyframe động cho một clip/segment đang có trên CapCut** (\`update_segment\` theo \`id\` của segment — truyền \`zoomEnd\` / \`panXEnd\` / \`panYEnd\` sẽ tự động tạo keyframe động mượt mà từ đầu đến cuối clip):
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
\`\`\``;

const DELETE_SEGMENT_DOC = `**Xóa một clip/segment khỏi CapCut** (\`delete_segment\`):
\`\`\`timeline-action
{
  "action": "delete_segment",
  "summary": "Xóa clip khỏi timeline",
  "segmentId": "<ID_SEGMENT>"
}
\`\`\``;

const CAPCUT_ADD_TEXT_DOC = `**Thêm chữ / tiêu đề lên Timeline CapCut** (\`add_text\`):
- \`texts\`: danh sách đoạn chữ, mỗi phần tử gồm \`text\`, \`start\`, \`end\` (giây từ đầu timeline).
- \`template\` (tùy chọn): \`"Yellow"\` cho chữ vàng, bỏ trống là chữ trắng viền đen.
- Mỗi lần gọi tạo một Text Track mới.
\`\`\`timeline-action
{
  "action": "add_text",
  "summary": "Thêm tiêu đề mở đầu",
  "template": "Yellow",
  "texts": [
    { "text": "5 SỰ THẬT BẠN CHƯA BIẾT", "start": 0, "end": 3 }
  ]
}
\`\`\``;

function capcutContext(snapshot: CapCutTimelineSnapshot, useTools: boolean): string {
  const counters: Record<string, number> = {};
  const tracks = snapshot.tracks.map((tr) => {
    const letter = tr.trackType === "audio" ? "A" : tr.trackType === "text" ? "T" : tr.trackType === "video" ? "V" : "E";
    counters[letter] = (counters[letter] ?? 0) + 1;
    return { label: `${letter}${counters[letter]}`, count: tr.segments.length };
  });

  return `### Ngữ cảnh Project CapCut hiện tại:
- Tên Project: "${snapshot.draftName}" (ID: ${snapshot.draftId})
- Thư mục Draft CapCut: "${snapshot.folderPath}"
- Đường dẫn file Timeline JSON trực tiếp: "${snapshot.jsonPath}"
- Độ phân giải: ${snapshot.canvasWidth}x${snapshot.canvasHeight}
${timelineBrief(snapshot.fps, snapshot.durationSec, tracks, (snapshot.markers ?? []).length)}${useTools ? "" : `

${capcutJsonGuide(snapshot)}`}`;
}

// How to edit the draft JSON by hand; only offered when the agent has no tools.
function capcutJsonGuide(snapshot: CapCutTimelineSnapshot): string {
  return `### Quy chuẩn cấu trúc JSON của CapCut (Dùng ngay, TUYỆT ĐỐI KHÔNG quét mã nguồn dự án hay thư mục target/ node_modules/):
- Đơn vị thời gian trong \`${snapshot.jsonPath}\` là **microseconds** (\`1s = 1_000_000\`).
- Để tạo **Keyframe động** (Zoom/Pan/Rotation/Volume) trên một \`segment\`, đặt \`"uniform_scale": {"on": true, "value": 1.0}\` và ghi mảng \`common_keyframes\` trên segment đó:
  - Các \`property_type\` chuẩn: \`"KFTypeScaleX"\` (tỉ lệ zoom), \`"KFTypePositionX"\`, \`"KFTypePositionY"\`, \`"KFTypeRotation"\`, \`"KFTypeVolume"\`.
  - Mỗi phần tử trong \`keyframe_list\` có: \`{"id": "<UUID-HOA>", "curveType": "Line", "time_offset": <offset_us_tinh_tu_dau_clip>, "left_control": {"x":0.0,"y":0.0}, "right_control": {"x":0.0,"y":0.0}, "values": [<gia_tri_float>], "string_value": "", "graphID": ""}\`.
- Nếu bạn dùng script Python sửa trực tiếp \`${snapshot.jsonPath}\`, hãy đồng bộ nội dung đó sang cả \`draft_info.json.bak\`, \`template-2.tmp\` và thư mục con \`Timelines/<id>/\` (nếu có) để CapCut nhận 100%.`;
}

/** Prompt for a conversation bound to CapCut. `snapshot` is null until the draft is read. */
export function buildCapCutPrompt(
  snapshot: CapCutTimelineSnapshot | null,
  userSystemPrompt: string,
  workspaceInfo: WorkspaceInfo | null,
  useTools: boolean,
): string {
  return [
    intro("CAPCUT"),
    ...(snapshot ? [capcutContext(snapshot, useTools)] : []),
    ...workspaceSection(workspaceInfo),
    useTools
      ? toolsSection("CapCut")
      : actionsSection([
          STORYBOARD_DOC,
          CAPCUT_MARKER_DOC,
          CAPCUT_ADD_TEXT_DOC,
          UPDATE_SEGMENT_DOC,
          DELETE_SEGMENT_DOC,
          SPLIT_DOC,
          REMOVE_RANGES_DOC,
        ]),
    ...userAndMemorySections(userSystemPrompt, workspaceInfo),
  ].join("\n\n");
}
