# Redgifs Bulk Downloader (Chrome Extension)

A lightweight Chrome extension that adds checkboxes to Redgifs tiles and lets you download selected videos in bulk.
⚠️ This project was developed with the assistance of AI tools (including code generation and architectural guidance). ⚠️

---

## What It Does

- Injects a checkbox into each `div[data-feed-item-id]`
- Adds a floating **Download (N)** button
- Downloads selected videos **sequentially**
- Supports both direct `.mp4` and HLS `.m3u8` streams
- Auto-unchecks successful downloads
- Skips already-downloaded items (per tab session)
- Applies a short cooldown after HLS downloads to prevent memory pressure

---

## How It Works

1. Select tiles using the injected checkboxes  
2. Click **Download (N)**  
3. The extension:
   - Fetches `/watch/<id>`
   - Extracts `.mp4` or `.m3u8`
   - Downloads directly (MP4) or assembles via worker (HLS)
4. Files are saved as `<data-feed-item-id>.mp4`

All downloads are processed strictly one at a time for stability.

---

## Installation (Developer Mode)

1. Clone this repo  
2. Open `chrome://extensions`  
3. Enable **Developer Mode**  
4. Click **Load Unpacked**  
5. Select the project folder  

---

## Notes

- Completed downloads are tracked in `sessionStorage` (resets when tab closes).
- No parallel downloads.
- No background analytics or external services.
- Intended for personal use.

---

## License

MIT