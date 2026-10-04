import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StorageSettings } from '../storage.mjs';

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-storage-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const storage = new StorageSettings(path.join(temp, 'data'));
  await storage.init();
  const manager = { dataDir: storage.settings.dataDir, storePath: path.join(storage.settings.dataDir, 'profiles.json'), home: path.join(temp, 'codex') };
  const monitor = { enabled: false, active: new Map(), recoveryWarning: '', sessionFile: path.join(manager.dataDir, 'monitor-session.json') };
  await fs.writeFile(manager.storePath, '{"profiles":[],"lastBackup":{"file":"backup-test.json"}}');
  return { temp, storage, manager, monitor };
}

test('migration preserves encrypted data, backups and logs and survives restart', async t => {
  const { temp, storage, manager, monitor } = await fixture(t);
  await fs.mkdir(path.join(manager.dataDir, 'backups'));
  await fs.writeFile(path.join(manager.dataDir, 'backups', 'backup-test.json'), 'encrypted-fixture');
  await storage.record('startup');
  const old = manager.dataDir, target = path.join(temp, 'new-data');
  assert.deepEqual(await storage.update({ dataDir: target, logging: true, retentionDays: 7 }, manager, monitor), { migrated: true });
  assert.equal(await fs.readFile(manager.storePath, 'utf8'), await fs.readFile(path.join(old, 'profiles.json'), 'utf8'));
  assert.equal(await fs.readFile(path.join(target, 'backups', 'backup-test.json'), 'utf8'), 'encrypted-fixture');
  assert.equal(monitor.sessionFile, path.join(target, 'monitor-session.json'));
  const restarted = new StorageSettings(storage.root); await restarted.init();
  assert.equal(restarted.settings.dataDir, storage.settings.dataDir);
  assert.equal(restarted.settings.retentionDays, 7);
  assert.ok((await fs.readdir(restarted.logDir)).length >= 1);
});

test('migration rejects occupied, nested and monitored destinations without losing data', async t => {
  const { temp, storage, manager, monitor } = await fixture(t);
  const old = manager.dataDir;
  const occupied = path.join(temp, 'occupied'); await fs.mkdir(occupied); await fs.writeFile(path.join(occupied, 'keep'), 'user-file');
  const input = dataDir => ({ dataDir, logging: true, retentionDays: 30 });
  await assert.rejects(storage.update(input(occupied), manager, monitor), /必须为空/);
  await assert.rejects(storage.update(input(path.join(old, 'child')), manager, monitor), /独立/);
  await assert.rejects(storage.update(input(manager.home), manager, monitor), /独立/);
  monitor.enabled = true;
  await assert.rejects(storage.update(input(path.join(temp, 'target')), manager, monitor), /关闭实时监控/);
  monitor.enabled = false;
  await fs.writeFile(monitor.sessionFile, 'recovery');
  await assert.rejects(storage.update(input(path.join(temp, 'target')), manager, monitor), /未恢复/);
  assert.equal(manager.dataDir, old);
  assert.equal(await fs.readFile(path.join(occupied, 'keep'), 'utf8'), 'user-file');
  assert.equal(JSON.parse(await fs.readFile(storage.settingsFile, 'utf8')).dataDir, old);
});

test('logs allow only safe metadata, honor disable, retention and clear without deleting other files', async t => {
  const { storage, manager, monitor } = await fixture(t);
  const secret = 'should-never-appear';
  await storage.record('operation', { operation: 'switch', outcome: 'error', key: secret, message: secret, url: secret });
  await storage.record('request', { status: 429, durationMs: 123, firstByteMs: 12, outcome: 'completed', model: secret, prompt: secret, headers: secret });
  const files = await fs.readdir(storage.logDir);
  const text = await fs.readFile(path.join(storage.logDir, files[0]), 'utf8');
  assert.ok(!text.includes(secret)); assert.ok(text.includes('429')); assert.ok(text.includes('switch'));
  await storage.update({ dataDir: manager.dataDir, logging: false, retentionDays: 7 }, manager, monitor);
  const before = await fs.readFile(path.join(storage.logDir, files[0]), 'utf8');
  await storage.record('startup');
  assert.equal(await fs.readFile(path.join(storage.logDir, files[0]), 'utf8'), before);
  const stale = path.join(storage.logDir, 'events-2020-01-01-abcd.jsonl');
  await fs.writeFile(stale, 'old'); await fs.utimes(stale, new Date(0), new Date(0));
  const extra = path.join(storage.logDir, 'keep.txt'); await fs.writeFile(extra, 'keep');
  await storage.prune(); await assert.rejects(fs.access(stale), { code: 'ENOENT' });
  await storage.clearLogs(); assert.deepEqual(await fs.readdir(storage.logDir), ['keep.txt']);
});

test('unavailable custom directory is reported instead of silently resetting profiles', async t => {
  const { temp, storage, manager, monitor } = await fixture(t);
  await storage.update({ dataDir: path.join(temp, 'custom'), logging: true, retentionDays: 30 }, manager, monitor);
  await fs.rename(storage.settings.dataDir, path.join(temp, 'disconnected'));
  await assert.rejects(new StorageSettings(storage.root).init(), { code: 'ENOENT' });
});
