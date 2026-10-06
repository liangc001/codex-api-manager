const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

// Use Chromium's system proxy/PAC and TLS stack; never share the UI's cookies or disk cache.
function createMonitorRequester(networkSession) {
  return (url, options, onResponse) => {
    const request = new EventEmitter();
    const controller = new AbortController();
    let responseStream, timer, timeoutMs, onTimeout, destroyed = false;
    const touch = () => {
      clearTimeout(timer);
      if (timeoutMs && !destroyed) timer = setTimeout(() => onTimeout(), timeoutMs);
    };
    request.setTimeout = (milliseconds, callback) => { timeoutMs = milliseconds; onTimeout = callback; touch(); return request; };
    request.destroy = () => {
      if (destroyed) return;
      destroyed = true; clearTimeout(timer); controller.abort(); responseStream?.destroy();
      if (!responseStream) queueMicrotask(() => request.emit('error', new Error('Monitor request aborted')));
    };
    request.end = body => {
      (async () => {
        try {
          const headers = { ...options.headers };
          // Chromium computes length and may transparently decode the response.
          delete headers['content-length'];
          delete headers['accept-encoding'];
          for (const name of Object.keys(headers)) if (name.toLowerCase().startsWith('sec-fetch-')) delete headers[name];
          const response = await networkSession.fetch(url.href, {
            method: options.method, headers, body: body?.length ? body : undefined,
            credentials: 'omit', redirect: 'manual', cache: 'no-store',
            bypassCustomProtocolHandlers: true, signal: controller.signal,
          });
          if (destroyed) { await response.body?.cancel(); return; }
          responseStream = response.body ? Readable.fromWeb(response.body) : Readable.from([]);
          responseStream.statusCode = response.status;
          responseStream.headers = Object.fromEntries(response.headers.entries());
          delete responseStream.headers['content-encoding'];
          delete responseStream.headers['content-length'];
          touch();
          responseStream.on('data', touch);
          responseStream.on('end', () => clearTimeout(timer));
          responseStream.on('close', () => clearTimeout(timer));
          onResponse(responseStream);
        } catch (error) {
          clearTimeout(timer);
          if (!destroyed) request.emit('error', error);
        }
      })();
      return request;
    };
    return request;
  };
}

module.exports = { createMonitorRequester };
