(function() {
  'use strict';

  const activeAdapter = window.__lyricallyAdapter;
  if (!activeAdapter) {
    return;
  }

  console.log(`[Lyrically] Detector active: ${activeAdapter.platform}`);

  let lastSentKey = '';
  let wasPlaying = false;
  let lastUrl = location.href;
  let isEnabled = true;

  chrome.storage.local.get(['lyrically:enabled'], (data) => {
    if (data['lyrically:enabled'] === false) isEnabled = false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['lyrically:enabled']) {
      const wasEnabled = isEnabled;
      isEnabled = changes['lyrically:enabled'].newValue !== false;
      if (wasEnabled && !isEnabled && wasPlaying) {
        wasPlaying = false;
        lastSentKey = '';
        chrome.runtime.sendMessage({ type: 'STOPPED_PLAYING' }).catch(() => {});
      }
    }
  });

  const intervalId = setInterval(() => {
    if (!isEnabled) return;
    try {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        lastSentKey = '';
      }

      const track = activeAdapter.getTrack();
      const currentTime = activeAdapter.getPlaybackPosition();
      const isPlaying = activeAdapter.getPlaybackState();

      if (!track.title) {
        if (wasPlaying) {
          wasPlaying = false;
          lastSentKey = '';
          chrome.runtime.sendMessage({ type: 'STOPPED_PLAYING' }).catch(() => {});
        }
        return;
      }

      wasPlaying = true;
      const trackKey = `${track.artist}::${track.title}`;

      if (trackKey !== lastSentKey || isPlaying) {
        const duration = activeAdapter.getDuration ? activeAdapter.getDuration() : 0;
        chrome.runtime.sendMessage({
          type: 'NOW_PLAYING',
          payload: {
            title: track.title,
            artist: track.artist,
            platform: activeAdapter.platform,
            currentTime,
            duration,
            isPlaying
          }
        }).catch(() => {});
      }

      if (trackKey !== lastSentKey) {
        lastSentKey = trackKey;
        console.log(`[Lyrically] New track: ${track.artist} — ${track.title}`);
      }
    } catch (err) {
      const errMsg = err.message || err.toString() || '';
      if (errMsg.includes('Extension context invalidated')) {
        clearInterval(intervalId);
        console.log('[Lyrically] Extension reloaded. Stopping old detector loop.');
      } else {
        console.warn('[Lyrically] Detection error:', err);
      }
    }
  }, 500);
})();
