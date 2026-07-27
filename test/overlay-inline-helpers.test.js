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

test("minimize clears fixed host height so collapsed overlay shrinks to header", async () => {
  const overlaySource = await readFile(OVERLAY_PATH, "utf8");
  assert.match(overlaySource, /function setCollapsed\(/);
  assert.match(overlaySource, /setCollapsed\(!widget\.classList\.contains\("collapsed"\)\)/);
  // Collapse must drop the sized height; expand restores the remembered height.
  assert.match(
    overlaySource,
    /function setCollapsed\(collapsed\)[\s\S]*?host\.style\.height\s*=\s*""/,
  );
  assert.match(overlaySource, /\.widget\.collapsed\s*\{[^}]*height:\s*auto/s);
  assert.match(overlaySource, /let expandedHeight\s*=\s*null/);
  assert.match(
    overlaySource,
    /overlayHeight:\s*collapsed\s*\?[\s\S]*?expandedHeight/,
  );
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

test("transcript panel sticks to bottom only when near end and scrolls inside #body", async () => {
  const panelJsPath = new URL("../extension/transcript-panel.js", import.meta.url);
  const panelCssPath = new URL("../extension/transcript-panel.css", import.meta.url);
  const [panelJs, panelCss] = await Promise.all([
    readFile(panelJsPath, "utf8"),
    readFile(panelCssPath, "utf8"),
  ]);

  assert.match(panelJs, /stuckNearBottom/);
  assert.match(
    panelJs,
    /requestAnimationFrame\(\s*\(\)\s*=>\s*\{\s*bodyEl\.scrollTop\s*=\s*bodyEl\.scrollHeight/,
  );
  // Flex child must shrink so overflow:auto scrolls inside the frame, not the page.
  assert.match(panelCss, /\.shell\s*\{[^}]*height:\s*100vh/s);
  assert.match(panelCss, /\.shell\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(panelCss, /\.body\s*\{[^}]*min-height:\s*0/s);
});
