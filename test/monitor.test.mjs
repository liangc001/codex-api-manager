import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Manager, parseConfig } from '../core.mjs';
import { MonitorController } from '../monitor.mjs';
import { StorageSettings } from '../storage.mjs';

const codec = { encrypt: async v => Buffer.from(v).toString('base64'), decrypt: async v => Buffer.from(v, 'base64').toString() };
async function fixture(t, handler) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-monitor-'));
  const manager = new Manager({ codexHome: path.join(temp, 'codex'), dataDir: path.join(temp, 'data'), codec });
  await manager.init();
  await manager.save({ name: 'API A', url: 'https://a.example/v1', model: 'test-model', effort: 'high', adapter: 'none', key: 'key-a' });
  await manager.save({ name: 'API B', url: 'https://b.example/v1', model: 'test-model', effort: 'high', adapter: 'none', key: 'key-b' });
  const a = manager.store.profiles[0], b = manager.store.profiles[1];
  await manager.switchTo(a.id);
  const upstream = http.createServer(handler);
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const options = { requester: (url, opts, callback) => http.request(`http://127.0.0.1:${upstream.address().port}${url.pathname}${url.search}`, opts, callback) };
  const controller = new MonitorController(manager, options); await controller.init();
  t.after(async () => { await controller.monitor.shutdown().catch(() => {}); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); await fs.rm(temp, { recursive: true, force: true }); });
  return { manager, controller, a, b, options };
}
async function until(fn) {
  for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Condition not reached');
}

test('legacy conversation follows monitor routing, switching and recovery after Codex edits', async t => {
  const { manager, controller, a, b } = await fixture(t, (_req, res) => { res.end('{}'); });
  await fs.appendFile(manager.configPath, '\n[model_providers.custom]\nbase_url = "https://a.example/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n');
  await controller.monitor.enable(a.id);
  let config = parseConfig(await fs.readFile(manager.configPath, 'utf8'));
  assert.equal(config.model_providers.custom.base_url, controller.monitor.localUrl);
  await controller.switchTo(b.id);
  config = parseConfig(await fs.readFile(manager.configPath, 'utf8'));
  assert.equal(config.model_providers.custom.base_url, controller.monitor.localUrl);
  await fs.appendFile(manager.configPath, '\n[features]\nsome_feature = true\n');
  await controller.monitor.disable();
  config = parseConfig(await fs.readFile(manager.configPath, 'utf8'));
  assert.equal(config.model_providers.custom.base_url, b.url);
  assert.equal(config.model_providers.codex_api_manager.base_url, b.url);
  assert.equal(config.features.some_feature, true);
  assert.equal(JSON.parse(await fs.readFile(manager.authPath, 'utf8')).OPENAI_API_KEY, 'key-b');
});
function request(monitor, model = 'actual-model', opts = {}) {
  return fetch(monitor.localUrl + '/responses', { method: 'POST', headers: { Authorization: `Bearer ${monitor.token}`, 'Content-Type': 'application/json', Cookie: 'do-not-forward=1' }, body: JSON.stringify({ model, input: 'private prompt' }), ...opts });
}

