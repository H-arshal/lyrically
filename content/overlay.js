// ── Lyrically Overlay ──────────────────────────────────────────────────────────
// Injected into every tab. Renders a floating lyrics panel using Shadow DOM
// for style isolation. Receives LYRICS_STATE broadcasts from the service worker.

(function () {
  'use strict';

  // Prevent double-injection
  if (document.getElementById('lyrically-root')) return;

  // ── Constants ──────────────────────────────────────────────────────────────
  const STORAGE_KEY_POSITION = 'lyrically:overlay:position';
  const STORAGE_KEY_VISIBLE = 'lyrically:overlay:visible';
  const DEFAULT_POS = { x: 20, y: 20 };
  const OVERLAY_WIDTH = 340;
  const OVERLAY_HEIGHT = 480;

  // ── State ──────────────────────────────────────────────────────────────────
  let state = {
    title: null,
    artist: null,
    currentTime: 0,
    lyrics: null,
    status: 'idle',
    visible: true,
    minimized: false
  };

  // ── Create host element + Shadow DOM ───────────────────────────────────────
  const host = document.createElement('div');
  host.id = 'lyrically-root';
  host.style.cssText = 'all:initial; position:fixed; z-index:2147483647; pointer-events:none;';
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'closed' });

  // ── Styles ─────────────────────────────────────────────────────────────────
  const styles = document.createElement('style');
  styles.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

    :host {
      all: initial;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    .lyrically-panel {
      position: fixed;
      width: ${OVERLAY_WIDTH}px;
      height: ${OVERLAY_HEIGHT}px;
      border-radius: 16px;
      background: rgba(15, 15, 20, 0.82);
      backdrop-filter: blur(24px) saturate(1.4);
      -webkit-backdrop-filter: blur(24px) saturate(1.4);
      border: 1px solid rgba(255, 255, 255, 0.08);
      box-shadow:
        0 8px 32px rgba(0, 0, 0, 0.5),
        0 0 0 1px rgba(255, 255, 255, 0.04) inset,
        0 1px 0 rgba(255, 255, 255, 0.06) inset;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      pointer-events: auto;
      transition: height 0.3s cubic-bezier(0.4, 0, 0.2, 1),
                  opacity 0.3s ease,
                  transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      transform: translateY(0);
      opacity: 1;
    }

    .lyrically-panel.hidden {
      opacity: 0;
      pointer-events: none;
      transform: translateY(12px);
    }

    .lyrically-panel.minimized {
      height: 54px;
    }

    /* ── Header ── */
    .lyrically-header {
      display: flex;
      align-items: center;
      padding: 12px 14px;
      cursor: grab;
      user-select: none;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      flex-shrink: 0;
      min-height: 54px;
    }

    .lyrically-header:active {
      cursor: grabbing;
    }

    .lyrically-icon {
      width: 22px;
      height: 22px;
      border-radius: 6px;
      background: linear-gradient(135deg, #6366f1, #a855f7, #ec4899);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      flex-shrink: 0;
      margin-right: 10px;
      color: #fff;
      font-weight: 700;
    }

    .lyrically-track-info {
      flex: 1;
      min-width: 0;
    }

    .lyrically-track-title {
      font-size: 13px;
      font-weight: 600;
      color: #f0f0f5;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.3;
    }

    .lyrically-track-artist {
      font-size: 11px;
      font-weight: 400;
      color: rgba(255, 255, 255, 0.45);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.3;
    }

    .lyrically-controls {
      display: flex;
      gap: 4px;
      flex-shrink: 0;
      margin-left: 8px;
    }

    .lyrically-btn {
      width: 28px;
      height: 28px;
      border-radius: 8px;
      border: none;
      background: rgba(255, 255, 255, 0.06);
      color: rgba(255, 255, 255, 0.5);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      transition: all 0.15s ease;
      line-height: 1;
    }

    .lyrically-btn:hover {
      background: rgba(255, 255, 255, 0.12);
      color: rgba(255, 255, 255, 0.85);
    }

    /* ── Lyrics body ── */
    .lyrically-body {
      flex: 1;
      overflow-y: auto;
      padding: 16px 18px;
      scroll-behavior: smooth;
    }

    .lyrically-body::-webkit-scrollbar {
      width: 4px;
    }

    .lyrically-body::-webkit-scrollbar-track {
      background: transparent;
    }

    .lyrically-body::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.12);
      border-radius: 4px;
    }

    /* ── Lyric lines (synced) ── */
    .lyrically-line {
      font-size: 14px;
      line-height: 1.85;
      color: rgba(255, 255, 255, 0.28);
      transition: color 0.3s ease, transform 0.3s ease, font-weight 0.3s ease;
      padding: 2px 0;
      transform: scale(1);
    }

    .lyrically-line.active {
      color: #f0f0f5;
      font-weight: 600;
      transform: scale(1.02);
      transform-origin: left center;
    }

    .lyrically-line.passed {
      color: rgba(255, 255, 255, 0.40);
    }

    /* ── Plain text ── */
    .lyrically-plain {
      font-size: 13.5px;
      line-height: 1.9;
      color: rgba(255, 255, 255, 0.72);
      white-space: pre-wrap;
      word-break: break-word;
    }

    /* ── Status messages ── */
    .lyrically-status {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      padding: 24px;
      gap: 12px;
    }

    .lyrically-status-icon {
      font-size: 32px;
      opacity: 0.5;
    }

    .lyrically-status-text {
      font-size: 13px;
      color: rgba(255, 255, 255, 0.40);
      line-height: 1.6;
    }

    .lyrically-status-text strong {
      color: rgba(255, 255, 255, 0.65);
      font-weight: 600;
    }

    /* ── Loading ── */
    .lyrically-loader {
      width: 24px;
      height: 24px;
      border: 2px solid rgba(255, 255, 255, 0.1);
      border-top-color: rgba(165, 85, 247, 0.7);
      border-radius: 50%;
      animation: lyrically-spin 0.8s linear infinite;
    }

    @keyframes lyrically-spin {
      to { transform: rotate(360deg); }
    }

    /* ── Footer badge ── */
    .lyrically-footer {
      padding: 8px 14px;
      border-top: 1px solid rgba(255, 255, 255, 0.04);
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }

    .lyrically-badge {
      font-size: 10px;
      font-weight: 500;
      color: rgba(255, 255, 255, 0.22);
      letter-spacing: 0.3px;
    }

    .lyrically-sync-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #22c55e;
      animation: lyrically-pulse 2s ease-in-out infinite;
    }

    .lyrically-sync-dot.plain {
      background: #eab308;
      animation: none;
    }

    .lyrically-sync-dot.off {
      background: rgba(255, 255, 255, 0.15);
      animation: none;
    }

    @keyframes lyrically-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
  `;

  // ── Build DOM ──────────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.className = 'lyrically-panel';

  panel.innerHTML = `
    <div class="lyrically-header" id="lyrically-drag-handle">
      <div class="lyrically-icon">♪</div>
      <div class="lyrically-track-info">
        <div class="lyrically-track-title" id="lyrically-title">Lyrically</div>
        <div class="lyrically-track-artist" id="lyrically-artist">Waiting for music…</div>
      </div>
      <div class="lyrically-controls">
        <button class="lyrically-btn" id="lyrically-minimize" title="Minimize">─</button>
        <button class="lyrically-btn" id="lyrically-close" title="Hide overlay">✕</button>
      </div>
    </div>
    <div class="lyrically-body" id="lyrically-body">
      <div class="lyrically-status">
        <div class="lyrically-status-icon">🎵</div>
        <div class="lyrically-status-text">
          Play a song on <strong>YouTube Music</strong> or <strong>YouTube</strong> to see lyrics here.
        </div>
      </div>
    </div>
    <div class="lyrically-footer">
      <span class="lyrically-badge">LYRICALLY</span>
      <div class="lyrically-sync-dot off" id="lyrically-sync-dot"></div>
    </div>
  `;

  shadow.appendChild(styles);
  shadow.appendChild(panel);

  // ── Element references ─────────────────────────────────────────────────────
  const titleEl = shadow.getElementById('lyrically-title');
  const artistEl = shadow.getElementById('lyrically-artist');
  const bodyEl = shadow.getElementById('lyrically-body');
  const syncDot = shadow.getElementById('lyrically-sync-dot');
  const minimizeBtn = shadow.getElementById('lyrically-minimize');
  const closeBtn = shadow.getElementById('lyrically-close');
  const dragHandle = shadow.getElementById('lyrically-drag-handle');

  // ── Restore position ───────────────────────────────────────────────────────
  chrome.storage.local.get([STORAGE_KEY_POSITION, STORAGE_KEY_VISIBLE], (data) => {
    const pos = data[STORAGE_KEY_POSITION] || DEFAULT_POS;
    panel.style.left = Math.min(pos.x, window.innerWidth - 60) + 'px';
    panel.style.top = Math.min(pos.y, window.innerHeight - 60) + 'px';

    if (data[STORAGE_KEY_VISIBLE] === false) {
      state.visible = false;
      panel.classList.add('hidden');
    }
  });

  // ── Dragging ───────────────────────────────────────────────────────────────
  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  dragHandle.addEventListener('mousedown', (e) => {
    // Don't drag when clicking buttons
    if (e.target.closest('.lyrically-btn')) return;

    isDragging = true;
    dragOffsetX = e.clientX - panel.getBoundingClientRect().left;
    dragOffsetY = e.clientY - panel.getBoundingClientRect().top;
    panel.style.transition = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;

    const x = Math.max(0, Math.min(e.clientX - dragOffsetX, window.innerWidth - 60));
    const y = Math.max(0, Math.min(e.clientY - dragOffsetY, window.innerHeight - 60));

    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;

    // Re-enable transitions
    panel.style.transition = '';

    // Persist position
    const rect = panel.getBoundingClientRect();
    chrome.storage.local.set({
      [STORAGE_KEY_POSITION]: { x: rect.left, y: rect.top }
    });
  });

  // ── Minimize / Close ───────────────────────────────────────────────────────
  minimizeBtn.addEventListener('click', () => {
    state.minimized = !state.minimized;
    panel.classList.toggle('minimized', state.minimized);
    minimizeBtn.textContent = state.minimized ? '□' : '─';
    minimizeBtn.title = state.minimized ? 'Expand' : 'Minimize';
  });

  closeBtn.addEventListener('click', () => {
    state.visible = false;
    panel.classList.add('hidden');
    chrome.storage.local.set({ [STORAGE_KEY_VISIBLE]: false });
  });

  // ── Render lyrics ──────────────────────────────────────────────────────────
  let renderedLines = [];   // DOM elements for synced lines
  let lastActiveIdx = -1;

  function renderLyrics() {
    const { status, lyrics, title, artist } = state;

    // Update header
    titleEl.textContent = title || 'Lyrically';
    artistEl.textContent = artist || 'Waiting for music…';

    // Update sync dot
    syncDot.className = 'lyrically-sync-dot';
    if (status === 'ready' && lyrics?.type === 'synced') {
      syncDot.className = 'lyrically-sync-dot'; // green pulse
    } else if (status === 'ready' && lyrics?.type === 'plain') {
      syncDot.className = 'lyrically-sync-dot plain';
    } else {
      syncDot.className = 'lyrically-sync-dot off';
    }

    // Clear body
    bodyEl.innerHTML = '';
    renderedLines = [];
    lastActiveIdx = -1;

    if (status === 'idle') {
      bodyEl.innerHTML = `
        <div class="lyrically-status">
          <div class="lyrically-status-icon">🎵</div>
          <div class="lyrically-status-text">
            Play a song on <strong>YouTube Music</strong> or <strong>YouTube</strong> to see lyrics here.
          </div>
        </div>`;
      return;
    }

    if (status === 'loading') {
      bodyEl.innerHTML = `
        <div class="lyrically-status">
          <div class="lyrically-loader"></div>
          <div class="lyrically-status-text">Finding lyrics…</div>
        </div>`;
      return;
    }

    if (status === 'not_found' || status === 'error') {
      bodyEl.innerHTML = `
        <div class="lyrically-status">
          <div class="lyrically-status-icon">🔍</div>
          <div class="lyrically-status-text">
            Lyrics not found for<br><strong>${escapeHTML(title || 'this track')}</strong>
          </div>
        </div>`;
      return;
    }

    // status === 'ready'
    if (lyrics?.type === 'synced' && lyrics.lines?.length) {
      // Render synced lines
      for (const line of lyrics.lines) {
        const div = document.createElement('div');
        div.className = 'lyrically-line';
        div.textContent = line.text || '♪';
        bodyEl.appendChild(div);
        renderedLines.push({ el: div, time: line.time });
      }
      // Kick an initial sync
      syncHighlight();
    } else if (lyrics?.plainText) {
      const div = document.createElement('div');
      div.className = 'lyrically-plain';
      div.textContent = lyrics.plainText;
      bodyEl.appendChild(div);
    }
  }

  function syncHighlight() {
    if (!renderedLines.length) return;

    const t = state.currentTime;
    let activeIdx = -1;

    // Find the last line whose timestamp <= currentTime
    for (let i = renderedLines.length - 1; i >= 0; i--) {
      if (renderedLines[i].time <= t) {
        activeIdx = i;
        break;
      }
    }

    if (activeIdx === lastActiveIdx) return;
    lastActiveIdx = activeIdx;

    for (let i = 0; i < renderedLines.length; i++) {
      const el = renderedLines[i].el;
      el.classList.remove('active', 'passed');

      if (i === activeIdx) {
        el.classList.add('active');
      } else if (i < activeIdx) {
        el.classList.add('passed');
      }
    }

    // Auto-scroll to active line
    if (activeIdx >= 0 && renderedLines[activeIdx]) {
      const el = renderedLines[activeIdx].el;
      const container = bodyEl;
      const elTop = el.offsetTop;
      const containerHeight = container.clientHeight;

      container.scrollTo({
        top: elTop - containerHeight / 3,
        behavior: 'smooth'
      });
    }
  }

  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Message listener ───────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'LYRICS_STATE') {
      const prev = state.status;
      const prevTrack = `${state.artist}::${state.title}`;
      const newTrack = `${msg.payload.artist}::${msg.payload.title}`;

      state.title = msg.payload.title;
      state.artist = msg.payload.artist;
      state.currentTime = msg.payload.currentTime;
      state.lyrics = msg.payload.lyrics;
      state.status = msg.payload.status;

      // Only re-render the full UI when the track or status changes
      if (prevTrack !== newTrack || prev !== state.status) {
        renderLyrics();
      } else if (state.lyrics?.type === 'synced') {
        // Same track — just update the highlight position
        syncHighlight();
      }

      // Show overlay when music starts playing
      if (!state.visible && state.status !== 'idle') {
        state.visible = true;
        panel.classList.remove('hidden');
        chrome.storage.local.set({ [STORAGE_KEY_VISIBLE]: true });
      }
    }

    if (msg.type === 'TOGGLE_OVERLAY') {
      state.visible = !state.visible;
      panel.classList.toggle('hidden', !state.visible);
      chrome.storage.local.set({ [STORAGE_KEY_VISIBLE]: state.visible });
    }
  });

  // ── Initial state fetch ────────────────────────────────────────────────────
  // On page load, ask the SW for current state in case music is already playing
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
    if (chrome.runtime.lastError) return; // Extension context invalidated

    if (res && res.status && res.status !== 'idle') {
      state.title = res.title;
      state.artist = res.artist;
      state.currentTime = res.currentTime;
      state.lyrics = res.lyrics;
      state.status = res.status;
      renderLyrics();

      if (!state.visible) {
        state.visible = true;
        panel.classList.remove('hidden');
      }
    }
  });

})();
