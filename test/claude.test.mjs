import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ClaudeManager, ClaudeMonitor, claudeProfile, normalizeClaudeUrl } from '../claude.mjs';
import { portableCodec } from '../portable.mjs';
import { TransferService } from '../transfer.mjs';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { testConnection } from '../support.mjs';

const a = { name: 'Fixture A', url: 'https://one.example/anthropic/v1/messages', model: 'claude-sonnet-fixture', auth: 'bearer', key: 'test-bearer-secret' };
const b = { name: 'Fixture B', url: 'https://two.example', model: '', auth: 'api-key', key: 'test-api-key-secret' };
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-claude-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data'), claudeHome = path.join(root, 'claude');
  await fs.mkdir(claudeHome);
  const manager = new ClaudeManager({ dataDir, claudeHome, codec: await portableCodec(dataDir) });
  await manager.init();
  return { root, manager, transfer: new TransferService(manager, null, {
    format: 'claude-code-api-manager', validate: claudeProfile, serialize: ({ name, url, model, auth }) => ({ name, url, model, auth }),
  }) };
}

test('switch and undo preserve other Claude settings and leave Codex untouched', async t => {
  const { root, manager } = await setup(t);
  const initial = '{"permissions":{"deny":["Read(.env)"]},"env":{"OTHER":"preserve"}}\n';
  const codex = path.join(root, 'config.toml');
  await fs.writeFile(codex, 'model_provider = "fixture"\n');
  await fs.writeFile(manager.configPath, initial);
  await manager.save(a); await manager.save(b);
  const [one, two] = manager.store.profiles;
  await manager.switchTo(one.id);
  const first = await fs.readFile(manager.configPath, 'utf8');
  assert.deepEqual(JSON.parse(first), { permissions: { deny: ['Read(.env)'] },
    env: { OTHER: 'preserve', ANTHROPIC_BASE_URL: 'https://one.example/anthropic', ANTHROPIC_AUTH_TOKEN: a.key, ANTHROPIC_MODEL: a.model } });
  assert.equal((await manager.state()).profiles[0].active, true);
  await manager.switchTo(two.id);
  assert.deepEqual(JSON.parse(await fs.readFile(manager.configPath)).env, { OTHER: 'preserve', ANTHROPIC_BASE_URL: b.url, ANTHROPIC_API_KEY: b.key });
  await manager.restore();
  assert.equal(await fs.readFile(manager.configPath, 'utf8'), first);
  assert.equal(await fs.readFile(codex, 'utf8'), 'model_provider = "fixture"\n');
  assert.ok(!JSON.stringify(await manager.state()).includes(a.key));
  assert.ok(!(await fs.readFile(manager.storePath, 'utf8')).includes(a.key));
});

test('first switch can restore an absent file; external changes and competing routing are preserved', async t => {
  const { manager } = await setup(t);
  await manager.save(a);
  const [profile] = manager.store.profiles;
  await manager.switchTo(profile.id); await manager.restore();
  await assert.rejects(fs.stat(manager.configPath), { code: 'ENOENT' });
  await manager.switchTo(profile.id);
  await fs.appendFile(manager.configPath, ' ');
  await assert.rejects(manager.restore(), /其他程序修改/);
  const cloud = '{"env":{"CLAUDE_CODE_USE_BEDROCK":"1"}}';
  await fs.writeFile(manager.configPath, cloud);
  await assert.rejects(manager.switchTo(profile.id), /云路由/);
  assert.equal(await fs.readFile(manager.configPath, 'utf8'), cloud);
  await assert.rejects(manager.save({ ...a, id: profile.id, url: b.url, key: '' }), /重新填写/);
  assert.throws(() => normalizeClaudeUrl('http://example.com/v1'), /HTTPS/);
});

