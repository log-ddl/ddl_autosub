---
name: footage-planning
description: Từ voice hoặc kịch bản, lên kế hoạch hình minh họa, tìm và tải footage (YouTube, Pexels, Pixabay), xem video để chọn đoạn, rồi ráp lên timeline. Dùng khi người dùng muốn tìm B-roll, footage minh họa, hoặc dựng hình cho một kịch bản.
---
# Lên kế hoạch và tìm footage cho kịch bản

Quy trình 6 bước. Mỗi bước lưu kết quả bằng `save_plan` (vào thư mục `plan/` của project), để làm tiếp được sau khi hội thoại bị nén hay khi người dùng chen vào sửa. Bắt đầu bằng `read_plan` (không truyền tên) để xem đã có gì: nếu có file của bước trước thì đọc nó và làm tiếp từ đó, đừng làm lại. Chưa biết đang làm với editor và project nào thì gọi `get_project_context`.

Bạn quyết định, tool làm việc: tool tìm, tải, phân tích hình và đặt clip. Không tự chạy yt-dlp, ffmpeg hay cắt file.

## 1. Kịch bản thành các nhịp (`save_plan` tên `script.json`)

- Voice đã nằm trên timeline: đọc bằng `get_transcript` để có thời gian từng câu.
- Chỉ có văn bản kịch bản: dùng văn bản đó; thời gian ước theo tốc độ đọc khoảng 2.5 từ mỗi giây (tiếng Việt khoảng 3.5 tiếng mỗi giây), và ghi rõ là ước lượng.
- Chia thành nhịp 3-8 giây, mỗi nhịp một ý hình. Lưu:

```json
[
  { "line": 1, "start": 0.0, "end": 4.2, "text": "Năm 2024, siêu bão Yagi...", "need": "bão đổ bộ, cây đổ, gió mạnh", "kind": "specific", "keywords": ["bão Yagi 2024", "typhoon Yagi Vietnam"] },
  { "line": 2, "start": 4.2, "end": 9.0, "text": "...", "need": "phố ngập nước nhìn từ trên cao", "kind": "generic", "keywords": ["flooded street aerial"] }
]
```

`kind`: `specific` (sự kiện, người, nơi chốn, sản phẩm có thật), `generic` (B-roll chung), `motion` (số liệu, bản đồ, chữ: làm motion graphic, không tìm footage), `none` (giữ hình gốc, ví dụ người dẫn đang nói).

Cho người dùng xem bảng nhịp ngắn gọn trước khi đi tìm, trừ khi họ đã bảo cứ làm hết.

## 2. Tìm footage

- Ít nhịp (khoảng 5 trở xuống): tự gọi `search_media` MỘT lần với tất cả từ khóa trong `queries`.
- Nhiều nhịp: chia thành nhóm 3-5 nhịp và giao mỗi nhóm cho một subagent `footage-scout`, gọi tất cả CÙNG LÚC (Claude Code: tool Agent/Task với `subagent_type: "footage-scout"`; agy: `invoke_subagent` với `TypeName: "footage-scout"`). Gửi cho mỗi subagent nội dung các nhịp của nhóm (line, text, need, kind, thời lượng); nó không đọc được file của bạn.
- Nếu không gọi được subagent thì tự làm từng nhóm.

Quy tắc chọn nguồn: `generic` thì Pexels/Pixabay trước (sạch, dùng lại được); `specific` thì YouTube. Muốn chắc về bản quyền thì YouTube `license: "cc"`. Nhắc người dùng một lần rằng footage YouTube thường không được phép dùng lại nếu không phải CC.

Lưu ứng viên bằng `save_plan` tên `candidates.json`: mỗi nhịp một danh sách link kèm nguồn và độ dài.

## 3. Tải bản xem trước

- Stock (Pexels, Pixabay) thường ngắn: tải luôn bản đầy đủ bằng `download_media` (không cần preview).
- YouTube: tải bản xem trước `preview: true` (360p, vào `media/preview`). Video dài hơn khoảng 10 phút mà chỉ cần một cảnh thì thôi, chọn ứng viên khác hoặc chỉ preview một khoảng bằng `startSec`/`endSec`.
- Gom tối đa 10 link mỗi lần gọi `download_media` (`items`), chúng tải song song.

## 4. Xem video và chọn đoạn

- Mỗi video giao cho một subagent `clip-analyst`, gọi tất cả CÙNG LÚC. Gửi cho nó: id video (`m12`) và các nhịp mà video đó là ứng viên (line, need, thời lượng cần). Nó trả về JSON `srcIn`/`srcOut`/`score` cho từng nhịp.
- Không gọi được subagent: tự gọi `analyze_media` với `items` (nhiều video một lần), mở các ảnh contact sheet và chọn đoạn theo cùng tiêu chí: nằm trong một shot, đủ dài, đúng nội dung, không chữ/logo/watermark.
- Với mỗi nhịp, giữ đoạn có `score` cao nhất. Nhịp nào không có đoạn đạt (score dưới 3 hoặc không có) thì quay lại bước 2 với từ khóa khác, tối đa một lần, rồi đánh dấu là thiếu.

Lưu kết quả bằng `save_plan` tên `shotlist.json`:

```json
[
  { "line": 1, "start": 0.0, "end": 4.2, "media": "m12", "srcIn": 34.2, "srcOut": 38.4, "source": "youtube", "preview": true, "url": "https://www.youtube.com/watch?v=..." },
  { "line": 2, "start": 4.2, "end": 9.0, "media": "m15", "srcIn": 2.0, "srcOut": 6.8, "source": "pexels", "preview": false }
]
```

## 5. Duyệt với người dùng

Trước khi tải bản đầy đủ và ráp: trình bày bảng ngắn (nhịp, nội dung câu, clip chọn, đoạn in-out, nguồn) và những nhịp còn thiếu. Chờ người dùng đồng ý, trừ khi họ đã bảo làm hết không cần hỏi.

## 6. Tải bản đầy đủ và ráp

- Mỗi đoạn lấy từ bản preview: tải lại ĐÚNG đoạn đó ở chất lượng cao bằng `download_media` với `startSec = srcIn - 1`, `endSec = srcOut + 1` (thừa 1 giây mỗi đầu để biên tập viên còn chỉnh). File tải theo đoạn bắt đầu từ 0, nên đổi lại `srcIn = 1`, `srcOut = 1 + (srcOut cũ - srcIn cũ)` và dùng id của file mới. Gom các đoạn vào `items` (tối đa 10 mỗi lần).
- Lưu lại `shotlist.json` (`save_plan`) với id và srcIn/srcOut mới.
- Ráp tất cả trong MỘT lần gọi `build_storyboard` (hoặc `apply_actions`): mỗi nhịp là một item `path` = id, `start`/`end` = thời gian nhịp, `srcIn`/`srcOut` = đoạn đã chọn, chế độ `overlay` lên track trên voice/A-roll. Không đặt nhịp `none`; nhịp `motion` để cho bước motion graphic.
- Đọc kết quả tool, sửa những dòng báo lỗi, rồi báo người dùng những nhịp còn thiếu.
