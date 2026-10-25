---
name: long-video
description: Làm video dài (khoảng 4 phút trở lên) theo chương, với bất kỳ kiểu video nào: đọc toàn bộ voice, chia chương vào plan/STORY.md, lên plan các chương song song bằng subagent, dựng từng chương lần lượt, render Remotion xếp hàng. Skill này chỉ chia việc; cách kể, cách dựng và cách kiểm vẫn là của skill kiểu video.
---
# Video dài theo chương (`long-video`)

Skill này **chỉ chia việc**. Cách kể, cách dựng, cách kiểm là của **skill chính** của kiểu video (ví dụ `story-planning` rồi `remotion-premiere-hybrid`, hay `footage-planning`). Mỗi chương phải qua **đủ mọi bước** skill chính đòi hỏi, kỹ như một video ngắn. Không bỏ bước, không bớt hiệu ứng, không đổi model nhanh hơn để xong sớm.

Video ngắn hơn khoảng 4 phút: không dùng skill này, làm thẳng skill chính. Video dài thì skill này **đi trước** skill chính: không viết `SHOT_PLAN.md` cho cả phim, kể cả khi skill chính hay một skill khác (ví dụ skill làm workflow ảnh) nhắc tới nó; mỗi chương có file riêng.

Nhanh hơn chỉ nhờ làm cùng lúc những việc không phải chờ nhau:

| Việc | Cùng lúc được? |
| :--- | :--- |
| Lên plan chương, viết code Remotion, `preview_motion` | Được, nhiều subagent |
| `render_motion` | App tự xếp hàng, từng cái một |
| Sửa timeline, `get_timeline`, `preview_timeline` | Một chương một lúc (app cũng chỉ nhận một lệnh timeline một lúc) |

**Bắt đầu:** `get_project_context`, rồi `read_plan` (không tên). Đã có `STORY.md` thì đọc cột "Theo dõi" và làm tiếp phần còn thiếu, không làm lại.

**Gọi subagent:** Claude Code dùng tool Agent/Task với `subagent_type`; agy dùng `invoke_subagent` với `TypeName`. Subagent không thấy hội thoại của bạn: giao đủ số chương, tên skill, tên file. Không gọi được subagent thì tự làm từng chương theo đúng các bước dưới, lần lượt.

---

## 1. Khung cả phim (bạn tự làm, không giao subagent)

1. **Đọc toàn bộ nguồn trước khi chia.** `get_transcript(map: true)`: một dòng mỗi câu, cả phim trong một lần (nếu cuối kết quả báo còn câu thì đọc tiếp bằng `fromSec`/`toSec` cho tới hết). Chỉ có văn bản thì đọc hết văn bản.
   - **Người dùng đưa file phụ đề** (`.srt`, `.vtt`): đó là bản họ tin hơn transcript của app. Đọc bằng `get_transcript(path: "<đường dẫn đầy đủ>", map: true)`, ghi đường dẫn vào dòng `Transcript:` của `STORY.md`, và mọi lần gọi `get_transcript` sau (của bạn và của subagent) đều truyền `path` đó.
   - Không có transcript, cũng không có file phụ đề: hỏi người dùng. Không đọc code của app, không tự viết script tách phụ đề.
2. Đọc skill chính (`read_skill`), nhất là mục **"Khi làm theo chương"**: nó nói `STORY.md` cần thêm gì cho kiểu video này.
   Bước này chỉ đọc và chia chương. **Không viết shot**, không lập danh sách ảnh: đó là việc của bước 2.
3. **Chia chương theo ý**, không theo đồng hồ: mỗi chương trả lời một câu hỏi, thường 1 đến 2 phút. Ranh giới đặt ở chỗ nghỉ (`‖`) hoặc chỗ đổi ý, nơi cắt thẳng là tự nhiên.
4. `save_plan(name: "STORY.md")` theo mẫu:

