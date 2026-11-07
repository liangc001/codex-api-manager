// Opt-in integration test: a local stub supplies all model responses. No real account is used.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import readline from 'node:readline';
import assert from 'node:assert/strict';
import { SessionRepair } from '../session-repair.mjs';
import { AutoSessionRepair } from '../auto-session-repair.mjs';
import { portableCodec } from '../portable.mjs';

const binary = process.env.CODEX_REPAIR_TEST_BINARY;
if (!binary) throw new Error('Set CODEX_REPAIR_TEST_BINARY to the Codex app-server executable.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'session-engine-'));
const home = path.join(temp, 'codex'), dataDir = path.join(temp, 'data');
await fs.mkdir(home); await fs.mkdir(dataDir);
let requests = 0;
const stub = http.createServer((req, res) => {
  requests++;
  req.resume();
  const output = { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Synthetic preserved answer.', annotations: [] }] };
  const response = { id: 'resp_fixture', object: 'response', status: 'completed', output: [output], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...output, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Synthetic preserved answer.' },
    { type: 'response.output_item.done', output_index: 0, item: output },
    { type: 'response.completed', response },
  ]) res.write('data: ' + JSON.stringify(event) + '\n\n');
  res.end();
});
await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
const configPath = path.join(home, 'config.toml');
const config = provider => `model="test-model"\nmodel_provider="${provider}"\napproval_policy="never"\n[model_providers.original]\nname="Fixture original"\nbase_url="http://127.0.0.1:${stub.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=true\n[model_providers.codex_api_manager]\nname="Fixture target"\nbase_url="http://127.0.0.1:${stub.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=true\n`;
class Server {
  constructor() {
    const env = { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: 'isolated-fake-key' };
    for (const key of ['CODEX_API_KEY', 'CODEX_API_URL', 'OPENAI_BASE_URL']) delete env[key];
    this.child = spawn(binary, ['app-server', '--stdio'], { cwd: home, env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.waiting = new Map(); this.events = []; this.seq = 0;
    readline.createInterface({ input: this.child.stdout }).on('line', line => {
      let data; try { data = JSON.parse(line); } catch { return; }
      if (data.id != null && this.waiting.has(data.id)) { this.waiting.get(data.id)(data); this.waiting.delete(data.id); }
      else this.events.push(data);
    });
  }
  async call(method, params) {
    const id = ++this.seq;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error('Timed out: ' + method)); }, 30000);
      this.waiting.set(id, data => { clearTimeout(timer); resolve(data); });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async init() { const response = await this.call('initialize', { clientInfo: { name: 'repair_engine_test', version: '1.0' }, capabilities: { experimentalApi: true } }); assert.ok(response.result); this.child.stdin.write('{"method":"initialized"}\n'); }
  async completed() {
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      const event = this.events.find(e => e.method === 'turn/completed');
      if (event) { assert.equal(event.params.turn.status, 'completed', JSON.stringify(event.params.turn.error)); return; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('No completed local fixture turn');
  }
  async close() { this.child.stdin.end(); await new Promise(resolve => { const timer = setTimeout(() => this.child.kill(), 5000); this.child.once('exit', () => { clearTimeout(timer); resolve(); }); }); }
}
let server;
try {
  console.log('Engine', execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim());
  await fs.writeFile(configPath, config('original'));
  server = new Server(); await server.init();
  const started = await server.call('thread/start', { cwd: home, modelProvider: 'original', historyMode: 'paginated' });
  assert.ok(started.result, JSON.stringify(started.error));
  const id = started.result.thread.id;
  const turn = await server.call('turn/start', { threadId: id, input: [{ type: 'text', text: 'Synthetic user history for migration.', text_elements: [] }] });
  assert.ok(turn.result, JSON.stringify(turn.error)); await server.completed(); await server.close(); server = null;
  await fs.writeFile(configPath, config('codex_api_manager'));
  server = new Server(); await server.init();
  const mismatch = await server.call('thread/resume', { threadId: id });
  assert.ok(mismatch.error, 'Current engine should reproduce provider mismatch');
  assert.match(mismatch.error.message, /current provider|provider mismatch/i);
  console.log('Original mismatch reproduced'); await server.close(); server = null;
  const manager = { home, configPath, dataDir, origin: 'isolated-engine-test', codec: await portableCodec(dataDir) };
  const service = new SessionRepair(manager, { assertStopped: async () => { assert.equal(server, null); } });
  const scan = await service.scan(); assert.equal(scan.entries.find(e => e.id === id)?.eligible, true);
  manager.exclusive = operation => operation();
  const auto = new AutoSessionRepair(manager, { settings: { autoSessionRepair: true, sessionRepairExclusions: [] } }, { enabled: false, active: new Map() }, { repair: service, quietMs: 0 });
  await auto.tick(); assert.equal(auto.state().repaired, 1);
  server = new Server(); await server.init();
  const resumed = await server.call('thread/resume', { threadId: id, excludeTurns: true });
  assert.ok(resumed.result, JSON.stringify(resumed.error)); assert.equal(resumed.result.thread.modelProvider, 'codex_api_manager');
  const turns = await server.call('thread/turns/list', { threadId: id, limit: 20 });
  assert.ok(turns.result, JSON.stringify(turns.error));
  const history = JSON.stringify(turns.result); assert.match(history, /Synthetic user history/); assert.match(history, /Synthetic preserved answer/);
  console.log('Migrated paginated thread resumed and both user/assistant history hydrated');
  await server.close(); server = null;
  // Resuming can update indexes; verify rollback on unchanged fixture history where possible.
  assert.equal(requests, 1, 'No upstream request should occur during scan/migration/resume');
  console.log('Engine integration passed; model traffic was exactly one local stub request.');
} finally {
  if (server) await server.close();
  await new Promise(resolve => stub.close(resolve));
  // App-server helpers can briefly hold Windows directory handles.
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}
