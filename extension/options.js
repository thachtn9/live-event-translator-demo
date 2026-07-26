import { GEMINI_API_KEY_STORAGE_KEY } from "./lib/messages.js";

const geminiApiKeyInput = document.querySelector("#geminiApiKey");
const saveButton = document.querySelector("#saveButton");
const clearButton = document.querySelector("#clearButton");
const status = document.querySelector("#status");

void restore();

saveButton.addEventListener("click", async () => {
  const geminiApiKey = String(geminiApiKeyInput.value ?? "").trim();
  if (!geminiApiKey) {
    setStatus("Nhập Gemini API key trước khi lưu.");
    return;
  }

  await chrome.storage.local.set({
    [GEMINI_API_KEY_STORAGE_KEY]: geminiApiKey,
  });
  geminiApiKeyInput.value = geminiApiKey;
  setStatus("Đã lưu API key trên máy này.");
});

clearButton.addEventListener("click", async () => {
  await chrome.storage.local.remove(GEMINI_API_KEY_STORAGE_KEY);
  geminiApiKeyInput.value = "";
  setStatus("Đã xóa API key.");
});

async function restore() {
  const stored = await chrome.storage.local.get({
    [GEMINI_API_KEY_STORAGE_KEY]: "",
  });
  geminiApiKeyInput.value = String(
    stored[GEMINI_API_KEY_STORAGE_KEY] ?? "",
  ).trim();
  if (geminiApiKeyInput.value) {
    setStatus("Đã có API key đã lưu.");
  }
}

function setStatus(message) {
  status.textContent = message;
}
