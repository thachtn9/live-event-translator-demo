import {
  buildSaveFilename,
  splitDisplayParagraphs,
} from "./lib/polish-text.js";
import { MessageType } from "./lib/messages.js";

const statusEl = document.querySelector("#status");
const bodyEl = document.querySelector("#body");
const saveButton = document.querySelector("#saveButton");
const polishEnabledEl = document.querySelector("#polishEnabled");

void refresh();

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MessageType.FULL_TRANSCRIPT_UPDATE) {
    applySnapshot(message);
  }
});

polishEnabledEl.addEventListener("change", () => {
  void chrome.runtime
    .sendMessage({
      type: MessageType.SET_POLISH_ENABLED,
      enabled: polishEnabledEl.checked,
    })
    .catch(() => {});
});

saveButton.addEventListener("click", () => {
  const paragraphs = [...bodyEl.querySelectorAll("p")]
    .map((node) => node.textContent?.trim() || "")
    .filter(Boolean);
  if (!paragraphs.length) {
    return;
  }
  const text = `${paragraphs.join("\n\n")}\n`;
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = buildSaveFilename(new Date());
  anchor.rel = "noopener";
  document.documentElement.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
});

async function refresh() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: MessageType.GET_FULL_TRANSCRIPT,
    });
    if (response?.ok) {
      applySnapshot(response);
    }
  } catch {
    setStatus("Không đọc được bản dịch.");
  }
}

function applySnapshot(snapshot) {
  const display = String(snapshot.display ?? "");
  const stuckNearBottom =
    bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 24;
  if (typeof snapshot.polishEnabled === "boolean") {
    polishEnabledEl.checked = snapshot.polishEnabled;
  }
  renderParagraphs(display);
  if (stuckNearBottom) {
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }
  setStatus(snapshot.status || "");
}

function renderParagraphs(display) {
  const paragraphs = splitDisplayParagraphs(display);
  bodyEl.replaceChildren();
  for (const text of paragraphs) {
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    bodyEl.appendChild(paragraph);
  }
}

function setStatus(message) {
  const text = String(message ?? "").trim();
  statusEl.textContent = text;
  statusEl.hidden = !text;
}
