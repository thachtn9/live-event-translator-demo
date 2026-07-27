# Full Transcript Panel + AI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an overlay slide-out panel that shows the full session translation, auto-polishes every ~18 completed sentences with free-tier Gemini Flash-Lite, and lets the user save a `.txt` file.

**Architecture:** Overlay accumulates streaming `TRANSCRIPT` text, batches completed sentences, and asks the background service worker to call Gemini `generateContent`. Background uses the stored API key and returns cleaned text. Panel UI lives in the overlay shadow DOM as a right-hand slide-out.

**Tech Stack:** Chrome MV3 extension (content script overlay + service worker), Gemini REST `generateContent`, Node `node:test` for pure helpers.

## Global Constraints

- Polish style: clean punctuation/flow only; do not change meaning, summarize, or translate.
- Batch size: `18` completed sentences (`POLISH_BATCH_SIZE`).
- Primary model: `gemini-2.5-flash-lite`; fallback: `gemini-2.0-flash-lite` then `gemini-2.5-flash`.
- Panel: slide-out attached to the right of the overlay (~280–320px).
- Save: UTF-8 `.txt` named `ban-dich-YYYYMMDD-HHmm.txt` via Blob download (no new permissions).
- Polish remainder on Stop; reset buffers on Start / TRANSCRIPT_CLEAR.
- Do not change the Live Translate audio WebSocket pipeline.
- Overlay `content/overlay.js` is a classic IIFE (no ES imports); shared pure logic lives in `extension/lib/polish-text.js` for background + tests, and the same functions are inlined in overlay (keep signatures identical).

## File map

| File | Responsibility |
|------|----------------|
| `extension/lib/polish-text.js` | Pure helpers: sentence batching, prompt, response parse, constants |
| `test/polish-text.test.js` | Unit tests for helpers |
| `extension/lib/messages.js` | Add `POLISH_TRANSCRIPT` |
| `extension/lib/polish.js` | Background-only: call Gemini generateContent with fallbacks |
| `extension/background.js` | Handle `POLISH_TRANSCRIPT` command |
| `extension/content/overlay.js` | Panel UI, buffers, batch trigger, save download |

---

### Task 1: Pure polish-text helpers + tests

**Files:**
- Create: `extension/lib/polish-text.js`
- Create: `test/polish-text.test.js`

**Interfaces:**
- Produces:
  - `POLISH_BATCH_SIZE = 18`
  - `DEFAULT_POLISH_MODEL = "gemini-2.5-flash-lite"`
  - `POLISH_MODEL_FALLBACKS = ["gemini-2.0-flash-lite", "gemini-2.5-flash"]`
  - `countCompletedSentences(text: string): number`
  - `takeCompletedBatch(pendingRawText: string, batchSize = POLISH_BATCH_SIZE): { batchText: string, rest: string } | null`
    - Returns `null` if fewer than `batchSize` completed sentences.
    - `batchText` is the completed-sentence prefix; `rest` is the unfinished trailing fragment.
  - `takeAllCompletedAndRest(pendingRawText: string): { batchText: string, rest: string }`
    - For Stop flush: `batchText` = all completed sentences (may be 0+); if no completed sentences but pending has trim-able text, `batchText` = trimmed full pending and `rest` = `""`.
  - `buildPolishPrompt(batchText: string): string`
  - `parseGenerateContentText(payload: object): string` — extracts first candidate text; throws if empty
  - `buildSaveFilename(date = new Date()): string` — `ban-dich-YYYYMMDD-HHmm.txt` local time zero-padded
  - `joinDisplay(polishedText: string, pendingRawText: string): string`

- [ ] **Step 1: Write the failing test file**

Create `test/polish-text.test.js`:

