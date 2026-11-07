import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-session-ui-'));
const env = { ...process.env, CODEX_HOME: path.join(temp, 'codex'), CODEX_MANAGER_TEST_DATA: path.join(temp, 'data'), PORTABLE_EXECUTABLE_DIR: temp };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ ...(process.argv[2] ? { executablePath: path.resolve(process.argv[2]), args: [] } : { args: ['.'] }), env });
try {
  const page = await app.firstWindow(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.waitForFunction(() => document.querySelector('#count').textContent === '0');
  await page.locator('#close-guide').click();
  await app.evaluate(async ({ app }) => {
    const { DatabaseSync } = process.mainModule.require('node:sqlite');
    const fs = process.mainModule.require('node:fs'); const path = process.mainModule.require('node:path');
    const home = process.env.CODEX_HOME; fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, 'config.toml'), 'model_provider="codex_api_manager"\n[model_providers.codex_api_manager]\nbase_url="https://provider.example/v1"\n');
    const id = '11111111-1111-4111-8111-111111111111'; const file = path.join(home, 'sessions', 'synthetic.jsonl');
    const header = JSON.stringify({ type: 'session_meta', payload: { id, model_provider: 'previous' } }) + '\n';
    const tail = '{"type":"response_item","payload":{"text":"Synthetic history"}}\n';
    fs.writeFileSync(file, header + tail);
    const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,model_provider TEXT,title TEXT,updated_at INTEGER,history_mode TEXT)');
    db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?)').run(id, path.toNamespacedPath(file), 'previous', '演示对话 · 日常开发', 100, 'legacy');
    db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?)').run('22222222-2222-4222-8222-222222222222', path.join(home, 'sessions', 'missing.jsonl'), 'another', '文件不可用的对话', 99, 'legacy'); db.close();
    const { SessionRepair } = process.mainModule.require(app.getAppPath() + '/session-repair.mjs');
    app.repairQA = { running: true };
    SessionRepair.prototype.checkStopped = async () => { if (app.repairQA.running) throw Object.assign(new Error('请先正常退出 Codex App 和所有 Codex CLI，再重试。'), { kind: 'codex-running', processes: { count: 2, editor: 1 } }); };
    const { AutoSessionRepair } = process.mainModule.require(app.getAppPath() + '/auto-session-repair.mjs');
    const state = AutoSessionRepair.prototype.state;
    AutoSessionRepair.prototype.state = function () { app.repairQA.worker = this; this.quietMs = 0; return state.call(this); };
  });
  await page.waitForSelector('#auto-repair-overview:not([hidden])');
  assert.equal(await page.locator('#auto-repair-overview').isVisible(), true);
  await page.locator('#open-overview-records').click();
  await page.waitForSelector('#auto-repair-records-dialog[open]');
  await page.locator('#close-auto-repair-records').click();
  await page.locator('#open-compatibility-panel').click();
  await page.locator('#open-session-repair').click();
  await page.waitForFunction(() => document.querySelectorAll('.repair-session').length === 2);
  assert.equal(await page.locator('#session-repair-target').textContent(), 'codex_api_manager');
  assert.equal(await page.locator('.repair-session input:disabled').count(), 1);
  await page.locator('#session-repair-all').check();
  assert.equal(await page.locator('#session-repair-count').textContent(), '已选 1 个');
  await page.locator('#apply-session-repair').click();
  await page.waitForFunction(() => document.querySelector('#session-repair-notice').textContent.includes('先正常退出'));
  await app.evaluate(({ app }) => { app.repairQA.running = false; });
  await page.locator('#apply-session-repair').click();
  await page.waitForFunction(() => document.querySelector('#session-repair-notice').textContent.includes('已修复 1'));
  assert.equal(await page.locator('#undo-session-repair').isEnabled(), true);
  await app.evaluate(({ app }) => {
    const fs = process.mainModule.require('node:fs'); const path = process.mainModule.require('node:path');
    const file = path.join(process.env.CODEX_HOME, 'config.toml'); app.repairQA.config = fs.readFileSync(file, 'utf8'); fs.writeFileSync(file, 'model_provider="openai"\n');
  });
  await page.locator('#rescan-session-repair').click();
  await page.waitForFunction(() => document.querySelector('#session-repair-notice').textContent.includes('先切换'));
  assert.equal(await page.locator('#undo-session-repair').isEnabled(), true);
  await page.locator('#undo-session-repair').click();
  await page.waitForFunction(() => document.querySelector('#session-repair-notice').textContent.includes('已撤回 1'));
  await app.evaluate(({ app }) => { process.mainModule.require('node:fs').writeFileSync(process.mainModule.require('node:path').join(process.env.CODEX_HOME, 'config.toml'), app.repairQA.config); });
  await page.locator('#rescan-session-repair').click();
  await page.waitForFunction(() => document.querySelectorAll('.repair-session').length === 2);
  assert.equal(await page.locator('.repair-session input:not(:disabled)').count(), 1);
  await fs.mkdir('test-output', { recursive: true });
  for (const theme of ['light', 'dark', 'rainbow']) {
    await page.evaluate(theme => window.managerTheme.apply(theme), theme);
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 950 });
      await page.screenshot({ path: `test-output/session-repair-${theme}-${width}.png` });
      assert.ok(await page.evaluate(() => { const d = document.querySelector('#session-repair-dialog'); return d.scrollWidth <= d.clientWidth; }));
    }
  }
  await page.locator('#close-session-repair').click();
  for (const theme of ['light', 'dark', 'rainbow']) {
    await page.evaluate(theme => window.managerTheme.apply(theme), theme);
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.screenshot({ path: `test-output/auto-session-settings-${theme}.png` });
  }
  await app.evaluate(({ app }) => { app.repairQA.running = true; });
  await page.locator('#auto-session-repair-toggle').check();
  await page.waitForFunction(() => !document.querySelector('#auto-session-repair-toggle').disabled);
  const tick = () => app.evaluate(async ({ app }) => { await app.repairQA.worker.tick(); return app.repairQA.worker.state(); });
  await page.waitForFunction(async () => (await api('auto-session-repair-status')).phase === 'waiting');
  assert.equal((await tick()).phase, 'waiting');
  await page.locator('#check-auto-session-repair').click();
  await page.waitForFunction(() => document.querySelector('#auto-repair-blockers').textContent.includes('Codex'));
  assert.equal(await page.locator('#auto-repair-overview').evaluate(node => node.hidden), false);
  assert.match(await page.locator('#auto-repair-counts').textContent(), /待处理 1.*跳过 1/);
  assert.match(await page.locator('#auto-repair-blockers').textContent(), /VS Code/);
  await app.evaluate(({ app }) => {
    const fs = process.mainModule.require('node:fs'); const path = process.mainModule.require('node:path'); const file = path.join(process.env.CODEX_HOME, 'config.toml');
    app.repairQA.originalConfig = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, app.repairQA.originalConfig.replace('model_provider="codex_api_manager"', 'model_provider="custom"\nmodel="gpt-6-sol"\nmodel_reasoning_effort="xhigh"') + '[model_providers.custom]\nbase_url="https://provider.example/v1"\nwire_api="responses"\nrequires_openai_auth=true\n');
    fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), '{"OPENAI_API_KEY":"isolated-fake-key"}');
  });
  await page.evaluate(async () => { await api('save', { name: 'Fixture API', url: 'https://provider.example/v1', key: 'isolated-fake-key', model: 'gpt-6-sol', effort: 'xhigh', adapter: 'none' }); await load(); });
  await page.locator('#check-auto-session-repair').click();
  await page.waitForFunction(() => document.querySelector('#auto-repair-phase').textContent === '需要切换入口');
  assert.equal(await page.locator('#auto-repair-blockers li').count(), 2);
  assert.match(await page.locator('#auto-repair-connection').textContent(), /custom/);
  assert.match(await page.locator('#auto-repair-counts').textContent(), /待处理 1.*跳过 1/);
  await page.locator('#open-session-repair').click();
  await page.waitForFunction(() => document.querySelectorAll('.repair-session').length === 2);
  assert.equal(await page.locator('#session-repair-target').textContent(), 'codex_api_manager');
  await page.locator('#session-repair-all').check();
  assert.equal(await page.locator('#apply-session-repair').isEnabled(), false);
  assert.match(await page.locator('#session-repair-notice').textContent(), /同步入口/);
  await page.locator('#close-session-repair').click();
  await page.locator('#check-auto-session-repair').click();
  for (const theme of ['light', 'dark', 'rainbow']) {
    await page.evaluate(theme => window.managerTheme.apply(theme), theme);
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 950 });
      await page.screenshot({ path: `test-output/auto-session-blockers-${theme}-${width}.png` });
      assert.ok(await page.locator('#compatibility-dialog').evaluate(d => d.scrollWidth <= d.clientWidth));
    }
  }
  await page.locator('#close-compatibility').click();
  const syncProvider = page.getByRole('button', { name: '统一当前 API 的连接入口', exact: true });
  assert.equal(await syncProvider.isEnabled(), true); assert.equal(await syncProvider.textContent(), '同步入口');
  await syncProvider.click();
  await page.waitForFunction(() => document.querySelector('.switch-button').textContent === '当前');
  await page.locator('#open-compatibility').click();
  await page.locator('#check-auto-session-repair').click();
  await page.waitForFunction(() => document.querySelector('#auto-repair-phase').textContent === '等待处理');
  await page.locator('#close-compatibility').click();
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.screenshot({ path: 'test-output/auto-session-overview.png' });
  await page.locator('#open-compatibility').click();
  assert.equal(await page.locator('#auto-session-repair-control').isVisible(), true); assert.equal(await page.locator('#settings-dialog').evaluate(d => d.open), false);
  await page.locator('#open-session-repair').click();
  await page.waitForFunction(() => document.querySelectorAll('.repair-exclude').length === 1);
  await page.locator('.repair-exclude').click();
  await page.waitForFunction(() => document.querySelector('.repair-exclude').getAttribute('aria-pressed') === 'true');
  await page.locator('#close-session-repair').click();
  await page.waitForFunction(async () => (await api('auto-session-repair-status')).exclusions.length === 1);
  await app.evaluate(({ app }) => { app.repairQA.running = false; app.repairQA.worker.release(); });
  assert.equal((await tick()).repaired, 0);
  await page.locator('#open-session-repair').click();
  await page.waitForFunction(() => document.querySelectorAll('.repair-exclude').length === 1);
  await page.locator('.repair-exclude').click();
  await page.waitForFunction(() => document.querySelector('.repair-exclude').getAttribute('aria-pressed') === 'false');
  await page.locator('#close-session-repair').click();
  await app.evaluate(({ app }) => app.repairQA.worker.release());
  assert.equal((await tick()).repaired, 1);
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('可查看处理记录'));
  await page.locator('#open-auto-repair-records').click();
  await page.waitForFunction(() => document.querySelector('#auto-repair-records').textContent.includes('自动兼容 1'));
  assert.match(await page.locator('#auto-repair-records').textContent(), /演示对话.*previous → codex_api_manager/s);
  for (const theme of ['light', 'dark', 'rainbow']) {
    await page.evaluate(theme => window.managerTheme.apply(theme), theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 950 }); await page.screenshot({ path: `test-output/auto-session-records-${theme}-${width}.png` });
      assert.ok(await page.locator('#auto-repair-records-dialog').evaluate(d => d.scrollWidth <= d.clientWidth));
    }
  }
  await page.locator('#close-auto-repair-records').click();
  await page.locator('#open-session-repair').click();
  await page.waitForFunction(() => !document.querySelector('#undo-session-repair').disabled);
  await page.locator('#undo-session-repair').click();
  await page.waitForFunction(() => document.querySelector('#session-repair-notice').textContent.includes('已撤回 1'));
  assert.equal(await page.locator('#auto-session-repair-toggle').isChecked(), false);
  await page.locator('#close-session-repair').click();
  assert.equal((await tick()).enabled, false);
  await page.reload();
  await page.waitForFunction(() => window.codexManager && !document.querySelector('#auto-session-repair-toggle').checked);
  assert.equal(await page.evaluate(async () => (await api('auto-session-repair-status')).enabled), false);
  const report = await page.evaluate(() => api('auto-session-repair-details'));
  assert.ok(report.records.length >= 1); assert.ok(report.records[0].undoneAt);
  assert.deepEqual(errors, []);
  console.log('Session repair desktop UI passed: manual repair, automatic migration, running guard, exclusions, undo disables auto, persisted settings, themes and responsive dialogs.');
} finally { await app.close(); await fs.rm(temp, { recursive: true, force: true }); }
