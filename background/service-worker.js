import {
  buildLookupQueries,
  makeResolution,
  normalizeText,
  normalizeTrackMetadata,
  rankLyricsCandidates
} from './song-resolver.js';

// Service worker: state hub, lyrics lookup, cross-tab broadcast

// ── Lyrics Engine / Song Resolution V2 ───────────────────────────────────────
/**
 * Lyrically V2 lyrics resolver.
 * The resolver separates song identity from lyrics quality.
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
      const fraction = match[3] ? parseInt(match[3].padEnd(3, '0'), 10) / 1000 : 0;
      parsed.push({
        time: minutes * 60 + seconds + fraction,
        text: textPart
      });
    }
  }

  parsed.sort((a, b) => a.time - b.time);
  return parsed;
}

function processLyricsData(data, resolution) {
  if (!data) return null;

  if (data.syncedLyrics) {
    const lines = parseLRC(data.syncedLyrics);
    return {
      type: 'synced',
      lines,
      plainText: data.plainLyrics || lines.map((line) => line.text).join('\n'),
      resolution
    };
  }

  if (data.plainLyrics) {
    return {
      type: 'plain',
      lines: null,
      plainText: data.plainLyrics,
      resolution
    };
  }

  return null;
}

async function fetchLyrics(artist, title, duration, platform = 'youtube') {
  const metadata = normalizeTrackMetadata({
    platform,
    title,
    artist,
    duration
  });

  // The cache follows normalized input rather than the raw YouTube title.
  // Duration is bucketed so tiny player-duration changes do not create new keys.
  const durationBucket = duration ? Math.round(Number(duration) / 5) * 5 : 0;
  const cacheKey = `lyrics:v2:${metadata.source}:${normalizeText(title)}:${normalizeText(artist)}:${durationBucket}`;

  try {
    const cached = await chrome.storage.local.get(cacheKey);
    if (cached[cacheKey] && cached[cacheKey].expires > Date.now()) {
      return cached[cacheKey].result;
    }
  } catch (e) {
    console.warn('[Lyrically] Cache read failed:', e);
  }

  const headers = {
    'User-Agent': 'Lyrically/0.2.0 (https://github.com/lyrically-extension)',
    'Lrclib-Client': 'Lyrically/0.2.0'
  };

  let result = {
    type: 'not_found',
    lines: null,
    plainText: null,
    resolution: {
      status: 'not_found',
      confidence: 'low',
      score: 0,
      title: metadata.primaryTitle,
      artist: metadata.artistHints.join(', '),
      variant: metadata.variant.type,
      reasons: []
    }
  };

  try {
    const queries = buildLookupQueries(metadata);
    const primaryQuery = queries[0] || metadata.primaryTitle || title;
    const fallbackQuery = queries[1];

    const requests = [];

    // Exact /api/get is only used when we have a trustworthy artist hint.
    // On normal YouTube, the channel is an uploader and must not be sent as artist.
    if (metadata.artistHints.length && metadata.primaryTitle) {
      let exactUrl = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(metadata.artistHints.join(', '))}&track_name=${encodeURIComponent(metadata.primaryTitle)}`;
      if (duration && duration > 0) {
        exactUrl += `&duration=${Math.round(duration)}`;
      }
      requests.push(fetch(exactUrl, { headers }));
    }

    if (primaryQuery) {
      requests.push(fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(primaryQuery)}`, { headers }));
    }

    const responses = await Promise.allSettled(requests);
    const candidates = [];

    for (const response of responses) {
      if (response.status !== 'fulfilled' || !response.value.ok) continue;
      const data = await response.value.json();
      if (Array.isArray(data)) {
        candidates.push(...data);
      } else if (data && typeof data === 'object') {
        candidates.push(data);
      }
    }

    let ranked = rankLyricsCandidates(candidates, metadata);
    let resolution = makeResolution(metadata, ranked);

    // One additional search only when the first pass is not confident enough.
    // This keeps V2 lightweight while preserving a useful fallback.
    if ((resolution.confidence === 'low' || !ranked.best) && fallbackQuery && fallbackQuery !== primaryQuery) {
      const fallbackResponse = await fetch(
        `https://lrclib.net/api/search?q=${encodeURIComponent(fallbackQuery)}`,
        { headers }
      );

      if (fallbackResponse.ok) {
        const fallbackData = await fallbackResponse.json();
        if (Array.isArray(fallbackData)) {
          candidates.push(...fallbackData);
          ranked = rankLyricsCandidates(candidates, metadata);
          resolution = makeResolution(metadata, ranked);
        }
      }
    }

    if (ranked.best && resolution.confidence !== 'low') {
      const processed = processLyricsData(ranked.best.entry, resolution);
      if (processed) result = processed;
    } else {
      // Conservative fallback: do not display lyrics from a weak identity match.
      result = {
        type: 'not_found',
        lines: null,
        plainText: null,
        resolution
      };
    }
  } catch (err) {
    console.error('[Lyrically] Lyrics fetch failed:', err);
    result = {
      type: 'not_found',
      lines: null,
      plainText: null,
      resolution: {
        ...result.resolution,
        status: 'error'
      }
    };
  }

  const ttl = result.type === 'not_found'
    ? 1 * 60 * 60 * 1000
    : 7 * 24 * 60 * 60 * 1000;

  try {
    await chrome.storage.local.set({
      [cacheKey]: {
        result,
        fetchedAt: Date.now(),
        source: 'lrclib',
        expires: Date.now() + ttl
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
  isPlaying: false,
  lyrics: null,       // { type, lines, plainText }
  status: 'idle'      // 'idle' | 'detecting' | 'loading' | 'ready' | 'not_found' | 'error'
};

// Track which tab is the music source
let musicTabId = null;

// Prevent duplicate lookups for the same track
let lastLookupKey = '';

// Rehydrate state on worker boot
chrome.storage.session.get(['currentState', 'musicTabId', 'lastLookupKey'], (data) => {
  if (data.currentState) currentState = data.currentState;
  if (data.musicTabId !== undefined) musicTabId = data.musicTabId;
  if (data.lastLookupKey !== undefined) lastLookupKey = data.lastLookupKey;
});

// Evict expired cache entries to prevent quota leaks
chrome.storage.local.get(null, (data) => {
  const now = Date.now();
  const keysToRemove = [];
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith('lyrics:') && value.expires && value.expires < now) {
      keysToRemove.push(key);
    }
  }
  if (keysToRemove.length > 0) {
    chrome.storage.local.remove(keysToRemove).catch(() => {});
  }
});

let persistTimeout = null;
function persistState(immediate = false) {
  if (immediate) {
    chrome.storage.session.set({ currentState, musicTabId, lastLookupKey }).catch(() => {});
    if (persistTimeout) {
      clearTimeout(persistTimeout);
      persistTimeout = null;
    }
    return;
  }
  if (!persistTimeout) {
    persistTimeout = setTimeout(() => {
      chrome.storage.session.set({ currentState, musicTabId, lastLookupKey }).catch(() => {});
      persistTimeout = null;
    }, 5000);
  }
}

// ── Broadcast helper ───────────────────────────────────────────────────────────
async function broadcastState(positionOnly = false) {
  persistState(!positionOnly);
  const message = positionOnly
    ? {
        type: 'POSITION_UPDATE',
        payload: { currentTime: currentState.currentTime }
      }
    : {
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
    const tabs = await chrome.tabs.query(positionOnly ? { active: true } : {});
    for (const tab of tabs) {
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

// Track pending fetches to debounce rate limits
let fetchTimeout = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── STOPPED_PLAYING: detector reports playback ended or navigated away ──
  if (msg.type === 'STOPPED_PLAYING') {
    if (sender.tab?.id === musicTabId) {
      musicTabId = null;
      lastLookupKey = '';
      currentState = {
        title: null,
        artist: null,
        currentTime: 0,
        isPlaying: false,
        lyrics: null,
        status: 'idle'
      };
      broadcastState();
    }
    return;
  }

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
    const { title, artist, platform = 'youtube', currentTime, duration, isPlaying } = msg.payload;

    // Ignore empty detections
    if (!title && !artist) return false;

    // Multi-tab lock: Allow stealing the lock if the current owner is paused
    if (musicTabId !== null && musicTabId !== sender.tab?.id) {
      if (currentState.isPlaying) {
        return false; // Current owner is playing, ignore this tab
      }
    }

    musicTabId = sender.tab?.id || musicTabId;
    currentState.isPlaying = isPlaying;

    // Always update playback position
    currentState.currentTime = currentTime || 0;

    // Check if the track changed
    const lookupKey = `${platform}::${normalizeText(artist || '')}::${normalizeText(title || '')}`;

    if (lookupKey !== lastLookupKey) {
      // New track — fetch lyrics
      lastLookupKey = lookupKey;
      currentState.title = title;
      currentState.artist = artist;
      currentState.status = 'loading';
      currentState.lyrics = null;

      // Broadcast the "loading" state immediately
      broadcastState();

      // Async lyrics fetch (debounced to respect rate limits)
      if (fetchTimeout) clearTimeout(fetchTimeout);
      fetchTimeout = setTimeout(() => {
        fetchLyrics(artist || '', title || '', duration || 0, platform).then(result => {
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
      }, 400);
    } else {
      // Same track — just broadcast updated position
      broadcastState(true);
    }

    return false;
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle_overlay') {
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
      console.warn('[Lyrically] Could not toggle overlay via shortcut:', e);
    }
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
      isPlaying: false,
      lyrics: null,
      status: 'idle'
    };
    broadcastState();
  }
});
