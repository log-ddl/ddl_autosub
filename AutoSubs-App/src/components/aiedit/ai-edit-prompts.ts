import type { WorkspaceInfo } from "@/api/cli-chat-api";
import type { CapCutTimelineSnapshot } from "@/api/capcut-api";

// System prompts for AI Edit. A conversation is bound to one editor for its
// whole life, so DaVinci and CapCut each get their own prompt that only
// describes the context and timeline-action commands that editor supports.

function intro(editorName: string): string {
  return `Bạn là AI Video Director tích hợp trực tiếp bên trong ứng dụng AutoSubs.
Trình dựng phim đích hiện đang kết nối: **${editorName}**.`;
}

function workspaceSection(workspaceInfo: WorkspaceInfo | null): string[] {
  const parts: string[] = [];
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
  return parts;
}

const RULES_HEADER = `### Quy tắc thực thi lệnh dựng phim TỨC THÌ lên Timeline (KHÔNG ĐỌC SOURCE CODE CỦA APP):
⚠️ **QUY TẮC TỐC ĐỘ TỐI QUAN TRỌNG**:
- **TUYỆT ĐỐI KHÔNG** chạy \`grep\`, \`find\`, hay \`view_file\` vào mã nguồn của ứng dụng AutoSubs (\`use-ai-edit-controller.ts\`, \`resolve-api.ts\`, \`autosubs_core.lua\`, \`capcut_bridge.rs\`, \`target/\`, \`node_modules/\`...).
- Mọi tham số của \`timeline-action\` đã được định nghĩa ĐẦY ĐỦ 100% ngay bên dưới. Khi người dùng yêu cầu import, cắt ghép đoạn video, chèn A-roll/B-roll, thêm nhạc/SFX, hoặc chỉnh keyframe, hãy tính toán thông số và **phát ra khối \`\`\`timeline-action NGAY LẬP TỨC trong 1 bước duy nhất**!`;

const STORYBOARD_DOC = `**Import, Cắt ghép (Cut/Split), Thay thế, Chèn xen giữa, hoặc Đè B-Roll / Motion Graphic / Audio lên Timeline** (\`build_storyboard\` — hoạt động cho cả **DaVinci Resolve** và **CapCut**):
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
\`\`\``;

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

// Turbo runs give the agent the AutoSubs MCP tools, so the prompt only says
// how to use them; the tool schemas carry the parameters and editor limits.
function toolsSection(editorName: string): string {
  return `### Công cụ dựng phim (MCP server \`autosubs\`)
Bạn có các tool của MCP server \`autosubs\` để thao tác trực tiếp lên timeline ${editorName}: \`get_timeline\`, \`build_storyboard\`, \`add_marker\`, \`add_text\`, \`update_clip\`, \`delete_clips\`.
- Dùng các tool này thay vì viết khối \`timeline-action\`, sửa file project hay gọi cổng HTTP. KHÔNG đọc mã nguồn của ứng dụng AutoSubs.
- Thời gian luôn tính bằng giây từ đầu timeline. Cần id của clip thì gọi \`get_timeline\`.
- Mỗi tool trả về kết quả. Nếu báo lỗi hoặc chỉ làm được một phần, đọc thông báo, chỉnh tham số rồi gọi lại.
- Sau khi sửa xong, gọi \`get_timeline\` để kiểm tra lại trước khi báo cho người dùng.`;
}

// The command docs, numbered in the order this editor's prompt lists them.
function actionsSection(docs: string[]): string {
  return [RULES_HEADER, ...docs.map((doc, i) => `${i + 1}. ${doc}`)].join("\n\n");
}

function userAndMemorySections(
  userSystemPrompt: string,
  workspaceInfo: WorkspaceInfo | null,
): string[] {
  const parts: string[] = [];
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
  return parts;
}

function capcutContext(snapshot: CapCutTimelineSnapshot, useTools: boolean): string {
  const markerSummary = (snapshot.markers ?? [])
    .map(
      (m) =>
        `  - "${m.title}" tại ${m.startSec.toFixed(2)}s${m.durationSec > 0 ? ` (dài ${m.durationSec.toFixed(2)}s)` : ""}`,
    )
    .join("\n");
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

  return `### Ngữ cảnh Project CapCut hiện tại:
- Tên Project: "${snapshot.draftName}" (ID: ${snapshot.draftId})
- Thư mục Draft CapCut: "${snapshot.folderPath}"
- Đường dẫn file Timeline JSON trực tiếp: "${snapshot.jsonPath}"
- Độ phân giải: ${snapshot.canvasWidth}x${snapshot.canvasHeight} @ ${snapshot.fps}fps
- Tổng thời lượng: ${snapshot.durationSec.toFixed(2)}s
- Chi tiết các Track trên Timeline:
${trackSummary || "(Timeline hiện đang trống)"}
- Marker đang có trên Timeline:
${markerSummary || "  (Chưa có marker nào)"}${useTools ? "" : `

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
      text?: string;
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
            `  - [id="${c.id}"] "${c.name}" từ ${c.startSec.toFixed(2)}s -> ${(c.startSec + c.durationSec).toFixed(2)}s (dài ${c.durationSec.toFixed(2)}s${c.zoom != null ? `, zoom=${c.zoom.toFixed(2)}` : ""}${c.text ? `, text="${c.text}"` : ""})`,
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
        ]),
    ...userAndMemorySections(userSystemPrompt, workspaceInfo),
  ].join("\n\n");
}

export function buildEditorContextPrompt(
  integration: string,
  snapshot: CapCutTimelineSnapshot | null,
  resolveTimelineName: string | undefined,
  davinciSnapshot: DavinciTimelineSnapshot | null,
  userSystemPrompt: string,
  workspaceInfo: WorkspaceInfo | null,
  /** Turbo: the agent edits through MCP tools. Manual: it writes timeline-action blocks. */
  useTools: boolean,
): string {
  return integration === "capcut"
    ? buildCapCutPrompt(snapshot, userSystemPrompt, workspaceInfo, useTools)
    : buildDavinciPrompt(resolveTimelineName, davinciSnapshot, userSystemPrompt, workspaceInfo, useTools);
}
