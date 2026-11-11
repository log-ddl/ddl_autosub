import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractDialogueTags,
  findUnclosedDialogueTag,
  insertDialogueTagAtCursor,
  parseDialoguePreviewTurns,
} from "../src/components/tts/dialogue-tags";

test("extractDialogueTags finds paired speaker tags and ignores single brackets or emotions", () => {
  const script = `
Trời đã khuya trên bến cảng [theo báo cáo] [1] và [1].
Nam khẽ hỏi: [A] Anh có nghe thấy tiếng bước chân không? [A] [laugh]
Lan mỉm cười đáp: [B] Chỉ là gió biển thôi. [/B]
[a]
Không, có người đang tới!
[a]
[Narrator] Bóng tối bao trùm con hẻm nhỏ. [Narrator]
`;
  assert.deepEqual(extractDialogueTags(script), ["A", "B"]);
});

test("parseDialoguePreviewTurns handles inline and multiline [A]...[A] with narrator outside", () => {
  const script = [
    "Mở đầu câu chuyện. Nam quay sang hỏi: [A] Chào cậu, lâu quá không gặp! [A] Lan đáp: [B] Ừ, gần ba năm rồi nhỉ. [B]",
    "[A]",
    "Cậu vẫn làm ở xưởng cũ chứ?",
    "Tớ mới chuyển về đây tuần trước.",
    "[A]",
    "Hai người lặng lẽ bước dọc bờ sông.",
  ].join("\n");

  const turns = parseDialoguePreviewTurns(script);
  assert.deepEqual(turns, [
    {
      speaker: "narrator",
      isNarrator: true,
      text: "Mở đầu câu chuyện. Nam quay sang hỏi:",
    },
    { speaker: "A", isNarrator: false, text: "Chào cậu, lâu quá không gặp!" },
    { speaker: "narrator", isNarrator: true, text: "Lan đáp:" },
    { speaker: "B", isNarrator: false, text: "Ừ, gần ba năm rồi nhỉ." },
    {
      speaker: "A",
      isNarrator: false,
      text: "Cậu vẫn làm ở xưởng cũ chứ?\nTớ mới chuyển về đây tuần trước.",
    },
    {
      speaker: "narrator",
      isNarrator: true,
      text: "Hai người lặng lẽ bước dọc bờ sông.",
    },
  ]);
});

test("insertDialogueTagAtCursor inserts [TAG]  [TAG] or wraps selected text", () => {
  const empty = insertDialogueTagAtCursor("", "ID1", 0, 0);
  assert.equal(empty.text, "[ID1]  [ID1]");
  assert.equal(empty.cursor, 6);

  const midSentence = insertDialogueTagAtCursor("Nam hỏi:", "A", 8, 8);
  assert.equal(midSentence.text, "Nam hỏi: [A]  [A]");
  assert.equal(midSentence.cursor, 13);

  const wrapped = insertDialogueTagAtCursor(
    "Nam hỏi: Đi đâu đấy? Rồi cười.",
    "A",
    9,
    20,
  );
  assert.equal(wrapped.text, "Nam hỏi: [A] Đi đâu đấy? [A] Rồi cười.");
});

test("findUnclosedDialogueTag detects unclosed speaker tags", () => {
  assert.equal(
    findUnclosedDialogueTag("Theo báo cáo [ghi chú] hôm nay.", []),
    null,
  );
  assert.deepEqual(findUnclosedDialogueTag("[A] Quên đóng thẻ\nDòng 2", []), {
    tag: "A",
    lineEndOffset: 17,
  });
  assert.deepEqual(
    findUnclosedDialogueTag(
      "Mở đầu [A] Đã đóng [A] rồi [A] quên đóng ở giữa dòng",
      [],
    ),
    {
      tag: "A",
      lineEndOffset: 52,
    },
  );
});
