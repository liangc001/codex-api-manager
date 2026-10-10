import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-usage-ui-'));
const env = { ...process.env, CODEX_HOME: path.join(temp, 'codex'), CODEX_MANAGER_TEST_DATA: path.join(temp, 'data'), PORTABLE_EXECUTABLE_DIR: temp };
delete env.ELECTRON_RUN_AS_NODE;
let app;
const errors = [];
async function launch() {
  const executable = process.argv[2];
  app = await electron.launch({ ...(executable ? { executablePath: path.resolve(executable), args: [] } : { args: ['.'] }), env });
  const page = await app.firstWindow();
  page.on('pageerror', e => errors.push(e.message));
  await page.waitForFunction(() => document.querySelector('#count').textContent !== '');
  await app.evaluate(({ app }) => {
    const { Manager } = process.mainModule.require(app.getAppPath() + '/core.mjs');
    app.usageCalls = [];
    Manager.prototype.refresh = async function (id) { app.usageCalls.push(id); return { status: 'ok' }; };
  });
  return page;
}
try {
  let page = await launch();
  await page.locator('#close-guide').click();
  for (const [name, adapter, key] of [['Alpha', 'auto', 'fake-alpha-key'], ['Beta', 'auto', 'fake-beta-key'], ['Disabled', 'none', 'fake-disabled-key'], ['No key', 'auto', '']]) {
    await page.evaluate(p => window.codexManager.request('save', p), { name, adapter, key, url: 'https://usage-qa.example/v1', model: 'qa-model', effort: 'high' });
  }
  await page.evaluate(() => load());
  await page.locator('#refresh-all').click();
  assert.equal(await page.locator('#usage-list input:disabled').count(), 2);
  await page.locator('#usage-clear').click();
  assert.equal(await page.locator('#submit-usage').isDisabled(), true);
  await page.locator('#usage-all').check();
  assert.equal(await page.locator('#usage-list input:checked').count(), 2);
  await page.locator('#usage-list input').nth(1).uncheck();
  assert.equal(await page.locator('#usage-all').evaluate(n => n.indeterminate), true);
  const selected = await page.locator('#usage-list input').first().getAttribute('data-id');
  await fs.mkdir('test-output', { recursive: true });
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 850 });
    await page.screenshot({ path: `test-output/usage-${width}.png`, fullPage: true });
    assert.ok(await page.locator('#usage-dialog').evaluate(n => n.scrollWidth <= n.clientWidth));
  }
  await page.locator('#submit-usage').click();
  await page.waitForFunction(() => !document.body.classList.contains('busy'));
  assert.deepEqual(await app.evaluate(({ app }) => app.usageCalls), [selected]);
  const settings = JSON.parse(await fs.readFile(path.join(temp, 'data', 'settings.json'), 'utf8'));
  assert.deepEqual(settings.usageSelection, [selected]);
  assert.ok(!JSON.stringify(settings).includes('fake-alpha-key'));
  // Saving unrelated settings must retain the selection.
  await page.locator('#settings').click();
  await page.locator('#logging-enabled').uncheck();
  await page.locator('#save-settings').click();
  await page.waitForFunction(() => document.querySelector('#settings-notice').textContent === '已保存');
  await page.locator('#close-settings').click();
  await app.close(); app = null;
  page = await launch();
  await page.waitForFunction(() => document.querySelector('#count').textContent === '4');
  await page.locator('#refresh-all').click();
  assert.equal(await page.locator('#usage-list input:checked').count(), 1);
  assert.equal(await page.locator('#usage-list input:checked').getAttribute('data-id'), selected);
  await page.locator('#usage-all').check();
  await page.locator('#cancel-usage').click();
  assert.deepEqual(await app.evaluate(({ app }) => app.usageCalls), []);
  await page.locator('#refresh-all').click();
  assert.equal(await page.locator('#usage-list input:checked').count(), 1);
  assert.deepEqual(errors, []);
  console.log('Usage selection passed: selected-only requests, disabled entries, select/clear, cancel, portable persistence and settings preservation');
} finally {
  await app?.close();
  await fs.rm(temp, { recursive: true, force: true });
}
