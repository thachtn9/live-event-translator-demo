import { buildAudioMixState } from "./lib/audio-mix.js";
import {
  DEFAULT_TRANSLATED_MIX,
  GEMINI_API_KEY_STORAGE_KEY,
  MessageType,
} from "./lib/messages.js";

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
const inputMeterFill = document.querySelector("#inputMeterFill");
const originalTranscript = document.querySelector("#originalTranscript");
const translatedTranscript = document.querySelector("#translatedTranscript");
const geminiApiKeyInput = document.querySelector("#geminiApiKey");
const saveApiKeyButton = document.querySelector("#saveApiKeyButton");
const clearApiKeyButton = document.querySelector("#clearApiKeyButton");
const cancelApiKeyButton = document.querySelector("#cancelApiKeyButton");
const editApiKeyButton = document.querySelector("#editApiKeyButton");
const apiKeyStatus = document.querySelector("#apiKeyStatus");
const apiKeySummary = document.querySelector("#apiKeySummary");
const apiKeySummaryText = document.querySelector("#apiKeySummaryText");
const apiKeyEditor = document.querySelector("#apiKeyEditor");
const apiKeyField = document.querySelector("#apiKeyField");

let running = false;
let hasSavedApiKey = false;

applyAudioMixLabels(audioMix.value);
void restoreApiKey();

saveApiKeyButton?.addEventListener("click", () => {
  void saveApiKey();
});

clearApiKeyButton?.addEventListener("click", () => {
  void clearApiKey();
});

cancelApiKeyButton?.addEventListener("click", () => {
  if (hasSavedApiKey) {
    setApiKeyEditing(false);
    setApiKeyStatus("");
  }
});

editApiKeyButton?.addEventListener("click", () => {
  setApiKeyEditing(true);
  geminiApiKeyInput?.focus();
  geminiApiKeyInput?.select();
});

geminiApiKeyInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void saveApiKey();
  }
  if (event.key === "Escape" && hasSavedApiKey) {
    setApiKeyEditing(false);
  }
});

audioMix.addEventListener("input", () => {
  applyAudioMixLabels(audioMix.value);
  if (running) {
    void sendCommand({
      type: MessageType.SET_MIX,
      value: Number(audioMix.value),
    });
  }
});

startButton.addEventListener("click", async () => {
  clearTranscript();
  setControls({ running: true });
  setStatus("Đang khởi động…", "idle");

  try {
    const result = await sendCommand({
      type: MessageType.START,
      targetLanguage: targetLanguage.value,
      mix: Number(audioMix.value),
    });
    running = true;
    if (result?.status) {
      setStatus(result.status.message, result.status.state);
    }
  } catch (error) {
    running = false;
    setControls({ running: false });
    setStatus(error instanceof Error ? error.message : String(error), "error");
  }
});

stopButton.addEventListener("click", async () => {
  try {
    await sendCommand({ type: MessageType.STOP });
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  } finally {
    running = false;
    setControls({ running: false });
    setInputLevel(0);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type?.startsWith?.("OFFSCREEN_")) {
    return;
  }

  switch (message?.type) {
    case MessageType.STATUS:
      setStatus(message.message ?? statusText.textContent, message.state ?? "idle");
      if (message.state === "live") {
        running = true;
        setControls({ running: true });
      }
      break;
    case MessageType.TRANSCRIPT_CLEAR:
      clearTranscript();
      break;
    case MessageType.TRANSCRIPT_ORIGINAL:
      appendTranscript(originalTranscript, message.text ?? "");
      break;
    case MessageType.TRANSCRIPT:
      appendTranscript(translatedTranscript, message.text ?? "");
      break;
    case MessageType.INPUT_LEVEL:
      setInputLevel(Number(message.value) || 0);
      break;
    case MessageType.ERROR:
      setStatus(message.message ?? "Lỗi", "error");
      break;
    case MessageType.STOPPED:
      running = false;
      setControls({ running: false });
      setInputLevel(0);
      setStatus(message.message ?? "Đã dừng", message.state ?? "idle");
      break;
    default:
      break;
  }
});

void restoreState();

async function restoreApiKey() {
  if (!geminiApiKeyInput) {
    return;
  }
  const stored = await chrome.storage.local.get({
    [GEMINI_API_KEY_STORAGE_KEY]: "",
  });
  const key = String(stored[GEMINI_API_KEY_STORAGE_KEY] ?? "").trim();
  geminiApiKeyInput.value = key;
  hasSavedApiKey = Boolean(key);
  setApiKeyEditing(!hasSavedApiKey);
  setApiKeyStatus(hasSavedApiKey ? "" : "Chưa có API key — dán key rồi bấm Lưu.");
}

