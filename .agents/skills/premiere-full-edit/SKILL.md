---
name: premiere-full-edit
description: Dựng video 2D kể chuyện / giải thích ghép lớp (nhân vật PNG trên bối cảnh) hoàn toàn trên timeline Premiere Pro theo plan/SHOT_PLAN.md của skill story-planning, mọi lớp là clip sửa tay được. Muốn ra thẳng file MP4 thì dùng remotion-full-video; có shot engine remotion thì dùng remotion-premiere-hybrid.
---
# Dựng Trên Premiere Pro theo Shot Plan (`premiere-full-edit`)

Skill này **chỉ dựng**. Mọi quyết định kể bằng hình (cụm ý, shot, ai ở chỗ nào, chữ, Host) đã nằm trong `plan/SHOT_PLAN.md`.

**Bắt đầu:** `get_project_context`, rồi `read_plan(name: "SHOT_PLAN.md")`.
- Chưa có plan, hoặc plan chưa có mục **Bố cục**: `read_skill("story-planning")` và làm skill đó trước. Không tự chia kịch bản ở đây.
- Dựng đúng plan; thấy plan sai hay thiếu thì sửa plan (`save_plan`) rồi mới dựng, không lặng lẽ dựng khác plan.
- **Không thêm** những gì plan không có: Host, chữ, bảng tên, hiệu ứng, chuyển cảnh, SFX.

**Nguyên tắc:** dựng **một cụm** (hoặc một shot dài) xong thì `preview_timeline` xem ngay, sửa đúng rồi mới sang cụm sau.

---

## 1. Tính vị trí từ mục Bố cục

Sequence `1920x1080` (khác thì thay số). Với mỗi (ảnh, chỗ): ảnh canvas `W x H`, `figure y1-y2`, `feet fx,fy`; chỗ có chân tại `(gx, gy)`, cao `t`:
- `zoom = t * 1080 / ((y2 - y1) * H)`
- `px = gx - (fx - 0.5) * W * zoom / 1920`, `py = gy - (fy - 0.5) * H * zoom / 1080`
- `panX = 2*px - 1`, `panY = 1 - 2*py` (pan Y dương là **lên**, ngược với `y` của ảnh)
- Đặt bằng `effect: { zoom, panX, panY }` trong `build_storyboard`.
- Công thức giả định Premiere đặt ảnh ở 100% kích thước gốc (không bật Scale to Frame Size); `preview_timeline` sẽ cho thấy nếu không đúng.
- Nhân vật cần lật hướng mặt: `add_effects` `"Horizontal Flip"`.

Bối cảnh: không `effect`, không keyframe, trừ khi shot ghi rõ.

## 2. Thứ tự lớp

| Track | Lớp |
| :---: | :--- |
| `V1` | Bối cảnh `bg_*` (`mode: "replace"` hoặc `"append"`, `targetVideoTrack: 1`) |
| `V2` | Nhân vật / vật ở phía sau (đứng xa, ảnh trong màn hình, con ngựa được cưỡi) |
| `V3` | Nhân vật chính (đổi pose: các ảnh nối tiếp, **cùng** `effect`) |
| `V4` | Đạo cụ rời, tiền cảnh che (`fg_*` nằm trên nên che nửa người dưới) |
| `V5` | Khung chữ / khói / lửa PNG, nếu shot có |
| `V6` | Chữ `.mogrt`, nếu shot có (`add_text`, `track: "V6"`) |
| `A2+` | SFX, nhạc: item âm thanh `{ path, start }` trong `build_storyboard`, tự vào track trống, không đè voice |

## 3. Dựng từng cụm và nhìn lại

1. Một `apply_actions` cho cụm: các `build_storyboard` theo thứ tự `V1` đến `V5` (`mode: "overlay"`, `targetVideoTrack` đúng lớp), rồi `add_text` nếu có.
   - **Mọi ảnh tĩnh có `start` và `end`**, lấy từ cột mốc của shot.
   - Ranh giới shot là mốc chung: mọi lớp của shot cũ kết thúc đúng ở đó.
2. **Đọc kết quả.** `overlay` đặt vào track trống **đầu tiên từ target trở lên**, nên một lớp có thể bị đẩy lên track khác. Đọc dòng kết quả, hoặc `get_timeline(fromSec, toSec)` của cụm; lớp nào sai thứ tự (nhân vật nằm trên `fg_*`) thì xóa và đặt lại.
3. **Chữ** (chỉ những chữ plan có): `.mogrt` nằm ở chỗ của template, nên `update_clip` clip chữ bằng `panX/panY/zoom` của vùng chữ trong Bố cục. Khung `V5` và chữ `V6` dùng cùng vị trí, cùng `start/end`, cùng keyframe.
4. **Nhìn:** `preview_timeline(atSec: [1 đến 3 mốc trong cụm], grid: true)`, mở sheet (và frame lẻ khi cần soi kỹ). Kiểm:
   - điều cột "Người xem phải THẤY" có thấy rõ ngay không;
   - chân trên đường đất, không lơ lửng / lún (đọc `y` trên lưới); cỡ người hợp chỗ gần / xa;
   - không gì bị cắt mép; tiền cảnh che đúng; chữ gọn trong khung, không che mặt;
   - hướng mặt và phía đứng đúng quy ước của plan.
