import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { queryModels } from '../models.mjs';
import { Manager } from '../core.mjs';

test('models use authenticated GET without redirects and return only bounded unique IDs', async () => {
  const ids = await queryModels('https://models.example/v1/', 'fake-private-key', async (url, options) => {
    assert.equal(url, 'https://models.example/v1/models');
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, 'Bearer fake-private-key');
    return Response.json({ data: [{ id: 'gpt-6-sol' }, { id: 'other/model' }, { id: 'gpt-6-sol' }, { id: '<script>' }, { id: 'fake-private-key' }, { id: 'a'.repeat(101) }, {}] });
  });
  assert.deepEqual(ids, ['gpt-6-sol', 'other/model']);
});
test('models failure messages do not expose upstream data, credentials or transport errors', async () => {
  for (const status of [401, 403, 404, 405, 302, 429, 500]) {
    await assert.rejects(queryModels('https://models.example/v1', 'fake-private-key', async () => Response.json({ error: 'fake-private-key' }, { status })), error => !error.message.includes('fake-private-key'));
  }
  await assert.rejects(queryModels('https://models.example/v1', 'fake-private-key', async () => { throw new Error('fake-private-key'); }), /无法查询/);
  await assert.rejects(queryModels('https://models.example/v1', 'fake-private-key', async () => Response.json({ data: [] })), /未返回/);
  let canceled = false;
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1048577)); }, cancel() { canceled = true; } });
  await assert.rejects(queryModels('https://models.example/v1', 'fake-private-key', async () => new Response(stream)), /过大/);
  assert.equal(canceled, true);
});
test('model lookup for an existing API cannot reuse its key at a changed address or modify configuration', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-models-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const manager = new Manager({ codexHome: path.join(temp, 'codex'), dataDir: path.join(temp, 'data'), codec: { encrypt: async v => v, decrypt: async v => v } });
  await manager.init();
  await manager.save({ name: 'QA', url: 'https://models.example/v1', key: 'fake-private-key', model: 'qa-model', effort: 'high', adapter: 'auto' });
  const id = manager.store.profiles[0].id, before = await fs.readFile(manager.storePath, 'utf8');
  let calls = 0;
  const fetcher = async () => { calls++; return Response.json({ data: [{ id: 'qa-model' }] }); };
  await assert.rejects(manager.listModels({ id, url: 'https://other.example/v1', key: '' }, fetcher), /重新填写/);
  assert.equal(calls, 0);
  assert.deepEqual(await manager.listModels({ id, url: 'https://models.example/v1/', key: '' }, fetcher), ['qa-model']);
  assert.equal(await fs.readFile(manager.storePath, 'utf8'), before);
  await assert.rejects(fs.access(manager.configPath), { code: 'ENOENT' });
});
