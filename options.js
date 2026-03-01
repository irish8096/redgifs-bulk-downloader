const DL_INDEX_KEY = 'downloadedIds_v2_index';
const DL_CHUNK_PREFIX = 'downloadedIds_v2_chunk_';
const DL_CHUNK_SIZE = 5000;

const SETTINGS_KEY = 'rg_settings_v1';

let showTimer;
let pendingImportIds = null;

function show(msg) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(showTimer);
  showTimer = setTimeout(() => (el.style.display = 'none'), 2500);
}

function parseChunkNum(key) {
  const m = key.match(/^downloadedIds_v2_chunk_(\d{4})$/);
  return m ? parseInt(m[1], 10) : null;
}

function chunkKeyFromNum(n) {
  return DL_CHUNK_PREFIX + String(n).padStart(4, '0');
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

  return {
    version: 2,
    chunkSize: DL_CHUNK_SIZE,
    chunks: chunkKeys.slice(),
    counts,
    total
  };
}

async function ensureIndex() {
  const out = await chrome.storage.local.get(DL_INDEX_KEY);
  const idx = out[DL_INDEX_KEY];

  if (idx && Array.isArray(idx.chunks)) return idx;

  // Repair path
  const discovered = await discoverChunkKeys();
  const rebuilt = await rebuildIndexFromChunks(discovered);
  await chrome.storage.local.set({ [DL_INDEX_KEY]: rebuilt });
  return rebuilt;
}

async function loadCount() {
  const idx = await ensureIndex();
  document.getElementById('count').textContent = String(idx.total || 0);
}


