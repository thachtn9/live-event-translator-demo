import {
  DEFAULT_TARGET_LANGUAGE,
  DEFAULT_TRANSLATED_MIX,
  GEMINI_API_KEY_STORAGE_KEY,
  MessageType,
} from "./lib/messages.js";

const OFFSCREEN_URL = "offscreen.html";
const OFFSCREEN_REASONS = ["USER_MEDIA", "AUDIO_PLAYBACK"];
const OFFSCREEN_JUSTIFICATION =
  "Bắt âm thanh tab đang xem, gửi tới Gemini Live Translate và phát bản dịch.";
const OFFSCREEN_PING = "OFFSCREEN_PING";

let running = false;
let capturedTabId = null;
let lastInvokedTabId = null;
let lastStatus = { message: "Đã dừng", state: "idle" };
let lastMix = DEFAULT_TRANSLATED_MIX;
let lastLanguage = DEFAULT_TARGET_LANGUAGE;

// tabCapture cần user bấm icon extension trên tab (activeTab).
chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) {
    return;
  }
  lastInvokedTabId = tab.id;
  void openOverlayOnTab(tab).catch((error) => {
    console.error("Không mở được overlay:", error);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === lastInvokedTabId) {
    lastInvokedTabId = null;
  }
  if (tabId === capturedTabId && running) {
    void stopTranslation("Tab nguồn đã đóng", "idle");
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Offscreen-targeted commands are handled by the offscreen document.
  if (
    message?.type === MessageType.OFFSCREEN_START ||
    message?.type === MessageType.OFFSCREEN_STOP ||
    message?.type === MessageType.OFFSCREEN_SET_MIX ||
    message?.type === OFFSCREEN_PING ||
    message?.type === MessageType.OVERLAY_PING
  ) {
    return false;
  }

  // Pipeline events from offscreen: update state and forward to in-page overlay.
  if (isPipelineEvent(message?.type)) {
    applyPipelineEvent(message, sender);
    sendResponse({ ok: true });
    return false;
  }

  void handleCommand(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      sendResponse({ ok: false, error: errorMessage });
    });
  return true;
});

function isPipelineEvent(type) {
  return (
    type === MessageType.STATUS ||
    type === MessageType.TRANSCRIPT ||
    type === MessageType.TRANSCRIPT_ORIGINAL ||
    type === MessageType.TRANSCRIPT_CLEAR ||
    type === MessageType.INPUT_LEVEL ||
    type === MessageType.ERROR ||
    type === MessageType.STOPPED
  );
}

function applyPipelineEvent(message, sender) {
  const fromOffscreen = Boolean(sender?.url?.includes("offscreen.html"));

  // Content scripts do not receive chrome.runtime.sendMessage — forward explicitly.
  void forwardToOverlay(message);

  if (message.type === MessageType.STATUS) {
    lastStatus = {
      message: message.message ?? lastStatus.message,
      state: message.state ?? lastStatus.state,
    };
  }

  if (message.type === MessageType.STOPPED) {
    running = false;
    capturedTabId = null;
    lastStatus = {
      message: message.message ?? "Đã dừng",
      state: message.state ?? "idle",
    };
    if (fromOffscreen) {
      void closeOffscreenDocument().catch(() => {});
    }
  }

  if (message.type === MessageType.ERROR) {
    lastStatus = {
      message: message.message ?? "Lỗi",
      state: "error",
    };
  }
}

async function forwardToOverlay(message) {
  const tabId = capturedTabId ?? lastInvokedTabId;
  if (!tabId) {
    return;
  }
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // Overlay may be closed or tab navigated away.
  }
}

async function handleCommand(message, sender) {
  switch (message?.type) {
    case MessageType.START:
      return startTranslation({
        ...message,
        tabId: message.tabId ?? sender?.tab?.id ?? null,
      });
    case MessageType.STOP:
      return stopTranslation(message?.message ?? "Đã dừng", "idle");
    case MessageType.SET_MIX:
      return setMix(message.value);
    case MessageType.GET_STATE:
      return getState();
    default:
      throw new Error(`Unknown message type: ${message?.type ?? "undefined"}`);
  }
}

