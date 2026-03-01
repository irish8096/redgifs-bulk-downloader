// mp4worker.js (module worker) - streaming CHUNK output
// - Parses fMP4 HLS byte-range manifests (#EXT-X-MAP + #EXT-X-BYTERANGE)
// - Requests init + segments from the main thread via FETCH/FETCH_RESULT
// - Strips duplicate ftyp/moov from media segments
// - Streams CHUNK messages back to the main thread (transferable ArrayBuffers)
// - Sends DONE at end (no giant concatenation in worker)

function parseM3u8(manifestText, baseUrl) {
  const lines = manifestText.split('\n').map(l => l.trim()).filter(Boolean);

  let init = null;
  const segments = [];
  let current = null;

  const resolveUrl = (u) => new URL(u, baseUrl).toString();

  for (const line of lines) {
    if (line.startsWith('#EXT-X-MAP:')) {
      const uriMatch = line.match(/URI="([^"]+)"/);
      const brMatch = line.match(/BYTERANGE="([^"]+)"/);
      if (uriMatch) {
        const url = resolveUrl(uriMatch[1]);
        let byteRange = null;
        if (brMatch) {
          const [lenStr, offStr] = brMatch[1].split('@');
          byteRange = { length: parseInt(lenStr, 10), offset: parseInt(offStr, 10) };
        }
        init = { url, byteRange };
      }
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      current = { url: null, byteRange: null };
      continue;
    }

    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const val = line.split(':')[1] || '';
      const [lenStr, offStr] = val.split('@');
      if (current) {
        current.byteRange = {
          length: parseInt(lenStr, 10),
          offset: offStr ? parseInt(offStr, 10) : 0
        };
      }
      continue;
    }

    if (!line.startsWith('#') && current) {
      current.url = resolveUrl(line);
      segments.push(current);
      current = null;
      continue;
    }
  }

  return { init, segments };
}

function readU32BE(u8, off) {
  return ((u8[off] << 24) | (u8[off + 1] << 16) | (u8[off + 2] << 8) | u8[off + 3]) >>> 0;
}

function boxType(u8, off) {
  return String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
}

function stripLeadingFtypMoov(u8) {
  let p = 0;
  while (p + 8 <= u8.length) {
    const size = readU32BE(u8, p);
    if (size < 8 || p + size > u8.length) break;
    const type = boxType(u8, p + 4);
    if (type === 'ftyp' || type === 'moov') {
      p += size;
      continue;
    }
    break;
  }
  return p > 0 ? u8.slice(p) : u8;
}

let nextReqId = 1;
const inflight = new Map(); // reqId -> {resolve,reject}

function requestFetch(url, byteRange) {
  const reqId = nextReqId;
  nextReqId = (nextReqId % 1_000_000) + 1; // B4: wrap to avoid unbounded growth
  postMessage({ type: 'FETCH', reqId, url, byteRange });
  return new Promise((resolve, reject) => inflight.set(reqId, { resolve, reject }));
}

onmessage = async (ev) => {
  const msg = ev.data;

  if (msg?.type === 'FETCH_RESULT') {
    const p = inflight.get(msg.reqId);
    if (!p) return;
    inflight.delete(msg.reqId);
    if (msg.ok) p.resolve(msg.buffer);
    else p.reject(new Error(msg.error || 'Fetch failed'));
    return;
  }

  if (msg?.type !== 'START') return;

  const { videoId, m3u8Url, manifestText } = msg;

  try {
    const { init, segments } = parseM3u8(manifestText, m3u8Url);
    if (!segments.length) throw new Error('No segments found in manifest');

    // INIT chunk (if present)
    if (init?.url) {
      const initBuf = await requestFetch(init.url, init.byteRange || null);
      postMessage({ type: 'CHUNK', videoId, kind: 'init', buffer: initBuf }, [initBuf]);
    }

    // MEDIA chunks
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const buf = await requestFetch(seg.url, seg.byteRange || null);

      const strippedU8 = stripLeadingFtypMoov(new Uint8Array(buf));

      // Make a tight ArrayBuffer for transfer
      const outBuf = strippedU8.buffer.slice(
        strippedU8.byteOffset,
        strippedU8.byteOffset + strippedU8.byteLength
      );

      postMessage({ type: 'CHUNK', videoId, kind: 'media', index: i, buffer: outBuf }, [outBuf]);
    }

    postMessage({ type: 'DONE', videoId });
  } catch (e) {
    postMessage({ type: 'ERROR', videoId, error: String(e?.message || e) });
  }
};