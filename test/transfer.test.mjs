import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Manager } from '../core.mjs';
import { portableCodec } from '../portable.mjs';
import { TransferService, parseBundle } from '../transfer.mjs';

const fields = { name: 'API A', url: 'https://a.example/v1', model: 'test-model', effort: 'high', adapter: 'auto' };
const bundle = profiles => JSON.stringify({ format: 'codex-api-manager', version: 1, profiles });
async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-transfer-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const dataDir = path.join(temp, 'data');
  const manager = new Manager({ codexHome: path.join(temp, 'codex'), dataDir, codec: await portableCodec(dataDir) });
  await manager.init();
  await manager.save({ ...fields, key: 'original-key-a' });
  await manager.save({ ...fields, name: 'API B', url: 'https://b.example/v1', key: 'original-key-b' });
  const monitor = { enabled: false, profile: null };
  const transfer = new TransferService(manager, monitor); t.after(() => transfer.discard());
  return { temp, manager, monitor, transfer };
}

test('selected exports include keys and exclude local history and identifiers', async t => {
  const { temp, manager, transfer } = await fixture(t);
  manager.store.profiles[0].usage = { private: 'not-exported' };
  const id = manager.store.profiles[0].id;
  const selected = await transfer.exportBundle([id]);
  assert.equal(selected.profiles.length, 1);
  assert.deepEqual(selected.profiles[0], { ...fields, key: 'original-key-a' });
  assert.ok(!JSON.stringify(selected).includes('not-exported'));
  assert.equal(selected.profiles[0].key, 'original-key-a');
  assert.ok(!JSON.stringify(selected).includes('original-key-b'));
  const file = path.join(temp, 'export.json'); await transfer.exportTo(file, [id]);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), selected);
  await assert.rejects(transfer.exportTo(manager.storePath, [id]), /运行文件/);
  await assert.rejects(transfer.exportBundle([]), /选择/);
  await assert.rejects(transfer.exportBundle([id, id]), /选择/);
  await assert.rejects(transfer.exportBundle(['missing']), /选择/);
  await manager.save({ ...fields, name: 'Missing key', key: '' });
  await assert.rejects(transfer.exportBundle([manager.store.profiles[2].id]), /填写 Key/);
  await manager.save({ ...fields, key: 'duplicate-account-key' });
  await assert.rejects(transfer.exportBundle([id, manager.store.profiles[3].id]), /重复项/);
});

test('import preview never exposes keys and selected import encrypts with destination key', async t => {
  const { temp, manager, transfer } = await fixture(t);
  const exported = await transfer.exportBundle(manager.store.profiles.map(p => p.id));
  const targetDir = path.join(temp, 'destination');
  const target = new Manager({ codexHome: path.join(temp, 'destination-codex'), dataDir: targetDir, codec: await portableCodec(targetDir) }); await target.init();
  const importer = new TransferService(target); t.after(() => importer.discard());
  const preview = importer.preview(JSON.stringify(exported), 'selected.json');
  assert.ok(!JSON.stringify(preview).includes('original-key'));
  assert.equal(preview.profiles[0].hasKey, true);
  assert.deepEqual(await importer.apply({ token: preview.token, indices: [1], duplicates: 'skip' }), { added: 1, updated: 0, skipped: 0 });
  assert.equal(target.store.profiles.length, 1);
  assert.equal(await target.codec.decrypt(target.store.profiles[0].encryptedKey), 'original-key-b');
  assert.ok(!JSON.stringify(target.store).includes('original-key-b'));
  assert.notEqual(target.store.profiles[0].encryptedKey, manager.store.profiles[1].encryptedKey);
  await assert.rejects(fs.access(target.authPath), { code: 'ENOENT' });
  assert.equal(target.store.lastBackup, null);
});

