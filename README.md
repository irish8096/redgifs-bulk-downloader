# Redgifs Bulk Downloader

A Chrome extension for bulk-downloading videos from Redgifs creator pages.

## Features

- Injects checkboxes into video tiles on creator pages
- Downloads selected videos sequentially — MP4 direct or HLS assembled in-browser
- Remembers downloaded videos across sessions (persisted in `chrome.storage.local`)
- Dims already-downloaded tiles so you can see what's new at a glance
- Options page to view count, export/import history, and adjust dim strength
- Embed page (`/ifr/`) support for single-video download

## Installation

1. Clone or download this repo
2. Open `chrome://extensions` and enable **Developer Mode**
3. Click **Load unpacked** and select the project folder

## Usage

1. Go to any Redgifs creator page (`redgifs.com/users/…`)
2. Check the tiles you want to download
3. Click **Download (N)** in the bottom-right corner
4. Files are saved as `<video-id>.mp4`

## Notes

- No parallel downloads — strictly sequential for stability
- No background analytics or external requests beyond Redgifs itself
- Intended for personal use

---

*Developed with AI assistance (Claude, ChatGPT). Code reviewed and tested by hand.*
