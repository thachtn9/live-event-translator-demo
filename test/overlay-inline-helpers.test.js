import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const OVERLAY_PATH = new URL("../extension/content/overlay.js", import.meta.url);
const LIB_PATH = new URL("../extension/lib/polish-text.js", import.meta.url);

// overlay.js là classic script nên phải chép tay các helper từ lib; test này
// bắt lỗi lệch bản sao.
const MIRRORED = [
  "countCompletedSentences",
  "isPolishCooldownActive",
  "isImplausiblePolish",
];

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `không tìm thấy function ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return normalize(source.slice(start, i + 1));
      }
    }
  }
  throw new Error(`function ${name} không đóng ngoặc`);
}

function normalize(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//"))
    .join("\n");
}

test("overlay inline helpers match extension/lib/polish-text.js", async () => {
  const [overlaySource, libSource] = await Promise.all([
    readFile(OVERLAY_PATH, "utf8"),
    readFile(LIB_PATH, "utf8"),
  ]);

  for (const name of MIRRORED) {
    assert.equal(
      extractFunction(overlaySource, name),
      extractFunction(libSource, name),
      `bản sao ${name} trong overlay.js đã lệch so với lib`,
    );
  }
});

test("overlay constants match polish-text constants", async () => {
  const overlaySource = await readFile(OVERLAY_PATH, "utf8");
  const lib = await import("../extension/lib/polish-text.js");
  const pairs = [
    ["POLISH_BATCH_SIZE", lib.POLISH_BATCH_SIZE],
    ["POLISH_FAILURE_COOLDOWN_MS", lib.POLISH_FAILURE_COOLDOWN_MS],
    ["MIN_POLISH_LENGTH_RATIO", lib.MIN_POLISH_LENGTH_RATIO],
    ["MIN_POLISH_LENGTH_CHECK", lib.MIN_POLISH_LENGTH_CHECK],
  ];
  for (const [name, expected] of pairs) {
    const match = overlaySource.match(new RegExp(`const ${name} = ([^;]+);`));
    assert.ok(match, `overlay.js thiếu hằng ${name}`);
    assert.equal(Number(match[1]), expected);
  }
});