```js
import assert from "node:assert/strict";
import test from "node:test";

async function importPolishText() {
  return import("../extension/lib/polish-text.js");
}

test("takeCompletedBatch returns null until batch size is reached", async () => {
  const { takeCompletedBatch, POLISH_BATCH_SIZE } = await importPolishText();
  const partial = Array.from({ length: POLISH_BATCH_SIZE - 1 }, (_, i) => `Câu ${i + 1}.`).join(" ");
  assert.equal(takeCompletedBatch(partial), null);
});

test("takeCompletedBatch splits completed prefix and leaves trailing fragment", async () => {
  const { takeCompletedBatch } = await importPolishText();
  const sentences = Array.from({ length: 18 }, (_, i) => `Câu ${i + 1}.`);
  const pending = `${sentences.join(" ")} và đoạn chưa hết`;
  const result = takeCompletedBatch(pending, 18);
  assert.ok(result);
  assert.match(result.batchText, /Câu 18\./);
  assert.equal(result.rest, "và đoạn chưa hết");
  assert.equal(result.batchText.includes("và đoạn chưa hết"), false);
});

test("takeAllCompletedAndRest flushes leftover text on stop", async () => {
  const { takeAllCompletedAndRest } = await importPolishText();
  assert.deepEqual(takeAllCompletedAndRest("Xin chào. Phần dở"), {
    batchText: "Xin chào.",
    rest: "Phần dở",
  });
  assert.deepEqual(takeAllCompletedAndRest("chỉ một đoạn"), {
    batchText: "chỉ một đoạn",
    rest: "",
  });
});

test("buildPolishPrompt asks for clean edit only", async () => {
  const { buildPolishPrompt } = await importPolishText();
  const prompt = buildPolishPrompt("Hello. World.");
  assert.match(prompt, /không/i);
  assert.match(prompt, /Hello\. World\./);
});

test("parseGenerateContentText reads Gemini candidate text", async () => {
  const { parseGenerateContentText } = await importPolishText();
  const text = parseGenerateContentText({
    candidates: [{ content: { parts: [{ text: "  Sạch sẽ.  " }] } }],
  });
  assert.equal(text, "Sạch sẽ.");
});

test("buildSaveFilename uses ban-dich stamp", async () => {
  const { buildSaveFilename } = await importPolishText();
  const name = buildSaveFilename(new Date(2026, 6, 27, 9, 5));
  assert.equal(name, "ban-dich-20260727-0905.txt");
});

test("joinDisplay concatenates polished and pending", async () => {
  const { joinDisplay } = await importPolishText();
  assert.equal(joinDisplay("A. ", "B."), "A. B.");
  assert.equal(joinDisplay("A.", ""), "A.");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/polish-text.test.js`  
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `extension/lib/polish-text.js`**

```js
export const POLISH_BATCH_SIZE = 18;
export const DEFAULT_POLISH_MODEL = "gemini-2.5-flash-lite";
export const POLISH_MODEL_FALLBACKS = [
  "gemini-2.0-flash-lite",
  "gemini-2.5-flash",
];

const SENTENCE_END = /([.!?…。！？]+)(?:\s+|$)/g;

export function countCompletedSentences(text) {
  if (!text) return 0;
  const matches = String(text).match(/[.!?…。！？]+/g);
  return matches ? matches.length : 0;
}

export function takeCompletedBatch(pendingRawText, batchSize = POLISH_BATCH_SIZE) {
  const pending = String(pendingRawText ?? "");
  if (countCompletedSentences(pending) < batchSize) {
    return null;
  }

  let seen = 0;
  let endIndex = -1;
  const re = new RegExp(SENTENCE_END.source, "g");
  let match;
  while ((match = re.exec(pending)) !== null) {
    seen += 1;
    if (seen === batchSize) {
      endIndex = match.index + match[0].length;
      break;
    }
  }
  if (endIndex < 0) {
    return null;
  }

  return {
    batchText: pending.slice(0, endIndex).trimEnd(),
    rest: pending.slice(endIndex),
  };
}

export function takeAllCompletedAndRest(pendingRawText) {
  const pending = String(pendingRawText ?? "");
  if (!pending.trim()) {
    return { batchText: "", rest: "" };
  }

  let endIndex = -1;
  const re = new RegExp(SENTENCE_END.source, "g");
  let match;
  while ((match = re.exec(pending)) !== null) {
    endIndex = match.index + match[0].length;
  }

  if (endIndex < 0) {
    return { batchText: pending.trim(), rest: "" };
  }

  const batchText = pending.slice(0, endIndex).trimEnd();
  const rest = pending.slice(endIndex);
  if (!batchText && rest.trim()) {
    return { batchText: rest.trim(), rest: "" };
  }
  return { batchText, rest };
}

export function buildPolishPrompt(batchText) {
  return [
    "Bạn là biên tập viên. Hãy làm sạch đoạn văn bản dịch sau:",
    "- Chỉ sửa lỗi chính tả, dấu câu, viết hoa, và nối câu cho mạch lạc.",
    "- Giữ nguyên ý nghĩa và ngôn ngữ; không tóm tắt; không thêm thông tin mới; không bỏ nội dung.",
    "- Trả về plain text only, không markdown.",
    "",
    "Văn bản:",
    String(batchText ?? "").trim(),
  ].join("\n");
}

export function parseGenerateContentText(payload) {
  const text = payload?.candidates?.[0]?.content?.parts
    ?.map((part) => part?.text ?? "")
    .join("")
    .trim();
  if (!text) {
    throw new Error("Gemini không trả về văn bản đã làm sạch.");
  }
  return text;
}

export function buildSaveFilename(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `ban-dich-${y}${m}${d}-${hh}${mm}.txt`;
}

export function joinDisplay(polishedText, pendingRawText) {
  return `${polishedText ?? ""}${pendingRawText ?? ""}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/polish-text.test.js`  
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add extension/lib/polish-text.js test/polish-text.test.js
git commit -m "feat: add polish-text helpers for full transcript batches"
```

