import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-claude-ui-'));
const env = { ...process.env, CODEX_HOME: path.join(temp, 'codex'), CLAUDE_CONFIG_DIR: path.join(temp, 'claude'),
  CODEX_MANAGER_TEST_DATA: path.join(temp, 'data'), PORTABLE_EXECUTABLE_DIR: temp };
delete env.ELECTRON_RUN_AS_NODE;
const config = path.join(env.CLAUDE_CONFIG_DIR, 'settings.json');
const codex = path.join(env.CODEX_HOME, 'config.toml');
const initial = '{"env":{"KEEP":"yes"},"permissions":{"deny":["Read(.env)"]}}\n';
await fs.mkdir(env.CODEX_HOME); await fs.mkdir(env.CLAUDE_CONFIG_DIR);
await fs.writeFile(codex, '# untouched\n'); await fs.writeFile(config, initial);
let app;
try {
  app = await electron.launch({ ...(process.argv[2] ? { executablePath: path.resolve(process.argv[2]), args: [] } : { args: ['.'] }), env });
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await app.evaluate(({ session }) => {
    session.fromPartition('claude-model-network').fetch = async (url, options) => {
      if (url !== 'https://fixture.example/anthropic/v1/models' || options.headers['x-api-key'] !== 'fixture-key') throw new Error('Unexpected request');
      return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-fixture' }] }));
    };
  });
  await page.locator('#close-guide').click();
  await page.getByRole('button', { name: 'Claude Code', exact: true }).click();
  await page.waitForFunction(() => document.body.dataset.client === 'claude');
  assert.equal(await page.locator('#auto-repair-overview').isVisible(), false);
  await page.locator('#add').click();
  await page.locator('#profile-form [name=name]').fill('Fixture Claude');
  await page.locator('#profile-form [name=url]').fill('https://fixture.example/anthropic/v1');
  await page.locator('#profile-form [name=key]').fill('fixture-key');
  await page.locator('#profile-form [name=auth]').selectOption('api-key');
  await page.locator('#query-models').click();
  await page.locator('#model-picker').waitFor();
  await page.locator('#model-list').selectOption('claude-sonnet-fixture');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('.switch-button').click();
  await page.waitForFunction(() => document.querySelector('#current-name').textContent === 'Fixture Claude');
  assert.equal(JSON.parse(await fs.readFile(config, 'utf8')).env.ANTHROPIC_API_KEY, 'fixture-key');
  await page.getByRole('button', { name: '收藏 Fixture Claude', exact: true }).click();
  await page.getByRole('button', { name: '取消收藏 Fixture Claude' }).waitFor();
  await page.getByRole('button', { name: '查看详情 Fixture Claude' }).click();
  await page.locator('#api-details').getByText('x-api-key').waitFor();
  await page.locator('#close-api-details').click();
  await page.locator('#export-file').click();
  await page.getByRole('heading', { name: '导出 Claude API' }).waitFor();
  await page.locator('#cancel-transfer').click();
  for (const theme of ['light', 'dark', 'rainbow']) {
    await page.evaluate(theme => window.managerTheme.apply(theme), theme);
    for (const width of [1440, 560, 390]) {
      await page.setViewportSize({ width, height: 740 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: `test-output/claude-workspace-${theme}-${width}.png` });
    }
  }
  await page.locator('#client-codex').click();
  await page.waitForFunction(() => document.body.dataset.client === 'codex');
  assert.equal(await page.locator('.profile').count(), 0);
  await page.locator('#client-claude').click();
  await page.locator('#restore').click();
  await page.waitForFunction(() => document.querySelector('#current-name').textContent === '尚未配置');
  assert.equal(await fs.readFile(config, 'utf8'), initial);
  assert.equal(await fs.readFile(codex, 'utf8'), '# untouched\n');
  assert.deepEqual(errors, []);
  console.log('Claude desktop UI passed: add, switch, export selection, restore, themes and viewport sizes.');
} finally {
  if (app) await app.close();
  await fs.rm(temp, { recursive: true, force: true });
}
