// background.js (MV3 service worker)

const activeObjectUrls = new Map(); // downloadId -> objectUrl

// ===== Memory storage (v3: creator-nested) =====
const DL_V3_INDEX_KEY      = 'downloadedIds_v3_index';
const DL_V3_CREATOR_PREFIX = 'downloadedIds_v3_creator_';
const DL_V3_ORPHAN_PREFIX  = 'downloadedIds_v3_orphan_';
const DL_V3_ORPHAN_CHUNK_SIZE = 5000;

// Migration-only constants (v2 → v3)
const DL_V2_INDEX_KEY    = 'downloadedIds_v2_index';
const DL_V2_CHUNK_PREFIX = 'downloadedIds_v2_chunk_';

const CREATOR_VISITS_KEY = 'rg_creator_visits';
const SETTINGS_KEY = 'rg_settings_v1';

function parseOrphanChunkNum(key) {
  const m = key.match(/^downloadedIds_v3_orphan_(\d{4})$/);
  return m ? parseInt(m[1], 10) : null;
}
function orphanChunkKeyFromNum(n) {
  return DL_V3_ORPHAN_PREFIX + String(n).padStart(4, '0');
}

let memMutex = Promise.resolve();
function withMemLock(fn) {
  memMutex = memMutex.then(fn, fn);
  return memMutex;
}

async function ensureIndexV3() {
  const out = await chrome.storage.local.get(DL_V3_INDEX_KEY);
  let idx = out[DL_V3_INDEX_KEY];
  if (idx && idx.version === 3) {
    idx.creators = idx.creators || {};
    idx.orphaned = idx.orphaned || { chunks: [], counts: {}, total: 0 };
    idx.total = idx.total || 0;
    return idx;
  }
  idx = { version: 3, total: 0, creators: {}, orphaned: { chunks: [], counts: {}, total: 0 } };
  await chrome.storage.local.set({ [DL_V3_INDEX_KEY]: idx });
  return idx;
}

async function memAddIdV3(id, creator) {
  return withMemLock(async () => {
    if (!id) return { ok: false, error: 'missing id' };
    let idx = await ensureIndexV3();

    if (creator) {
      const creatorKey = DL_V3_CREATOR_PREFIX + creator;
      const got = await chrome.storage.local.get(creatorKey);
      const obj = got[creatorKey] || {};
      if (obj[id]) return { ok: true, already: true, total: idx.total };
      obj[id] = 1;
      if (!idx.creators[creator]) idx.creators[creator] = { total: 0 };
      idx.creators[creator].total = (idx.creators[creator].total || 0) + 1;
      idx.total = (idx.total || 0) + 1;
      await chrome.storage.local.set({ [creatorKey]: obj, [DL_V3_INDEX_KEY]: idx });
      return { ok: true, added: true, total: idx.total };
    }

    // No creator — write to orphan chunks
    const orphaned = idx.orphaned;
    let activeKey = null;

    if (orphaned.chunks.length) {
      const last = orphaned.chunks[orphaned.chunks.length - 1];
      if ((orphaned.counts[last] ?? 0) < DL_V3_ORPHAN_CHUNK_SIZE) activeKey = last;
    }

    if (!activeKey) {
      const maxNum = orphaned.chunks.reduce((m, k) => {
        const n = parseOrphanChunkNum(k);
        return (n !== null && n > m) ? n : m;
      }, -1);
      activeKey = orphanChunkKeyFromNum(maxNum + 1);
      orphaned.chunks.push(activeKey);
      orphaned.counts[activeKey] = 0;
      await chrome.storage.local.set({ [DL_V3_INDEX_KEY]: idx, [activeKey]: {} });
    }

    const got = await chrome.storage.local.get(activeKey);
    const chunkObj = got[activeKey] || {};
    if (chunkObj[id]) return { ok: true, already: true, total: idx.total };

    chunkObj[id] = 1;
    orphaned.counts[activeKey] = (orphaned.counts[activeKey] ?? 0) + 1;
    orphaned.total = (orphaned.total ?? 0) + 1;
    idx.total = (idx.total ?? 0) + 1;

    await chrome.storage.local.set({ [activeKey]: chunkObj, [DL_V3_INDEX_KEY]: idx });
    return { ok: true, added: true, total: idx.total };
  });
}

async function memDeorphan(ids, creator) {
  return withMemLock(async () => {
    if (!ids?.length || !creator) return { ok: false, error: 'missing ids or creator' };
    let idx = await ensureIndexV3();
    const orphaned = idx.orphaned;
    const chunkKeys = orphaned.chunks.slice();
    if (!chunkKeys.length) return { ok: true, moved: 0 };

    const chunksData = await chrome.storage.local.get(chunkKeys);
    const creatorKey = DL_V3_CREATOR_PREFIX + creator;
    const got = await chrome.storage.local.get(creatorKey);
    const creatorObj = got[creatorKey] || {};

    const remaining = new Set(ids);
    let moved = 0;
    const modifiedChunks = {};

    for (const key of chunkKeys) {
      if (!remaining.size) break;
      const chunkObj = chunksData[key] || {};
      let chunkModified = false;
      for (const id of remaining) {
        if (chunkObj[id]) {
          delete chunkObj[id];
          creatorObj[id] = 1;
          orphaned.counts[key] = Math.max(0, (orphaned.counts[key] ?? 1) - 1);
          orphaned.total = Math.max(0, (orphaned.total ?? 1) - 1);
          moved++;
          chunkModified = true;
          remaining.delete(id);
        }
      }
      if (chunkModified) modifiedChunks[key] = chunkObj;
    }

    if (!moved) return { ok: true, moved: 0 };

    if (!idx.creators[creator]) idx.creators[creator] = { total: 0 };
    idx.creators[creator].total = (idx.creators[creator].total || 0) + moved;

    await chrome.storage.local.set({
      [creatorKey]: creatorObj,
      ...modifiedChunks,
      [DL_V3_INDEX_KEY]: idx,
    });
    return { ok: true, moved };
  });
}

