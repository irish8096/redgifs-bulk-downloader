// background.js (MV3 service worker)

const activeObjectUrls = new Map(); // downloadId -> objectUrl

// ===== Memory storage (chunked) =====
const DL_INDEX_KEY = 'downloadedIds_v2_index';
const DL_CHUNK_PREFIX = 'downloadedIds_v2_chunk_';
const DL_CHUNK_SIZE = 5000;

function parseChunkNum(key) {
  const m = key.match(/^downloadedIds_v2_chunk_(\d{4})$/);
  return m ? parseInt(m[1], 10) : null;
}
function chunkKeyFromNum(n) {
  return DL_CHUNK_PREFIX + String(n).padStart(4, '0');
}

let memMutex = Promise.resolve();
function withMemLock(fn) {
  memMutex = memMutex.then(fn, fn);
  return memMutex;
}

async function discoverChunkKeys() {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all)
    .filter(k => k.startsWith(DL_CHUNK_PREFIX))
    .sort((a, b) => (parseChunkNum(a) ?? 0) - (parseChunkNum(b) ?? 0));
}

async function rebuildIndexFromChunks(chunkKeys) {
  const chunksData = await chrome.storage.local.get(chunkKeys);
  const counts = {};
  let total = 0;

  for (const key of chunkKeys) {
    const obj = chunksData[key] || {};
    const c = Object.keys(obj).length;
    counts[key] = c;
    total += c;
  }

  return { version: 2, chunkSize: DL_CHUNK_SIZE, chunks: chunkKeys.slice(), counts, total };
}

async function ensureIndex() {
  const out = await chrome.storage.local.get(DL_INDEX_KEY);
  let idx = out[DL_INDEX_KEY];

  // Hot path: trust the index if it looks valid — skip the expensive full scan
  if (idx && Array.isArray(idx.chunks)) {
    idx.counts    = idx.counts    || {};
    idx.total     = idx.total     || 0;
    idx.chunkSize = idx.chunkSize || DL_CHUNK_SIZE;
    return idx;
  }

  // Repair path: index missing or corrupt — rebuild from full scan
  const discovered = await discoverChunkKeys();
  idx = await rebuildIndexFromChunks(discovered);
  await chrome.storage.local.set({ [DL_INDEX_KEY]: idx });
  return idx;
}

async function memAddId(id) {
  return withMemLock(async () => {
    if (!id) return { ok: false, error: 'missing id' };

    let idx = await ensureIndex();
    const chunkSize = idx.chunkSize || DL_CHUNK_SIZE;

    // Choose active chunk: last chunk if not full; else create new
    let activeKey = null;

    if (idx.chunks.length) {
      const last = idx.chunks[idx.chunks.length - 1];
      const lastCount = idx.counts?.[last] ?? 0;
      if (lastCount < chunkSize) activeKey = last;
    }

    if (!activeKey) {
      const maxNum = idx.chunks.reduce((m, k) => {
        const n = parseChunkNum(k);
        return (n !== null && n > m) ? n : m;
      }, -1);
      activeKey = chunkKeyFromNum(maxNum + 1);
      idx.chunks.push(activeKey);
      idx.counts[activeKey] = 0;

      // Persist index + initialize chunk
      await chrome.storage.local.set({ [DL_INDEX_KEY]: idx, [activeKey]: {} });
    }

    // Merge-write chunk (critical: read-modify-write)
    const got = await chrome.storage.local.get(activeKey);
    const chunkObj = got[activeKey] || {};

    if (chunkObj[id]) {
      // already present, nothing changes
      return { ok: true, already: true, total: idx.total };
    }

    chunkObj[id] = 1;

    idx.counts[activeKey] = (idx.counts[activeKey] ?? 0) + 1;
    idx.total = (idx.total ?? 0) + 1;

    await chrome.storage.local.set({ [activeKey]: chunkObj, [DL_INDEX_KEY]: idx });
    return { ok: true, added: true, total: idx.total };
  });
}

async function memGetCount() {
  return withMemLock(async () => {
    const idx = await ensureIndex();
    return { ok: true, total: idx.total || 0 };
  });
}

async function memClearAll() {
  return withMemLock(async () => {
    const out = await chrome.storage.local.get(DL_INDEX_KEY);
    const idx = out[DL_INDEX_KEY];
    const keys = Array.isArray(idx?.chunks) ? idx.chunks : await discoverChunkKeys();
    await chrome.storage.local.remove([DL_INDEX_KEY, ...keys]);
    return { ok: true };
  });
}

// ===== Downloads cleanup =====
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta?.id) return;

  if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
    const url = activeObjectUrls.get(delta.id);
    if (url) {
      activeObjectUrls.delete(delta.id);
      try { URL.revokeObjectURL(url); } catch {}
    }
  }
});

// ===== Message router =====
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      // Existing download paths
      if (msg?.type === 'DOWNLOAD_DIRECT') {
        const { url, filename } = msg;
        const downloadId = await chrome.downloads.download({ url, filename, saveAs: false });
        sendResponse({ success: true, downloadId });
        return;
      }

      if (msg?.type === 'DOWNLOAD_FETCH') {
        const { url, filename } = msg;

        const res = await fetch(url, {
          method: 'GET',
          // S1: 'same-origin' prevents sending cookies to redirect targets on other domains.
          credentials: 'same-origin',
          // S2: Referer and Origin are required because Redgifs' CDN enforces hotlink
          // protection — requests without a matching Referer are rejected with 403.
          // These headers make the request appear as first-party page traffic, which is
          // intentional for this use-case (user-initiated download from the Redgifs tab).
          headers: {
            'Referer': 'https://www.redgifs.com/',
            'Origin': 'https://www.redgifs.com',
            'Accept': '*/*'
          },
          signal: AbortSignal.timeout(30_000) // Q5: prevent indefinitely-hanging fetches
        });

        if (!res.ok) {
          sendResponse({ success: false, error: `FETCH_HTTP_${res.status}` });
          return;
        }

        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);

        const downloadId = await chrome.downloads.download({ url: objectUrl, filename, saveAs: false });
        activeObjectUrls.set(downloadId, objectUrl);

        sendResponse({ success: true, downloadId, fetched: true });
        return;
      }

      // New: memory operations (serialized + merge-based)
      if (msg?.type === 'MEM_ADD_ID') {
        const resp = await memAddId(msg.id);
        sendResponse(resp);
        return;
      }

      if (msg?.type === 'MEM_GET_COUNT') {
        const resp = await memGetCount();
        sendResponse(resp);
        return;
      }

      if (msg?.type === 'MEM_CLEAR') {
        const resp = await memClearAll();
        sendResponse(resp);
        return;
      }

      sendResponse({ success: false, error: 'UNKNOWN_MESSAGE' });
    } catch (e) {
      sendResponse({ success: false, error: String(e?.message || e) });
    }
  })();

  return true;
});