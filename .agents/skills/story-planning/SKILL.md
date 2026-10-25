---
name: story-planning
description: Lên kế hoạch hình cho một video kể chuyện / giải thích 2D ghép lớp (nhân vật PNG, bối cảnh, đạo cụ) từ voice hoặc kịch bản, ra một plan/SHOT_PLAN.md duy nhất (cụm ý, shot, điều người xem phải thấy, danh sách ảnh, bố cục chỗ đứng & tỉ lệ thực tế). Luôn chạy skill này trước remotion-premiere-hybrid; skill dựng chỉ dựng theo plan này, không tự chia kịch bản.
---
# Lên kế hoạch hình (`story-planning`)

Đây là **cổng vào duy nhất** cho video kể chuyện 2D. Skill này đọc voice, chia ý, đạo diễn cách kể bằng hình, lập danh sách ảnh và chốt bố cục + tỉ lệ kích thước thực tế, tất cả trong **một file `plan/SHOT_PLAN.md`** (hoặc các file `plan/ch<NN>.md` khi làm video dài). Skill dựng `remotion-premiere-hybrid` chỉ đọc file này rồi dựng; không chia kịch bản lại.

Bắt đầu: `get_project_context`, rồi `read_plan` (không tên). Đã có `SHOT_PLAN.md` thì đọc và làm tiếp phần còn thiếu, không làm lại.

**Video dài (khoảng 4 phút trở lên): dừng ở đây, `read_skill("long-video")` và làm theo nó.** Khi làm video dài, mỗi chương ngắn (~2 phút, `90s–150s`) dùng skill này theo mục cuối **"Khi làm theo chương"**.

---

## Vai trò: Đạo diễn hình ảnh, không phải người nhặt từ khóa xếp hình

Người nhặt từ khóa hỏi *"câu này nhắc tới tên ai/vật gì thì quăng hình đó lên màn hình"*. Người đạo diễn hỏi *"ở giây này người xem cần hiểu tình huống gì, mắt họ đang nhìn vào đâu, nhân vật tương tác vật lý với nhau thế nào để tắt tiếng đi vẫn hiểu câu chuyện"*.

**Dấu hiệu làm sai (Gặp là phải sửa ngay từ trong Plan):**
- **Bệnh "Xếp búp bê dàn hàng ngang":** Cảnh nào cũng đặt 3–4 nhân vật đứng thành hàng ngang nhìn nhau suốt 15–20 giây trong khi lời thoại đang kể một hành động kịch tính (bị bắt trói, ngồi thuyền, chui vào bụng, sập bẫy...).
- **Bệnh "Ghép lớp cơ học vô lý":** Lấy ảnh nhân vật đứng thẳng ghép đè lên cạnh chiếc thuyền, hoặc đặt con hổ đứng riêng cạnh cái lồng, hoặc đặt đạo cụ lơ lửng giữa trời không gắn vào tay ai.
- **Bệnh "Lạm dụng nhún nhảy hoặc Đơ cứng về cuối":** Bắt tất cả nhân vật trên sân khấu cùng nhún nhảy/co giãn liên tục suốt cả shot làm khung hình loạn mắt, hoặc ngược lại ở các chương cuối bỏ mặc nhân vật đứng đơ không có phản ứng.
- **Bệnh "Cắt vụn theo dòng SRT làm mất frame":** Lấy nguyên `end_time` của từng câu SRT (trước khoảng nghỉ lấy hơi 0.4s–0.7s của người đọc) làm `end` của clip khiến nhân vật bị nháy biến mất vài chục frame rồi hiện lại, hoặc để clip của cảnh cũ thò đuôi vượt qua vạch chuyển cảnh sang cảnh mới.

---

## 1. Đọc nguồn và tìm điều cần truyền đạt

