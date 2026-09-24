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
/**
 * Score search results to pick the best match.
 * Strongly prefers synced lyrics, then penalizes based on duration difference.
 */
function scoreLyricsResults(results, duration) {
  let bestMatch = null;
  let bestScore = -1;

  for (const entry of results.slice(0, 10)) {
    let score = 0;
    if (entry.syncedLyrics) score += 100;
    if (entry.plainLyrics) score += 10;
    if (duration && entry.duration) {
      const diff = Math.abs(entry.duration - duration);
      if (diff < 3) score += 50;
      else if (diff < 10) score += 20;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = entry;
    }
  }

  return bestMatch;
}

async function fetchLyrics(artist, title, duration) {
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

  // Clean title for better API matching (remove YouTube noise)
  const cleanTitle = title
    .replace(/\s*\(Official\s*(Music\s*)?Video\)/gi, '')
    .replace(/\s*\[Official\s*(Music\s*)?Video\]/gi, '')
    .replace(/\s*\(Official\s*Audio\)/gi, '')
    .replace(/\s*\[Official\s*Audio\]/gi, '')
    .replace(/\s*\(Lyric\s*Video\)/gi, '')
    .replace(/\s*\[Lyric\s*Video\]/gi, '')
    .replace(/\s*\(Lyrics?\)/gi, '')
    .replace(/\s*\[Lyrics?\]/gi, '')
    .replace(/\s*\|\s*Lyrics?$/gi, '')
    .replace(/\s*\(HD\)/gi, '')
    .replace(/\s*\[HD\]/gi, '')
    .replace(/\s*\(HQ\)/gi, '')
    .replace(/\s*\[HQ\]/gi, '')
    .replace(/\s*\(4K\)/gi, '')
    .replace(/\s*\[4K\]/gi, '')
    .replace(/\s*\(Audio\)/gi, '')
    .replace(/\s*\[Audio\]/gi, '')
    .replace(/\s*\(ft\.?\s*.+\)/gi, '')  // Remove feat. in parens
    .replace(/\s*\[ft\.?\s*.+\]/gi, '')
    .replace(/\s*\(feat\.?\s*.+\)/gi, '')
    .replace(/\s*\[feat\.?\s*.+\]/gi, '')
    .trim();

  const headers = {
    'User-Agent': 'Lyrically/0.1.0 (https://github.com/lyrically-extension)',
    'Lrclib-Client': 'Lyrically/0.1.0'
  };

  let result = { type: 'not_found', lines: null, plainText: null };

  const processData = (data) => {
    if (data.syncedLyrics) {
      const lines = parseLRC(data.syncedLyrics);
      return {
        type: 'synced',
        lines,
        plainText: data.plainLyrics || lines.map(l => l.text).join('\n')
      };
    } else if (data.plainLyrics) {
      return {
        type: 'plain',
        lines: null,
        plainText: data.plainLyrics
      };
    }
    return null;
  };

  try {
    // Build exact-match URL with optional duration for better matching
    let exactUrl = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(cleanTitle)}`;
    if (duration && duration > 0) {
      exactUrl += `&duration=${Math.round(duration)}`;
    }

    // Fire exact match and fuzzy search in parallel for speed
    const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(artist + ' ' + cleanTitle)}`;

    const [exactRes, searchRes] = await Promise.allSettled([
      fetch(exactUrl, { headers }),
      fetch(searchUrl, { headers })
    ]);

    // Try exact match first
    if (exactRes.status === 'fulfilled' && exactRes.value.ok) {
      const data = await exactRes.value.json();
      const processed = processData(data);
      if (processed) result = processed;
    }

    // Check fuzzy search results — always check if we don't have synced yet
    if (result.type !== 'synced' && searchRes.status === 'fulfilled' && searchRes.value.ok) {
      const searchData = await searchRes.value.json();
      if (searchData && searchData.length > 0) {
        // Score results: prefer synced lyrics and closest duration match
        const bestMatch = scoreLyricsResults(searchData, duration);

        if (bestMatch) {
          const processed = processData(bestMatch);
          // Only upgrade: synced always wins, or use if we had nothing
          if (processed && (processed.type === 'synced' || result.type === 'not_found')) {
            result = processed;
          }
        }
      }
    }

    // If still no synced lyrics and title differs from cleaned, try original title
    if (result.type !== 'synced' && cleanTitle !== title) {
      const fallbackUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(artist + ' ' + title)}`;
      const fallbackRes = await fetch(fallbackUrl, { headers });
      if (fallbackRes.ok) {
        const fallbackData = await fallbackRes.json();
        if (fallbackData && fallbackData.length > 0) {
          // Pick the best synced result from the fallback too
          const bestMatch = scoreLyricsResults(fallbackData, duration);

          if (bestMatch) {
            const processed = processData(bestMatch);
            if (processed && (processed.type === 'synced' || result.type === 'not_found')) {
              result = processed;
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[Lyrically] Lyrics fetch failed:', err);
  }

  // Cache results — shorter TTL for not_found so we retry sooner
  const ttl = result.type === 'not_found'
    ? 1 * 60 * 60 * 1000    // 1 hour for not_found (retry sooner)
    : 7 * 24 * 60 * 60 * 1000; // 7 days for successful results

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
    const { title, artist, currentTime, duration, isPlaying } = msg.payload;

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

      // Async lyrics fetch (debounced to respect rate limits)
      if (fetchTimeout) clearTimeout(fetchTimeout);
      fetchTimeout = setTimeout(() => {
        fetchLyrics(artist || '', title || '', duration || 0).then(result => {
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
    const data = await chrome.storage.local.get(['lyrically:overlay:visible']);
    const isVisible = data['lyrically:overlay:visible'] !== false;
    
    if (!isVisible) {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && !tab.url.startsWith('chrome://')) {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content/overlay.js']
          });
        }
      } catch (e) {
        console.warn('[Lyrically] Could not inject overlay via shortcut:', e);
      }
    }
    chrome.storage.local.set({ 'lyrically:overlay:visible': !isVisible });
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
