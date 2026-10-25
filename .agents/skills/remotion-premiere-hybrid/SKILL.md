---
name: remotion-premiere-hybrid
description: Skill dựng duy nhất cho video 2D kể chuyện / giải thích ghép lớp (OverSimplified) theo plan/SHOT_PLAN.md (hoặc plan/ch<NN>.md) của skill story-planning — trục chính ghép lớp trực tiếp trên timeline Premiere Pro (bối cảnh, nhân vật, đạo cụ, âm thanh sửa tay được) kết hợp các đại cảnh tính toán động bằng Remotion. Tự chủ 100%, không cần đọc thêm premiere-full-edit hay remotion-full-video.
---
# Dựng Video 2D Kết Hợp Remotion + Premiere Pro (`remotion-premiere-hybrid`)

Đây là **skill dựng duy nhất và hoàn chỉnh** sau bước `story-planning`. Mọi quyết định kể chuyện bằng hình, danh sách ảnh, bảng `Scale Tier`, vùng đứng `Zones` và cột `Engine` (`premiere` hay `remotion`) đều đã nằm trong `plan/SHOT_PLAN.md` (hoặc `plan/STORY.md` + `plan/ch<NN>.md` đối với video dài). Skill này **tự chủ 100%**.

**Bắt đầu:**
0. Video dài (khoảng 4 phút trở lên): đi theo `read_skill("long-video")`; skill này dựng từng chương ngắn ~2 phút theo mục cuối **"Khi làm theo chương"**.
1. Gọi `get_project_context`, rồi `read_plan` và `get_timeline()` để kiểm tra kích thước Sequence (`1920x1080`) và **FPS thực tế của Sequence** trên Premiere Pro (`30 fps`).
2. Nếu plan chưa điền mục **Bố cục**: chạy phần đo ảnh (`list_media`) và xác định hướng mặt gốc + vùng đứng `Zones` của từng `bg_*` theo mục 7 của `story-planning`, lưu vào plan rồi mới dựng.
3. **Không tự ý thêm** những gì plan không có: Host, chữ, bảng tên, hiệu ứng, chuyển cảnh.

---

## 1. Đồng bộ FPS & Quy tắc Khóa Lưới Frame Tuyệt Đối (`Master Cut Grid` — Bắt buộc)

1. **Mặc định `30 fps` & Khớp thời lượng tuyệt đối tại mọi ranh giới chuyển cảnh (`Cut Alignment`):**
   - Cả Sequence Premiere Pro và `Root.tsx` của Remotion mặc định đều ở **`30 fps`** (`fps={30}`).
   - Khi tính `durationInFrames` cho Remotion: tính khít chính xác theo mốc giây của shot `Math.round((endSec - startSec) * 30)`.
   - **Bù khoảng nghỉ lấy hơi của SRT (`Shot_N.end === Shot_N+1.start`):** Tại mọi điểm cắt chuyển cảnh từ `Shot A` sang `Shot B` ở mốc giây `T`, nền `V1` của `Shot A` **BẮT BUỘC kết thúc đúng tại `end: T`**, và nền `V1` của `Shot B` **BẮT BUỘC bắt đầu đúng tại `start: T`**. Tuyệt đối không lấy `end` của câu nói trước khoảng nghỉ lấy hơi làm hở khe đen giữa 2 shot!
2. **Phân biệt rõ 2 loại thời lượng lớp (Layer Lifespan) trên `V2..V5` trong mỗi Shot:**
   - **Loại A — Lớp Trụ của cảnh (`Persistent Layer` — nhân vật đứng xuyên suốt cảnh):**
     - Nếu một nhân vật có mặt xuyên suốt từ đầu đến cuối shot (qua 2–3 câu thoại SRT liên tiếp) và không đổi file ảnh, **BẮT BUỘC đặt thành 1 clip liền mạch duy nhất từ `Shot_Start` đến `Shot_End`**. **CẤM TUYỆT ĐỐI** cắt vụn nhân vật trụ theo từng dòng SRT khiến nhân vật bị nháy biến mất 10–20 frame lúc người đọc nghỉ lấy hơi!
     - Nếu nhân vật đổi pose biểu cảm tại giây `t_change` trong cùng 1 shot, thì clip 1 là `[Shot_Start, t_change]` và clip 2 là `[t_change, Shot_End]` (`clip_1.end === clip_2.start` khít 100%, không hở 1 frame nào).
     - Khi hết shot tại `Shot_End`, mọi Lớp Trụ của shot đó **bắt buộc kết thúc đúng tại `Shot_End`**, cấm kéo lố sang shot tiếp theo.
   - **Loại B — Lớp Xuất Hiện Ngắn theo từ khóa (`Transient / Cue Layer` — chỉ hiện một chút):**
     - Như đám khói phép (`fg_smoke`), đạo cụ xuất hiện khi nhắc tên, nhân vật phụ hiện ra giải cứu rồi biến mất.
     - Chỉ đặt trong khoảng ngắn `[t_in, t_out]` cần thiết, **NHƯNG bắt buộc `Shot_Start <= t_in < t_out <= Shot_End`**. Tuyệt đối cấm để `t_out > Shot_End` làm clip của cảnh cũ thò đuôi đè lên cảnh mới!