async function loadSettings() {
  const out = await chrome.storage.local.get(SETTINGS_KEY);
  const stored = out[SETTINGS_KEY] || {};
  return {
    dim: stored.dim || 'high',
    dimCustom: Number.isFinite(stored.dimCustom) ? stored.dimCustom : 75,
    memoryMode: stored.memoryMode || 'full',
    downloadSpeed: stored.downloadSpeed || 'normal',
    downloadDelayMin: Number.isFinite(stored.downloadDelayMin) ? stored.downloadDelayMin : 400,
    downloadDelayMax: Number.isFinite(stored.downloadDelayMax) ? stored.downloadDelayMax : 900,
    notifications: stored.notifications === true,
    autoSelect: stored.autoSelect === true,
    filenameFormat: typeof stored.filenameFormat === 'string' ? stored.filenameFormat : '<id>',
    btnCornerEmbed: stored.btnCornerEmbed || 'top-right',
    btnCornerPage: stored.btnCornerPage || 'bottom-right',
  };
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

async function initDimUI() {
  const settings = await loadSettings();
  const val = settings.dim || 'high';

  const radio = document.querySelector(`input[name="dim"][value="${val}"]`);
  if (radio) radio.checked = true;

  document.querySelectorAll('input[name="dim"]').forEach(r => {
    r.addEventListener('change', async () => {
      const next = r.value;
      const cur = await loadSettings();
      cur.dim = next;
      await saveSettings(cur);
      show(`Dim strength set to: ${next}`);
    });
  });

  const dimCustomBlock = document.getElementById('dimCustomBlock');
  const dimCustomSlider = document.getElementById('dimCustom');
  const dimCustomVal = document.getElementById('dimCustomVal');

  function updateDimCustomVisibility() {
    const checked = document.querySelector('input[name="dim"]:checked');
    dimCustomBlock.style.display = checked?.value === 'custom' ? 'block' : 'none';
  }

  dimCustomSlider.value = settings.dimCustom;
  dimCustomVal.textContent = settings.dimCustom;
  updateDimCustomVisibility();

  document.querySelectorAll('input[name="dim"]').forEach(r => {
    r.addEventListener('change', updateDimCustomVisibility);
  });

  dimCustomSlider.addEventListener('input', () => {
    dimCustomVal.textContent = dimCustomSlider.value;
  });

  dimCustomSlider.addEventListener('change', async () => {
    const cur = await loadSettings();
    cur.dimCustom = parseInt(dimCustomSlider.value, 10);
    await saveSettings(cur);
  });
}

async function initNewSettings() {
  const settings = await loadSettings();

  // Memory mode
  document.querySelectorAll('input[name="memoryMode"]').forEach(r => {
    if (r.value === settings.memoryMode) r.checked = true;
    r.addEventListener('change', async () => {
      const cur = await loadSettings();
      cur.memoryMode = r.value;
      await saveSettings(cur);
    });
  });

  // Download speed
  const customDelayBlock = document.getElementById('customDelayBlock');
  const delayMinEl = document.getElementById('delayMin');
  const delayMaxEl = document.getElementById('delayMax');

  delayMinEl.value = settings.downloadDelayMin;
  delayMaxEl.value = settings.downloadDelayMax;

  function updateCustomDelayVisibility() {
    const checked = document.querySelector('input[name="downloadSpeed"]:checked');
    customDelayBlock.style.display = checked?.value === 'custom' ? 'block' : 'none';
  }

  document.querySelectorAll('input[name="downloadSpeed"]').forEach(r => {
    if (r.value === settings.downloadSpeed) r.checked = true;
    r.addEventListener('change', async () => {
      updateCustomDelayVisibility();
      const cur = await loadSettings();
      cur.downloadSpeed = r.value;
      await saveSettings(cur);
    });
  });
  updateCustomDelayVisibility();

  async function saveCustomDelay() {
    const min = parseInt(delayMinEl.value, 10);
    const max = parseInt(delayMaxEl.value, 10);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < 0 || min > max) return;
    const cur = await loadSettings();
    cur.downloadDelayMin = min;
    cur.downloadDelayMax = max;
    await saveSettings(cur);
  }

  delayMinEl.addEventListener('change', saveCustomDelay);
  delayMaxEl.addEventListener('change', saveCustomDelay);

  // Notifications
  const notificationsEl = document.getElementById('notifications');
  notificationsEl.checked = settings.notifications;
  notificationsEl.addEventListener('change', async () => {
    const cur = await loadSettings();
    cur.notifications = notificationsEl.checked;
    await saveSettings(cur);
  });

  // Auto-select
  const autoSelectEl = document.getElementById('autoSelect');
  autoSelectEl.checked = settings.autoSelect;
  autoSelectEl.addEventListener('change', async () => {
    const cur = await loadSettings();
    cur.autoSelect = autoSelectEl.checked;
    await saveSettings(cur);
  });

  // Filename format
  const filenameFormatEl = document.getElementById('filenameFormat');
  const filenameWarningEl = document.getElementById('filenameWarning');
  filenameFormatEl.value = settings.filenameFormat;

  function updateFilenameWarning() {
    filenameWarningEl.style.display = filenameFormatEl.value.includes('<id>') ? 'none' : 'block';
  }
  updateFilenameWarning();

  filenameFormatEl.addEventListener('input', updateFilenameWarning);
  filenameFormatEl.addEventListener('change', async () => {
    const cur = await loadSettings();
    cur.filenameFormat = filenameFormatEl.value;
    await saveSettings(cur);
  });

  // Button corners
  const btnCornerEmbedEl = document.getElementById('btnCornerEmbed');
  const btnCornerPageEl = document.getElementById('btnCornerPage');
  btnCornerEmbedEl.value = settings.btnCornerEmbed;
  btnCornerPageEl.value = settings.btnCornerPage;

  btnCornerEmbedEl.addEventListener('change', async () => {
    const cur = await loadSettings();
    cur.btnCornerEmbed = btnCornerEmbedEl.value;
    await saveSettings(cur);
  });

  btnCornerPageEl.addEventListener('change', async () => {
    const cur = await loadSettings();
    cur.btnCornerPage = btnCornerPageEl.value;
    await saveSettings(cur);
  });
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
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

async function exportIds() {
  const idx = await ensureIndex();
  if (!idx.chunks.length) {
    show('Nothing to export.');
    return;
  }

  show('Exporting…');
  const chunksData = await chrome.storage.local.get(idx.chunks);
  const ids = [];

  for (const key of idx.chunks) {
    const obj = chunksData[key] || {};
    for (const id of Object.keys(obj)) ids.push(id);
  }

  const payload = {
    format: 'redgifsBulkDownloadedIds',
    version: 1,
    exportedAt: new Date().toISOString(),
    count: ids.length,
    ids
  };

  downloadTextFile(`redgifs-downloaded-ids-${ids.length}.json`, JSON.stringify(payload, null, 2));
  show(`Exported ${ids.length} IDs.`);
  await loadCount();
}

function normalizeImportedIds(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.ids)) return parsed.ids;
  return null;
}