1. Người dùng đưa file phụ đề (`.srt`, `.vtt`): dùng nó thay transcript của app, `get_transcript(path: "<đường dẫn đầy đủ>", map: true)`, và luôn truyền `path` đó ở các lần gọi sau. Có voice trên timeline: `get_transcript(map: true)`: một dòng mỗi câu với mốc giây, `‖` là chỗ nghỉ dài, sau `·` là các từ mang số hoặc tên riêng kèm mốc. Đọc **toàn bộ** trước khi chia. Khi cần mốc chính xác của từng từ khóa trong câu để đặt lớp xuất hiện ngắn (`Transient`) hoặc điểm va chạm (`t_hit`), tra bằng `get_transcript(words: true, fromSec, toSec)`.
2. Chỉ có văn bản: dùng văn bản, ước khoảng 3.5 tiếng/giây (tiếng Việt) và ghi là ước lượng.
3. **Hook trước tiên:** Hình đầu tiên phải có tình huống thị giác đáng nhìn ngay, tự gợi câu hỏi kể cả khi tắt tiếng.

---

## 2. Chia thành Cụm ý & Khóa Lưới Thời Gian Tuyệt Đối (`Master Cut Grid`)

- **Cụm** là một nhóm câu cùng giải thích một tình huống (thường 30–60s, gồm 2–4 shot).
- **Tách shot khi đổi không gian, đổi tình huống hành động, hoặc đổi cỡ cảnh:** Không cắt shot vụn theo từng câu nói ngắn nếu vẫn đang ở cùng một không gian và cùng một tình huống; nhưng cũng không ngâm một bố cục tĩnh quá 15–18 giây mà không có sự thay đổi trạng thái, đổi biểu cảm hoặc chuyển động Camera.
- **QUY TẮC KHÓA FRAME TUYỆT ĐỐI (`Master Cut Grid` — Bắt buộc):**
  1. **Nối khít ranh giới Shot (`Shot_N.end === Shot_N+1.start`):**
     - Giữa câu cuối của Shot $N$ và câu đầu của Shot $N+1$ trong file SRT luôn có khoảng nghỉ lấy hơi (`0.3s–0.8s`). Người lập plan **BẮT BUỘC gộp khoảng nghỉ đó vào cuối Shot $N$** (tức là `Shot_N.end` phải bằng chính xác `Shot_N+1.start`, chính xác tới `1/30s`). **CẤM TUYỆT ĐỐI** để khe hở trống giữa 2 shot kế tiếp!
  2. **Phân biệt rõ 2 loại thời lượng lớp (Layer Lifespan) bên trong mỗi Shot:**
     - **Loại A — Lớp Trụ của cảnh (`Persistent Layer`):** Các nhân vật/vật thể có mặt xuyên suốt từ đầu đến cuối shot (hoặc từ lúc bước vào đến hết shot). Nếu nhân vật giữ nguyên mặt trong 2–3 câu SRT liên tiếp của cùng 1 shot, **bắt buộc gộp thành 1 khoảng thời gian liền mạch duy nhất `[Shot_Start, Shot_End]`**, tuyệt đối không ngắt vụn theo từng dòng SRT! Nếu đổi biểu cảm (`base` $\rightarrow$ `attack` tại `t_change`), thì đoạn 1 là `[Shot_Start, t_change]` và đoạn 2 là `[t_change, Shot_End]` (khít 100%, không hở 1 frame nào).
     - **Loại B — Lớp Xuất Hiện Ngắn theo từ khóa (`Transient / Cue Layer` — chỉ hiện một chút):** Như đám khói phép (`fg_smoke`), tia chớp, đạo cụ hiện lên khi nhắc tên, hoặc nhân vật phụ lướt qua giải cứu rồi đi. Chỉ xuất hiện trong khoảng ngắn `[t_in, t_out]` cần thiết, **NHƯNG bắt buộc `Shot_Start <= t_in < t_out <= Shot_End`** (tuyệt đối cấm để `t_out > Shot_End` làm clip thò đuôi sang cảnh tiếp theo, và khi kết thúc ở `t_out` phải là kết thúc thật sự chứ không phải tắt vài frame rồi bật lại chính nó!).

---

## 3. Đạo diễn Storytelling, Camera Dẫn Mắt & Nhún Nhảy Có Chọn Lọc

Trước mỗi shot viết **một câu**: người xem phải thấy tình huống gì.

1. **Chữ ít nhất có thể (CẤM dùng chữ `.mogrt` / `add_text` trên shot `premiere`):**
   - Với các shot `premiere`, luôn để trống cột Chữ (`*(không)*`). Chỉ hiển thị nhãn ngắn (`1–3 từ`) bên trong các shot `remotion` khi thật sự cần thiết (cấm HUD banner, Legend box, Info popup, thanh máu).
