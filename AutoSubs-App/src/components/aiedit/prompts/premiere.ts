import type { WorkspaceInfo } from "@/api/cli-chat-api";
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

// System prompt for a conversation bound to Adobe Premiere Pro.

const PREMIERE_STORYBOARD_NOTE = `- **Lưu ý với Premiere**: \`replace\` ghi đè cả video lẫn audio đi kèm; \`insert\` chỉ đẩy lùi Video Track đích và Audio Track cùng số; \`overlay\` chỉ đặt video (không kèm audio của B-roll).`;

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
- Mỗi đoạn là một Motion Graphics Template (.mogrt) đặt trên video track trống đầu tiên từ \`track\` trở lên (mặc định V2), chữ được gõ vào ô chữ đầu tiên của template.
- \`template\` (tùy chọn): tên template có sẵn trong Premiere (mặc định \`Basic Title\`, ví dụ \`Basic Lower Third\`, \`Bold Web Caption\`) hoặc đường dẫn file .mogrt. \`"captions"\` thì thêm thành Caption Track (dùng cho phụ đề).
\`\`\`timeline-action
{
  "action": "add_text",
  "summary": "Thêm tiêu đề mở đầu",
  "template": "Basic Title",
  "texts": [
    { "text": "5 SỰ THẬT BẠN CHƯA BIẾT", "start": 0, "end": 3 }
  ]
}
\`\`\``;

const PICK_CLIPS_NOTE = `- Chọn clip: \`segmentId\` cho một clip, hoặc chọn nhiều clip bằng \`clips\` (danh sách id), \`tracks\` (ví dụ \`["V1"]\`), \`fromSec\` / \`toSec\`, \`selected: true\` (các clip người dùng đang chọn trong Premiere) hay \`all: true\`. Các điều kiện cộng dồn: \`tracks: ["V1"]\` + \`fromSec: 10\` là mọi clip V1 từ giây 10 trở đi.`;

const PREMIERE_UPDATE_DOC = `**Chỉnh clip trên Premiere** (\`update_segment\`):
${PICK_CLIPS_NOTE}
- Đổi được: \`startSec\` (dời clip), \`durationSec\` (đổi độ dài) (hai trường này chỉ cho một clip), \`zoom\` (1.0 = 100%), \`panX\` / \`panY\` (-1..1, 0 = giữa khung), \`rotation\` (độ), \`opacity\` (0-100).
- Truyền \`zoomEnd\` / \`panXEnd\` / \`panYEnd\` để tạo keyframe động từ đầu đến cuối clip.
- \`volume\`: âm lượng của clip audio (hoặc audio đi liền với clip video): \`1.0\` = giữ nguyên, \`0.5\` ≈ -6 dB, \`0\` = tắt tiếng.
- \`speed\`: tốc độ (\`2\` = nhanh gấp đôi, \`0.5\` = chậm một nửa; clip dài ra nên cần chỗ trống phía sau). \`reverse: true\` để phát ngược.
- \`keyframes\`: keyframe cho bất kỳ thông số nào, theo đơn vị của Premiere: \`{ "property": "Opacity", "points": [{ "sec": 0, "value": 0 }, { "sec": 1, "value": 100 }], "interpolation": "ease" }\`. \`property\` là \`Scale\` (100 = 100%), \`Scale Width\` / \`Scale Height\` (chỉ chiều rộng hoặc cao, để nhún bẹt ra/dài ra; tự tắt Uniform Scale), \`Position\` (\`[0.5, 0.5]\` = giữa), \`Rotation\`, \`Opacity\`, \`Level\` hoặc \`"<Hiệu ứng>/<Thông số>"\`. \`sec\` tính từ đầu clip, thêm \`fromEnd: true\` để tính lùi từ cuối clip.
- \`anchor\`: điểm xoay và co giãn, tính theo chính ảnh đó: \`[0.5, 0.5]\` = giữa, \`[0.5, 1]\` = giữa cạnh dưới (chân nhân vật), cán búa thì là chỗ tay cầm. Ảnh không bị dời trên màn hình. Đặt \`anchor\` trước khi keyframe \`Rotation\` / \`Scale\`; sau đó \`Position\` là vị trí của chính điểm đó.
- Không đổi được nội dung caption.
\`\`\`timeline-action
{
  "action": "update_segment",
  "summary": "Fade out 1 giây cuối mọi clip V1",
  "tracks": ["V1"],
  "keyframes": [
    { "property": "Opacity", "points": [{ "sec": 1, "fromEnd": true, "value": 100 }, { "sec": 0, "fromEnd": true, "value": 0 }] }
  ]
}
\`\`\``;

