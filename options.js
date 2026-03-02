const DL_INDEX_KEY = 'downloadedIds_v2_index';
const DL_CHUNK_PREFIX = 'downloadedIds_v2_chunk_';
const DL_CHUNK_SIZE = 5000;

const SETTINGS_KEY = 'rg_settings_v1';
const CREATOR_VISITS_KEY = 'rg_creator_visits';

let showTimer;
let pendingImport = null;

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

function updateMemCountVisibility() {
  const checked = document.querySelector('input[name="memoryMode"]:checked');
  document.getElementById('memCountRow').style.display =
    checked?.value === 'full' ? 'flex' : 'none';
}

async function loadCount() {
  const idx = await ensureIndex();
  document.getElementById('count').textContent = String(idx.total || 0);
  updateMemCountVisibility();
}


async function loadSettings() {
  const out = await chrome.storage.local.get(SETTINGS_KEY);
  const stored = out[SETTINGS_KEY] || {};
  return {
    dimGrayscale: (Number.isFinite(stored.dimGrayscale) && stored.dimGrayscale >= 0   && stored.dimGrayscale <= 100) ? stored.dimGrayscale : 100,
    dimBrightness:(Number.isFinite(stored.dimBrightness)&& stored.dimBrightness >= 0  && stored.dimBrightness <= 200) ? stored.dimBrightness : 62,
    dimContrast:  (Number.isFinite(stored.dimContrast)  && stored.dimContrast >= 0    && stored.dimContrast <= 200)   ? stored.dimContrast   : 115,
    dimOpacity:   (Number.isFinite(stored.dimOpacity)   && stored.dimOpacity >= 0     && stored.dimOpacity <= 100)    ? stored.dimOpacity    : 78,
    dimRemove: stored.dimRemove === true,
    memoryMode: stored.memoryMode || 'full',
    downloadSpeed: stored.downloadSpeed || 'normal',
    downloadDelayMin: Number.isFinite(stored.downloadDelayMin) ? stored.downloadDelayMin : 400,
    downloadDelayMax: Number.isFinite(stored.downloadDelayMax) ? stored.downloadDelayMax : 900,
    notifications: stored.notifications === true,
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
  const sliders = [
    { id: 'dimGrayscale', key: 'dimGrayscale' },
    { id: 'dimBrightness', key: 'dimBrightness' },
    { id: 'dimContrast',   key: 'dimContrast'   },
    { id: 'dimOpacity',    key: 'dimOpacity'     },
  ];
  for (const { id, key } of sliders) {
    const el  = document.getElementById(id);
    const val = document.getElementById(id + 'Val');
    el.value = settings[key];
    val.textContent = settings[key];
    el.addEventListener('input', () => { val.textContent = el.value; });
    el.addEventListener('change', async () => {
      const cur = await loadSettings();
      cur[key] = parseInt(el.value, 10);
      await saveSettings(cur);
    });
  }

  const dimRemoveEl = document.getElementById('dimRemove');

  dimRemoveEl.checked = settings.dimRemove === true;

  dimRemoveEl.addEventListener('change', async () => {
    const cur = await loadSettings();
    cur.dimRemove = dimRemoveEl.checked;
    await saveSettings(cur);
  });

  const DIM_DEFAULTS = { dimGrayscale: 100, dimBrightness: 62, dimContrast: 115, dimOpacity: 78 };
  document.getElementById('dimRevertDefaults').addEventListener('click', async () => {
    for (const { id, key } of sliders) {
      document.getElementById(id).value = DIM_DEFAULTS[key];
      document.getElementById(id + 'Val').textContent = DIM_DEFAULTS[key];
    }
    const cur = await loadSettings();
    Object.assign(cur, DIM_DEFAULTS);
    await saveSettings(cur);
  });
}

async function initNewSettings() {
  const settings = await loadSettings();

  // Memory mode
  let pendingMemMode = null;

  const memClearPrompt = document.getElementById('memClearPrompt');
  const memClearYes    = document.getElementById('memClearYes');
  const memClearNo     = document.getElementById('memClearNo');

  function hideMemPrompt() {
    memClearPrompt.style.display = 'none';
    pendingMemMode = null;
  }

  async function applyMemMode(mode, clearFirst) {
    if (clearFirst) {
      await new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'MEM_CLEAR' }, (resp) => {
          void chrome.runtime.lastError; resolve(resp);
        });
      });
    }
    const cur = await loadSettings();
    cur.memoryMode = mode;
    await saveSettings(cur);
    await loadCount();
  }

  memClearYes.addEventListener('click', async () => {
    const mode = pendingMemMode;
    hideMemPrompt();
    if (!mode) return;
    await applyMemMode(mode, true);
    show('Stored IDs cleared.');
  });

  memClearNo.addEventListener('click', async () => {
    hideMemPrompt();
    const fullRadio = document.querySelector('input[name="memoryMode"][value="full"]');
    if (fullRadio) fullRadio.checked = true;
    updateMemCountVisibility();
    const cur = await loadSettings();
    cur.memoryMode = 'full';
    await saveSettings(cur);
  });

  document.querySelectorAll('input[name="memoryMode"]').forEach(r => {
    if (r.value === settings.memoryMode) r.checked = true;
    r.addEventListener('change', () => {
      updateMemCountVisibility();
      if (r.value !== 'full') {
        pendingMemMode = r.value;
        memClearPrompt.style.display = 'block';
      } else {
        hideMemPrompt();
        loadSettings().then(cur => { cur.memoryMode = 'full'; return saveSettings(cur); });
      }
    });
  });

  updateMemCountVisibility();

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

