const DL_V3_INDEX_KEY      = 'downloadedIds_v3_index';
const DL_V3_CREATOR_PREFIX = 'downloadedIds_v3_creator_';
const DL_V3_ORPHAN_PREFIX  = 'downloadedIds_v3_orphan_';
const DL_V3_ORPHAN_CHUNK_SIZE = 5000;

const SETTINGS_KEY             = 'rg_settings_v1';
const CREATOR_VISITS_KEY       = 'rg_creator_visits';
const CREATOR_FIRST_VISITS_KEY = 'rg_creator_first_visits';

let showTimer;
let pendingImport = null;

function show(msg) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(showTimer);
  showTimer = setTimeout(() => (el.style.display = 'none'), 2500);
}

function parseOrphanChunkNum(key) {
  const m = key.match(/^downloadedIds_v3_orphan_(\d{4})$/);
  return m ? parseInt(m[1], 10) : null;
}

function orphanChunkKeyFromNum(n) {
  return DL_V3_ORPHAN_PREFIX + String(n).padStart(4, '0');
}

function updateMemCountVisibility() {
  const checked = document.querySelector('input[name="memoryMode"]:checked');
  document.getElementById('memCountRow').style.display =
    checked?.value === 'full' ? 'flex' : 'none';
}

async function loadCount() {
  const out = await chrome.storage.local.get(DL_V3_INDEX_KEY);
  const idx = out[DL_V3_INDEX_KEY];
  document.getElementById('count').textContent = String(idx?.total || 0);
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
    memoryMode: stored.memoryMode || 'full',
    downloadSpeed: stored.downloadSpeed || 'normal',
    downloadDelayMin: Number.isFinite(stored.downloadDelayMin) ? stored.downloadDelayMin : 400,
    downloadDelayMax: Number.isFinite(stored.downloadDelayMax) ? stored.downloadDelayMax : 900,
    notifications: stored.notifications === true,
    filenameFormat: typeof stored.filenameFormat === 'string' ? stored.filenameFormat : '<id>',
    btnCornerEmbed: stored.btnCornerEmbed || 'top-right',
    btnCornerPage: stored.btnCornerPage || 'bottom-right',
    hideMode: stored.hideMode !== false,
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
  const out = await chrome.storage.local.get(DL_V3_INDEX_KEY);
  const idx = out[DL_V3_INDEX_KEY];
  const creators = {};
  const orphaned = [];
  const creatorIdMap = {};

  if (idx) {
    // Load creator ID objects
    const creatorUsernames = Object.keys(idx.creators || {});
    if (creatorUsernames.length) {
      const creatorKeys = creatorUsernames.map(u => DL_V3_CREATOR_PREFIX + u);
      const creatorData = await chrome.storage.local.get(creatorKeys);
      for (const u of creatorUsernames) {
        const obj = creatorData[DL_V3_CREATOR_PREFIX + u] || {};
        creatorIdMap[u] = Object.entries(obj).map(([id, val]) => ({
          tile_id: id,
          downloaded: val === 1,
        }));
      }
    }

    // Load orphan chunks
    const orphanChunks = idx.orphaned?.chunks || [];
    if (orphanChunks.length) {
      const chunksData = await chrome.storage.local.get(orphanChunks);
      for (const key of orphanChunks) {
        const obj = chunksData[key] || {};
        for (const id of Object.keys(obj)) orphaned.push(id);
      }
    }
  }

  const visitsData = await chrome.storage.local.get([CREATOR_VISITS_KEY, CREATOR_FIRST_VISITS_KEY]);
  const lastVisits  = visitsData[CREATOR_VISITS_KEY]       || {};
  const firstVisits = visitsData[CREATOR_FIRST_VISITS_KEY] || {};

  const allUsernames = new Set([
    ...Object.keys(creatorIdMap),
    ...Object.keys(lastVisits),
    ...Object.keys(firstVisits),
  ]);

  for (const u of allUsernames) {
    creators[u] = {
      first_visit_date: firstVisits[u] || null,
      last_visit_date:  lastVisits[u]  || null,
      tile_ids: creatorIdMap[u] || [],
    };
  }

  const idCount = Object.values(creators).reduce((s, c) => s + c.tile_ids.filter(t => t.downloaded).length, 0) + orphaned.length;
  const settingsOut = await chrome.storage.local.get(SETTINGS_KEY);

  const payload = {
    format: 'redgifsBulkBackup',
    version: 3,
    exportedAt: new Date().toISOString(),
    idCount,
    creators,
    orphaned,
    settings: settingsOut[SETTINGS_KEY] || null,
  };

  downloadTextFile(
    `redgifs-backup-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify(payload, null, 2)
  );
  show(`Exported ${idCount} IDs, ${allUsernames.size} creator entries.`);
}

function parseBackupFile(parsed) {
  const extractSettings = p => (p.settings && typeof p.settings === 'object') ? p.settings : null;

  // Normalize a raw creators map into { username: { first_visit_date, last_visit_date, tile_ids } }.
  // Accepts new-format objects (with tile_ids) or old plain-array values (v1.3.0 transitional).
  // legacyLastVisits is folded in as last_visit_date when values are plain arrays.
  function normalizeCreators(raw, legacyLastVisits) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const result = {};
    for (const [u, val] of Object.entries(raw)) {
      if (typeof u !== 'string') continue;
      if (Array.isArray(val)) {
        // Legacy plain string array (pre-v1.4) — all were downloaded
        result[u] = {
          first_visit_date: null,
          last_visit_date: legacyLastVisits?.[u] || null,
          tile_ids: val.filter(x => typeof x === 'string' && x.length > 0)
                       .map(x => ({ tile_id: x, downloaded: true })),
        };
      } else if (val && typeof val === 'object' && Array.isArray(val.tile_ids)) {
        const rawTileIds = val.tile_ids;
        let normalizedTileIds;
        if (rawTileIds.length === 0 || typeof rawTileIds[0] === 'string') {
          // v1.3.1 plain string array — all downloaded
          normalizedTileIds = rawTileIds
            .filter(x => typeof x === 'string' && x.length > 0)
            .map(x => ({ tile_id: x, downloaded: true }));
        } else {
          // New format: array of { tile_id, downloaded }
          normalizedTileIds = rawTileIds.filter(x =>
            x && typeof x === 'object' && typeof x.tile_id === 'string' && x.tile_id.length > 0
          );
        }
        result[u] = {
          first_visit_date: typeof val.first_visit_date === 'string' ? val.first_visit_date : null,
          last_visit_date:  typeof val.last_visit_date  === 'string' ? val.last_visit_date  : null,
          tile_ids: normalizedTileIds,
        };
      }
    }
    return result;
  }

  if (parsed?.format === 'redgifsBulkBackup') {
    if (parsed.creators !== undefined || parsed.orphaned !== undefined) {
      const legacyLastVisits = (parsed.creatorVisits && typeof parsed.creatorVisits === 'object')
        ? parsed.creatorVisits : null;
      return {
        creators: normalizeCreators(parsed.creators, legacyLastVisits),
        orphaned: Array.isArray(parsed.orphaned) ? parsed.orphaned : [],
        settings: extractSettings(parsed),
      };
    }
    // Older v3 format with flat ids array
    return {
      creators: {},
      orphaned: Array.isArray(parsed.ids) ? parsed.ids : [],
      settings: extractSettings(parsed),
    };
  }
  // Legacy formats (plain array or { ids: [...] })
  if (Array.isArray(parsed)) return { creators: {}, orphaned: parsed, settings: null };
  if (parsed && Array.isArray(parsed.ids)) return { creators: {}, orphaned: parsed.ids, settings: null };
  return null;
}

async function importFromBackup(backup, mode) {
  const { creators: backupCreators, orphaned: backupOrphaned, settings: backupSettings } = backup;

  // Sanitize backup data and split creator entries into IDs + visit dates
  const cleanCreators = {};
  const backupLastVisits  = {};
  const backupFirstVisits = {};
  for (const [u, entry] of Object.entries(backupCreators)) {
    if (typeof u !== 'string') continue;
    const tileIds = entry?.tile_ids;
    if (Array.isArray(tileIds)) {
      const downloadedTiles = [...new Set(tileIds.filter(t => t.downloaded).map(t => t.tile_id).filter(id => typeof id === 'string' && id.length > 0))];
      const seenTiles = [...new Set(tileIds.filter(t => !t.downloaded).map(t => t.tile_id).filter(id => typeof id === 'string' && id.length > 0))];
      if (downloadedTiles.length || seenTiles.length) cleanCreators[u] = { downloadedTiles, seenTiles };
    }
    if (typeof entry?.last_visit_date  === 'string') backupLastVisits[u]  = entry.last_visit_date;
    if (typeof entry?.first_visit_date === 'string') backupFirstVisits[u] = entry.first_visit_date;
  }
  const cleanOrphaned = [...new Set(backupOrphaned.filter(x => typeof x === 'string' && x.length > 0))];

  const out = await chrome.storage.local.get(DL_V3_INDEX_KEY);
  const existingIdx = out[DL_V3_INDEX_KEY] || {
    version: 3, total: 0, creators: {}, orphaned: { chunks: [], counts: {}, total: 0 },
  };

  if (mode === 'merge') {
    show('Merging…');

    // Load existing creator objects (needed to detect 0 vs 1 for upgrade logic)
    const existingCreatorObjects = {};
    const existingCreatorKeys = Object.keys(existingIdx.creators || {}).map(u => DL_V3_CREATOR_PREFIX + u);
    if (existingCreatorKeys.length) {
      const creatorData = await chrome.storage.local.get(existingCreatorKeys);
      for (const u of Object.keys(existingIdx.creators || {})) {
        existingCreatorObjects[u] = creatorData[DL_V3_CREATOR_PREFIX + u] || {};
      }
    }

    // Build global existing-ID set for dedup (all creator + orphan IDs)
    const existingIds = new Set();
    for (const obj of Object.values(existingCreatorObjects)) {
      for (const id of Object.keys(obj)) existingIds.add(id);
    }

    const existingOrphanChunks = existingIdx.orphaned?.chunks || [];
    if (existingOrphanChunks.length) {
      const chunksData = await chrome.storage.local.get(existingOrphanChunks);
      for (const key of existingOrphanChunks) {
        const obj = chunksData[key] || {};
        for (const id of Object.keys(obj)) existingIds.add(id);
      }
    }

    const addedIds = new Set(); // cross-creator dedup within this import
    let totalNew = 0;
    let totalDups = 0;
    const updatedCreators = { ...(existingIdx.creators || {}) };

    // Merge creator IDs into their per-creator storage keys
    for (const [username, { downloadedTiles, seenTiles }] of Object.entries(cleanCreators)) {
      const creatorKey = DL_V3_CREATOR_PREFIX + username;
      const existingCreatorObj = existingCreatorObjects[username] || {};
      const creatorObj = Object.assign(Object.create(null), existingCreatorObj);
      let newCount = 0;
      let upgradeCount = 0;
      let modified = false;

      for (const id of downloadedTiles) {
        if (addedIds.has(id)) { totalDups++; continue; }
        if (existingIds.has(id)) {
          if (existingCreatorObj[id] === 0) {
            // Upgrade: seen-only → downloaded
            creatorObj[id] = 1;
            upgradeCount++;
            modified = true;
          } else {
            totalDups++;
          }
          continue;
        }
        creatorObj[id] = 1;
        newCount++;
        modified = true;
        addedIds.add(id);
      }

      for (const id of seenTiles) {
        if (addedIds.has(id) || existingIds.has(id)) continue;
        creatorObj[id] = 0;
        modified = true;
        addedIds.add(id);
      }

      const creatorDownloadedDelta = newCount + upgradeCount;
      if (modified) {
        await chrome.storage.local.set({ [creatorKey]: creatorObj });
      }

      if (updatedCreators[username]) {
        updatedCreators[username] = { ...updatedCreators[username], total: (updatedCreators[username].total || 0) + creatorDownloadedDelta };
      } else {
        updatedCreators[username] = { total: creatorDownloadedDelta };
      }
      totalNew += creatorDownloadedDelta;
    }

    // Merge orphaned IDs into orphan chunks
    const toWriteOrphaned = cleanOrphaned.filter(id => !existingIds.has(id) && !addedIds.has(id));
    totalDups += cleanOrphaned.length - toWriteOrphaned.length;
    totalNew += toWriteOrphaned.length;

    const maxOrphanNum = existingOrphanChunks.reduce((m, k) => {
      const n = parseOrphanChunkNum(k);
      return (n !== null && n > m) ? n : m;
    }, -1);

    const newOrphanChunks = [];
    const newOrphanCounts = {};
    let chunkNum = maxOrphanNum + 1;
    let cur = Object.create(null);
    let curCount = 0;

    const flush = async () => {
      const key = orphanChunkKeyFromNum(chunkNum);
      newOrphanChunks.push(key);
      newOrphanCounts[key] = curCount;
      await chrome.storage.local.set({ [key]: cur });
      chunkNum++;
      cur = Object.create(null);
      curCount = 0;
    };

    for (const id of toWriteOrphaned) {
      cur[id] = 1;
      curCount++;
      if (curCount >= DL_V3_ORPHAN_CHUNK_SIZE) await flush();
    }
    if (curCount > 0) await flush();

    const indexModified = totalNew > 0 || Object.keys(updatedCreators).some(u => !existingIdx.creators[u]);
    if (indexModified) {
      const allOrphanChunks = [...existingOrphanChunks, ...newOrphanChunks];
      const allOrphanCounts = { ...(existingIdx.orphaned?.counts || {}), ...newOrphanCounts };
      await chrome.storage.local.set({
        [DL_V3_INDEX_KEY]: {
          version: 3,
          total: (existingIdx.total || 0) + totalNew,
          creators: updatedCreators,
          orphaned: {
            chunks: allOrphanChunks,
            counts: allOrphanCounts,
            total: (existingIdx.orphaned?.total || 0) + toWriteOrphaned.length,
          },
        },
      });
    }

    // Creator visits: last_visit_date → keep later; first_visit_date → keep earlier
    const visitsData = await chrome.storage.local.get([CREATOR_VISITS_KEY, CREATOR_FIRST_VISITS_KEY]);
    const existingLastVisits  = visitsData[CREATOR_VISITS_KEY]       || {};
    const existingFirstVisits = visitsData[CREATOR_FIRST_VISITS_KEY] || {};

    for (const [username, date] of Object.entries(backupLastVisits)) {
      if (!existingLastVisits[username] || date > existingLastVisits[username])
        existingLastVisits[username] = date;
    }
    for (const [username, date] of Object.entries(backupFirstVisits)) {
      if (!existingFirstVisits[username] || date < existingFirstVisits[username])
        existingFirstVisits[username] = date;
    }
    await chrome.storage.local.set({
      [CREATOR_VISITS_KEY]:       existingLastVisits,
      [CREATOR_FIRST_VISITS_KEY]: existingFirstVisits,
    });

    const grandTotal = (existingIdx.total || 0) + totalNew;
    show(`Merged: ${totalNew} new IDs (${totalDups} dup${totalDups !== 1 ? 's' : ''} skipped). Total: ${grandTotal}.`);
    await loadCount();
    return;
  }

  // Override mode — full restore
  // Write-then-swap: write new data first (orphan chunks with new key numbers, creator keys
  // directly), commit new index, then remove stale old keys.
  show('Restoring…');

  const oldOrphanChunks = existingIdx.orphaned?.chunks || [];
  const maxOldOrphanNum = oldOrphanChunks.reduce((m, k) => {
    const n = parseOrphanChunkNum(k);
    return (n !== null && n > m) ? n : m;
  }, -1);
  const oldCreatorKeys = Object.keys(existingIdx.creators || {}).map(u => DL_V3_CREATOR_PREFIX + u);

  // Write new orphan chunks (after old max num to avoid collision)
  const newOrphanChunks = [];
  const newOrphanCounts = {};
  let orphanTotal = 0;
  let chunkNum = maxOldOrphanNum + 1;
  let cur = Object.create(null);
  let curCount = 0;

  const flush = async () => {
    const key = orphanChunkKeyFromNum(chunkNum);
    newOrphanChunks.push(key);
    newOrphanCounts[key] = curCount;
    await chrome.storage.local.set({ [key]: cur });
    chunkNum++;
    cur = Object.create(null);
    curCount = 0;
  };

  for (const id of cleanOrphaned) {
    cur[id] = 1;
    curCount++;
    orphanTotal++;
    if (curCount >= DL_V3_ORPHAN_CHUNK_SIZE) await flush();
  }
  if (curCount > 0) await flush();

  // Write new creator objects
  const newCreatorEntries = {};
  let creatorTotal = 0;
  for (const [username, { downloadedTiles, seenTiles }] of Object.entries(cleanCreators)) {
    const obj = Object.create(null);
    for (const id of downloadedTiles) obj[id] = 1;
    for (const id of seenTiles) { if (!(id in obj)) obj[id] = 0; }
    await chrome.storage.local.set({ [DL_V3_CREATOR_PREFIX + username]: obj });
    newCreatorEntries[username] = { total: downloadedTiles.length };
    creatorTotal += downloadedTiles.length;
  }

  const total = orphanTotal + creatorTotal;

  // Commit new index
  await chrome.storage.local.set({
    [DL_V3_INDEX_KEY]: {
      version: 3,
      total,
      creators: newCreatorEntries,
      orphaned: { chunks: newOrphanChunks, counts: newOrphanCounts, total: orphanTotal },
    },
  });

  // Remove stale old keys (orphan chunks + creator keys not in new backup)
  const newCreatorKeySet = new Set(Object.keys(cleanCreators).map(u => DL_V3_CREATOR_PREFIX + u));
  const keysToRemove = [
    ...oldOrphanChunks,
    ...oldCreatorKeys.filter(k => !newCreatorKeySet.has(k)),
  ];
  if (keysToRemove.length) {
    try { await chrome.storage.local.remove(keysToRemove); }
    catch (e) { console.warn('[RedgifsOptions] Failed to remove old keys after restore:', e); }
  }

  await chrome.storage.local.set({
    [CREATOR_VISITS_KEY]:       backupLastVisits,
    [CREATOR_FIRST_VISITS_KEY]: backupFirstVisits,
  });

  if (backupSettings) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: backupSettings });
  }

  const visitCount = Object.keys(backupLastVisits).length;
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
  const totalIds = Object.values(backup.creators).reduce((s, c) => s + (c.tile_ids?.length || 0), 0) + backup.orphaned.length;
  if (totalIds > 5_000_000) {
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
