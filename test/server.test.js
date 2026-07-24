import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { DEFAULT_TRANSLATION_MODEL } from "../src/session.js";
import { buildServer, getListenHost } from "../src/server.js";

async function withServer(options, run) {
  const server = buildServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    server.close();
    await once(server, "close");
  }
}

test("serves the browser app from the root route", async () => {
  await withServer({ env: { GEMINI_API_KEY: "test-key" } }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(body, /Live Event Translator/);
    assert.match(body, /Choose event tab/);
    assert.doesNotMatch(body, /Start translating</);
    assert.doesNotMatch(body, /OpenAI Developers/);
    assert.doesNotMatch(body, /class="topbar"/);
    assert.doesNotMatch(body, /Open a tab that is already playing audio/);
  });
});

test("uses localhost by default and allows the listen host to be configured", () => {
  assert.equal(getListenHost({}), "127.0.0.1");
  assert.equal(getListenHost({ HOST: "0.0.0.0" }), "0.0.0.0");
});

test("serves the source speech WAV as audio", async () => {
  await withServer({ env: { GEMINI_API_KEY: "test-key" } }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/source-speech.wav`, { method: "HEAD" });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /audio\/wav/);
  });
});

test("serves browser app code that connects to translation over WebSocket", async () => {
  await withServer({ env: { GEMINI_API_KEY: "test-key" } }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/app.js`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /new WebSocket/);
    assert.match(body, /BidiGenerateContentConstrained|ws_url|ephemeral_token/);
    assert.doesNotMatch(body, /RTCPeerConnection/);
    assert.doesNotMatch(body, /realtime\/translations\/calls/);
  });
});

test("POST /session validates target language before calling Gemini", async () => {
  let calls = 0;
  await withServer(
    {
      env: { GEMINI_API_KEY: "test-key" },
      fetchImpl: async () => {
        calls += 1;
        throw new Error("fetch should not be called");
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetLanguage: "english" }),
      });
      const body = await response.json();

      assert.equal(response.status, 400);
      assert.match(body.error, /language code/i);
      assert.equal(calls, 0);
    },
  );
});

test("POST /session returns a browser-safe Gemini ephemeral token response", async () => {
  const requests = [];
  await withServer(
    {
      env: { GEMINI_API_KEY: "test-key" },
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return Response.json({
          name: "auth_tokens/ek_test",
        });
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetLanguage: "es" }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ephemeral_token, "auth_tokens/ek_test");
      assert.equal(body.model, DEFAULT_TRANSLATION_MODEL);
      assert.equal(body.targetLanguage, "es");
      assert.match(body.ws_url, /BidiGenerateContentConstrained/);
      assert.match(body.ws_url, /access_token=/);
      assert.equal(body.setup.setup.generationConfig.translationConfig.targetLanguageCode, "es");
      assert.equal(requests.length, 1);
      assert.equal(requests[0].init.headers["x-goog-api-key"], "test-key");
      const requestBody = JSON.parse(requests[0].init.body);
      assert.equal(
        requestBody.bidiGenerateContentSetup.generationConfig.translationConfig
          .targetLanguageCode,
        "es",
      );
    },
  );
});

test("POST /session reports missing GEMINI_API_KEY", async () => {
  await withServer({ env: {} }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetLanguage: "vi" }),
    });
    const body = await response.json();

    assert.equal(response.status, 500);
    assert.match(body.error, /GEMINI_API_KEY/);
  });
});