---

### Task 2: Background Gemini polish API

**Files:**
- Create: `extension/lib/polish.js`
- Modify: `extension/lib/messages.js`
- Modify: `extension/background.js`
- Test: `test/polish-text.test.js` (reuse parse helper; optional light test of prompt wiring not required if Task 1 covers parse)

**Interfaces:**
- Consumes: `buildPolishPrompt`, `parseGenerateContentText`, `DEFAULT_POLISH_MODEL`, `POLISH_MODEL_FALLBACKS` from `polish-text.js`; `GEMINI_API_KEY_STORAGE_KEY` from `messages.js`
- Produces:
  - `MessageType.POLISH_TRANSCRIPT = "POLISH_TRANSCRIPT"`
  - `polishTranscriptText({ text, apiKey, model? }): Promise<string>`
  - Background command: on `POLISH_TRANSCRIPT` with `{ text }`, respond `{ ok: true, text }` or `{ ok: false, error }`

- [ ] **Step 1: Add message constant**

In `extension/lib/messages.js`, add inside `MessageType`:

```js
  POLISH_TRANSCRIPT: "POLISH_TRANSCRIPT",
```

- [ ] **Step 2: Implement `extension/lib/polish.js`**

```js
import {
  DEFAULT_POLISH_MODEL,
  POLISH_MODEL_FALLBACKS,
  buildPolishPrompt,
  parseGenerateContentText,
} from "./polish-text.js";

export async function polishTranscriptText({
  text,
  apiKey,
  model = DEFAULT_POLISH_MODEL,
}) {
  const batch = String(text ?? "").trim();
  if (!batch) {
    return "";
  }
  if (!apiKey) {
    throw new Error("Cần Gemini API key để làm sạch bản dịch.");
  }

  const models = [model, ...POLISH_MODEL_FALLBACKS.filter((item) => item !== model)];
  let lastError = null;

  for (const candidate of models) {
    try {
      return await generatePolishedText({
        apiKey,
        model: candidate,
        prompt: buildPolishPrompt(batch),
      });
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      // Try next model on not-found / unsupported; otherwise stop.
      if (!/not found|404|unsupported|NOT_FOUND/i.test(message)) {
        throw error;
      }
    }
  }

  throw lastError ?? new Error("Không làm sạch được bản dịch.");
}

async function generatePolishedText({ apiKey, model, prompt }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
      },
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail =
      payload?.error?.message ||
      payload?.error?.status ||
      `HTTP ${response.status}`;
    if (response.status === 429) {
      throw new Error("Quota tạm thời — giữ bản thô");
    }
    throw new Error(detail);
  }

  return parseGenerateContentText(payload);
}
```

- [ ] **Step 3: Wire background handler**

In `extension/background.js`:

