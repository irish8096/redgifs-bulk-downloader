# Redgifs Bulk Downloader — Project Guide

## What It Is
A Chrome MV3 extension that bulk-downloads Redgifs videos. Injects checkboxes into creator-page tiles, downloads selected videos sequentially (MP4 direct or HLS assembled via a Web Worker), and persists download history across sessions.

## File Map
| File | Role |
|------|------|
| `manifest.json` | MV3 manifest — permissions, host rules, content script registration |
| `content.js` | Content script — UI injection, tile scanning, download queue orchestration |
| `background.js` | Service worker — handles `DOWNLOAD_DIRECT`, `DOWNLOAD_FETCH`, and all `MEM_*` messages |
| `mp4worker.js` | Web Worker (module) — parses HLS manifests, fetches segments, strips ftyp/moov, streams chunks |
| `options.js` | Options page logic — count display, export/import, dim-strength setting |
| `options.html` | Options page markup |

## Architecture Notes

**No build step.** All files are plain JS loaded directly by Chrome. Do not introduce a bundler, transpiler, or npm dependencies.

**Message passing pattern:**
- Content script → background via `chrome.runtime.sendMessage`
- Worker ↔ content script via `postMessage` / `worker.onmessage`
- Message types: `DOWNLOAD_DIRECT`, `DOWNLOAD_FETCH`, `MEM_ADD_ID`, `MEM_GET_COUNT`, `MEM_CLEAR`

**Storage layout (`chrome.storage.local`):**
- `downloadedIds_v2_index` — index object: `{ version, chunkSize, chunks[], counts{}, total }`
- `downloadedIds_v2_chunk_NNNN` — chunk objects: `{ [videoId]: 1, ... }` (5000 IDs per chunk)
- `rg_settings_v1` — settings object: `{ dim: 'low'|'med'|'high' }`
- All storage writes are serialized through `withMemLock()` in `background.js` to prevent race conditions.

**Download flow:**
1. `content.js` fetches `/watch/<id>` HTML
2. Extracts `.mp4` or `.m3u8` URL via regex (known limitation — see S4 TODO in code)
3. MP4: tries `DOWNLOAD_DIRECT` first, falls back to `DOWNLOAD_FETCH`
4. HLS: `assembleMp4FromM3u8()` spawns `mp4worker.js`, proxies segment fetches through content script, collects CHUNK blobs, triggers download on DONE

**Modes:**
- Creator page (`/users/*`) — multi-tile checkbox UI
- Watch page (`/watch/*`) — single download button
- Embed page (`/ifr/*`) — single download, no tile scanning

## Testing / Reload Workflow
1. Open `chrome://extensions` in developer mode
2. Click **Load unpacked** → select project folder (first time)
3. After code changes: click the reload icon on the extension card
4. No automated tests yet — verify manually. Tests for core logic are worth adding eventually.

## How to Work With Claude

**Before making changes:** always write a plan and wait for explicit approval before editing any files.

**Unrelated issues noticed during work:** always ask before touching anything outside the stated task scope. Do not silently fix things.

**Committing and pushing:** when asked to commit and/or push, just do it — no extra confirmation step needed.

**Version bumping:** increment the patch version (`0.0.1`) in `manifest.json` on every commit. For example: 1.0.5 → 1.0.6. Never increment minor (`0.1.0`) or major without explicit instruction — but do flag when a minor bump seems appropriate (e.g. after a meaningful feature batch lands).

**CLAUDE.md:** keep this file up to date as the project evolves. Add new conventions, update the deferred issues list, note architectural changes.

**Build tools:** the project currently has no build step (plain JS, load unpacked). Don't add a bundler or npm unless there's a concrete reason and it's discussed first.

## Code Conventions
- Vanilla JS only unless a build tool is explicitly introduced
- Constants at the top of each file (all-caps, named)
- `async/await` throughout; no raw `.then()` chains in new code
- All `fetch()` calls must include `signal: AbortSignal.timeout(30_000)`
- Storage writes go through background service worker only — content scripts call `MEM_ADD_ID` via message and are otherwise read-only on storage
- Do not add `console.log` debug statements; use `console.warn` with a `[RedgifsBulk]` prefix for real warnings
- Do not add docstrings, comments, or type annotations to code that wasn't changed

## Known Deferred Issues
- **S4 / F8:** URL extraction uses regex on raw HTML. Should be replaced with JSON parse of embedded page state (`window.__STORE__` or similar). Tagged as TODO in `extractMediaUrlsFromWatchHtml`.
- **P2 (background-hosted Set):** `loadDownloadedIds()` builds a local in-memory Set on every tab boot. For very large histories (50k+ IDs) this costs RAM. The proper fix is hosting the Set in the background service worker and making `isDownloaded()` async everywhere — a significant refactor deferred until needed.
- **F1–F7:** Feature additions (parallel downloads, select-all, filter, retry button, hotkey, auto-scroll) deferred.
