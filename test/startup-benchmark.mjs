import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';

const exe = path.resolve(process.argv[2] || 'dist-public-1.0.52/Codex-API-Manager.exe');
const password = process.env.API_SWITCHBOARD_QA_UNLOCK_PASSWORD;
if (!password) throw new Error('Set API_SWITCHBOARD_QA_UNLOCK_PASSWORD for the isolated startup measurement.');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-startup-'));
const target = path.join(root, 'Switchboard.exe');
await fs.copyFile(exe, target);
const env = { ...process.env, CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude') };
delete env.ELECTRON_RUN_AS_NODE; delete env.API_SWITCHBOARD_QA_UNLOCK_PASSWORD;
const results = [];
async function unusedPort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function until(check, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check().catch(() => null);
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('Isolated launch measurement timed out.');
}
let child, browser;
try {
  for (let i = 0; i < 3; i++) {
    const port = await unusedPort(), mainPort = await unusedPort(), started = performance.now();
    child = spawn(target, ['--remote-debugging-port=' + port, '--inspect=127.0.0.1:' + mainPort], { env, stdio: 'ignore', windowsHide: true });
    const exited = new Promise(resolve => child.once('exit', resolve));
    await until(async () => (await fetch('http://127.0.0.1:' + port + '/json/version')).ok);
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
    let page = await until(async () => browser.contexts()[0]?.pages().find(p => /\/(?:unlock|index)\.html$/.test(p.url())));
    let unlockMs;
    if (/\/unlock\.html$/.test(page.url())) {
      await page.locator('#unlock-form').waitFor();
      unlockMs = Math.round(performance.now() - started);
      await page.locator('#startup-password').fill(password);
      await page.locator('#unlock-submit').click();
      page = await until(async () => browser.contexts()[0]?.pages().find(p => /\/index\.html$/.test(p.url())));
    }
    await page.waitForFunction(() => document.querySelector('#count')?.textContent === '0');
    const readyMs = Math.round(performance.now() - started);
    results.push({ run: i + 1, ...(unlockMs ? { unlockMs } : {}), readyMs });
    console.log(JSON.stringify(results.at(-1)));
    if (await page.locator('#quick-guide').isVisible()) await page.locator('#close-guide').click();
    if (i === 0) {
      const settings = await page.evaluate(() => window.codexManager.request('state'));
      await page.evaluate(async settings => {
        await window.codexManager.request('settings', { ...settings, autoUpdates: false });
      }, settings.settings);
    }
    const debuggerPages = await (await fetch('http://127.0.0.1:' + mainPort + '/json/list')).json();
    const socket = new WebSocket(debuggerPages[0].webSocketDebuggerUrl);
    await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: "process.mainModule.require('electron').app.quit()" } }));
    socket.close();
    await Promise.race([exited, new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Isolated application did not exit.')), 20000).unref();
    })]);
    await browser.close(); browser = null;
    child = null;
  }
  assert.equal(results.length, 3);
  console.log(JSON.stringify({ executable: path.basename(exe), results }));
} finally {
  await browser?.close().catch(() => {});
  child?.kill();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
