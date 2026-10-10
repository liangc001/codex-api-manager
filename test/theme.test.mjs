import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StorageSettings } from '../storage.mjs';

test('portable appearance survives migration; partial settings updates preserve it', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-theme-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'data');
  const storage = new StorageSettings(root, { portable: true });
  await storage.init();
  assert.equal(storage.settings.theme, 'light');
  const monitor = { enabled: false, active: new Map() };
  const settings = { dataDir: root, logging: false, retentionDays: 7 };
  await storage.update({ ...settings, theme: 'dark' }, {}, monitor);
  await storage.update({ ...settings, autoUpdates: false }, {}, monitor);
  assert.equal(storage.settings.theme, 'dark');
  const copy = path.join(temp, 'other-computer', 'data');
  await fs.cp(root, copy, { recursive: true });
  const reopened = new StorageSettings(copy, { portable: true });
  await reopened.init();
  assert.equal(reopened.settings.theme, 'dark');
  assert.equal(reopened.settings.dataDir, copy);
  await assert.rejects(reopened.update({ ...settings, dataDir: copy, theme: 'invalid' }, {}, monitor), /主题设置无效/);
  assert.equal(reopened.settings.theme, 'dark');
});
