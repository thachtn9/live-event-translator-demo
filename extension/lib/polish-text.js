export const POLISH_BATCH_SIZE = 5;
export const DEFAULT_POLISH_MODEL = "gemini-3.5-flash-lite";
export const POLISH_MODEL_FALLBACKS = [
  "gemini-2.5-flash",
  "gemini-2.0-flash-lite",
];
export const POLISH_FAILURE_COOLDOWN_MS = 30000;
export const MIN_POLISH_LENGTH_RATIO = 0.4;
export const MIN_POLISH_LENGTH_CHECK = 40;

export const POLISH_LANGUAGE_NAMES = {
  vi: "Vietnamese",
  en: "English",
  es: "Spanish",
  pt: "Portuguese",
  fr: "French",
  ja: "Japanese",
  ru: "Russian",
  zh: "Chinese",
  de: "German",
  ko: "Korean",
  hi: "Hindi",
  id: "Indonesian",
  it: "Italian",
};

const SENTENCE_END = /([.!?…。！？]+)(?:\s+|$)/g;

export function countCompletedSentences(text) {
  if (!text) return 0;
  const re = new RegExp(SENTENCE_END.source, "g");
  let count = 0;
  while (re.exec(String(text)) !== null) {
    count += 1;
  }
  return count;
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

// Sau một lần làm sạch lỗi, chỉ thử lại khi đã hết cooldown hoặc đã dồn thêm
// trọn một batch mới — nếu không mỗi delta transcript sẽ gọi lại API liên tục.
export function isPolishCooldownActive(failure, options = {}) {
  if (!failure) {
    return false;
  }
  const {
    now = Date.now(),
    pendingCompleted = 0,
    cooldownMs = POLISH_FAILURE_COOLDOWN_MS,
    batchSize = POLISH_BATCH_SIZE,
  } = options;
  if (now - Number(failure.at ?? 0) >= cooldownMs) {
    return false;
  }
  if (pendingCompleted - Number(failure.pendingCompleted ?? 0) >= batchSize) {
    return false;
  }
  return true;
}

// Model đôi khi trả về tóm tắt hoặc chuỗi rỗng: coi như thất bại thay vì thay
// thế nguyên batch thô bằng vài chữ.
export function isImplausiblePolish(cleaned, batchText, options = {}) {
  const {
    ratio = MIN_POLISH_LENGTH_RATIO,
    minLength = MIN_POLISH_LENGTH_CHECK,
  } = options;
  const source = String(batchText ?? "").trim();
  const result = String(cleaned ?? "").trim();
  if (!result) {
    return true;
  }
  if (source.length <= minLength) {
    return false;
  }
  return result.length < source.length * ratio;
}

export function resolvePolishLanguageName(targetLanguage) {
  const code = String(targetLanguage ?? "")
    .trim()
    .toLowerCase()
    .split("-")[0];
  return POLISH_LANGUAGE_NAMES[code] || POLISH_LANGUAGE_NAMES.en;
}

/** Lấy N đoạn đã chuẩn hóa cuối cùng để nối mạch với batch mới. */
export function takeTrailingPolishedParagraphs(polishedText, count = 1) {
  const paragraphs = splitDisplayParagraphs(polishedText);
  if (!paragraphs.length || count <= 0) {
    return "";
  }
  return paragraphs.slice(-count).join("\n\n");
}

/** Bỏ N đoạn cuối — phần sẽ được gửi lại cùng batch mới. */
export function dropTrailingPolishedParagraphs(polishedText, count = 1) {
  const paragraphs = splitDisplayParagraphs(polishedText);
  if (!paragraphs.length || count <= 0) {
    return String(polishedText ?? "").trim();
  }
  if (count >= paragraphs.length) {
    return "";
  }
  return paragraphs.slice(0, -count).join("\n\n");
}

export function buildPolishInputWithOverlap(
  polishedText,
  batchText,
  overlapParagraphs = 1,
) {
  const batch = String(batchText ?? "").trim();
  const overlap = takeTrailingPolishedParagraphs(polishedText, overlapParagraphs);
  if (!overlap) {
    return { polishInput: batch, overlapParagraphs: 0 };
  }
  return {
    polishInput: `${overlap}\n\n${batch}`,
    overlapParagraphs,
  };
}

export function mergePolishedResult(polishedText, cleaned, overlapParagraphs = 0) {
  const cleanedNorm = normalizePolishedParagraphs(cleaned);
  if (!overlapParagraphs) {
    return cleanedNorm;
  }
  const prefix = dropTrailingPolishedParagraphs(polishedText, overlapParagraphs);
  if (!prefix) {
    return cleanedNorm;
  }
  return normalizePolishedParagraphs(`${prefix}\n\n${cleanedNorm}`);
}

export function buildPolishPrompt(batchText, targetLanguage = "en", { hasOverlap = false } = {}) {
  const languageName = resolvePolishLanguageName(targetLanguage);
  const lines = [
    `You are an editor. Clean up the following translated transcript in ${languageName}:`,
    `- Fix spelling, punctuation, capitalization, and sentence flow in ${languageName} only.`,
    `- Keep the meaning and keep the text in ${languageName}; do not translate to another language.`,
    "- Do not summarize; do not add new information; do not remove content.",
    "- Split into logical paragraphs by topic/idea (usually 1–3 sentences each).",
    "- Separate paragraphs with exactly one blank line.",
    "- Return plain text only, no markdown, no paragraph numbering.",
  ];
  if (hasOverlap) {
    lines.push(
      "- The text may start with an already-edited segment followed by new raw transcript.",
      "- Merge them seamlessly at the boundary; do not leave awkward gaps or duplicate breaks.",
    );
  }
  lines.push("", "Text:", String(batchText ?? "").trim());
  return lines.join("\n");
}

/** Chuẩn hóa xuống dòng: giữ ngắt đoạn, bỏ khoảng trắng thừa. */
export function normalizePolishedParagraphs(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .trim()
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** Tách bản hiển thị thành các đoạn (ngăn bởi dòng trống). */
export function splitDisplayParagraphs(display) {
  return String(display ?? "")
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
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
  const polished = String(polishedText ?? "").trimEnd();
  const pending = String(pendingRawText ?? "").trim();
  if (!polished) {
    return pending;
  }
  if (!pending) {
    return polished;
  }
  return `${polished}\n\n${pending}`;
}