async function memGetCountV3() {
  return withMemLock(async () => {
    const idx = await ensureIndexV3();
    return { ok: true, total: idx.total || 0 };
  });
}

async function memClearAllV3() {
  return withMemLock(async () => {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter(k =>
      k === DL_V3_INDEX_KEY ||
      k.startsWith(DL_V3_CREATOR_PREFIX) ||
      k.startsWith(DL_V3_ORPHAN_PREFIX)
    );
    await chrome.storage.local.remove(keys);
    return { ok: true };
  });
}

async function migrateV2toV3() {
  const v2Out = await chrome.storage.local.get(DL_V2_INDEX_KEY);
  const v2Idx = v2Out[DL_V2_INDEX_KEY];
  if (!v2Idx) return; // No v2 data, nothing to migrate

  // If v3 already exists (crash after step 3 but before step 4), just clean up v2
  const v3Out = await chrome.storage.local.get(DL_V3_INDEX_KEY);
  if (v3Out[DL_V3_INDEX_KEY]) {
    const all = await chrome.storage.local.get(null);
    const v2Keys = Object.keys(all).filter(k => k === DL_V2_INDEX_KEY || k.startsWith(DL_V2_CHUNK_PREFIX));
    if (v2Keys.length) await chrome.storage.local.remove(v2Keys);
    return;
  }

  // Collect all v2 chunk keys
  let chunkKeys = [];
  if (Array.isArray(v2Idx.chunks)) {
    chunkKeys = v2Idx.chunks;
  } else {
    const all = await chrome.storage.local.get(null);
    chunkKeys = Object.keys(all).filter(k => k.startsWith(DL_V2_CHUNK_PREFIX));
  }

  // Flatten all IDs from v2 chunks
  const ids = [];
  if (chunkKeys.length) {
    const chunksData = await chrome.storage.local.get(chunkKeys);
    for (const key of chunkKeys) {
      const obj = chunksData[key] || {};
      for (const id of Object.keys(obj)) ids.push(id);
    }
  }

  // Write v3 orphan chunks
  const orphanChunks = [];
  const orphanCounts = {};
  let orphanTotal = 0;
  let chunkNum = 0;
  let cur = Object.create(null);
  let curCount = 0;

  const flush = async () => {
    const key = orphanChunkKeyFromNum(chunkNum);
    orphanChunks.push(key);
    orphanCounts[key] = curCount;
    await chrome.storage.local.set({ [key]: cur });
    chunkNum++;
    cur = Object.create(null);
    curCount = 0;
  };

  for (const id of ids) {
    cur[id] = 1;
    curCount++;
    orphanTotal++;
    if (curCount >= DL_V3_ORPHAN_CHUNK_SIZE) await flush();
  }
  if (curCount > 0) await flush();

  // Write v3 index (step 3 — crash-safe: v2 still intact)
  await chrome.storage.local.set({
    [DL_V3_INDEX_KEY]: {
      version: 3,
      total: orphanTotal,
      creators: {},
      orphaned: { chunks: orphanChunks, counts: orphanCounts, total: orphanTotal },
    },
  });

  // Delete all v2 data (step 4)
  const all = await chrome.storage.local.get(null);
  const v2Keys = Object.keys(all).filter(k => k === DL_V2_INDEX_KEY || k.startsWith(DL_V2_CHUNK_PREFIX));
  if (v2Keys.length) await chrome.storage.local.remove(v2Keys);
}

// Kick off migration at service-worker start; all MEM_* operations queue behind it
memMutex = migrateV2toV3().catch(e => console.warn('[RedgifsBulk] v2→v3 migration failed:', e));

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

      if (msg?.type === 'MEM_ADD_ID') {
        const resp = await memAddIdV3(msg.id, msg.creator || null);
        sendResponse(resp);
        return;
      }

      if (msg?.type === 'MEM_DEORPHAN') {
        const resp = await memDeorphan(msg.ids, msg.creator);
        sendResponse(resp);
        return;
      }

      if (msg?.type === 'MEM_GET_COUNT') {
        const resp = await memGetCountV3();
        sendResponse(resp);
        return;
      }

      if (msg?.type === 'MEM_CLEAR') {
        const resp = await memClearAllV3();
        sendResponse(resp);
        return;
      }

      if (msg?.type === 'NOTIFY') {
        chrome.notifications.create(`rg-${Date.now()}`, {
          type: 'basic',
          title: msg.title || 'Redgifs Bulk Downloader',
          message: msg.message || '',
          iconUrl: chrome.runtime.getURL('icon48.png'),
        });
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === 'MEM_RECORD_VISIT') {
        const { username, date } = msg;
        if (!username || !date) { sendResponse({ ok: false }); return; }
        const out = await chrome.storage.local.get(CREATOR_VISITS_KEY);
        const visits = out[CREATOR_VISITS_KEY] || {};
        visits[username] = date;
        await chrome.storage.local.set({ [CREATOR_VISITS_KEY]: visits });
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === 'SAVE_SETTING') {
        const { key, value } = msg;
        if (key === undefined) { sendResponse({ ok: false }); return; }
        const out = await chrome.storage.local.get(SETTINGS_KEY);
        const stored = out[SETTINGS_KEY] || {};
        stored[key] = value;
        await chrome.storage.local.set({ [SETTINGS_KEY]: stored });
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ success: false, error: 'UNKNOWN_MESSAGE' });
    } catch (e) {
      sendResponse({ success: false, error: String(e?.message || e) });
    }
  })();

  return true;
});