async function importIdsFromList(ids, mode) {
  const cleaned = [...new Set(ids.filter(x => typeof x === 'string' && x.length > 0))];
  if (!cleaned.length) {
    show('Import file had no usable IDs.');
    return;
  }

  // D1: Write-then-swap — write new chunks first, then commit the index, then remove old
  // chunks. If the tab crashes before the index write, old data survives untouched.
  // New chunks use keys starting after the current max so there is no key collision.
  const oldIdx = await ensureIndex();
  const oldChunkKeys = oldIdx.chunks;
  const maxOldNum = oldChunkKeys.reduce((m, k) => {
    const n = parseChunkNum(k);
    return (n !== null && n > m) ? n : m;
  }, -1);

  if (mode === 'merge') {
    show(`Merging ${cleaned.length} IDs…`);

    const oldChunksData = await chrome.storage.local.get(oldChunkKeys);
    const existingSet = new Set();
    for (const key of oldChunkKeys) {
      const obj = oldChunksData[key] || {};
      for (const id of Object.keys(obj)) existingSet.add(id);
    }

    const toWrite = cleaned.filter(id => !existingSet.has(id));
    const dupCount = cleaned.length - toWrite.length;

    if (toWrite.length === 0) {
      show(`No new IDs — all ${cleaned.length} already present.`);
      return;
    }

    const newChunks = [];
    const newCounts = {};
    let newTotal = 0;

    let chunkNum = maxOldNum + 1;
    let cur = Object.create(null);
    let curCount = 0;

    const flush = async () => {
      const key = chunkKeyFromNum(chunkNum);
      newChunks.push(key);
      newCounts[key] = curCount;
      await chrome.storage.local.set({ [key]: cur });
      chunkNum++;
      cur = Object.create(null);
      curCount = 0;
    };

    for (let i = 0; i < toWrite.length; i++) {
      cur[toWrite[i]] = 1;
      curCount++;
      newTotal++;
      if (curCount >= DL_CHUNK_SIZE) await flush();
    }
    if (curCount > 0) await flush();

    const allChunks = [...oldChunkKeys, ...newChunks];
    const allCounts = { ...oldIdx.counts, ...newCounts };
    const grandTotal = (oldIdx.total || 0) + newTotal;
    const index = { version: 2, chunkSize: DL_CHUNK_SIZE, chunks: allChunks, counts: allCounts, total: grandTotal };
    await chrome.storage.local.set({ [DL_INDEX_KEY]: index });

    show(`Merged ${newTotal} new IDs (${dupCount} duplicate${dupCount !== 1 ? 's' : ''} skipped). Total: ${grandTotal}.`);
    await loadCount();
    return;
  }

  // Override mode
  show(`Importing ${cleaned.length} IDs…`);

  const newChunks = [];
  const newCounts = {};
  let total = 0;

  let chunkNum = maxOldNum + 1;
  let cur = Object.create(null);
  let curCount = 0;

  const flush = async () => {
    const key = chunkKeyFromNum(chunkNum);
    newChunks.push(key);
    newCounts[key] = curCount;
    await chrome.storage.local.set({ [key]: cur });
    chunkNum++;
    cur = Object.create(null);
    curCount = 0;
  };

  for (let i = 0; i < cleaned.length; i++) {
    cur[cleaned[i]] = 1;
    curCount++;
    total++;

    if (curCount >= DL_CHUNK_SIZE) {
      await flush();
      if (i % 10000 === 0 && i > 0) show(`Importing… ${total}/${cleaned.length}`);
    }
  }

  if (curCount > 0) await flush();

  // Atomic commit point: index now points to new chunks; old data still intact up to here
  const index = { version: 2, chunkSize: DL_CHUNK_SIZE, chunks: newChunks, counts: newCounts, total };
  await chrome.storage.local.set({ [DL_INDEX_KEY]: index });

  // Remove old chunks — safe to fail, they are now orphaned
  if (oldChunkKeys.length) {
    try { await chrome.storage.local.remove(oldChunkKeys); }
    catch (e) { console.warn('[RedgifsOptions] Failed to remove old chunks after import:', e); }
  }

  show(`Imported ${total} IDs.`);
  await loadCount();
}

