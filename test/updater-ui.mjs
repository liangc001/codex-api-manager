import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-update-ui-'));
const env = { ...process.env, CODEX_HOME: path.join(temp, 'codex'), CODEX_MANAGER_TEST_DATA: path.join(temp, 'data'), PORTABLE_EXECUTABLE_DIR: temp };
delete env.ELECTRON_RUN_AS_NODE;
const executable = process.argv[2];
const app = await electron.launch({ ...(executable ? { executablePath: path.resolve(executable), args: [] } : { args: ['.'] }), env });
try {
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.waitForFunction(() => document.querySelector('#count').textContent === '0');
  await page.locator('#close-guide').click();
  await app.evaluate(async ({ app }) => {
    const { Updater } = process.mainModule.require(app.getAppPath() + '/updater.mjs');
    app.updateQA = { mode: 'available', installs: 0 };
    Updater.prototype.check = async function () {
      this.status = { currentVersion: app.getVersion(), phase: app.updateQA.mode, latestVersion: app.updateQA.mode === 'latest' ? undefined : '1.0.25', canInstall: true, progress: 0 };
      return this.state();
    };
    Updater.prototype.prepare = async function () {
      app.updateQA.installs++;
      this.status.phase = 'downloading'; this.status.progress = 42;
      await new Promise(resolve => setTimeout(resolve, 1400));
      this.status.phase = 'error'; this.status.message = '更新下载或校验失败，旧版本已保留，请重试。';
      throw new Error(this.status.message);
    };
  });
  await page.locator('#settings').click();
  await page.locator('#check-update').click();
  await page.locator('#update-banner').waitFor({ state: 'visible' });
  assert.ok((await page.locator('#update-title').textContent()).includes('1.0.25'));
  await page.locator('#auto-updates').uncheck();
  await page.locator('#save-settings').click();
  await page.waitForFunction(() => document.querySelector('#settings-notice').textContent === '已保存');
  await page.locator('#close-settings').click();
  assert.equal(JSON.parse(await fs.readFile(path.join(temp, 'data', 'settings.json'), 'utf8')).autoUpdates, false);
  for (const width of [1040, 560, 390]) {
    await page.setViewportSize({ width, height: 850 });
    assert.ok(await page.locator('#update-banner').evaluate(n => n.scrollWidth <= n.clientWidth));
  }
  await page.locator('#install-update').click();
  await page.waitForFunction(() => document.querySelector('#install-update').disabled);
  assert.ok((await page.locator('#update-detail').textContent()).includes('42%'));
  await page.waitForFunction(() => !document.querySelector('#install-update').disabled);
  assert.ok((await page.locator('#update-detail').textContent()).includes('旧版本已保留'));
  assert.equal(await app.evaluate(({ app }) => app.updateQA.installs), 1);
  await app.evaluate(({ app }) => { app.updateQA.mode = 'latest'; });
  await page.locator('#settings').click();
  assert.equal(await page.locator('#auto-updates').isChecked(), false);
  await page.locator('#check-update').click();
  await page.waitForFunction(() => document.querySelector('#update-banner').hidden);
  assert.equal(await page.locator('#update-status-text').textContent(), '已是最新版本');
  assert.deepEqual(errors, []);
  await page.locator('#close-settings').click();
  await page.evaluate(async () => {
    await window.codexManager.request('save', { name: 'Update QA', url: 'https://update-qa.example/v1', key: 'fake-update-qa-key', model: 'qa-model', effort: 'high', adapter: 'none' });
    const state = await window.codexManager.request('state');
    await window.codexManager.request('switch', { id: state.profiles[0].id });
    await window.codexManager.request('monitor', { enabled: true });
  });
  await app.evaluate(({ app }, temp) => {
    const { Updater } = process.mainModule.require(app.getAppPath() + '/updater.mjs');
    const fs = process.mainModule.require('node:fs');
    app.updateQA.mode = 'available';
    Updater.prototype.prepare = async function () { this.status.phase = 'installing'; };
    Updater.prototype.launchInstaller = async function () {
      const config = fs.readFileSync(temp + '/codex/config.toml', 'utf8');
      fs.writeFileSync(temp + '/installer-receipt.json', JSON.stringify({ restored: !config.includes('127.0.0.1'), upstream: config.includes('update-qa.example') }));
    };
  }, temp);
  await page.evaluate(() => window.codexManager.request('check-update'));
  const closed = new Promise(resolve => app.once('close', resolve));
  await page.evaluate(() => window.codexManager.request('install-update'));
  await closed;
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(temp, 'installer-receipt.json'), 'utf8')), { restored: true, upstream: true });
  assert.equal(JSON.parse(await fs.readFile(path.join(temp, 'data', 'profiles.json'), 'utf8')).profiles.length, 1);
  console.log('Updater UI and shutdown: banner, settings, progress, safe failure, monitor restoration and preserved profiles passed');
} finally { await app.close(); await fs.rm(temp, { recursive: true, force: true }); }
