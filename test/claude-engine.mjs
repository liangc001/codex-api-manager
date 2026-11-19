// Opt-in: requires Claude Code and OpenSSL. All requests go to a local fixture.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { ClaudeManager } from '../claude.mjs';
import { portableCodec } from '../portable.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-claude-cli-'));
let server;
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', 'key.pem', '-out', 'cert.pem'], { cwd: root, stdio: 'ignore', windowsHide: true });
  const requests = [];
  server = https.createServer({ key: await fs.readFile(path.join(root, 'key.pem')), cert: await fs.readFile(path.join(root, 'cert.pem')) }, async (req, res) => {
    const parts = [];
    for await (const chunk of req) parts.push(chunk);
    if (req.method !== 'POST' || !req.url.split('?')[0].endsWith('/v1/messages')) { res.writeHead(404).end(); return; }
    const { model, stream } = JSON.parse(Buffer.concat(parts).toString());
    requests.push({ url: req.url.split('?')[0], model, bearer: req.headers.authorization, apiKey: req.headers['x-api-key'] });
    const reply = { id: 'msg_fixture', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'Fixture response' }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 2 } };
    if (!stream) { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply)); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const data of [
      { type: 'message_start', message: { ...reply, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Fixture response' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ]) res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const dataDir = path.join(root, 'data'), claudeHome = path.join(root, 'claude');
  const manager = new ClaudeManager({ dataDir, claudeHome, codec: await portableCodec(dataDir) });
  await manager.init();
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE_|HTTPS?_PROXY$|ALL_PROXY$)/i.test(k)));
  Object.assign(env, { CLAUDE_CONFIG_DIR: claudeHome, NODE_EXTRA_CA_CERTS: path.join(root, 'cert.pem'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1', NO_PROXY: '127.0.0.1' });
  for (const auth of ['bearer', 'api-key']) {
    const key = 'fixture-' + auth, model = 'claude-sonnet-4-6', url = `https://127.0.0.1:${server.address().port}/${auth}/v1`;
    await manager.save({ name: auth, url, auth, key, model });
    await manager.switchTo(manager.store.profiles.at(-1).id);
    const args = ['-p', 'Hello fixture', '--setting-sources', 'user', '--tools', '', '--no-session-persistence'];
    const { stdout } = process.platform === 'win32'
      ? await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "claude -p 'Hello fixture' --setting-sources user --tools '' --no-session-persistence"], { cwd: root, env, timeout: 25000, windowsHide: true })
      : await promisify(execFile)('claude', args, { cwd: root, env, timeout: 25000 });
    assert.match(stdout, /Fixture response/);
    assert.ok(requests.some(r => r.url === `/${auth}/v1/messages` && r.model === model &&
      (auth === 'bearer' ? r.bearer === 'Bearer ' + key && !r.apiKey : r.apiKey === key && !r.bearer)));
  }
  console.log('Claude Code CLI used the configured HTTPS route, model and header for both authentication modes.');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
