import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-quit-recovery-'));
const home = path.join(temp, 'codex'), portable = path.join(temp, 'portable');
const env = { ...process.env, CODEX_HOME: home, CODEX_MANAGER_TEST_DATA: path.join(portable, 'data'),
  PORTABLE_EXECUTABLE_DIR: portable, LOCALAPPDATA: path.join(temp, 'local'), APPDATA: path.join(temp, 'roaming') };
delete env.ELECTRON_RUN_AS_NODE;
const executable = process.argv[2];
const app = await electron.launch({ ...(executable ? { executablePath: path.resolve(executable), args: [] } : { args: ['.'] }), env });
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => document.querySelector('#count').textContent === '0');
  const saved = await page.evaluate(() => window.codexManager.request('save', {
    name: 'QA', url: 'https://qa.example/v1', key: 'qa-key', model: 'test-model', effort: 'high', adapter: 'none' }));
  assert.equal(saved.ok, true);
  const state = await page.evaluate(() => window.codexManager.request('state'));
  assert.equal((await page.evaluate(id => window.codexManager.request('switch', { id }), state.profiles[0].id)).ok, true);
  assert.equal((await page.evaluate(() => window.codexManager.request('monitor', { enabled: true }))).ok, true);
  const snapshotPath = path.join(portable, 'data', 'monitor-session.json');
  const snapshot = await fs.readFile(snapshotPath, 'utf8');
  await fs.rm(path.join(home, 'auth.json'));
  await fs.mkdir(path.join(home, 'auth.json'));
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async options => {
      if (options.buttons?.[1] !== '保留备份并退出') throw new Error('Missing exit option');
      return { response: 1 };
    };
  });
  await app.close();
  assert.equal(await fs.readFile(snapshotPath, 'utf8'), snapshot);
  console.log('Quit recovery passed: unreadable auth cannot trap the app; explicit exit retains the encrypted recovery snapshot.');
} finally {
  await app.close();
  await fs.rm(temp, { recursive: true, force: true });
}
