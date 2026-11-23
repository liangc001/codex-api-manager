import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bundle from '../desktop/vpn-bundle.cjs';

const password = process.env.API_SWITCHBOARD_QA_UNLOCK_PASSWORD;
if (!password) throw new Error('Supply the password in API_SWITCHBOARD_QA_UNLOCK_PASSWORD.');
const packaged = process.argv[2] && path.resolve(process.argv[2]);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-bootstrap-'));
const data = path.join(root, 'data'), installed = path.join(data, 'vpn');
const encrypted = path.join(root, 'fixture.enc'), source = path.join(root, 'fixture');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const env = { ...process.env, CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
  CODEX_MANAGER_TEST_DATA: data, PORTABLE_EXECUTABLE_DIR: root, API_SWITCHBOARD_REQUIRE_ACCESS: '1' };
delete env.ELECTRON_RUN_AS_NODE; delete env.API_SWITCHBOARD_QA_UNLOCK_PASSWORD;
let app;
const start = () => electron.launch({ ...(packaged ? { executablePath: packaged, args: [] } : { args: ['.'] }), env });
async function mainPage() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const main = app.windows().find(p => /\/index\.html$/.test(p.url()));
    if (main) { await main.locator('#vpn-controls').waitFor(); return main; }
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error('VPN did not become ready after login.');
}
try {
  if (!packaged) {
    execFileSync(path.resolve('vpn/artifacts/fixture/Switchboard.Vpn.exe'), ['--make-fixture', source], { windowsHide: true, stdio: 'ignore' });
    await fs.mkdir(path.join(source, 'cores'));
    for (const name of ['mihomo.exe', 'sing-box.exe'])
      await fs.writeFile(path.join(source, 'cores', name), 'MZ synthetic fixture: never executed');
    await bundle.packBundle({ source, output: encrypted, password });
    env.API_SWITCHBOARD_TEST_BUNDLE = encrypted;
  } else env.PORTABLE_EXECUTABLE_FILE = packaged;
  app = await start();
  let page = await app.firstWindow();
  await page.locator('#unlock-form').waitFor();
  await assert.rejects(fs.stat(installed), { code: 'ENOENT' });
  await page.locator('#startup-password').fill('wrong');
  await page.locator('#unlock-submit').click();
  await page.locator('#unlock-error').filter({ hasText: '密码不正确' }).waitFor();
  await assert.rejects(fs.stat(installed), { code: 'ENOENT' });
  await page.waitForFunction(() => !document.querySelector('#unlock-submit').disabled);
  await page.locator('#startup-password').fill(password);
  await page.locator('#unlock-submit').click();
  page = await mainPage();
  assert.equal(await page.locator('#vpn-setup').isVisible(), false);
  assert.equal(await page.locator('#vpn-status').textContent(), '未连接');
  assert.equal((await page.evaluate(() => window.codexManager.request('state'))).profiles.length, 0);
  assert.equal(await page.evaluate(() => typeof window.startupAccess), 'undefined');
  const before = new Map();
  for (const folder of ['data', 'cores']) {
    for (const name of await fs.readdir(path.join(installed, folder))) {
      const relative = folder + '/' + name;
      before.set(relative, hash(await fs.readFile(path.join(installed, relative))));
    }
  }
  assert.equal(before.has('data/preferences.json'), false);
  if (!packaged) {
    for (const [file, checksum] of before)
      assert.equal(hash(await fs.readFile(path.join(source, file))), checksum);
  }
  await fs.writeFile(path.join(installed, 'data/clash.protected'), 'user-config-preserved');
  const preserved = await fs.readFile(path.join(installed, 'data/clash.protected'));
  await app.close(); app = null;
  app = await start();
  page = await mainPage();
  assert.equal((await page.evaluate(() => window.codexManager.request('login-status'))).remembered, true);
  assert.deepEqual(await fs.readFile(path.join(installed, 'data/clash.protected')), preserved);
  await app.close(); app = null;
  // Recreate a missing bundled installation using the protected key, without another password prompt.
  assert.equal(path.dirname(installed), data);
  await fs.rm(installed, { recursive: true, force: true });
  app = await start();
  page = await mainPage();
  assert.equal((await page.evaluate(() => window.codexManager.request('login-status'))).remembered, true);
  for (const [file, checksum] of before) assert.equal(hash(await fs.readFile(path.join(installed, file))), checksum);
  assert.equal((await fs.readdir(data)).some(n => n.startsWith('vpn-bootstrap-')), false);
  await app.close(); app = null;

  // A v1.0.52/v1.0.53 remembered login has no resource key: request one password, then install.
  app = await start();
  await mainPage();
  await app.evaluate(async ({ app, safeStorage }, dataDir) => {
    const req = process.mainModule.require, base = app.getAppPath();
    const memory = req(base + '/desktop/access-memory.cjs').createLoginMemory({
      file: req('node:path').join(dataDir, 'cache/startup-access.bin'), safeStorage,
      record: req(base + '/desktop/access-config.cjs'),
    });
    await memory.remember();
  }, data);
  await app.close(); app = null;
  await fs.rm(installed, { recursive: true, force: true });
  app = await start();
  page = await app.firstWindow();
  await page.locator('#unlock-form').waitFor();
  await page.locator('#startup-password').fill(password);
  await page.locator('#unlock-submit').click();
  await mainPage();
  for (const [file, checksum] of before) assert.equal(hash(await fs.readFile(path.join(installed, file))), checksum);
  console.log('Bundled VPN desktop flow passed: empty computer, wrong password, automatic setup, no API distribution, retained existing files, automatic login and old-login migration. No proxy or core was started.');
} catch (error) {
  if (app) console.error('Test windows:', app.windows().map(p => p.url().split(/[?#]/)[0]));
  throw error;
} finally {
  await app?.close();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
