// Popup: shows now-playing state and provides overlay toggle
(function () {
  'use strict';

  const body = document.getElementById('popup-body');

  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
    if (chrome.runtime.lastError || !res) {
      body.innerHTML = `
        <div class="popup-idle-msg">
          Unable to connect to Lyrically.<br>Try reloading the extension.
        </div>`;
      return;
    }

    if (!res.status || res.status === 'idle') {
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

    document.getElementById('toggle-btn').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'TOGGLE_OVERLAY' });
    });
  });

  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
})();
