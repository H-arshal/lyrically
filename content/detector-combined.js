// ── Adapter Interface ──────────────────────────────────────────────────────────
// Each adapter implements: platform, canDetect(), getTrack(), getPlaybackPosition()

// ── YouTube Music Adapter ──────────────────────────────────────────────────────
class YouTubeMusicAdapter {
  constructor() {
    this.platform = 'youtube-music';
  }

  canDetect() {
    return location.hostname === 'music.youtube.com';
  }

  getTrack() {
    const titleEl = document.querySelector('.title.style-scope.ytmusic-player-bar');
    const artistEl = document.querySelector('.subtitle.style-scope.ytmusic-player-bar .yt-formatted-string');

    // Fallback: try the subtitle container directly if the inner span isn't found
    const artistFallback = document.querySelector('.subtitle.style-scope.ytmusic-player-bar');

    const title = titleEl?.textContent?.trim() || '';
    let artist = artistEl?.textContent?.trim() || artistFallback?.textContent?.trim() || '';

    // YouTube Music subtitle often contains "Artist • Album • Year" — take first part
    if (artist.includes('•')) {
      artist = artist.split('•')[0].trim();
    }

    return { title, artist };
  }

  getPlaybackPosition() {
    const video = document.querySelector('video');
    return video?.currentTime || 0;
  }
}

// ── Plain YouTube Adapter ──────────────────────────────────────────────────────
class YouTubeAdapter {
  constructor() {
    this.platform = 'youtube';
  }

  canDetect() {
    return location.hostname === 'www.youtube.com' || location.hostname === 'youtube.com';
  }

  getTrack() {
    // Strategy 1: Try the structured info below the video player
    const titleEl = document.querySelector('h1.ytd-watch-metadata yt-formatted-string');
    const channelEl = document.querySelector('#channel-name yt-formatted-string a');

    let title = titleEl?.textContent?.trim() || '';
    let artist = channelEl?.textContent?.trim() || '';

    // Strategy 2: Fuzzy-parse document.title
    // YouTube titles are typically: "Artist - Song Title - YouTube"
    if (!title || !artist) {
      const docTitle = document.title.replace(/ - YouTube$/i, '').trim();
      const parsed = this._fuzzyParse(docTitle);
      title = title || parsed.title;
      artist = artist || parsed.artist;
    }

    // Clean up common suffixes
    title = this._cleanTitle(title);

    return { title, artist };
  }

  _fuzzyParse(raw) {
    // Common patterns: "Artist - Song Title", "Song Title | Artist"
    const separators = [' - ', ' – ', ' — ', ' | '];
    for (const sep of separators) {
      const idx = raw.indexOf(sep);
      if (idx !== -1) {
        return {
          artist: raw.substring(0, idx).trim(),
          title: raw.substring(idx + sep.length).trim()
        };
      }
    }
    // Can't split — use the whole thing as title
    return { title: raw, artist: '' };
  }

  _cleanTitle(title) {
    // Remove common video-title noise
    return title
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
      .trim();
  }

  getPlaybackPosition() {
    const video = document.querySelector('video');
    return video?.currentTime || 0;
  }
}

// ── Adapter Registry & Detection Loop ──────────────────────────────────────────
const adapters = [new YouTubeMusicAdapter(), new YouTubeAdapter()];

// Find the right adapter for this page
const activeAdapter = adapters.find(a => a.canDetect());

if (activeAdapter) {
  console.log(`[Lyrically] Detector active: ${activeAdapter.platform}`);

  let lastSentKey = '';

  setInterval(() => {
    try {
      const track = activeAdapter.getTrack();
      const currentTime = activeAdapter.getPlaybackPosition();

      // Skip if nothing is playing (no title detected)
      if (!track.title) return;

      const trackKey = `${track.artist}::${track.title}`;

      // Always send position updates for synced lyrics, but
      // only log track changes for dedup in the SW
      chrome.runtime.sendMessage({
        type: 'NOW_PLAYING',
        payload: {
          title: track.title,
          artist: track.artist,
          currentTime
        }
      }).catch(() => {
        // Extension context invalidated — page was likely reloaded
      });

      if (trackKey !== lastSentKey) {
        lastSentKey = trackKey;
        console.log(`[Lyrically] New track: ${track.artist} — ${track.title}`);
      }
    } catch (err) {
      // Selector may have failed — don't crash the loop
      console.warn('[Lyrically] Detection error:', err);
    }
  }, 500); // 500ms polling — good balance of responsiveness vs. overhead
} else {
  console.log('[Lyrically] No supported music platform detected on this page.');
}
  