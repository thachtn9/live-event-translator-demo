export const POLISH_BATCH_SIZE = 18;
export const DEFAULT_POLISH_MODEL = "gemini-2.5-flash-lite";
export const POLISH_MODEL_FALLBACKS = [
  "gemini-2.0-flash-lite",
  "gemini-2.5-flash",
];

const SENTENCE_END = /([.!?…。！？]+)(?:\s+|$)/g;

export function countCompletedSentences(text) {
  if (!text) return 0;
  const matches = String(text).match(/[.!?…。！？]+/g);
  return matches ? matches.length : 0;
}

export function takeCompletedBatch(pendingRawText, batchSize = POLISH_BATCH_SIZE) {
  const pending = String(pendingRawText ?? "");
  if (countCompletedSentences(pending) < batchSize) {
    return null;
  }

  let seen = 0;
  let endIndex = -1;
  const re = new RegExp(SENTENCE_END.source, "g");
  let match;
  while ((match = re.exec(pending)) !== null) {
    seen += 1;
    if (seen === batchSize) {
      endIndex = match.index + match[0].length;
      break;
    }
  }
  if (endIndex < 0) {
    return null;
  }

  return {
    batchText: pending.slice(0, endIndex).trimEnd(),
    rest: pending.slice(endIndex),
  };
}

export function takeAllCompletedAndRest(pendingRawText) {
  const pending = String(pendingRawText ?? "");
  if (!pending.trim()) {
    return { batchText: "", rest: "" };
  }

  let endIndex = -1;
  const re = new RegExp(SENTENCE_END.source, "g");
  let match;
  while ((match = re.exec(pending)) !== null) {
    endIndex = match.index + match[0].length;
  }

  if (endIndex < 0) {
    return { batchText: pending.trim(), rest: "" };
  }

  const batchText = pending.slice(0, endIndex).trimEnd();
  const rest = pending.slice(endIndex);
  if (!batchText && rest.trim()) {
    return { batchText: rest.trim(), rest: "" };
  }
  return { batchText, rest };
}

export function buildPolishPrompt(batchText) {
  return [
    "Bạn là biên tập viên. Hãy làm sạch đoạn văn bản dịch sau:",
    "- Chỉ sửa lỗi chính tả, dấu câu, viết hoa, và nối câu cho mạch lạc.",
    "- Giữ nguyên ý nghĩa và ngôn ngữ; không tóm tắt; không thêm thông tin mới; không bỏ nội dung.",
    "- Trả về plain text only, không markdown.",
    "",
    "Văn bản:",
    String(batchText ?? "").trim(),
  ].join("\n");
}

export function parseGenerateContentText(payload) {
  const text = payload?.candidates?.[0]?.content?.parts
    ?.map((part) => part?.text ?? "")
    .join("")
    .trim();
  if (!text) {
    throw new Error("Gemini không trả về văn bản đã làm sạch.");
  }
  return text;
}

export function buildSaveFilename(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `ban-dich-${y}${m}${d}-${hh}${mm}.txt`;
}

export function joinDisplay(polishedText, pendingRawText) {
  return `${polishedText ?? ""}${pendingRawText ?? ""}`;
}
