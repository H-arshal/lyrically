window.__lyricallyAdapter = {
  platform: 'youtube',
  getTrack() {
    const titleEl = document.querySelector('h1.ytd-watch-metadata yt-formatted-string');
    const channelEl = document.querySelector('#channel-name yt-formatted-string a');
    
    let title = titleEl?.textContent?.trim() || '';
    let artist = channelEl?.textContent?.trim() || '';

    if (!title || !artist) {
      const docTitle = document.title.replace(/ - YouTube$/i, '').trim();
      const parsed = this._fuzzyParse(docTitle);
      title = title || parsed.title;
      artist = artist || parsed.artist;
    }

    return { title, artist };
  },
  _fuzzyParse(raw) {
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
    return { title: raw, artist: '' };
  },
  getPlaybackPosition() {
    const video = document.querySelector('video');
    return video?.currentTime || 0;
  },
  getDuration() {
    const video = document.querySelector('video');
    return (video?.duration && isFinite(video.duration)) ? video.duration : 0;
  },
  getPlaybackState() {
    const video = document.querySelector('video');
    return video ? (!video.paused && !video.ended) : false;
  }
};
