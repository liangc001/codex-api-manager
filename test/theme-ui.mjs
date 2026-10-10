import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-theme-ui-'));
const env = { ...process.env, CODEX_HOME: path.join(temp, 'codex'), CODEX_MANAGER_TEST_DATA: path.join(temp, 'data'), PORTABLE_EXECUTABLE_DIR: temp };
delete env.ELECTRON_RUN_AS_NODE;
const executable = process.argv[2];
const app = await electron.launch({ ...(executable ? { executablePath: path.resolve(executable), args: [] } : { args: ['.'] }), env });
try {
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.waitForFunction(() => document.querySelector('#count').textContent === '0');
  await page.locator('#close-guide').click();
  const appearance = () => page.locator('html').getAttribute('data-theme');
  assert.equal(await appearance(), 'light');
  await page.locator('#settings').click();
  await page.locator('#theme-select').selectOption('dark');
  assert.equal(await appearance(), 'dark');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.locator('#settings').click();
  await page.locator('#theme-select').selectOption('dark');
  await page.locator('#settings-form button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#settings-notice').textContent === '已保存');
  await page.waitForFunction(() => !document.querySelector('#settings-form').hasAttribute('aria-busy'));
  await page.locator('#cancel-settings').click();
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#count').textContent === '0');
  assert.equal(await appearance(), 'dark');
  await fs.mkdir('test-output', { recursive: true });
  await page.screenshot({ path: 'test-output/theme-dark-empty.png' });
  for (const [name, url] of [['日常使用', 'https://provider.example/v1'], ['备用 API', 'https://provider.example/v1'], ['开发环境', 'https://sandbox.example/v1']]) {
    await page.evaluate(p => window.codexManager.request('save', p), { name, url, key: 'fake-test-key', model: 'gpt-6-sol', effort: 'high', adapter: 'none' });
  }
  await page.evaluate(() => load());
  for (const theme of ['light', 'dark']) {
    await page.locator('#settings').click();
    await page.locator('#theme-select').selectOption(theme);
    await page.waitForFunction(() => !document.querySelector('#settings-form').hasAttribute('aria-busy'));
    await page.screenshot({ path: `test-output/theme-${theme}-settings.png` });
    await page.locator('#settings-form button[type=submit]').click();
    await page.waitForFunction(() => document.querySelector('#settings-notice').textContent === '已保存');
    await page.waitForFunction(() => !document.querySelector('#settings-form').hasAttribute('aria-busy'));
    await page.locator('#cancel-settings').click();
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.screenshot({ path: `test-output/theme-${theme}-${width}.png`, fullPage: true });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.locator('#add').click();
    await page.screenshot({ path: `test-output/theme-${theme}-editor.png` });
    await page.locator('#cancel-editor').click();
    await page.locator('#export-file').click();
    await page.screenshot({ path: `test-output/theme-${theme}-export.png` });
    await page.locator('#cancel-transfer').click();
  }
  await app.evaluate(({ app, dialog }) => {
    const service = process.mainModule.require(app.getAppPath() + '/desktop/restart-codex.cjs');
    service.probe = async () => ({ running: true });
    service.restart = async () => ({ restarted: true });
    dialog.showMessageBox = async () => ({ response: 1 });
  });
  await page.locator('.profile').first().locator('.switch-button').click();
  await page.waitForFunction(() => !document.body.classList.contains('busy'));
  await page.locator('#monitor-toggle').check();
  await page.waitForFunction(() => !document.body.classList.contains('busy'));
  await page.screenshot({ path: 'test-output/theme-dark-monitor-reminder.png', fullPage: true });
  await page.locator('#restart-later').click();
  await page.locator('#notice').evaluate(el => el.hidden = true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'test-output/theme-dark-complete.png', fullPage: true });
  await page.locator('#help').click();
  await page.screenshot({ path: 'test-output/theme-dark-guide.png' });
  await page.locator('#close-guide').click();
  await page.locator('#monitor-toggle').uncheck();
  await page.waitForFunction(() => !document.body.classList.contains('busy'));
  await page.locator('#settings').click();
  await page.locator('#theme-select').selectOption('system');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.locator('#settings-form button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#settings-notice').textContent === '已保存');
  await page.locator('#cancel-settings').click();
  assert.equal((await page.evaluate(() => window.codexManager.request('state'))).settings.theme, 'system');
  assert.deepEqual(errors, []);
  console.log('Theme UI passed: preview, cancel/Escape, save/reload, system changes, responsive screens and dialogs');
} finally { await app.close(); await fs.rm(temp, { recursive: true, force: true }); }
