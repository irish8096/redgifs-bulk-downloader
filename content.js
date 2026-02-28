// content.js
// Persistent memory via chrome.storage.local (CHUNKED) + gray-out tiles already downloaded
// - If tile is already downloaded: checkbox is removed / not injected
// - Embed mode (/ifr/<id>): download single video
// - Normal mode: checkbox selection + sequential bulk downloads

(() => {
  'use strict';

  // ===== Config =====
  const TILE_SELECTOR = 'div[data-feed-item-id]';
  const CHECKBOX_CLASS = 'tileItem-checkbox';
  const UI_ID = 'tilecheckbox-ui';
  const CREATOR_PAGE_SELECTOR = '.creatorPage';

  const HLS_COOLDOWN_MS = 750;

  // ===== Persistent storage (chunked) =====
  const DL_INDEX_KEY = 'downloadedIds_v2_index';
  const DL_CHUNK_PREFIX = 'downloadedIds_v2_chunk_';
  const DL_CHUNK_SIZE = 5000;

  // ===== Settings =====
  const SETTINGS_KEY = 'rg_settings_v1';

  // ===== Small utils =====
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function isEmbedMode() {
    return location.pathname.startsWith('/ifr/');
  }

  function getSingleIdFromUrl() {
    const m = location.pathname.match(/^\/(?:ifr|watch)\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function ensureUIParent() {
    return document.querySelector(CREATOR_PAGE_SELECTOR) || document.body || document.documentElement;
  }

  function getSelectedFeedIds() {
    return [...document.querySelectorAll(`input.${CHECKBOX_CLASS}:checked`)]
      .map(cb => cb.dataset.feedItemId)
      .filter(Boolean);
  }

  function uncheckTileById(feedId) {
    const cb = document.querySelector(`input.${CHECKBOX_CLASS}[data-feed-item-id="${CSS.escape(feedId)}"]`);
    if (cb) cb.checked = false;
  }

  async function fetchText(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  }

  function extractMediaUrlsFromWatchHtml(html) {
    const mp4 = (html.match(/https?:\/\/[^"'\\\s]+\.mp4[^"'\\\s]*/i) || [null])[0];
    const m3u8 = (html.match(/https?:\/\/[^"'\\\s]+\.m3u8[^"'\\\s]*/i) || [null])[0];
    return { mp4, m3u8 };
  }

  function downloadBlobAsMp4(blob, filename) {
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  async function fetchArrayBuffer(url, byteRange /* {offset,length} | null */) {
    const headers = new Headers();
    if (byteRange && Number.isFinite(byteRange.offset) && Number.isFinite(byteRange.length)) {
      const start = byteRange.offset;
      const end = start + byteRange.length - 1;
      headers.set('Range', `bytes=${start}-${end}`);
    }

    const res = await fetch(url, {
      method: 'GET',
      headers,
      credentials: 'include',
      mode: 'cors'
    });

    if (!res.ok) throw new Error(`HTTP ${res.status} fetching segment`);
    return await res.arrayBuffer();
  }

  // ===== UI State =====
  let ui = null; // { btn, status }
  let running = false;
  let cancelRequested = false;

  // ===== Persistent memory (chunked) =====
  let downloadedIds = new Set();
  let storageLoaded = false;

  let dlIndex = null;
  let currentChunkKey = null;
  let currentChunkObj = null;
  let saveTimer = null;

  function chunkKeyFromNum(n) {
    return DL_CHUNK_PREFIX + String(n).padStart(4, '0');
  }

  async function loadDownloadedIds() {
    const out = await chrome.storage.local.get(DL_INDEX_KEY);
    dlIndex = out[DL_INDEX_KEY];

    if (!dlIndex || !Array.isArray(dlIndex.chunks)) {
      dlIndex = {
        version: 2,
        chunkSize: DL_CHUNK_SIZE,
        chunks: [],
        counts: {},
        total: 0
      };
    }

    if (dlIndex.chunks.length) {
      const chunksData = await chrome.storage.local.get(dlIndex.chunks);
      for (const key of dlIndex.chunks) {
        const obj = chunksData[key] || {};
        for (const id of Object.keys(obj)) downloadedIds.add(id);
      }
    }

    if (dlIndex.chunks.length) {
      const last = dlIndex.chunks[dlIndex.chunks.length - 1];
      const lastCount = dlIndex.counts?.[last] ?? 0;

      if (lastCount < dlIndex.chunkSize) {
        currentChunkKey = last;
        const got = await chrome.storage.local.get(last);
        currentChunkObj = got[last] || {};
      }
    }

    if (!currentChunkKey) {
      const nextNum = dlIndex.chunks.length;
      currentChunkKey = chunkKeyFromNum(nextNum);
      currentChunkObj = {};
      dlIndex.chunks.push(currentChunkKey);
      dlIndex.counts[currentChunkKey] = 0;
    }
  }

  function isDownloaded(id) {
    return downloadedIds.has(id);
  }

  function markDownloaded(id) {
    if (!id) return;
    if (downloadedIds.has(id)) return;

    downloadedIds.add(id);

    if (!currentChunkObj) currentChunkObj = {};

    const curCount = dlIndex.counts[currentChunkKey] ?? Object.keys(currentChunkObj).length;
    if (curCount >= dlIndex.chunkSize) {
      const nextNum = dlIndex.chunks.length;
      currentChunkKey = chunkKeyFromNum(nextNum);
      currentChunkObj = {};
      dlIndex.chunks.push(currentChunkKey);
      dlIndex.counts[currentChunkKey] = 0;
    }

    currentChunkObj[id] = 1;
    dlIndex.counts[currentChunkKey] = (dlIndex.counts[currentChunkKey] ?? 0) + 1;
    dlIndex.total = (dlIndex.total ?? 0) + 1;

    scheduleSave();
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await chrome.storage.local.set({
          [DL_INDEX_KEY]: dlIndex,
          [currentChunkKey]: currentChunkObj
        });
      } catch (e) {
        console.warn('[RedgifsBulk] storage save failed:', e);
      }
    }, 350);
  }

  // ===== Settings (dim strength) =====
  async function loadDimStrength() {
    const out = await chrome.storage.local.get(SETTINGS_KEY);
    const dim = out[SETTINGS_KEY]?.dim || 'high';
    return (dim === 'low' || dim === 'med' || dim === 'high') ? dim : 'high';
  }

  async function injectStylesOnce() {
    const existing = document.getElementById('rg-bulk-style');
    const dim = await loadDimStrength();

    const presets = {
      low:  { filter: 'grayscale(0.6) brightness(0.82) contrast(1.05)', opacity: '0.90' },
      med:  { filter: 'grayscale(0.85) brightness(0.70) contrast(1.12)', opacity: '0.84' },
      high: { filter: 'grayscale(1) brightness(0.62) contrast(1.15)', opacity: '0.78' }
    };

    const p = presets[dim] || presets.high;
    const css = `
      .rg-downloaded {
        filter: ${p.filter};
        opacity: ${p.opacity};
      }
    `;

    if (existing) {
      existing.textContent = css;
      return;
    }

    const style = document.createElement('style');
    style.id = 'rg-bulk-style';
    style.textContent = css;
    document.documentElement.appendChild(style);
  }

  // ===== UI helpers =====
  function showStatus(msg, ms = 1600) {
    if (!ui?.status) return;
    ui.status.textContent = msg;
    ui.status.style.display = 'block';
    ui.status.style.opacity = '1';

    clearTimeout(showStatus._t);
    showStatus._t = setTimeout(() => {
      ui.status.style.opacity = '0';
      setTimeout(() => (ui.status.style.display = 'none'), 150);
    }, ms);
  }

  function updateSelectionCount() {
    if (!ui?.btn) return;

    if (isEmbedMode()) {
      ui.btn.textContent = running ? 'Downloading… (Click to cancel)' : 'Download';
      return;
    }

    const count = document.querySelectorAll(`input.${CHECKBOX_CLASS}:checked`).length;
    ui.btn.textContent = running
      ? 'Downloading… (Click to cancel)'
      : (count > 0 ? `Download (${count})` : 'Download');
  }

  function setButtonRunning(isRunning) {
    running = isRunning;
    if (!ui?.btn) return;
    ui.btn.style.opacity = isRunning ? '0.95' : '1';
    updateSelectionCount();
  }

  // ===== Downloaded state on tiles =====
  function applyDownloadedState(tile, feedId) {
    if (!feedId) return;

    if (isDownloaded(feedId)) {
      tile.classList.add('rg-downloaded');
      const wrap = tile.querySelector(':scope > .tileItem-checkboxWrap');
      if (wrap) wrap.remove();
    } else {
      tile.classList.remove('rg-downloaded');
    }
  }

  // ===== Checkbox injection (normal mode only) =====
  function injectCheckbox(tile) {
    if (!(tile instanceof HTMLElement)) return false;
    if (!tile.matches(TILE_SELECTOR)) return false;

    const feedId = tile.getAttribute('data-feed-item-id') || '';
    if (!feedId) return false;

    if (isDownloaded(feedId)) {
      applyDownloadedState(tile, feedId);
      return false;
    }

    if (tile.querySelector(`:scope > .tileItem-checkboxWrap`)) return false;

    const cs = getComputedStyle(tile);
    if (cs.position === 'static') tile.style.position = 'relative';

    // Invisible 44x44 hitbox, checkbox centered
    const label = document.createElement('label');
    label.className = 'tileItem-checkboxWrap';
    Object.assign(label.style, {
      position: 'absolute',
      top: '0px',
      left: '0px',
      width: '44px',
      height: '44px',
      zIndex: '999999',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      cursor: 'pointer',
      background: 'transparent',
      pointerEvents: 'auto'
    });

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = CHECKBOX_CLASS;
    Object.assign(cb.style, {
      width: '18px',
      height: '18px',
      margin: '0',
      cursor: 'pointer'
    });

    cb.dataset.feedItemId = feedId;
    cb.addEventListener('change', updateSelectionCount);

    label.appendChild(cb);
    tile.appendChild(label);

    return true;
  }

  function scanAndInject(root = document) {
    let injectedAny = false;
    root.querySelectorAll(TILE_SELECTOR).forEach(tile => {
      const id = tile.getAttribute('data-feed-item-id');
      applyDownloadedState(tile, id);

      if (id && !isDownloaded(id)) {
        if (injectCheckbox(tile)) injectedAny = true;
      }
    });
    if (injectedAny) updateSelectionCount();
  }

  // ===== Background download (direct MP4) =====
  function requestDirectDownload(url, filename) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_DIRECT', url, filename }, (resp) => resolve(resp));
    });
  }

  // ===== HLS -> MP4 via streaming Worker (returns Blob) =====
  async function assembleMp4FromM3u8(videoId, m3u8Url) {
    const manifestText = await fetchText(m3u8Url);

    const workerUrl = chrome.runtime.getURL('mp4worker.js');
    const worker = new Worker(workerUrl, { type: 'module' });

    const cleanup = () => { try { worker.terminate(); } catch {} };
    const parts = [];

    return await new Promise((resolve, reject) => {
      worker.onmessage = async (ev) => {
        const msg = ev.data;

        if (msg?.type === 'FETCH') {
          const { reqId, url, byteRange } = msg;
          try {
            const buf = await fetchArrayBuffer(url, byteRange || null);
            worker.postMessage({ type: 'FETCH_RESULT', reqId, ok: true, buffer: buf }, [buf]);
          } catch (e) {
            worker.postMessage({ type: 'FETCH_RESULT', reqId, ok: false, error: String(e?.message || e) });
          }
          return;
        }

        if (msg?.type === 'PROGRESS' && msg.videoId === videoId) {
          if (Number.isFinite(msg.percent)) {
            showStatus(`(${videoId}) Assembling… ${msg.percent.toFixed(1)}%`, 800);
          }
          return;
        }

        if (msg?.type === 'CHUNK' && msg.videoId === videoId) {
          parts.push(msg.buffer);
          return;
        }

        if (msg?.type === 'DONE' && msg.videoId === videoId) {
          cleanup();
          resolve(new Blob(parts, { type: 'video/mp4' }));
          return;
        }

        if (msg?.type === 'ERROR' && msg.videoId === videoId) {
          cleanup();
          reject(new Error(msg.error || 'Worker error'));
        }
      };

      worker.onerror = (e) => {
        cleanup();
        reject(new Error(e.message || 'Worker crashed'));
      };

      worker.postMessage({ type: 'START', videoId, m3u8Url, manifestText });
    });
  }

  // ===== Per-item processing =====
  async function processOne(videoId, idx, total) {
    const watchUrl = `https://www.redgifs.com/watch/${encodeURIComponent(videoId)}`;

    showStatus(`(${idx}/${total}) Fetching watch page…`, 1200);
    const html = await fetchText(watchUrl);
    const { mp4, m3u8 } = extractMediaUrlsFromWatchHtml(html);

    if (mp4) {
      showStatus(`(${idx}/${total}) Downloading MP4…`, 1500);
      const resp = await requestDirectDownload(mp4, `${videoId}.mp4`);
      if (!resp?.success) throw new Error(resp?.error || 'Direct download failed');
      return { mode: 'mp4' };
    }

    if (m3u8) {
      showStatus(`(${idx}/${total}) Fetching manifest…`, 1200);
      const mp4blob = await assembleMp4FromM3u8(videoId, m3u8);
      showStatus(`(${idx}/${total}) Saving…`, 1200);
      downloadBlobAsMp4(mp4blob, `${videoId}.mp4`);
      return { mode: 'hls' };
    }

    throw new Error('No .mp4 or .m3u8 found on watch page');
  }

  // ===== Sequential queue (bulk, normal mode) =====
  async function runQueueSequential(ids) {
    const queue = ids.filter(id => !isDownloaded(id));
    const skipped = ids.length - queue.length;

    if (!queue.length) {
      showStatus('All selected already downloaded.', 2600);
      for (const id of ids) uncheckTileById(id);
      updateSelectionCount();
      return;
    }

    if (skipped > 0) {
      showStatus(`Skipping ${skipped} already downloaded.`, 2200);
      for (const id of ids) if (isDownloaded(id)) uncheckTileById(id);
      updateSelectionCount();
      await sleep(300);
    }

    showStatus(`Queue started: ${queue.length} item(s)`, 1500);

    for (let i = 0; i < queue.length; i++) {
      if (cancelRequested) {
        showStatus('Canceled.', 2500);
        return;
      }

      const id = queue[i];

      try {
        const result = await processOne(id, i + 1, queue.length);

        markDownloaded(id);
        uncheckTileById(id);
        updateSelectionCount();

        // Update visible tiles: gray out + remove checkbox
        document.querySelectorAll(`${TILE_SELECTOR}[data-feed-item-id="${CSS.escape(id)}"]`)
          .forEach(tile => applyDownloadedState(tile, id));

        showStatus(`(${i + 1}/${queue.length}) Done (${result.mode}).`, 1200);

        if (result.mode === 'hls') await sleep(HLS_COOLDOWN_MS);
        else await sleep(250);
      } catch (e) {
        console.warn('[RedgifsBulk] failed:', id, e);
        showStatus(`(${i + 1}/${queue.length}) Failed: ${id}`, 2500);
        await sleep(500);
      }
    }

    showStatus('Queue finished.', 2500);
  }

  // ===== Single download (embed mode) =====
  async function runSingleDownloadFromEmbed() {
    const id = getSingleIdFromUrl();
    if (!id) return showStatus('Could not determine video id', 2200);

    if (isDownloaded(id)) return showStatus('Already downloaded.', 2000);

    try {
      const result = await processOne(id, 1, 1);
      markDownloaded(id);
      showStatus(`Done (${result.mode}).`, 1800);
      if (result.mode === 'hls') await sleep(HLS_COOLDOWN_MS);
    } catch (e) {
      console.warn('[RedgifsEmbed] failed:', e);
      showStatus('Download failed', 2200);
    }
  }

  // ===== UI creation =====
  function addUI() {
    if (document.getElementById(UI_ID)) return;

    const parent = ensureUIParent();
    if (!parent) return;

    const wrap = document.createElement('div');
    wrap.id = UI_ID;

    Object.assign(wrap.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      zIndex: '2147483647',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-end',
      gap: '8px'
    });

    const status = document.createElement('div');
    Object.assign(status.style, {
      padding: '8px 12px',
      fontSize: '12px',
      borderRadius: '10px',
      background: 'rgba(20,20,20,0.92)',
      color: '#fff',
      border: '1px solid rgba(255,255,255,0.2)',
      boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
      display: 'none',
      maxWidth: '320px',
      textAlign: 'right',
      pointerEvents: 'none'
    });

    const btn = document.createElement('button');
    btn.type = 'button';
    Object.assign(btn.style, {
      padding: '10px 14px',
      fontSize: '14px',
      fontWeight: '700',
      borderRadius: '12px',
      border: '1px solid rgba(255,255,255,0.25)',
      background: 'rgba(20,20,20,0.88)',
      color: '#fff',
      cursor: 'pointer',
      backdropFilter: 'blur(6px)',
      boxShadow: '0 6px 18px rgba(0,0,0,0.35)'
    });

    btn.addEventListener('click', async () => {
      if (running) {
        cancelRequested = true;
        showStatus('Cancel requested…', 1200);
        return;
      }

      cancelRequested = false;
      setButtonRunning(true);

      try {
        if (isEmbedMode()) {
          await runSingleDownloadFromEmbed();
        } else {
          const ids = getSelectedFeedIds();
          if (!ids.length) return showStatus('No tiles selected');
          await runQueueSequential(ids);
        }
      } finally {
        setButtonRunning(false);
        cancelRequested = false;
        updateSelectionCount();
      }
    });

    wrap.appendChild(status);
    wrap.appendChild(btn);
    parent.appendChild(wrap);

    ui = { btn, status };
    updateSelectionCount();
  }

  // ===== Boot =====
  async function boot() {
    try {
      await injectStylesOnce();
    } catch (e) {
      console.warn('[RedgifsBulk] style inject failed:', e);
    }

    try {
      await loadDownloadedIds();
    } catch (e) {
      console.warn('[RedgifsBulk] storage load failed:', e);
    } finally {
      storageLoaded = true;
    }

    addUI();
    updateSelectionCount();

    if (isEmbedMode()) return;

    scanAndInject(document);

    const observer = new MutationObserver((mutations) => {
      if (!storageLoaded) return;

      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.id === UI_ID) continue;

          if (node.matches?.(TILE_SELECTOR)) {
            const id = node.getAttribute('data-feed-item-id');
            applyDownloadedState(node, id);
            if (id && !isDownloaded(id)) injectCheckbox(node);
            continue;
          }

          if (node.querySelector?.(TILE_SELECTOR)) {
            scanAndInject(node);
          }
        }
      }
    });

    const target = document.body || document.documentElement;
    observer.observe(target, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => boot().catch(console.error), { once: true });
  } else {
    boot().catch(console.error);
  }
})();