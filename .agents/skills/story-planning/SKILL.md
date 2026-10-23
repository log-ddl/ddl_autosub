---
name: story-planning
description: Lên kế hoạch hình cho một video kể chuyện / giải thích 2D ghép lớp (nhân vật PNG, bối cảnh, đạo cụ) từ voice hoặc kịch bản, ra một plan/SHOT_PLAN.md duy nhất (cụm ý, shot, điều người xem phải thấy, danh sách ảnh, bố cục chỗ đứng). Luôn chạy skill này trước premiere-full-edit, remotion-full-video hay remotion-premiere-hybrid; ba skill đó chỉ dựng theo plan này, không tự chia kịch bản.
---
# Lên kế hoạch hình (`story-planning`)

Đây là **cổng vào duy nhất** cho video kể chuyện 2D. Skill này đọc voice, chia ý, chọn cách kể bằng hình, lập danh sách ảnh và chốt bố cục, tất cả trong **một file `plan/SHOT_PLAN.md`**. Ba skill dựng (`premiere-full-edit`, `remotion-full-video`, `remotion-premiere-hybrid`) chỉ đọc file này rồi dựng; chúng không chia kịch bản lại. Đổi cách dựng giữa chừng thì plan, ảnh và bố cục vẫn dùng được.

Bắt đầu: `get_project_context`, rồi `read_plan` (không tên). Đã có `SHOT_PLAN.md` thì đọc và làm tiếp phần còn thiếu, không làm lại.

**Thứ tự làm việc không phải thứ tự kể chuyện.** Các bước dưới đây là cách ra quyết định, không phải các cảnh bắt buộc. Không áp một khuôn (Host mở đầu, bảng tên, cảnh kể, Host kết) cho mọi video.

---

## Vai trò: nhà dựng, không phải người minh họa

Người minh họa hỏi "câu này nhắc tới gì thì đặt hình đó". Nhà dựng hỏi "ở giây này người xem đang ở trạng thái nào, và hình nào giúp họ hiểu hơn hay chỉ làm họ bận mắt". Một câu voice không tự động cần một hình mới; một hình tốt có thể giữ qua nhiều câu và chỉ đổi trạng thái.

**Dấu hiệu làm sai** (gặp là quay lại sửa plan):
- Hình chỉ minh họa từ khóa trong câu; câu nào cũng đổi hình hoặc đổi pose.
- Đổi hình, thêm chuyển động liên tục để "có cảm giác động".
- Chữ, bảng tên, khung giấy thay cho hình.
- Host hiện vì "đến lượt Host", không vì có việc.
- Hiệu ứng, chuyển cảnh, SFX rải đều cho đủ.
- Cùng một cách xử lý lặp lại ở nhiều đoạn.
- Hình đẹp nhưng không giúp hiểu thêm điều gì.

## 1. Đọc nguồn và tìm điều cần truyền đạt

1. Có voice trên timeline: `get_transcript(map: true)`: một dòng mỗi câu với mốc giây, `‖` là chỗ nghỉ dài, sau `·` là các từ mang số hoặc tên riêng kèm mốc (chỗ hình có thể đặt vào). Đọc **toàn bộ** trước khi chia. Mốc của một từ khác thì tra sau bằng `get_transcript(words: true, fromSec, toSec)`, không đọc cả file theo từng từ.
2. Chỉ có văn bản: dùng văn bản, ước khoảng 3.5 tiếng/giây (tiếng Việt) và ghi là ước lượng.
3. Ghi ngắn: người xem là ai, họ đã biết gì, video trả lời câu hỏi gì, trọng tâm là gì. Phân biệt điều nguồn khẳng định với phần minh họa; không thêm sự kiện để hấp dẫn hơn.
4. **Hook trước tiên.** Tìm điều đáng ngạc nhiên nhất trong nguồn và câu hỏi nó mở ra mà phần sau trả lời. Hình đầu tiên phải có điều đáng nhìn ngay, tự gợi câu hỏi kể cả khi tắt tiếng; không mở bằng nền trống, logo, tiêu đề chạy chậm hay giới thiệu chung. Nếu voice mở đầu không tạo được câu hỏi đó, **báo người dùng** và đề xuất thứ tự khác, không tự sửa lời.

## 2. Chia thành cụm ý, rồi mới chia shot

