import { buildAudioMixState } from "/audio-mix.js";
import {
  PCM16_100MS_CHUNK_BYTES,
  PCM16_INPUT_SAMPLE_RATE,
  Pcm16Chunker,
} from "/audio-chunks.js";
import { buildDisplayMediaOptions } from "/capture-options.js";

const OUTPUT_SAMPLE_RATE = 24_000;

const targetLanguage = document.querySelector("#targetLanguage");
const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const audioMix = document.querySelector("#audioMix");
const mixValue = document.querySelector("#mixValue");
const originalMixLabel = document.querySelector("#originalMixLabel");
const translatedMixLabel = document.querySelector("#translatedMixLabel");
const statusDot = document.querySelector("#statusDot");
const statusText = document.querySelector("#statusText");
const inputMeter = document.querySelector("#inputMeter");
const queueProgress = document.querySelector("#queueProgress");
const translatedTranscript = document.querySelector("#translatedTranscript");
const eventLog = document.querySelector("#eventLog");
const captureState = document.querySelector("#captureState");
const chunksSent = document.querySelector("#chunksSent");
const activeInputFrames = document.querySelector("#activeInputFrames");
const peakInputLevel = document.querySelector("#peakInputLevel");
const outputAudioDeltas = document.querySelector("#outputAudioDeltas");
const transcriptDeltas = document.querySelector("#transcriptDeltas");
const lastEventType = document.querySelector("#lastEventType");

let captureStream = null;
let meterContext = null;
let meterSource = null;
let meterAnalyser = null;
let meterTimer = null;
let sourceAudio = null;
let captureContext = null;
let captureSource = null;
let captureNode = null;
let chunker = null;
let websocket = null;
let playback = null;
let diagnostics = createEmptyDiagnostics();
let setupComplete = false;
let inputChunksSent = 0;

applyAudioMix();

audioMix.addEventListener("input", () => {
  applyAudioMix();
});

startButton.addEventListener("click", async () => {
  clearTranscript();
  resetDiagnostics();
  setControls({ running: true });
  setStatus("Pick a browser tab with audio", "idle");

  try {
    captureStream = await captureTabAudio();
    startSourceAudio(captureStream);
    startInputMeter(captureStream);

    setStatus("Creating Gemini Live Translate session", "idle");
    const session = await createSession(targetLanguage.value);

    setStatus("Connecting WebSocket", "idle");
    await connectGeminiLiveTranslate(session, captureStream);

    setStatus("Translating tab audio", "live");
  } catch (error) {
    logEvent("error", error instanceof Error ? error.message : String(error));
    await stop("Stopped after startup error", "error");
  }
});

stopButton.addEventListener("click", async () => {
  await stop("Stopped", "idle");
});

async function createSession(language) {
  const response = await fetch("/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetLanguage: language }),
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error ?? "Failed to create session.");
  }

  return body;
}