const PREMIERE_EFFECTS_DOC = `**Thêm hiệu ứng** (\`add_effects\`):
${PICK_CLIPS_NOTE}
- \`effects\`: danh sách \`{ "name": "<tên trong bảng Effects>", "params": { "<tên thông số>": giá trị } }\`. Hiệu ứng video chỉ gắn vào clip video, hiệu ứng âm thanh (DeNoise, Reverb...) chỉ gắn vào clip audio.
- Chỉnh màu dùng \`Lumetri Color\` (Exposure, Contrast, Highlights, Shadows, Temperature, Tint, Saturation, Vibrance).
\`\`\`timeline-action
{
  "action": "add_effects",
  "summary": "Làm mờ clip đang chọn",
  "selected": true,
  "effects": [{ "name": "Gaussian Blur", "params": { "Blurriness": 30 } }]
}
\`\`\``;

const PREMIERE_TRANSITIONS_DOC = `**Thêm chuyển cảnh** (\`add_transitions\`):
- Điểm chuyển cảnh là chỗ hai clip nằm sát nhau trên cùng track. Chọn bằng \`atSec\` (danh sách thời điểm cắt), \`between\` (cặp id \`[["a", "b"]]\`), \`clips\` (hai đầu của các clip này, \`edge\`: \`start\` / \`end\` để chọn một đầu), \`tracks\`, \`fromSec\` / \`toSec\` hoặc \`all: true\`. Không truyền \`tracks\` thì chỉ tính các video track.
- Đầu clip giáp khoảng trống là fade từ / về màu đen: chỉ được thêm khi \`clips\` có clip đó hoặc \`fades: true\`.
- \`transition\` (mặc định \`Cross Dissolve\`; ví dụ \`Dip to Black\`, \`Film Dissolve\`, \`Push\`), \`audioTransition\` cho audio track (mặc định \`Constant Power\`), \`durationSec\` (mặc định 0.5).
\`\`\`timeline-action
{
  "action": "add_transitions",
  "summary": "Dissolve ở 2 điểm cắt",
  "atSec": [12.5, 30],
  "transition": "Cross Dissolve",
  "durationSec": 0.5
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

const PREMIERE_TOOLS_NOTE = `### Thêm cho Premiere Pro
- \`update_clip\`, \`add_effects\` chọn được một clip (\`segmentId\` / \`clips\`), cả track (\`tracks\`), một khoảng (\`fromSec\`/\`toSec\`), clip người dùng đang chọn (\`selected: true\`) hoặc tất cả (\`all: true\`). Làm đúng phạm vi người dùng nói: "clip này" là một clip, "tất cả" mới là \`all\`.
- \`add_transitions\` chọn điểm cắt bằng \`atSec\`, \`between\`, \`clips\`, \`tracks\` hoặc \`all\`. Chỉ thêm ở những điểm người dùng muốn.
- \`update_clip\` có thêm \`speed\`, \`reverse\` và \`keyframes\` (mọi thông số, kể cả của hiệu ứng: \`"Gaussian Blur/Blurriness"\`).
- \`add_text\` dùng Motion Graphics Template (\`template\`, mặc định \`Basic Title\`); phụ đề thì dùng \`template: "captions"\`.
- Tên hiệu ứng / chuyển cảnh / thông số sai thì kết quả tool sẽ gợi ý tên gần đúng; dùng tên đó gọi lại.`;

/** What GetTimelineSnapshot (ppro/ai-edit.ts) returns for the active sequence. */
export interface PremiereTimelineSnapshot {
  name: string;
  fps: number;
  width?: number;
  height?: number;
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
      speed?: number;
      effects?: string[];
      selected?: boolean;
      path?: string;
    }>;
  }>;
  markers: Array<{ atSec: number; color: string; name: string; durationSec: number }>;
}

function premiereTimelineSummary(snapshot: PremiereTimelineSnapshot): string {
  const tracks = (snapshot.tracks ?? []).map((tr) => ({
    label: `${tr.trackType === "video" ? "V" : "A"}${tr.index}`,
    count: (tr.clips ?? []).length,
  }));
  return timelineBrief(snapshot.fps, snapshot.durationSec, tracks, (snapshot.markers ?? []).length);
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
      ? `${toolsSection("Premiere Pro")}\n\n${PREMIERE_TOOLS_NOTE}`
      : actionsSection([
          `${STORYBOARD_DOC}\n${PREMIERE_STORYBOARD_NOTE}`,
          PREMIERE_MARKER_DOC,
          PREMIERE_ADD_TEXT_DOC,
          PREMIERE_UPDATE_DOC,
          PREMIERE_EFFECTS_DOC,
          PREMIERE_TRANSITIONS_DOC,
          PREMIERE_DELETE_DOC,
          SPLIT_DOC,
          REMOVE_RANGES_DOC,
        ]),
    ...userAndMemorySections(userSystemPrompt, workspaceInfo),
  ].join("\n\n");
}
