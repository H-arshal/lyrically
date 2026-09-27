// Popup: shows now-playing state and provides overlay toggle
(function () {
  'use strict';

  const body = document.getElementById('popup-body');

  let isExtensionEnabled = true;
  const masterSwitch = document.getElementById('master-switch');
  const masterSwitchLabel = document.getElementById('master-switch-label');

  function updateUI(res) {
    if (!isExtensionEnabled) {
      body.innerHTML = `
        <div class="popup-idle-msg">
          <strong>Lyrically is turned off.</strong><br>
          Use the switch above to turn it back on.
        </div>`;
      return;
    }

    if (!res || !res.status || res.status === 'idle') {
      body.innerHTML = `
        <div class="popup-idle-msg">
          Play a song on <strong>YouTube Music</strong> or <strong>YouTube</strong> to get started.
        </div>`;
      return;
    }

    // Track info
    let statusDotClass = 'gray';
    let statusText = 'Unknown';

    switch (res.status) {
      case 'loading':
        statusDotClass = 'yellow';
        statusText = 'Finding lyrics…';
        break;
      case 'ready':
        if (res.lyrics?.type === 'synced') {
          statusDotClass = 'green';
          statusText = 'Synced lyrics active';
        } else if (res.lyrics?.type === 'plain') {
          statusDotClass = 'yellow';
          statusText = 'Plain lyrics (no sync)';
        } else {
          statusDotClass = 'green';
          statusText = 'Lyrics loaded';
        }
        break;
      case 'not_found':
        statusDotClass = 'red';
        statusText = 'Lyrics not found';
        break;
      case 'error':
        statusDotClass = 'red';
        statusText = 'Lookup error';
        break;
    }

    body.innerHTML = `
      <div class="popup-track">
        <div class="popup-label">Now Playing</div>
        <div class="popup-title">${escapeHTML(res.title || 'Unknown Track')}</div>
        <div class="popup-artist">${escapeHTML(res.artist || 'Unknown Artist')}</div>
      </div>
      <div class="popup-status">
        <div class="popup-dot ${statusDotClass}"></div>
        <span class="popup-status-text">${statusText}</span>
      </div>
      <button class="popup-btn" id="toggle-btn">Toggle Overlay</button>
    `;

    document.getElementById('toggle-btn').addEventListener('click', async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || tab.url.startsWith('chrome://')) return;

        let overlayState = null;
        try {
          overlayState = await chrome.tabs.sendMessage(tab.id, { type: 'PING_OVERLAY' });
        } catch(e) {}

        if (!overlayState || !overlayState.injected) {
          // Not injected on this tab yet. Inject it and ensure visibility is ON.
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content/overlay.js']
          });
          chrome.storage.local.set({ 'lyrically:overlay:visible': true });
        } else {
          // Already injected. Toggle it off if visible, on if hidden.
          chrome.storage.local.set({ 'lyrically:overlay:visible': !overlayState.visible });
        }
      } catch (e) {
        console.warn('[Lyrically] Could not toggle overlay:', e);
      }
    });
  }

  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
    if (chrome.runtime.lastError || !res) {
      body.innerHTML = `
        <div class="popup-idle-msg">
          Unable to connect to Lyrically.<br>Try reloading the extension.
        </div>`;
      return;
    }
    updateUI(res);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'LYRICS_STATE') {
      updateUI(msg.payload);
    }
  });

  // ── Master Switch ──────────────────────────────────────────────────────────
  masterSwitch.addEventListener('click', () => {
    const newState = !isExtensionEnabled;
    chrome.storage.local.set({ 'lyrically:enabled': newState });
  });

  chrome.storage.local.get(['lyrically:enabled'], (data) => {
    if (data['lyrically:enabled'] === false) {
      isExtensionEnabled = false;
      masterSwitch.classList.remove('active');
      masterSwitchLabel.textContent = 'OFF';
      updateUI(null);
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['lyrically:enabled']) {
      isExtensionEnabled = changes['lyrically:enabled'].newValue !== false;
      masterSwitch.classList.toggle('active', isExtensionEnabled);
      masterSwitchLabel.textContent = isExtensionEnabled ? 'ON' : 'OFF';
      if (isExtensionEnabled) {
        chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
          if (!chrome.runtime.lastError) updateUI(res);
        });
      } else {
        updateUI(null);
      }
    }
  });

  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Customization ──────────────────────────────────────────────────────────
  const STORAGE_KEY_CUSTOMIZATION = 'lyrically:customization';
  
  const elSize = document.getElementById('setting-size');
  const labelSize = document.getElementById('label-size');
  const elWeight = document.getElementById('setting-weight');
  const elAlign = document.getElementById('setting-alignment');
  const elBgColor = document.getElementById('setting-bgcolor');
  const elBgOpacity = document.getElementById('setting-bgopacity');
  const labelBgOpacity = document.getElementById('label-bgopacity');

  function hexToRgbString(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const r = parseInt(hex.substring(0, 2), 16) || 0;
    const g = parseInt(hex.substring(2, 4), 16) || 0;
    const b = parseInt(hex.substring(4, 6), 16) || 0;
    return `${r}, ${g}, ${b}`;
  }

  function rgbStringToHex(rgbStr) {
    if (!rgbStr) return '#000000';
    const parts = rgbStr.split(',');
    if (parts.length !== 3) return '#000000';
    const [r, g, b] = parts.map(s => parseInt(s.trim(), 10) || 0);
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  function saveCustomization() {
    labelSize.textContent = elSize.value;
    labelBgOpacity.textContent = elBgOpacity.value;
    const prefs = {
      fontSize: parseInt(elSize.value, 10),
      fontWeight: parseInt(elWeight.value, 10) || 600,
      alignment: elAlign.value,
      bgColor: hexToRgbString(elBgColor.value),
      bgOpacity: parseInt(elBgOpacity.value, 10) / 100
    };
    chrome.storage.local.set({ [STORAGE_KEY_CUSTOMIZATION]: prefs });
  }

  chrome.storage.local.get([STORAGE_KEY_CUSTOMIZATION], (data) => {
    const prefs = data[STORAGE_KEY_CUSTOMIZATION];
    if (prefs) {
      if (prefs.fontSize) { elSize.value = prefs.fontSize; labelSize.textContent = prefs.fontSize; }
      if (prefs.fontWeight) elWeight.value = prefs.fontWeight;
      if (prefs.alignment) elAlign.value = prefs.alignment;
      if (prefs.bgColor) elBgColor.value = rgbStringToHex(prefs.bgColor);
      if (prefs.bgOpacity !== undefined) {
        const op = Math.round(prefs.bgOpacity * 100);
        elBgOpacity.value = op;
        labelBgOpacity.textContent = op;
      }
    }
  });

  elSize.addEventListener('input', saveCustomization);
  elWeight.addEventListener('change', saveCustomization);
  elAlign.addEventListener('change', saveCustomization);
  elBgColor.addEventListener('input', saveCustomization);
  elBgOpacity.addEventListener('input', saveCustomization);

})();