async function saveApiKey() {
  if (!geminiApiKeyInput) {
    return;
  }
  const geminiApiKey = String(geminiApiKeyInput.value ?? "").trim();
  if (!geminiApiKey) {
    setApiKeyStatus("Nhập Gemini API key trước khi lưu.");
    return;
  }
  await chrome.storage.local.set({
    [GEMINI_API_KEY_STORAGE_KEY]: geminiApiKey,
  });
  geminiApiKeyInput.value = geminiApiKey;
  hasSavedApiKey = true;
  setApiKeyEditing(false);
  setApiKeyStatus("");
}

async function clearApiKey() {
  await chrome.storage.local.remove(GEMINI_API_KEY_STORAGE_KEY);
  if (geminiApiKeyInput) {
    geminiApiKeyInput.value = "";
  }
  hasSavedApiKey = false;
  setApiKeyEditing(true);
  setApiKeyStatus("Đã xóa API key.");
}

function setApiKeyEditing(editing) {
  const showEditor = Boolean(editing) || !hasSavedApiKey;
  if (apiKeyEditor) {
    apiKeyEditor.hidden = !showEditor;
  }
  if (apiKeySummary) {
    apiKeySummary.hidden = showEditor;
  }
  if (cancelApiKeyButton) {
    cancelApiKeyButton.hidden = !hasSavedApiKey;
  }
  apiKeyField?.classList.toggle("is-editing", showEditor);
  apiKeyField?.classList.toggle("has-key", hasSavedApiKey);
  if (!showEditor && apiKeySummaryText) {
    apiKeySummaryText.textContent = "API key đã lưu";
  }
}

function setApiKeyStatus(message) {
  if (apiKeyStatus) {
    apiKeyStatus.textContent = message;
    apiKeyStatus.hidden = !message;
  }
}

async function restoreState() {
  try {
    const state = await sendCommand({ type: MessageType.GET_STATE });
    if (typeof state.mix === "number") {
      audioMix.value = String(state.mix);
      applyAudioMixLabels(state.mix);
    }
    if (state.targetLanguage) {
      targetLanguage.value = state.targetLanguage;
    }
    running = Boolean(state.running);
    setControls({ running });
    if (state.status) {
      setStatus(state.status.message, state.status.state);
    }
  } catch {
    // Fresh install / worker waking up.
  }
}

async function sendCommand(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error ?? "Lệnh extension thất bại.");
  }
  return response;
}

function applyAudioMixLabels(value) {
  const mix = buildAudioMixState(value ?? DEFAULT_TRANSLATED_MIX);
  audioMix.value = String(mix.translatedPercent);
  mixValue.textContent = mix.valueLabel;
  originalMixLabel.textContent = mix.originalLabel;
  translatedMixLabel.textContent = mix.translatedLabel;
}

function setControls({ running: isRunning }) {
  startButton.disabled = isRunning;
  stopButton.disabled = !isRunning;
  targetLanguage.disabled = isRunning;
}

function setStatus(message, state = "idle") {
  statusText.textContent = message;
  statusDot.className = `status-dot ${state === "live" ? "live" : ""} ${
    state === "error" ? "error" : ""
  }`.trim();
  document.body.classList.toggle("is-live", state === "live");
  document.body.classList.toggle("is-error", state === "error");
}

function setInputLevel(value) {
  const level = Math.max(0, Math.min(1, Number(value) || 0));
  if (inputMeterFill) {
    inputMeterFill.style.width = `${level * 100}%`;
  }
  if (inputMeter) {
    inputMeter.setAttribute("aria-valuenow", String(level));
  }
}

const MAX_RECENT_SENTENCES = 3;

function appendTranscript(node, text) {
  if (!node || !text) {
    return;
  }
  node.textContent = keepRecentSentences(node.textContent + text, MAX_RECENT_SENTENCES);
  node.scrollTop = node.scrollHeight;
}

function keepRecentSentences(text, maxSentences) {
  const parts = text.match(/[^.!?\n。！？…]+(?:[.!?\n。！？…]+|$)/g);
  if (!parts || parts.length <= maxSentences) {
    return text;
  }
  return parts.slice(-maxSentences).join("").replace(/^\s+/, "");
}

function clearTranscript() {
  if (originalTranscript) {
    originalTranscript.textContent = "";
  }
  if (translatedTranscript) {
    translatedTranscript.textContent = "";
  }
}
