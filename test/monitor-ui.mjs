import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Manager } from '../core.mjs';
import { MonitorController } from '../monitor.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-monitor-ui-'));
const codec = { encrypt: async v => Buffer.from(v).toString('base64'), decrypt: async v => Buffer.from(v, 'base64').toString() };
const manager = new Manager({ codexHome: path.join(temp, 'codex'), dataDir: path.join(temp, 'data'), codec });
await manager.init();
await manager.save({ name: 'QA Primary', url: 'https://primary.example/v1', model: 'test-model', effort: 'high', adapter: 'none', key: 'fake-key' });
await manager.save({ name: 'QA Backup', url: 'https://backup.example/v1', model: 'test-model', effort: 'high', adapter: 'none', key: 'fake-key-2' });
await manager.switchTo(manager.store.profiles[0].id);
const streams = [];
const upstream = http.createServer((req, res) => {
  const chunks = []; req.on('data', c => chunks.push(c));
  req.on('end', () => {
    if (JSON.parse(Buffer.concat(chunks)).model === 'limited') { res.writeHead(429); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: running\n\n'); streams.push(res);
  });
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const controller = new MonitorController(manager, { requester: (url, opts, cb) => http.request(`http://127.0.0.1:${upstream.address().port}${url.pathname}`, opts, cb) });
await controller.init();
const assets = { '/': ['public/index.html', 'text/html'], '/app.js': ['public/app.js', 'text/javascript'], '/style.css': ['public/style.css', 'text/css'], '/lucide.js': ['public/lucide.js', 'text/javascript'] };
const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) {
      const route = req.url.slice(5); let result;
      if (route === 'state') result = await controller.state();
      else if (route === 'metrics') result = controller.monitor.summary();
      else if (route === 'monitor') {
        let body = ''; for await (const chunk of req) body += chunk;
        await controller.setMonitoring(JSON.parse(body).enabled); result = { ok: true };
      } else throw new Error('Unsupported test route');
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
    } else {
      const [file, type] = assets[req.url]; res.setHeader('Content-Type', type); res.end(await fs.readFile(file));
    }
  } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('.profile').nth(1).waitFor();
  await page.locator('#monitor-toggle').check();
  await page.waitForFunction(() => !document.body.classList.contains('busy'));
  const send = model => fetch(controller.monitor.localUrl + '/responses', { method: 'POST', headers: { Authorization: `Bearer ${controller.monitor.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, input: 'not logged' }) });
  const responses = await Promise.all([send('test-model'), send('test-model')]);
  const limited = await send('limited'); await limited.text();
  await page.waitForFunction(() => document.querySelector('#monitor-stats .metric strong').textContent === '2');
  assert.equal(controller.monitor.summary().limited, 1);
  await page.locator('#request-details summary').click();
  await page.waitForFunction(() => document.querySelector('#request-count').textContent === '3');
  await fs.mkdir('test-output', { recursive: true });
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`);
    await page.screenshot({ path: `test-output/monitor-${width}.png`, fullPage: true });
  }
  for (const stream of streams) stream.end('data: done\n\n');
  await Promise.all(responses.map(r => r.text()));
  await page.waitForFunction(() => document.querySelector('#monitor-stats .metric strong').textContent === '0');
  await page.locator('#monitor-toggle').uncheck();
  await page.waitForFunction(() => !document.body.classList.contains('busy'));
  assert.deepEqual(errors, []);
  console.log('Monitoring UI passed: live concurrent streams, HTTP 429, completion, toggles, request table, desktop/tablet/mobile.');
} finally {
  for (const stream of streams) stream.end();
  await browser.close(); await controller.monitor.shutdown();
  upstream.closeAllConnections(); server.closeAllConnections();
  await Promise.all([new Promise(r => upstream.close(r)), new Promise(r => server.close(r))]);
  await fs.rm(temp, { recursive: true, force: true });
}
