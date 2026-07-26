import { buildAudioMixState } from "./lib/audio-mix.js";
import {
  PCM16_100MS_CHUNK_BYTES,
  PCM16_INPUT_SAMPLE_RATE,
  Pcm16Chunker,
} from "./lib/audio-chunks.js";
import { MessageType } from "./lib/messages.js";
import { createEphemeralToken } from "./lib/session.js";

const OUTPUT_SAMPLE_RATE = 24_000;

let captureStream = null;
let sourceAudio = null;
let captureContext = null;
let captureSource = null;
let captureNode = null;
let chunker = null;
let websocket = null;
let playback = null;
let setupComplete = false;
let inputChunksSent = 0;
let mixPercent = 85;
let meterContext = null;
let meterSource = null;
let meterAnalyser = null;
let meterTimer = null;
let starting = false;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "OFFSCREEN_PING") {
    sendResponse({ ok: true });
    return false;
  }

  if (
    message?.type !== MessageType.OFFSCREEN_START &&
    message?.type !== MessageType.OFFSCREEN_STOP &&
    message?.type !== MessageType.OFFSCREEN_SET_MIX
  ) {
    return false;
  }

  void handleOffscreenMessage(message)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      sendResponse({ ok: false, error: errorMessage });
    });
  return true;
});

async function handleOffscreenMessage(message) {
  switch (message.type) {
    case MessageType.OFFSCREEN_START:
      await startPipeline(message);
      return {};
    case MessageType.OFFSCREEN_STOP:
      await stopPipeline("Đã dừng", "idle");
      return {};
    case MessageType.OFFSCREEN_SET_MIX:
      mixPercent = Number(message.value);
      applyAudioMix();
      return { mix: mixPercent };
    default:
      return {};
  }
}

async function startPipeline({
  streamId,
  geminiApiKey,
  targetLanguage,
  mix = 85,
}) {
  if (starting || websocket) {
    throw new Error("Pipeline dịch đang chạy hoặc đang khởi động.");
  }
  if (!streamId) {
    throw new Error("Thiếu stream id bắt âm tab.");
  }
  if (!geminiApiKey) {
    throw new Error(
      "Chưa có Gemini API key. Chuột phải icon extension → Cài đặt → nhập API key.",
    );
  }

  starting = true;
  mixPercent = Number(mix);
  inputChunksSent = 0;
  setupComplete = false;

  try {
    emit({ type: MessageType.TRANSCRIPT_CLEAR });
    emitStatus("Đang bắt âm thanh tab", "idle");

    captureStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });

    const audioTracks = captureStream.getAudioTracks();
    if (audioTracks.length === 0) {
      throw new Error("Không nhận được track âm thanh từ tab.");
    }

    audioTracks[0].addEventListener(
      "ended",
      () => {
        void stopPipeline("Đã kết thúc bắt âm tab", "idle");
      },
      { once: true },
    );

    startSourceAudio(captureStream);
    startInputMeter(captureStream);

    emitStatus("Đang tạo phiên Gemini Live Translate", "idle");
    const session = await createSession(geminiApiKey, targetLanguage);

    emitStatus("Đang kết nối WebSocket", "idle");
    await connectGeminiLiveTranslate(session, captureStream);

    emitStatus("Đang dịch âm thanh tab", "live");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    emit({ type: MessageType.ERROR, message: errorMessage });
    await stopPipeline(errorMessage, "error");
    throw error;
  } finally {
    starting = false;
  }
}

async function createSession(geminiApiKey, targetLanguage) {
  const session = await createEphemeralToken({
    apiKey: geminiApiKey,
    targetLanguage,
  });
  if (!session.ws_url || !session.setup) {
    throw new Error("Phản hồi phiên thiếu ws_url hoặc setup.");
  }
  return session;
}

async function connectGeminiLiveTranslate(session, stream) {
  playback = new Pcm24Player();
  await playback.init();
  applyAudioMix();

  chunker = new Pcm16Chunker(PCM16_100MS_CHUNK_BYTES);
  setupComplete = false;

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    websocket = new WebSocket(session.ws_url);

    const timeout = window.setTimeout(() => {
      finish(new Error("Hết thời gian chờ thiết lập phiên Gemini Live."));
    }, 15_000);

    websocket.addEventListener("open", () => {
      websocket.send(JSON.stringify(session.setup));
    });

    websocket.addEventListener("error", () => {
      window.clearTimeout(timeout);
      finish(new Error("Kết nối WebSocket Gemini Live thất bại."));
    });

    websocket.addEventListener("close", () => {
      if (!setupComplete) {
        window.clearTimeout(timeout);
        finish(new Error("WebSocket Gemini Live đóng trước khi setup xong."));
      }
    });

    websocket.addEventListener("message", async (event) => {
      let message;
      try {
        message = JSON.parse(await messageToText(event.data));
      } catch {
        return;
      }

      handleGeminiMessage(message);

      if (message.setupComplete && !setupComplete) {
        setupComplete = true;
        window.clearTimeout(timeout);
        try {
          await startPcmCapture(stream);
          finish();
        } catch (error) {
          finish(error);
        }
      }
    });
  });
}

function handleGeminiMessage(message) {
  if (message.error) {
    emit({
      type: MessageType.ERROR,
      message: JSON.stringify(message.error),
    });
    return;
  }

  const content = message.serverContent;
  if (!content) {
    return;
  }

  if (content.interrupted) {
    playback?.interrupt();
  }

  if (content.inputTranscription?.text) {
    emit({
      type: MessageType.TRANSCRIPT_ORIGINAL,
      text: content.inputTranscription.text,
    });
  }

  if (content.outputTranscription?.text) {
    emit({
      type: MessageType.TRANSCRIPT,
      text: content.outputTranscription.text,
    });
  }

  if (content.modelTurn?.parts) {
    for (const part of content.modelTurn.parts) {
      if (part.inlineData?.data) {
        void playback?.playBase64(part.inlineData.data).catch(() => {});
      }
    }
  }
}

