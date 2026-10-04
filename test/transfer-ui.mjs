import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-transfer-ui-'));
const dataRoot = path.join(temp, 'portable', 'data'), home = path.join(temp, 'codex');
const env = { ...process.env, CODEX_HOME: home, CODEX_MANAGER_TEST_DATA: dataRoot, PORTABLE_EXECUTABLE_DIR: path.dirname(dataRoot), LOCALAPPDATA: path.join(temp, 'local'), APPDATA: path.join(temp, 'roaming') };
delete env.ELECTRON_RUN_AS_NODE;
const packaged = process.argv[2];
const app = await electron.launch({ ...(packaged ? { executablePath: path.resolve(packaged), args: [] } : { args: ['.'] }), env });
const errors = [];
async function saveTarget(filePath, canceled = false) { await app.evaluate(({ dialog }, value) => { dialog.showSaveDialog = async () => value; }, { filePath, canceled }); }
async function openTarget(filePath, canceled = false) { await app.evaluate(({ dialog }, value) => { dialog.showOpenDialog = async () => value; }, { filePaths: [filePath], canceled }); }
try {
  const page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  await page.waitForFunction(() => document.querySelector('#count').textContent === '0');
  const profiles = [
    { name: 'Alpha', url: 'https://alpha.example/v1', model: 'gpt-6-sol', effort: 'high', adapter: 'none', key: 'alpha-qa-key' },
    { name: 'Beta', url: 'https://beta.example/v1', model: 'gpt-6-sol', effort: 'high', adapter: 'none', key: 'beta-qa-key' },
  ];
  for (const profile of profiles) assert.equal((await page.evaluate(p => window.codexManager.request('save', p), profile)).ok, true);
  await page.evaluate(() => load());
  const publicFile = path.join(temp, 'public.json'); await saveTarget(publicFile);
  await page.locator('#export-file').click();
  await page.locator('#transfer-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#export-key-warning').isVisible(), true);
  assert.equal(await page.locator('#transfer-count').textContent(), '2 / 2');
  await page.locator('#submit-transfer').click();
  await page.locator('#transfer-dialog').waitFor({ state: 'hidden' });
  const publicBundle = JSON.parse(await fs.readFile(publicFile, 'utf8'));
  assert.equal(publicBundle.profiles.length, 2);
  assert.ok(publicBundle.profiles.every(p => p.key && p.id === undefined));

  const privateFile = path.join(temp, 'private.json'); await saveTarget(privateFile);
  await page.locator('#export-file').click();
  await page.locator('#transfer-list input').nth(1).uncheck();
  assert.equal(await page.locator('#export-key-warning').isVisible(), true);
  await fs.mkdir('test-output', { recursive: true });
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 850 });
    await page.screenshot({ path: `test-output/export-${width}.png`, fullPage: true });
    assert.ok(await page.locator('#transfer-dialog').evaluate(node => node.scrollWidth <= node.clientWidth));
  }
  await page.locator('#submit-transfer').click();
  await page.locator('#transfer-dialog').waitFor({ state: 'hidden' });
  const privateBundle = JSON.parse(await fs.readFile(privateFile, 'utf8'));
  assert.equal(privateBundle.profiles.length, 1);
  assert.equal(privateBundle.profiles[0].key, 'alpha-qa-key');
  await saveTarget(path.join(temp, 'canceled.json'), true);
  await page.locator('#export-file').click(); await page.locator('#submit-transfer').click();
  await page.waitForFunction(() => document.querySelector('#transfer-form').getAttribute('aria-busy') !== 'true');
  assert.equal(await page.locator('#transfer-dialog').isVisible(), true);
  await assert.rejects(fs.access(path.join(temp, 'canceled.json')), { code: 'ENOENT' });
  await page.locator('#cancel-transfer').click();

  const importFile = path.join(temp, 'import.json');
  const imported = { format: publicBundle.format, version: 1, profiles: [
    { ...privateBundle.profiles[0], model: 'new-model', key: 'updated-alpha-key' },
    { ...publicBundle.profiles[1], name: 'Imported API', url: 'https://imported.example/v1', key: 'imported-qa-key' },
  ] };
  await fs.writeFile(importFile, JSON.stringify(imported)); await openTarget(importFile);
  await page.locator('#import-file').click();
  await page.locator('#transfer-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#transfer-list .badge').count(), 1);
  assert.equal(await page.locator('#duplicate-mode').inputValue(), 'skip');
  assert.ok(!(await page.locator('body').textContent()).includes('updated-alpha-key'));
  await page.locator('#transfer-list input').first().uncheck();
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 850 });
    await page.screenshot({ path: `test-output/import-${width}.png`, fullPage: true });
    assert.ok(await page.locator('#transfer-dialog').evaluate(node => node.scrollWidth <= node.clientWidth));
  }
  await page.locator('#submit-transfer').click();
  await page.locator('#transfer-dialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('#count').textContent === '3');
  await assert.rejects(fs.access(path.join(home, 'auth.json')), { code: 'ENOENT' });
  const before = await fs.readFile(path.join(dataRoot, 'profiles.json'), 'utf8');
  assert.ok(!before.includes('imported-qa-key'));
  await page.locator('#import-file').click(); await page.locator('#transfer-dialog').waitFor({ state: 'visible' });
  await page.locator('#submit-transfer').click(); await page.locator('#transfer-dialog').waitFor({ state: 'hidden' });
  assert.equal(await fs.readFile(path.join(dataRoot, 'profiles.json'), 'utf8'), before);
  await page.locator('#import-file').click(); await page.locator('#transfer-dialog').waitFor({ state: 'visible' });
  await page.locator('#duplicate-mode').selectOption('replace');
  await page.locator('#submit-transfer').click(); await page.locator('#transfer-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.profile').count(), 3);
  await page.locator('.profile').filter({ has: page.getByRole('heading', { name: 'Alpha', exact: true }) }).locator('.switch-button').click();
  await page.waitForFunction(() => document.querySelector('.profile.active h3')?.textContent === 'Alpha');
  assert.equal(JSON.parse(await fs.readFile(path.join(home, 'auth.json'), 'utf8')).OPENAI_API_KEY, 'updated-alpha-key');
  const invalid = path.join(temp, 'invalid.json'); await fs.writeFile(invalid, '{"key":"never-show-this-key'); await openTarget(invalid);
  await page.locator('#import-file').click();
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('有效的 JSON'));
  assert.ok(!(await page.locator('#notice').textContent()).includes('never-show-this-key'));
  await openTarget(importFile, true); await page.locator('#import-file').click();
  assert.equal(await page.locator('#transfer-dialog').isVisible(), false);
  const state = await page.evaluate(() => window.codexManager.request('state'));
  assert.ok(!JSON.stringify(state).includes('updated-alpha-key'));
  const logNames = await fs.readdir(path.join(dataRoot, 'logs'));
  const logs = (await Promise.all(logNames.map(name => fs.readFile(path.join(dataRoot, 'logs', name), 'utf8')))).join('');
  assert.ok(!logs.includes('updated-alpha-key') && !logs.includes('imported-qa-key'));
  assert.deepEqual(errors, []);
  console.log('Transfer UI passed: all/selected export with keys, canceled dialogs, selective import with keys, duplicate skip/replace, secret isolation, bad JSON, desktop/tablet/mobile.');
} finally { await app.close(); await fs.rm(temp, { recursive: true, force: true }); }
