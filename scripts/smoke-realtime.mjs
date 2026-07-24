import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_TRANSLATION_MODEL,
  createEphemeralToken,
} from "../src/session.js";
import { loadEnvFiles } from "../src/server.js";
import {
  PCM16_100MS_CHUNK_BYTES,
  PCM16_INPUT_SAMPLE_RATE,
} from "../src/public/audio-chunks.js";

const TARGET_LANGUAGE = process.env.SMOKE_TARGET_LANGUAGE ?? "es";
const PHRASE =
  process.env.SMOKE_PHRASE ??
  "Hello, this is a browser tab audio translation test.";

loadEnvFiles(process.env, process.cwd());

if (!process.env.GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is not configured.");
}

const session = await createEphemeralToken({
  apiKey: process.env.GEMINI_API_KEY,
  targetLanguage: TARGET_LANGUAGE,
  model: process.env.GEMINI_TRANSLATION_MODEL ?? DEFAULT_TRANSLATION_MODEL,
});

const audio = createSpeechPcm16(PHRASE) ?? Buffer.alloc(PCM16_INPUT_SAMPLE_RATE * 2);
const usedSpeech = audio.some((byte) => byte !== 0);
const result = await runWebSocketSmoke({ session, audio, requireOutput: usedSpeech });

console.log(
  JSON.stringify(
    {
      ok: true,
      mode: usedSpeech ? "speech" : "silence",
      targetLanguage: session.targetLanguage,
      setupComplete: result.setupComplete,
      outputAudioChunks: result.outputAudioChunks,
      outputTranscriptPreview: result.outputTranscript.slice(0, 160),
    },
    null,
    2,
  ),
);

async function runWebSocketSmoke({ session, audio, requireOutput }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(session.ws_url);

    const state = {
      setupComplete: false,
      outputAudioChunks: 0,
      outputTranscript: "",
      sending: false,
      sent: false,
    };
    let settled = false;

    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      ws.close();
      if (error) {
        reject(error);
        return;
      }
      resolve(state);
    };

    const timeout = setTimeout(() => {
      if (!state.setupComplete) {
        finish(new Error("Gemini Live session was not set up before timeout."));
        return;
      }
      if (requireOutput && state.outputAudioChunks === 0 && !state.outputTranscript) {
        finish(new Error("Gemini Live session produced no translated output before timeout."));
        return;
      }
      finish();
    }, requireOutput ? 25_000 : 5_000);

    ws.addEventListener("error", () => {
      finish(new Error("Gemini Live WebSocket error."));
    });

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify(session.setup));
    });

    ws.addEventListener("message", async (message) => {
      let event;
      try {
        event = JSON.parse(await messageToText(message.data));
      } catch (error) {
        finish(error);
        return;
      }

      if (event.error) {
        finish(new Error(JSON.stringify(event.error)));
        return;
      }

      if (event.setupComplete) {
        state.setupComplete = true;
        void sendAudioAndMaybeFinish(ws, audio, state, requireOutput, finish);
      }

      const content = event.serverContent;
      if (content?.outputTranscription?.text) {
        state.outputTranscript += content.outputTranscription.text;
      }

      if (content?.modelTurn?.parts) {
        for (const part of content.modelTurn.parts) {
          if (part.inlineData?.data) {
            state.outputAudioChunks += 1;
          }
        }
      }

      if (
        state.setupComplete &&
        state.sent &&
        (!requireOutput || state.outputAudioChunks > 0 || state.outputTranscript)
      ) {
        finish();
      }
    });
  });
}

async function sendAudioAndMaybeFinish(ws, audio, state, requireOutput, finish) {
  if (state.sending || state.sent) {
    return;
  }
  state.sending = true;
  try {
    await sendAudio(ws, audio);
    state.sent = true;
    if (!requireOutput || state.outputAudioChunks > 0 || state.outputTranscript) {
      finish();
    }
  } catch (error) {
    finish(error);
  }
}

async function sendAudio(ws, audio) {
  const chunkBytes = PCM16_100MS_CHUNK_BYTES;
  for (let offset = 0; offset < audio.length; offset += chunkBytes) {
    const chunk = audio.subarray(offset, offset + chunkBytes);
    ws.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            data: chunk.toString("base64"),
            mimeType: `audio/pcm;rate=${PCM16_INPUT_SAMPLE_RATE}`,
          },
        },
      }),
    );
    await delay(100);
  }

  const silence = Buffer.alloc(chunkBytes);
  for (let i = 0; i < 12; i += 1) {
    ws.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            data: silence.toString("base64"),
            mimeType: `audio/pcm;rate=${PCM16_INPUT_SAMPLE_RATE}`,
          },
        },
      }),
    );
    await delay(100);
  }
}

function createSpeechPcm16(phrase) {
  if (!existsSync("/usr/bin/say") || !existsSync("/usr/bin/afconvert")) {
    return null;
  }

  const dir = mkdtempSync(path.join(tmpdir(), "browser-translation-smoke-"));
  const aiffPath = path.join(dir, "speech.aiff");
  const wavPath = path.join(dir, "speech.wav");

  try {
    const say = spawnSync("/usr/bin/say", ["-v", "Samantha", "-o", aiffPath, phrase], {
      stdio: "ignore",
    });
    if (say.status !== 0) {
      return null;
    }

    const convert = spawnSync(
      "/usr/bin/afconvert",
      ["-f", "WAVE", "-d", `LEI16@${PCM16_INPUT_SAMPLE_RATE}`, aiffPath, wavPath],
      { stdio: "ignore" },
    );
    if (convert.status !== 0) {
      return null;
    }

    return extractWavData(readFileSync(wavPath));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function extractWavData(wav) {
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString("ascii", offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkSize;
    if (chunkId === "data") {
      return wav.subarray(dataStart, dataEnd);
    }
    offset = dataEnd + (chunkSize % 2);
  }
  throw new Error("Generated WAV did not contain a data chunk.");
}

async function messageToText(data) {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  if (typeof data?.text === "function") {
    return data.text();
  }
  return String(data);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
