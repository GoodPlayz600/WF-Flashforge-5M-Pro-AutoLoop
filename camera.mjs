export function cameraUrls(ip, reported) {
  const fallback = new URL(`http://${ip}:8080/?action=stream`);
  let stream = fallback;
  try {
    const url = new URL(reported);
    if (url.protocol === 'http:' && url.hostname === ip && ['8080', '8081'].includes(url.port) &&
        !url.username && !url.password) stream = url;
  } catch { /* A firmware can omit the stream URL. */ }
  const snapshot = new URL(stream);
  snapshot.searchParams.set('action', 'snapshot');
  stream = new URL(stream);
  stream.searchParams.set('action', 'stream');
  return [...new Set([snapshot.href, stream.href, fallback.href])];
}

export async function readCameraFrame(source, request = fetch, signal) {
  for (const url of cameraUrls(source.ip, source.reported)) {
    signal?.throwIfAborted();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 2600);
    try {
      const response = await request(url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, abort.signal]) : abort.signal, cache: 'no-store' });
      const type = response.headers.get('content-type') ?? '';
      if (!response.ok || !response.body || !/^(image\/jpeg|multipart\/x-mixed-replace)\b/i.test(type)) {
        await response.body?.cancel();
        continue;
      }
      let buffer = Buffer.alloc(0);
      for await (const part of response.body) {
        buffer = Buffer.concat([buffer, part]);
        if (buffer.length > 5 * 1024 * 1024) break;
        const start = buffer.indexOf(Buffer.from([255, 216]));
        if (start < 0) continue;
        const end = buffer.indexOf(Buffer.from([255, 217]), start + 2);
        if (end >= 0) return buffer.subarray(start, end + 2);
      }
    } catch { /* Try the next camera URL after a timeout or rejected response. */ }
    finally { clearTimeout(timer); abort.abort(); }
  }
  throw Error('No camera frame received. Enable Camera on the printer and refresh the view.');
}

export async function* liveCameraFrames(source, signal, request = fetch) {
  const urls = cameraUrls(source.ip, source.reported);
  for (const url of urls.slice(1)) {
    const connection = new AbortController();
    const upstream = AbortSignal.any([signal, connection.signal]);
    let timeout;
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => connection.abort(), 3000);
    };
    resetTimeout();
    try {
      const response = await request(url, { redirect: 'error', signal: upstream, cache: 'no-store' });
      if (!response.ok || !response.body ||
          !/^multipart\/x-mixed-replace\b/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel();
        continue;
      }

      const startMarker = Buffer.from([255, 216]);
      const endMarker = Buffer.from([255, 217]);
      let buffer = Buffer.alloc(0);
      for await (const part of response.body) {
        buffer = Buffer.concat([buffer, part]);
        let start = buffer.indexOf(startMarker);
        while (start !== -1) {
          const end = buffer.indexOf(endMarker, start + 2);
          if (end === -1) break;
          resetTimeout();
          yield { frame: buffer.subarray(start, end + 2), live: true };
          buffer = buffer.subarray(end + 2);
          start = buffer.indexOf(startMarker);
        }
        buffer = start === -1 ? Buffer.from(buffer.subarray(-1)) : buffer.subarray(start);
        if (buffer.length > 5 * 1024 * 1024) break;
      }
    } catch { /* Try the other stream URL, then snapshots. */ }
    finally {
      clearTimeout(timeout);
      connection.abort();
    }
    if (signal.aborted) return;
  }
}

