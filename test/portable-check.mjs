import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-portable-qa-'));
const sourceDir = path.join(temp, 'computer-a', 'package');
const movedDir = path.join(temp, 'computer-b', 'package');
const emptyDir = path.join(temp, 'computer-c', 'package');
const exeName = 'Codex-API-Manager.exe';
await fs.mkdir(sourceDir, { recursive: true });
await fs.copyFile(path.resolve('dist/Codex-API-Manager-1.0.20-Windows-x64.exe'), path.join(sourceDir, exeName));
const running = new Set();

async function launch(directory, context) {
  await fs.mkdir(path.join(context, 'roaming'), { recursive: true });
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const env = { ...process.env, CODEX_HOME: path.join(context, 'codex'), LOCALAPPDATA: path.join(context, 'local'), APPDATA: path.join(context, 'roaming') };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CODEX_MANAGER_TEST_DATA;
  delete env.PORTABLE_EXECUTABLE_DIR;
  delete env.PORTABLE_EXECUTABLE_FILE;
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.Path = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0;${process.env.SystemRoot}`;
  const child = spawn(path.join(directory, exeName), [`--remote-debugging-port=${port}`], { env, windowsHide: true, stdio: 'ignore' });
  const handle = { child, exited: false };
  running.add(handle);
  handle.exit = new Promise(resolve => child.once('exit', () => { handle.exited = true; resolve(); }));
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (handle.exited) throw new Error('Portable wrapper exited before desktop startup');
    try { const res = await fetch(`http://127.0.0.1:${port}/json/version`); if (res.ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, 'Portable desktop did not start');
  handle.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  for (let i = 0; i < 100; i++) {
    handle.page = handle.browser.contexts()[0].pages().find(p => p.url().startsWith('file:'));
    if (handle.page) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(handle.page);
  handle.errors = []; handle.page.on('pageerror', error => handle.errors.push(error.message));
  await handle.page.waitForFunction(() => document.querySelector('#current-name').textContent !== '读取中...');
  const state = await handle.page.evaluate(() => window.codexManager.request('state'));
  assert.equal(state.dataDir, path.join(directory, 'data'));
  assert.equal(state.cacheDir, path.join(directory, 'data', 'cache'));
  assert.equal(state.settings.settingsFile, path.join(directory, 'data', 'settings.json'));
  return handle;
}
async function stop(handle) {
  await handle.page.close();
  await Promise.race([handle.exit, new Promise(resolve => setTimeout(resolve, 10000))]);
  assert.ok(handle.exited, 'App should exit after its window closes');
  await handle.browser.close().catch(() => {});
  assert.deepEqual(handle.errors, []);
  running.delete(handle);
}
async function settled(page) { await page.waitForFunction(() => !document.body.classList.contains('busy')); }

try {
  const first = await launch(sourceDir, path.join(temp, 'computer-a'));
  const page = first.page;
  await page.waitForFunction(() => document.querySelector('#count').textContent === '0');
  await page.locator('#settings').click();
  await page.locator('#settings-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#logging-enabled').isChecked(), true);
  await page.locator('#retention-days').selectOption('7');
  await page.locator('#save-settings').click();
  await page.waitForFunction(() => document.querySelector('#settings-notice').textContent === '已保存');
  await page.locator('#close-settings').click();
  await page.locator('#add').click();
  await page.locator('input[name="name"]').fill('QA API');
  await page.locator('input[name="url"]').fill('https://qa.example/v1');
  await page.locator('input[name="key"]').fill('portable-qa-key');
  await page.locator('#profile-form button[type="submit"]').click(); await settled(page);
  await page.locator('.profile .switch-button').click();
  await page.waitForFunction(() => document.querySelector('.profile.active h3')?.textContent === 'QA API');
  await page.locator('#monitor-toggle').check(); await settled(page);
  await page.locator('#monitor-toggle').uncheck(); await settled(page);
  await stop(first);
  const data = path.join(sourceDir, 'data');
  const profiles = await fs.readFile(path.join(data, 'profiles.json'), 'utf8');
  assert.ok(!profiles.includes('portable-qa-key')); assert.ok(profiles.includes('portable-v1:'));
  assert.equal(JSON.parse(await fs.readFile(path.join(data, 'settings.json'), 'utf8')).dataDir, undefined);
  await assert.rejects(fs.access(path.join(temp, 'computer-a', 'roaming', 'codex-api-manager')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(temp, 'computer-a', 'local', 'CodexApiManager')), { code: 'ENOENT' });

  await fs.cp(sourceDir, movedDir, { recursive: true });
  const second = await launch(movedDir, path.join(temp, 'computer-b'));
  await second.page.waitForFunction(() => document.querySelector('#count').textContent === '1');
  const movedState = await second.page.evaluate(() => window.codexManager.request('state'));
  assert.equal(movedState.settings.retentionDays, 7); assert.equal(movedState.canRestore, false);
  await assert.rejects(fs.access(path.join(temp, 'computer-b', 'codex', 'auth.json')), { code: 'ENOENT' });
  await second.page.locator('.profile .switch-button').click();
  await second.page.waitForFunction(() => document.querySelector('.profile.active h3')?.textContent === 'QA API');
  assert.equal(JSON.parse(await fs.readFile(path.join(temp, 'computer-b', 'codex', 'auth.json'), 'utf8')).OPENAI_API_KEY, 'portable-qa-key');
  await second.page.locator('#restore').click(); await settled(second.page);
  await assert.rejects(fs.access(path.join(temp, 'computer-b', 'codex', 'auth.json')), { code: 'ENOENT' });
  await fs.mkdir('test-output', { recursive: true });
  await second.page.screenshot({ path: 'test-output/portable-moved.png', fullPage: true });
  await stop(second);

  await fs.mkdir(emptyDir, { recursive: true });
  await fs.copyFile(path.join(sourceDir, exeName), path.join(emptyDir, exeName));
  const legacyDir = path.join(temp, 'computer-c', 'local', 'CodexApiManager');
  await fs.mkdir(legacyDir, { recursive: true });
  await fs.writeFile(path.join(legacyDir, 'profiles.json'), JSON.stringify({ profiles: [{ name: 'Unrelated legacy', encryptedKey: 'never-import-automatically' }] }));
  const third = await launch(emptyDir, path.join(temp, 'computer-c'));
  await third.page.waitForFunction(() => document.querySelector('#count').textContent === '0');
  assert.equal(await third.page.locator('.profile').count(), 0);
  await third.page.screenshot({ path: 'test-output/portable-empty.png', fullPage: true });
  await stop(third);
  console.log('Portable EXE passed: no Node on PATH, all manager data beside EXE, whole-folder copy preserves keys/settings, fresh EXE starts empty, foreign backups protected, monitoring and undo.');
} finally {
  for (const handle of running) {
    await handle.browser?.close().catch(() => {});
    if (!handle.exited) spawnSync('taskkill.exe', ['/PID', String(handle.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  }
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
