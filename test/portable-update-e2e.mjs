import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';

const source = path.resolve(process.argv[2] || 'dist/Codex-API-Manager.exe');
const replacement = path.resolve(process.argv[3] || 'dist/Codex-API-Manager-1.0.25-Windows-x64.exe');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'manager portable update & quote-'));
const target = path.join(temp, "renamed manager's app.exe");
const home = path.join(temp, 'codex'), data = path.join(temp, 'data');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function port() {
  const server = net.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const value = server.address().port; await new Promise(r => server.close(r)); return value;
}
async function until(fn, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn().catch(() => null); if (value) return value; await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Portable update test timed out');
}
let child, browser, socket;
try {
  await fs.copyFile(source, target);
  const mainPort = await port(), browserPort = await port();
  const env = { ...process.env, CODEX_HOME: home, CODEX_MANAGER_TEST_DATA: data }; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(target, [`--inspect=127.0.0.1:${mainPort}`, `--remote-debugging-port=${browserPort}`], { env, stdio: 'ignore', windowsHide: true });
  const closed = new Promise(resolve => child.once('exit', resolve));
  const endpoints = await until(async () => (await (await fetch(`http://127.0.0.1:${mainPort}/json/list`)).json()));
  await until(async () => (await (await fetch(`http://127.0.0.1:${browserPort}/json/version`)).json()));
  socket = new WebSocket(endpoints[0].webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  const expression = `(() => {
    const req = process.mainModule.require, app = req('electron').app, fs = req('node:fs');
    const { Updater } = req(app.getAppPath() + '/updater.mjs');
    Updater.prototype.check = async function () {
      const bytes = fs.readFileSync(${JSON.stringify(replacement)});
      this.release = { version: '1.0.25', url: 'https://github.com/liangc001/codex-api-manager/releases/download/v1.0.25/Codex-API-Manager-1.0.25-Windows-x64.exe', size: bytes.length, digest: req('node:crypto').createHash('sha256').update(bytes).digest('hex') };
      this.fetcher = async () => new Response(bytes);
      this.status.phase = 'available'; this.status.latestVersion = this.release.version; return this.state();
    }; return true;
  })()`;
  const evaluated = new Promise(resolve => socket.addEventListener('message', event => { const result = JSON.parse(event.data); if (result.id === 1) resolve(result); }));
  socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  assert.equal((await evaluated).result.exceptionDetails, undefined); socket.close();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${browserPort}`);
  const page = browser.contexts()[0].pages()[0];
  await page.waitForFunction(() => document.querySelector('#count').textContent === '0');
  await page.locator('#close-guide').click();
  await page.evaluate(async () => {
    await window.codexManager.request('save', { name: 'Portable update QA', url: 'https://portable-update.example/v1', key: 'fake-portable-key', model: 'qa-model', effort: 'high', adapter: 'none' });
    const state = await window.codexManager.request('state');
    await window.codexManager.request('switch', { id: state.profiles[0].id });
    await window.codexManager.request('monitor', { enabled: true });
    await load();
  });
  const profilesHash = hash(await fs.readFile(path.join(data, 'profiles.json')));
  await page.locator('#settings').click(); await page.locator('#check-update').click();
  await page.locator('#close-settings').click();
  await page.locator('#install-update').click(); await closed;
  await browser.close().catch(() => {}); browser = null;
  const expected = hash(await fs.readFile(replacement));
  await until(async () => hash(await fs.readFile(target)) === expected);
  await until(async () => {
    const names = await fs.readdir(path.join(data, 'logs')); let startups = 0;
    for (const name of names.filter(n => n.endsWith('.jsonl'))) {
      for (const line of (await fs.readFile(path.join(data, 'logs', name), 'utf8')).trim().split('\n')) if (JSON.parse(line).event === 'startup') startups++;
    }
    return startups >= 2;
  });
  assert.equal(hash(await fs.readFile(path.join(data, 'profiles.json'))), profilesHash);
  assert.ok((await fs.readFile(path.join(home, 'config.toml'), 'utf8')).includes('portable-update.example'));
  assert.ok(!(await fs.readFile(path.join(home, 'config.toml'), 'utf8')).includes('127.0.0.1'));
  assert.equal(JSON.parse(await fs.readFile(path.join(home, 'auth.json'), 'utf8')).OPENAI_API_KEY, 'fake-portable-key');
  console.log('Portable EXE update passed: real download verification, helper handshake, exit, replacement at renamed path, restart, restored monitor and preserved profiles');
} finally {
  socket?.close(); await browser?.close().catch(() => {});
  // End only processes owned by this temporary portable checkout, including its launcher descendants.
  const cleanup = `$target = $env:MANAGER_TEST_TARGET; $all = @(Get-CimInstance Win32_Process); $owned = @($all | Where-Object { $_.ExecutablePath -eq $target } | Select-Object -ExpandProperty ProcessId); do { $before = $owned.Count; $owned += @($all | Where-Object { $_.ParentProcessId -in $owned -and $_.ProcessId -notin $owned } | Select-Object -ExpandProperty ProcessId) } while ($owned.Count -gt $before); foreach ($id in $owned) { Stop-Process -Id $id -ErrorAction SilentlyContinue }`;
  execFileSync(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(cleanup, 'utf16le').toString('base64')], { env: { ...process.env, MANAGER_TEST_TARGET: target }, windowsHide: true, stdio: 'ignore' });
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
}
