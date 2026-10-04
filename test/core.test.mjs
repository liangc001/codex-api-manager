import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Manager, updateConfig, parseConfig, restoreMonitorConfig, normalizeUrl, normalizeUsage, queryUsage, windowsCodec } from '../core.mjs';

const original = '# user comment\nmodel_provider = "custom" # provider comment\nmodel = "old"\nmodel_reasoning_effort = "high"\n\n[model_providers.custom]\nbase_url = "https://original.example/v1"\n\n[projects."C:\\\\work"]\ntrust_level = "trusted"\n\n[desktop]\nlocaleOverride = "zh-CN"\n';
const profile = { name: 'Test', url: 'https://target.example/v1', model: 'new', effort: 'xhigh' };

const legacyConfig = original.replace('base_url = "https://original.example/v1"',
  'base_url = "https://original.example/v1" # legacy URL\nwire_api = "responses"\nrequires_openai_auth = true\nrequest_max_retries = 7');

test('old conversation providers follow shared auth, preserving independent providers', () => {
  const input = legacyConfig + '\n[model_providers.other]\nbase_url = "https://other.example/v1"\nwire_api = "responses"\nrequires_openai_auth = true\nenv_key = "OTHER_API_KEY"\n'
    + '\n[model_providers.header]\nbase_url = "https://header.example/v1"\nwire_api = "responses"\nrequires_openai_auth = true\nhttp_headers = { Authorization = "independent" }\n';
  const before = parseConfig(input), result = updateConfig(input, profile), after = parseConfig(result);
  assert.equal(after.model_providers.custom.base_url, profile.url);
  assert.equal(after.model_providers.custom.request_max_retries, 7);
  assert.ok(result.includes('# legacy URL'));
  assert.deepEqual(after.model_providers.other, before.model_providers.other);
  assert.deepEqual(after.model_providers.header, before.model_providers.header);
  assert.equal(updateConfig(result, profile), result);
  const next = parseConfig(updateConfig(result, { ...profile, url: 'https://next.example/v1' }));
  assert.equal(next.model_providers.custom.base_url, next.model_providers.codex_api_manager.base_url);
});

test('monitor recovery restores legacy aliases and preserves externally edited aliases', () => {
  const direct = updateConfig(legacyConfig, profile);
  const monitored = updateConfig(direct, { ...profile, url: 'http://127.0.0.1:1234/v1' });
  assert.equal(parseConfig(monitored).model_providers.custom.base_url, 'http://127.0.0.1:1234/v1');
  const external = monitored + '\n# Codex update\n[features]\nsome_feature = true\n';
  const restored = restoreMonitorConfig(external, direct, monitored);
  assert.equal(parseConfig(restored).model_providers.custom.base_url, profile.url);
  assert.equal(parseConfig(restored).model_providers.codex_api_manager.base_url, profile.url);
  assert.equal(parseConfig(restored).features.some_feature, true);
  const manual = external.replace('"http://127.0.0.1:1234/v1" # legacy URL', '"https://manual.example/v1" # legacy URL');
  assert.equal(parseConfig(restoreMonitorConfig(manual, direct, monitored)).model_providers.custom.base_url, 'https://manual.example/v1');
  const movedDefault = external.replace('model_provider = "codex_api_manager"', 'model_provider = "other"');
  const independentlyRestored = parseConfig(restoreMonitorConfig(movedDefault, direct, monitored));
  assert.equal(independentlyRestored.model_provider, 'other');
  assert.equal(independentlyRestored.model_providers.custom.base_url, profile.url);
});

