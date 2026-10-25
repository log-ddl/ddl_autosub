---
name: remotion-full-video
description: Dựng trọn video 2D kể chuyện / giải thích ghép lớp (nhân vật PNG trên bối cảnh) bằng code Remotion theo plan/SHOT_PLAN.md của skill story-planning và xuất thẳng file MP4. Muốn mọi lớp là clip sửa tay trên Premiere thì dùng premiere-full-edit; trục chính trên Premiere, chỉ vài shot Remotion thì dùng remotion-premiere-hybrid.
---
# Dựng Bằng Remotion theo Shot Plan (`remotion-full-video`)

Skill này **chỉ dựng**. Mọi quyết định kể bằng hình đã nằm trong `plan/SHOT_PLAN.md`.

> **Đọc skill `remotion-motion` trước khi viết code:** thư viện có trong kit (`@remotion/transitions`, `@remotion/google-fonts`, `@remotion/layout-utils`, `@remotion/media-utils`, `@remotion/sfx`...) và quy tắc. Không tự chạy `npm`, `npx`, hay `remotion` CLI.

**Bắt đầu:** `get_project_context`, rồi `read_plan(name: "SHOT_PLAN.md")`.
- Chưa có plan, hoặc plan chưa có mục **Bố cục**: `read_skill("story-planning")` và làm skill đó trước. Không tự chia kịch bản ở đây.
- Video dài (khoảng 4 phút trở lên): đi theo `read_skill("long-video")`; skill này chỉ dựng từng chương (mục cuối "Khi làm theo chương").
- Dựng đúng plan; thấy plan sai thì sửa plan (`save_plan`) rồi mới dựng.
- **Không thêm** những gì plan không có: Host, chữ, bảng tên, hiệu ứng, chuyển cảnh, SFX.

**Nguyên tắc:** viết xong **một cụm** thì `preview_motion` xem ngay, sửa rồi mới viết cụm sau.

---

## 1. Chuẩn bị project

1. Chép `templates/motion-graphics/remotion-starter` sang `motion-graphics/<slug>`.
2. Chép ảnh, voice, nhạc, SFX vào `motion-graphics/<slug>/public/` (gọi bằng `staticFile(...)`).
3. **Độ dài theo voice, không để số cứng:** trong `Root.tsx` dùng `calculateMetadata` với `getAudioDurationInSeconds(staticFile("voice.wav"))` (`@remotion/media-utils`), `durationInFrames = Math.ceil(giây * fps)`. Starter để sẵn `durationInFrames={150}`, phải thay.

## 2. Bố cục bằng dữ liệu, chép từ mục Bố cục của plan

- `src/assets.ts`: mỗi ảnh `{ src, w, h, box: [x1, y1, x2, y2], feet: [fx, fy] }`, đúng số `list_media`.
- `src/layout.ts`: mỗi bg `{ slots: { "near-left": { x, y, t }, ... }, text: {...} }`.
- `src/cues.ts`: mốc của shot và của từ then chốt (giây, từ plan), đổi ra frame một chỗ; cảnh nào cũng lấy mốc từ đây, không gõ số frame rải rác.
- `<Puppet asset slot>` tự tính:
  - `scale = t * 1080 / ((y2 - y1) * h)`, ảnh rộng `w * scale`;
  - `left = x*1920 - fx*w*scale`, `top = y*1080 - fy*h*scale`;
  - `transformOrigin: "${fx*100}% ${fy*100}%"` (xoay, co giãn quanh chân);
  - `flip` thì `scaleX(-1)`.
- Nhờ vậy nhân vật đứng đúng đất ngay từ đầu, đổi pose giữ chỗ vì cùng `slot`.

## 3. Component, dùng khi shot cần