- **Cụm** là một nhóm câu cùng giải thích một điều. Mỗi cụm ghi: người xem đã biết gì → còn cần hiểu gì → thấy bằng chứng / biến đổi nào → cuối cụm hiểu thêm gì. Một cụm có thể dài nhiều câu và nhiều cỡ cảnh.
- **Rút ý thật** khi một đoạn khô hay trừu tượng: bỏ lớp từ ngữ, hỏi "điều gì thay đổi, so với cái gì", viết thành một câu không dùng từ khóa của lời dẫn. Hình đúng có **cùng cấu trúc** với ý (lớn dần, đầy / cạn, dồn về một điểm, hai phía tách xa...), không chỉ cùng từ khóa. Ưu tiên chất liệu đã có trong chính video (nhân vật, vật, nơi chốn người xem đã thấy).
- **Thử phản chứng** mỗi phương án: tắt tiếng có đoán ra ý không? Tắt hình voice có tự đủ không (đủ mà hình không thêm gì thì hình thừa)? Hình này gắn sang câu khác được không (được thì quá chung chung)?
- **Tách shot chỉ khi có lý do đọc hình**: cần cỡ khác để thấy điểm quan trọng, cần đổi nơi / thời gian theo nguồn, cần đối chiếu bằng bố cục khác. Bố cục hiện tại vẫn cho thấy phần tiếp theo thì giữ nó và chỉ đổi trạng thái (thêm một vật, đổi pose, nhân vật bước vào). Ghi lý do ở mỗi ranh giới shot và thứ mang sang shot sau (nhân vật, vị trí, hướng, trạng thái, câu hỏi chưa giải đáp).
- **Nhịp theo nội dung**, không chia đều, không cắt mỗi khi hết câu. Hình có thể vào trước từ khóa để dẫn, đúng lúc để nhấn, hoặc sau để xác nhận; giữ đủ lâu để đọc, không lâu hơn. Sau một nhấn mạnh thì có khoảng nghỉ.

## 3. Mỗi shot: người xem phải THẤY gì

Trước mỗi shot viết **một câu**: người xem phải thấy gì (ai làm gì với ai, cái gì đổi, so với cái gì). Không viết được thì shot chưa có lý do tồn tại.

- **Hình là chính.** Ý được kể bằng nhân vật, tư thế, vị trí tương đối, vật thay đổi, nơi chốn.
- **Host xuất hiện khi cần, không theo lịch.** Có việc thì hiện: dẫn vào một câu hỏi, bình luận một điều hình không tự nói được, nối hai phần cách xa nhau. Không có việc thì không hiện, kể cả ở mở đầu hay kết.
- **Chữ ít nhất có thể.** Mặc định không có chữ. Chỉ thêm khi bỏ đi sẽ mất thông tin hoặc dễ hiểu sai: tên một nhân vật mà hình không phân biệt được, một con số voice đọc ra mà hình không thể hiện. Tối đa 2 chữ cùng lúc, đúng lúc, đủ lâu để đọc rồi mất. Không tiêu đề, không nhãn kết luận, không bảng tên chỉ để trang trí.
- **Chuyển động có nghĩa.** Chuyển động phải chính là nội dung (người ngã vì bị đánh, vật rơi khi bị cắt dây). Bỏ chuyển động mà ý không đổi thì không cần chuyển động.
- **Liên tục.** Nhân vật giữ nhận dạng, hướng mặt, phía đứng (ai bên trái, ai bên phải) giữa các shot liên tiếp, trừ khi nguồn đổi tình huống. Không để vật biến mất hay quay lại trạng thái cũ vô cớ.
- **Chuyển cảnh có quan hệ**: tiếp tục, đổi điểm nhìn, đổi nơi / thời gian, đối chiếu. Cắt thẳng thường đúng hơn một hiệu ứng chuyển cảnh kéo dài.
- **Engine** (cột trong bảng shot): `premiere` cho ghép lớp thường; `remotion` cho phần cần tính toán (sơ đồ / bản đồ vẽ động, nhiều nhân vật chuyển động đồng bộ với camera, biến hình nhiều lớp). Dựng toàn bộ bằng Remotion thì ghi `remotion` cho tất cả.

## 4. Danh sách ảnh: rút từ bảng shot

Chỉ liệt kê ảnh mà **một shot cụ thể cần**; ảnh không gắn với shot nào là thừa. Mỗi ảnh: **tên file + mô tả** (không viết prompt) + shot dùng nó.
- Nhân vật, Host: chỉ những tư thế các shot thật sự dùng. PNG tách nền.
- Đạo cụ rời (`prop_*`), tiền cảnh che (`fg_*`): tách khỏi bối cảnh chỉ khi chúng chuyển động riêng hoặc che nhân vật.
- Bối cảnh (`bg_*`): đúng tỉ lệ khung hình, dùng lại cho mọi shot cùng nơi; không vẽ sẵn nhân vật; chừa mặt đất trống chỗ nhân vật đứng.

**Quy tắc ghi kèm cho người tạo ảnh:**
- Các pose của **cùng một nhân vật**: cùng kích thước canvas, cùng cỡ người, chân ở cùng chỗ; chỉ đổi tay và nét mặt.
- Nhân vật đứng nguyên người, thấy chân, không cắt mép; ghi hướng mặt (trái / phải).