3. **Quy tắc đặt clip theo thứ tự thời gian tăng dần & Dùng đường dẫn chuẩn chống Media Offline:**
   - Trong CEP Premiere, hàm `placeClip` tham chiếu tới clip cuối cùng trên track (`track.clips[numItems - 1]`) để trim thời lượng và gán scale. Do đó, trên mỗi track `V1..V5`, **bắt buộc đặt các clip theo đúng thứ tự thời gian tăng dần từ đầu đến cuối** (cấm chèn clip vào đầu/giữa track khi phía sau trên cùng track đã có clip; nếu cần sửa một đoạn ở giữa track, phải xóa từ điểm đó đến cuối đoạn rồi đặt lại theo thứ tự thời gian).
   - Khi truyền `path` vào `build_storyboard`, luôn dùng **Media ID (`m12`, `m51`...)** từ `list_media` hoặc **đường dẫn vật lý thật (`realpath`)**, tránh truyền qua symlink `project/` để không bao giờ bị lỗi `<OfflineReason>` (ô đỏ Media Offline).

---

## 2. Công thức Bố cục, Bảng Quy Chuẩn Kích Thước (`Scale Tier`) & Camera Dẫn Mắt

Mọi thông số lấy từ `list_media`: ảnh có kích thước gốc `W x H`, khung bao phần có hình `figure: x1-x2, y1-y2`, điểm chạm đất `feet: fx, fy`. Chỗ đứng trong plan có tọa độ chân `(gx, gy)` trên khung `1920x1080` (`0..1`, `y` dương hướng xuống) và chiều cao mục tiêu `t` (tỉ lệ so với `1080`).

### A. Bảng Quy Chuẩn Kích Thước Thực Tế (`Real-World Scale Tier`)
Tuyệt đối không dùng chung một số `t ≈ 0.38` cho mọi ảnh. Bắt buộc áp đúng `t` theo kích thước thật ngoài đời của đối tượng:
- **Tier 1 — Đạo cụ nhỏ cầm tay (`bát vàng, quạt, giấy thông quan, kinh Phật, bảo châu, côn trùng`):** **`t = 0.10 – 0.14`**. Tọa độ `(gx, gy)` phải gắn theo vị trí tay nhân vật cầm nó (`gx = gx_char ± 0.05, gy = gy_char - 0.15`), cấm đặt đạo cụ nhỏ đứng dưới đất như người!
- **Tier 2 — Nhân vật thấp / Trẻ em / Tiểu yêu (`Ngộ Không, Hồng Hài Nhi, tiểu yêu`):** **`t = 0.30 – 0.33`**.
- **Tier 3 — Người trưởng thành đứng (`Đường Tăng, Bát Giới, Sa Tăng, Nhà Vua, Quan Âm`):** **`t = 0.36 – 0.39`** (khi đứng ở hậu cảnh xa: `t = 0.26 – 0.28`).
- **Tier 4 — Người cưỡi ngựa / Phật ngồi đài sen cao / Yêu vương khổng lồ (`char_duong_tang_horse, phat_to, nguu_ma_vuong`):** **`t = 0.52 – 0.58`** (để phần thân người ngồi trên lưng ngựa/đài sen có kích thước tương đương người đứng dưới đất).
- **Tier 5 — Phương tiện lớn / Lồng sắt / Núi (`thuyền, xe, lồng nhốt hổ, lò Bát Quái, núi`):** **`t = 0.55 – 0.68`** (phải to hơn hẳn người ngồi bên trong; nếu người ngồi trên thuyền thì người và thuyền phải khóa chung tâm tọa độ di chuyển).

