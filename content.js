// content.js (stable UI + selection count + streaming HLS assembly via mp4worker.js)
// Enhancements added:
// - Auto-uncheck tile after successful download
// - Skip IDs already completed this tab (sessionStorage-backed Set)
// - Cooldown after each HLS video to let GC breathe (default 750ms)
// - Still strictly sequential (no parallel downloads)

(() => {
  'use strict';

  // ===== Config =====
  const TILE_SELECTOR = 'div[data-feed-item-id]';
  const CHECKBOX_CLASS = 'tileItem-checkbox';
  const UI_ID = 'tilecheckbox-ui';
  const CREATOR_PAGE_SELECTOR = '.creatorPage';

  const HLS_COOLDOWN_MS = 750;
  const COMPLETED_KEY = 'redgifsBulk_completedIds_v1';

  // ===== Small utils =====
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function ensureUIParent() {
    return document.querySelector(CREATOR_PAGE_SELECTOR) || document.body || document.documentElement;
  }

  function safeJsonParse(s, fallback) {
    try { return JSON.parse(s); } catch { return fallback; }
  }

  function loadCompletedSet() {
    const raw = sessionStorage.getItem(COMPLETED_KEY);
    const arr = safeJsonParse(raw, []);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter(x => typeof x === 'string' && x.length));
  }

  function saveCompletedSet(set) {
    try {
      sessionStorage.setItem(COMPLETED_KEY, JSON.stringify([...set]));
    } catch {
      // If storage is full/blocked, just ignore; Set still works in-memory.
    }
  }

  const completedIds = loadCompletedSet();

  function markCompleted(id) {
    completedIds.add(id);
    saveCompletedSet(completedIds);
  }

  function isCompleted(id) {
    return completedIds.has(id);
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

  // ===== State =====
  let ui = null; // { btn, status }
  let running = false;
  let cancelRequested = false;

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
    const count = document.querySelectorAll(`input.${CHECKBOX_CLASS}:checked`).length;

    if (running) {
      ui.btn.textContent = 'Downloading… (Click to cancel)';
    } else {
      ui.btn.textContent = count > 0 ? `Download (${count})` : 'Download';
    }
  }

  function setButtonRunning(isRunning) {
    running = isRunning;
    if (!ui?.btn) return;
    ui.btn.style.opacity = isRunning ? '0.95' : '1';
    updateSelectionCount();
  }

  // ===== Checkbox injection =====
  function injectCheckbox(tile) {
    if (!(tile instanceof HTMLElement)) return false;
    if (!tile.matches(TILE_SELECTOR)) return false;

    if (tile.querySelector(`:scope > .tileItem-checkboxWrap`)) return false;

    const cs = getComputedStyle(tile);
    if (cs.position === 'static') tile.style.position = 'relative';

    // Invisible click zone
    const label = document.createElement('label');
    label.className = 'tileItem-checkboxWrap';

    Object.assign(label.style, {
      position: 'absolute',
      top: '0px',
      left: '0px',
      width: '44px',     // bigger hit area
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

    const feedId = tile.getAttribute('data-feed-item-id');
    if (feedId) cb.dataset.feedItemId = feedId;

    cb.addEventListener('change', updateSelectionCount);

    label.appendChild(cb);
    tile.appendChild(label);

    return true;
  }

  function scanAndInject(root = document) {
    let injectedAny = false;
    root.querySelectorAll(TILE_SELECTOR).forEach(tile => {
      if (injectCheckbox(tile)) injectedAny = true;
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

    const cleanup = () => { try { worker.terminate(); } catch { } };

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
          const blob = new Blob(parts, { type: 'video/mp4' });
          resolve(blob);
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

  // ===== Sequential queue (bulk) =====
  async function runQueueSequential(ids) {
    const totalSelected = ids.length;

    // Filter out already-completed IDs (sessionStorage-backed)
    const queue = ids.filter(id => !isCompleted(id));
    const skipped = totalSelected - queue.length;

    if (!queue.length) {
      showStatus(`All selected already downloaded (this tab).`, 3000);
      return;
    }

    if (skipped > 0) {
      showStatus(`Skipping ${skipped} already downloaded (this tab).`, 2500);
      // Also auto-uncheck skipped ones so count reflects reality
      for (const id of ids) {
        if (isCompleted(id)) uncheckTileById(id);
      }
      updateSelectionCount();
      await sleep(400);
    }

    const total = queue.length;
    let ok = 0;
    let failed = 0;

    showStatus(`Queue started: ${total} item(s)`, 1800);

    for (let i = 0; i < queue.length; i++) {
      if (cancelRequested) {
        showStatus(`Canceled. Completed ${ok}/${total}`, 3500);
        return;
      }

      const id = queue[i];

      try {
        const result = await processOne(id, i + 1, total);

        // Mark completed + auto-uncheck
        markCompleted(id);
        uncheckTileById(id);
        updateSelectionCount();

        ok++;
        showStatus(`(${i + 1}/${total}) Done (${result.mode}).`, 1200);

        // Cooldown after HLS to let GC breathe
        if (result.mode === 'hls') {
          await sleep(HLS_COOLDOWN_MS);
        } else {
          await sleep(250);
        }
      } catch (e) {
        failed++;
        console.warn('[RedgifsBulk] failed:', id, e);
        showStatus(`(${i + 1}/${total}) Failed: ${id}`, 2500);
        await sleep(500);
      }
    }

    showStatus(`Queue finished. OK: ${ok}, Failed: ${failed}`, 4500);
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

      const ids = getSelectedFeedIds();
      if (!ids.length) {
        showStatus('No tiles selected');
        return;
      }

      cancelRequested = false;
      setButtonRunning(true);

      try {
        await runQueueSequential(ids);
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
  function boot() {
    scanAndInject(document);
    addUI();
    updateSelectionCount();

    // Keep observer lean: only inject checkboxes; never run selection counting from here.
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.id === UI_ID) continue;

          if (node.matches?.(TILE_SELECTOR)) {
            injectCheckbox(node);
            continue;
          }

          // Cheap pre-check before scanning a subtree
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
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();