2. **Storytelling qua Hình ảnh — Cấm "Xếp hàng ngang", Ưu tiên "Ảnh Tình Huống Gộp" & "Camera Dẫn Mắt":**
   - **Khi có tương tác gắn kết vật lý (`Composite Action Pose`):** Những cảnh như *"thầy trò ngồi trong thuyền không đáy"*, *"Đường Tăng bị trói treo trên cột/cây"*, *"hổ nằm trong lồng sắt"*, *"Bát Giới cõng cô gái"*, *"nhà vua nằm liệt giường"* $\rightarrow$ **CẤM** lấy ảnh nhân vật đứng thẳng ghép đè lên chiếc thuyền/cái lồng/cái giường. Bắt buộc khai báo trong Danh sách ảnh **1 tấm `pose` vẽ sẵn tình huống tương tác đó** (ví dụ `char_thay_tro_ngoi_thuyen.png`, `prop_ho_nhot_trong_long.png`).
   - **Dẫn mắt người xem bằng Camera (`Camera Zoom & Pan` đồng bộ — Dùng có chọn lọc ở điểm đắt):**
     - Không phải shot nào cũng chỉ quay toàn cảnh rộng (`Wide Shot`) từ đầu đến cuối, nhưng cũng **không lạm dụng zoom ở mọi shot**.
     - Chỉ ở những shot có **điểm nhấn tâm lý, phát hiện âm mưu, lời thoại chốt hoặc bảo bối quan trọng** (khoảng 25–30% số shot), ghi rõ vào cột "Diễn biến" kịch bản Camera đồng bộ (`Virtual Camera` áp cho cả `V1..V5`):
       - *Ví dụ `Wide -> Push-in Focus`:* Đầu shot mở toàn cảnh (`camZoom = 1.0, camX = 0.50, camY = 0.50`), đến đúng giây `t_cue` khi nhân vật mở lời hoặc lộ biểu cảm đắt, Camera đẩy cận mượt vào nhân vật đó (`camZoom = 1.40, camX = gx_char, camY = 0.65` trong `0.45s`) kèm đổi pose biểu cảm.
       - *Ví dụ `Camera Pan đối đáp`:* Camera đang cận ở nhân vật bên trái (`camX = 0.28`), khi đối phương bên phải đáp trả hoặc tung bảo bối thì Camera lia ngang sang phải (`camX = 0.72`).
3. **Quy tắc Nhún Nhảy / Biến Dạng theo Ngữ Cảnh (`Active` vs `Passive` — Cấm lạm dụng, Cấm bỏ rơi về cuối):**
   - **XÓA BỎ quy tắc cũ bắt mọi nhân vật trên sân khấu nhún liên tục 100% thời lượng.**
   - **Luật "Đúng 1 Tâm Điểm Động (`Single Active Focus`)":** Tại mỗi thời điểm trong shot, phân biệt rõ:
     - **Ai ĐƯỢC nhún / biến dạng (`Active`):**
       1. Nhân vật **đang trực tiếp phát ngôn câu thoại đó** (`Snap Hop` nhẹ theo nhịp câu nói: bật nhẹ `Scale Height 1.06x`, nhích `gy - 0.025`, nghiêng `3°` tại các từ nhấn rồi nghỉ tĩnh giữa các câu; tuyệt đối không bóp méo đầu tròn).
       2. Nhân vật **đang thực hiện hành động vật lý** tại đúng mốc giây hành động: đang bước đi (`walk`), vừa nhảy bổ vào tiếp đất (`landing squash & stretch` trong `0.25s` rồi hồi 1:1), đang vung vũ khí tấn công (`attack lunge`), hoặc đang bị đánh trúng / giật mình hoảng sợ (`hit shake / shock bounce` trong `0.25s`).
       3. Các lớp **hiệu ứng tự nhiên** (`fg_fire_flames`, `fg_smoke`, `fg_yellow_wind`, sóng nước, hào quang) được phép co giãn/xoay nhẹ liên tục.
     - **Ai PHẢI GIỮ TĨNH (`Passive / Dignified`):**
       1. Tất cả các nhân vật đang **đứng nghe / chờ đến lượt** trên sân khấu trong lúc người khác nói $\rightarrow$ **Đứng tĩnh 100% (`Uniform Scale = true`, `Rotation = 0°`)**, chỉ đổi pose hoặc lật mặt khi có phản ứng.
       2. Các nhân vật **trang nghiêm / uy nghi** (`Phật Tổ`, `Quan Âm Bồ Tát`, `Ngọc Hoàng`, `Vua ngồi ngai vàng`, `Đường Tăng đang chắp tay nhắm mắt tụng kinh`) $\rightarrow$ **CẤM nhún nhảy hay bóp méo**, chỉ trượt êm (`float`) hoặc giữ tĩnh đĩnh đạc.
       3. Các **đồ vật / phương tiện cứng** (`lồng sắt, thuyền, ngai vàng, tảng đá, núi`) $\rightarrow$ Giữ nguyên tỉ lệ cứng, chỉ di chuyển vị trí hoặc rung nhẹ khi có va chạm.
   - **Đồng đều xuyên suốt cả phim:** Mật độ diễn hoạt của Chương cuối phải được viết kỹ và rõ ràng y hệt Chương 1 (ghi rõ từ giây `a` đến giây `b` ai là `Active`, làm hành động gì; từ giây `b` đến giây `c` chuyển sang ai).