### B. Công thức 2 Bước Đặt Nhân Vật & Đạo Cụ trên Premiere Pro
1. **Ảnh bối cảnh (`bg_*` trên `V1`):**
   - Với ảnh `1920x1080`: `zoom: 1.0, panX: 0, panY: 0`. Với ảnh `1376x768`: **`zoom: 1.41, panX: 0, panY: 0`**.
   - **CẤM dùng `zoomEnd` / `panXEnd` riêng lẻ trên `V1` khi đang có nhân vật đứng ở `V2..V5`** (vì sẽ làm mặt đất trượt dưới chân nhân vật). Chỉ khi dùng **Virtual Camera đồng bộ cả `V1..V5`** (mục C dưới đây) thì nền và nhân vật mới cùng zoom/pan.
2. **Ảnh nhân vật & đạo cụ tách nền (`char_*`, `prop_*`, `fg_*` trên `V2..V5`):**
   - **Độ phóng (`zoom`):**
     $$\text{zoom} = \frac{t \times 1080}{(y_2 - y_1) \times H}$$
   - **Lật hướng mặt (`Horizontal Flip`) & Đạo ngược `fx`:**
     - Nếu nhân vật/đạo cụ KHÔNG lật mặt: `fx_used = fx`.
     - Nếu nhân vật/đạo cụ CÓ gắn `add_effects` `{ name: "Horizontal Flip" }`: vì hiệu ứng `Horizontal Flip` lật ảnh trước bước `Motion`, điểm neo ngang thực tế phải lấy đối xứng **`fx_used = 1.0 - fx`**.
   - **QUY TẮC 2 BƯỚC `anchor` + `Position` TRÊN PREMIERE (BẮT BUỘC):**
     1. **Bước 1 (`build_storyboard`):** Đặt clip lên track với `effect: { zoom, panX: 0, panY: 0 }` (hoặc `panX, panY` khởi tạo).
     2. **Bước 2 (`add_effects` rồi `update_clip`):**
        - Nếu cần lật mặt, gọi `add_effects(clips: [...], effects: [{ name: "Horizontal Flip" }])`.
        - Sau đó gọi `update_clip` truyền **`anchor: [fx_used, fy]`** và mảng **`keyframes`** (**TUYỆT ĐỐI KHÔNG truyền `panX` hay `panY` trong `update_clip` khi đã truyền `anchor`**).
        - Khi `anchor` đã ở `[fx_used, fy]`, tọa độ `Position` trong `keyframes` chính bằng **tọa độ màn hình `[gx, gy]` của điểm chạm đất** (ví dụ đứng trên bờ đất là `[0.24, 0.84]`).
   - **Quy tắc Cấm Chồng Keyframe (`No Keyframe Stacking`):** Chỉ gắn keyframe 1 lần trên clip mới đặt. Nếu muốn sửa lại keyframe của clip đã có keyframe, phải `delete_clips` xóa đi đặt lại rồi mới gắn.

### C. Công thức Camera Dẫn Mắt Đồng Bộ (`Virtual Camera` — Dùng ở các shot cần Zoom / Pan nhấn tâm điểm)
Khi plan chỉ định một shot có **Camera Push-in (phóng cận vào nhân vật đang nói/biểu cảm)** hoặc **Camera Pan (lia ngang từ người A sang người B)**:
- Giả sử mỗi lớp $i$ (cả nền `V1` có tâm gốc `(wx_1 = 0.5, wy_1 = 0.5)`, `baseScale_1 = 141` và các nhân vật `V2..V5` có vị trí đứng gốc trên nền `(wx_i, wy_i)`, `baseScale_i = zoom_i * 100`) được đặt trong không gian cảnh.
- Khi Camera ở trạng thái `(camZoom(t), camX(t), camY(t))` (mặc định toàn cảnh là `camZoom = 1.0, camX = 0.5, camY = 0.5`; khi phóng cận vào nhân vật ở `(0.28, 0.70)` là `camZoom = 1.40, camX = 0.28, camY = 0.65`), tại thời điểm `t`, keyframe của **mọi lớp `V1..V5`** trong shot đó được tính đồng bộ theo 3 phương trình:
  $$\text{Scale}_i(t) = \text{baseScale}_i \times \text{camZoom}(t)$$
  $$\text{PosX}_i(t) = 0.5 + (wx_i - \text{camX}(t)) \times \text{camZoom}(t)$$
  $$\text{PosY}_i(t) = 0.5 + (wy_i - \text{camY}(t)) \times \text{camZoom}(t)$$