test('Claude selectively exports and imports independently with a secret-free preview', async t => {
  const source = await setup(t), dest = await setup(t);
  await source.manager.save(a); await source.manager.save(b);
  const bundle = await source.transfer.exportBundle([source.manager.store.profiles[1].id]);
  assert.equal(bundle.profiles.length, 1); assert.deepEqual(bundle.profiles[0], b);
  const preview = dest.transfer.preview(JSON.stringify(bundle));
  assert.ok(!JSON.stringify(preview).includes(b.key));
  await dest.transfer.apply({ token: preview.token, indices: [0], duplicates: 'skip' });
  await dest.manager.switchTo(dest.manager.store.profiles[0].id);
  assert.equal(JSON.parse(await fs.readFile(dest.manager.configPath)).env.ANTHROPIC_API_KEY, b.key);
  assert.throws(() => new TransferService(dest.manager).preview(JSON.stringify(bundle)), /配置文件/);
});

test('Claude model discovery and connection tests use Anthropic routes and never follow redirects', async t => {
  const { manager } = await setup(t);
  await manager.save(b);
  const id = manager.store.profiles[0].id;
  const models = await manager.listModels({ id, url: b.url + '/v1', auth: b.auth }, async (url, options) => {
    assert.equal(url, b.url + '/v1/models'); assert.equal(options.headers['x-api-key'], b.key);
    assert.equal(options.headers['anthropic-version'], '2023-06-01'); assert.equal(options.redirect, 'manual');
    return Response.json({ data: [{ id: 'claude-fixture' }, { id: b.key }] });
  });
  assert.deepEqual(models, ['claude-fixture']);
  await assert.rejects(manager.listModels({ id, url: a.url, auth: b.auth }, async () => assert.fail('unexpected request')), /重新填写|修改地址/);
  const tested = await testConnection({ ...b, model: 'claude-fixture' }, b.key, async (url, options) => {
    assert.equal(url, b.url + '/v1/messages'); assert.equal(options.redirect, 'manual');
    assert.equal(options.headers['x-api-key'], b.key); assert.equal(JSON.parse(options.body).model, 'claude-fixture');
    return Response.json({ type: 'message', content: [{ type: 'text', text: 'Fixture' }] });
  });
  assert.equal(tested.kind, 'ok');
});

test('Claude monitor pins credentials, accepts only Anthropic routes, and restores direct configuration', async t => {
  const { manager } = await setup(t);
  await manager.save(b);
  const id = manager.store.profiles[0].id;
  await manager.switchTo(id);
  const direct = await fs.readFile(manager.configPath, 'utf8');
  const calls = [];
  const monitor = new ClaudeMonitor(manager, { requester(url, options, callback) {
    calls.push([url.href, options.headers]);
    const request = new EventEmitter(); request.setTimeout = () => {}; request.destroy = () => {};
    request.end = () => {
      const response = Readable.from(['{"type":"message"}']);
      response.statusCode = 200; response.headers = { 'content-type': 'application/json' };
      callback(response);
    };
    return request;
  } });
  try {
    await monitor.enable(id);
    const { env } = JSON.parse(await fs.readFile(manager.configPath, 'utf8'));
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.notEqual(env.ANTHROPIC_AUTH_TOKEN, b.key);
    const url = env.ANTHROPIC_BASE_URL;
    const headers = { Authorization: 'Bearer ' + env.ANTHROPIC_AUTH_TOKEN, 'x-api-key': 'untrusted' };
    assert.equal((await fetch(url + '/v1/responses', { method: 'POST', headers })).status, 404);
    assert.equal((await fetch(url + '/v1/messages', { method: 'POST' })).status, 401);
    const result = await fetch(url + '/v1/messages?beta=true', { method: 'POST', headers, body: '{"model":"claude-fixture"}' });
    assert.equal(result.status, 200); await result.text();
    assert.equal(calls.length, 1); assert.equal(calls[0][0], b.url + '/v1/messages?beta=true');
    assert.equal(calls[0][1]['x-api-key'], b.key); assert.equal(calls[0][1].authorization, undefined);
    assert.equal(monitor.summary().success, 1);
    await fs.writeFile(manager.configPath, JSON.stringify({ env: { ...env, KEEP: 'external edit' } }));
  } finally { await monitor.shutdown(); }
  const restored = JSON.parse(await fs.readFile(manager.configPath, 'utf8'));
  assert.deepEqual(restored.env, { ...JSON.parse(direct).env, KEEP: 'external edit' });
});
