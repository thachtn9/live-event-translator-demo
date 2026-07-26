export const DEFAULT_TRANSLATION_MODEL = "gemini-3.5-live-translate-preview";
export const AUTH_TOKENS_URL =
  "https://generativelanguage.googleapis.com/v1alpha/auth_tokens";
export const LIVE_WS_CONSTRAINED_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";

const LANGUAGE_TAG_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}$/;
const SUPPORTED_TRANSLATION_LANGUAGES = new Set([
  "es",
  "pt",
  "fr",
  "ja",
  "ru",
  "zh",
  "de",
  "ko",
  "hi",
  "id",
  "vi",
  "it",
  "en",
]);

const GEMINI_LANGUAGE_ALIASES = {
  zh: "zh-Hans",
  pt: "pt-BR",
};

export function normalizeTargetLanguage(targetLanguage) {
  if (typeof targetLanguage !== "string" || !targetLanguage.trim()) {
    throw new Error("Cần mã ngôn ngữ đích.");
  }

  const normalized = targetLanguage.trim().toLowerCase();
  if (!LANGUAGE_TAG_PATTERN.test(normalized)) {
    throw new Error("Dùng mã ngôn ngữ gọn như es, fr, pt, hoặc zh.");
  }
  if (!SUPPORTED_TRANSLATION_LANGUAGES.has(normalized)) {
    throw new Error(
      "Dùng mã ngôn ngữ được hỗ trợ: es, pt, fr, ja, ru, zh, de, ko, hi, id, vi, it, hoặc en.",
    );
  }

  return normalized;
}

export function toGeminiLanguageCode(targetLanguage) {
  const normalized = normalizeTargetLanguage(targetLanguage);
  return GEMINI_LANGUAGE_ALIASES[normalized] ?? normalized;
}

export function buildBidiSetup({
  targetLanguage,
  model = DEFAULT_TRANSLATION_MODEL,
  echoTargetLanguage = true,
}) {
  const language = toGeminiLanguageCode(targetLanguage);
  return {
    model: `models/${model}`,
    generationConfig: {
      responseModalities: ["AUDIO"],
      translationConfig: {
        targetLanguageCode: language,
        echoTargetLanguage,
      },
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
}

export function buildLiveWsUrl(ephemeralToken) {
  if (!ephemeralToken || typeof ephemeralToken !== "string") {
    throw new Error("Cần ephemeral token.");
  }
  const url = new URL(LIVE_WS_CONSTRAINED_BASE);
  url.searchParams.set("access_token", ephemeralToken);
  return url.toString();
}

export function buildEphemeralTokenRequest({
  apiKey,
  targetLanguage,
  model = DEFAULT_TRANSLATION_MODEL,
  echoTargetLanguage = true,
  now = Date.now(),
}) {
  if (!apiKey) {
    throw new Error("Cần Gemini API key. Mở Cài đặt extension để nhập key.");
  }

  const language = normalizeTargetLanguage(targetLanguage);
  const bidiGenerateContentSetup = buildBidiSetup({
    targetLanguage: language,
    model,
    echoTargetLanguage,
  });
  const body = {
    uses: 1,
    expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
    newSessionExpireTime: new Date(now + 1 * 60 * 1000).toISOString(),
    bidiGenerateContentSetup,
  };

  return {
    url: AUTH_TOKENS_URL,
    init: {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    language,
    model,
    setup: { setup: bidiGenerateContentSetup },
    expireTime: body.expireTime,
  };
}

export async function createEphemeralToken({
  apiKey,
  targetLanguage,
  model,
  echoTargetLanguage,
  now,
  fetchImpl = fetch,
}) {
  const request = buildEphemeralTokenRequest({
    apiKey,
    targetLanguage,
    model,
    echoTargetLanguage,
    now,
  });

  let response;
  try {
    response = await fetchImpl(request.url, request.init);
  } catch (error) {
    throw new GeminiNetworkError(error);
  }

  if (!response.ok) {
    throw new GeminiRequestError(
      response.status,
      await readResponseBodySafely(response),
    );
  }

  const data = await response.json();
  const tokenName = typeof data?.name === "string" ? data.name : null;
  if (!tokenName) {
    throw new Error("Gemini không trả về ephemeral token.");
  }

  return {
    ephemeral_token: tokenName,
    expires_at: request.expireTime,
    model: request.model,
    setup: request.setup,
    targetLanguage: request.language,
    ws_url: buildLiveWsUrl(tokenName),
  };
}

export class GeminiRequestError extends Error {
  constructor(status, body) {
    super(describeRequestFailure(status, body));
    this.name = "GeminiRequestError";
    this.status = status;
    this.body = body;
  }
}

export class GeminiNetworkError extends Error {
  constructor(cause) {
    const detail = describeNetworkError(cause);
    super(
      `Không kết nối được Gemini API${detail ? ` (${detail})` : ""}. ` +
        "Kiểm tra mạng hoặc thử lại sau.",
    );
    this.name = "GeminiNetworkError";
    this.cause = cause;
  }
}

function describeRequestFailure(status, body) {
  if (status === 400) {
    return "Yêu cầu Gemini không hợp lệ. Kiểm tra API key và ngôn ngữ đích.";
  }
  if (status === 401 || status === 403) {
    return "API key Gemini bị từ chối. Mở Cài đặt extension và kiểm tra lại key.";
  }
  if (status === 429) {
    return "Gemini đang giới hạn tốc độ. Thử lại sau ít phút.";
  }
  const snippet =
    typeof body === "string" && body.trim()
      ? ` Chi tiết: ${body.trim().slice(0, 180)}`
      : "";
  return `Gemini trả lỗi HTTP ${status}.${snippet}`;
}

function describeNetworkError(error) {
  const cause = error?.cause ?? error;
  if (!cause) {
    return "";
  }
  if (cause.code) {
    return String(cause.code);
  }
  if (cause.cause?.code) {
    return String(cause.cause.code);
  }
  if (typeof cause.message === "string" && cause.message) {
    return cause.message;
  }
  return "";
}

async function readResponseBodySafely(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