- Nhờ 3 phương trình này, khi Camera phóng cận hay lia ngang, **chân nhân vật vẫn bám chặt 100% vào mặt đất của tấm nền `V1`**, đạo cụ vẫn bám chặt vào tay nhân vật, và mắt người xem được dẫn thẳng vào đúng tâm điểm câu chuyện!

### D. Công thức `<Puppet>` trong Remotion (khớp 1:1 với Premiere)
Trong Remotion (`1920x1080`), dùng component `<Puppet>` tính trực tiếp từ cùng bộ số `(W, H, y1, y2, fx, fy)` và `(gx, gy, t)`:
- `scale = (t * 1080) / ((y2 - y1) * H)`, `w = W * scale`, `h = H * scale`
- `left = gx * 1920 - fx * w + offsetX`, `top = gy * 1080 - fy * h + offsetY`
- `transformOrigin: "${fx * 100}% ${fy * 100}%"`

---

## 3. Hệ thống Diễn hoạt 2D Có Chọn Lọc (`Active` vs `Passive` — Chấm dứt lạm dụng nhún nhảy & Chấm dứt đầu voi đuôi chuột)

Để nhân vật có hồn, đúng ngữ cảnh câu chuyện mà **không bị nhún nhảy loạn xạ như thạch rau câu** và **không làm treo Premiere ở các video dài**, bắt buộc tuân thủ quy tắc **Đúng 1 Tâm Điểm Động (`Single Active Focus`)**:

### A. Phân loại `Active` (Được nhún / diễn) vs `Passive` (Đứng tĩnh)
1. **Các lớp `Passive` — BẮT BUỘC GIỮ TĨNH (`Uniform Scale = true`, `Rotation = 0°`):**
   - Nhân vật đang **đứng nghe / chờ đến lượt** trong lúc nhân vật khác nói: Chỉ đặt keyframe trượt vào (nếu mới xuất hiện) rồi **giữ tĩnh tại `[gx, gy]`** suốt khoảng thời gian đứng nghe.
   - Nhân vật **trang nghiêm / uy nghi** (`Phật Tổ, Quan Âm, Ngọc Hoàng, Vua ngồi ngai vàng, Đường Tăng đang chắp tay nhắm mắt niệm Phật`): **CẤM TUYỆT ĐỐI** bóp `Scale Width ≠ Scale Height` hay lắc `Rotation`. Chỉ giữ tĩnh đĩnh đạc hoặc trượt êm (`float`).
   - Đồ vật & phương tiện cứng (`thuyền, lồng sắt, ngai vàng, núi`): Giữ nguyên tỉ lệ 1:1, không co giãn.