1. Import `polishTranscriptText` from `./lib/polish.js`.
2. In `handleCommand`, add:

```js
  if (message?.type === MessageType.POLISH_TRANSCRIPT) {
    const apiKey = await readGeminiApiKey();
    const text = await polishTranscriptText({
      text: message.text,
      apiKey,
    });
    return { text };
  }
```

(`readGeminiApiKey` already exists in this file.)

- [ ] **Step 4: Smoke-check handler wiring**

Run: `node --test test/polish-text.test.js`  
Expected: PASS (no regressions)

Manually sanity-check that `MessageType.POLISH_TRANSCRIPT` is exported (read file).

- [ ] **Step 5: Commit**

```bash
git add extension/lib/messages.js extension/lib/polish.js extension/background.js
git commit -m "feat: polish transcript batches via Gemini Flash-Lite"
```

---

### Task 3: Overlay full-transcript panel UI + session buffers

**Files:**
- Modify: `extension/content/overlay.js`

**Interfaces:**
- Consumes: background `POLISH_TRANSCRIPT` via `chrome.runtime.sendMessage`; inline copies of `takeCompletedBatch`, `takeAllCompletedAndRest`, `joinDisplay`, `buildSaveFilename`, `POLISH_BATCH_SIZE` with **identical behavior** to `extension/lib/polish-text.js`
- Produces: slide-out panel UX; session buffers; auto polish; save download

- [ ] **Step 1: Extend overlay markup**

In the Bản dịch header row, after the language `<select>`, add:

```html
<button type="button" class="icon-btn full-btn" id="fullTranscriptButton" title="Bản dịch đầy đủ" aria-label="Bản dịch đầy đủ" aria-expanded="false">▤</button>
```

After `</div>` of `.widget` (still inside host root structure), add sibling panel inside a wrapper. Easiest layout: wrap existing `.widget` + new panel in `.shell-row`:

```html
<div class="shell-row" id="shellRow">
  <div class="widget" part="widget">
    ...existing widget...
  </div>
  <aside class="full-panel" id="fullPanel" hidden>
    <header class="full-panel-header">
      <strong>Bản dịch đầy đủ</strong>
      <div class="full-panel-actions">
        <button type="button" class="secondary compact-btn" id="saveTranscriptButton">Lưu file</button>
        <button type="button" class="icon-btn" id="closeFullPanelButton" title="Đóng" aria-label="Đóng">✕</button>
      </div>
    </header>
    <p class="full-panel-status" id="fullPanelStatus" role="status">Chưa có bản dịch</p>
    <div class="full-panel-body" id="fullPanelBody" data-empty="Toàn bộ bản dịch của phiên sẽ hiện tại đây."></div>
  </aside>
</div>
```

Update host width handling: when panel open, expand host so both columns fit (widget width + ~300px panel), e.g. set `host.style.width` to `widgetWidth + panelWidth + gap` while open.

- [ ] **Step 2: Add CSS for shell-row + full panel**

Inside `overlayCss()`, add approximately:

```css
.shell-row {
  display: flex;
  align-items: stretch;
  gap: 8px;
  max-width: 100%;
}
.widget { flex: 0 1 auto; width: 100%; min-width: 0; }
.full-panel {
  flex: 0 0 300px;
  width: 300px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  color: var(--text);
  background: rgb(var(--bg) / var(--panel-alpha));
  border: 1px solid rgb(var(--border) / var(--panel-alpha));
  border-radius: var(--radius);
  box-shadow: 0 12px 36px rgb(0 0 0 / calc(0.32 * var(--panel-alpha)));
  overflow: hidden;
}
.full-panel[hidden] { display: none !important; }
.full-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 10px 8px 12px;
  background: rgb(var(--bg-2) / var(--panel-alpha));
  border-bottom: 1px solid rgb(var(--border) / var(--panel-alpha));
}
.full-panel-actions { display: flex; align-items: center; gap: 6px; }
.full-panel-status {
  margin: 0;
  padding: 6px 12px 0;
  color: var(--faint);
  font-size: 11px;
}
.full-panel-body {
  flex: 1 1 auto;
  min-height: 160px;
  max-height: min(70vh, 640px);
  overflow: auto;
  margin: 8px 12px 12px;
  padding: 10px;
  border: 1px solid rgb(var(--border) / max(0.75, var(--panel-alpha)));
  border-radius: 6px;
  background: rgb(var(--bg-3) / max(0.88, var(--panel-alpha)));
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
  cursor: text;
}
.full-panel-body:empty::before {
  content: attr(data-empty);
  color: var(--faint);
}
.full-btn { width: 28px; height: 28px; flex: 0 0 auto; }
.transcript-head select { max-width: calc(58% - 36px); }
.compact-btn {
  width: auto;
  min-width: 64px;
  height: 28px;
  padding: 0 10px;
  font-size: 12px;
}
```

