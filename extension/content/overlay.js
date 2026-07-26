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
  };

  if (window.__liveEventTranslatorOverlayLoaded) {
    showHost();
    return;
  }
  window.__liveEventTranslatorOverlayLoaded = true;

  let running = false;
  let dragState = null;
  let resizeState = null;

  const MIN_WIDTH = 280;
  const MIN_HEIGHT = 240;
  const DEFAULT_WIDTH = 380;

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
    <div class="widget" part="widget">
      <header class="drag-handle" title="Kéo để di chuyển">
        <div class="title-wrap">
          <strong>Dịch sự kiện trực tiếp</strong>
          <span class="status">
            <i class="dot" id="statusDot"></i>
            <span id="statusText">Đã dừng</span>
          </span>
        </div>
        <div class="header-actions">
          <button type="button" class="icon-btn" id="minimizeButton" title="Thu gọn">–</button>
          <button type="button" class="icon-btn" id="closeButton" title="Ẩn">✕</button>
        </div>
      </header>

      <div class="body" id="widgetBody">
        <div class="actions">
          <button type="button" id="startButton">Bắt đầu dịch</button>
          <button type="button" class="secondary" id="stopButton" disabled>Dừng</button>
        </div>

        <div class="transcripts">
          <div class="transcript-block">
            <div class="row"><span class="label">Tiếng gốc</span></div>
            <div class="transcript" id="originalTranscript" data-empty="Các câu gốc gần nhất sẽ hiện tại đây."></div>
          </div>
          <div class="transcript-block">
            <div class="row"><span class="label">Bản dịch</span></div>
            <div class="transcript" id="translatedTranscript" data-empty="Các câu dịch gần nhất sẽ hiện tại đây."></div>
          </div>
        </div>

        <details class="settings">
          <summary>Cài đặt</summary>
          <div class="settings-body">
            <div class="field">
              <label for="targetLanguage">Ngôn ngữ đích</label>
              <select id="targetLanguage">
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
            </div>

            <div class="field">
              <div class="row">
                <label for="audioMix">Trộn âm thanh</label>
                <span id="mixValue">85% bản dịch</span>
              </div>
              <input id="audioMix" type="range" min="0" max="100" step="1" value="85" />
              <div class="row muted">
                <span id="originalMixLabel">Gốc 15%</span>
                <span id="translatedMixLabel">Dịch 85%</span>
              </div>
            </div>

            <div class="field">
              <div class="row">
                <label for="opacityRange">Độ trong suốt</label>
                <span id="opacityValue">0%</span>
              </div>
              <input id="opacityRange" type="range" min="0" max="70" step="1" value="0" />
            </div>

            <div class="field">
              <div class="row">
                <span class="label">Mức âm tab</span>
              </div>
              <div class="level-track" id="inputMeter" role="meter" aria-valuemin="0" aria-valuemax="1" aria-valuenow="0">
                <div class="level-fill" id="inputMeterFill"></div>
              </div>
            </div>
          </div>
        </details>
      </div>
      <div class="resize-handle" id="resizeHandle" title="Kéo để đổi kích thước"></div>
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

  applyMixLabels(audioMix.value);
  void restoreUiPrefs();
  void restoreState();

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

  startButton.addEventListener("click", async () => {
    clearTranscripts();
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
        setControls(false);
        setInputLevel(0);
        setStatus(message.message ?? "Đã dừng", message.state ?? "idle");
        break;
      default:
        break;
    }
    return false;
  });

  function showHost() {
    host.style.display = "block";
  }

  async function restoreUiPrefs() {
    try {
      const prefs = await chrome.storage.local.get({
        overlayOpacity: 0,
        overlayLeft: null,
        overlayTop: null,
        overlayWidth: DEFAULT_WIDTH,
        overlayHeight: null,
      });
      applyOpacity(Number(prefs.overlayOpacity) || 0);
      opacityRange.value = String(Number(prefs.overlayOpacity) || 0);
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
    try {
      await chrome.storage.local.set({
        overlayOpacity: Number(opacityRange.value) || 0,
        overlayLeft: Math.round(rect.left),
        overlayTop: Math.round(rect.top),
        overlayWidth: Math.round(rect.width),
        overlayHeight: Math.round(rect.height),
      });
    } catch {
      // ignore
    }
  }

  function applySize(width, height) {
    host.style.width = `${Math.round(width)}px`;
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
    const translated = clamp(Number.parseInt(String(value), 10) || 85, 0, 100);
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
    widget.style.setProperty("--panel-alpha", String(1 - value / 100));
    widget.style.opacity = "";
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

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function overlayCss() {
    return `
      :host { all: initial; }
      * { box-sizing: border-box; }
      .widget {
        --panel-alpha: 1;
        position: relative;
        display: flex;
        flex-direction: column;
        height: auto;
        min-height: 0;
        font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
        font-size: 13px;
        line-height: 1.45;
        color: #e8eaed;
        background: rgb(26 29 33 / var(--panel-alpha));
        border: 1px solid rgb(42 47 54 / var(--panel-alpha));
        border-radius: 8px;
        box-shadow: 0 12px 40px rgb(0 0 0 / calc(0.35 * var(--panel-alpha)));
        overflow: hidden;
        user-select: none;
      }
      .widget.sized {
        height: 100%;
      }
      .widget.dragging {
        box-shadow: 0 16px 48px rgb(0 0 0 / calc(0.45 * var(--panel-alpha)));
      }
      .widget.resizing {
        user-select: none;
      }
      .drag-handle {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
        flex: 0 0 auto;
        padding: 10px 10px 10px 12px;
        background: rgb(21 24 28 / var(--panel-alpha));
        border-bottom: 1px solid rgb(42 47 54 / var(--panel-alpha));
        cursor: grab;
      }
      .widget.dragging .drag-handle { cursor: grabbing; }
      .title-wrap {
        display: grid;
        gap: 6px;
        min-width: 0;
      }
      .title-wrap strong {
        font-size: 13px;
        font-weight: 600;
        color: #e8eaed;
      }
      .status {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        color: #a8b0ba;
        font-size: 12px;
      }
      .status span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dot {
        display: inline-block;
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #7b8490;
        flex: 0 0 auto;
      }
      .dot.live { background: #5fad7a; }
      .dot.error { background: #d46b6b; }
      .header-actions { display: flex; gap: 4px; }
      .icon-btn {
        width: 28px;
        height: 28px;
        border: 1px solid rgb(42 47 54 / var(--panel-alpha));
        border-radius: 6px;
        background: transparent;
        color: #a8b0ba;
        cursor: pointer;
        font-size: 14px;
        line-height: 1;
      }
      .icon-btn:hover { background: rgb(26 29 33 / var(--panel-alpha)); color: #e8eaed; }
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
      .row.muted, .muted { color: #7b8490; font-size: 11px; }
      label, .label {
        color: #a8b0ba;
        font-size: 12px;
        font-weight: 500;
      }
      select, button, input[type="range"], summary { font: inherit; }
      select {
        width: 100%;
        height: 34px;
        padding: 0 10px;
        border: 1px solid rgb(42 47 54 / var(--panel-alpha));
        border-radius: 6px;
        background: rgb(18 20 23 / var(--panel-alpha));
        color: #e8eaed;
      }
      input[type="range"] {
        width: 100%;
        height: 20px;
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
        background: #e8eaed;
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
        background: #3d9a8b;
        color: #041512;
        cursor: pointer;
        font-weight: 600;
      }
      button.secondary {
        border-color: rgb(42 47 54 / var(--panel-alpha));
        background: transparent;
        color: #a8b0ba;
      }
      button:disabled {
        border-color: rgb(42 47 54 / var(--panel-alpha));
        background: rgb(21 24 28 / var(--panel-alpha));
        color: #7b8490;
        cursor: not-allowed;
      }
      .level-track {
        height: 4px;
        overflow: hidden;
        border-radius: 2px;
        background: rgb(42 47 54 / var(--panel-alpha));
      }
      .level-fill {
        width: 0%;
        height: 100%;
        background: #3d9a8b;
      }
      .transcripts { display: grid; gap: 10px; min-height: 0; }
      .widget.sized .transcripts {
        grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
        height: 100%;
        overflow: hidden;
      }
      .transcript-block { display: grid; gap: 6px; min-height: 0; }
      .widget.sized .transcript-block {
        grid-template-rows: auto minmax(0, 1fr);
      }
      .transcript {
        min-height: 120px;
        max-height: 28vh;
        overflow: auto;
        padding: 10px;
        border: 1px solid rgb(42 47 54 / max(0.75, var(--panel-alpha)));
        border-radius: 6px;
        /* Nền khung phụ đề giữ độ đậm tối thiểu để chữ luôn dễ đọc */
        background: rgb(18 20 23 / max(0.88, var(--panel-alpha)));
        color: #e8eaed;
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
        color: #7b8490;
      }
      .settings {
        border-top: 1px solid rgb(42 47 54 / var(--panel-alpha));
        padding-top: 4px;
      }
      .settings summary {
        cursor: pointer;
        list-style: none;
        color: #a8b0ba;
        font-size: 12px;
        font-weight: 500;
        padding: 4px 0;
        user-select: none;
      }
      .settings summary::-webkit-details-marker { display: none; }
      .settings summary::before {
        content: "▸ ";
        color: #7b8490;
      }
      .settings[open] summary::before { content: "▾ "; }
      .settings-body {
        display: grid;
        gap: 10px;
        padding: 6px 0 2px;
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
        border-right: 2px solid #7b8490;
        border-bottom: 2px solid #7b8490;
        opacity: 0.85;
      }
      .resize-handle:hover::before,
      .widget.resizing .resize-handle::before {
        border-color: #a8b0ba;
      }
      .widget.collapsed .resize-handle {
        display: none;
      }
      .widget.is-error .status { color: #e8b4b4; }
    `;
  }
})();