2. **Các lớp `Active` — ĐƯỢC nhún / biến dạng đúng lúc diễn ra hành động hoặc lời nói:**
   - **Khi nhân vật đang trực tiếp phát ngôn (`Active Speaker`):**
     - Chỉ trong khoảng giây `[t_speak_start, t_speak_end]` mà nhân vật đó mở lời (hoặc tại các từ nhấn quan trọng), tạo nhịp nhấn thoại gọn gàng (**tối đa 4–8 điểm keyframe trên mỗi clip**, không rải vòng lặp 150 điểm gây treo Premiere):
       - Nhịp nhấn thoại (`Talk Beat`): `Position: [gx, gy] -> [gx, gy - 0.024] -> [gx, gy]`, `Scale Height: base_s -> base_s * 1.05 -> base_s` (giữ `Scale Width = base_s` cố định), `Rotation: 0° -> ±3° -> 0°` trong `0.28s`, sau đó nghỉ tĩnh.
   - **Khi nhân vật thực hiện hành động vật lý (`Active Physical Action`):**
     - *Bước đi / Chạy vào hoặc Thoát khỏi màn hình (`Walk / Run`):* Trong lúc `gx` di chuyển từ `gx_1` sang `gx_2`, cho `gy` nhấp nhô nhẹ `2–3 nhịp` và nghiêng `Rotation ±3°`. Ngay khi dừng lại ở `gx_2`, khóa ngay `Rotation = 0°` và đứng tĩnh! (Nếu thoát khỏi màn hình `Exit Off-Screen`: phải vượt qua `gx <= -0.25` hoặc `gx >= 1.25` trước khi hết shot `10 frames`).
     - *Nhảy bổ vào / Tiếp đất (`Jump & Land`):* Ngay tại giây chạm đất `t_land`, nén giảm chấn `1 nhịp` (`Scale Height: 0.92 * base_s, Scale Width: 1.06 * base_s` trong `0.10s` $\rightarrow$ bung `1.04 * base_s, 0.98 * base_s` trong `0.10s` $\rightarrow$ trả về **tỉ lệ chuẩn 1:1 `base_s, base_s` và đứng yên**).
     - *Tấn công / Va chạm / Trúng đòn (`Attack & Hit` tại đúng giây `t_hit`):*
       - Người đánh lao vọt tới mục tiêu tại `t_hit` (`Rotation: +25°`).
       - Người/vật trúng đòn giữ tĩnh từ `0.00s` đến đúng `t_hit`, tại `t_hit` mới rung lắc (`hit_shake`), ngã đổ ngang ra đất (`Rotation: 0° -> +86°` quanh `anchor: [fx_used, fy]`) hoặc bay văng khỏi khung hình (`anchor: [0.5, 0.5]`, `Rotation: 0° -> 720°`).
   - **Các lớp hiệu ứng tự nhiên (`fg_fire_flames, fg_smoke, fg_yellow_wind`):** Được phép co giãn nhẹ hoặc bung mở từ `Scale 0.4x -> 1.0x`.

---

## 4. Kiến Trúc Điều Phối Subagent Chuẩn (Code Remotion Song Song — Đặt Lên Premiere Tuần Tự Từng Đoạn ~2 Phút)

Để vừa đạt tốc độ cao vừa đảm bảo **không bao giờ xung đột lệnh trên Premiere, không lệch tọa độ giữa các track, và chất lượng chương cuối kỹ y hệt chương đầu**:

### Nguyên tắc Vàng về Subagent trên Premiere Pro:
1. **CẤM TUYỆT ĐỐI gọi nhiều Subagent đặt clip lên Premiere Pro cùng một lúc:**
   - Premiere Pro chỉ có 1 Sequence mở và ExtendScript xử lý đơn luồng; hàm `placeClip` luôn nối vào cuối track. Nếu 2 Subagent cùng gọi `build_storyboard` hoặc `apply_actions` cùng lúc sẽ gây timeout hoặc trim nhầm clip của nhau!
2. **CẤM TUYỆT ĐỐI chia Subagent theo từng Track rời (`Subagent V2`, `Subagent V3`, `Subagent V4`):**
   - Trong một cảnh, nền `V1`, nhân vật `V2, V3`, phương tiện/yêu quái `V4` và đạo cụ/khói `V5` có quan hệ vị trí và thời gian chặt chẽ với nhau (người ngồi trong thuyền, tay cầm quạt, cùng cắt đúng 1 frame `Shot_End`, cùng zoom theo 1 Camera).
   - Do đó, **mỗi Subagent `chapter-builder` bắt buộc phụ trách TRỌN VẸN cả 5 track (`V1 + V2 + V3 + V4 + V5`) của đúng phân đoạn ~2 phút (`ch<NN>.md`) được giao!**

### Quy trình 4 Bước Thực Thi:
1. **Bước 1 — AI chính chuẩn bị Hồ sơ Bố cục Chung (`## Bố cục`):**
   - Gọi `list_media()` lấy `mId`, `W x H`, `figure`, `feet` của toàn bộ ảnh; xem hướng mặt gốc và đo `Zones` của từng `bg_*`; lưu vào plan.
2. **Bước 2 — Chạy SONG SONG các Subagent `motion-builder` (Cho các cảnh `remotion`):**
   - Khởi tạo các project Remotion trong `project/motion-graphics/<slug>`.
   - Gọi các `motion-builder` chạy song song: viết code, `preview_motion`, tự kiểm ảnh `sheet-1.jpg` (cấm HUD/Legend/chữ thừa, đúng hướng mặt, chân chạm đất), đạt 100% thì gọi `render_motion(wait: false)` để xếp hàng render ngầm.