- [ ] **Step 3: Add session buffer state + inline helpers**

Near other `let` state in overlay:

```js
let fullPanelOpen = false;
let polishedText = "";
let pendingRawText = "";
let polishedSentenceCount = 0;
let polishInFlight = false;
const POLISH_BATCH_SIZE = 18;
```

Paste the same implementations of `countCompletedSentences`, `takeCompletedBatch`, `takeAllCompletedAndRest`, `joinDisplay`, `buildSaveFilename` as local functions (copy from `extension/lib/polish-text.js` — do not use `import`).

Wire elements:

```js
const fullTranscriptButton = shadow.querySelector("#fullTranscriptButton");
const fullPanel = shadow.querySelector("#fullPanel");
const fullPanelBody = shadow.querySelector("#fullPanelBody");
const fullPanelStatus = shadow.querySelector("#fullPanelStatus");
const saveTranscriptButton = shadow.querySelector("#saveTranscriptButton");
const closeFullPanelButton = shadow.querySelector("#closeFullPanelButton");
const shellRow = shadow.querySelector("#shellRow");
```

- [ ] **Step 4: Implement panel toggle, render, accumulate, polish, save**

```js
function resetFullTranscript() {
  polishedText = "";
  pendingRawText = "";
  polishedSentenceCount = 0;
  polishInFlight = false;
  renderFullPanel();
}

function renderFullPanel() {
  const display = joinDisplay(polishedText, pendingRawText);
  fullPanelBody.textContent = display;
  const pendingCompleted = countCompletedSentences(pendingRawText);
  const totalCompleted = polishedSentenceCount + pendingCompleted;
  if (polishInFlight) {
    fullPanelStatus.textContent = "Đang làm sạch…";
  } else if (!display.trim()) {
    fullPanelStatus.textContent = "Chưa có bản dịch";
  } else {
    fullPanelStatus.textContent = `Đã làm sạch ${polishedSentenceCount}/${totalCompleted || polishedSentenceCount} câu`;
  }
}

function setFullPanelOpen(open) {
  fullPanelOpen = open;
  fullPanel.hidden = !open;
  fullTranscriptButton.setAttribute("aria-expanded", open ? "true" : "false");
  // Expand host when open: keep current widget width + 308px panel/gap
  const widgetWidth = Math.round(widget.getBoundingClientRect().width) || DEFAULT_WIDTH;
  host.style.width = open ? `${widgetWidth + 308}px` : `${widgetWidth}px`;
  host.style.maxWidth = "calc(100vw - 16px)";
}

function appendFullTranscript(text) {
  if (!text) return;
  pendingRawText += text;
  renderFullPanel();
  void maybePolishBatch(false);
}

async function maybePolishBatch(forceAll) {
  if (polishInFlight) return;
  const slice = forceAll
    ? takeAllCompletedAndRest(pendingRawText)
    : takeCompletedBatch(pendingRawText, POLISH_BATCH_SIZE);
  if (!slice || !slice.batchText.trim()) {
    if (forceAll) {
      pendingRawText = slice?.rest ?? pendingRawText;
      renderFullPanel();
    }
    return;
  }

  polishInFlight = true;
  renderFullPanel();
  try {
    const response = await chrome.runtime.sendMessage({
      type: "POLISH_TRANSCRIPT",
      text: slice.batchText,
    });
    if (!response?.ok) {
      throw new Error(response?.error ?? "Làm sạch thất bại.");
    }
    const cleaned = String(response.text ?? "").trim();
    polishedText += (polishedText && !polishedText.endsWith("\n") ? "\n" : "") + cleaned + "\n";
    polishedSentenceCount += countCompletedSentences(slice.batchText);
    pendingRawText = slice.rest;
  } catch (error) {
    fullPanelStatus.textContent =
      error instanceof Error ? error.message : String(error);
  } finally {
    polishInFlight = false;
    renderFullPanel();
  }
}

function downloadTranscriptFile() {
  const display = joinDisplay(polishedText, pendingRawText).trim();
  if (!display) return;
  const blob = new Blob([display + "\n"], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = buildSaveFilename(new Date());
  anchor.rel = "noopener";
  document.documentElement.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
```