async function connectGeminiLiveTranslate(session, stream) {
  if (!session.ws_url || !session.setup) {
    throw new Error("Session response is missing ws_url or setup.");
  }

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
    diagnostics.connectionState = "connecting";
    chunksSent.textContent = diagnostics.connectionState;
    updateDiagnostics();

    const timeout = window.setTimeout(() => {
      finish(new Error("Gemini Live session setup timed out."));
    }, 15_000);

    websocket.addEventListener("open", () => {
      diagnostics.connectionState = "open";
      diagnostics.dataChannelState = "open";
      chunksSent.textContent = diagnostics.connectionState;
      activeInputFrames.textContent = diagnostics.dataChannelState;
      queueProgress.value = 0.5;
      logEvent("websocket.open", "ok");
      websocket.send(JSON.stringify(session.setup));
      logEvent("setup.sent", session.targetLanguage);
      updateDiagnostics();
    });

    websocket.addEventListener("error", () => {
      window.clearTimeout(timeout);
      finish(new Error("Gemini Live WebSocket connection failed."));
    });

    websocket.addEventListener("close", (event) => {
      diagnostics.connectionState = "closed";
      diagnostics.dataChannelState = "closed";
      chunksSent.textContent = "closed";
      activeInputFrames.textContent = "closed";
      queueProgress.value = 0;
      logEvent("websocket.close", `${event.code} ${event.reason || ""}`.trim());
      updateDiagnostics();
      if (!setupComplete) {
        window.clearTimeout(timeout);
        finish(new Error("Gemini Live WebSocket closed before setup completed."));
      }
    });

    websocket.addEventListener("message", async (event) => {
      let message;
      try {
        message = JSON.parse(await messageToText(event.data));
      } catch {
        logEvent("message", "Received non-JSON WebSocket message.");
        return;
      }

      handleGeminiMessage(message);

      if (message.setupComplete && !setupComplete) {
        setupComplete = true;
        window.clearTimeout(timeout);
        try {
          await startPcmCapture(stream);
          queueProgress.value = 1;
          diagnostics.iceConnectionState = "connected";
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
    diagnostics.lastEventType = "error";
    lastEventType.textContent = "error";
    logEvent("error", JSON.stringify(message.error));
    updateDiagnostics();
    return;
  }

  if (message.setupComplete) {
    diagnostics.lastEventType = "setupComplete";
    lastEventType.textContent = "setupComplete";
    logEvent("setupComplete", "ok");
    updateDiagnostics();
    return;
  }

  const content = message.serverContent;
  if (!content) {
    diagnostics.lastEventType = Object.keys(message)[0] ?? "unknown";
    lastEventType.textContent = diagnostics.lastEventType;
    updateDiagnostics();
    return;
  }

  if (content.interrupted) {
    diagnostics.lastEventType = "interrupted";
    lastEventType.textContent = "interrupted";
    playback?.interrupt();
    logEvent("interrupted", "ok");
    updateDiagnostics();
  }

  if (content.inputTranscription?.text) {
    diagnostics.lastEventType = "inputTranscription";
    lastEventType.textContent = "inputTranscription";
    logEvent("input", content.inputTranscription.text);
  }

  if (content.outputTranscription?.text) {
    diagnostics.lastEventType = "outputTranscription";
    lastEventType.textContent = "outputTranscription";
    diagnostics.transcriptDeltas += 1;
    appendTranslatedText(content.outputTranscription.text);
  }

  if (content.modelTurn?.parts) {
    for (const part of content.modelTurn.parts) {
      if (part.inlineData?.data) {
        diagnostics.lastEventType = "outputAudio";
        lastEventType.textContent = "outputAudio";
        diagnostics.remoteAudioTracks += 1;
        outputAudioDeltas.textContent = String(diagnostics.remoteAudioTracks);
        void playback?.playBase64(part.inlineData.data).catch((error) => {
          logEvent("audio.play", error.message);
        });
      }
    }
  }

  if (content.turnComplete) {
    diagnostics.lastEventType = "turnComplete";
    lastEventType.textContent = "turnComplete";
    logEvent("turnComplete", "ok");
  }

  updateDiagnostics();
}

async function startPcmCapture(stream) {
  captureContext = new AudioContext();
  await captureContext.audioWorklet.addModule("/pcm16-capture.worklet.js");
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
      activeInputFrames.textContent = String(inputChunksSent);
    }
  };

  captureSource.connect(captureNode);
  logEvent("capture.pcm", `${PCM16_INPUT_SAMPLE_RATE} Hz`);
}

async function captureTabAudio() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("This browser does not support tab audio capture.");
  }

  const supportedConstraints =
    navigator.mediaDevices.getSupportedConstraints?.() ?? {};
  const stream = await navigator.mediaDevices.getDisplayMedia(
    buildDisplayMediaOptions(supportedConstraints),
  );

  const audioTracks = stream.getAudioTracks();
  const videoTracks = stream.getVideoTracks();

  if (audioTracks.length === 0) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("No tab audio was shared. Pick a Chrome tab and enable tab audio.");
  }

  audioTracks[0].addEventListener(
    "ended",
    () => {
      void stop("Tab audio sharing ended", "idle");
    },
    { once: true },
  );

  const audioSettings = audioTracks[0].getSettings?.() ?? {};
  const suppressed =
    typeof audioSettings.suppressLocalAudioPlayback === "boolean"
      ? String(audioSettings.suppressLocalAudioPlayback)
      : "unknown";
  captureState.textContent = `audio=${audioTracks[0].readyState}, video=${videoTracks.length}, suppressed=${suppressed}`;
  logEvent(
    "capture.started",
    `audio tracks=${audioTracks.length}, video tracks=${videoTracks.length}, suppressed=${suppressed}`,
  );

  return stream;
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
    inputMeter.value = Math.min(1, rms * 12);
    diagnostics.peakInputLevel = Math.max(diagnostics.peakInputLevel, rms);
    peakInputLevel.textContent = diagnostics.peakInputLevel.toFixed(3);
  }, 100);
}