## 5. Viết `plan/SHOT_PLAN.md` và dừng chờ người dùng

Lưu bằng `save_plan(name: "SHOT_PLAN.md", content: "<markdown>")` theo mẫu:

```markdown
# Shot plan: <tên video>

Mốc là giây toàn phim (tổng <dur> s; ước lượng nếu chưa có voice). Mặc định không chữ trên hình.

## Lập luận biên tập
Hook mở câu hỏi gì; video trả lời bằng cách kể nào; điều người xem hiểu được ở cuối.

## Quy ước hình
- Nhân vật: ai, phía đứng quen thuộc (trái / phải), hướng mặt.
- Hình đại diện cho ý (vật / màu / vị trí nào mang nghĩa gì, giữ suốt phim).
- Nơi chốn: bg nào cho nơi nào.

## Nhân vật và vật xuyên phim
| Tên | Dấu nhận dạng | Các pose / trạng thái dùng | Có mặt ở cụm |
|---|---|---|---|

## Cụm ý
### Cụm 1: <câu hỏi> (<từ>–<đến> s)
Đã biết → cần hiểu → thấy gì → hiểu thêm gì.

| Mốc · từ then chốt | Người xem phải THẤY | Bối cảnh · ai ở chỗ nào | Diễn biến (đầu → đổi → cuối) | Chữ (nếu có) | Engine | Nối shot sau, lý do |
|---|---|---|---|---|---|---|

## Danh sách ảnh
| File | Mô tả | Dùng ở shot |
|---|---|---|

## Bố cục (điền sau khi có ảnh)

## Lỗi thấy khi kiểm
```

Video dài (khoảng 4 phút trở lên): chia **chương** theo câu hỏi (thường 1 đến 2 phút), viết shot chi tiết cho chương nào khi tới chương đó, và cuối mỗi chương ghi **trạng thái cuối** (mỗi nhân vật đang ở đâu, hướng nào, trạng thái gì; bối cảnh cuối) vào file để chương sau đọc lại.

**Tự rà trước khi gửi:** đọc riêng cột "Người xem phải THẤY": có thấy ý phát triển hay chỉ là danh sách vật? Với mỗi ranh giới shot: giữ bố cục cũ có được không, cắt thêm giá trị gì? Mỗi chữ, mỗi lần Host xuất hiện: bỏ đi có mất gì không? Rồi đối chiếu với "Dấu hiệu làm sai".

Gửi người dùng lập luận biên tập, bảng cụm / shot và danh sách ảnh, rồi **dừng chờ** người dùng duyệt và tạo ảnh.

## 6. Bố cục, sau khi có ảnh (mục "Bố cục" của SHOT_PLAN.md)

1. **Đo PNG:** `list_media` trả mỗi ảnh, ví dụ `m7 images/char_a.png 2000x2000, figure x 0.31-0.70 y 0.09-0.97 (780x1760 px), feet 0.50,0.97`:
   - `figure`: khung bao sát phần có hình (tỉ lệ 0 đến 1 của canvas).
   - `feet`: giữa đáy phần có hình, là điểm chạm đất và điểm xoay.
   - `opaque` ở ảnh nhân vật / đạo cụ: chưa tách nền; báo người dùng, hoặc `remove_background` nếu họ đồng ý.
   - Ảnh thiếu hay sai so với danh sách: báo người dùng; không tự thay bằng ảnh khác.
2. **Mở từng `bg_*` ra xem** và ghi cho mỗi bg:
   - đường đất (tỉ lệ `y`, 0 trên, 1 dưới; dốc thì vài điểm);
   - chỗ **gần** (chân thấp, người to) và **xa** (chân gần chân trời, người nhỏ), mỗi chỗ có `x`, `y` của chân và chiều cao người `t` (tỉ lệ chiều cao khung), theo đúng phối cảnh của tranh;
   - mặt đặt đồ vật (mặt bàn, tảng đá), vùng đặt chữ, vùng không được che.
3. Đặt tên các chỗ (`near-left`, `far-center`, `table`, `text-top`...) và điền tên chỗ vào cột "ai ở chỗ nào" của bảng shot. Mọi pose của một nhân vật trong một shot dùng chung chỗ và chung `t`.
4. Ghi bảng bố cục: mỗi bg với các chỗ; mỗi ảnh với `W x H`, `figure`, `feet`. Skill dựng tính vị trí từ đây.
5. **Bối cảnh đứng yên** trừ khi một shot ghi rõ cần zoom vào chi tiết; khi đó mọi lớp của shot zoom cùng.

Xong mục này thì báo người dùng và chuyển sang skill dựng theo engine đã chọn.
