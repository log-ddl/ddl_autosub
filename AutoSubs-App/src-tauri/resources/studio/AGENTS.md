<!-- Written by AutoSubs. -->
# Luật chung cho AI

Đây là Video Studio của AutoSubs: dựng video bằng code Remotion. Khung thư mục và cách dùng các tool ở `README.md`.
AutoSubs ghi file này; muốn tự viết luật riêng thì xoá dòng đầu, app sẽ không ghi đè nữa.

- Tạo dự án chỉ bằng `core/tools/new.py`; đưa file vào bằng `core/tools/ingest.py`.
- Làm video: đọc skill ghi trong `projects/<id>/project.json` (`skills/<tên>/SKILL.md`). Các skill người dùng đã nạp
  nằm ở `skills/` (cũng có trong `.claude/skills`, `.agents/skills`). Chưa có skill nào thì hỏi người dùng muốn làm gì.
- Mỗi tầng một việc, đừng trộn:
  - `remotion/` chỉ Remotion. Không viết code vào đây. Tài liệu đúng bản: `remotion/docs/`.
  - `core/` phần chung mọi chủ đề, do AutoSubs cập nhật (sửa ở đây sẽ mất khi app cập nhật).
  - `skills/<tên>/` mọi thứ của một chủ đề: SKILL.md, templates, `lib/` (`@skill/<tên>/…`), CATALOG.md.
  - `projects/<id>/` chỉ một video; không đọc hay chép code dự án khác.
- Không sửa file máy sinh: `.build/`, `plan/timeline.json`, `src/cues/index.ts`, `out/`.
- Không sửa, không xoá tài sản `locked: true` trong `assets/ASSETS.json`.
- Thêm / đổi skill xong chạy `.venv/bin/python core/tools/setup.py` (link vào `.claude/skills`, `.agents/skills`, cập nhật alias).
- Chạy mọi tool bằng `.venv/bin/python` (đã có numpy, whisper). Lệnh `python3 core/tools/…` trong skill cũng chạy được như vậy.
  `ffmpeg` / `ffprobe` thiếu trên máy thì dùng bản trong `.bin/`.
- Người dùng xem video bằng nút Preview của AI Edit trong AutoSubs (Remotion Studio của dự án); không cần tự mở Studio.

# Dựng trên Premiere (MCP server `autosubs-app`)

Việc với Premiere là phần riêng, chạy song song với Video Studio ở trên:
- Mọi thao tác timeline, tìm, tải và phân tích media đi qua MCP server `autosubs-app`. Tool làm việc trên project
  Premiere đang mở trong AutoSubs và lưu file vào thư mục của project đó, link ở `project/` (media trong `project/media`,
  contact sheet trong `project/analysis`, kế hoạch trong `project/plan`).
- Bắt đầu bằng `get_project_context` để biết project, ghi nhớ của nó và các skill có sẵn.
- Không tự cắt hay mã hoá lại video: đặt đoạn cần dùng bằng `build_storyboard` với `srcIn`/`srcOut`, Premiere tự cắt.
- Tool báo AutoSubs chưa kết nối thì nhờ người dùng mở AutoSubs và project Premiere.
