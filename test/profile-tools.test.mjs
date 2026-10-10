import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Manager } from '../core.mjs';
import { portableCodec } from '../portable.mjs';

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-profile-tools-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const dataDir = path.join(temp, 'data');
  const manager = new Manager({ dataDir, codexHome: path.join(temp, 'codex'), codec: await portableCodec(dataDir) });
  await manager.init();
  for (const name of ['Alpha', 'Beta']) await manager.save({ name, url: 'https://profiles-qa.example/v1', key: 'fake-secret-' + name, model: 'qa-model', effort: 'high', adapter: 'auto' });
  return manager;
}
test('favorite survives edits and restart; delete undo preserves encrypted key and order', async t => {
  const manager = await fixture(t), [a, b] = manager.store.profiles;
  await manager.setFavorite(a.id, true);
  await manager.save({ ...a, name: 'Edited', key: '' });
  assert.equal(manager.store.profiles[0].favorite, true);
  await manager.init(); assert.equal(manager.store.profiles[0].favorite, true);
  const { undoToken } = await manager.remove(a.id);
  assert.equal(manager.store.profiles.length, 1);
  assert.ok(!(await fs.readFile(manager.storePath, 'utf8')).includes('fake-secret'));
  await manager.undoRemove(undoToken);
  assert.deepEqual(manager.store.profiles.map(p => p.id), [a.id, b.id]);
  assert.equal(await manager.readKey(a.id), 'fake-secret-Alpha');
  assert.equal(manager.store.profiles[0].favorite, true);
  await assert.rejects(manager.undoRemove(undoToken), /过期/);
});
test('failed favorite/delete/undo writes leave disk and memory intact; expiration cannot restore', async t => {
  const manager = await fixture(t), id = manager.store.profiles[0].id;
  const persist = manager.persist.bind(manager);
  manager.persist = async () => { throw new Error('simulated disk failure'); };
  await assert.rejects(manager.setFavorite(id, true));
  assert.equal(manager.store.profiles[0].favorite, false);
  await assert.rejects(manager.remove(id));
  assert.equal(manager.deletedProfiles.size, 0);
  assert.equal(manager.store.profiles.length, 2);
  manager.persist = persist;
  const { undoToken } = await manager.remove(id);
  manager.persist = async () => { throw new Error('simulated disk failure'); };
  await assert.rejects(manager.undoRemove(undoToken));
  assert.equal(manager.store.profiles.length, 1);
  assert.ok(manager.deletedProfiles.has(undoToken));
  manager.persist = persist;
  manager.deletedProfiles.get(undoToken).expiresAt = Date.now() - 1;
  await assert.rejects(manager.undoRemove(undoToken), /过期/);
  assert.equal(manager.store.profiles.length, 1);
});
