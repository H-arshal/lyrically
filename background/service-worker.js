// Service worker: state hub, lyrics lookup, cross-tab broadcast

// ── Lyrics Engine (inlined — importScripts path resolution is unreliable in MV3) ──

/**
 * Parse LRC-formatted lyrics into an array of { time, text } objects.
 * LRC lines look like: [mm:ss.xx] Some lyric text
 * Returns sorted array by timestamp.
 */
function parseLRC(lrcString) {
  if (!lrcString || typeof lrcString !== 'string') return [];

  const lines = lrcString.split('\n');
  const parsed = [];

  for (const line of lines) {
    const timestampRegex = /\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]/g;
    const textPart = line.replace(/\[\d{1,3}:\d{2}(?:\.\d{1,3})?\]/g, '').trim();

    let match;
    while ((match = timestampRegex.exec(line)) !== null) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      const centiseconds = match[3] ? parseInt(match[3].padEnd(3, '0'), 10) / 1000 : 0;
      const time = minutes * 60 + seconds + centiseconds;

      parsed.push({ time, text: textPart });
    }
  }

  parsed.sort((a, b) => a.time - b.time);
  return parsed;
}

/**
 * Fetch lyrics for a given artist + title.
 * Returns: { type: 'synced'|'plain'|'not_found', lines: [{time, text}]|null, plainText: string|null }
 */
async function fetchLyrics(artist, title) {
  const cacheKey = `lyrics:${artist.toLowerCase()}:${title.toLowerCase()}`;

  // Check cache first
  try {
    const cached = await chrome.storage.local.get(cacheKey);
    if (cached[cacheKey] && cached[cacheKey].expires > Date.now()) {
      return cached[cacheKey].result;
    }
  } catch (e) {
    console.warn('[Lyrically] Cache read failed:', e);
  }

  const url = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`;
  let result;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      if (response.status === 404) {
        result = { type: 'not_found', lines: null, plainText: null };
      } else {
        console.warn(`[Lyrically] lrclib.net returned ${response.status}`);
        result = { type: 'not_found', lines: null, plainText: null };
      }
    } else {
      const data = await response.json();

      if (data.syncedLyrics) {
        const lines = parseLRC(data.syncedLyrics);
        result = {
          type: 'synced',
          lines,
          plainText: data.plainLyrics || lines.map(l => l.text).join('\n')
        };
      } else if (data.plainLyrics) {
        result = {
          type: 'plain',
          lines: null,
          plainText: data.plainLyrics
        };
      } else {
        result = { type: 'not_found', lines: null, plainText: null };
      }
    }
  } catch (err) {
    console.error('[Lyrically] Lyrics fetch failed:', err);
    result = { type: 'not_found', lines: null, plainText: null };
  }

  // Cache for 7 days
  try {
    await chrome.storage.local.set({
      [cacheKey]: {
        result,
        fetchedAt: Date.now(),
        source: 'lrclib',
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000
      }
    });
  } catch (e) {
    console.warn('[Lyrically] Cache write failed:', e);
  }

  return result;
}

// ── State ──────────────────────────────────────────────────────────────────────
let currentState = {
  title: null,
  artist: null,
  currentTime: 0,
  lyrics: null,       // { type, lines, plainText }
  status: 'idle'      // 'idle' | 'detecting' | 'loading' | 'ready' | 'not_found' | 'error'
};

// Track which tab is the music source
let musicTabId = null;

// Prevent duplicate lookups for the same track
let lastLookupKey = '';

// ── Broadcast helper ───────────────────────────────────────────────────────────
async function broadcastState() {
  const message = {
    type: 'LYRICS_STATE',
    payload: {
      title: currentState.title,
      artist: currentState.artist,
      currentTime: currentState.currentTime,
      lyrics: currentState.lyrics,
      status: currentState.status
    }
  };

  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      // Don't send to the music tab itself, only to overlay tabs
      if (tab.id === musicTabId) continue;
      try {
        await chrome.tabs.sendMessage(tab.id, message);
      } catch (_) {
        // Tab may not have content script — ignore silently
      }
    }
  } catch (err) {
    console.warn('[Lyrically SW] Broadcast failed:', err);
  }
}

// ── Message handlers ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── GET_STATE: popup or overlay requesting current state ──
  if (msg.type === 'GET_STATE') {
    sendResponse({
      title: currentState.title,
      artist: currentState.artist,
      currentTime: currentState.currentTime,
      lyrics: currentState.lyrics,
      status: currentState.status
    });
    return true;
  }

  // ── NOW_PLAYING: detector content script reporting track info ──
  if (msg.type === 'NOW_PLAYING') {
    const { title, artist, currentTime } = msg.payload;

    // Ignore empty detections
    if (!title && !artist) return;

    musicTabId = sender.tab?.id || musicTabId;

    // Always update playback position
    currentState.currentTime = currentTime || 0;

    // Check if the track changed
    const lookupKey = `${(artist || '').toLowerCase()}::${(title || '').toLowerCase()}`;

    if (lookupKey !== lastLookupKey) {
      // New track — fetch lyrics
      lastLookupKey = lookupKey;
      currentState.title = title;
      currentState.artist = artist;
      currentState.status = 'loading';
      currentState.lyrics = null;

      // Broadcast the "loading" state immediately
      broadcastState();

      // Async lyrics fetch
      fetchLyrics(artist || '', title || '').then(result => {
        // Guard: only apply if still the same track
        if (lastLookupKey === lookupKey) {
          currentState.lyrics = result;
          currentState.status = result.type === 'not_found' ? 'not_found' : 'ready';
          broadcastState();
        }
      }).catch(err => {
        console.error('[Lyrically SW] Lyrics fetch error:', err);
        if (lastLookupKey === lookupKey) {
          currentState.status = 'error';
          broadcastState();
        }
      });
    } else {
      // Same track — just broadcast updated position
      broadcastState();
    }

    return;
  }

  // ── TOGGLE_OVERLAY: popup requesting overlay visibility toggle ──
  if (msg.type === 'TOGGLE_OVERLAY') {
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        if (tab.id === musicTabId) continue;
        try {
          chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_OVERLAY' });
        } catch (_) {}
      }
    });
    return;
  }
});

// ── Clean up when the music tab is closed ──────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === musicTabId) {
    musicTabId = null;
    lastLookupKey = '';
    currentState = {
      title: null,
      artist: null,
      currentTime: 0,
      lyrics: null,
      status: 'idle'
    };
    broadcastState();
  }
});
