import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { testConnection, classifyFailure, diagnosticReport, exportDiagnostics } from '../support.mjs';
import { Manager } from '../core.mjs';
import { StorageSettings } from '../storage.mjs';

const profile = { url: 'https://test.example/v1', model: 'test-model' };
const key = 'private-key-do-not-export';
const stream = events => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });

test('actual test request uses the selected model and key, and requires completed model response', async () => {
  let calls = 0;
  const result = await testConnection(profile, key, async (url, opts) => {
    calls++;
    assert.equal(url, profile.url + '/responses'); assert.equal(opts.redirect, 'manual');
    assert.equal(opts.headers.Authorization, 'Bearer ' + key);
    const body = JSON.parse(opts.body); assert.equal(body.model, profile.model); assert.equal(body.store, false);
    assert.equal(body.input[0].content[0].text, '你好');
    return stream([{ type: 'response.output_text.delta', delta: 'private model response' }, { type: 'response.completed', response: { status: 'completed' } }]);
  });
  assert.equal(calls, 1); assert.equal(result.kind, 'ok'); assert.equal(result.httpStatus, 200);
  assert.ok(!JSON.stringify(result).includes(key)); assert.ok(!JSON.stringify(result).includes('private model response'));
  const incomplete = await testConnection(profile, key, async () => stream([{ type: 'response.created' }]));
  assert.equal(incomplete.kind, 'format');
  const json = await testConnection(profile, key, async () => Response.json({ status: 'completed', output: [{ content: [] }] }));
  assert.equal(json.kind, 'ok');
});

test('HTTP and streamed errors receive fixed actionable messages, never remote bodies', async () => {
  for (const [status, message, code, expected] of [
    [401, 'Invalid API key ' + key, 'INVALID_API_KEY', 'auth'],
    [400, "The 'test-model' model is not supported when using Codex with a ChatGPT account.", '', 'model'],
    [429, 'All available accounts are currently rate-limited.', '', 'limited'],
    [429, 'balance ' + key, 'insufficient_quota', 'quota'],
    [403, key, '', 'permission'], [404, key, '', 'endpoint'], [503, key, '', 'upstream'],
  ]) {
    assert.equal(classifyFailure(status, message, code), expected);
    const r = await testConnection(profile, key, async () => Response.json({ error: { message, code } }, { status }));
    assert.equal(r.kind, expected); assert.ok(r.hint); assert.ok(!JSON.stringify(r).includes(key));
  }
  const streamed = await testConnection(profile, key, async () => stream([{ type: 'error', code: 'model_not_found', message: key }]));
  assert.equal(streamed.kind, 'model');
  const incomplete = await testConnection(profile, key, async () => stream([{ type: 'response.incomplete' }]));
  assert.equal(incomplete.kind, 'format');
  let calls = 0;
  const redirect = await testConnection(profile, key, async () => { calls++; return new Response('', { status: 307, headers: { location: 'https://other.example/v1' } }); });
  assert.equal(redirect.kind, 'redirect'); assert.equal(calls, 1);
  const large = await testConnection(profile, key, async () => new Response('x'.repeat(1024 * 1024 + 1)));
  assert.equal(large.kind, 'format');
  for (const [name, code, expected] of [['TimeoutError', '', 'timeout'], ['TypeError', 'CERT_HAS_EXPIRED', 'certificate'], ['TypeError', 'ECONNREFUSED', 'network']]) {
    const r = await testConnection(profile, key, async () => { const e = new Error(key); e.name = name; e.cause = { code }; throw e; });
    assert.equal(r.kind, expected); assert.ok(!JSON.stringify(r).includes(key));
  }
});

test('diagnostics rebuild metadata by allowlist, exclude secrets and reject runtime folders', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-diagnostics-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const manager = new Manager({ codexHome: path.join(temp, 'codex'), dataDir: path.join(temp, 'data'), codec: { encrypt: async v => v, decrypt: async v => v } });
  await manager.init(); const storage = new StorageSettings(manager.dataDir, { portable: true }); await storage.init();
  await manager.save({ ...profile, name: key, effort: 'high', adapter: 'none', key });
  const p = manager.store.profiles[0]; await manager.switchTo(p.id);
  manager.connectionTests.set(p.id, { kind: 'auth', httpStatus: 401, durationMs: 25, checkedAt: new Date().toISOString(), key, message: key, reply: key });
  await storage.record('operation', { operation: 'test-connection', outcome: 'error', status: 401, errorKind: 'auth', key, body: key });
  const file = path.join(storage.logDir, (await fs.readdir(storage.logDir))[0]);
  await fs.appendFile(file, JSON.stringify({ time: new Date().toISOString(), event: 'request', status: 429, message: key, url: profile.url, path: temp, prompt: key }) + '\n');
  const report = await diagnosticReport(manager, storage, {}, '1.0.18');
  const raw = JSON.stringify(report);
  for (const privateValue of [key, profile.url, temp, p.id]) assert.ok(!raw.includes(privateValue));
  assert.equal(report.profiles[0].test.kind, 'auth'); assert.equal(report.events.at(-1).status, 429);
  await exportDiagnostics(path.join(temp, 'diagnostics.json'), manager, storage, {}, '1.0.18');
  const exported = JSON.parse(await fs.readFile(path.join(temp, 'diagnostics.json'), 'utf8'));
  assert.equal(exported.appVersion, '1.0.18');
  await assert.rejects(() => exportDiagnostics(path.join(manager.dataDir, 'profiles.json'), manager, storage, {}, '1.0.18'), /目录之外/);
  await assert.rejects(() => exportDiagnostics(path.join(manager.home, 'auth.json'), manager, storage, {}, '1.0.18'), /目录之外/);
});
