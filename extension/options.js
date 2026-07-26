import { DEFAULT_SESSION_API_BASE } from "./lib/messages.js";

const sessionApiBaseInput = document.querySelector("#sessionApiBase");
const saveButton = document.querySelector("#saveButton");
const permissionButton = document.querySelector("#permissionButton");
const status = document.querySelector("#status");

void restore();

saveButton.addEventListener("click", async () => {
  const sessionApiBase = normalizeBase(sessionApiBaseInput.value);
  if (!sessionApiBase) {
    setStatus("Nhập URL hợp lệ, ví dụ http://127.0.0.1:5173");
    return;
  }

  await chrome.storage.sync.set({ sessionApiBase });
  sessionApiBaseInput.value = sessionApiBase;
  setStatus(`Đã lưu ${sessionApiBase}`);
});

permissionButton.addEventListener("click", async () => {
  const sessionApiBase = normalizeBase(sessionApiBaseInput.value);
  if (!sessionApiBase) {
    setStatus("Hãy nhập URL trước.");
    return;
  }

  let origin;
  try {
    const url = new URL(sessionApiBase);
    origin = `${url.protocol}//${url.host}/*`;
  } catch {
    setStatus("URL không hợp lệ.");
    return;
  }

  const granted = await chrome.permissions.request({ origins: [origin] });
  setStatus(
    granted
      ? `Đã cấp quyền host cho ${origin}`
      : `Chưa được cấp quyền host cho ${origin}`,
  );
});

async function restore() {
  const stored = await chrome.storage.sync.get({
    sessionApiBase: DEFAULT_SESSION_API_BASE,
  });
  sessionApiBaseInput.value =
    stored.sessionApiBase || DEFAULT_SESSION_API_BASE;
}

function normalizeBase(value) {
  const trimmed = String(value ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }
    return `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
}

function setStatus(message) {
  status.textContent = message;
}
