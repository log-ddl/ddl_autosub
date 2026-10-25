---
name: remotion-premiere-hybrid
description: Dựng video 2D kể chuyện / giải thích ghép lớp theo plan/SHOT_PLAN.md của skill story-planning, trục chính trên Premiere Pro (bối cảnh, nhân vật, chữ, âm thanh là clip sửa tay được) và các shot plan ghi engine remotion (sơ đồ / bản đồ động, cảnh đông nhân vật có camera, biến hình nhiều lớp) làm bằng Remotion rồi đặt lên timeline. Không có shot remotion thì dùng premiere-full-edit; muốn ra thẳng MP4 thì dùng remotion-full-video.
---
# Kết Hợp Remotion + Premiere theo Shot Plan (`remotion-premiere-hybrid`)

Skill này **chỉ dựng**. Mọi quyết định kể bằng hình, kể cả shot nào làm bằng Remotion (cột Engine), đã nằm trong `plan/SHOT_PLAN.md`.

**Bắt đầu:** `get_project_context`, rồi `read_plan(name: "SHOT_PLAN.md")`.
- Chưa có plan, hoặc plan chưa có mục **Bố cục**: `read_skill("story-planning")` và làm skill đó trước. Không tự chia kịch bản ở đây.
- Video dài (khoảng 4 phút trở lên): đi theo `read_skill("long-video")`; skill này chỉ dựng từng chương (mục cuối "Khi làm theo chương").
- Dựng đúng plan; thấy plan sai thì sửa plan (`save_plan`) rồi mới dựng.
- **Không thêm** những gì plan không có: Host, chữ, bảng tên, hiệu ứng, chuyển cảnh, SFX.

**Nguyên tắc:** mỗi cụm Remotion qua `preview_motion` trước khi render; mỗi cụm trên Premiere qua `preview_timeline` trước khi sang cụm sau.

Phần Premiere làm như skill `premiere-full-edit` (`read_skill("premiere-full-edit")`): công thức vị trí từ Bố cục (mục 1), thứ tự lớp (mục 2), dựng và nhìn từng cụm (mục 3), keyframe / chuyển cảnh / hiệu ứng (mục 4). File này chỉ thêm phần Remotion và cách ghép.

---

## 1. Làm các shot `remotion` trước

Đọc skill `remotion-motion` trước khi viết code. Không tự chạy `npm`, `npx`, `remotion`.

- **Hai loại:**
  - **Overlay** đè lên cảnh Premiere (sơ đồ vẽ trên nền, khói phép thuật, chữ động): nền trong suốt (không `backgroundColor` ở `AbsoluteFill` ngoài cùng), `render_motion` với `transparent: true` (mặc định, ProRes 4444 có alpha, `.mov`).
  - **Cả cảnh** (đông nhân vật đi cùng camera): `transparent: false`, đặt ở `V1` thay bối cảnh.
- **Độ dài** composition = độ dài shot trong plan. Overlay phải khớp chỗ trong khung với bố cục của bg nó đè lên (lấy từ mục Bố cục).
- **Nhân vật trong Remotion** đặt bằng số đo và chỗ đứng của plan, như `<Puppet>` của `remotion-full-video` (mục 2), để khớp với các shot Premiere kề bên.
- **Một project dùng nhiều lần bằng `props`**, ví dụ khung chữ: `defaultProps: { text: "..." }`; `preview_motion(props: { text: "<chữ dài nhất>" }, atSec: [...])` để chắc chữ dài nhất vẫn vừa; rồi `render_motion(props: { text: "<CHỮ>" }, output: "label-<slug>")` cho từng chữ.
- `output` là tên **không có đuôi** (tool tự thêm `.mov` / `.mp4`); mỗi lần render trả một id `mXX`.
- Luôn `preview_motion` (mở sheet, kiểm như mục 3 của `premiere-full-edit`) trước `render_motion`.

## 2. Ghép lên Premiere

| Track | Lớp |
| :---: | :--- |
| `V1` | Bối cảnh `bg_*`, hoặc shot Remotion cả cảnh |
| `V2` | Nhân vật / vật phía sau |
| `V3` | Nhân vật chính |
| `V4` | Đạo cụ, tiền cảnh che |
| `V5` | Overlay Remotion `.mov` có alpha (không `effect`: đã đúng khung 1920x1080) |
| `V6` | Chữ `.mogrt`, nếu plan có |
| `A1` / `A2+` | Voice / SFX, nhạc (`{ path, start }` trong `items`, tự vào track trống) |

Dựng từng cụm theo mục 3 của `premiere-full-edit`:
- mọi ảnh tĩnh có `start` và `end`;
- đọc kết quả để chắc lớp không bị đẩy sai track;
- `preview_timeline(atSec, grid: true)` từng cụm, kiểm thêm overlay Remotion có khớp chỗ với bối cảnh và nhân vật Premiere bên dưới không.

## 3. Kiểm tra cuối

`preview_timeline(frames: 12)` cả timeline, và `atSec` hai bên mỗi chỗ đổi cảnh, nhất là chỗ nối giữa shot Premiere và shot Remotion (nhân vật có nhảy chỗ, đổi cỡ không). Báo cáo ngắn: đã dựng gì, đường dẫn sheet, lỗi còn lại (đã ghi vào plan), phần chưa kiểm được.

## Khi làm theo chương (`long-video`)

- Plan là `ch<NN>.md` của chương, mục **Bố cục** nằm trong `STORY.md` (thay cho `SHOT_PLAN.md`). Mốc là giây toàn phim.
- **Mục 1** (shot `remotion`): mỗi shot một `motion-builder`, chạy song song; project và `output` có số chương (`ch03-<slug>`); render bằng `render_motion(wait: false)`.
- **Mục 2**: mỗi `chapter-builder` ghép chương của nó; shot Remotion chưa xong thì `render_status(ids, waitSec)` chờ rồi mới đặt.
- **Mục 3** cho chương do `chapter-builder` làm (cộng hai bên ranh giới với chương trước); cho cả phim do agent chính làm ở cuối.