```markdown
# Story: <tên video>

Skill chính: <skill lên plan> rồi <skill dựng>. Tổng <dur> s. Mốc luôn là giây toàn phim.
Transcript: <transcript của app | đường dẫn đầy đủ của file phụ đề>

## Lập luận cả phim
Hook mở câu hỏi gì; mỗi chương trả lời phần nào; người xem hiểu gì ở cuối.

## Quy ước xuyên phim
(Những gì skill chính ghi ở mục "Khi làm theo chương": nhân vật, hình đại diện cho ý, nơi chốn, tông hình...)

## Chương
| # | Mốc (s) | Câu hỏi / ý của chương | Trạng thái đầu | Trạng thái cuối | Nối với chương sau |
|---|---|---|---|---|---|

## Theo dõi
| # | Plan | Duyệt | Dựng | Kiểm |
|---|---|---|---|---|
```

- **Trạng thái đầu / cuối** là thứ chương sau nhận lại (skill chính nói gồm những gì). Nhờ nó các chương lên plan cùng lúc mà vẫn nối liền.
- Hook của skill chính áp cho mở đầu phim; mỗi chương mở bằng câu hỏi của chính nó.

5. Gửi người dùng lập luận và bảng chương, rồi **dừng chờ duyệt**. Người dùng đã bảo làm luôn, không cần hỏi: gửi để họ xem rồi sang bước 2 ngay.

## 2. Plan từng chương (song song)

1. Gọi subagent `chapter-planner` cho **mọi chương cùng lúc**, mỗi chương một cái (trong cùng một lượt, không đợi cái trước xong). Giao: số chương, skill lên plan, tên file ra `ch<NN>.md` (2 chữ số: `ch01.md`). Kiểu video nào dùng file khác thì theo mục "Khi làm theo chương" của skill chính.
2. Xong thì **bạn đọc mọi file chương** và kiểm cả phim, việc mà từng subagent không làm được:
   - trạng thái cuối chương N khớp trạng thái đầu chương N+1;
   - một nhân vật, vật, nơi chốn được gọi cùng một tên ở mọi chương;
   - "Dấu hiệu làm sai" của skill chính nhìn trên cả phim: cùng một cách xử lý lặp lại ở nhiều chương, nhịp đều đều;
   - các đề xuất sửa `STORY.md` mà subagent gửi về.
   Sai thì sửa: tự sửa, hoặc gọi lại `chapter-planner` của chương đó kèm ghi chú.
3. Gộp phần dùng chung theo skill chính (ví dụ danh sách ảnh bỏ trùng) vào `STORY.md`.
4. Gửi người dùng theo đợt vài chương, **dừng chờ duyệt** (trừ khi họ đã bảo làm luôn). Cập nhật cột Plan / Duyệt.

## 3. Chuẩn bị chung (một lần cho cả phim)

Làm những gì skill chính đòi trước khi dựng (ví dụ chờ người dùng tạo ảnh, đo bố cục), một lần cho cả phim, ghi đúng chỗ skill chính nói.

Bước 4 và 5 dưới đây là cách mặc định. Skill dựng nào tự có cách chia subagent trong mục "Khi làm theo chương" của nó thì làm theo skill đó thay cho bước 4 và 5.

## 4. Shot Remotion (nếu plan có)

1. Gọi subagent `motion-builder` **cùng lúc**, mỗi shot (hoặc mỗi project Remotion) một cái, theo thứ tự chương để render của chương đầu xong trước. Giao: file chương, mốc shot, skill dựng, tên project và `output` có số chương (`ch03-<slug>`).
2. Mỗi `motion-builder` làm code, `preview_motion`, kiểm đến khi đạt rồi `render_motion(wait: false)`, trả về job id. Ghi job id vào cột Dựng của chương.
3. Không chờ render xong mới sang bước 5: render chạy nền trong lúc dựng.

## 5. Dựng từng chương (lần lượt)

1. Gọi subagent `chapter-builder` **từng chương một, theo thứ tự**: chương trước báo xong mới gọi chương sau. Giao: số chương, file chương, skill dựng, các job id render của chương.
2. Mỗi chương có một subagent mới, nên chương 20 được dựng kỹ như chương 1.
3. Đọc báo cáo, cập nhật cột Dựng / Kiểm. Lỗi do plan thì sửa plan chương rồi gọi lại.

## 6. Kiểm cả phim

`render_status` để chắc không còn render lỗi hay đang chờ. Rồi làm "Kiểm tra cuối" của skill dựng cho cả phim, thêm `atSec` hai bên **mỗi ranh giới chương**. Báo cáo ngắn: đã dựng gì, sheet, lỗi còn lại theo chương, phần chưa kiểm được.