test('live streaming concurrency counts until EOF; provider switch pins in-flight requests', async t => {
  const connections = [];
  const { manager, controller, a, b } = await fixture(t, (req, res) => {
    assert.equal(req.headers.cookie, undefined);
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: {"part":1}\n\n'); connections.push({ res, key: req.headers.authorization, body: Buffer.concat(chunks).toString() }); });
  });
  const original = await fs.readFile(manager.configPath, 'utf8');
  await controller.setMonitoring(true);
  assert.equal((await controller.state()).profiles.find(p => p.id === a.id).active, true);
  const first = await request(controller.monitor), second = await request(controller.monitor);
  assert.equal(controller.monitor.summary().active, 2);
  assert.ok(controller.monitor.summary().firstByte >= 0);
  assert.equal(controller.monitor.summary().provider[a.id].active, 2);
  await controller.switchTo(b.id);
  const third = await request(controller.monitor);
  assert.equal(controller.monitor.summary().active, 3);
  assert.deepEqual(connections.map(c => c.key), ['Bearer key-a', 'Bearer key-a', 'Bearer key-b']);
  assert.equal(controller.monitor.summary().provider[b.id].active, 1);
  assert.ok(connections.every(c => JSON.parse(c.body).input === 'private prompt'));
  for (const c of connections) c.res.end('data: [DONE]\n\n');
  const output = await Promise.all([first.text(), second.text(), third.text()]);
  assert.ok(output.every(body => body === 'data: {"part":1}\n\ndata: [DONE]\n\n'));
  await until(() => controller.monitor.summary().active === 0);
  const stats = controller.monitor.summary();
  assert.equal(stats.peak, 3); assert.equal(stats.success, 3); assert.equal(stats.rpm, 3);
  assert.equal(stats.recent[0].model, 'actual-model');
  assert.ok(!JSON.stringify(stats).includes('private prompt')); assert.ok(!JSON.stringify(stats).includes('key-a'));
  await controller.setMonitoring(false);
  assert.ok((await fs.readFile(manager.configPath, 'utf8')).includes('https://b.example/v1'));
  assert.notEqual(await fs.readFile(manager.configPath, 'utf8'), original);
  await assert.rejects(() => fs.readFile(controller.monitor.sessionFile), { code: 'ENOENT' });
});

test('429 and authentication failures are accurate; no unauthenticated open proxy', async t => {
  const { manager, controller } = await fixture(t, (_req, res) => { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end('{"error":"limited"}'); });
  manager.storage = new StorageSettings(manager.dataDir); await manager.storage.init();
  await controller.setMonitoring(true);
  const rejected = await fetch(controller.monitor.localUrl + '/responses', { method: 'POST' });
  assert.equal(rejected.status, 401); assert.equal(controller.monitor.summary().active, 0);
  const response = await request(controller.monitor); assert.equal(response.status, 429); await response.text();
  await until(() => controller.monitor.summary().failed === 1);
  assert.equal(controller.monitor.summary().limited, 1);
  assert.equal(controller.monitor.summary().successRate, 0);
  await manager.storage.tail;
  const files = await fs.readdir(manager.storage.logDir);
  const logs = await fs.readFile(path.join(manager.storage.logDir, files[0]), 'utf8');
  const row = JSON.parse(logs.trim());
  assert.equal(row.event, 'request'); assert.equal(row.status, 429);
  assert.ok(row.durationMs >= 0);
  assert.ok(!logs.includes('private prompt') && !logs.includes('key-a'));
});

