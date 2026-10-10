import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Manager, updateConfig } from '../core.mjs';
import { MonitorController } from '../monitor.mjs';

test('startup recognizes URL and key after model changes without writing Codex configuration', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-current-api-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const codec = { encrypt: async v => Buffer.from(v).toString('base64'), decrypt: async v => Buffer.from(v, 'base64').toString() };
  const options = { codexHome: path.join(dir, 'codex'), dataDir: path.join(dir, 'data'), codec };
  const m = new Manager(options); await m.init();
  const p = { name: 'First', url: 'https://current-qa.example/v1', key: 'first-fixture-key', model: 'saved-model', effort: 'high', adapter: 'none' };
  await m.save(p); await m.save({ ...p, name: 'Second', key: 'second-fixture-key' });
  const id = m.store.profiles[0].id;
  await m.switchTo(id);
  const originalAuth = await fs.readFile(m.authPath, 'utf8');
  for (const edit of [
    { model: 'changed-model', effort: 'low', url: p.url },
    { model: p.model, effort: undefined, url: p.url + '/' },
  ]) {
    let config = updateConfig('', { ...p, ...edit, effort: edit.effort || p.effort });
    if (!edit.effort) config = config.replace(/^model_reasoning_effort = .*\r?\n/m, '');
    await fs.writeFile(m.configPath, config);
    const reopened = new Manager(options); await reopened.init();
    const state = await reopened.state();
    assert.deepEqual(state.profiles.filter(p => p.active).map(p => p.id), [id]);
    assert.equal(state.current.needsProfileSync, true);
    assert.equal(await fs.readFile(m.configPath, 'utf8'), config);
    assert.equal(await fs.readFile(m.authPath, 'utf8'), originalAuth);
    assert.ok(!JSON.stringify(state).includes('first-fixture-key'));
    await fs.writeFile(m.authPath, '{"OPENAI_API_KEY":"unknown-fixture-key"}');
    assert.equal((await reopened.state()).profiles.some(p => p.active), false);
    await fs.writeFile(m.authPath, originalAuth);
  }
  await m.switchTo(id);
  assert.equal((await m.state()).current.needsProfileSync, false);
  const controller = new MonitorController(m); await controller.init();
  await controller.setMonitoring(true); await controller.monitor.shutdown();
  const reopened = new Manager(options); await reopened.init();
  assert.deepEqual((await reopened.state()).profiles.filter(p => p.active).map(p => p.id), [id]);
});

test('profiles sharing credentials prefer exact settings and show only one current API', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-current-duplicate-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const codec = { encrypt: async v => v, decrypt: async v => v };
  const m = new Manager({ codexHome: path.join(dir, 'codex'), dataDir: path.join(dir, 'data'), codec }); await m.init();
  const p = { name: 'One', url: 'https://duplicate-qa.example/v1', key: 'fake-shared-key', model: 'one', effort: 'high', adapter: 'none' };
  await m.save(p); await m.save({ ...p, name: 'Two', model: 'two' });
  const second = m.store.profiles[1]; await m.switchTo(second.id);
  assert.deepEqual((await m.state()).profiles.filter(p => p.active).map(p => p.id), [second.id]);
});