- **`<StageCamera>`:** bao bối cảnh và mọi lớp của shot, nên zoom / pan / rung áp lên tất cả cùng lúc. Mặc định **đứng yên**. Zoom (`interpolate` 1 đến 1.35, `Easing.inOut(Easing.cubic)`) chỉ khi shot ghi rõ. Rung khi trúng đòn: cộng `Math.sin((frame - hitFrame) * 1.8) * 12` vào translate trong 6 đến 8 frame.
- **`<Puppet>`:**
  - Đổi pose: `poses: [{ fromFrame, src }]`, cùng `slot`.
  - Bước vào / ra: nội suy `x` từ ngoài khung tới `slot.x` trong 10 đến 18 frame, `Easing.out(Easing.cubic)`.
  - Nhô lên: từ dưới đáy lên trong 8 frame, `Easing.out(Easing.back(1.4))`.
  - Đi bộ / cưỡi ngựa: `offsetY = -Math.abs(Math.sin((frame - f1) * 0.45)) * 12`, nghiêng `Math.sin((frame - f1) * 0.45) * 3` độ.
  - Ngã: `rotate` 0 đến -90 trong 6 frame (quanh chân). Bị đánh văng: bay chéo ra ngoài + `rotate` 720 trong 8 frame.
  - Hồn lìa khỏi xác: thêm một `<Puppet>` cùng ảnh, `opacity 0.55`, bay lên rồi trượt ngang.
- **`<SmokeMorph>`:** từ `morphFrame - 4` đến `morphFrame + 8` lớp khói phóng `0.4` đến `1.35` rồi mờ dần; đổi ảnh đúng `morphFrame` (không khói thì cross-fade 6 frame).
- **Chữ** (chỉ chữ plan có): đặt ở vùng `text` của layout; vào nhanh (5 frame), đủ lâu để đọc, ra khi hết vai trò; `@remotion/google-fonts`, `fitText` của `@remotion/layout-utils` để không tràn khung.
- **Shot và chuyển cảnh:** mỗi cụm một component, ráp bằng `<Series>`; mặc định cắt thẳng. Plan ghi chuyển cảnh thì `<TransitionSeries>` (`fade()`, `slide()`), áp lên cả shot.
- **Âm thanh:** voice ở gốc composition; nhạc nền (nếu plan có) `volume={0.16}`; mỗi SFX plan ghi một `<Sequence from={cue}>`.

## 4. Viết xong một cụm thì xem ngay

`preview_motion(project: "<slug>", atSec: [1 đến 3 mốc trong cụm])`, mở sheet và kiểm:
- điều cột "Người xem phải THẤY" có thấy rõ ngay không;
- chân trên đất, không lơ lửng / lún; cỡ người hợp chỗ gần / xa;
- không gì bị cắt mép; tiền cảnh che đúng; chữ gọn trong khung, không che mặt;
- hướng mặt và phía đứng đúng quy ước của plan.

Sai vị trí thì sửa **số trong `layout.ts`** (không vá riêng một chỗ trong cảnh). Lỗi do plan thì sửa plan trước. Ghi lỗi còn lại vào mục "Lỗi thấy khi kiểm" của plan.

## 5. Xem toàn bộ và render

1. `preview_motion(project: "<slug>", frames: 12)` cả video, và `atSec` hai bên mỗi chỗ đổi cảnh.
2. `render_motion(project: "<slug>", transparent: false, output: "<ten-video>")`: `output` **không có đuôi**, tool tự thêm `.mp4`.
3. Báo người dùng đường dẫn file và sheet, lỗi còn lại, phần chưa kiểm được.

## Khi làm theo chương (`long-video`)

- Plan là `ch<NN>.md` của chương, mục **Bố cục** nằm trong `STORY.md`. Mốc là giây toàn phim.
- Một project chung cho cả phim (`assets.ts`, `layout.ts`, các component dùng chung), mỗi chương một composition `Ch<NN>` có độ dài đúng bằng chương; voice phát từ giây đầu chương (`trimBefore` của `<Audio>`). Ranh giới chương đặt ở chỗ cắt thẳng (`STORY.md` đã chọn vậy).
- Viết phần dùng chung trước (bạn tự làm), rồi mỗi chương một `motion-builder` song song: viết `Ch<NN>`, xem từng cụm theo mục 4, rồi `render_motion(composition: "Ch<NN>", transparent: false, output: "ch<NN>", wait: false)`.
- Khi mọi chương đã render (`render_status`), đặt các file `ch<NN>.mp4` nối nhau trên timeline bằng `build_storyboard` (mỗi file ở đúng giây đầu chương), rồi `preview_timeline` hai bên mỗi ranh giới chương.
