import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const password = process.env.API_SWITCHBOARD_QA_UNLOCK_PASSWORD;
if (!password) throw new Error('Supply the startup password through API_SWITCHBOARD_QA_UNLOCK_PASSWORD.');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-access-qa-'));
const data = path.join(root, 'data');
const packagedPath = process.argv[2];
const env = { ...process.env, CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
  CODEX_MANAGER_TEST_DATA: data, PORTABLE_EXECUTABLE_DIR: root, API_SWITCHBOARD_REQUIRE_ACCESS: '1' };
if (packagedPath) env.PORTABLE_EXECUTABLE_FILE = path.resolve(packagedPath);
delete env.ELECTRON_RUN_AS_NODE;
delete env.API_SWITCHBOARD_QA_UNLOCK_PASSWORD;
const start = () => electron.launch({ ...(packagedPath ? { executablePath: path.resolve(packagedPath), args: [] } : { args: ['.'] }), env });
let app;
try {
  app = await start();
  const page = await app.firstWindow();
  await page.locator('#unlock-form').waitFor();
  assert.equal(await page.locator('#unlock-form').isVisible(), true);
  assert.equal(await page.evaluate(() => typeof window.codexManager), 'undefined');
  assert.equal(await app.evaluate(({ ipcMain }) => ipcMain._invokeHandlers.has('manager:request')), false);
  for (const file of ['profiles.json', 'claude-profiles.json', 'secrets.key'])
    await assert.rejects(fs.stat(path.join(data, file)), { code: 'ENOENT' });
  const invalidSender = await app.evaluate(async ({ ipcMain }) => ipcMain._invokeHandlers.get('access:unlock')({ sender: {}, senderFrame: {} }, 'not-secret'));
  assert.equal(invalidSender.ok, false);
  await page.locator('#startup-password').fill('not-the-password');
  await page.locator('#unlock-submit').click();
  await page.locator('#unlock-error').filter({ hasText: '密码不正确' }).waitFor();
  assert.equal(await page.locator('#startup-password').inputValue(), '');
  assert.equal(await app.evaluate(({ ipcMain }) => ipcMain._invokeHandlers.has('manager:request')), false);
  await fs.mkdir('test-output', { recursive: true });
  await page.screenshot({ path: 'test-output/startup-access.png' });
  await page.waitForFunction(() => !document.querySelector('#unlock-submit').disabled);
  await page.locator('#startup-password').fill(password);
  await page.locator('#unlock-submit').click();
  let main;
  for (let attempt = 0; attempt < 100; attempt++) {
    main = app.windows().find(w => /\/index\.html$/.test(w.url()));
    if (main) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(main, 'Main window was not created after unlocking.');
  await main.waitForFunction(() => document.querySelector('#count').textContent === '0');
  assert.equal((await main.evaluate(() => window.codexManager.request('state'))).profiles.length, 0);
  assert.equal(await app.evaluate(({ ipcMain }) => ipcMain._invokeHandlers.has('access:unlock')), false);
  if (packagedPath) assert.equal((await main.evaluate(() => window.codexManager.request('update-status'))).canInstall, true);
  assert.equal((await fs.readFile(path.join(data, 'settings.json'), 'utf8')).includes(password), false);
  const loginFile = path.join(data, 'cache', 'startup-access.bin');
  assert.equal((await fs.readFile(loginFile)).includes(Buffer.from(password)), false);
  await app.close(); app = null;
  app = await start();
  const remembered = await app.firstWindow();
  await remembered.locator('#vpn-workspace').waitFor();
  assert.deepEqual(await remembered.evaluate(() => window.codexManager.request('login-status')), { enabled: true, remembered: true });
  await remembered.locator('#settings').click();
  await remembered.locator('#forget-login').click();
  await remembered.getByText('下次启动需输入密码', { exact: true }).waitFor();
  await remembered.locator('#cancel-settings').click();
  await assert.rejects(fs.stat(loginFile), { code: 'ENOENT' });
  await app.close(); app = null;
  app = await start();
  const lockedAgain = await app.firstWindow();
  await lockedAgain.locator('#unlock-form').waitFor();
  assert.equal(await app.evaluate(({ ipcMain }) => ipcMain._invokeHandlers.has('manager:request')), false);
  const closed = app.waitForEvent('close');
  await lockedAgain.close();
  await closed;
  app = null;
  console.log('Startup password: isolated lock window, wrong password, sender validation, deferred initialization, automatic login, clear login and close passed.');
} finally {
  await app?.close();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