---

## 4. Quy Chuẩn Kích Thước Thực Tế (`Scale Tier`) & Bản Đồ Vùng Đứng (`Background Zones`)

Để chấm dứt tình trạng *"cái thuyền bé hơn người, người cưỡi ngựa bé bằng nửa người đi bộ, con ruồi to bằng người, nhân vật đứng trên mặt nước"*, mọi shot bắt buộc tuân thủ 2 bảng quy chuẩn sau:

### A. Bảng Quy Chuẩn Kích Thước Thực Tế (`Real-World Scale Tier` — tham số `t` so với chiều cao khung hình `1080p`)
Khi ghi bố cục trong bảng shot, bắt buộc gán `t` theo đúng phân hạng kích thước thật ngoài đời của vật thể trong ảnh:

| Phân hạng (`Scale Tier`) | Đối tượng áp dụng | Giá trị `t` chuẩn | Quy tắc tọa độ đi kèm |
| :--- | :--- | :---: | :--- |
| **Tier 1 — Đạo cụ nhỏ / Vật cầm tay** | Bát vàng, giấy thông quan, kinh Phật, quạt Ba Tiêu, hồ lô, viên bảo châu, côn trùng/chim nhỏ... | **`t = 0.10 – 0.14`** | **CẤM đặt đứng dưới đất như người.** Tọa độ `(gx, gy)` phải gắn liền với vị trí tay nhân vật cầm nó (`gx = gx_char ± 0.05, gy = gy_char - 0.15`) hoặc đặt trên mặt bàn/bệ thờ. |
| **Tier 2 — Nhân vật thấp / Trẻ em / Tiểu yêu** | Tôn Ngộ Không, Hồng Hài Nhi, tiểu yêu, chú tiểu, thú nhỏ... | **`t = 0.30 – 0.33`** | Đứng trên mặt đất (`gy` theo `Zone` của nền), thấp hơn Đường Tăng / Bát Giới một chút để đúng tỉ lệ giải phẫu. |
| **Tier 3 — Người trưởng thành đứng** | Đường Tăng, Bát Giới, Sa Tăng, Nhà Vua, Quan Âm, yêu quái hình người... | **`t = 0.36 – 0.39`** | Đứng trên mặt đất (`gy ≈ 0.82–0.88` ở cận/trung cảnh, `gy ≈ 0.76–0.79, t ≈ 0.27` khi đứng ở hậu cảnh xa). |
| **Tier 4 — Người cưỡi ngựa / Ngồi đài sen cao / Yêu vương khổng lồ** | `char_duong_tang_horse` (Đường Tăng cưỡi Bạch Long Mã), Phật Tổ ngồi đài sen lớn, Ngưu Ma Vương, Voi/Sư tử lớn... | **`t = 0.52 – 0.58`** | Vì ảnh bao gồm cả con ngựa/đài sen + thân người, bắt buộc phóng `t = 0.52–0.58` để phần thân người ngồi trên lưng ngựa có kích thước **bằng đúng** người lúc đứng dưới đất (`Tier 3`). |
| **Tier 5 — Phương tiện lớn / Kiến trúc / Lồng / Núi đè** | Thuyền (`prop_thuyen_*`), xe kéo, lồng sắt nhốt hổ, lò Bát Quái, ngọn núi Ngũ Hành Sơn... | **`t = 0.55 – 0.68`** | Phải to và rộng hơn hẳn nhân vật (`Tier 2/3`). Nếu nhân vật đứng/ngồi cạnh hoặc trong thuyền, thuyền và người phải khóa chung tâm tọa độ di chuyển. |