test('client cancellation releases concurrency and shuts down upstream', async t => {
  let response;
  const { controller } = await fixture(t, (_req, res) => { response = res; res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: one\n\n'); });
  await controller.setMonitoring(true);
  const abort = new AbortController();
  const result = await request(controller.monitor, 'actual', { signal: abort.signal });
  assert.equal(controller.monitor.summary().active, 1);
  abort.abort(); await result.text().catch(() => {});
  await until(() => controller.monitor.summary().active === 0);
  assert.equal(controller.monitor.summary().recent[0].label, 'cancelled');
  response.destroy();
});

test('crash recovery restores direct config; external edits are preserved', async t => {
  const { manager, controller, options } = await fixture(t, (_req, res) => res.end('{}'));
  const originalConfig = await fs.readFile(manager.configPath, 'utf8');
  const originalAuth = await fs.readFile(manager.authPath, 'utf8');
  await controller.setMonitoring(true);
  const recovery = new MonitorController(manager, options); await recovery.init();
  assert.equal(await fs.readFile(manager.configPath, 'utf8'), originalConfig);
  assert.equal(await fs.readFile(manager.authPath, 'utf8'), originalAuth);
  controller.monitor.enabled = false; controller.monitor.profile = null;
  await controller.setMonitoring(true);
  await fs.appendFile(manager.configPath, '\n# external change\n');
  const recovered = new MonitorController(manager, options); await recovered.init();
  assert.equal(recovered.monitor.recoveryWarning, '');
  assert.ok((await fs.readFile(manager.configPath, 'utf8')).includes('# external change'));
  assert.ok((await fs.readFile(manager.configPath, 'utf8')).includes('https://a.example/v1'));
  assert.equal(await fs.readFile(manager.authPath, 'utf8'), originalAuth);
  controller.monitor.enabled = false; controller.monitor.profile = null;
});

test('Codex settings updates do not block monitor switch or shutdown', async t => {
  const { manager, controller, b } = await fixture(t, (_req, res) => res.end('{}'));
  await controller.setMonitoring(true);
  await fs.appendFile(manager.configPath, '\n[desktop]\nlocaleOverride = "zh-CN"\n[mcp_servers.changed]\ncommand = "example"\n');
  await controller.switchTo(b.id);
  await fs.appendFile(manager.configPath, '\n# Codex updated preferences\n');
  await controller.monitor.shutdown();
  const text = await fs.readFile(manager.configPath, 'utf8'), config = parseConfig(text);
  assert.equal(config.desktop.localeOverride, 'zh-CN');
  assert.equal(config.mcp_servers.changed.command, 'example');
  assert.ok(text.includes('# Codex updated preferences'));
  assert.equal(config.model_providers.codex_api_manager.base_url, b.url);
  assert.equal(JSON.parse(await fs.readFile(manager.authPath, 'utf8')).OPENAI_API_KEY, 'key-b');
  assert.equal(controller.monitor.enabled, false);
  assert.equal(controller.monitor.server, null);
  assert.ok((await fs.readdir(path.join(manager.dataDir, 'backups'))).some(name => name.startsWith('monitor-conflict-')));
});

test('manual key edits survive monitor disable and unrelated auth metadata keeps its updates', async t => {
  const { manager, controller, a } = await fixture(t, (_req, res) => res.end('{}'));
  await controller.setMonitoring(true);
  await fs.writeFile(manager.authPath, JSON.stringify({ OPENAI_API_KEY: 'manually-updated-key', added: true }));
  await controller.setMonitoring(false);
  assert.equal(parseConfig(await fs.readFile(manager.configPath, 'utf8')).model_providers.codex_api_manager.base_url, a.url);
  assert.deepEqual(JSON.parse(await fs.readFile(manager.authPath, 'utf8')), { OPENAI_API_KEY: 'manually-updated-key', added: true });
  await manager.switchTo(a.id);
  await controller.setMonitoring(true);
  await fs.writeFile(manager.authPath, JSON.stringify({ OPENAI_API_KEY: controller.monitor.token, added: true }));
  await controller.setMonitoring(false);
  assert.deepEqual(JSON.parse(await fs.readFile(manager.authPath, 'utf8')), { OPENAI_API_KEY: 'key-a', added: true });
});

test('external provider changes are preserved and conflict no longer prevents exit', async t => {
  const { manager, controller } = await fixture(t, (_req, res) => res.end('{}'));
  await controller.setMonitoring(true);
  const config = 'model_provider = "external"\n[model_providers.external]\nbase_url = "https://external.example/v1"\n';
  const auth = '{"OPENAI_API_KEY":"external-key"}';
  await fs.writeFile(manager.configPath, config); await fs.writeFile(manager.authPath, auth);
  await controller.monitor.shutdown();
  assert.equal(await fs.readFile(manager.configPath, 'utf8'), config);
  assert.equal(await fs.readFile(manager.authPath, 'utf8'), auth);
  assert.equal(controller.monitor.enabled, false);
  assert.equal(controller.monitor.server, null);
  await assert.rejects(fs.readFile(controller.monitor.sessionFile), { code: 'ENOENT' });
});

test('a restored direct URL cannot keep the monitor token as its provider key', async t => {
  const { manager, controller, options } = await fixture(t, (_req, res) => res.end('{}'));
  await controller.setMonitoring(true);
  const snapshot = { ...controller.monitor.snapshot };
  delete snapshot.monitoredConfig; delete snapshot.monitoredAuth;
  await fs.writeFile(controller.monitor.sessionFile, await codec.encrypt(JSON.stringify(snapshot)));
  const direct = snapshot.config + '\n# Codex restored URL and updated preferences\n';
  await fs.writeFile(manager.configPath, direct);
  await fs.writeFile(manager.authPath, JSON.stringify({ OPENAI_API_KEY: controller.monitor.token, added: true }));
  const recovery = new MonitorController(manager, options); await recovery.init();
  assert.equal(await fs.readFile(manager.configPath, 'utf8'), direct);
  assert.deepEqual(JSON.parse(await fs.readFile(manager.authPath, 'utf8')), { OPENAI_API_KEY: 'key-a', added: true });
  controller.monitor.enabled = false; controller.monitor.profile = null;
});

test('legacy snapshots recover local monitor routes while preserving model and provider edits', async t => {
  const { manager, controller, options, a } = await fixture(t, (_req, res) => res.end('{}'));
  await controller.setMonitoring(true);
  const snapshot = { ...controller.monitor.snapshot };
  delete snapshot.monitoredConfig; delete snapshot.monitoredAuth;
  await fs.writeFile(controller.monitor.sessionFile, await codec.encrypt(JSON.stringify(snapshot)));
  let current = await fs.readFile(manager.configPath, 'utf8');
  current = current.replace('model_reasoning_effort = "high"', 'model_reasoning_effort = "low"');
  current += 'request_max_retries = 6\n';
  await fs.writeFile(manager.configPath, current);
  await fs.writeFile(manager.authPath, '{"OPENAI_API_KEY":"manually-updated-key"}');
  const recovery = new MonitorController(manager, options); await recovery.init();
  const config = parseConfig(await fs.readFile(manager.configPath, 'utf8'));
  assert.equal(config.model_reasoning_effort, 'low');
  assert.equal(config.model_providers.codex_api_manager.base_url, a.url);
  assert.equal(config.model_providers.codex_api_manager.request_max_retries, 6);
  assert.equal(JSON.parse(await fs.readFile(manager.authPath, 'utf8')).OPENAI_API_KEY, 'manually-updated-key');
  controller.monitor.enabled = false; controller.monitor.profile = null;
});

test('shutdown restores direct configuration and drains existing streams', async t => {
  let stream;
  const { manager, controller } = await fixture(t, (_req, res) => { stream = res; res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: waiting\n\n'); });
  const original = await fs.readFile(manager.configPath, 'utf8');
  await controller.setMonitoring(true);
  const response = await request(controller.monitor);
  let stopped = false;
  const stopping = controller.monitor.shutdown().then(() => { stopped = true; });
  await until(() => !controller.monitor.enabled);
  assert.equal(await fs.readFile(manager.configPath, 'utf8'), original);
  assert.equal(stopped, false);
  stream.end('data: done\n\n'); await response.text(); await stopping;
  assert.equal(controller.monitor.summary().active, 0);
  assert.equal(stopped, true);
});

test('failed activation cannot overwrite an unresolved recovery snapshot', async t => {
  const { manager, controller, a } = await fixture(t, (_req, res) => res.end('{}'));
  const writePair = manager.writePair.bind(manager);
  manager.writePair = async () => { throw new Error('simulated permission failure'); };
  await assert.rejects(() => controller.monitor.enable(a.id), /permission failure/);
  const snapshot = await fs.readFile(controller.monitor.sessionFile, 'utf8');
  await assert.rejects(() => controller.monitor.enable(a.id), /未恢复的监控备份/);
  assert.equal(await fs.readFile(controller.monitor.sessionFile, 'utf8'), snapshot);
  manager.writePair = writePair;
});