Event wiring:

```js
fullTranscriptButton.addEventListener("click", () => {
  setFullPanelOpen(!fullPanelOpen);
});
closeFullPanelButton.addEventListener("click", () => setFullPanelOpen(false));
saveTranscriptButton.addEventListener("click", () => downloadTranscriptFile());
```

In message switch:

- `TRANSCRIPT`: existing `appendTranscript(...)` **and** `appendFullTranscript(message.text ?? "")`
- `TRANSCRIPT_CLEAR`: existing clear **and** `resetFullTranscript()`
- `STOPPED`: after existing stop UI, `void maybePolishBatch(true)`

On Start button success path / when status becomes live after start: call `resetFullTranscript()` once at start click (before/with `clearTranscripts()`).

Use message type string `"POLISH_TRANSCRIPT"` or add the same key to overlay's local `MessageType` object:

```js
POLISH_TRANSCRIPT: "POLISH_TRANSCRIPT",
```

- [ ] **Step 5: Manual verification checklist**

1. Reload extension, refresh event tab, open overlay.
2. Click ▤ — panel opens to the right; click again / ✕ — closes.
3. Run translation; full panel accumulates text beyond the 3-sentence live pane.
4. After ~18 completed sentences, status shows “Đang làm sạch…” then count updates.
5. Stop — leftover pending is polished once.
6. Lưu file downloads `ban-dich-….txt`.
7. With API key removed: panel still shows raw; polish status shows key error (non-fatal).

- [ ] **Step 6: Commit**

```bash
git add extension/content/overlay.js
git commit -m "feat: add full transcript slide-out panel with AI polish and save"
```

---

### Task 4: Spec coverage pass + README note

**Files:**
- Modify: `README.md` (short Extension section note only)
- Modify: `docs/superpowers/specs/2026-07-27-full-transcript-polish-design.md` (set Status to Implemented)

- [ ] **Step 1: Update README Extension section**

Add under extension usage:

```markdown
- Click **▤** beside Bản dịch to open the full-transcript panel.
- Every ~18 sentences, Gemini Flash-Lite cleans punctuation/flow (same API key).
- Use **Lưu file** to download `ban-dich-YYYYMMDD-HHmm.txt`.
```

- [ ] **Step 2: Mark design spec status**

Change `Status: Draft for review` → `Status: Implemented`

- [ ] **Step 3: Run unit tests**

Run: `node --test test/polish-text.test.js test/audio-mix.test.js`  
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/specs/2026-07-27-full-transcript-polish-design.md
git commit -m "docs: note full transcript panel and mark polish spec implemented"
```

---

## Spec coverage self-check

| Spec requirement | Task |
|------------------|------|
| Button beside Bản dịch | Task 3 |
| Slide-out panel right of overlay | Task 3 |
| Full session text | Task 3 buffers |
| Live pane still ~3 sentences | unchanged path + separate full buffer |
| Clean-edit polish only | Task 1 prompt + Task 2 API |
| Batch ~18 sentences | Task 1/3 `POLISH_BATCH_SIZE` |
| Flash-Lite + fallbacks | Task 1 constants + Task 2 |
| Background generateContent | Task 2 |
| Polish remainder on Stop | Task 3 `maybePolishBatch(true)` |
| Reset on Start | Task 3 |
| Save `.txt` Blob download | Task 3 |
| Missing key / 429 handling | Task 2 + Task 3 status |
| No Live audio pipeline changes | respected |

## Placeholder scan

No TBD / “implement later” steps remain.