### B. Quy tắc Vùng Đứng Hợp Lệ (`Background Zones`) trên từng tấm nền `bg_*`
Không được đặt nhân vật theo công thức mù `gx = 0.2, 0.7, gy = 0.84` cho mọi tấm nền. Mỗi loại bối cảnh phải tuân thủ đúng vùng vật lý của nó:
- **Nền Bờ sông / Biển (`bg_bo_song_*`):** Xác định rõ phần **Bờ đất** (ví dụ `gx = 0.10..0.44, gy = 0.82`) và phần **Mặt nước** (`gx = 0.48..0.92, gy = 0.88`). Nhân vật trên bờ **bắt buộc đứng trong vùng Bờ đất**; chỉ thủy quái nhô lên từ nước, cá bơi, thuyền hoặc người đang chìm/lội nước mới được đặt ở vùng Mặt nước!
- **Nền Cung điện / Phật đài (`bg_cung_dien_*`, `bg_linh_son_*`):** Xác định rõ **Bục ngai vàng / Đài sen cao** (`gx_throne, gy_throne ≈ 0.66–0.72`) và **Sàn đại điện phía dưới** (`gy ≈ 0.85–0.88`). Nhà Vua hoặc Phật Tổ phải đặt đúng vào tọa độ Bục ngai vàng/Đài sen, còn quần thần/thầy trò đứng hành lễ ở Sàn đại điện phía dưới.
- **Nền Đường núi / Sân chùa / Động yêu quái (`bg_nui_*`, `bg_chua_*`, `bg_dong_*`):** Mặt đất phẳng suốt từ trái sang phải (`gx = 0.14..0.86, gy = 0.83–0.87`).

---

## 5. Danh sách ảnh: rút từ bảng shot

Chỉ liệt kê ảnh mà **một shot cụ thể cần**. Mỗi ảnh ghi: **tên file (chỉ 1 đuôi `.png` duy nhất) + loại & tham chiếu (`refs`) + mô tả + shot dùng nó**.
- **Phân loại node & tham chiếu (`Loại · Tham chiếu`):**
  - `base_char`: nhân vật gốc mới (tạo lần đầu, không có `refs`). Khóa góc máy ngang tầm mắt trực diện, thân trụ đáy phẳng ngang tuyệt đối.
  - `local_ref`: nhân vật cố định đã có sẵn ảnh gốc trên máy.
  - `pose (refs: <file_gốc>)`: tư thế biến thể của một nhân vật, hoặc **ảnh tình huống gộp** (nhân vật đang ngồi thuyền, cưỡi ngựa, bị trói, ngồi ngai vàng, ôm bảo vật sát ngực). Nếu cần khớp đồng thời nhân vật gốc và đạo cụ gốc thì ghi `pose (refs: <file_nhân_vật>, <file_đạo_cụ>)`.
  - `prop` / `fg`: đạo cụ rời (`prop_*`), phương tiện rời hoặc tiền cảnh (`fg_*`) — chỉ tách rời khi thật sự bay/di chuyển độc lập.
  - `bg`: bối cảnh sân khấu 2D (`bg_*`, `16:9`), không vẽ sẵn nhân vật. Mô tả rõ 3 lớp (`ground`, `midground`, `sky`) và vị trí bờ đất / mặt nước / bục cao.

---

## 6. Viết `plan/SHOT_PLAN.md`, xuất `plan/N_workflow.json` và dừng chờ người dùng

1. Lưu kế hoạch bằng `save_plan(name: "SHOT_PLAN.md", content: "<markdown>")` theo mẫu:

```markdown
# Shot plan: <tên video>

Mốc là giây toàn phim (tổng <dur> s; ranh giới các shot nối khít tuyệt đối `Shot_N.end === Shot_N+1.start`). Mặc định không chữ trên hình (`premiere`).

## Lập luận biên tập
Hook mở câu hỏi gì; video trả lời bằng cách kể nào; điều người xem hiểu được ở cuối.

## Quy ước hình & Bảng Scale Tier
- Nhân vật: ai, phía đứng quen thuộc (trái / phải), hướng mặt, `Scale Tier` (`t`).
- Nơi chốn (`bg_*`): vùng đứng hợp lệ (`Zones`: bờ đất, mặt nước, bục ngai vàng).

## Nhân vật và vật xuyên phim
| Tên | Dấu nhận dạng | Scale Tier (`t`) | Các pose / trạng thái dùng | Có mặt ở cụm |
|---|---|---|---|---|

## Cụm ý
### Cụm 1: <câu hỏi> (<từ>–<đến> s)
Đã biết → cần hiểu → thấy gì → hiểu thêm gì.

| Mốc khít (s) · từ then chốt | Người xem phải THẤY (Tình huống) | Bối cảnh (`Zone`) · Lớp (`Persistent` / `Transient`) · Vị trí & `t` | Diễn biến (`Active` nhún/hành động vs `Passive` tĩnh · Camera nếu có) | Chữ (chỉ `remotion`) | Engine | Nối shot sau |
|---|---|---|---|---|---|---|

## Danh sách ảnh
| File (`.png`) | Loại · Tham chiếu (refs) | Mô tả chi tiết | Dùng ở shot |
|---|---|---|---|

## Bố cục (điền sau khi có ảnh)

## Lỗi thấy khi kiểm
```

2. **Đóng gói `project/plan/1_workflow.json`, `2_workflow.json`... (tối đa 50 node mỗi file) ngay sau khi lưu plan** bằng skill `canvas-workflow-json`, gửi người dùng và **dừng chờ** tạo ảnh.

---

## 7. Bố cục, sau khi có ảnh (mục "Bố cục" của SHOT_PLAN.md / STORY.md)

1. **Chuẩn hóa file & Đo PNG:**
   - Kiểm tra tên file trong `project/media/images/` (nếu công cụ tải về sinh đuôi kép `.png.png` hoặc `.png.jpg` thì copy chuẩn hóa về đúng tên `<name>.png` thật trên đĩa trước khi import vào Premiere).
   - Gọi `list_media` lấy mã `mId`, kích thước `W x H`, khung bao `figure (x1-x2, y1-y2)`, điểm chạm đất `feet (fx, fy)`.
   - **CẤM TUYỆT ĐỐI gọi tool `remove_background`** hay dùng script/ffmpeg xóa nền lại ảnh `.png`.
2. **Mở từng `bg_*` và nhân vật chính ra xem (`read_file`)** để ghi:
   - Hướng mặt gốc của từng nhân vật (`Nhìn Phải` hay `Nhìn Trái`);
   - Các `Zones` đứng hợp lệ của từng `bg_*` (bờ đất trái/phải, mặt nước, bục ngai vàng/đài cao) kèm tọa độ `(gx, gy)`.
3. Ghi bảng `## Bố cục` đầy đủ vào `SHOT_PLAN.md` (hoặc `STORY.md`).

---

## Khi làm theo chương (`long-video`)

- **Mỗi chương dài khoảng ~2 phút (`90s–150s`, khoảng 6–8 shot):** Đảm bảo mỗi subagent `chapter-planner` đạo diễn sâu từng shot và từng beat, không bao giờ bị đuối hay làm ẩu về cuối.
- **`STORY.md`, mục "Quy ước xuyên phim"**: Chốt trước bảng Nhân vật gốc, Bối cảnh dùng chung và **Bảng Quy Chuẩn Kích Thước (`Scale Tier`)** để mọi chương dùng chung.
- **Plan một chương (`chapter-planner`)**: Ghi vào `ch<NN>.md` với ranh giới `Shot_N.end === Shot_N+1.start` khít từng frame và khớp chính xác với mốc đầu/cuối chương trong `STORY.md`.
- **Danh sách ảnh & `N_workflow.json`**: Agent chính gộp danh sách ảnh từ mọi chương vào `STORY.md` (bỏ trùng) và tạo bộ `project/plan/N_workflow.json` một lần cho cả phim.
- **Bố cục**: Đo và ghi một lần cho cả phim vào `STORY.md` (và/hoặc từng file `ch<NN>.md`).
