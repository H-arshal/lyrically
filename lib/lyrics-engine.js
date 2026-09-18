// Lyrics engine: lrclib.net lookup + LRC parsing + 7-day cache
// No ES module syntax — loaded via importScripts() in the service worker.

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
    // Match one or more timestamps: [mm:ss.xx] or [mm:ss]
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

  // Sort by timestamp
  parsed.sort((a, b) => a.time - b.time);
  return parsed;
}

/**
 * Fetch lyrics for a given artist + title.
 * Returns: { type: 'synced'|'plain'|'not_found', lines: [{time, text}]|null, plainText: string|null }
 *
 * - 'synced': lines is an array of {time, text}, plainText is also available
 * - 'plain': lines is null, plainText is the unsynced lyric text
 * - 'not_found': both null
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

  // Fetch from lrclib.net
  const url = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`;

  let result;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      // 404 = song not found on lrclib, not an error per se
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
