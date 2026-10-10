import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-models-tray-'));
const env = { ...process.env, CODEX_HOME: path.join(temp, 'codex'), CODEX_MANAGER_TEST_DATA: path.join(temp, 'data'), PORTABLE_EXECUTABLE_DIR: temp };
delete env.ELECTRON_RUN_AS_NODE;
const executable = process.argv[2];
const app = await electron.launch({ ...(executable ? { executablePath: path.resolve(executable), args: [] } : { args: ['.'] }), env });
try {
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.waitForFunction(() => document.querySelector('#count').textContent === '0');
  await page.locator('#close-guide').click();
  await app.evaluate(({ app, Tray, dialog }) => {
    const original = Tray.prototype.setContextMenu;
    Tray.prototype.setContextMenu = function(menu) { app.qaMenu = menu; return original.call(this, menu); };
    const { Manager } = process.mainModule.require(app.getAppPath() + '/core.mjs');
    app.modelQA = { delayed: false, fail: false, restarts: 0 };
    const originalModels = Manager.prototype.listModels;
    Manager.prototype.listModels = function(input) {
      return originalModels.call(this, input, async () => {
        if (app.modelQA.delayed) await new Promise(resolve => setTimeout(resolve, 650));
        return app.modelQA.fail ? new Response(null, { status: 403 }) : Response.json({ data: [{ id: 'gpt-6-sol' }, { id: 'qa-fast' }] });
      });
    };
    const service = process.mainModule.require(app.getAppPath() + '/desktop/restart-codex.cjs');
    service.probe = async () => ({ executable: 'C:\\fake\\Codex.exe', running: true });
    service.restart = async () => { app.modelQA.restarts++; return { restarted: true }; };
    dialog.showMessageBox = async () => ({ response: 1 });
  });
  await page.locator('#add').click();
  await page.locator('[name=name]').fill('Alpha');
  await page.locator('[name=url]').fill('https://models-qa.example/v1');
  await page.locator('[name=key]').fill('fake-model-key');
  await page.locator('#query-models').click();
  await page.locator('#model-picker').waitFor({ state: 'visible' });
  await page.locator('#model-list').selectOption('qa-fast');
  assert.equal(await page.locator('[name=model]').inputValue(), 'qa-fast');
  await fs.mkdir('test-output', { recursive: true });
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 850 });
    await page.screenshot({ path: `test-output/models-${width}.png`, fullPage: true });
    assert.ok(await page.locator('#editor').evaluate(n => n.scrollWidth <= n.clientWidth));
  }
  await page.locator('#profile-form [type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#count').textContent === '1');
  await page.evaluate(() => window.codexManager.request('save', { name: 'Beta', url: 'https://models-qa.example/v1', key: 'fake-beta-key', model: 'qa-fast', effort: 'high', adapter: 'none' }));
  await page.evaluate(() => load());
  await page.locator('[title="编辑 Alpha"]').click();
  await page.locator('[name=key]').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('[name=key]').disabled);
  await page.locator('[name=url]').fill('https://changed-qa.example/v1');
  await page.locator('#query-models').click();
  await page.waitForFunction(() => document.querySelector('#model-notice').textContent.includes('重新填写'));
  await page.locator('[name=url]').fill('https://models-qa.example/v1');
  await app.evaluate(({ app }) => { app.modelQA.fail = true; });
  await page.locator('#query-models').click();
  await page.waitForFunction(() => document.querySelector('#model-notice').textContent.includes('权限'));
  assert.equal(await page.locator('[name=model]').inputValue(), 'qa-fast');
  await app.evaluate(({ app }) => { app.modelQA.fail = false; app.modelQA.delayed = true; });
  await page.locator('#query-models').click();
  await page.locator('[name=url]').fill('https://changed-again.example/v1');
  await page.waitForTimeout(800);
  assert.equal(await page.locator('#model-picker').isVisible(), false);
  await page.locator('#cancel-editor').click();
  await page.locator('#hide-to-tray').click();
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  // Invoke the actual native tray menu callback, preserving the shared switch workflow.
  await app.evaluate(({ app }) => app.qaMenu.items.find(i => i.label === '切换 API').submenu.items[0].submenu.items[1].click());
  await page.waitForFunction(() => document.querySelector('#current-name').textContent === 'Beta');
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
  assert.equal(await page.locator('#restart-reminder').isVisible(), true);
  assert.equal(await app.evaluate(({ app }) => app.qaMenu.items.find(i => i.label === '切换 API').submenu.items[0].submenu.items[1].checked), true);
  await app.evaluate(({ app }) => app.qaMenu.items.find(i => i.label === '重启 Codex').click());
  await page.waitForFunction(() => !document.body.classList.contains('busy') && document.querySelector('#restart-reminder').hidden);
  assert.equal(await app.evaluate(({ app }) => app.modelQA.restarts), 1);
  await page.evaluate(() => window.codexManager.request('monitor', { enabled: true }));
  await app.evaluate(({ app, dialog, BrowserWindow }) => {
    dialog.showMessageBox = async (_window, options) => { app.closeQA = options; return { response: 0 }; };
    BrowserWindow.getAllWindows()[0].close();
  });
  await page.waitForTimeout(150);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  assert.equal(await app.evaluate(({ app }) => app.closeQA.defaultId), 0);
  assert.ok(await app.evaluate(({ app }) => app.closeQA.detail.includes('重新打开 Codex')));
  assert.equal((await page.evaluate(() => window.codexManager.request('metrics'))).enabled, true);
  await app.evaluate(({ app }) => app.qaMenu.items.find(i => i.label === '打开主窗口').click());
  await page.evaluate(() => window.codexManager.request('monitor', { enabled: false }));
  const config = await fs.readFile(path.join(temp, 'codex', 'config.toml'), 'utf8');
  assert.ok(config.includes('qa-fast'));
  assert.deepEqual(errors, []);
  console.log('Models and tray UI passed: query/select, failure/manual input, address-key protection, stale queries, tray hide/show/switch and mocked restart');
} finally { await app.close(); await fs.rm(temp, { recursive: true, force: true }); }
