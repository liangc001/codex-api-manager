import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const oldExe = path.resolve(process.argv[2] || 'dist/Codex-API-Manager.exe');
const newExe = path.resolve(process.argv[3] || 'dist-public-1.0.52/Codex-API-Manager.exe');
const oldRuntime = path.resolve(process.argv[4] || 'dist/win-unpacked/Codex API Manager.exe');
const newRuntime = path.resolve(process.argv[5] || 'dist-public-1.0.52/win-unpacked/Codex API Manager.exe');
const password = process.env.API_SWITCHBOARD_QA_UNLOCK_PASSWORD;
if (!password) throw new Error('Supply the startup password in API_SWITCHBOARD_QA_UNLOCK_PASSWORD.');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-update-access-'));
const target = path.join(root, 'renamed-switchboard.exe'), data = path.join(root, 'data');
const env = { ...process.env, CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
  CODEX_MANAGER_TEST_DATA: data, PORTABLE_EXECUTABLE_DIR: root, PORTABLE_EXECUTABLE_FILE: target };
delete env.ELECTRON_RUN_AS_NODE;
delete env.API_SWITCHBOARD_QA_UNLOCK_PASSWORD;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
let app;
async function until(check) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const result = await check().catch(() => false);
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Isolated update did not finish in time.');
}
function stopTestCopy() {
  const script = String.raw`
    $all = @(Get-CimInstance Win32_Process)
    $owned = @($all | Where-Object { $_.ExecutablePath -eq $env:SWITCHBOARD_QA_EXE } | Select-Object -ExpandProperty ProcessId)
    do {
      $before = $owned.Count
      $owned += @($all | Where-Object { $_.ParentProcessId -in $owned -and $_.ProcessId -notin $owned } | Select-Object -ExpandProperty ProcessId)
    } while ($owned.Count -gt $before)
    foreach ($pidToStop in $owned) { Stop-Process -Id $pidToStop -ErrorAction SilentlyContinue }
  `;
  execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env: { ...process.env, SWITCHBOARD_QA_EXE: target }, windowsHide: true, stdio: 'ignore' });
}
try {
  await fs.copyFile(oldExe, target);
  app = await electron.launch({ executablePath: oldRuntime, env, timeout: 60000 });
  const page = await app.firstWindow();
  await page.waitForFunction(() => document.querySelector('#count')?.textContent === '0');
  await page.locator('#close-guide').click();
  await page.evaluate(async () => {
    const profile = await window.codexManager.request('save', { name: 'Update fixture', url: 'https://update.example.invalid/v1',
      key: 'synthetic-update-key', model: 'fixture-model', effort: 'high', adapter: 'none' });
    if (profile.error) throw new Error(profile.error);
    const state = await window.codexManager.request('state');
    await window.codexManager.request('switch', { id: state.profiles[0].id });
    await window.codexManager.request('monitor', { enabled: true });
    await load();
  });
  const before = hash(await fs.readFile(path.join(data, 'profiles.json')));
  const keyBefore = hash(await fs.readFile(path.join(data, 'secrets.key')));
  await app.evaluate(({ app }, replacement) => {
    const req = process.mainModule.require;
    const { Updater } = req(app.getAppPath() + '/updater.mjs');
    Updater.prototype.check = async function() {
      const bytes = req('node:fs').readFileSync(replacement);
      this.release = { version: '1.0.52', url: 'https://github.com/liangc001/codex-api-manager/releases/download/v1.0.52/Codex-API-Manager.exe',
        size: bytes.length, digest: req('node:crypto').createHash('sha256').update(bytes).digest('hex') };
      this.fetcher = async () => new Response(bytes);
      this.status.phase = 'available'; this.status.latestVersion = '1.0.52';
      return this.state();
    };
  }, newExe);
  await page.locator('#settings').click();
  await page.locator('#check-update').click();
  await page.locator('#close-settings').click();
  const closed = app.waitForEvent('close', { timeout: 90000 });
  await page.locator('#install-update').click();
  await closed; app = null;
  const expected = hash(await fs.readFile(newExe));
  await until(async () => hash(await fs.readFile(target)) === expected);
  await until(async () => {
    const updates = path.join(data, 'cache/updates');
    for (const entry of await fs.readdir(updates)) {
      const result = JSON.parse((await fs.readFile(path.join(updates, entry, 'result.json'), 'utf8').catch(() => '{}')).replace(/^\uFEFF/, ''));
      if (result.status === 'installed') return true;
    }
    return false;
  });
  assert.equal(hash(await fs.readFile(path.join(data, 'profiles.json'))), before);
  assert.equal(hash(await fs.readFile(path.join(data, 'secrets.key'))), keyBefore);
  assert.doesNotMatch(await fs.readFile(path.join(root, 'codex/config.toml'), 'utf8'), /127\.0\.0\.1/);
  stopTestCopy();
  app = await electron.launch({ executablePath: newRuntime, env, timeout: 60000 });
  const locked = await app.firstWindow();
  await locked.locator('#unlock-form').waitFor();
  await locked.locator('#startup-password').fill(password);
  await locked.locator('#unlock-submit').click();
  const main = await until(async () => app.windows().find(w => /\/index\.html$/.test(w.url())));
  await main.waitForFunction(() => document.querySelector('#count')?.textContent === '1');
  assert.equal((await main.evaluate(() => window.codexManager.request('login-status'))).remembered, true);
  assert.equal(hash(await fs.readFile(path.join(data, 'secrets.key'))), keyBefore);
  console.log('Real 1.0.51 to 1.0.52 update passed: same EXE path, checksum, helper restart, monitor cleanup, preserved API/key, password unlock and automatic login.');
} finally {
  await app?.close();
  stopTestCopy();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
