# Full transcript panel + AI polish (Approach A)

Date: 2026-07-27  
Status: Implemented  
Product: Chrome extension “Dịch sự kiện trực tiếp”

## Goal

Beside the live “Bản dịch” pane (last few sentences), add a button that opens a **side panel attached to the overlay**. That panel shows the **full translated transcript** for the session. Every ~15–20 new sentences, send a batch to a **free-tier Gemini model** to clean punctuation/flow **without changing meaning**. User can **save** the polished text to a local file.

## Confirmed decisions

| Decision | Choice |
|----------|--------|
| Polish style | Clean edit only (punctuation, sentence flow); keep meaning |
| When AI runs | Automatic batch every ~18 sentences of new raw translation |
| Free model preference | Gemini Flash-Lite via existing API key |
| Panel placement | Slide-out panel attached to the right of the overlay |
| Approach | A — accumulate + polish in overlay/session UI; background does API call |

## Non-goals

- Summarization / rewrite tone
- Continuous per-sentence polish (too many API calls)
- Server-side storage or accounts
- Changing Live Translate audio pipeline

## UX

### Trigger

- Small button on the **Bản dịch** header row (e.g. icon/label “Full”), next to the language select.
- Toggle: opens/closes the slide-out panel.

### Panel contents

1. Scrollable full text (polished segments + trailing raw segment not yet polished).
2. Status line, e.g. `Đã làm sạch 36/42 câu` or `Đang làm sạch…`.
3. **Lưu file** button → downloads `.txt`.
4. Optional: small “Đóng” control (same as toggle).

### Live vs full pane

- Existing live transcript UI keeps showing only recent sentences (~3).
- Full panel is the only place that shows the entire session text.

### Empty / error states

- No translation yet: empty hint in panel.
- Missing API key: status explains need to save key; batch polish skipped until key exists.
- Polish API failure: keep raw batch visible; show non-blocking error; retry on next batch boundary or manual retry later (v1: next batch / reopen is enough).

## Data model (session)

Keep in memory for the active capture session (clear on Stop / new Start):

```text
fullRawText: string             // append every TRANSCRIPT chunk (streaming deltas)
polishedText: string            // concatenated cleaned batches
pendingRawText: string          // fullRawText slice not yet polished
completedSentenceCount: number  // count of finished sentences inside pendingRawText
polishInFlight: boolean
```

Live Translate emits **incremental** `outputTranscription` chunks (not whole sentences). Therefore:

1. Append each `TRANSCRIPT.text` to `fullRawText` / `pendingRawText`.
2. Detect completed sentences in `pendingRawText` with a simple splitter on `. ! ? … 。 ！ ？` (and newlines).
3. When **completed sentence count in pending ≥ 18** and not in flight → send those completed sentences to polish; leave any trailing incomplete fragment in `pendingRawText`.

Display text in panel:

```text
display = polishedText + pendingRawText
```

**Batch size:** `POLISH_BATCH_SIZE = 18` completed sentences (within 15–20).

## AI polish

### Model

- Primary: `gemini-2.5-flash-lite` (free-tier friendly).
- Fallback if 404/unsupported: `gemini-2.0-flash-lite` or `gemini-2.5-flash`.
- Configurable constant in extension code (not required in UI for v1).

### API

- `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
- Auth: existing `geminiApiKey` from `chrome.storage.local`.
- Call from **background service worker** (or offscreen) so content script does not hold the key in extra places and CORS is avoided.
- Host permission already includes `https://generativelanguage.googleapis.com/*`.

### Prompt (intent)

System/user instruction in Vietnamese or bilingual, roughly:

- Input: 15–20 raw translated sentences (joined).
- Output: same content, cleaned punctuation and cohesion.
- Do not add facts, remove content, summarize, or translate to another language.
- Return plain text only.

### Trigger rules

1. After each `TRANSCRIPT` chunk is appended to `pendingRawText`.
2. If completed-sentence count in `pendingRawText` ≥ 18 and not `polishInFlight` → polish that completed prefix.
3. On **Stop**: polish any remaining pending text once (even if < 18 sentences), so Save is complete.
4. On **Start**: reset all session buffers and clear panel text.

### Rate limits

- One request per batch (~18 sentences) → low RPM; fine for free tier.
- If 429: backoff once, keep raw; surface status “Quota tạm thời — giữ bản thô”.

## Save file

- Format: UTF-8 `.txt`
- Filename: `ban-dich-YYYYMMDD-HHmm.txt`
- Contents: current `display` text (polished + trailing raw).
- Implementation: Blob + temporary `<a download>` from overlay, or `chrome.downloads` if we add permission later. Prefer Blob download in overlay for v1 (no new permission).

## Architecture

```text
Live WS (offscreen)
  → TRANSCRIPT messages (as today)
  → overlay appends to live UI (last N) AND full rawSentences

When batch ready:
  overlay → runtime message POLISH_TRANSCRIPT { text }
  background → generateContent(Flash-Lite)
  background → response { ok, text } | { ok:false, error }
  overlay merges into polishedText, shrinks pendingRawText, refreshes panel
```

### New message types

- `POLISH_TRANSCRIPT`
- (optional) `POLISH_RESULT` if async push; v1 can use request/response on `sendMessage`

### Files likely touched

- `extension/content/overlay.js` — panel UI, buffers, toggle, save
- `extension/background.js` — polish handler + Gemini REST call
- `extension/lib/messages.js` — message constants
- `extension/lib/` — small `polish.js` helper (prompt + parse response)
- CSS inside overlay shadow styles

## Testing (manual)

1. Start session with API key; open Full panel; confirm sentences accumulate.
2. After ~18 segments, status shows polish; text becomes cleaner; count updates.
3. Stop with leftover sentences → remaining polished once.
4. Lưu file downloads expected content.
5. Without API key: panel still shows raw; polish status explains missing key.
6. Simulate 429 / network error: raw preserved, error status shown.

## Open points (defaults if unstated)

- Batch size 18; polish remainder on Stop: **yes**.
- Panel width ~280–320px; does not replace live transcripts.
- No persistence of full transcript across browser restart (session-only).

## Success criteria

- User can open full translated text without digging settings.
- Meaning-preserving cleanup runs automatically every ~18 sentences using a free Gemini model.
- User can download a usable `.txt` of the session text.
