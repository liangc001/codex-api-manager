import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { portableCodec } from '../portable.mjs';
import { Manager } from '../core.mjs';
import { StorageSettings } from '../storage.mjs';
import { MonitorController } from '../monitor.mjs';

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-portable-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const dataDir = path.join(temp, 'portable', 'data');
  const storage = new StorageSettings(dataDir, { portable: true }); await storage.init();
  const manager = new Manager({ codexHome: path.join(temp, 'codex'), dataDir, codec: await portableCodec(dataDir), origin: 'computer-a' }); await manager.init();
  const controller = new MonitorController(manager);
  return { temp, storage, manager, controller };
}

test('portable keys and settings survive moving folder; foreign backup cannot restore', async t => {
  const { temp, storage, manager } = await fixture(t);
  await manager.save({ name: 'Portable', url: 'https://example.com/v1', model: 'test', effort: 'high', adapter: 'none', key: 'portable-test-key' });
  await manager.switchTo(manager.store.profiles[0].id);
  const moved = path.join(temp, 'computer-b', 'data'); await fs.cp(manager.dataDir, moved, { recursive: true });
  const reopenedStorage = new StorageSettings(moved, { portable: true }); await reopenedStorage.init();
  const reopened = new Manager({ codexHome: path.join(temp, 'codex-b'), dataDir: moved, codec: await portableCodec(moved), origin: 'computer-b' }); await reopened.init();
  assert.equal(await reopened.codec.decrypt(reopened.store.profiles[0].encryptedKey), 'portable-test-key');
  assert.equal(reopenedStorage.settings.dataDir, moved);
  assert.equal(JSON.parse(await fs.readFile(storage.settingsFile, 'utf8')).dataDir, undefined);
  assert.equal((await reopened.state()).canRestore, false);
  await assert.rejects(reopened.restore(), /另一台电脑/);
  await reopened.switchTo(reopened.store.profiles[0].id);
  assert.equal(JSON.parse(await fs.readFile(reopened.authPath, 'utf8')).OPENAI_API_KEY, 'portable-test-key');
  await reopened.restore(); await assert.rejects(fs.access(reopened.authPath), { code: 'ENOENT' });
  const altered = reopened.store.profiles[0].encryptedKey.replace(/.$/, 'x');
  await assert.rejects(reopened.codec.decrypt(altered), /无法解密/);
  await fs.rm(path.join(moved, 'secrets.key'));
  await assert.rejects(portableCodec(moved), /缺少 secrets.key/);
});

test('portable settings never follow absolute paths copied from another computer', async t => {
  const { temp, storage, manager, controller } = await fixture(t);
  const external = path.join(temp, 'external');
  await fs.writeFile(storage.settingsFile, JSON.stringify({ dataDir: external, logging: false, retentionDays: 7 }));
  const reopened = new StorageSettings(manager.dataDir, { portable: true }); await reopened.init();
  assert.equal(reopened.settings.dataDir, manager.dataDir);
  assert.equal(reopened.settings.logging, false);
  await assert.rejects(reopened.update({ dataDir: external, logging: true, retentionDays: 30 }, manager, controller.monitor), /便携版/);
});

test('foreign monitor recovery is archived without changing new computer config', async t => {
  const { manager, controller } = await fixture(t);
  const original = 'model = "local-model"\n';
  await fs.mkdir(manager.home); await fs.writeFile(manager.configPath, original);
  await fs.writeFile(controller.monitor.sessionFile, await manager.codec.encrypt(JSON.stringify({ origin: 'computer-b', config: 'other config', auth: 'other auth' })));
  await controller.init();
  assert.equal(await fs.readFile(manager.configPath, 'utf8'), original);
  await assert.rejects(fs.access(controller.monitor.sessionFile), { code: 'ENOENT' });
  assert.ok((await fs.readdir(path.join(manager.dataDir, 'backups')))[0].startsWith('monitor-other-machine-'));
  assert.equal(controller.monitor.recoveryWarning, '');
});
