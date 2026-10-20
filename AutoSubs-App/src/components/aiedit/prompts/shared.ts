import type { WorkspaceInfo } from "@/api/cli-chat-api";

// Prompt sections every editor shares. A conversation is bound to one editor
// for its whole life; each editor's own file (davinci.ts, capcut.ts) builds
// its prompt from these plus the context and commands only it supports.

export function intro(editorName: string): string {
  return `Bạn là AI Video Director tích hợp trực tiếp bên trong ứng dụng AutoSubs.
Trình dựng phim đích hiện đang kết nối: **${editorName}**.`;
}

export function workspaceSection(workspaceInfo: WorkspaceInfo | null): string[] {
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
   - \`${workspaceInfo.exportsDir}\`: Nơi xuất các file video thành phẩm (\`.mp4\`, \`.mov\`) đã render xong để đẩy vào Timeline của trình dựng đang kết nối.
   - \`${workspaceInfo.path}/visual-plan.json\`: File lưu kịch bản phân cảnh Visual Plan của dự án.
2. **Kho mẫu Motion Graphic dùng chung (Global Templates)**: \`${workspaceInfo.templatesDir}\`
3. **Danh sách Assets hiện có trong Project**:
${assetSummary}`,
    );
  }
  return parts;
}

export const RULES_HEADER = `### Quy tắc thực thi lệnh dựng phim TỨC THÌ lên Timeline (KHÔNG ĐỌC SOURCE CODE CỦA APP):
⚠️ **QUY TẮC TỐC ĐỘ TỐI QUAN TRỌNG**:
- **TUYỆT ĐỐI KHÔNG** chạy \`grep\`, \`find\`, hay \`view_file\` vào mã nguồn của ứng dụng AutoSubs (\`use-ai-edit-controller.ts\`, \`resolve-api.ts\`, \`autosubs_core.lua\`, \`capcut_bridge.rs\`, \`target/\`, \`node_modules/\`...).
- Mọi tham số của \`timeline-action\` đã được định nghĩa ĐẦY ĐỦ 100% ngay bên dưới. Khi người dùng yêu cầu import, cắt ghép đoạn video, chèn A-roll/B-roll, thêm nhạc/SFX, hoặc chỉnh keyframe, hãy tính toán thông số và **phát ra khối \`\`\`timeline-action NGAY LẬP TỨC trong 1 bước duy nhất**!`;

export const STORYBOARD_DOC = `**Import, Cắt ghép (Cut/Split), Thay thế, Chèn xen giữa, hoặc Đè B-Roll / Motion Graphic / Audio lên Timeline** (\`build_storyboard\`, dùng được với mọi trình dựng; giới hạn riêng của trình dựng, nếu có, ghi ở cuối mục):
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

// Turbo runs give the agent the AutoSubs MCP tools, so the prompt only says
// how to use them; the tool schemas carry the parameters and editor limits.
export function toolsSection(editorName: string): string {
  return `### Công cụ dựng phim (MCP server \`autosubs\`)
Bạn có các tool của MCP server \`autosubs\` để thao tác trực tiếp lên timeline ${editorName}: \`get_timeline\`, \`build_storyboard\`, \`add_marker\`, \`add_text\`, \`update_clip\`, \`delete_clips\`.
- Dùng các tool này thay vì viết khối \`timeline-action\`, sửa file project hay gọi cổng HTTP. KHÔNG đọc mã nguồn của ứng dụng AutoSubs.
- Thời gian luôn tính bằng giây từ đầu timeline. Cần id của clip thì gọi \`get_timeline\`.
- Mỗi tool trả về kết quả. Nếu báo lỗi hoặc chỉ làm được một phần, đọc thông báo, chỉnh tham số rồi gọi lại.
- Kết quả tool đã cho biết đặt/sửa được bao nhiêu. KHÔNG gọi lại \`get_timeline\` chỉ để kiểm tra; chỉ gọi khi tool báo lỗi, chỉ làm được một phần, hoặc cần id clip mới cho bước sửa tiếp theo.`;
}

// The command docs, numbered in the order this editor's prompt lists them.
export function actionsSection(docs: string[]): string {
  return [RULES_HEADER, ...docs.map((doc, i) => `${i + 1}. ${doc}`)].join("\n\n");
}

export function userAndMemorySections(
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
