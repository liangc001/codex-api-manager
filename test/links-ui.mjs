import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-links-ui-'));
const packaged = process.argv[2] && path.resolve(process.argv[2]);
const password = process.env.API_SWITCHBOARD_QA_UNLOCK_PASSWORD;
if (packaged && !password) throw new Error('Supply API_SWITCHBOARD_QA_UNLOCK_PASSWORD for packaged UI testing.');
const env = { ...process.env, CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
  CODEX_MANAGER_TEST_DATA: path.join(root, 'data'), API_SWITCHBOARD_VPN_FIXTURE: '1' };
if (packaged) { env.PORTABLE_EXECUTABLE_FILE = packaged; env.PORTABLE_EXECUTABLE_DIR = root; }
delete env.ELECTRON_RUN_AS_NODE;
delete env.API_SWITCHBOARD_QA_UNLOCK_PASSWORD;
let app;
async function start() {
  app = await electron.launch({ ...(packaged ? { executablePath: packaged, args: [] } : { args: ['.'] }), env });
  const first = await app.firstWindow();
  await first.locator('#unlock-form, #open-links').first().waitFor();
  if (await first.locator('#unlock-form').count()) {
    await first.locator('#startup-password').fill(password);
    await first.locator('#unlock-submit').click();
  }
  for (let attempt = 0; attempt < 400; attempt++) {
    const main = app.windows().find(page => /\/index\.html$/.test(page.url()));
    if (main) { await main.locator('#open-links').waitFor(); return main; }
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error('Main window did not open.');
}
try {
  const page = await start(), errors = [], externalRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) externalRequests.push(request.url()); });
  await app.evaluate(({ shell }) => { globalThis.linksOpened = []; shell.openExternal = async url => { globalThis.linksOpened.push(url); }; });
  await page.locator('#close-guide').click();
  await page.setViewportSize({ width: 390, height: 850 });
  await page.locator('#quick-links-list .quick-link').first().waitFor();
  assert.equal(await page.locator('#quick-links-list .quick-link').count(), 6);
  assert.ok(await page.locator('body').evaluate(node => node.scrollWidth <= innerWidth + 1));
  assert.equal(await page.locator('#open-links').isVisible(), true);
  await page.screenshot({ path: 'test-output/links-home-390.png' });
  await page.setViewportSize({ width: 1080, height: 850 });
  await page.locator('#open-links').click();
  await page.locator('.link-card').first().waitFor();
  assert.equal(await page.locator('.link-card').count(), 55);
  assert.equal(await page.locator('#links-search').evaluate(node => node === document.activeElement), true);
  await page.locator('#links-dialog .link-card[data-id="chatgpt"] .link-open').click();
  assert.deepEqual(await app.evaluate(() => globalThis.linksOpened), ['https://chatgpt.com/']);
  const rejected = await page.evaluate(() => window.codexManager.request('links-open', { id: 'file:///C:/Windows/notepad.exe' }));
  assert.ok(rejected.error);
  await page.locator('#links-search').fill('linux');
  assert.equal(await page.locator('.link-card').count(), 1);
  await page.locator('#links-search').fill('');
  await page.getByRole('button', { name: '日常工具', exact: true }).click();
  assert.equal(await page.locator('.link-card').count(), 8);
  await page.locator('#links-add').click();
  await page.locator('#link-name').fill('Example fixture');
  await page.locator('#link-url').fill('https://example.invalid/tool');
  await page.locator('#links-form button[type=submit]').click();
  await page.getByRole('link', { name: /Example fixture/ }).waitFor();
  await page.locator('#links-manage').click();
  await page.getByRole('button', { name: '编辑 Example fixture', exact: true }).click();
  await page.locator('#link-name').fill('Renamed fixture');
  await page.locator('#links-form button[type=submit]').click();
  await page.getByRole('button', { name: '移除 Renamed fixture', exact: true }).click();
  await page.getByText('已移除 Renamed fixture', { exact: true }).waitFor();
  await page.locator('#links-undo').click();
  await page.locator('#links-dialog').getByRole('link', { name: /Renamed fixture/ }).waitFor();
  await page.getByRole('button', { name: '固定到首页 Renamed fixture', exact: true }).click();
  await page.getByText('已固定到首页', { exact: true }).waitFor();
  assert.equal(await page.locator('#quick-links-list .quick-link').count(), 7);
  await page.getByRole('button', { name: '从首页取消 Renamed fixture', exact: true }).click();
  await page.getByText('已从首页取消', { exact: true }).waitFor();
  assert.equal(await page.locator('#quick-links-list .quick-link').count(), 6);
  await page.getByRole('button', { name: '固定到首页 Renamed fixture', exact: true }).click();
  await page.getByText('已固定到首页', { exact: true }).waitFor();
  await page.locator('#links-manage').click();
  await page.getByRole('button', { name: '全部', exact: true }).click();
  await fs.mkdir('test-output', { recursive: true });
  for (const [width, theme] of [[1440, 'light'], [768, 'light'], [390, 'light'], [1080, 'dark'], [1080, 'rainbow']]) {
    await page.setViewportSize({ width, height: 850 });
    await page.evaluate(theme => { window.managerTheme.apply(theme); }, theme);
    assert.ok(await page.locator('#links-dialog').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    assert.ok(await page.locator('.links-toolbar').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    await page.screenshot({ path: `test-output/links-${width}-${theme}.png` });
  }
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#links-dialog').evaluate(node => node.open), false);
  await page.locator('#quick-links-list').getByRole('link', { name: /ChatGPT/ }).click();
  assert.equal((await app.evaluate(() => globalThis.linksOpened)).length, 2);
  await app.evaluate(({ shell }) => { shell.openExternal = async () => { throw new Error('synthetic private transport detail'); }; });
  await page.locator('#quick-links-list').getByRole('link', { name: /Gemini/ }).click();
  await page.locator('#notice').filter({ hasText: '无法打开浏览器' }).waitFor();
  assert.ok(!(await page.locator('#notice').textContent()).includes('private transport'));
  await page.setViewportSize({ width: 1080, height: 850 });
  await page.screenshot({ path: 'test-output/links-home-1080.png' });
  await page.locator('#open-links').click();
  await page.locator('#links-dialog').getByRole('link', { name: /Renamed fixture/ }).waitFor();
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  await app.close(); app = null;
  const reopened = await start();
  await reopened.locator('#quick-links-list').getByRole('link', { name: /Renamed fixture/ }).waitFor();
  await reopened.locator('#open-links').click();
  await reopened.locator('#links-dialog').getByRole('link', { name: /Renamed fixture/ }).waitFor();
  console.log('Links UI passed: curated list, safe browser launch, search, categories, add/edit/remove/undo, persistence, themes, responsive layout and no background web requests.');
} finally {
  await app?.close();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