async function startTranslation({
  targetLanguage = DEFAULT_TARGET_LANGUAGE,
  mix = DEFAULT_TRANSLATED_MIX,
  tabId = null,
} = {}) {
  if (running) {
    throw new Error("Đang dịch rồi. Hãy dừng phiên hiện tại trước.");
  }

  const targetTabId = tabId ?? lastInvokedTabId ?? (await getActiveTabId());
  if (!targetTabId) {
    throw new Error(
      "Chưa có tab để bắt âm. Bấm icon extension trên tab sự kiện, rồi nhấn Bắt đầu dịch.",
    );
  }

  const tab = await chrome.tabs.get(targetTabId);
  if (!tab?.id) {
    throw new Error("Không đọc được tab sự kiện.");
  }
  if (isRestrictedTabUrl(tab.url)) {
    throw new Error(
      "Không bắt được trang trình duyệt này. Mở tab http(s) sự kiện, bấm icon extension trên tab đó, rồi Bắt đầu dịch.",
    );
  }

  const geminiApiKey = await getGeminiApiKey();
  if (!geminiApiKey) {
    throw new Error(
      "Chưa có Gemini API key. Mở Cài đặt trên overlay, dán key rồi bấm Lưu key.",
    );
  }

  await setupOffscreenDocument();
  await waitForOffscreenReady();

  // streamId is single-use and expires quickly — request it only after offscreen
  // is ready, then hand it off immediately.
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tab.id,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${detail} Bấm icon Dịch sự kiện trực tiếp trên tab sự kiện (không dùng trang chrome://), rồi nhấn Bắt đầu dịch.`,
    );
  }

  running = true;
  capturedTabId = tab.id;
  lastInvokedTabId = tab.id;
  lastLanguage = targetLanguage;
  lastMix = Number(mix);
  lastStatus = { message: "Đang bắt âm thanh", state: "idle" };

  try {
    const response = await chrome.runtime.sendMessage({
      type: MessageType.OFFSCREEN_START,
      streamId,
      geminiApiKey,
      targetLanguage,
      mix: lastMix,
    });
    if (response && response.ok === false) {
      throw new Error(response.error ?? "Không khởi động được pipeline offscreen.");
    }
  } catch (error) {
    running = false;
    capturedTabId = null;
    await closeOffscreenDocument().catch(() => {});
    throw error;
  }

  return getState();
}

function isRestrictedTabUrl(url) {
  if (!url) {
    return true;
  }
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("devtools://") ||
    url.startsWith("https://chrome.google.com/webstore") ||
    url.startsWith("https://chromewebstore.google.com/")
  );
}

async function stopTranslation(message = "Đã dừng", state = "idle") {
  if (running) {
    try {
      await chrome.runtime.sendMessage({ type: MessageType.OFFSCREEN_STOP });
    } catch {
      // Offscreen may already be gone.
    }
  }

  running = false;
  capturedTabId = null;
  lastStatus = { message, state };
  await closeOffscreenDocument().catch(() => {});

  try {
    await chrome.runtime.sendMessage({
      type: MessageType.STOPPED,
      message,
      state,
    });
  } catch {
    // Side panel may be closed.
  }

  return getState();
}

async function setMix(value) {
  lastMix = Number(value);
  if (running) {
    try {
      await chrome.runtime.sendMessage({
        type: MessageType.OFFSCREEN_SET_MIX,
        value: lastMix,
      });
    } catch {
      // Offscreen may already be gone.
    }
  }
  return { mix: lastMix };
}

function getState() {
  return {
    running,
    capturedTabId,
    status: lastStatus,
    mix: lastMix,
    targetLanguage: lastLanguage,
  };
}

async function getActiveTabId() {
  const focused = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (focused[0]?.id) {
    return focused[0].id;
  }

  const current = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  return current[0]?.id ?? null;
}

async function getGeminiApiKey() {
  const stored = await chrome.storage.local.get({
    [GEMINI_API_KEY_STORAGE_KEY]: "",
  });
  return String(stored[GEMINI_API_KEY_STORAGE_KEY] ?? "").trim();
}

async function setupOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: OFFSCREEN_REASONS,
    justification: OFFSCREEN_JUSTIFICATION,
  });
}

async function waitForOffscreenReady(attempts = 12) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await chrome.runtime.sendMessage({ type: OFFSCREEN_PING });
      if (response?.ok) {
        return;
      }
      lastError = new Error("Tài liệu offscreen không phản hồi.");
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await delay(40 * (attempt + 1));
  }
  throw lastError ?? new Error("Không kết nối được tới tài liệu offscreen.");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeOffscreenDocument() {
  if (!(await hasOffscreenDocument())) {
    return;
  }
  await chrome.offscreen.closeDocument();
}

async function hasOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
    });
    return contexts.length > 0;
  }

  const clientsList = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  return clientsList.some((client) => client.url.endsWith(`/${OFFSCREEN_URL}`));
}

async function openOverlayOnTab(tab) {
  if (!tab?.id) {
    return;
  }
  if (isRestrictedTabUrl(tab.url)) {
    throw new Error(
      "Không nhúng được vào trang trình duyệt này. Hãy mở tab http(s) sự kiện rồi bấm icon extension.",
    );
  }

  try {
    const ping = await chrome.tabs.sendMessage(tab.id, {
      type: MessageType.OVERLAY_PING,
    });
    if (ping?.ok) {
      return;
    }
  } catch {
    // Overlay chưa được inject.
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content/overlay.js"],
  });
}
