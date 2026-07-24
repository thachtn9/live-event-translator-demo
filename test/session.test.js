import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_TRANSLATION_MODEL,
  AUTH_TOKENS_URL,
  LIVE_WS_CONSTRAINED_BASE,
  buildEphemeralTokenRequest,
  buildLiveSetup,
  buildLiveWsUrl,
  normalizeTargetLanguage,
  toGeminiLanguageCode,
} from "../src/session.js";

test("normalizeTargetLanguage accepts compact BCP-47 style tags", () => {
  assert.equal(normalizeTargetLanguage(" ES "), "es");
  assert.equal(normalizeTargetLanguage("PT"), "pt");
  assert.equal(normalizeTargetLanguage("zh"), "zh");
  assert.equal(normalizeTargetLanguage("vi"), "vi");
});

test("normalizeTargetLanguage rejects missing or unsafe values", () => {
  assert.throws(() => normalizeTargetLanguage(""), /target language/i);
  assert.throws(() => normalizeTargetLanguage("english"), /language code/i);
  assert.throws(() => normalizeTargetLanguage("pt-br"), /supported target language/i);
  assert.throws(() => normalizeTargetLanguage("zh-hans"), /supported target language/i);
  assert.throws(() => normalizeTargetLanguage("../es"), /language code/i);
});

test("toGeminiLanguageCode maps UI codes to Gemini Live Translate codes", () => {
  assert.equal(toGeminiLanguageCode("zh"), "zh-Hans");
  assert.equal(toGeminiLanguageCode("pt"), "pt-BR");
  assert.equal(toGeminiLanguageCode("vi"), "vi");
  assert.equal(toGeminiLanguageCode(" ES "), "es");
});

test("buildLiveSetup builds a Gemini Live Translate setup message", () => {
  assert.deepEqual(buildLiveSetup({ targetLanguage: " VI " }), {
    setup: {
      model: `models/${DEFAULT_TRANSLATION_MODEL}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        translationConfig: {
          targetLanguageCode: "vi",
          echoTargetLanguage: true,
        },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  });
});

test("buildEphemeralTokenRequest builds a constrained auth token payload", () => {
  const now = Date.parse("2026-07-24T10:00:00.000Z");
  const request = buildEphemeralTokenRequest({
    apiKey: "test-api-key",
    targetLanguage: " ES ",
    now,
  });

  assert.equal(request.url, AUTH_TOKENS_URL);
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers["x-goog-api-key"], "test-api-key");
  assert.equal(request.init.headers["Content-Type"], "application/json");

  const body = JSON.parse(request.init.body);
  assert.equal(body.uses, 1);
  assert.equal(body.expireTime, "2026-07-24T10:30:00.000Z");
  assert.equal(body.newSessionExpireTime, "2026-07-24T10:01:00.000Z");
  assert.deepEqual(body.bidiGenerateContentSetup, {
    model: `models/${DEFAULT_TRANSLATION_MODEL}`,
    generationConfig: {
      responseModalities: ["AUDIO"],
      translationConfig: {
        targetLanguageCode: "es",
        echoTargetLanguage: true,
      },
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  });
  assert.equal(request.language, "es");
  assert.equal(request.model, DEFAULT_TRANSLATION_MODEL);
});

test("buildLiveWsUrl uses the constrained v1alpha endpoint", () => {
  const url = buildLiveWsUrl("auth_tokens/abc123");
  assert.equal(
    url,
    `${LIVE_WS_CONSTRAINED_BASE}?access_token=${encodeURIComponent("auth_tokens/abc123")}`,
  );
});