test('portable profiles switch local legacy providers on two computers and support undo', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-legacy-portable-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const codec = { encrypt: async v => Buffer.from(v).toString('base64'), decrypt: async v => Buffer.from(v, 'base64').toString() };
  const dataDir = path.join(temp, 'data');
  for (const computer of ['one', 'two']) {
    const codexHome = path.join(temp, computer); await fs.mkdir(codexHome);
    const localConfig = legacyConfig.replaceAll('custom', `custom_${computer}`);
    await fs.writeFile(path.join(codexHome, 'config.toml'), localConfig);
    await fs.writeFile(path.join(codexHome, 'auth.json'), '{"OPENAI_API_KEY":"local-key"}');
    const m = new Manager({ codexHome, dataDir, codec, origin: computer }); await m.init();
    if (computer === 'one') {
      await m.save({ ...profile, adapter: 'none', key: 'key-a' });
      await m.save({ ...profile, name: 'second', adapter: 'none', key: 'key-b' });
    }
    for (const p of m.store.profiles) {
      await m.switchTo(p.id);
      assert.equal((await m.state()).current.needsLegacySync, false);
      const config = parseConfig(await fs.readFile(m.configPath, 'utf8'));
      assert.equal(config.model_providers[`custom_${computer}`].base_url, p.url);
      assert.equal(JSON.parse(await fs.readFile(m.authPath, 'utf8')).OPENAI_API_KEY, await codec.decrypt(p.encryptedKey));
      await m.restore();
      assert.equal(await fs.readFile(m.configPath, 'utf8'), localConfig);
    }
    await m.switchTo(m.store.profiles[0].id);
    await fs.writeFile(m.configPath, (await fs.readFile(m.configPath, 'utf8')).replace('base_url = "https://target.example/v1" # legacy URL', 'base_url = "https://stale.example/v1" # legacy URL'));
    assert.equal((await m.state()).profiles[0].active, true);
    assert.equal((await m.state()).current.needsLegacySync, true);
    await m.switchTo(m.store.profiles[0].id);
    assert.equal((await m.state()).current.needsLegacySync, false);
  }
});

test('TOML changes only connection fields, preserves comments, desktop and project data', () => {
  const changed = updateConfig(original, profile);
  const before = parseConfig(original), after = parseConfig(changed);
  assert.deepEqual(after.projects, before.projects);
  assert.deepEqual(after.desktop, before.desktop);
  assert.deepEqual(after.model_providers.custom, before.model_providers.custom);
  assert.ok(changed.includes('# user comment'));
  assert.ok(changed.includes('# provider comment'));
  assert.equal(after.model, 'new');
  assert.equal(after.model_providers.codex_api_manager.base_url, profile.url);
  assert.equal(updateConfig(changed, profile), changed);
});

test('empty, CRLF and quoted TOML keys are valid', () => {
  assert.equal(parseConfig(updateConfig('', profile)).model_provider, 'codex_api_manager');
  const text = '"model" = "old"\r\n[desktop]\r\nfoo = true\r\n';
  const result = updateConfig(text, profile);
  assert.equal(parseConfig(result).model, 'new');
  assert.ok(result.includes('[desktop]\r\nfoo = true'));
});

test('URL validation disallows credential and malformed endpoints', () => {
  assert.equal(normalizeUrl('https://test.example/v1/'), 'https://test.example/v1');
  for (const url of ['http://test.example/v1', 'https://user:secret@test.example/v1', 'https://test.example/v1?token=secret', 'https://test.example/v1https://other.example/v1']) {
    assert.throws(() => normalizeUrl(url));
  }
});

test('New API stays in raw quota units and unlimited does not become a fake balance', () => {
  const result = normalizeUsage('newapi', { success: true, data: { total_available: 1500000, total_used: 100, unlimited_quota: true } });
  assert.equal(result.unit, '额度'); assert.equal(result.remaining, null); assert.equal(result.used, 100);
});

test('Sub2API supports wallet, per-key quota, and subscription windows', () => {
  assert.equal(normalizeUsage('sub2api', { balance: 3, remaining: 3, unit: 'USD' }).scope, '账户余额');
  assert.equal(normalizeUsage('sub2api', { remaining: 2, quota: { used: 1 } }).used, 1);
  const sub = normalizeUsage('sub2api', { remaining: 20, subscription: { weekly_usage_usd: 10, weekly_limit_usd: 30 }, usage: { today: { actual_cost: 1, total_tokens: 200 } } });
  assert.equal(sub.today, 1); assert.equal(sub.tokens, 200); assert.equal(sub.subscription[0].limit, 30);
  assert.throws(() => normalizeUsage('sub2api', {}));
});

