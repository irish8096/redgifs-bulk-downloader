// background.js (MV3 service worker)
// Minimal: only handles direct MP4 downloads via chrome.downloads.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'DOWNLOAD_DIRECT') return;

  const { url, filename } = message;
  if (!url || !filename) {
    sendResponse({ success: false, error: 'Missing url or filename' });
    return true;
  }

  chrome.downloads.download(
    {
      url,
      filename,
      conflictAction: 'uniquify',
      saveAs: false
    },
    (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true, downloadId });
      }
    }
  );

  return true; // async response
});