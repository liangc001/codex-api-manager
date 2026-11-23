import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';
import client from '../desktop/vpn-client.cjs';

const run = promisify(execFile);
const executable = path.resolve('vpn/artifacts/fixture/Switchboard.Vpn.exe');
const cores = process.argv[2];
if (!cores) throw new Error('Pass the trusted cores folder as the only argument.');
const listen = port => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => resolve(server));
});
const release = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
async function ports() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const base = 44000 + Math.floor(Math.random() * 400) * 12;
    const servers = [];
    try {
      for (let i = 0; i < 11; i++) servers.push(await listen(base + i));
      return [base, base + 10];
    } catch (e) { if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e; }
    finally { await Promise.all(servers.map(release)); }
  }
  throw new Error('No isolated port range available.');
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-vpn-qa-'));
const home = path.join(temp, 'installed'), portable = path.join(temp, 'fixture'), runtime = path.join(temp, 'runtime');
const [base, relay] = await ports();
const vpn = new client.VpnClient({ executable, home, fixtureArgs: [home, runtime, String(base), String(relay)] });
const hash = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
async function waitUntil(check, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await vpn.call('status');
    if (check(result)) return result;
    await delay(75);
  }
  assert.fail('Timed out: ' + JSON.stringify(vpn.last));
}
try {
  await run(executable, ['--make-fixture', portable], { timeout: 15000 });
  await fs.mkdir(path.join(portable, 'cores'));
  for (const name of ['mihomo.exe', 'sing-box.exe'])
    await fs.copyFile(path.join(cores, name), path.join(portable, 'cores', name));
  for (const name of ['storage', 'latency', 'ranking', 'recovery', 'configuration']) {
    const [testBase, testRelay] = await ports();
    const report = path.join(temp, name + '.json');
    const args = ['--test', name, portable, path.join(temp, name), report, String(testBase), String(testRelay)];
    const result = await run(executable, args, { timeout: 120000 }).catch(e => e);
    const summary = JSON.parse(await fs.readFile(report, 'utf8'));
    assert.ok(!result.code && summary.success, name + ': ' + summary.error);
    console.log(name, summary.results.length, 'checks passed');
  }
  assert.equal((await vpn.call('status')).imported, false);
  await vpn.call('import', { directory: path.join(temp, 'missing') });
  assert.equal((await waitUntil(({ busy }) => !busy)).imported, false);
  await assert.rejects(fs.stat(home), { code: 'ENOENT' });
  const key = path.join(portable, 'data', 'portable.key'), before = await hash(key);
  await vpn.call('import', { directory: portable });
  const configured = await waitUntil(({ imported, busy }) => imported && !busy);
  assert.deepEqual(configured.regions.map(r => r.code).sort(), ['DE', 'US', 'auto']);
  assert.equal(await hash(key), before);
  assert.equal(await hash(path.join(home, 'data', 'portable.key')), before);
  await assert.rejects(vpn.call('import', { directory: portable }));
  await assert.rejects(vpn.call('connect', { mode: 'system' }));
  await assert.rejects(vpn.call('open-codex'));
  await assert.rejects(vpn.call('not-a-command'));

  const occupied = await listen(relay);
  try {
    await vpn.call('connect', { region: 'US' });
    assert.match((await waitUntil(({ busy }) => !busy)).error, /被占用/);
    await assert.rejects(vpn.proxyUrl(), /未回退/);
    assert.equal(occupied.listening, true);
  } finally { await release(occupied); }
  await vpn.call('disconnect');
  await waitUntil(s => s.phase === 'disconnected' && !s.busy);
  assert.equal(await vpn.proxyUrl(), null);

  await vpn.call('connect', { region: 'DE' });
  const mismatch = await waitUntil(({ busy }) => !busy);
  assert.equal(mismatch.connected, false);
  assert.equal(mismatch.phase, 'error');
  await vpn.call('connect', { region: 'US' });
  await vpn.call('cancel-connect');
  assert.match((await waitUntil(({ busy }) => !busy)).error, /已取消/);
  await vpn.call('benchmark');
  await vpn.call('cancel-benchmark');
  await waitUntil(s => !s.rankingBusy);
  await vpn.call('benchmark');
  const ranked = await waitUntil(s => !s.rankingBusy && s.rankings.some(r => r.milliseconds));
  assert.equal(ranked.rankings[0].code, 'US');
  await vpn.call('connect', { region: 'auto' });
  const status = await waitUntil(s => s.connected && !s.busy && s.proxyPort === relay);
  assert.equal(status.country, 'US');
  assert.equal(await vpn.proxyUrl(), 'http://127.0.0.1:' + relay);
  assert.equal((await waitUntil(s => s.latencyMs === 27)).exitIp, '192.0.2.10');
  const diagnostics = await vpn.call('diagnostics');
  assert.equal(diagnostics.exitIp, null);
  assert.equal(diagnostics.regions, null);
  assert.doesNotMatch(JSON.stringify(diagnostics), /portable\.key|\.protected|fixture|mihomo/);
  await vpn.close();
  assert.equal(vpn.child, null);
  assert.equal(await vpn.proxyUrl(), null);
  for (let p = base; p <= relay; p++) await release(await listen(p));
  assert.deepEqual((await fs.readdir(path.join(runtime, 'runtime'))).filter(n => n.startsWith('runtime-')), []);
  console.log('Named Pipe: import, modes, occupied port, strict region, cancellation, ranking, latency, redaction and orderly exit passed');

  const env = { ...process.env, CODEX_HOME: path.join(temp, 'codex'), CLAUDE_CONFIG_DIR: path.join(temp, 'claude'),
    CODEX_MANAGER_TEST_DATA: path.join(temp, 'app-data'), API_SWITCHBOARD_VPN_FIXTURE: '1',
    API_SWITCHBOARD_VPN_TEST_BASE: String(base), API_SWITCHBOARD_VPN_TEST_RELAY: String(relay) };
  delete env.ELECTRON_RUN_AS_NODE;
  const desktop = await electron.launch({ args: ['.'], env });
  try {
    const page = await desktop.firstWindow(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.locator('#close-guide').click();
    await desktop.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, portable);
    await page.locator('#vpn-workspace').waitFor();
    assert.ok(await page.locator('#vpn-workspace').evaluate(node => node.getBoundingClientRect().bottom < innerHeight));
    assert.equal(await page.locator('#vpn-details').isVisible(), false);
    await assert.rejects(fs.stat(path.join(temp, 'app-data', 'vpn-fixture-runtime')), { code: 'ENOENT' });
    await page.locator('#vpn-import').click();
    await page.waitForFunction(() => !document.querySelector('#vpn-controls').hidden || !document.querySelector('#vpn-error').hidden);
    assert.equal(await page.locator('#vpn-error').isVisible(), false, await page.locator('#vpn-error').textContent());
    await page.locator('#vpn-region').selectOption('US');
    await page.locator('#vpn-connect').click();
    await page.waitForFunction(() => document.querySelector('#vpn-status').textContent === '已连接');
    await page.waitForFunction(() => document.querySelector('#vpn-latency').textContent === '27 ms');
    assert.equal(await page.locator('#vpn-scope').textContent(), '应用代理');
    assert.equal(await page.locator('#vpn-exit-ip').textContent(), '192.0.2.10');
    await desktop.evaluate(({ ipcMain, app }) => {
      const key = 'manager:request';
      const handler = ipcMain._invokeHandlers.get(key);
      app.restoreVpnOverview = () => {
        ipcMain.removeHandler(key);
        ipcMain.handle(key, handler);
      };
      ipcMain.removeHandler(key);
      ipcMain.handle(key, (event, route, ...args) => route === 'vpn-overview'
        ? { error: '合成的状态查询失败' } : handler(event, route, ...args));
    });
    await page.locator('#vpn-retry-status').waitFor();
    assert.equal(await page.locator('#vpn-latency').textContent(), '—');
    assert.equal(await page.locator('#vpn-connect').isDisabled(), true);
    await desktop.evaluate(({ app }) => app.restoreVpnOverview());
    await page.locator('#vpn-retry-status').click();
    await page.waitForFunction(() => document.querySelector('#vpn-status').textContent === '已连接');
    assert.equal(await page.locator('#vpn-retry-status').isVisible(), false);
    await page.locator('#vpn-more').click();
    assert.equal(await page.locator('#vpn-more').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#vpn-details #vpn-mode, #vpn-details #vpn-diagnostics').count(), 0);
    await page.locator('#settings').click();
    await page.locator('#settings-tab-vpn').click();
    assert.equal(await page.locator('#save-settings').isVisible(), false);
    await page.locator('#vpn-auto-recover').uncheck();
    await page.locator('#vpn-auto-connect').check();
    await page.waitForFunction(async () => (await window.codexManager.request('vpn-overview', {})).result.autoConnect);
    await page.locator('#vpn-startup').check();
    await page.waitForFunction(async () => (await window.codexManager.request('vpn-overview', {})).result.startWithWindows);
    await page.locator('#cancel-settings').click();
    await page.locator('#vpn-check-sources').click();
    await page.locator('#vpn-notice').filter({ hasText: '线路检测完成。' }).waitFor();
    assert.equal(await page.locator('#vpn-sources div').count(), 3);
    await page.locator('#vpn-rankings summary').click();
    await page.locator('#vpn-benchmark').click();
    await page.locator('#vpn-ranking-list li').first().waitFor();
    await fs.mkdir('test-output', { recursive: true });
    for (const width of [1080, 560, 390]) {
      await page.setViewportSize({ width, height: 720 });
      assert.ok(await page.locator('#vpn-workspace').evaluate(n => n.scrollWidth <= n.clientWidth + 1));
      await page.screenshot({ path: 'test-output/vpn-polish-details-' + width + '.png' });
    }
    await page.locator('#vpn-more').click();
    assert.equal(await page.locator('#vpn-details').isVisible(), false);
    await page.waitForFunction(() => document.querySelector('#vpn-status').textContent === '已连接');
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: 'test-output/vpn-polish-390.png' });
    await page.setViewportSize({ width: 1080, height: 720 });
    await page.screenshot({ path: 'test-output/vpn-polish-1080.png' });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.screenshot({ path: 'test-output/vpn-polish-dark.png' });
    await page.locator('#settings').click();
    await page.locator('#settings-tab-vpn').click();
    await page.locator('#vpn-history-panel summary').click();
    await page.screenshot({ path: 'test-output/vpn-settings-1080.png' });
    await page.setViewportSize({ width: 390, height: 720 });
    assert.ok(await page.locator('.settings-layout').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    assert.ok(await page.locator('#settings-panel-vpn').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    await page.screenshot({ path: 'test-output/vpn-settings-390.png' });
    await page.locator('#vpn-shutdown').click();
    await page.getByText('VPN 服务已停止', { exact: true }).waitFor();
    await page.locator('#cancel-settings').click();
    await page.waitForFunction(() => document.querySelector('#vpn-status').textContent === '服务已停止');
    assert.deepEqual(errors, []);
  } finally { await desktop.close(); }
  await release(await listen(relay));
  console.log('Electron: passive homepage, native picker, status, latency, settings, diagnostics, ranking, responsive layout and orderly stop passed');
} finally {
  await vpn.close();
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