async function startPcmCapture(stream) {
  captureContext = new AudioContext();
  await captureContext.audioWorklet.addModule("./lib/pcm16-capture.worklet.js");
  captureSource = captureContext.createMediaStreamSource(stream);
  captureNode = new AudioWorkletNode(captureContext, "pcm16-capture", {
    processorOptions: { targetSampleRate: PCM16_INPUT_SAMPLE_RATE },
  });

  captureNode.port.onmessage = ({ data }) => {
    if (data?.type !== "pcm16" || !data.buffer) {
      return;
    }
    if (!websocket || websocket.readyState !== WebSocket.OPEN || !setupComplete) {
      return;
    }

    const chunks = chunker.push(data.buffer);
    for (const chunk of chunks) {
      websocket.send(
        JSON.stringify({
          realtimeInput: {
            audio: {
              data: bytesToBase64(chunk),
              mimeType: `audio/pcm;rate=${PCM16_INPUT_SAMPLE_RATE}`,
            },
          },
        }),
      );
      inputChunksSent += 1;
    }
  };

  captureSource.connect(captureNode);
}

function startSourceAudio(stream) {
  sourceAudio = new Audio();
  sourceAudio.autoplay = true;
  sourceAudio.srcObject = stream;
  applyAudioMix();
  void sourceAudio.play().catch(() => {});
}

function startInputMeter(stream) {
  meterContext = new AudioContext();
  meterSource = meterContext.createMediaStreamSource(stream);
  meterAnalyser = meterContext.createAnalyser();
  meterAnalyser.fftSize = 2048;
  meterSource.connect(meterAnalyser);

  const samples = new Float32Array(meterAnalyser.fftSize);
  meterTimer = window.setInterval(() => {
    meterAnalyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / samples.length);
    emit({
      type: MessageType.INPUT_LEVEL,
      value: Math.min(1, rms * 12),
    });
  }, 100);
}

function applyAudioMix() {
  const mix = buildAudioMixState(mixPercent);
  if (sourceAudio) {
    sourceAudio.volume = mix.originalVolume;
  }
  if (playback) {
    playback.setVolume(mix.translatedVolume);
  }
}

async function stopPipeline(message = "Đã dừng", state = "idle") {
  if (meterTimer) {
    window.clearInterval(meterTimer);
    meterTimer = null;
  }

  meterSource?.disconnect();
  meterAnalyser?.disconnect();
  meterSource = null;
  meterAnalyser = null;
  if (meterContext?.state !== "closed") {
    await meterContext?.close().catch(() => {});
  }
  meterContext = null;

  if (captureNode?.port) {
    captureNode.port.onmessage = null;
  }
  captureSource?.disconnect();
  captureNode?.disconnect();
  captureSource = null;
  captureNode = null;
  if (captureContext?.state !== "closed") {
    await captureContext?.close().catch(() => {});
  }
  captureContext = null;
  chunker?.reset();
  chunker = null;

  if (websocket) {
    websocket.close();
    websocket = null;
  }
  setupComplete = false;
  starting = false;

  if (sourceAudio) {
    sourceAudio.pause();
    sourceAudio.srcObject = null;
  }
  sourceAudio = null;

  captureStream?.getTracks().forEach((track) => track.stop());
  captureStream = null;

  playback?.destroy();
  playback = null;
  inputChunksSent = 0;

  emit({
    type: MessageType.STOPPED,
    message,
    state,
  });
  emitStatus(message, state);
}

function emitStatus(message, state) {
  emit({
    type: MessageType.STATUS,
    message,
    state,
  });
}

function emit(message) {
  try {
    void chrome.runtime.sendMessage(message);
  } catch {
    // Service worker / side panel may be unavailable.
  }
}

async function messageToText(data) {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof Blob) {
    return data.text();
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  return String(data);
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

class Pcm24Player {
  constructor() {
    this.audioContext = null;
    this.gainNode = null;
    this.nextTime = 0;
    this.sources = new Set();
    this.volume = 1;
  }

  async init() {
    this.audioContext = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = this.volume;
    this.gainNode.connect(this.audioContext.destination);
    this.nextTime = this.audioContext.currentTime;
  }

  setVolume(volume) {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.gainNode) {
      this.gainNode.gain.value = this.volume;
    }
  }

  async playBase64(base64Audio) {
    if (!this.audioContext || !this.gainNode) {
      await this.init();
    }
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }

    const bytes = base64ToUint8Array(base64Audio);
    const samples = new Int16Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength / 2,
    );
    const float32 = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      float32[i] = samples[i] / 32768;
    }

    const buffer = this.audioContext.createBuffer(
      1,
      float32.length,
      OUTPUT_SAMPLE_RATE,
    );
    buffer.copyToChannel(float32, 0);

    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gainNode);
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
    };

    const startAt = Math.max(this.audioContext.currentTime, this.nextTime);
    source.start(startAt);
    this.nextTime = startAt + buffer.duration;
  }

  interrupt() {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    this.sources.clear();
    if (this.audioContext) {
      this.nextTime = this.audioContext.currentTime;
    }
  }

  destroy() {
    this.interrupt();
    if (this.audioContext?.state !== "closed") {
      void this.audioContext?.close();
    }
    this.audioContext = null;
    this.gainNode = null;
  }
}

function base64ToUint8Array(base64Audio) {
  const binary = atob(base64Audio);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