async function readAndValidateFile(file) {
  const text = await file.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    show('Import failed: invalid JSON.');
    return null;
  }

  const ids = normalizeImportedIds(parsed);
  if (!ids) {
    show('Import failed: expected an array or { ids: [...] }.');
    return null;
  }

  // S3: Guard against malformed/huge files that would OOM the tab
  if (ids.length > 5_000_000) {
    show('Import failed: file too large (>5M IDs).');
    return null;
  }

  return ids;
}

function hideImportMode() {
  pendingImportIds = null;
  document.getElementById('importMode').style.display = 'none';
}

async function importIdsFromFile(file) {
  const ids = await readAndValidateFile(file);
  if (!ids) return;

  pendingImportIds = ids;
  document.getElementById('importFileName').textContent = file.name;
  document.getElementById('importMode').style.display = 'block';
}

// UI wiring
document.getElementById('refresh').addEventListener('click', async () => {
  await loadCount();
  show('Refreshed.');
});

document.getElementById('clear').addEventListener('click', async () => {
  // A1: route through background mutex so it can't race with an active download
  await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'MEM_CLEAR' }, (resp) => {
      void chrome.runtime.lastError;
      resolve(resp);
    });
  });
  await loadCount();
  show('Memory cleared.');
});

document.getElementById('export').addEventListener('click', async () => {
  try { await exportIds(); }
  catch (e) { console.error(e); show('Export failed (see console).'); }
});

const importBtn = document.getElementById('importBtn');
const importFile = document.getElementById('importFile');

importBtn.addEventListener('click', () => {
  importFile.value = '';
  importFile.click();
});

importFile.addEventListener('change', async () => {
  const file = importFile.files?.[0];
  if (!file) return;
  try { await importIdsFromFile(file); }
  catch (e) { console.error(e); show('Import failed (see console).'); }
});

document.getElementById('importMerge').addEventListener('click', async () => {
  if (!pendingImportIds) return;
  const ids = pendingImportIds;
  hideImportMode();
  try { await importIdsFromList(ids, 'merge'); }
  catch (e) { console.error(e); show('Import failed (see console).'); }
});

document.getElementById('importOverride').addEventListener('click', async () => {
  if (!pendingImportIds) return;
  const ids = pendingImportIds;
  hideImportMode();
  try { await importIdsFromList(ids, 'override'); }
  catch (e) { console.error(e); show('Import failed (see console).'); }
});

document.getElementById('importCancel').addEventListener('click', hideImportMode);

(async () => {
  await loadCount();
  await initDimUI();
  await initNewSettings();
})().catch(console.error);
