(() => {
  const HOST_ID = "live-event-translator-overlay-host";
  const MessageType = {
    START: "START",
    STOP: "STOP",
    SET_MIX: "SET_MIX",
    GET_STATE: "GET_STATE",
    STATUS: "STATUS",
    TRANSCRIPT: "TRANSCRIPT",
    TRANSCRIPT_ORIGINAL: "TRANSCRIPT_ORIGINAL",
    TRANSCRIPT_CLEAR: "TRANSCRIPT_CLEAR",
    INPUT_LEVEL: "INPUT_LEVEL",
    ERROR: "ERROR",
    STOPPED: "STOPPED",
    OVERLAY_PING: "OVERLAY_PING",
    POLISH_TRANSCRIPT: "POLISH_TRANSCRIPT",
  };

  if (window.__liveEventTranslatorOverlayLoaded) {
    showHost();
    return;
  }
  window.__liveEventTranslatorOverlayLoaded = true;

  let running = false;
  let dragState = null;
  let resizeState = null;

  let fullPanelOpen = false;
  let polishedText = "";
  let pendingRawText = "";
  let fullRawText = "";
  let polishedSentenceCount = 0;
  let polishInFlight = false;
  let polishFlushQueued = false;
  let polishFailure = null;
  let lastPolishError = "";
  let lastForceFlushAt = 0;
  let transcriptGeneration = 0;
  const POLISH_BATCH_SIZE = 18;
  const POLISH_FAILURE_COOLDOWN_MS = 30000;
  const MIN_POLISH_LENGTH_RATIO = 0.4;
  const MIN_POLISH_LENGTH_CHECK = 40;
  const FORCE_FLUSH_DEBOUNCE_MS = 2000;
  const SCROLL_STICK_SLACK = 24;

  const MIN_WIDTH = 280;
  const MIN_HEIGHT = 240;
  const DEFAULT_WIDTH = 380;
  const FULL_PANEL_WIDTH = 300;
  const FULL_PANEL_GAP = 8;

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.all = "initial";
  host.style.position = "fixed";
  host.style.top = "72px";
  host.style.right = "24px";
  host.style.zIndex = "2147483646";
  host.style.width = `${DEFAULT_WIDTH}px`;
  host.style.maxWidth = "calc(100vw - 16px)";
  host.style.maxHeight = "calc(100vh - 16px)";
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>${overlayCss()}</style>
    <div class="shell-row" id="shellRow">
      <div class="widget" part="widget">
        <header class="drag-handle" title="Kéo để di chuyển">
          <div class="title-wrap">
            <strong>Dịch sự kiện trực tiếp</strong>
            <span class="status-chip">
              <i class="dot" id="statusDot"></i>
              <span id="statusText">Đã dừng</span>
            </span>
          </div>
          <div class="header-actions">
            <button type="button" class="icon-btn" id="minimizeButton" title="Thu gọn" aria-label="Thu gọn">–</button>
            <button type="button" class="icon-btn" id="closeButton" title="Ẩn" aria-label="Ẩn">✕</button>
          </div>
        </header>

        <div class="body" id="widgetBody">
          <div class="actions">
            <button type="button" id="startButton">Bắt đầu dịch</button>
            <button type="button" class="secondary" id="stopButton" disabled>Dừng</button>
          </div>

          <div class="transcripts">
            <div class="transcript-block">
              <div class="row transcript-head">
                <span class="label">Tiếng gốc</span>
                <div
                  class="level-track inline-meter"
                  id="inputMeter"
                  role="meter"
                  aria-label="Mức âm tab"
                  aria-valuemin="0"
                  aria-valuemax="1"
                  aria-valuenow="0"
                  title="Mức âm tab"
                >
                  <div class="level-fill" id="inputMeterFill"></div>
                </div>
              </div>
              <div class="transcript" id="originalTranscript" data-empty="Các câu gốc gần nhất sẽ hiện tại đây."></div>
            </div>
            <div class="transcript-block">
              <div class="row transcript-head">
                <span class="label">Bản dịch</span>
                <select id="targetLanguage" aria-label="Ngôn ngữ đích" title="Ngôn ngữ đích">
                  <option value="vi" selected>Tiếng Việt</option>
                  <option value="en">Tiếng Anh</option>
                  <option value="es">Tiếng Tây Ban Nha</option>
                  <option value="pt">Tiếng Bồ Đào Nha</option>
                  <option value="fr">Tiếng Pháp</option>
                  <option value="ja">Tiếng Nhật</option>
                  <option value="ru">Tiếng Nga</option>
                  <option value="zh">Tiếng Trung</option>
                  <option value="de">Tiếng Đức</option>
                  <option value="ko">Tiếng Hàn</option>
                  <option value="hi">Tiếng Hindi</option>
                  <option value="id">Tiếng Indonesia</option>
                  <option value="it">Tiếng Ý</option>
                </select>
                <button type="button" class="icon-btn full-btn" id="fullTranscriptButton" title="Bản dịch đầy đủ" aria-label="Bản dịch đầy đủ" aria-expanded="false">▤</button>
              </div>
              <div class="transcript" id="translatedTranscript" data-empty="Các câu dịch gần nhất sẽ hiện tại đây."></div>
            </div>
          </div>

          <details class="settings" id="settingsPanel">
            <summary>Cài đặt</summary>
            <div class="settings-body">
              <div class="field api-key-field is-editing" id="apiKeyField">
                <div class="api-key-summary" id="apiKeySummary" hidden>
                  <span class="api-key-ok" aria-hidden="true"></span>
                  <span class="label" id="apiKeySummaryText">API key đã lưu</span>
                  <button type="button" class="text-btn" id="editApiKeyButton">Sửa</button>
                </div>
                <div class="api-key-editor" id="apiKeyEditor">
                  <label for="geminiApiKey">Gemini API key</label>
                  <input
                    id="geminiApiKey"
                    type="password"
                    placeholder="Dán API key…"
                    autocomplete="off"
                    spellcheck="false"
                  />
                  <div class="key-actions">
                    <button type="button" id="saveApiKeyButton">Lưu</button>
                    <button type="button" class="secondary" id="cancelApiKeyButton">Hủy</button>
                    <button type="button" class="secondary" id="clearApiKeyButton">Xóa</button>
                  </div>
                  <p class="hint" id="apiKeyStatus"></p>
                  <p class="hint">
                    Lấy key tại
                    <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Google AI Studio</a>.
                  </p>
                </div>
              </div>

              <div class="field">
                <div class="row">
                  <label for="audioMix">Trộn âm thanh</label>
                  <span class="value" id="mixValue">95% bản dịch</span>
                </div>
                <input id="audioMix" type="range" min="0" max="100" step="1" value="95" />
                <div class="row muted">
                  <span id="originalMixLabel">Gốc 5%</span>
                  <span id="translatedMixLabel">Dịch 95%</span>
                </div>
              </div>

              <div class="field">
                <div class="row">
                  <label for="opacityRange">Độ trong suốt</label>
                  <span class="value" id="opacityValue">5%</span>
                </div>
                <input id="opacityRange" type="range" min="0" max="70" step="1" value="5" />
              </div>
            </div>
          </details>
        </div>
        <div class="resize-handle" id="resizeHandle" title="Kéo để đổi kích thước"></div>
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
  `;

  const widget = shadow.querySelector(".widget");
  const widgetBody = shadow.querySelector("#widgetBody");
  const dragHandle = shadow.querySelector(".drag-handle");
  const statusDot = shadow.querySelector("#statusDot");
  const statusText = shadow.querySelector("#statusText");
  const targetLanguage = shadow.querySelector("#targetLanguage");
  const audioMix = shadow.querySelector("#audioMix");
  const mixValue = shadow.querySelector("#mixValue");
  const originalMixLabel = shadow.querySelector("#originalMixLabel");
  const translatedMixLabel = shadow.querySelector("#translatedMixLabel");
  const opacityRange = shadow.querySelector("#opacityRange");
  const opacityValue = shadow.querySelector("#opacityValue");
  const startButton = shadow.querySelector("#startButton");
  const stopButton = shadow.querySelector("#stopButton");
  const minimizeButton = shadow.querySelector("#minimizeButton");
  const closeButton = shadow.querySelector("#closeButton");
  const inputMeter = shadow.querySelector("#inputMeter");
  const inputMeterFill = shadow.querySelector("#inputMeterFill");
  const originalTranscript = shadow.querySelector("#originalTranscript");
  const translatedTranscript = shadow.querySelector("#translatedTranscript");
  const resizeHandle = shadow.querySelector("#resizeHandle");
  const geminiApiKeyInput = shadow.querySelector("#geminiApiKey");
  const saveApiKeyButton = shadow.querySelector("#saveApiKeyButton");
  const clearApiKeyButton = shadow.querySelector("#clearApiKeyButton");
  const cancelApiKeyButton = shadow.querySelector("#cancelApiKeyButton");
  const editApiKeyButton = shadow.querySelector("#editApiKeyButton");
  const apiKeyStatus = shadow.querySelector("#apiKeyStatus");
  const apiKeySummary = shadow.querySelector("#apiKeySummary");
  const apiKeySummaryText = shadow.querySelector("#apiKeySummaryText");
  const apiKeyEditor = shadow.querySelector("#apiKeyEditor");
  const apiKeyField = shadow.querySelector("#apiKeyField");
  const settingsPanel = shadow.querySelector("#settingsPanel");
  const shellRow = shadow.querySelector("#shellRow");
  const fullTranscriptButton = shadow.querySelector("#fullTranscriptButton");
  const fullPanel = shadow.querySelector("#fullPanel");
  const fullPanelBody = shadow.querySelector("#fullPanelBody");
  const fullPanelStatus = shadow.querySelector("#fullPanelStatus");
  const saveTranscriptButton = shadow.querySelector("#saveTranscriptButton");
  const closeFullPanelButton = shadow.querySelector("#closeFullPanelButton");
  const GEMINI_API_KEY_STORAGE_KEY = "geminiApiKey";
  let hasSavedApiKey = false;

  applyMixLabels(audioMix.value);
  void restoreApiKey();
  void restoreUiPrefs();
  void restoreState();

  saveApiKeyButton.addEventListener("click", () => {
    void saveApiKey();
  });

  clearApiKeyButton.addEventListener("click", () => {
    void clearApiKey();
  });

  cancelApiKeyButton.addEventListener("click", () => {
    if (hasSavedApiKey) {
      setApiKeyEditing(false);
      setApiKeyStatus("");
    }
  });

  editApiKeyButton.addEventListener("click", () => {
    setApiKeyEditing(true);
    settingsPanel.open = true;
    geminiApiKeyInput.focus();
    geminiApiKeyInput.select();
  });

  geminiApiKeyInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void saveApiKey();
    }
    if (event.key === "Escape" && hasSavedApiKey) {
      setApiKeyEditing(false);
    }
  });

  audioMix.addEventListener("input", () => {
    applyMixLabels(audioMix.value);
    if (running) {
      void sendCommand({ type: MessageType.SET_MIX, value: Number(audioMix.value) });
    }
  });

  opacityRange.addEventListener("input", () => {
    applyOpacity(Number(opacityRange.value));
    void saveUiPrefs();
  });

  fullTranscriptButton.addEventListener("click", () => {
    setFullPanelOpen(!fullPanelOpen);
  });

  closeFullPanelButton.addEventListener("click", () => {
    setFullPanelOpen(false);
  });

  saveTranscriptButton.addEventListener("click", () => {
    downloadTranscriptFile();
  });

  startButton.addEventListener("click", async () => {
    clearTranscripts();
    resetFullTranscript();
    setControls(true);
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
      setControls(false);
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
      setControls(false);
      setInputLevel(0);
      // Dừng thủ công không nhận lại STOPPED từ service worker, nên flush ở đây.
      void maybePolishBatch(true);
    }
  });

  minimizeButton.addEventListener("click", () => {
    widget.classList.toggle("collapsed");
    minimizeButton.textContent = widget.classList.contains("collapsed") ? "+" : "–";
  });

  closeButton.addEventListener("click", () => {
    host.style.display = "none";
  });

  dragHandle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    if (event.target.closest("button")) {
      return;
    }
    const rect = host.getBoundingClientRect();
    dragState = {
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    dragHandle.setPointerCapture(event.pointerId);
    widget.classList.add("dragging");
  });

  dragHandle.addEventListener("pointermove", (event) => {
    if (!dragState) {
      return;
    }
    const left = clamp(
      event.clientX - dragState.offsetX,
      8,
      window.innerWidth - host.offsetWidth - 8,
    );
    const top = clamp(
      event.clientY - dragState.offsetY,
      8,
      window.innerHeight - 48,
    );
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
    host.style.right = "auto";
  });

  dragHandle.addEventListener("pointerup", (event) => {
    if (!dragState) {
      return;
    }
    dragState = null;
    widget.classList.remove("dragging");
    try {
      dragHandle.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    void saveUiPrefs();
  });

  resizeHandle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const rect = host.getBoundingClientRect();
    resizeState = {
      startX: event.clientX,
      startY: event.clientY,
      startWidth: rect.width,
      startHeight: rect.height,
    };
    resizeHandle.setPointerCapture(event.pointerId);
    widget.classList.add("resizing");
  });

  resizeHandle.addEventListener("pointermove", (event) => {
    if (!resizeState) {
      return;
    }
    const rect = host.getBoundingClientRect();
    const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - rect.left - 8);
    const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - rect.top - 8);
    const nextWidth = clamp(
      resizeState.startWidth + (event.clientX - resizeState.startX),
      MIN_WIDTH,
      maxWidth,
    );
    const nextHeight = clamp(
      resizeState.startHeight + (event.clientY - resizeState.startY),
      MIN_HEIGHT,
      maxHeight,
    );
    applySize(nextWidth, nextHeight);
  });

  resizeHandle.addEventListener("pointerup", (event) => {
    if (!resizeState) {
      return;
    }
    resizeState = null;
    widget.classList.remove("resizing");
    try {
      resizeHandle.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    void saveUiPrefs();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === MessageType.OVERLAY_PING) {
      showHost();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type?.startsWith?.("OFFSCREEN_")) {
      return false;
    }

    switch (message?.type) {
      case MessageType.STATUS:
        setStatus(message.message ?? statusText.textContent, message.state ?? "idle");
        if (message.state === "live") {
          running = true;
          setControls(true);
        }
        break;
      case MessageType.TRANSCRIPT_CLEAR:
        clearTranscripts();
        resetFullTranscript();
        break;
      case MessageType.TRANSCRIPT_ORIGINAL:
        appendTranscript(originalTranscript, message.text ?? "");
        break;
      case MessageType.TRANSCRIPT:
        appendTranscript(translatedTranscript, message.text ?? "");
        appendFullTranscript(message.text ?? "");
        break;
      case MessageType.INPUT_LEVEL:
        setInputLevel(Number(message.value) || 0);
        break;
      case MessageType.ERROR:
        setStatus(message.message ?? "Lỗi", "error");
        break;
      case MessageType.STOPPED:
        running = false;
        setControls(false);
        setInputLevel(0);
        setStatus(message.message ?? "Đã dừng", message.state ?? "idle");
        void maybePolishBatch(true);
        break;
      default:
        break;
    }
    return false;
  });

  function showHost() {
    host.style.display = "block";
  }

  async function restoreApiKey() {
    try {
      const stored = await chrome.storage.local.get({
        [GEMINI_API_KEY_STORAGE_KEY]: "",
      });
      const key = String(stored[GEMINI_API_KEY_STORAGE_KEY] ?? "").trim();
      geminiApiKeyInput.value = key;
      hasSavedApiKey = Boolean(key);
      setApiKeyEditing(!hasSavedApiKey);
      settingsPanel.open = !hasSavedApiKey;
      setApiKeyStatus(hasSavedApiKey ? "" : "Chưa có API key — dán key rồi bấm Lưu.");
    } catch {
      hasSavedApiKey = false;
      setApiKeyEditing(true);
      settingsPanel.open = true;
      setApiKeyStatus("Không đọc được API key đã lưu.");
    }
  }

  async function saveApiKey() {
    const geminiApiKey = String(geminiApiKeyInput.value ?? "").trim();
    if (!geminiApiKey) {
      setApiKeyStatus("Nhập Gemini API key trước khi lưu.");
      return;
    }
    try {
      await chrome.storage.local.set({
        [GEMINI_API_KEY_STORAGE_KEY]: geminiApiKey,
      });
      geminiApiKeyInput.value = geminiApiKey;
      hasSavedApiKey = true;
      setApiKeyEditing(false);
      setApiKeyStatus("");
    } catch {
      setApiKeyStatus("Không lưu được API key.");
    }
  }

  async function clearApiKey() {
    try {
      await chrome.storage.local.remove(GEMINI_API_KEY_STORAGE_KEY);
      geminiApiKeyInput.value = "";
      hasSavedApiKey = false;
      setApiKeyEditing(true);
      settingsPanel.open = true;
      setApiKeyStatus("Đã xóa API key.");
    } catch {
      setApiKeyStatus("Không xóa được API key.");
    }
  }

  function setApiKeyEditing(editing) {
    const showEditor = Boolean(editing) || !hasSavedApiKey;
    apiKeyEditor.hidden = !showEditor;
    apiKeySummary.hidden = showEditor;
    cancelApiKeyButton.hidden = !hasSavedApiKey;
    apiKeyField?.classList.toggle("is-editing", showEditor);
    apiKeyField?.classList.toggle("has-key", hasSavedApiKey);
    if (!showEditor) {
      apiKeySummaryText.textContent = "API key đã lưu";
    }
  }

  function setApiKeyStatus(message) {
    apiKeyStatus.textContent = message;
    apiKeyStatus.hidden = !message;
  }

  async function restoreUiPrefs() {
    try {
      const prefs = await chrome.storage.local.get({
        overlayOpacity: 5,
        overlayLeft: null,
        overlayTop: null,
        overlayWidth: DEFAULT_WIDTH,
        overlayHeight: null,
      });
      const opacity = Number(prefs.overlayOpacity);
      applyOpacity(Number.isFinite(opacity) ? opacity : 5);
      opacityRange.value = String(Number.isFinite(opacity) ? opacity : 5);
      if (prefs.overlayLeft != null && prefs.overlayTop != null) {
        host.style.left = `${prefs.overlayLeft}px`;
        host.style.top = `${prefs.overlayTop}px`;
        host.style.right = "auto";
      }
      const width = clamp(
        Number(prefs.overlayWidth) || DEFAULT_WIDTH,
        MIN_WIDTH,
        window.innerWidth - 16,
      );
      const height =
        prefs.overlayHeight == null
          ? null
          : clamp(Number(prefs.overlayHeight) || MIN_HEIGHT, MIN_HEIGHT, window.innerHeight - 16);
      applySize(width, height);
    } catch {
      // ignore
    }
  }

  async function saveUiPrefs() {
    const rect = host.getBoundingClientRect();
    // Lưu kích thước widget, không phải host: khi panel mở host rộng thêm ~308px.
    const widgetRect = widget.getBoundingClientRect();
    try {
      await chrome.storage.local.set({
        overlayOpacity: Number(opacityRange.value) || 0,
        overlayLeft: Math.round(rect.left),
        overlayTop: Math.round(rect.top),
        overlayWidth: Math.round(widgetRect.width) || Math.round(rect.width),
        overlayHeight: Math.round(widgetRect.height) || Math.round(rect.height),
      });
    } catch {
      // ignore
    }
  }

  function applySize(width, height) {
    // Khi panel mở, host phải đủ chỗ cho cả widget lẫn panel.
    const extra = fullPanelOpen ? FULL_PANEL_WIDTH + FULL_PANEL_GAP : 0;
    host.style.width = `${Math.round(Math.max(width, MIN_WIDTH + extra))}px`;
    if (height == null) {
      host.style.height = "";
      widget.classList.remove("sized");
      return;
    }
    host.style.height = `${Math.round(height)}px`;
    widget.classList.add("sized");
  }

  async function restoreState() {
    try {
      const state = await sendCommand({ type: MessageType.GET_STATE });
      if (typeof state.mix === "number") {
        audioMix.value = String(state.mix);
        applyMixLabels(state.mix);
      }
      if (state.targetLanguage) {
        targetLanguage.value = state.targetLanguage;
      }
      running = Boolean(state.running);
      setControls(running);
      if (state.status) {
        setStatus(state.status.message, state.status.state);
      }
    } catch {
      // ignore
    }
  }

  async function sendCommand(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) {
      throw new Error(response?.error ?? "Lệnh extension thất bại.");
    }
    return response;
  }

  function applyMixLabels(value) {
    const translated = clamp(Number.parseInt(String(value), 10) || 95, 0, 100);
    const original = 100 - translated;
    mixValue.textContent = `${translated}% bản dịch`;
    originalMixLabel.textContent = `Gốc ${original}%`;
    translatedMixLabel.textContent = `Dịch ${translated}%`;
  }

  function applyOpacity(transparencyPercent) {
    const value = clamp(Number(transparencyPercent) || 0, 0, 70);
    opacityRange.value = String(value);
    opacityValue.textContent = `${value}%`;
    // Chỉ làm trong nền panel — chữ trong 2 khung transcript luôn đậm 100%.
    shellRow.style.setProperty("--panel-alpha", String(1 - value / 100));
    shellRow.style.opacity = "";
  }

  function setControls(isRunning) {
    startButton.disabled = isRunning;
    stopButton.disabled = !isRunning;
    targetLanguage.disabled = isRunning;
  }

  function setStatus(message, state = "idle") {
    statusText.textContent = message;
    statusDot.className = `dot${state === "live" ? " live" : ""}${
      state === "error" ? " error" : ""
    }`;
    widget.classList.toggle("is-error", state === "error");
    widget.classList.toggle("is-live", state === "live");
  }

  function setInputLevel(value) {
    const level = clamp(Number(value) || 0, 0, 1);
    inputMeterFill.style.width = `${level * 100}%`;
    inputMeter.setAttribute("aria-valuenow", String(level));
  }

  const MAX_RECENT_SENTENCES = 3;

  function appendTranscript(node, text) {
    if (!node || !text) {
      return;
    }
    node.textContent = keepRecentSentences(
      node.textContent + text,
      MAX_RECENT_SENTENCES,
    );
    node.scrollTop = node.scrollHeight;
  }

  function keepRecentSentences(text, maxSentences) {
    const parts = text.match(/[^.!?\n。！？…]+(?:[.!?\n。！？…]+|$)/g);
    if (!parts || parts.length <= maxSentences) {
      return text;
    }
    return parts.slice(-maxSentences).join("").replace(/^\s+/, "");
  }

  function clearTranscripts() {
    originalTranscript.textContent = "";
    translatedTranscript.textContent = "";
  }

  function resetFullTranscript() {
    // Tăng generation để phản hồi làm sạch của phiên cũ bị bỏ qua khi quay về.
    transcriptGeneration += 1;
    polishedText = "";
    pendingRawText = "";
    fullRawText = "";
    polishedSentenceCount = 0;
    polishFlushQueued = false;
    polishFailure = null;
    lastPolishError = "";
    lastForceFlushAt = 0;
    // Không hạ polishInFlight ở đây: request cũ vẫn đang chạy và sẽ tự dọn khi
    // trả về, giữ cờ bật tránh hai lượt làm sạch chồng nhau.
    renderFullPanel();
  }

  function renderFullPanel() {
    const display = joinDisplay(polishedText, pendingRawText);
    const stickToBottom =
      fullPanelBody.scrollHeight -
        fullPanelBody.scrollTop -
        fullPanelBody.clientHeight <
      SCROLL_STICK_SLACK;
    fullPanelBody.textContent = display;
    if (stickToBottom) {
      fullPanelBody.scrollTop = fullPanelBody.scrollHeight;
    }

    const pendingCompleted = countCompletedSentences(pendingRawText);
    const totalCompleted = polishedSentenceCount + pendingCompleted;
    if (polishInFlight) {
      fullPanelStatus.textContent = "Đang làm sạch…";
    } else if (lastPolishError) {
      // Giữ lỗi trên panel tới khi có lượt làm sạch thành công hoặc reset.
      fullPanelStatus.textContent = lastPolishError;
    } else if (!display.trim()) {
      fullPanelStatus.textContent = "Chưa có bản dịch";
    } else if (totalCompleted > 0) {
      fullPanelStatus.textContent = `Đã làm sạch ${polishedSentenceCount}/${totalCompleted} câu`;
    } else if (polishedText.trim()) {
      fullPanelStatus.textContent = "Đã làm sạch đoạn hiện có";
    } else {
      fullPanelStatus.textContent = "Đang chờ đủ câu để làm sạch";
    }
  }

  function setFullPanelOpen(open) {
    fullPanelOpen = Boolean(open);
    // Đo bề rộng widget trước khi đổi `hidden`: sau khi panel hiện, widget đã bị co lại.
    const measured = Math.round(widget.getBoundingClientRect().width);
    const widgetWidth = Math.max(MIN_WIDTH, measured || DEFAULT_WIDTH);

    fullPanel.hidden = !fullPanelOpen;
    fullTranscriptButton.setAttribute(
      "aria-expanded",
      fullPanelOpen ? "true" : "false",
    );
    host.style.width = fullPanelOpen
      ? `${widgetWidth + FULL_PANEL_WIDTH + FULL_PANEL_GAP}px`
      : `${widgetWidth}px`;
    host.style.maxWidth = "calc(100vw - 16px)";
    keepHostInViewport();
    if (fullPanelOpen) {
      renderFullPanel();
    }
  }

  function keepHostInViewport() {
    if (!host.style.left) {
      return;
    }
    const width = host.getBoundingClientRect().width;
    const left = clamp(
      Number.parseFloat(host.style.left) || 0,
      8,
      Math.max(8, window.innerWidth - width - 8),
    );
    host.style.left = `${left}px`;
  }

  function appendFullTranscript(text) {
    if (!text) {
      return;
    }
    pendingRawText += text;
    fullRawText += text;
    renderFullPanel();
    void maybePolishBatch(false);
  }

  async function maybePolishBatch(forceAll) {
    if (forceAll) {
      // STOPPED và nút Dừng đều flush: bỏ qua lần thứ hai sát nhau.
      const now = Date.now();
      if (!pendingRawText.trim() || now - lastForceFlushAt < FORCE_FLUSH_DEBOUNCE_MS) {
        return;
      }
      lastForceFlushAt = now;
    } else if (
      isPolishCooldownActive(polishFailure, {
        now: Date.now(),
        pendingCompleted: countCompletedSentences(pendingRawText),
        cooldownMs: POLISH_FAILURE_COOLDOWN_MS,
        batchSize: POLISH_BATCH_SIZE,
      })
    ) {
      return;
    }

    if (polishInFlight) {
      // Giữ lại yêu cầu làm sạch phần còn lại để chạy ngay sau lượt hiện tại.
      polishFlushQueued = polishFlushQueued || Boolean(forceAll);
      return;
    }

    const snapshot = pendingRawText;
    const slice = forceAll
      ? takeAllCompletedAndRest(snapshot)
      : takeCompletedBatch(snapshot, POLISH_BATCH_SIZE);
    if (!slice || !slice.batchText.trim()) {
      if (forceAll) {
        pendingRawText = slice?.rest ?? pendingRawText;
        renderFullPanel();
      }
      return;
    }

    const generation = transcriptGeneration;
    polishInFlight = true;
    renderFullPanel();
    try {
      const response = await chrome.runtime.sendMessage({
        type: MessageType.POLISH_TRANSCRIPT,
        text: slice.batchText,
      });
      if (generation !== transcriptGeneration) {
        // Phiên đã reset trong lúc chờ: bỏ phản hồi, không đụng vào buffer mới.
        polishInFlight = false;
        renderFullPanel();
      } else {
        if (!response?.ok) {
          throw new Error(response?.error ?? "Làm sạch thất bại.");
        }
        const cleaned = String(response.text ?? "").trim();
        if (
          isImplausiblePolish(cleaned, slice.batchText, {
            ratio: MIN_POLISH_LENGTH_RATIO,
            minLength: MIN_POLISH_LENGTH_CHECK,
          })
        ) {
          throw new Error("Bản làm sạch ngắn bất thường — giữ nguyên văn bản thô.");
        }
        polishedText +=
          (polishedText && !polishedText.endsWith("\n") ? "\n" : "") + cleaned + "\n";
        polishedSentenceCount += countCompletedSentences(slice.batchText);
        // Chỉ cắt đúng phần đã gửi đi: text đến trong lúc chờ phải được giữ lại.
        pendingRawText = pendingRawText.slice(snapshot.length - slice.rest.length);
        polishInFlight = false;
        polishFailure = null;
        lastPolishError = "";
        renderFullPanel();
        if (!forceAll) {
          void maybePolishBatch(false);
        }
      }
    } catch (error) {
      polishInFlight = false;
      if (generation === transcriptGeneration) {
        // Lỗi làm sạch không chặn phiên dịch: giữ nguyên văn bản thô đang chờ
        // và chờ hết cooldown trước khi tự thử lại.
        polishFailure = {
          at: Date.now(),
          pendingCompleted: countCompletedSentences(pendingRawText),
        };
        lastPolishError = error instanceof Error ? error.message : String(error);
      }
      renderFullPanel();
    }

    if (polishFlushQueued) {
      polishFlushQueued = false;
      // Flush đã xếp hàng là lượt hợp lệ, không tính vào chống trùng ở trên.
      lastForceFlushAt = 0;
      await maybePolishBatch(true);
    }
  }

  function downloadTranscriptFile() {
    // Nếu chưa có gì để hiển thị thì vẫn cứu được bản thô đã gom.
    const display = joinDisplay(polishedText, pendingRawText).trim() || fullRawText.trim();
    if (!display) {
      return;
    }
    const blob = new Blob([`${display}\n`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = buildSaveFilename(new Date());
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.documentElement.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Thu hồi trễ: revoke ngay lập tức có thể hủy download đang khởi tạo.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // Bản sao của extension/lib/polish-text.js — overlay là classic script nên không import được.
  const SENTENCE_END = /([.!?…。！？]+)(?:\s+|$)/g;

  function countCompletedSentences(text) {
    if (!text) return 0;
    const re = new RegExp(SENTENCE_END.source, "g");
    let count = 0;
    while (re.exec(String(text)) !== null) {
      count += 1;
    }
    return count;
  }

  function takeCompletedBatch(pendingText, batchSize = POLISH_BATCH_SIZE) {
    const pending = String(pendingText ?? "");
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

  function takeAllCompletedAndRest(pendingText) {
    const pending = String(pendingText ?? "");
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

  function isPolishCooldownActive(failure, options = {}) {
    if (!failure) {
      return false;
    }
    const {
      now = Date.now(),
      pendingCompleted = 0,
      cooldownMs = POLISH_FAILURE_COOLDOWN_MS,
      batchSize = POLISH_BATCH_SIZE,
    } = options;
    if (now - Number(failure.at ?? 0) >= cooldownMs) {
      return false;
    }
    if (pendingCompleted - Number(failure.pendingCompleted ?? 0) >= batchSize) {
      return false;
    }
    return true;
  }

  function isImplausiblePolish(cleaned, batchText, options = {}) {
    const {
      ratio = MIN_POLISH_LENGTH_RATIO,
      minLength = MIN_POLISH_LENGTH_CHECK,
    } = options;
    const source = String(batchText ?? "").trim();
    const result = String(cleaned ?? "").trim();
    if (!result) {
      return true;
    }
    if (source.length <= minLength) {
      return false;
    }
    return result.length < source.length * ratio;
  }

  function joinDisplay(polished, pending) {
    return `${polished ?? ""}${pending ?? ""}`;
  }

  function buildSaveFilename(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    return `ban-dich-${y}${m}${d}-${hh}${mm}.txt`;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function overlayCss() {
    return `
      :host { all: initial; }
      * { box-sizing: border-box; }
      .shell-row {
        /* Token nằm ở đây để cả .widget lẫn .full-panel (anh em) cùng kế thừa. */
        --panel-alpha: 1;
        --bg: 26 29 33;
        --bg-2: 21 24 28;
        --bg-3: 18 20 23;
        --border: 42 47 54;
        --text: #e8eaed;
        --muted: #a8b0ba;
        --faint: #7b8490;
        --accent: #3d9a8b;
        --accent-soft: #48a996;
        --ok: #5fad7a;
        --danger: #d46b6b;
        --radius: 8px;
        display: flex;
        align-items: flex-start;
        gap: 8px;
        max-width: 100%;
        height: 100%;
        min-height: 0;
        font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
        font-size: 13px;
        line-height: 1.45;
        color: var(--text);
      }
      .widget {
        flex: 0 1 auto;
        width: 100%;
        min-width: 0;
        position: relative;
        display: flex;
        flex-direction: column;
        height: auto;
        min-height: 0;
        color: var(--text);
        background: rgb(var(--bg) / var(--panel-alpha));
        border: 1px solid rgb(var(--border) / var(--panel-alpha));
        border-radius: var(--radius);
        box-shadow: 0 12px 36px rgb(0 0 0 / calc(0.32 * var(--panel-alpha)));
        overflow: hidden;
        user-select: none;
      }
      .widget.sized { height: 100%; }
      .widget.dragging {
        box-shadow: 0 16px 44px rgb(0 0 0 / calc(0.42 * var(--panel-alpha)));
      }
      .widget.resizing { user-select: none; }
      .drag-handle {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        flex: 0 0 auto;
        padding: 10px 10px 10px 12px;
        background: rgb(var(--bg-2) / var(--panel-alpha));
        border-bottom: 1px solid rgb(var(--border) / var(--panel-alpha));
        cursor: grab;
      }
      .widget.dragging .drag-handle { cursor: grabbing; }
      .title-wrap {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        flex: 1 1 auto;
      }
      .title-wrap strong {
        flex: 0 1 auto;
        font-size: 13px;
        font-weight: 600;
        color: var(--text);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .status-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        max-width: 46%;
        padding: 3px 8px;
        border: 1px solid rgb(var(--border) / var(--panel-alpha));
        border-radius: 999px;
        background: rgb(var(--bg-3) / calc(0.7 * var(--panel-alpha)));
        color: var(--muted);
        font-size: 11px;
        font-weight: 500;
      }
      .status-chip span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dot {
        display: inline-block;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--faint);
        flex: 0 0 auto;
      }
      .dot.live { background: var(--ok); box-shadow: 0 0 0 3px rgb(95 173 122 / 0.18); }
      .dot.error { background: var(--danger); }
      .widget.is-live .status-chip { color: #c8e6d1; border-color: rgb(95 173 122 / 0.35); }
      .widget.is-error .status-chip { color: #e8b4b4; border-color: rgb(212 107 107 / 0.4); }
      .header-actions { display: flex; gap: 4px; flex: 0 0 auto; }
      .icon-btn {
        width: 28px;
        height: 28px;
        border: 1px solid rgb(var(--border) / var(--panel-alpha));
        border-radius: 6px;
        background: transparent;
        color: var(--muted);
        cursor: pointer;
        font-size: 14px;
        line-height: 1;
      }
      .icon-btn:hover { background: rgb(var(--bg) / var(--panel-alpha)); color: var(--text); }
      .body {
        display: grid;
        gap: 10px;
        padding: 10px 12px 12px;
        min-height: 0;
      }
      .widget.sized .body {
        flex: 1 1 auto;
        grid-template-rows: auto minmax(0, 1fr) auto;
        overflow: hidden;
        padding-bottom: 18px;
      }
      .widget.collapsed .body { display: none; }
      .field { display: grid; gap: 6px; }
      .row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .transcript-head {
        gap: 10px;
        min-height: 28px;
      }
      .transcript-head .label {
        flex: 0 0 auto;
      }
      .transcript-head .inline-meter {
        flex: 1 1 auto;
        max-width: 140px;
        margin-left: auto;
      }
      .transcript-head select {
        flex: 0 1 auto;
        width: auto;
        min-width: 118px;
        max-width: calc(58% - 36px);
        margin-left: auto;
        height: 28px;
        padding: 0 24px 0 8px;
        font-size: 12px;
        appearance: none;
        background-image:
          linear-gradient(45deg, transparent 50%, var(--faint) 50%),
          linear-gradient(135deg, var(--faint) 50%, transparent 50%);
        background-position:
          calc(100% - 12px) calc(50% - 2px),
          calc(100% - 7px) calc(50% - 2px);
        background-size: 5px 5px;
        background-repeat: no-repeat;
      }
      .row.muted, .muted { color: var(--faint); font-size: 11px; }
      .value {
        color: var(--text);
        font-size: 12px;
        font-weight: 500;
        font-variant-numeric: tabular-nums;
      }
      label, .label {
        color: var(--muted);
        font-size: 12px;
        font-weight: 500;
      }
      select, button, input[type="range"], input[type="password"], summary { font: inherit; }
      select,
      input[type="password"] {
        width: 100%;
        height: 34px;
        padding: 0 10px;
        border: 1px solid rgb(var(--border) / var(--panel-alpha));
        border-radius: 6px;
        background: rgb(var(--bg-3) / var(--panel-alpha));
        color: var(--text);
      }
      select:focus-visible,
      input[type="password"]:focus-visible,
      button:focus-visible,
      summary:focus-visible,
      .text-btn:focus-visible {
        outline: 2px solid rgb(61 154 139 / 0.55);
        outline-offset: 1px;
      }
      .api-key-summary {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 28px;
        padding: 6px 8px;
        border: 1px solid rgb(95 173 122 / 0.28);
        border-radius: 6px;
        background: rgb(95 173 122 / 0.08);
      }
      .api-key-summary[hidden],
      .api-key-editor[hidden],
      .hint[hidden],
      button[hidden] {
        display: none !important;
      }
      .api-key-field:not(.is-editing) .api-key-editor {
        display: none !important;
      }
      .api-key-field.is-editing .api-key-summary,
      .api-key-field:not(.has-key) .api-key-summary {
        display: none !important;
      }
      .api-key-summary .label {
        flex: 1 1 auto;
        color: #c8e6d1;
        min-width: 0;
      }
      .api-key-ok {
        flex: 0 0 auto;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: rgb(95 173 122 / 0.2);
        position: relative;
      }
      .api-key-ok::after {
        content: "";
        position: absolute;
        left: 4px;
        top: 2.5px;
        width: 4px;
        height: 7px;
        border: solid var(--ok);
        border-width: 0 1.5px 1.5px 0;
        transform: rotate(45deg);
      }
      .api-key-editor { display: grid; gap: 6px; }
      .key-actions {
        display: flex;
        gap: 6px;
      }
      .key-actions button:first-child { flex: 1 1 auto; }
      .key-actions button.secondary {
        flex: 0 0 auto;
        min-width: 52px;
      }
      .text-btn {
        flex: 0 0 auto;
        height: auto;
        padding: 0;
        border: none;
        background: transparent;
        color: var(--accent-soft);
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }
      .text-btn:hover { color: var(--text); text-decoration: underline; }
      .hint {
        margin: 0;
        color: var(--faint);
        font-size: 11px;
      }
      .hint a {
        color: var(--accent-soft);
        text-decoration: none;
      }
      .hint a:hover { text-decoration: underline; }
      input[type="range"] {
        width: 100%;
        height: 18px;
        margin: 0;
        appearance: none;
        background: transparent;
      }
      input[type="range"]::-webkit-slider-runnable-track {
        height: 3px;
        border-radius: 2px;
        background: #3a414b;
      }
      input[type="range"]::-webkit-slider-thumb {
        appearance: none;
        width: 13px;
        height: 13px;
        margin-top: -5px;
        border: 1px solid #3a414b;
        border-radius: 50%;
        background: var(--text);
        cursor: pointer;
      }
      .actions {
        display: grid;
        grid-template-columns: 1fr 84px;
        gap: 8px;
      }
      button {
        height: 34px;
        border: 1px solid transparent;
        border-radius: 6px;
        background: var(--accent);
        color: #041512;
        cursor: pointer;
        font-weight: 600;
      }
      button:hover:not(:disabled) { filter: brightness(1.06); }
      button.secondary {
        border-color: rgb(var(--border) / var(--panel-alpha));
        background: transparent;
        color: var(--muted);
        filter: none;
      }
      button.secondary:hover:not(:disabled) {
        background: rgb(var(--bg-2) / var(--panel-alpha));
        color: var(--text);
      }
      button:disabled {
        border-color: rgb(var(--border) / var(--panel-alpha));
        background: rgb(var(--bg-2) / var(--panel-alpha));
        color: var(--faint);
        cursor: not-allowed;
        filter: none;
      }
      .level-track {
        height: 4px;
        overflow: hidden;
        border-radius: 2px;
        background: rgb(var(--border) / var(--panel-alpha));
      }
      .inline-meter {
        height: 5px;
        align-self: center;
      }
      .level-fill {
        width: 0%;
        height: 100%;
        background: var(--accent);
        transition: width 80ms linear;
      }
      .transcripts { display: grid; gap: 10px; min-height: 0; }
      .widget.sized .transcripts {
        grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
        height: 100%;
        overflow: hidden;
      }
      .transcript-block { display: grid; gap: 5px; min-height: 0; }
      .widget.sized .transcript-block {
        grid-template-rows: auto minmax(0, 1fr);
      }
      .transcript {
        min-height: 120px;
        max-height: 28vh;
        overflow: auto;
        padding: 10px;
        border: 1px solid rgb(var(--border) / max(0.75, var(--panel-alpha)));
        border-radius: 6px;
        background: rgb(var(--bg-3) / max(0.88, var(--panel-alpha)));
        color: var(--text);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        user-select: text;
        cursor: text;
      }
      .widget.sized .transcript {
        min-height: 0;
        max-height: none;
        height: 100%;
      }
      .transcript:empty::before {
        content: attr(data-empty);
        color: var(--faint);
      }
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
      .full-panel-header strong {
        font-size: 13px;
        font-weight: 600;
        white-space: nowrap;
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
      .compact-btn {
        width: auto;
        min-width: 64px;
        height: 28px;
        padding: 0 10px;
        font-size: 12px;
      }
      .settings {
        border-top: 1px solid rgb(var(--border) / var(--panel-alpha));
        padding-top: 2px;
      }
      .settings summary {
        cursor: pointer;
        list-style: none;
        color: var(--muted);
        font-size: 12px;
        font-weight: 500;
        padding: 6px 0;
        user-select: none;
      }
      .settings summary::-webkit-details-marker { display: none; }
      .settings summary::before {
        content: "▸ ";
        color: var(--faint);
      }
      .settings[open] summary::before { content: "▾ "; }
      .settings-body {
        display: grid;
        gap: 12px;
        padding: 2px 0 4px;
      }
      .resize-handle {
        position: absolute;
        right: 0;
        bottom: 0;
        width: 18px;
        height: 18px;
        cursor: nwse-resize;
        touch-action: none;
        z-index: 2;
      }
      .resize-handle::before {
        content: "";
        position: absolute;
        right: 4px;
        bottom: 4px;
        width: 9px;
        height: 9px;
        border-right: 2px solid var(--faint);
        border-bottom: 2px solid var(--faint);
        opacity: 0.85;
      }
      .resize-handle:hover::before,
      .widget.resizing .resize-handle::before {
        border-color: var(--muted);
      }
      .widget.collapsed .resize-handle { display: none; }
    `;
  }
})();