test('query checks redirects manually and falls back only to known same-provider endpoints', async () => {
  const calls = [];
  const result = await queryUsage({ url: 'https://target.example/v1', adapter: 'auto' }, 'fake-key', async (url, opts) => {
    calls.push(url); assert.equal(opts.redirect, 'manual'); assert.equal(opts.headers.Authorization, 'Bearer fake-key');
    if (calls.length === 1) return { status: 404 };
    return { status: 200, ok: true, text: async () => JSON.stringify({ data: { total_available: 1, total_used: 0 } }) };
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual(calls, ['https://target.example/v1/usage', 'https://target.example/api/usage/token']);
});

test('usage query supports only the exact trailing-slash redirect without leaking keys', async () => {
  const p = { url: 'https://target.example/v1', adapter: 'newapi' }, calls = [];
  let canceled = false;
  const result = await queryUsage(p, 'fake-key', async (url, options) => {
    calls.push(url);
    if (calls.length === 1) return { status: 301, headers: { get: () => '/api/usage/token/' }, body: { cancel: async () => { canceled = true; } } };
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer fake-key');
    return { status: 200, ok: true, text: async () => JSON.stringify({ data: { total_available: 12, total_used: 3 } }) };
  });
  assert.equal(result.status, 'ok'); assert.equal(result.remaining, 12); assert.equal(canceled, true);
  assert.deepEqual(calls, ['https://target.example/api/usage/token', 'https://target.example/api/usage/token/']);
  for (const location of ['https://other.example/api/usage/token/', '/login', '/api/usage/token/?secret=1', 'https://user:pass@target.example/api/usage/token/']) {
    let count = 0;
    const rejected = await queryUsage(p, 'fake-key', async () => { count++; return { status: 302, headers: { get: () => location } }; });
    assert.equal(count, 1); assert.equal(rejected.status, 'error');
    assert.equal(rejected.message, '服务商用量接口发生不兼容的跳转');
  }
});

test('transaction backs up and restores auth, with external-edit protection', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-manager-test-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const codexHome = path.join(temp, 'codex'); await fs.mkdir(codexHome);
  await fs.writeFile(path.join(codexHome, 'config.toml'), original);
  const originalAuth = '{"OPENAI_API_KEY":"original-key","tokens":{"placeholder":true}}';
  await fs.writeFile(path.join(codexHome, 'auth.json'), originalAuth);
  const codec = { encrypt: async v => Buffer.from(v).toString('base64'), decrypt: async v => Buffer.from(v, 'base64').toString() };
  const m = new Manager({ codexHome, dataDir: path.join(temp, 'data'), codec }); await m.init();
  assert.deepEqual((await m.state()).profiles, []);
  assert.equal(await fs.readFile(m.configPath, 'utf8'), original);
  assert.equal(await fs.readFile(m.authPath, 'utf8'), originalAuth);
  await m.importCurrent();
  assert.equal((await m.state()).profiles.find(p => p.name === 'original.example').active, true);
  await m.save({ ...profile, adapter: 'auto', key: 'target-key' });
  const p = m.store.profiles.find(p => p.name === 'Test'); await m.switchTo(p.id);
  assert.equal(JSON.parse(await fs.readFile(m.authPath, 'utf8')).OPENAI_API_KEY, 'target-key');
  assert.equal((await m.state()).profiles.find(x => x.id === p.id).active, true);
  assert.ok(!(await fs.readFile(m.storePath, 'utf8')).includes('target-key'));
  await m.restore();
  assert.equal(await fs.readFile(m.configPath, 'utf8'), original);
  assert.equal(await fs.readFile(m.authPath, 'utf8'), originalAuth);
  await m.switchTo(p.id);
  await fs.appendFile(m.configPath, '\n# edited elsewhere\n');
  await assert.rejects(() => m.restore(), /其他程序修改/);
  await assert.rejects(() => m.save({ ...p, url: 'https://different.example/v1', key: '' }), /重新填写/);
  const reopened = new Manager({ codexHome, dataDir: path.join(temp, 'data'), codec });
  await reopened.init();
  assert.deepEqual(reopened.store, m.store);
});

test('current import distinguishes keys at the same URL and remains repeatable', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-import-keys-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const home = path.join(temp, 'codex'); await fs.mkdir(home);
  const codec = { encrypt: async v => Buffer.from(v).toString('base64'), decrypt: async v => Buffer.from(v, 'base64').toString() };
  const m = new Manager({ codexHome: home, dataDir: path.join(temp, 'data'), codec }); await m.init();
  const input = { ...profile, name: 'target.example', adapter: 'none', key: 'saved-key' };
  await m.save(input);
  await m.save({ ...input, name: 'target.example (2)', key: '' });
  const saved = structuredClone(m.store.profiles);
  await fs.writeFile(m.configPath, updateConfig('', { ...profile, url: `${profile.url}/` }));
  await fs.writeFile(m.authPath, JSON.stringify({ OPENAI_API_KEY: 'imported-key' }));
  assert.equal(await m.importCurrent(), true);
  assert.equal(m.store.profiles.length, 3);
  assert.deepEqual(m.store.profiles.slice(0, 2), saved);
  const imported = structuredClone(m.store.profiles[2]);
  assert.equal(imported.name, 'target.example (3)');
  assert.equal(await codec.decrypt(imported.encryptedKey), 'imported-key');
  await fs.writeFile(m.configPath, updateConfig('', { ...profile, model: 'updated-model', effort: 'low' }));
  await m.importCurrent();
  assert.equal(m.store.profiles.length, 3);
  assert.equal(m.store.profiles[2].id, imported.id);
  assert.equal(m.store.profiles[2].name, imported.name);
  assert.equal(m.store.profiles[2].model, 'updated-model');
  assert.equal(m.store.profiles[2].effort, 'low');
  await fs.writeFile(m.authPath, JSON.stringify({ OPENAI_API_KEY: 'saved-key' }));
  await m.importCurrent();
  assert.equal(m.store.profiles.length, 3);
  assert.equal(m.store.profiles[0].id, saved[0].id);
  assert.equal(m.store.profiles[0].adapter, 'none');
  const before = structuredClone(m.store);
  const disk = await fs.readFile(m.storePath, 'utf8');
  m.persist = async () => { throw new Error('simulated disk failure'); };
  for (const key of ['saved-key', 'another-key']) {
    await fs.writeFile(m.authPath, JSON.stringify({ OPENAI_API_KEY: key }));
    await fs.writeFile(m.configPath, updateConfig('', profile));
    await assert.rejects(() => m.importCurrent(), /simulated disk failure/);
    assert.deepEqual(m.store, before);
    assert.equal(await fs.readFile(m.storePath, 'utf8'), disk);
  }
});

test('failed final persistence rolls back both files after they were written', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-manager-fail-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const home = path.join(temp, 'codex'); await fs.mkdir(home);
  const codec = { encrypt: async v => v, decrypt: async v => v };
  const m = new Manager({ codexHome: home, dataDir: path.join(temp, 'data'), codec }); await m.init();
  await m.save({ ...profile, adapter: 'none', key: 'fake-key' });
  await fs.writeFile(m.configPath, original);
  await fs.writeFile(m.authPath, '{"tokens":{"placeholder":true}}');
  m.persist = async () => { throw new Error('simulated disk failure'); };
  await assert.rejects(() => m.switchTo(m.store.profiles.find(p => p.name === 'Test').id));
  assert.equal(await fs.readFile(m.configPath, 'utf8'), original);
  assert.equal(await fs.readFile(m.authPath, 'utf8'), '{"tokens":{"placeholder":true}}');
});

test('Windows DPAPI round trips Unicode without plaintext on disk', { skip: process.platform !== 'win32' }, async () => {
  const codec = windowsCodec(); const value = 'test-key-中文-123'; const ciphertext = await codec.encrypt(value);
  assert.ok(!ciphertext.includes(value)); assert.equal(await codec.decrypt(ciphertext), value);
});
