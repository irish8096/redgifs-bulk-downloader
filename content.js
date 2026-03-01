(() => {
  'use strict';

  const TILE_SELECTOR = 'div[data-feed-item-id]';
  const CHECKBOX_CLASS = 'tileItem-checkbox';
  const UI_ID = 'tilecheckbox-ui';
  const CREATOR_PAGE_SELECTOR = '.creatorPage';

  const SEGMENT_RETRIES = 4;
  const SEGMENT_BACKOFF_MS = 250;

  const DL_INDEX_KEY = 'downloadedIds_v2_index';
  const DL_CHUNK_PREFIX = 'downloadedIds_v2_chunk_';
  const SETTINGS_KEY = 'rg_settings_v1';

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
    const res = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  }

  function extractMediaUrlsFromWatchHtml(html) {
    // TODO (S4): Replace with JSON parse of the page's embedded state object (e.g. window.__STORE__)
    // for more reliable extraction. Regex may match unintended .mp4/.m3u8 URLs from ads or comments.
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

  async function fetchArrayBuffer(url, byteRange) {
    const headers = new Headers();
    if (byteRange && Number.isFinite(byteRange.offset) && Number.isFinite(byteRange.length)) {
      const start = byteRange.offset;
      const end = start + byteRange.length - 1;
      headers.set('Range', `bytes=${start}-${end}`);
    }

    const res = await fetch(url, { method: 'GET', headers, credentials: 'include', mode: 'cors', signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching segment`);
    return await res.arrayBuffer();
  }

  async function fetchArrayBufferWithRetry(url, byteRange) {
    let lastErr = null;
    for (let attempt = 0; attempt <= SEGMENT_RETRIES; attempt++) {
      try {
        return await fetchArrayBuffer(url, byteRange);
      } catch (e) {
        lastErr = e;
        if (attempt === SEGMENT_RETRIES) break;
        await sleep(SEGMENT_BACKOFF_MS * Math.pow(2, attempt));
      }
    }
    throw new Error(lastErr?.message || String(lastErr) || 'Segment fetch failed');
  }

  let cachedToken = null;
  let cachedTokenExpiry = 0;

  function randomDelayMs() {
    const ranges = {
      fast:   [100, 300],
      normal: [400, 900],
      slow:   [1000, 2000],
      custom: [settings.downloadDelayMin, settings.downloadDelayMax],
    };
    const [min, max] = ranges[settings.downloadSpeed] || ranges.normal;
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  function formatDate(date, fmt) {
    const y = String(date.getFullYear());
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return fmt.replace('YYYY', y).replace('MM', m).replace('DD', d);
  }

  function buildFilename(videoId, index, total) {
    let result = settings.filenameFormat || '<id>';
    const now = new Date();
    result = result.replace(/<date\(([^)]+)\)>/g, (_, fmt) => formatDate(now, fmt));
    result = result.replace(/<date>/g, formatDate(now, 'YYYYMMDD'));
    const pad = Math.max(String(total || 1).length, 2);
    result = result.replace(/<index>/g, String(index).padStart(pad, '0'));
    result = result.replace(/<id>/g, videoId);
    result = result.replace(/[\\/:*?"<>|]/g, '_').trim() || videoId;
    return result + '.mp4';
  }

  async function getApiToken() {
    if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;
    const res = await fetch('https://api.redgifs.com/v2/auth/temporary', {
      signal: AbortSignal.timeout(30_000)
    });
    if (!res.ok) throw new Error(`Token fetch failed: HTTP ${res.status}`);
    const data = await res.json();
    cachedToken = data.token;
    cachedTokenExpiry = Date.now() + 20 * 60 * 60 * 1000;
    return cachedToken;
  }

  async function fetchGifUrls(videoId) {
    try {
      const token = await getApiToken();
      const res = await fetch(
        `https://api.redgifs.com/v2/gifs/${encodeURIComponent(videoId)}`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) }
      );
      if (!res.ok) throw new Error(`API error: HTTP ${res.status}`);
      const data = await res.json();
      const mp4  = data.gif?.urls?.hd  || null;
      const m3u8 = data.gif?.urls?.hls || null;
      if (mp4 || m3u8) return { mp4, m3u8 };
      throw new Error('No URLs in API response');
    } catch (e) {
      console.warn('[RedgifsBulk] API fetch failed, falling back to HTML:', e.message);
      const html = await fetchText(`https://www.redgifs.com/watch/${encodeURIComponent(videoId)}`);
      return extractMediaUrlsFromWatchHtml(html);
    }
  }

  // ===== Settings =====
  let settings = {
    dimGrayscale: 100,
    dimBrightness: 62,
    dimContrast: 115,
    dimOpacity: 78,
    memoryMode: 'full',
    downloadSpeed: 'normal',
    downloadDelayMin: 400,
    downloadDelayMax: 900,
    notifications: false,
    filenameFormat: '<id>',
    btnCornerEmbed: 'top-right',
    btnCornerPage: 'bottom-right',
    dimRemove: false,
  };

  // ===== UI state =====
  let ui = null;
  let running = false;
  let cancelRequested = false;
  let embedRedownloadConfirm = false;
  const runProgress = { current: 0, total: 0 };
  let statusTimer;
  let scanDebounceTimer = null;

  // ===== Downloaded memory (read-side) =====
  let downloadedIds = new Set();
  let storageLoaded = false;

  function parseChunkNum(key) {
    const m = key.match(/^downloadedIds_v2_chunk_(\d{4})$/);
    return m ? parseInt(m[1], 10) : null;
  }

  async function discoverChunkKeysLocal() {
    const out = await chrome.storage.local.get(DL_INDEX_KEY);
    const idx = out[DL_INDEX_KEY];
    if (idx && Array.isArray(idx.chunks)) return idx.chunks;

    // Fallback: index missing — full scan
    const all = await chrome.storage.local.get(null);
    return Object.keys(all)
      .filter(k => k.startsWith(DL_CHUNK_PREFIX))
      .sort((a, b) => (parseChunkNum(a) ?? 0) - (parseChunkNum(b) ?? 0));
  }

  async function loadDownloadedIds() {
    if (settings.memoryMode !== 'full') return;
    // For UI behavior we can still build a Set locally.
    // (Writes are now done ONLY by background via MEM_ADD_ID.)
    const discovered = await discoverChunkKeysLocal();

    downloadedIds = new Set();
    if (discovered.length) {
      const chunksData = await chrome.storage.local.get(discovered);
      for (const key of discovered) {
        const obj = chunksData[key] || {};
        for (const id of Object.keys(obj)) downloadedIds.add(id);
      }
    }
  }

  function isDownloaded(id) {
    if (settings.memoryMode === 'none') return false;
    return downloadedIds.has(id);
  }

  function requestMemAdd(id) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'MEM_ADD_ID', id }, (resp) => {
        void chrome.runtime.lastError;
        resolve(resp);
      });
    });
  }

  async function markDownloaded(id) {
    if (settings.memoryMode === 'none') return;
    if (!id || downloadedIds.has(id)) return;
    downloadedIds.add(id);
    if (settings.memoryMode === 'full') {
      const resp = await requestMemAdd(id);
      if (!resp?.ok) {
        console.warn('[RedgifsBulk] MEM_ADD_ID failed:', resp?.error);
        downloadedIds.delete(id);
      }
    }
    // 'session': in-memory only, no storage write
  }

  function notifyIfEnabled(title, message) {
    if (!settings.notifications) return;
    chrome.runtime.sendMessage({ type: 'NOTIFY', title, message });
  }

  // ===== Settings =====
  async function loadSettings() {
    const out = await chrome.storage.local.get(SETTINGS_KEY);
    const stored = out[SETTINGS_KEY] || {};
    const VALID_SPEED = ['fast', 'normal', 'slow', 'custom'];
    const VALID_CORNER = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
    const VALID_MEM = ['full', 'session', 'none'];
    settings.dimGrayscale = (Number.isFinite(stored.dimGrayscale) && stored.dimGrayscale >= 0   && stored.dimGrayscale <= 100) ? stored.dimGrayscale : 100;
    settings.dimBrightness= (Number.isFinite(stored.dimBrightness)&& stored.dimBrightness >= 0  && stored.dimBrightness <= 200) ? stored.dimBrightness : 62;
    settings.dimContrast  = (Number.isFinite(stored.dimContrast)  && stored.dimContrast >= 0    && stored.dimContrast <= 200)   ? stored.dimContrast   : 115;
    settings.dimOpacity   = (Number.isFinite(stored.dimOpacity)   && stored.dimOpacity >= 0     && stored.dimOpacity <= 100)    ? stored.dimOpacity    : 78;
    settings.memoryMode = VALID_MEM.includes(stored.memoryMode) ? stored.memoryMode : 'full';
    settings.downloadSpeed = VALID_SPEED.includes(stored.downloadSpeed) ? stored.downloadSpeed : 'normal';
    settings.downloadDelayMin = (Number.isFinite(stored.downloadDelayMin) && stored.downloadDelayMin >= 0) ? stored.downloadDelayMin : 400;
    settings.downloadDelayMax = (Number.isFinite(stored.downloadDelayMax) && stored.downloadDelayMax >= 0) ? stored.downloadDelayMax : 900;
    settings.notifications = stored.notifications === true;
    settings.filenameFormat = typeof stored.filenameFormat === 'string' ? stored.filenameFormat : '<id>';
    settings.btnCornerEmbed = VALID_CORNER.includes(stored.btnCornerEmbed) ? stored.btnCornerEmbed : 'top-right';
    settings.btnCornerPage = VALID_CORNER.includes(stored.btnCornerPage) ? stored.btnCornerPage : 'bottom-right';
    settings.dimRemove = stored.dimRemove === true;
  }

  async function injectStylesOnce() {
    const existing = document.getElementById('rg-bulk-style');
    const { dimGrayscale, dimBrightness, dimContrast, dimOpacity } = settings;
    const filter = `grayscale(${dimGrayscale/100}) brightness(${dimBrightness/100}) contrast(${dimContrast/100})`;
    const css = `.rg-downloaded { filter: ${filter}; opacity: ${dimOpacity/100}; }`;

    if (existing) { existing.textContent = css; return; }
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

    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      ui.status.style.opacity = '0';
      setTimeout(() => (ui.status.style.display = 'none'), 150);
    }, ms);
  }

  function updateSelectionCount() {
    if (!ui?.btn) return;

    if (running && runProgress.total > 0) {
      ui.btn.textContent = `Downloading ${runProgress.current} / ${runProgress.total} (Click to cancel)`;
      return;
    }

    if (isEmbedMode()) {
      if (running) {
        ui.btn.textContent = 'Downloading… (Click to cancel)';
      } else if (embedRedownloadConfirm) {
        ui.btn.textContent = 'Download again?';
      } else if (isDownloaded(getSingleIdFromUrl())) {
        ui.btn.textContent = 'Downloaded';
      } else {
        ui.btn.textContent = 'Download';
      }
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

  function applyDownloadedState(tile, feedId) {
    if (!feedId) return;
    if (isDownloaded(feedId)) {
      if (settings.dimRemove) {
        tile.remove();
      } else {
        tile.classList.add('rg-downloaded');
        const wrap = tile.querySelector(':scope > .tileItem-checkboxWrap');
        if (wrap) wrap.remove();
      }
    } else {
      tile.classList.remove('rg-downloaded');
    }
  }

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

  // ===== Downloads =====
  function requestDirectDownload(url, filename) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_DIRECT', url, filename }, (resp) => {
        void chrome.runtime.lastError;
        resolve(resp);
      });
    });
  }

  function requestFetchDownload(url, filename) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_FETCH', url, filename }, (resp) => {
        void chrome.runtime.lastError;
        resolve(resp);
      });
    });
  }

  async function downloadMp4Smart(mp4Url, filename) {
    const direct = await requestDirectDownload(mp4Url, filename);
    if (direct?.success) return { mode: 'mp4-direct' };

    const fetched = await requestFetchDownload(mp4Url, filename);
    if (fetched?.success) return { mode: 'mp4-fetch' };

    const err = direct?.error || fetched?.error || 'download failed';
    throw new Error(err);
  }

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
            const buf = await fetchArrayBufferWithRetry(url, byteRange || null);
            worker.postMessage({ type: 'FETCH_RESULT', reqId, ok: true, buffer: buf }, [buf]);
          } catch (e) {
            worker.postMessage({ type: 'FETCH_RESULT', reqId, ok: false, error: String(e?.message || e) });
          }
          return;
        }

        if (msg?.type === 'CHUNK' && msg.videoId === videoId) {
          parts.push(msg.buffer);
          return;
        }

        if (msg?.type === 'DONE' && msg.videoId === videoId) {
          try { resolve(new Blob(parts, { type: 'video/mp4' })); } finally { cleanup(); }
          return;
        }

        if (msg?.type === 'ERROR' && msg.videoId === videoId) {
          try { reject(new Error(msg.error || 'Worker error')); } finally { cleanup(); }
        }
      };

      worker.onerror = (e) => { cleanup(); reject(new Error(e.message || 'Worker crashed')); };
      worker.postMessage({ type: 'START', videoId, m3u8Url, manifestText });
    });
  }

  async function processOne(videoId, index, total) {
    const { mp4, m3u8 } = await fetchGifUrls(videoId);
    const filename = buildFilename(videoId, index, total);

    if (mp4) {
      await downloadMp4Smart(mp4, filename);
      return { mode: 'mp4' };
    }

    if (m3u8) {
      const mp4blob = await assembleMp4FromM3u8(videoId, m3u8);
      downloadBlobAsMp4(mp4blob, filename);
      return { mode: 'hls' };
    }

    throw new Error('No .mp4 or .m3u8 found');
  }

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
      for (const id of ids) {
        if (isDownloaded(id)) {
          uncheckTileById(id);
          // B3: also apply downloaded state immediately so tiles don't wait for next scroll/scan
          document.querySelectorAll(`${TILE_SELECTOR}[data-feed-item-id="${CSS.escape(id)}"]`)
            .forEach(tile => applyDownloadedState(tile, id));
        }
      }
      updateSelectionCount();
      await sleep(300);
    }

    runProgress.total = queue.length;
    let successCount = 0;

    for (let i = 0; i < queue.length; i++) {
      if (cancelRequested) { showStatus('Canceled.', 2500); return; }

      const id = queue[i];
      runProgress.current = i + 1;
      updateSelectionCount();

      try {
        // B1: Mark downloaded optimistically before starting so a navigation/refresh
        // mid-download doesn't cause a re-download next session. Roll back the local
        // in-memory set on failure so the item stays retryable this session.
        await markDownloaded(id);

        try {
          await processOne(id, i + 1, queue.length);
        } catch (e) {
          downloadedIds.delete(id); // roll back local set; storage entry stays (acceptable)
          throw e;
        }

        successCount++;
        uncheckTileById(id);
        document.querySelectorAll(`${TILE_SELECTOR}[data-feed-item-id="${CSS.escape(id)}"]`)
          .forEach(tile => applyDownloadedState(tile, id));

        await sleep(randomDelayMs());
      } catch (e) {
        console.warn('[RedgifsBulk] failed:', id, e);
        showStatus(`(${i + 1}/${queue.length}) Failed: ${id}`, 2500);
        await sleep(500);
      }
    }

    notifyIfEnabled('Redgifs Bulk Downloader', `Downloaded ${successCount} of ${queue.length} video(s).`);
  }

  async function runSingleDownloadFromEmbed() {
    const id = getSingleIdFromUrl();
    if (!id) return showStatus('Could not determine video id', 2200);

    runProgress.total = 1;
    runProgress.current = 0; // B2: start at 0; set to 1 after completion
    updateSelectionCount();

    try {
      await markDownloaded(id); // B1: optimistic mark before download
      try {
        await processOne(id, 1, 1);
        runProgress.current = 1; // B2: reflect completion
        notifyIfEnabled('Redgifs Bulk Downloader', 'Download complete.');
        await sleep(randomDelayMs());
      } catch (e) {
        downloadedIds.delete(id); // B1: roll back local set on failure
        throw e;
      }
    } catch (e) {
      console.warn('[RedgifsEmbed] failed:', e);
      showStatus(`Download failed: ${String(e?.message || e)}`, 2600);
    }
  }

  function addUI() {
    if (document.getElementById(UI_ID)) return;

    const parent = ensureUIParent();
    if (!parent) return;

    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:-9999px;width:50px;height:50px;overflow:scroll;visibility:hidden';
    document.body.appendChild(probe);
    const nativeScrollbarWidth = probe.offsetWidth - probe.clientWidth;
    probe.remove();
    // On embed pages the scrollbar belongs to the parent page and can't be measured;
    // fall back to the standard Windows classic scrollbar width.
    const scrollbarWidth = nativeScrollbarWidth > 0 ? nativeScrollbarWidth : (isEmbedMode() ? 17 : 0);

    const wrap = document.createElement('div');
    wrap.id = UI_ID;
    const corner = isEmbedMode() ? settings.btnCornerEmbed : settings.btnCornerPage;
    const [vert, horiz] = corner.split('-');
    const horizValue = horiz === 'right' ? (16 + scrollbarWidth) + 'px' : '16px';
    Object.assign(wrap.style, {
      position: 'fixed',
      [vert]: '16px',
      [horiz]: horizValue,
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
      if (running) { cancelRequested = true; showStatus('Cancel requested…', 1200); return; }

      if (isEmbedMode()) {
        const id = getSingleIdFromUrl();
        if (!embedRedownloadConfirm && isDownloaded(id)) {
          embedRedownloadConfirm = true;
          updateSelectionCount();
          return;
        }
        embedRedownloadConfirm = false;
      }

      cancelRequested = false;
      runProgress.current = 0;
      runProgress.total = 0;
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
        runProgress.current = 0;
        runProgress.total = 0;
        updateSelectionCount();
      }
    });

    wrap.appendChild(status);
    wrap.appendChild(btn);
    parent.appendChild(wrap);

    ui = { btn, status };
    updateSelectionCount();
  }

  async function boot() {
    try { await loadSettings(); } catch (e) { console.warn('[RedgifsBulk] settings load failed:', e); }
    try { await injectStylesOnce(); } catch (e) { console.warn('[RedgifsBulk] style inject failed:', e); }

    if (settings.memoryMode === 'full') {
      try { await loadDownloadedIds(); }
      catch (e) { console.warn('[RedgifsBulk] storage load failed:', e); }
      finally { storageLoaded = true; }
    } else {
      storageLoaded = true;
    }

    addUI();
    updateSelectionCount();

    if (isEmbedMode()) return;

    scanAndInject(document);

    const observer = new MutationObserver((mutations) => {
      if (!storageLoaded) return;

      let needsFullScan = false;

      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.id === UI_ID) continue;

          if (node.matches?.(TILE_SELECTOR)) {
            const id = node.getAttribute('data-feed-item-id');
            applyDownloadedState(node, id);
            if (id && !isDownloaded(id)) injectCheckbox(node);
          } else if (node.querySelector?.(TILE_SELECTOR)) {
            needsFullScan = true;
          }
        }
      }

      if (needsFullScan) {
        clearTimeout(scanDebounceTimer);
        scanDebounceTimer = setTimeout(() => scanAndInject(document), 100);
      }
    });

    const target = document.body || document.documentElement;
    observer.observe(target, { childList: true, subtree: true });
  }

  const handleBootError = (e) => {
    console.error('[RedgifsBulk] boot failed:', e);
    showStatus('Extension failed to initialize', 8000);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => boot().catch(handleBootError), { once: true });
  } else {
    boot().catch(handleBootError);
  }
})();