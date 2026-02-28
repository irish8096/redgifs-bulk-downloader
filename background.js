// background.js (MV3 service worker)
// Supports:
// - DOWNLOAD_DIRECT: normal chrome.downloads.download(url)
// - DOWNLOAD_FETCH: fetch with headers -> blob -> objectURL -> chrome.downloads.download(objectURL)

const activeObjectUrls = new Map(); // downloadId -> objectUrl

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'DOWNLOAD_DIRECT') {
        const { url, filename } = msg;
        const downloadId = await chrome.downloads.download({
          url,
          filename,
          saveAs: false
        });
        sendResponse({ success: true, downloadId });
        return;
      }

      if (msg?.type === 'DOWNLOAD_FETCH') {
        const { url, filename } = msg;

        // Fetch with headers that many CDNs expect
        const res = await fetch(url, {
          method: 'GET',
          // Note: credentials often not required for CDN, but doesn't hurt in same-site scenarios
          credentials: 'include',
          headers: {
            // These help with anti-hotlink checks
            'Referer': 'https://www.redgifs.com/',
            'Origin': 'https://www.redgifs.com',
            'Accept': '*/*'
          }
        });

        if (!res.ok) {
          sendResponse({ success: false, error: `FETCH_HTTP_${res.status}` });
          return;
        }

        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);

        const downloadId = await chrome.downloads.download({
          url: objectUrl,
          filename,
          saveAs: false
        });

        activeObjectUrls.set(downloadId, objectUrl);
        sendResponse({ success: true, downloadId, fetched: true });
        return;
      }

      sendResponse({ success: false, error: 'UNKNOWN_MESSAGE' });
    } catch (e) {
      sendResponse({ success: false, error: String(e?.message || e) });
    }
  })();

  return true; // keep channel open for async sendResponse
});

// Cleanup object URLs after download completes/interupts
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