async function exportBackup() {
  show('Exporting…');
  const idx = await ensureIndex();
  const ids = [];
  if (idx.chunks.length) {
    const chunksData = await chrome.storage.local.get(idx.chunks);
    for (const key of idx.chunks) {
      const obj = chunksData[key] || {};
      for (const id of Object.keys(obj)) ids.push(id);
    }
  }

  const settingsOut = await chrome.storage.local.get(SETTINGS_KEY);
  const visitsOut = await chrome.storage.local.get(CREATOR_VISITS_KEY);
  const creatorVisits = visitsOut[CREATOR_VISITS_KEY] || {};

  const payload = {
    format: 'redgifsBulkBackup',
    version: 2,
    exportedAt: new Date().toISOString(),
    idCount: ids.length,
    ids,
    settings: settingsOut[SETTINGS_KEY] || null,
    creatorVisitCount: Object.keys(creatorVisits).length,
    creatorVisits,
  };

  downloadTextFile(
    `redgifs-backup-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify(payload, null, 2)
  );
  show(`Exported ${ids.length} IDs, ${Object.keys(creatorVisits).length} creator visits.`);
}

function parseBackupFile(parsed) {
  if (parsed?.format === 'redgifsBulkBackup') {
    return {
      ids: Array.isArray(parsed.ids) ? parsed.ids : [],
      settings: (parsed.settings && typeof parsed.settings === 'object') ? parsed.settings : null,
      creatorVisits: (parsed.creatorVisits && typeof parsed.creatorVisits === 'object') ? parsed.creatorVisits : {},
    };
  }
  // Legacy formats (old export or plain array)
  if (Array.isArray(parsed)) return { ids: parsed, settings: null, creatorVisits: {} };
  if (parsed && Array.isArray(parsed.ids)) return { ids: parsed.ids, settings: null, creatorVisits: {} };
  return null;
}

async function importFromBackup(backup, mode) {
  const { ids, settings: backupSettings, creatorVisits: backupVisits } = backup;
  const cleaned = [...new Set(ids.filter(x => typeof x === 'string' && x.length > 0))];

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
    show('Merging…');

    // --- IDs: skip duplicates ---
    const oldChunksData = await chrome.storage.local.get(oldChunkKeys);
    const existingIds = new Set();
    for (const key of oldChunkKeys) {
      const obj = oldChunksData[key] || {};
      for (const id of Object.keys(obj)) existingIds.add(id);
    }

    const toWrite = cleaned.filter(id => !existingIds.has(id));
    const idDups = cleaned.length - toWrite.length;

    let newIdTotal = 0;
    const newChunks = [];
    const newCounts = {};
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

    for (const id of toWrite) {
      cur[id] = 1;
      curCount++;
      newIdTotal++;
      if (curCount >= DL_CHUNK_SIZE) await flush();
    }
    if (curCount > 0) await flush();

    if (newIdTotal > 0) {
      const allChunks = [...oldChunkKeys, ...newChunks];
      const allCounts = { ...oldIdx.counts, ...newCounts };
      const grandTotal = (oldIdx.total || 0) + newIdTotal;
      await chrome.storage.local.set({
        [DL_INDEX_KEY]: { version: 2, chunkSize: DL_CHUNK_SIZE, chunks: allChunks, counts: allCounts, total: grandTotal },
      });
    }

    // --- Creator visits: keep most recent date for duplicates ---
    const visitsOut = await chrome.storage.local.get(CREATOR_VISITS_KEY);
    const existingVisits = visitsOut[CREATOR_VISITS_KEY] || {};
    let visitNew = 0;
    let visitDups = 0;

    for (const [username, date] of Object.entries(backupVisits)) {
      if (typeof username !== 'string' || typeof date !== 'string') continue;
      if (existingVisits[username]) {
        visitDups++;
        if (date > existingVisits[username]) existingVisits[username] = date;
      } else {
        existingVisits[username] = date;
        visitNew++;
      }
    }
    await chrome.storage.local.set({ [CREATOR_VISITS_KEY]: existingVisits });

    const grandTotal = (oldIdx.total || 0) + newIdTotal;
    show(`Merged: ${newIdTotal} new IDs (${idDups} dup${idDups !== 1 ? 's' : ''} skipped), ${visitNew} new creators (${visitDups} updated). Total: ${grandTotal}.`);
    await loadCount();
    return;
  }

  // Override mode — full restore
  show('Restoring…');

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

  for (const id of cleaned) {
    cur[id] = 1;
    curCount++;
    total++;
    if (curCount >= DL_CHUNK_SIZE) {
      await flush();
      if (total % 10000 === 0) show(`Restoring… ${total}/${cleaned.length}`);
    }
  }
  if (curCount > 0) await flush();

  await chrome.storage.local.set({
    [DL_INDEX_KEY]: { version: 2, chunkSize: DL_CHUNK_SIZE, chunks: newChunks, counts: newCounts, total },
  });

  if (oldChunkKeys.length) {
    try { await chrome.storage.local.remove(oldChunkKeys); }
    catch (e) { console.warn('[RedgifsOptions] Failed to remove old chunks after restore:', e); }
  }

  await chrome.storage.local.set({ [CREATOR_VISITS_KEY]: backupVisits });

  if (backupSettings) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: backupSettings });
  }

  const visitCount = Object.keys(backupVisits).length;
  show(`Restored ${total} IDs, ${visitCount} creator visits${backupSettings ? ', and settings' : ''}.`);
  await loadCount();
  if (backupSettings) setTimeout(() => location.reload(), 1200);
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

  const backup = parseBackupFile(parsed);
  if (!backup) {
    show('Import failed: unrecognized file format.');
    return null;
  }

  // S3: Guard against malformed/huge files that would OOM the tab
  if (backup.ids.length > 5_000_000) {
    show('Import failed: file too large (>5M IDs).');
    return null;
  }

  return backup;
}

function hideImportMode() {
  pendingImport = null;
  document.getElementById('importMode').style.display = 'none';
}

async function importIdsFromFile(file) {
  const backup = await readAndValidateFile(file);
  if (!backup) return;

  pendingImport = backup;
  document.getElementById('importFileName').textContent = file.name;
  document.getElementById('importMode').style.display = 'block';
}

function isNewerVersion(remote, current) {
  const r = remote.split('.').map(Number);
  const c = current.split('.').map(Number);
  for (let i = 0; i < Math.max(r.length, c.length); i++) {
    const rv = r[i] ?? 0;
    const cv = c[i] ?? 0;
    if (rv > cv) return true;
    if (rv < cv) return false;
  }
  return false;
}

async function initVersionUI() {
  const current = chrome.runtime.getManifest().version;
  document.getElementById('currentVersion').textContent = current;

  const statusEl = document.getElementById('updateStatus');
  statusEl.textContent = 'Checking for updates…';

  try {
    const res = await fetch(
      'https://raw.githubusercontent.com/irish8096/redgifs-bulk-downloader/main/manifest.json',
      { signal: AbortSignal.timeout(8_000) }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const remote = await res.json();
    if (isNewerVersion(remote.version, current)) {
      statusEl.textContent = `Update available: v${remote.version}`;
      statusEl.style.color = '#c0392b';
    } else {
      statusEl.textContent = 'Up to date';
    }
  } catch {
    statusEl.textContent = 'Could not check for updates';
  }
}

// UI wiring
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
  try { await exportBackup(); }
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
  if (!pendingImport) return;
  const backup = pendingImport;
  hideImportMode();
  try { await importFromBackup(backup, 'merge'); }
  catch (e) { console.error(e); show('Import failed (see console).'); }
});

document.getElementById('importOverride').addEventListener('click', async () => {
  if (!pendingImport) return;
  const backup = pendingImport;
  hideImportMode();
  try { await importFromBackup(backup, 'override'); }
  catch (e) { console.error(e); show('Import failed (see console).'); }
});

document.getElementById('importCancel').addEventListener('click', hideImportMode);

(async () => {
  await loadCount();
  await initDimUI();
  await initNewSettings();
  await initVersionUI();
})().catch(console.error);
