import assert from "node:assert/strict";
import test from "node:test";

async function importPolishText() {
  return import("../extension/lib/polish-text.js");
}

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

test("joinDisplay concatenates polished and pending", async () => {
  const { joinDisplay } = await importPolishText();
  assert.equal(joinDisplay("A. ", "B."), "A. B.");
  assert.equal(joinDisplay("A.", ""), "A.");
});
