import { _electron as electron } from 'playwright';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-monitor-network-'));
const seen = [], streams = [];
const proxy = http.createServer((req, res) => {
  const body = []; req.on('data', chunk => body.push(chunk));
  req.on('end', () => {
    seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(body).toString() });
    if (req.url.includes('gateway')) { res.writeHead(502); res.end('Unknown error'); return; }
    if (req.url.includes('redirect')) { res.writeHead(307, { location: 'http://other.invalid/v1/responses' }); res.end(); return; }
    if (req.url.includes('reset')) { req.socket.destroy(); return; }
    if (req.url.includes('gzip')) {
      const bytes = zlib.gzipSync('data: compressed\n\n');
      res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': bytes.length }); res.end(bytes); return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: first\n\n'); streams.push(res);
  });
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, CODEX_HOME: path.join(temp, 'codex'), CODEX_MANAGER_TEST_DATA: path.join(temp, 'data'), PORTABLE_EXECUTABLE_DIR: temp };
delete env.ELECTRON_RUN_AS_NODE;
const executable = process.argv[2];
const app = await electron.launch({ ...(executable ? { executablePath: path.resolve(executable), args: [] } : { args: ['.'] }), env });
try {
  const page = await app.firstWindow(); await page.waitForFunction(() => document.querySelector('#count').textContent === '0');
  const local = await app.evaluate(async ({ app, session }, { temp, port }) => {
    const root = app.getAppPath();
    const { createMonitorRequester } = process.mainModule.require(root + '/desktop/monitor-transport.cjs');
    const { RequestMonitor } = process.mainModule.require(root + '/monitor.mjs');
    const network = session.fromPartition('monitor-network-test');
    await network.setProxy({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:' + port });
    await network.cookies.set({ url: 'http://upstream.invalid', name: 'private-cookie', value: 'never-forward' });
    const requester = createMonitorRequester(network);
    const monitor = new RequestMonitor({ dataDir: temp }, { requester: (url, opts, cb) => {
      const request = requester(url, opts, cb); request.on('error', error => { app.networkTestError = error.message; }); return request;
    } });
    await monitor.startServer(); monitor.enabled = true;
    monitor.profile = { id: 'fake-id', name: 'Example', url: 'http://upstream.invalid/v1', model: 'test', key: 'fake-upstream-key' };
    app.networkTest = monitor;
    return { url: monitor.localUrl, token: monitor.token };
  }, { temp, port: proxy.address().port });
  const send = (mode = '') => fetch(local.url + '/responses' + (mode ? '?' + mode : ''), {
    method: 'POST', redirect: 'manual', headers: { Authorization: 'Bearer ' + local.token, Cookie: 'local-private-cookie=never-forward', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test', input: 'private-request-body' }),
  });
  const first = await send(); const second = await send();
  assert.equal(first.status, 200, await app.evaluate(({ app }) => app.networkTestError)); assert.equal(second.status, 200);
  assert.equal(await app.evaluate(({ app }) => app.networkTest.summary().active), 2);
  for (const stream of streams.splice(0)) stream.end('data: done\n\n');
  assert.equal(await first.text(), 'data: first\n\ndata: done\n\n'); await second.text();
  const gateway = await send('gateway'); assert.equal(gateway.status, 502); assert.equal(await gateway.text(), 'Unknown error');
  const compressed = await send('gzip'); assert.equal(compressed.status, 200, await app.evaluate(({ app }) => app.networkTestError)); assert.equal(await compressed.text(), 'data: compressed\n\n');
  assert.equal(compressed.headers.get('content-encoding'), null); assert.equal(compressed.headers.get('content-length'), null);
  const abort = new AbortController();
  const canceled = await fetch(local.url + '/responses', { method: 'POST', headers: { Authorization: 'Bearer ' + local.token }, body: JSON.stringify({ input: 'private-request-body' }), signal: abort.signal });
  const reading = canceled.text(); abort.abort(); await assert.rejects(reading);
  for (let i = 0; i < 100 && await app.evaluate(({ app }) => app.networkTest.summary().active); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await app.evaluate(({ app }) => app.networkTest.summary().active), 0);
  assert.ok(await app.evaluate(({ app }) => app.networkTest.summary().recent.some(r => r.label === 'cancelled')));
  const redirect = await send('redirect'); assert.ok([307, 502].includes(redirect.status)); await redirect.text();
  assert.ok(!seen.some(r => r.url.includes('other.invalid')));
  const reset = await send('reset'); assert.equal(reset.status, 502); assert.ok((await reset.text()).includes('Upstream connection failed'));
  for (const r of seen) {
    assert.ok(r.url.startsWith('http://upstream.invalid/v1/responses'));
    assert.equal(r.headers.authorization, 'Bearer fake-upstream-key'); assert.equal(r.headers.cookie, undefined);
    assert.equal(JSON.parse(r.body).input, 'private-request-body');
  }
  const metrics = await app.evaluate(({ app }) => app.networkTest.summary());
  assert.ok(metrics.recent.some(r => r.status === 502 && r.failureSource === 'upstream'));
  assert.ok(metrics.recent.some(r => r.status === 502 && r.failureSource === 'transport'));
  assert.ok(!JSON.stringify(metrics).includes('private-request-body')); assert.ok(!JSON.stringify(metrics).includes('fake-upstream-key'));
  await app.evaluate(async ({ app }) => {
    app.networkTest.enabled = false; app.networkTest.profile = null;
    await app.networkTest.shutdown();
  });
  console.log('Monitor native network passed: system proxy routing, concurrent streaming, gzip, cancellation, exact POST forwarding, cookies excluded, redirects blocked, separate upstream/transport 502 causes.');
} finally {
  for (const stream of streams) stream.destroy();
  await app.close(); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
