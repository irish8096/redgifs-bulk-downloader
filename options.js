const DL_INDEX_KEY = 'downloadedIds_v2_index';
const DL_CHUNK_PREFIX = 'downloadedIds_v2_chunk_';
const SETTINGS_KEY = 'rg_settings_v1';

function show(msg) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(show._t);
  show._t = setTimeout(() => (el.style.display = 'none'), 2000);
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

document.getElementById('refresh').addEventListener('click', async () => {
  await loadCount();
  show('Refreshed.');
});

document.getElementById('clear').addEventListener('click', async () => {
  await clearAllMemory();
  await loadCount();
  show('Memory cleared.');
});

(async () => {
  await loadCount();
  await initDimUI();
})().catch(console.error);