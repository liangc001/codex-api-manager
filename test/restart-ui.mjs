import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-restart-ui-'));
const data = path.join(temp, 'portable', 'data');
const env = { ...process.env, CODEX_HOME: path.join(temp, 'codex'), CODEX_MANAGER_TEST_DATA: data,
  PORTABLE_EXECUTABLE_DIR: path.dirname(data), LOCALAPPDATA: path.join(temp, 'local'), APPDATA: path.join(temp, 'roaming') };
delete env.ELECTRON_RUN_AS_NODE;
const executable = process.argv[2];
const app = await electron.launch({ ...(executable ? { executablePath: path.resolve(executable), args: [] } : { args: ['.'] }), env });
try {
  const page = await app.firstWindow(); const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.waitForFunction(() => document.querySelector('#count').textContent === '0');
  await app.evaluate(({ app, dialog }) => {
    const service = process.mainModule.require(process.mainModule.require('node:path').join(app.getAppPath(), 'desktop', 'restart-codex.cjs'));
    app.restartTest = { count: 0, response: 0, running: true, failure: false, missing: false, dialogs: [] };
    service.probe = async () => {
      if (app.restartTest.missing) throw new Error('未找到 Codex 桌面 App');
      return { executable: 'C:\\fake\\Codex.exe', running: app.restartTest.running };
    };
    service.restart = async target => {
      if (target.executable !== 'C:\\fake\\Codex.exe') throw new Error('Wrong target');
      app.restartTest.count++;
      if (app.restartTest.failure) throw new Error('模拟重启失败');
      await new Promise(resolve => setTimeout(resolve, 100));
      return { restarted: true };
    };
    dialog.showMessageBox = async (_window, options) => {
      app.restartTest.dialogs.push(options);
      return { response: app.restartTest.response };
    };
  });
  const button = page.locator('#restart-codex');
  assert.equal(await button.isVisible(), true);
  assert.equal(await button.getAttribute('title'), '重启 Codex App');
  await button.click();
  await page.waitForFunction(() => !document.body.classList.contains('busy'));
  assert.equal(await app.evaluate(({ app }) => app.restartTest.count), 0);
  assert.ok((await app.evaluate(({ app }) => app.restartTest.dialogs[0].detail)).includes('中断请求'));
  await app.evaluate(({ app }) => { app.restartTest.response = 1; });
  await button.click();
  await page.waitForFunction(() => document.querySelector('#notice').textContent === 'Codex 已重新打开。');
  await page.waitForFunction(() => !document.body.classList.contains('busy'));
  assert.equal(await app.evaluate(({ app }) => app.restartTest.count), 1);
  await app.evaluate(({ app }) => { app.restartTest.running = false; });
  await button.click();
  await page.waitForFunction(() => !document.body.classList.contains('busy'));
  assert.equal(await app.evaluate(({ app }) => app.restartTest.dialogs.at(-1).buttons[1]), '打开');
  await app.evaluate(({ app }) => { app.restartTest.failure = true; });
  await button.click();
  await page.waitForFunction(() => document.querySelector('#notice').textContent === '模拟重启失败');
  await page.waitForFunction(() => !document.body.classList.contains('busy'));
  assert.equal(await button.isEnabled(), true);
  await app.evaluate(({ app }) => { app.restartTest.missing = true; });
  await button.click();
  await page.waitForFunction(() => document.querySelector('#notice').textContent === '未找到 Codex 桌面 App');
  await page.waitForFunction(() => !document.body.classList.contains('busy'));
  await fs.mkdir('test-output', { recursive: true });
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 850 });
    await page.screenshot({ path: `test-output/restart-${width}.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(await button.isVisible(), true);
  }
  const logFiles = await fs.readdir(path.join(data, 'logs'));
  const logs = (await Promise.all(logFiles.map(file => fs.readFile(path.join(data, 'logs', file), 'utf8')))).join('');
  assert.ok(logs.includes('restart-codex'));
  assert.ok(!logs.includes('fake\\\\Codex.exe'));
  await assert.rejects(fs.access(path.join(temp, 'codex', 'auth.json')), { code: 'ENOENT' });
  assert.deepEqual(errors, []);
  console.log('Restart UI passed with mocked lifecycle: confirm/cancel, open, success/error, missing install, safe logs, responsive toolbar.');
} finally {
  await app.close(); await fs.rm(temp, { recursive: true, force: true });
}
