import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { parseConfig } from '../core.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-groups-ui-'));
const home = path.join(temp, 'codex'), portable = path.join(temp, 'portable');
const env = { ...process.env, CODEX_HOME: home, CODEX_MANAGER_TEST_DATA: path.join(portable, 'data'),
  PORTABLE_EXECUTABLE_DIR: portable, LOCALAPPDATA: path.join(temp, 'local'), APPDATA: path.join(temp, 'roaming') };
delete env.ELECTRON_RUN_AS_NODE;
const executable = process.argv[2];
const app = await electron.launch({ ...(executable ? { executablePath: path.resolve(executable), args: [] } : { args: ['.'] }), env });
try {
  const page = await app.firstWindow();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => document.querySelector('#count').textContent === '0');
  const url = 'https://shared.example/v1';
  const profiles = [
    { name: 'Account A', url, key: 'qa-key-a' },
    { name: 'Other provider', url: 'https://other.example/v1', key: 'qa-key-other' },
    { name: 'Account B', url: `${url}/`, key: 'qa-key-b' },
  ];
  for (const p of profiles) {
    assert.equal((await page.evaluate(p => window.codexManager.request('save', p),
      { ...p, model: 'gpt-6-sol', effort: 'high', adapter: 'none' })).ok, true);
  }
  await page.evaluate(() => load());
  assert.equal(await page.locator('.profile-group').count(), 2);
  const group = page.locator('.profile-group').first();
  assert.equal(await group.locator('.profile').count(), 2);
  assert.equal(await group.locator('.profile-group-heading h3').textContent(), url);
  assert.equal(await group.locator('.profile-group-count').textContent(), '2 个 API');
  assert.deepEqual(await group.locator('.profile-title h3').allTextContents(), ['Account A', 'Account B']);
  await group.locator('.switch-button').nth(1).click();
  await page.waitForFunction(() => document.querySelector('.profile.active h3')?.textContent === 'Account B');
  assert.equal(JSON.parse(await fs.readFile(path.join(home, 'auth.json'), 'utf8')).OPENAI_API_KEY, 'qa-key-b');
  await fs.appendFile(path.join(home, 'config.toml'), '\n[model_providers.custom]\nbase_url = "https://stale.example/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n');
  await page.evaluate(() => load());
  const sync = page.locator('.profile.active .switch-button');
  assert.equal(await sync.textContent(), '同步');
  assert.equal(await sync.isEnabled(), true);
  await sync.click();
  await page.waitForFunction(() => document.querySelector('.profile.active .switch-button')?.disabled);
  assert.equal(parseConfig(await fs.readFile(path.join(home, 'config.toml'), 'utf8')).model_providers.custom.base_url, url);
  await fs.writeFile(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'qa-key-c' }));
  await page.locator('#import').click();
  await page.waitForFunction(() => document.querySelector('#count').textContent === '4');
  assert.equal(await group.locator('.profile').count(), 3);
  const saved = JSON.parse(await fs.readFile(path.join(portable, 'data', 'profiles.json'), 'utf8'));
  assert.equal(saved.profiles.find(p => p.name === 'Account A').encryptedKey.length > 0, true);
  await group.locator('.switch-button').first().click();
  await page.waitForFunction(() => document.querySelector('.profile.active h3')?.textContent === 'Account A');
  assert.equal(JSON.parse(await fs.readFile(path.join(home, 'auth.json'), 'utf8')).OPENAI_API_KEY, 'qa-key-a');
  await group.locator('.switch-button').nth(1).click();
  await page.waitForFunction(() => document.querySelector('.profile.active h3')?.textContent === 'Account B');
  assert.equal(JSON.parse(await fs.readFile(path.join(home, 'auth.json'), 'utf8')).OPENAI_API_KEY, 'qa-key-b');
  await fs.mkdir('test-output', { recursive: true });
  await group.locator('button[title="编辑 Account A"]').click();
  const keyInput = page.locator('#profile-form input[name="key"]');
  await page.waitForFunction(() => document.querySelector('#profile-form input[name="key"]').value === 'qa-key-a');
  assert.equal(await keyInput.getAttribute('type'), 'password');
  await page.locator('#toggle-key').click();
  assert.equal(await keyInput.getAttribute('type'), 'text');
  await page.locator('#cancel-editor').click();
  assert.equal(await keyInput.inputValue(), '');
  await group.locator('button[title="编辑 Account A"]').click();
  await page.waitForFunction(() => document.querySelector('#profile-form input[name="key"]').value === 'qa-key-a');
  assert.equal(await keyInput.getAttribute('type'), 'password');
  await page.locator('#profile-form input[name="model"]').fill('updated-model');
  await page.locator('#profile-form button[type="submit"]').click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
  assert.equal(await keyInput.inputValue(), '');
  const disk = JSON.parse(await fs.readFile(path.join(portable, 'data', 'profiles.json'), 'utf8'));
  assert.equal(disk.profiles.find(p => p.name === 'Account A').encryptedKey, saved.profiles.find(p => p.name === 'Account A').encryptedKey);
  await group.locator('button[title="编辑 Account A"]').click();
  await page.waitForFunction(() => document.querySelector('#profile-form input[name="key"]').value === 'qa-key-a');
  await page.locator('#profile-form input[name="url"]').fill('https://changed.example/v1');
  await page.locator('#profile-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('重新填写 Key'));
  assert.equal(await page.locator('#editor').isVisible(), true);
  await page.locator('#cancel-editor').click();
  await group.locator('button[title="编辑 Account A"]').click();
  await page.waitForFunction(() => document.querySelector('#profile-form input[name="key"]').value === 'qa-key-a');
  await keyInput.fill('qa-key-a-updated');
  await page.locator('#profile-form button[type="submit"]').click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
  await group.locator('.switch-button').first().click();
  await page.waitForFunction(() => document.querySelector('.profile.active h3')?.textContent === 'Account A');
  assert.equal(JSON.parse(await fs.readFile(path.join(home, 'auth.json'), 'utf8')).OPENAI_API_KEY, 'qa-key-a-updated');
  const state = await page.evaluate(() => window.codexManager.request('state'));
  assert.ok(!JSON.stringify(state).includes('qa-key-'));
  assert.ok((await page.evaluate(() => window.codexManager.request('read-key', { id: 'missing' }))).error);
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 850 });
    await page.screenshot({ path: `test-output/groups-${width}.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    for (const node of await page.locator('.profile-group-heading, .profile').all()) {
      assert.ok(await node.evaluate(node => node.scrollWidth <= node.clientWidth));
    }
  }
  assert.ok(!(await page.locator('body').textContent()).includes('qa-key-'));
  assert.deepEqual(errors, []);
  console.log('URL groups and key editor passed: separate accounts, masked/revealed keys, close clears keys, unchanged keys preserved, URL change guard, changed key switch, desktop/tablet/mobile.');
} finally {
  await app.close();
  await fs.rm(temp, { recursive: true, force: true });
}
