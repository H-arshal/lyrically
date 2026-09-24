window.__lyricallyAdapter = {
  platform: 'youtube-music',
  getTrack() {
    const titleEl = document.querySelector('.title.style-scope.ytmusic-player-bar');
    const artistEl = document.querySelector('.subtitle.style-scope.ytmusic-player-bar .yt-formatted-string');
    const artistFallback = document.querySelector('.subtitle.style-scope.ytmusic-player-bar');
    
    const title = titleEl?.textContent?.trim() || '';
    let artist = artistEl?.textContent?.trim() || artistFallback?.textContent?.trim() || '';
    
    if (artist.includes('•')) {
      artist = artist.split('•')[0].trim();
    }
    
    return { title, artist };
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
