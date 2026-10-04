import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Manager, normalizeUsage, queryUsage } from '../core.mjs';

test('failed save, delete and usage persistence leave memory, keys and disk unchanged', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-persistence-regression-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const manager = new Manager({ codexHome: path.join(temp, 'codex'), dataDir: path.join(temp, 'data'),
    codec: { encrypt: async v => Buffer.from(v).toString('base64'), decrypt: async v => Buffer.from(v, 'base64').toString() } });
  await manager.init();
  const input = { name: 'Original', url: 'https://test.example/v1', key: 'fake-original-key', model: 'test-model', effort: 'high', adapter: 'none' };
  await manager.save(input);
  const id = manager.store.profiles[0].id;
  manager.connectionTests.set(id, { kind: 'ok' });
  const previous = structuredClone(manager.store), disk = await fs.readFile(manager.storePath, 'utf8');
  const persist = manager.persist.bind(manager);
  manager.persist = async () => { throw new Error('simulated disk failure'); };
  for (const operation of [
    () => manager.save({ ...input, name: 'Phantom', key: 'fake-new-key' }),
    () => manager.save({ ...input, id, name: 'Changed', key: 'fake-new-key' }),
    () => manager.remove(id),
    () => manager.refresh(id),
  ]) {
    await assert.rejects(operation, /simulated disk failure/);
    assert.deepEqual(manager.store, previous);
    assert.equal(await manager.readKey(id), input.key);
    assert.equal(await fs.readFile(manager.storePath, 'utf8'), disk);
    assert.equal(manager.connectionTests.get(id).kind, 'ok');
  }
  manager.persist = persist;
  await manager.save({ ...input, id, name: 'Saved normally' });
  const reopened = new Manager({ codexHome: manager.home, dataDir: manager.dataDir, codec: manager.codec });
  await reopened.init();
  assert.deepEqual(reopened.store, manager.store);
});

test('usage normalization excludes echoed keys, arbitrary strings and nested response fields', () => {
  const secret = 'fake-private-value-never-store';
  const raw = { remaining: '12.5', quota: { used: { key: secret } }, unit: secret,
    usage: { today: { actual_cost: secret, total_tokens: '123' } },
    rate_limits: [{ window: secret, used: secret, limit: { key: secret } }, { window: '5h', used: '2', limit: 5 }, null],
    subscription: { daily_usage_usd: secret, daily_limit_usd: 3, weekly_limit_usd: secret }, key: secret };
  const result = normalizeUsage('sub2api', raw);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(result.remaining, 12.5); assert.equal(result.used, null); assert.equal(result.tokens, 123);
  assert.equal(result.unit, '额度'); assert.equal(result.windows[0].name, '额度窗口');
  assert.deepEqual(result.windows[1], { name: '5h', used: 2, limit: 5 });
  assert.deepEqual(result.subscription, [{ name: 'daily', used: null, limit: 3 }]);
});

test('usage errors never retain transport messages, URLs or private paths', async () => {
  const privateText = 'fake-key-partial https://private.example/v1 C:\\private\\auth.json';
  for (const fetcher of [
    async () => { throw new Error(privateText); },
    async () => Response.json({ error: { message: privateText } }, { status: 403 }),
    async () => Response.json(null),
  ]) {
    const result = await queryUsage({ url: 'https://test.example/v1', adapter: 'sub2api' }, 'fake-key-full', fetcher);
    assert.equal(result.status, 'error'); assert.ok(!JSON.stringify(result).includes(privateText));
    assert.ok(!JSON.stringify(result).includes('private.example'));
  }
});

test('usage response byte limit cancels an oversized stream before it is fully buffered', async () => {
  let canceled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1_000_001)); }, cancel() { canceled = true; } });
  const result = await queryUsage({ url: 'https://test.example/v1', adapter: 'sub2api' }, 'fake-key', async () => new Response(body));
  assert.equal(result.message, '用量响应过大'); assert.equal(canceled, true);
});

test('unsupported usage endpoints release response streams before trying the next adapter', async () => {
  let canceled = false, calls = 0;
  const result = await queryUsage({ url: 'https://test.example/v1', adapter: 'auto' }, 'fake-key', async () => {
    calls++;
    if (calls === 1) return new Response(new ReadableStream({ cancel() { canceled = true; } }), { status: 404 });
    assert.equal(canceled, true);
    return Response.json({ data: { total_available: 5, total_used: 1 } });
  });
  assert.equal(result.status, 'ok'); assert.equal(calls, 2);
});