test('duplicates skip or replace with imported keys; names distinguish same provider', async t => {
  const { manager, transfer } = await fixture(t);
  const id = manager.store.profiles[0].id;
  let preview = transfer.preview(bundle([{ ...fields, model: 'updated-model', key: 'replacement-key' }]));
  assert.equal(preview.profiles[0].duplicate, true);
  assert.deepEqual(await transfer.apply({ token: preview.token, indices: [0], duplicates: 'skip' }), { added: 0, updated: 0, skipped: 1 });
  assert.equal(await manager.codec.decrypt(manager.store.profiles[0].encryptedKey), 'original-key-a');
  preview = transfer.preview(bundle([{ ...fields, model: 'updated-model', key: 'replacement-key' }]));
  await transfer.apply({ token: preview.token, indices: [0], duplicates: 'replace' });
  assert.equal(manager.store.profiles[0].id, id);
  assert.equal(manager.store.profiles[0].model, 'updated-model');
  assert.equal(await manager.codec.decrypt(manager.store.profiles[0].encryptedKey), 'replacement-key');
  preview = transfer.preview(bundle([{ ...fields, name: 'Another account', key: 'another-key' }]));
  assert.equal(preview.profiles[0].duplicate, false);
  await transfer.apply({ token: preview.token, indices: [0], duplicates: 'replace' });
  assert.equal(manager.store.profiles.length, 3);
});

test('failed persistence and active monitored overwrite leave entire batch unchanged', async t => {
  const { manager, transfer, monitor } = await fixture(t);
  const before = JSON.stringify(manager.store), disk = await fs.readFile(manager.storePath, 'utf8');
  const preview = transfer.preview(bundle([{ ...fields, name: 'New', key: 'new-key' }, { ...fields, key: 'replacement' }]));
  monitor.enabled = true; monitor.profile = { id: manager.store.profiles[0].id };
  await assert.rejects(transfer.apply({ token: preview.token, indices: [0, 1], duplicates: 'replace' }), /关闭监控/);
  assert.equal(JSON.stringify(manager.store), before);
  monitor.enabled = false;
  manager.persist = async () => { throw new Error('write failure'); };
  await assert.rejects(transfer.apply({ token: preview.token, indices: [0, 1], duplicates: 'replace' }), /write failure/);
  assert.equal(JSON.stringify(manager.store), before);
  assert.equal(await fs.readFile(manager.storePath, 'utf8'), disk);
});

test('invalid files are rejected without disclosing input; only known fields survive parsing', () => {
  const secret = 'private-key-value';
  assert.throws(() => parseBundle('{"key":"' + secret), e => !e.message.includes(secret));
  for (const text of [JSON.stringify({ profiles: [fields] }), bundle([]), bundle([{ ...fields, url: 'http://bad.example/v1' }]), bundle([{ ...fields, key: 'bad\nkey' }]), bundle([{ ...fields, effort: 'bad' }]), bundle([{ ...fields }, { ...fields, url: fields.url + '/' }])]) assert.throws(() => parseBundle(text));
  assert.throws(() => parseBundle(' '.repeat(8 * 1024 * 1024 + 1)), /8 MiB/);
  assert.throws(() => parseBundle(bundle([fields])), /缺少有效/);
  assert.deepEqual(parseBundle('\uFEFF' + bundle([{ ...fields, key: 'valid-key', encryptedKey: 'untrusted', usage: 'untrusted', id: 'untrusted' }]))[0], { ...fields, key: 'valid-key' });
});

test('canceled or replaced preview tokens cannot be applied', async t => {
  const { transfer } = await fixture(t);
  const first = transfer.preview(bundle([{ ...fields, key: 'valid-key' }]));
  const second = transfer.preview(bundle([{ ...fields, key: 'valid-key' }]));
  await assert.rejects(transfer.apply({ token: first.token, indices: [0], duplicates: 'skip' }), /过期/);
  await assert.rejects(transfer.apply({ token: second.token, indices: [-1], duplicates: 'skip' }), /有效/);
  transfer.discard();
  await assert.rejects(transfer.apply({ token: second.token, indices: [0], duplicates: 'skip' }), /过期/);
});