5. Sai thì `update_clip` sửa theo số đọc trên lưới và xem lại. Lỗi do plan (hình không cho thấy điều cần thấy) thì sửa plan trước. Ghi lỗi còn lại vào mục "Lỗi thấy khi kiểm".

## 4. Chuyển động, chuyển cảnh, hiệu ứng (chỉ những gì plan ghi)

`get_timeline` (chỉ đoạn / track cần) lấy `segmentId`, rồi `apply_actions`.

**Keyframe:**
- `sec` tính **từ đầu clip**: lấy mốc trong plan trừ `startSec` của clip.
- `Position`: 0 đến 1, `[0.5, 0.5]` là giữa, **y dương là xuống**.
- Đặt `anchor: [fx, fy]` (chân) **trước**, thì `Position` chính là chỗ chân: điểm cuối chuyển động là `(gx, gy)` của chỗ đứng. Đặt anchor không làm ảnh nhảy.

Cách làm các diễn biến thường gặp, khi shot cần:

| Diễn biến | `update_clip` (sau `anchor: [fx, fy]`) |
| :--- | :--- |
| Bước vào từ phải | `Position` `[1.2, gy]` (sec 0) đến `[gx, gy]` (sec 0.45), `ease`; từ trái bắt đầu `[-0.2, gy]` |
| Nhô từ đáy lên | `Position` `[gx, gy + t + 0.05]` đến `[gx, gy]` trong 0.25 giây, `ease` |
| Ngã tại chỗ | `Rotation` 0 đến -90 (hoặc 90) trong 0.2 giây, `ease` (quanh chân) |
| Bị đánh văng | `anchor: [0.5, 0.5]`, `Position` ra ngoài khung trong 0.3 giây + `Rotation` 0 đến -720 `linear` |
| Nhún khi nói / đi | `Scale Height` 100, 94, 103, 100 và `Scale Width` 100, 105, 98, 100 tại sec 0, 0.12, 0.24, 0.36 (tự tắt Uniform Scale) |
| Hồn lìa khỏi xác | clip ở track trên, `opacity: 55`, `Position` từ `[gx, gy]` lên `[gx - 0.15, gy - 0.25]` trong 0.8 giây |
| Chữ / khung bung ra | cả khung và chữ: `Scale` 60%, 105%, 100% **của zoom đang dùng** tại sec 0, 0.15, 0.22 |
| Zoom vào chi tiết | `zoom`/`zoomEnd`, `panX`/`panXEnd` **giống nhau trên mọi lớp** của shot |

- **Biến hình:** hai ảnh trước / sau nối sát trên cùng track, cùng `effect`, tại mốc `t`; `add_transitions(atSec: [t], tracks: ["V3"], transition: "Cross Dissolve", durationSec: 0.35)`; nếu plan có khói thì `fg_khoi_*` ở `V5` từ `t - 0.15` đến `t + 0.25`, `Scale` 50 đến 140, `Opacity` 100 đến 0.
- **Chuyển cảnh:** mặc định cắt thẳng. Plan ghi chuyển cảnh thì áp lên **mọi** track hình tại mốc đó (`tracks: ["V1","V2","V3","V4","V5","V6"]`), vì chỉ `V1` thì nền đi mà nhân vật đứng lại. `Dip to Black` / `Dip to White` / `Cross Dissolve`; không `Push` từng lớp.
- **Hiệu ứng:** mù / choáng / hồi tưởng: `add_effects` `"Gaussian Blur"` lên các clip của shot, keyframe `"Gaussian Blur/Blurriness"` 0 đến 45.
- **Âm thanh:** nhạc nền (nếu plan có) `volume: 0.15` đến `0.2`; fade cuối `add_transitions(clips: [id nhạc], edge: "end", fades: true, audioTransition: "Constant Power", durationSec: 1.5)`.

## 5. Kiểm tra cuối

`preview_timeline(frames: 12)` cả timeline, và `atSec` hai bên mỗi chỗ đổi cảnh. Báo cáo ngắn: đã dựng gì, đường dẫn sheet, lỗi còn lại (đã ghi vào plan), phần chưa kiểm được (chưa nghe voice cùng hình).
