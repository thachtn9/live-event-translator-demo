import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const OVERLAY_PATH = new URL("../extension/content/overlay.js", import.meta.url);
const BACKGROUND_PATH = new URL("../extension/background.js", import.meta.url);
const MANIFEST_PATH = new URL("../extension/manifest.json", import.meta.url);

test("overlay opens Chrome Side Panel instead of floating full panel", async () => {
  const overlaySource = await readFile(OVERLAY_PATH, "utf8");
  assert.match(overlaySource, /OPEN_TRANSCRIPT_PANEL/);
  assert.match(overlaySource, /removeLegacyFullPanelHost/);
  assert.doesNotMatch(overlaySource, /fullPanelHost/);
  assert.doesNotMatch(overlaySource, /function maybePolishBatch/);
});

test("background owns transcript session and side panel open", async () => {
  const [backgroundSource, manifestSource] = await Promise.all([
    readFile(BACKGROUND_PATH, "utf8"),
    readFile(MANIFEST_PATH, "utf8"),
  ]);
  const manifest = JSON.parse(manifestSource);

  assert.ok(manifest.permissions.includes("sidePanel"));
  assert.equal(manifest.side_panel?.default_path, "transcript-panel.html");
  assert.match(backgroundSource, /OPEN_TRANSCRIPT_PANEL/);
  assert.match(backgroundSource, /GET_FULL_TRANSCRIPT/);
  assert.match(backgroundSource, /createTranscriptSession/);
  assert.match(backgroundSource, /chrome\.sidePanel\.open\(\{ windowId \}\)/);
});