function startSourceAudio(stream) {
  sourceAudio = new Audio();
  sourceAudio.autoplay = true;
  sourceAudio.playsInline = true;
  sourceAudio.srcObject = stream;
  applyAudioMix();

  void sourceAudio.play().catch((error) => {
    logEvent("source.audio.play", error.message);
  });
}

function applyAudioMix() {
  const mix = buildAudioMixState(audioMix.value);

  audioMix.value = String(mix.translatedPercent);
  mixValue.textContent = mix.valueLabel;
  originalMixLabel.textContent = mix.originalLabel;
  translatedMixLabel.textContent = mix.translatedLabel;

  if (sourceAudio) {
    sourceAudio.volume = mix.originalVolume;
  }
  if (playback) {
    playback.setVolume(mix.translatedVolume);
  }
}

async function stop(message, state = "idle") {
  if (meterTimer) {
    window.clearInterval(meterTimer);
    meterTimer = null;
  }

  meterSource?.disconnect();
  meterAnalyser?.disconnect();
  meterSource = null;
  meterAnalyser = null;

  if (meterContext?.state !== "closed") {
    await meterContext?.close();
  }
  meterContext = null;

  captureNode?.port && (captureNode.port.onmessage = null);
  captureSource?.disconnect();
  captureNode?.disconnect();
  captureSource = null;
  captureNode = null;
  if (captureContext?.state !== "closed") {
    await captureContext?.close();
  }
  captureContext = null;
  chunker?.reset();
  chunker = null;

  if (websocket) {
    websocket.close();
    websocket = null;
  }
  setupComplete = false;

  if (sourceAudio) {
    sourceAudio.pause();
    sourceAudio.srcObject = null;
  }
  sourceAudio = null;

  captureStream?.getTracks().forEach((track) => track.stop());
  captureStream = null;

  playback?.destroy();
  playback = null;

  inputMeter.value = 0;
  queueProgress.value = 0;
  setControls({ running: false });
  setStatus(message, state);
}

function setControls({ running }) {
  startButton.disabled = running;
  stopButton.disabled = !running;
  targetLanguage.disabled = running;
}

function setStatus(message, state) {
  statusText.textContent = message;
  statusDot.className = `status-dot ${state === "live" ? "live" : ""} ${
    state === "error" ? "error" : ""
  }`;
}

function appendTranslatedText(text) {
  translatedTranscript.textContent += text;
  translatedTranscript.scrollTop = translatedTranscript.scrollHeight;
}

function clearTranscript() {
  translatedTranscript.textContent = "";
}

function createEmptyDiagnostics() {
  return {
    connectionState: "new",
    dataChannelState: "connecting",
    iceConnectionState: "new",
    lastEventType: "none",
    peakInputLevel: 0,
    remoteAudioTracks: 0,
    transcriptDeltas: 0,
  };
}

function resetDiagnostics() {
  diagnostics = createEmptyDiagnostics();
  inputChunksSent = 0;
  captureState.textContent = "Starting";
  eventLog.textContent = "";
  updateDiagnostics();
}

function updateDiagnostics() {
  chunksSent.textContent = diagnostics.connectionState;
  if (!setupComplete || inputChunksSent === 0) {
    activeInputFrames.textContent = diagnostics.dataChannelState;
  } else {
    activeInputFrames.textContent = String(inputChunksSent);
  }
  peakInputLevel.textContent = diagnostics.peakInputLevel.toFixed(3);
  outputAudioDeltas.textContent = String(diagnostics.remoteAudioTracks);
  transcriptDeltas.textContent = String(diagnostics.transcriptDeltas);
  lastEventType.textContent = diagnostics.lastEventType;
}

function logEvent(type, detail) {
  const entry = document.createElement("div");
  entry.className = "log-entry";
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${type}: ${detail}`;
  eventLog.append(entry);
  eventLog.scrollTop = eventLog.scrollHeight;
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
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    const float32 = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      float32[i] = samples[i] / 32768;
    }

    const buffer = this.audioContext.createBuffer(1, float32.length, OUTPUT_SAMPLE_RATE);
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
