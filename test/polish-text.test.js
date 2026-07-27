import assert from "node:assert/strict";
import test from "node:test";

async function importPolishText() {
  return import("../extension/lib/polish-text.js");
}

test("countCompletedSentences uses SENTENCE_END like batch splitters", async () => {
  const { countCompletedSentences, takeCompletedBatch, takeAllCompletedAndRest } =
    await importPolishText();

  assert.equal(countCompletedSentences("A.B.C."), 1);
  assert.equal(countCompletedSentences("A. B. C."), 3);

  assert.equal(takeCompletedBatch("A.B.C.", 1)?.batchText, "A.B.C.");
  assert.equal(takeCompletedBatch("A.B.C.", 2), null);

  assert.deepEqual(takeAllCompletedAndRest("A.B.C. tail"), {
    batchText: "A.B.C.",
    rest: "tail",
  });
});

test("takeCompletedBatch returns null until batch size is reached", async () => {
  const { takeCompletedBatch, POLISH_BATCH_SIZE } = await importPolishText();
  const partial = Array.from({ length: POLISH_BATCH_SIZE - 1 }, (_, i) => `Câu ${i + 1}.`).join(" ");
  assert.equal(takeCompletedBatch(partial), null);
});

test("takeCompletedBatch splits completed prefix and leaves trailing fragment", async () => {
  const { takeCompletedBatch } = await importPolishText();
  const sentences = Array.from({ length: 18 }, (_, i) => `Câu ${i + 1}.`);
  const pending = `${sentences.join(" ")} và đoạn chưa hết`;
  const result = takeCompletedBatch(pending, 18);
  assert.ok(result);
  assert.match(result.batchText, /Câu 18\./);
  assert.equal(result.rest, "và đoạn chưa hết");
  assert.equal(result.batchText.includes("và đoạn chưa hết"), false);
});

test("takeAllCompletedAndRest flushes leftover text on stop", async () => {
  const { takeAllCompletedAndRest } = await importPolishText();
  assert.deepEqual(takeAllCompletedAndRest("Xin chào. Phần dở"), {
    batchText: "Xin chào.",
    rest: "Phần dở",
  });
  assert.deepEqual(takeAllCompletedAndRest("chỉ một đoạn"), {
    batchText: "chỉ một đoạn",
    rest: "",
  });
});

test("buildPolishPrompt asks for clean edit only", async () => {
  const { buildPolishPrompt } = await importPolishText();
  const prompt = buildPolishPrompt("Hello. World.");
  assert.match(prompt, /không/i);
  assert.match(prompt, /Hello\. World\./);
});

test("parseGenerateContentText reads Gemini candidate text", async () => {
  const { parseGenerateContentText } = await importPolishText();
  const text = parseGenerateContentText({
    candidates: [{ content: { parts: [{ text: "  Sạch sẽ.  " }] } }],
  });
  assert.equal(text, "Sạch sẽ.");
});

test("buildSaveFilename uses ban-dich stamp", async () => {
  const { buildSaveFilename } = await importPolishText();
  const name = buildSaveFilename(new Date(2026, 6, 27, 9, 5));
  assert.equal(name, "ban-dich-20260727-0905.txt");
});

test("isPolishCooldownActive blocks auto retry until timer or a new full batch", async () => {
  const { isPolishCooldownActive, POLISH_FAILURE_COOLDOWN_MS, POLISH_BATCH_SIZE } =
    await importPolishText();
  const failure = { at: 1000, pendingCompleted: 20 };

  assert.equal(isPolishCooldownActive(null, { now: 1000, pendingCompleted: 99 }), false);

  // Mỗi delta transcript ngay sau lỗi phải bị chặn, không gọi lại API.
  for (let i = 0; i < 5; i += 1) {
    assert.equal(
      isPolishCooldownActive(failure, { now: 1000 + i * 100, pendingCompleted: 20 + i }),
      true,
    );
  }

  assert.equal(
    isPolishCooldownActive(failure, {
      now: 1000 + POLISH_FAILURE_COOLDOWN_MS,
      pendingCompleted: 20,
    }),
    false,
  );
  assert.equal(
    isPolishCooldownActive(failure, {
      now: 1500,
      pendingCompleted: 20 + POLISH_BATCH_SIZE,
    }),
    false,
  );
  assert.equal(
    isPolishCooldownActive(failure, {
      now: 1500,
      pendingCompleted: 20 + POLISH_BATCH_SIZE - 1,
    }),
    true,
  );
});

test("isImplausiblePolish rejects empty or truncated cleaned text", async () => {
  const { isImplausiblePolish } = await importPolishText();
  const batch = Array.from({ length: 6 }, (_, i) => `Câu số ${i + 1} khá dài.`).join(" ");

  assert.equal(isImplausiblePolish("", batch), true);
  assert.equal(isImplausiblePolish("   ", batch), true);
  assert.equal(isImplausiblePolish("Tóm tắt ngắn.", batch), true);
  assert.equal(isImplausiblePolish(batch, batch), false);
  assert.equal(isImplausiblePolish(`${batch} thêm chút.`, batch), false);
  // Batch ngắn thì không áp tỉ lệ: làm sạch có thể cắt bớt hợp lệ.
  assert.equal(isImplausiblePolish("Ok.", "uh ok."), false);
});

test("joinDisplay concatenates polished and pending", async () => {
  const { joinDisplay } = await importPolishText();
  assert.equal(joinDisplay("A. ", "B."), "A. B.");
  assert.equal(joinDisplay("A.", ""), "A.");
});
