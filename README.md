# Lyrically — *Lyrics, wherever you listen.*

![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4?logo=googlechrome&logoColor=white)
![Version](https://img.shields.io/badge/version-0.1.0-brightgreen)
![Platforms](https://img.shields.io/badge/works%20on-YouTube%20Music%20%7C%20YouTube-red)
![License](https://img.shields.io/badge/license-MIT-blue)

A Chrome / Edge browser extension that floats a real-time, line-synced lyrics panel on **any browser tab** while you listen on YouTube Music or YouTube.

---

## ✨ Features

| Feature | Details |
|---|---|
| **Synced lyrics** | Line-by-line highlighting that follows playback in real time |
| **Plain-text fallback** | Displays unsynced lyrics when timestamps aren't available |
| **Cross-tab overlay** | Lyrics panel appears on *any* open tab — read docs while you listen |
| **Draggable panel** | Drag to reposition; last position saved across page loads |
| **Glassmorphism UI** | Dark frosted-glass panel, Shadow DOM isolated from host page styles |
| **Minimize / hide** | Collapse the panel to a slim header bar or toggle it off entirely |
| **Popup controls** | Extension popup shows current track and a one-click overlay toggle |
| **7-day lyrics cache** | Fetched lyrics stored in `chrome.storage.local`; no repeat network calls |
| **Zero host-page impact** | Closed Shadow DOM prevents style bleed in either direction |

---

## 🏗️ Architecture

### Component Map

```
┌─────────────────────────────────────────────────────────────────┐
│  YouTube Music / YouTube tab                                    │
│  ┌────────────────────────────┐                                 │
│  │  content/detector-combined │  polls DOM every 500 ms        │
│  │  .js                       │  sends NOW_PLAYING             │
│  └─────────────┬──────────────┘                                 │
└────────────────│────────────────────────────────────────────────┘
                 │ NOW_PLAYING {title, artist, currentTime}
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  background/service-worker.js  (state hub)                      │
│  • deduplicates track changes                                   │
│  • fetches lyrics from lrclib.net (7-day cache)                 │
│  • broadcasts LYRICS_STATE to all non-music tabs                │
└──────┬────────────────────────────────────────────┬─────────────┘
       │ LYRICS_STATE                               │ response
       ▼                                            ▼
┌──────────────────────┐                  ┌─────────────────────┐
│  content/overlay.js  │                  │  popup/popup.js     │
│  (every other tab)   │                  │  GET_STATE request  │
│  Shadow DOM panel    │◄─TOGGLE_OVERLAY──│  TOGGLE_OVERLAY     │
└──────────────────────┘                  └─────────────────────┘
```

### Message Protocol

| Message | Direction | Payload |
|---|---|---|
| `NOW_PLAYING` | detector → service-worker | `{ title, artist, currentTime }` |
| `LYRICS_STATE` | service-worker → overlay | `{ title, artist, currentTime, lyrics, status }` |
| `GET_STATE` | popup → service-worker | *(none)* → returns `currentState` |
| `TOGGLE_OVERLAY` | popup → service-worker → overlay | *(none)* |

### Status Values

`idle` → `detecting` → `loading` → `ready` (synced / plain) / `not_found` / `error`

### Lyrics Engine (`lib/lyrics-engine.js`)

- Fetches from **[lrclib.net](https://lrclib.net)** (`/api/get?artist_name=…&track_name=…`)
- Returns `{ type: 'synced' | 'plain' | 'not_found', lines, plainText }`
- Cache key: `lyrics:<artist>:<title>` in `chrome.storage.local`, TTL 7 days
- Source-of-truth module; **inlined** in the service worker due to MV3 `importScripts` unreliability

---

## 📁 File Structure

```
lyrically/
├── manifest.json                  # MV3 extension manifest
├── background/
│   └── service-worker.js          # State hub, lyrics fetch, cross-tab broadcast
├── content/
│   ├── detector-combined.js       # YouTubeMusic + YouTube adapters, 500 ms poll
│   └── overlay.js                 # Shadow DOM lyrics panel, drag, sync highlight
├── popup/
│   ├── popup.html                 # Extension popup markup
│   └── popup.js                   # Now-playing display, overlay toggle
├── lib/
│   └── lyrics-engine.js           # Canonical parseLRC() + fetchLyrics()
└── design/
    ├── adapter-interface.md        # Adapter contract spec
    ├── message-protocol.md         # Full message definitions
    ├── selectors.md                # DOM selector reference per platform
    └── storage-schema.md           # chrome.storage key/value schema
```

---

## 🎵 Supported Platforms

| Platform | Detection | Notes |
|---|---|---|
| **YouTube Music** | `music.youtube.com` | Player bar DOM; video `currentTime` |
| **YouTube** | `www.youtube.com` | DOM selectors + title fuzzy-parse fallback; strips qualifiers like "Official Music Video" |
| **Spotify Web** *(planned v0.2)* | — | Roadmap |
| **SoundCloud** *(planned v0.3)* | — | Roadmap |

---

## 🚀 Installation (Developer / Unpacked)

> Lyrically is not yet on the Chrome Web Store. Load it as an unpacked extension.

### Chrome
1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `lyrically` project folder
5. The extension icon appears in the toolbar

### Microsoft Edge
1. Open `edge://extensions`
2. Enable **Developer mode** (left sidebar)
3. Click **Load unpacked**
4. Select the `lyrically` project folder

### After loading
- Navigate to **YouTube Music** or **YouTube** and play a track
- The lyrics panel appears automatically on **any other open tab**
- Use the extension popup (toolbar icon) to see the current track or toggle the overlay

---

## 🖼️ Using the Overlay

| Action | How |
|---|---|
| **Reposition** | Click and drag the panel header |
| **Minimize** | Click **−** (collapses to 54 px header bar) |
| **Close / toggle** | Click **×** or use the popup **Toggle Overlay** button |
| **Sync dot colours** | 🟢 Green = synced (timestamps) · 🟡 Yellow = plain text · ⚫ Grey = off |

Panel position is saved in `chrome.storage.local` and restored on every page load.

---

## 🗺️ Roadmap

### v0.1 — *current*
- [x] YouTube Music + YouTube detection
- [x] lrclib.net lyrics (synced + plain)
- [x] Floating draggable overlay (Shadow DOM)
- [x] Cross-tab broadcast
- [x] 7-day lyrics cache
- [x] Popup with now-playing + toggle

### v0.2 — *planned*
- [ ] Karaoke / Focus mode (large centred lyrics)
- [ ] Spotify Web Player detection
- [ ] Themes / colour presets
- [ ] Keyboard shortcuts

### v0.3+ — *future*
- [ ] SoundCloud support
- [ ] Spotify Web API integration
- [ ] Fullscreen lyrics view
- [ ] Translation assist

---

## 📐 Design Docs

| Document | Purpose |
|---|---|
| [`design/adapter-interface.md`](design/adapter-interface.md) | Platform adapter contract |
| [`design/message-protocol.md`](design/message-protocol.md) | Full message definitions |
| [`design/selectors.md`](design/selectors.md) | DOM selector reference |
| [`design/storage-schema.md`](design/storage-schema.md) | `chrome.storage` key/value schema |

---

## 🤝 Contributing

1. Fork the repo and create a feature branch
2. Load unpacked (see Installation above) — changes to content/popup scripts take effect on page reload; service-worker changes need the extension to be reloaded in `chrome://extensions`
3. Open a PR with a clear description

---

## ⚖️ License

MIT — see [LICENSE](LICENSE) for details.

> lrclib.net is a free, open-source lyrics database. Please respect their usage guidelines.
