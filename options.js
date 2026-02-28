const DL_INDEX_KEY = 'downloadedIds_v2_index';
const DL_CHUNK_PREFIX = 'downloadedIds_v2_chunk_';
const DL_CHUNK_SIZE = 5000;

const SETTINGS_KEY = 'rg_settings_v1';

function show(msg) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(show._t);
  show._t = setTimeout(() => (el.style.display = 'none'), 2500);
}

function chunkKeyFromNum(n) {
  return DL_CHUNK_PREFIX + String(n).padStart(4, '0');
}

async function loadIndex() {
  const out = await chrome.storage.local.get(DL_INDEX_KEY);
  return out[DL_INDEX_KEY] || null;
}

async function loadCount() {
  const idx = await loadIndex();
  const count = idx?.total ?? 0;
  document.getElementById('count').textContent = String(count);
}

async function clearAllMemory() {
  const idx = await loadIndex();
  const keysToRemove = [DL_INDEX_KEY];

  if (idx?.chunks?.length) {
    for (const k of idx.chunks) keysToRemove.push(k);
  } else {
    // fallback: remove any keys matching prefix (in case index is missing)
    const all = await chrome.storage.local.get(null);
    for (const k of Object.keys(all)) {
      if (k.startsWith(DL_CHUNK_PREFIX)) keysToRemove.push(k);
    }
  }

  await chrome.storage.local.remove(keysToRemove);
}

async function loadSettings() {
  const out = await chrome.storage.local.get(SETTINGS_KEY);
  return out[SETTINGS_KEY] || { dim: 'high' };
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
  const idx = await loadIndex();
  if (!idx?.chunks?.length) {
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
}

function normalizeImportedIds(parsed) {
  // Accept either:
  // - { ids: [...] }
  // - [ ... ]
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.ids)) return parsed.ids;
  return null;
}

async function importIdsFromList(ids) {
  // De-dupe + sanitize
  const cleaned = [...new Set(ids.filter(x => typeof x === 'string' && x.length > 0))];

  if (!cleaned.length) {
    show('Import file had no usable IDs.');
    return;
  }

  // Clear existing downloaded memory first (explicit overwrite semantics)
  show('Clearing existing memory…');
  await clearAllMemory();

  // Build new chunks + index
  show(`Importing ${cleaned.length} IDs…`);

  const chunks = [];
  const counts = {};
  let total = 0;

  let chunkNum = 0;
  let cur = Object.create(null);
  let curCount = 0;

  const flush = async () => {
    const key = chunkKeyFromNum(chunkNum);
    chunks.push(key);
    counts[key] = curCount;

    // write chunk
    await chrome.storage.local.set({ [key]: cur });

    // reset
    chunkNum++;
    cur = Object.create(null);
    curCount = 0;
  };

  // Write chunks in manageable size; each set writes one chunk object
  for (let i = 0; i < cleaned.length; i++) {
    const id = cleaned[i];
    cur[id] = 1;
    curCount++;
    total++;

    if (curCount >= DL_CHUNK_SIZE) {
      await flush();
      show(`Importing… ${total}/${cleaned.length}`);
    }
  }

  if (curCount > 0) {
    await flush();
  }

  const index = {
    version: 2,
    chunkSize: DL_CHUNK_SIZE,
    chunks,
    counts,
    total
  };

  await chrome.storage.local.set({ [DL_INDEX_KEY]: index });

  show(`Imported ${total} IDs.`);
  await loadCount();
}

async function importIdsFromFile(file) {
  const text = await file.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    show('Import failed: invalid JSON.');
    return;
  }

  const ids = normalizeImportedIds(parsed);
  if (!ids) {
    show('Import failed: expected an array or { ids: [...] }.');
    return;
  }

  await importIdsFromList(ids);
}

// Wire up UI
document.getElementById('refresh').addEventListener('click', async () => {
  await loadCount();
  show('Refreshed.');
});

document.getElementById('clear').addEventListener('click', async () => {
  await clearAllMemory();
  await loadCount();
  show('Memory cleared.');
});

document.getElementById('export').addEventListener('click', async () => {
  try {
    await exportIds();
  } catch (e) {
    console.error(e);
    show('Export failed (see console).');
  }
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

  try {
    await importIdsFromFile(file);
  } catch (e) {
    console.error(e);
    show('Import failed (see console).');
  }
});

(async () => {
  await loadCount();
  await initDimUI();
})().catch(console.error);