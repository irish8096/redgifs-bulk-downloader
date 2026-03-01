# Redgifs Bulk Downloader

A Chrome extension for bulk-downloading videos from Redgifs creator pages.

## Features

- Injects checkboxes into video tiles on creator pages (`/users/…`)
- Downloads selected videos sequentially — MP4 direct or HLS assembled in-browser via a Web Worker
- Remembers downloaded videos across sessions (persisted in `chrome.storage.local`)
- **Tiles in memory** are either hidden (`display:none`) or dimmed — switchable via a toggle on the page with no reload required
- Single-video download button on watch pages (`/watch/…`) and embed pages (`/ifr/…`)
- Configurable filename format with `<id>`, `<date>`, and `<index>` tags
- Adjustable download speed (Fast / Normal / Slow / Custom delay)
- Desktop notifications when a batch finishes (optional)
- Configurable download button position (corner) for both creator and embed pages
- Options page showing stored ID count, export/import history, dim appearance sliders, and version with update check

## Installation

1. Clone or download this repo
2. Open `chrome://extensions` and enable **Developer Mode**
3. Click **Load unpacked** and select the project folder

## Usage

### Creator pages (`redgifs.com/users/…`)

1. Checkboxes appear on each tile automatically
2. Check the tiles you want, then click **Download (N)** in the corner
3. Already-downloaded tiles are hidden or dimmed based on your settings
4. If **Hide tiles in memory** is enabled, a **Tiles in memory:** toggle appears below the Follow button — flip it to switch between Hiding and Dimming instantly

### Watch & embed pages

A **Download** button appears in the corner. If the video has already been downloaded it shows **Downloaded**; click again to confirm a re-download.

## Options

Open via the extension's **Details → Extension options** or `chrome://extensions`.

| Setting | Description |
|---------|-------------|
| Memory mode | Full (persisted), Session-only, or None (privacy mode) |
| Hide tiles in memory | Hides downloaded tiles from the feed; toggle on the page switches to Dim without a reload |
| Tiles in memory appearance | Grayscale, brightness, contrast, and opacity sliders for the dim effect |
| Download speed | Fast / Normal / Slow / Custom ms range |
| Notifications | Desktop notification when a batch completes |
| Filename format | Template with `<id>`, `<date>`, `<date(YYYY-MM-DD)>`, `<index>` |
| Button position | Corner for embed pages and creator pages independently |
| Export / Import | Save or restore your downloaded-ID list as JSON |

## Notes

- Downloads are strictly sequential — no parallel downloads
- The extension fetches `raw.githubusercontent.com` once on options-page load to check for updates — no other external requests beyond Redgifs APIs
- Intended for personal use

---

*Developed with AI assistance. Code reviewed and tested by hand.*