3. **Bước 3 — Gọi TUẦN TỰ từng Subagent `chapter-builder` (Mỗi lần 1 đoạn ~2 phút theo đúng thứ tự `ch01 -> ch02 -> ch03...`):**
   - Nếu đoạn trước đang đặt clip lên Premiere thì đoạn sau **bắt buộc đợi**.
   - Trong lượt của mình, `chapter-builder` của chương $k$:
     1. Chờ file `.mp4` Remotion của chương $k$ (nếu có) render xong bằng `render_status`.
     2. Đặt toàn bộ clip `V1` (bối cảnh `bg_*` + video Remotion `.mp4`) của chương $k$ bằng `build_storyboard(mode: "replace", targetVideoTrack: 1)` nối khít `Shot_N.end === Shot_N+1.start`.
     3. Đặt lần lượt `V2`, `V3`, `V4`, `V5` của chương $k$ bằng `build_storyboard(mode: "replace", targetVideoTrack: 2..5)` theo đúng thứ tự thời gian tăng dần.
     4. Gọi `get_timeline(fromSec, toSec)` lấy đúng `segmentId` của chương $k$, áp `add_effects` (`Horizontal Flip`) và `apply_actions` (`update_clip` với `anchor: [fx_used, fy]` + `keyframes` theo đúng nhịp `Active/Passive`, chia mỗi gói `20–25 action` để chạy tức thì không bao giờ timeout).
     5. Gọi ngay `preview_timeline(atSec: [...], grid: true)` kiểm tra toàn bộ các shot trong 2 phút của chương $k$ + điểm nối với chương $k-1$:
        - Kiểm tra **0 có ô đỏ Media Offline**;
        - Kiểm tra **0 có khe hở mất frame** hay clip thò đuôi qua vạch cắt `Shot_End`;
        - Kiểm tra **đúng tỉ lệ `Scale Tier`** (thuyền to hơn người, đạo cụ vừa tay, chân nhân vật đứng đúng `Zone` bờ đất/ngai vàng của `bg_*`).
        - Có bất kỳ lỗi nào thì xóa clip lỗi (`delete_clips`) và sửa dứt điểm ngay trong chương $k$ rồi mới báo hoàn tất để AI chính mở khóa cho chương $k+1$ vào làm tiếp!
4. **Bước 4 — Nghiệm thu tổng thể cuối cùng:**
   - Sau khi chương cuối cùng hoàn tất, AI chính kiểm tra `get_timeline()` và `preview_timeline` toàn phim, cập nhật trạng thái vào `STORY.md` / `SHOT_PLAN.md` và báo cáo cho người dùng.

---

## 5. Thứ tự Track Chuẩn trên Premiere Pro

| Track | Vai trò cố định |
| :---: | :--- |
| `V1` | Bối cảnh tĩnh `bg_*` (`zoom: 1.41` nếu ảnh `1376x768`), hoặc video Remotion cả cảnh (`.mp4`) |
| `V2` | Nhân vật trụ / nhân vật bên trái / phương tiện nằm dưới nhân vật (như thuyền/kiệu nếu người ngồi đè lên trên) |
| `V3` | Nhân vật chính thứ 2 (ví dụ Ngộ Không) — các pose nối tiếp khít frame trên cùng track này |
| `V4` | Đối thủ / Yêu quái / Nhà Vua / Thần Phật bên phải sân khấu |
| `V5` | Tiền cảnh che (`fg_*`), đạo cụ cầm tay / đạo cụ bay (`prop_*`), hoặc Overlay Remotion `.mov` có alpha |
| `A1` / `A2+` | Voice chính và SFX / nhạc nền |

> **Lưu ý an toàn bắt buộc:**
> - **CẤM TUYỆT ĐỐI gọi tool `add_text` (`.mogrt`)** hoặc **`remove_background`** trên Premiere Pro.
> - Khi đặt clip nối đuôi theo từng chương từ `ch01 -> ch02 -> ...`, dùng `mode: "replace"` với `targetVideoTrack: 1..5` theo đúng thứ tự thời gian tăng dần để clip luôn nằm đúng trên track chỉ định (`V1..V5`), không bị nhảy sang `V6, V7`.
