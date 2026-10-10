import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-quit-restart-failure-'));
const env = { ...process.env, CODEX_HOME: path.join(temp, 'codex'), CODEX_MANAGER_TEST_DATA: path.join(temp, 'data'), PORTABLE_EXECUTABLE_DIR: temp };
delete env.ELECTRON_RUN_AS_NODE;
const executable = process.argv[2];
const app = await electron.launch({ ...(executable ? { executablePath: path.resolve(executable), args: [] } : { args: ['.'] }), env });
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => document.querySelector('#count').textContent === '0');
  await page.locator('#close-guide').click();
  await page.evaluate(() => window.codexManager.request('save', { name: 'QA', url: 'https://quit-qa.example/v1', key: 'fake-qa-key', model: 'qa-model', effort: 'high', adapter: 'none' }));
  const state = await page.evaluate(() => window.codexManager.request('state'));
  await page.evaluate(id => window.codexManager.request('switch', { id }), state.profiles[0].id);
  await page.evaluate(() => window.codexManager.request('monitor', { enabled: true }));
  await page.evaluate(() => load());
  await app.evaluate(({ app, dialog, BrowserWindow }) => {
    const service = process.mainModule.require(app.getAppPath() + '/desktop/restart-codex.cjs');
    service.probe = async () => ({ running: true });
    service.restart = async () => { throw new Error('fake-private-restart-failure'); };
    app.failureShown = false;
    dialog.showMessageBox = async (_window, options) => {
      if (options.title === '监控已自动关闭') return { response: 0 };
      if (options.title === '监控已关闭') { app.failureShown = true; return { response: 0 }; }
      return { response: 1 };
    };
    BrowserWindow.getAllWindows()[0].close();
  });
  await page.waitForFunction(() => document.querySelector('#connection-status').textContent === '直连 · 待重启');
  assert.equal(await app.evaluate(({ app }) => app.failureShown), true);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()), 'Codex API 管理');
  assert.equal((await page.evaluate(() => window.codexManager.request('metrics'))).enabled, false);
  assert.ok(!(await fs.readFile(path.join(temp, 'codex', 'config.toml'), 'utf8')).includes('127.0.0.1'));
  assert.equal(JSON.parse(await fs.readFile(path.join(temp, 'codex', 'auth.json'), 'utf8')).OPENAI_API_KEY, 'fake-qa-key');
  console.log('Quit restart failure passed: direct config/key preserved, visible normal window, pending restart state, retryable exit');
} finally { await app.close(); await fs.rm(temp, { recursive: true, force: true }); }
