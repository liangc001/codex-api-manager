import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { SessionRepair, replaceSessionProvider } from '../session-repair.mjs';
import { portableCodec } from '../portable.mjs';

const id = '11111111-1111-4111-8111-111111111111';
export async function repairFixture(root, source = 'old', target = 'codex_api_manager') {
  const home = path.join(root, 'codex'), dataDir = path.join(root, 'data');
  await fs.mkdir(path.join(home, 'sessions'), { recursive: true }); await fs.mkdir(dataDir, { recursive: true });
  const configPath = path.join(home, 'config.toml');
  await fs.writeFile(configPath, `model_provider = "${target}"\n[model_providers.${target}]\nbase_url = "https://provider.example/v1"\n`);
  const file = path.join(home, 'sessions', 'synthetic.jsonl');
  const header = Buffer.from(JSON.stringify({ type: 'session_meta', payload: { id, model_provider: source, base_instructions: { text: 'keep old model_provider text intact' } } }) + '\r\n');
  const tail = Buffer.from('{"type":"response_item","payload":{"text":"原始聊天 old 模型 🦋"}}\r\n');
  const original = Buffer.concat([header, tail]); await fs.writeFile(file, original);
  const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,model_provider TEXT,title TEXT,updated_at INTEGER,history_mode TEXT)');
  db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?)').run(id, file, source, '测试对话', 100, 'paginated'); db.close();
  const history = new DatabaseSync(path.join(home, 'thread_history_1.sqlite'));
  history.exec('CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,rollout_byte_offset INTEGER,rollout_end_byte_offset INTEGER); CREATE TABLE thread_history_projection_state(thread_id TEXT PRIMARY KEY,next_rollout_byte_offset INTEGER)');
  history.prepare('INSERT INTO thread_turns VALUES (?,?,?,?)').run(id, 'turn-one', header.length, original.length);
  history.prepare('INSERT INTO thread_history_projection_state VALUES (?,?)').run(id, original.length); history.close();
  const manager = { home, configPath, dataDir, origin: 'synthetic-only', codec: await portableCodec(dataDir) };
  return { manager, file, original, header, tail, id, source, target };
}
async function setup(t, source, target) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-repair-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixture = await repairFixture(root, source, target);
  fixture.service = new SessionRepair(fixture.manager, { assertStopped: async () => {} });
  return fixture;
}
function provider(f) { const db = new DatabaseSync(path.join(f.manager.home, 'state_5.sqlite')); try { return db.prepare('SELECT model_provider FROM threads WHERE id=?').get(f.id).model_provider; } finally { db.close(); } }
function offsets(f) { const db = new DatabaseSync(path.join(f.manager.home, 'thread_history_1.sqlite')); try { return { ...db.prepare('SELECT rollout_byte_offset,rollout_end_byte_offset FROM thread_turns').get(), ...db.prepare('SELECT next_rollout_byte_offset FROM thread_history_projection_state').get() }; } finally { db.close(); } }
async function apply(f) { const preview = await f.service.scan(); return f.service.apply({ token: preview.token, ids: [f.id] }); }

test('provider migration preserves all history bytes and adjusts paginated byte offsets; exact undo', async t => {
  const f = await setup(t); const beforeOffsets = offsets(f);
  await apply(f); const bytes = await fs.readFile(f.file); const first = bytes.indexOf(10) + 1;
  assert.equal(provider(f), f.target); assert.equal(JSON.parse(bytes.subarray(0, first)).payload.model_provider, f.target);
  assert.deepEqual(bytes.subarray(first), f.tail);
  const delta = first - f.header.length;
  assert.ok(delta > 0);
  assert.deepEqual(offsets(f), Object.fromEntries(Object.entries(beforeOffsets).map(([k, v]) => [k, v + delta])));
  const encrypted = await fs.readFile(f.service.journal, 'utf8');
  assert.ok(!encrypted.includes('base_instructions')); assert.ok(!encrypted.includes('测试对话'));
  await f.service.undo(); assert.equal(provider(f), f.source); assert.deepEqual(await fs.readFile(f.file), f.original); assert.deepEqual(offsets(f), beforeOffsets);
});
test('shorter provider pads legal JSON whitespace and keeps all history offsets unchanged', async t => {
  const f = await setup(t, 'very_long_old_provider_name', 'next'); const before = offsets(f);
  await apply(f); assert.equal((await fs.stat(f.file)).size, f.original.length); assert.deepEqual(offsets(f), before);
  await f.service.undo(); assert.deepEqual(await fs.readFile(f.file), f.original);
});
test('running Codex, expired preview, config edits and modified files block migration', async t => {
  const f = await setup(t); const preview = await f.service.scan();
  f.service.assertStopped = async () => { throw new Error('running'); };
  await assert.rejects(f.service.apply({ token: preview.token, ids: [f.id] }), /running/);
  f.service.assertStopped = async () => {};
  await assert.rejects(f.service.apply({ token: 'invalid', ids: [f.id] }), /重新扫描/);
  await fs.appendFile(f.manager.configPath, '# changed'); await assert.rejects(f.service.apply({ token: preview.token, ids: [f.id] }), /配置已改变/);
  const next = await f.service.scan(); await fs.appendFile(f.file, '\n');
  await assert.rejects(f.service.apply({ token: next.token, ids: [f.id] }), /已改变/); assert.equal(provider(f), f.source);
});
test('undo refuses to overwrite conversation continued after repair', async t => {
  const f = await setup(t); await apply(f); await fs.appendFile(f.file, '{"new":"history"}\n');
  const changed = await fs.readFile(f.file); await assert.rejects(f.service.undo(), /继续写入/); assert.deepEqual(await fs.readFile(f.file), changed); assert.equal(provider(f), f.target);
});
test('failure between file replacement and database commit compensates entire operation', async t => {
  const f = await setup(t); f.service.fault = async phase => { if (phase === 'file') throw new Error('injected interruption'); };
  await assert.rejects(apply(f), /injected interruption/); assert.equal(provider(f), f.source); assert.deepEqual(await fs.readFile(f.file), f.original); assert.equal((await f.service.saved()).phase, 'reverted');
});
test('failure after database commit recovers from persistent encrypted journal', async t => {
  const f = await setup(t); f.service.fault = async phase => { if (phase === 'committed') throw new Error('injected committed crash'); };
  await assert.rejects(apply(f), /injected committed crash/); assert.equal(provider(f), f.source); assert.deepEqual(await fs.readFile(f.file), f.original);
});
test('restart recovers mixed on-disk state without overwriting unrelated threads', async t => {
  const f = await setup(t); await apply(f);
  const journal = await f.service.saved(); journal.phase = 'prepared'; await f.service.save(journal);
  await fs.writeFile(f.file, f.original); // Simulate one side of interrupted compensation.
  f.service = new SessionRepair(f.manager, { assertStopped: async () => {} });
  assert.equal((await f.service.scan()).pending, true); await f.service.undo(); assert.equal(provider(f), f.source); assert.deepEqual(await fs.readFile(f.file), f.original);
});
test('unknown history offset columns stop repair before files are modified', async t => {
  const f = await setup(t); const db = new DatabaseSync(path.join(f.manager.home, 'thread_history_1.sqlite'));
  db.exec('ALTER TABLE thread_turns ADD COLUMN new_byte_offset INTEGER'); db.close();
  await assert.rejects(apply(f), /未知历史偏移字段/); assert.deepEqual(await fs.readFile(f.file), f.original);
});
test('provider disagreement is skipped during scan', async t => {
  const f = await setup(t); const db = new DatabaseSync(path.join(f.manager.home, 'state_5.sqlite'));
  db.prepare('UPDATE threads SET model_provider=?').run('different'); db.close();
  const preview = await f.service.scan(); assert.equal(preview.entries[0].eligible, false); assert.match(preview.entries[0].reason, /不一致/);
});
test('only direct provider token changes; embedded names, escaped strings and CRLF survive', () => {
  const header = Buffer.from('{"type":"session_meta","payload":{"id":"'+id+'","text":"escaped \\\"model_provider\\\": old", "model_provider" : "old","nested":{"model_provider":"old"}}}\r\n');
  const changed = replaceSessionProvider(header, id, 'old', 'longer-provider');
  assert.deepEqual(JSON.parse(changed).payload.nested, { model_provider: 'old' });
  assert.ok(changed.toString().endsWith('\r\n')); assert.ok(changed.toString().includes('"model_provider" : "longer-provider"'));
});
test('a failure on a later conversation restores the whole selected batch', async t => {
  const f = await setup(t);
  const secondId = '22222222-2222-4222-8222-222222222222';
  const second = path.join(f.manager.home, 'sessions', 'second.jsonl');
  const secondOriginal = Buffer.from(f.original.toString().replaceAll(f.id, secondId)); await fs.writeFile(second, secondOriginal);
  const db = new DatabaseSync(path.join(f.manager.home, 'state_5.sqlite'));
  db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?)').run(secondId, second, f.source, 'second fixture', 99, 'legacy'); db.close();
  let count = 0; f.service.fault = async phase => { if (phase === 'file' && ++count === 2) throw new Error('second file interruption'); };
  const preview = await f.service.scan();
  await assert.rejects(f.service.apply({ token: preview.token, ids: [f.id, secondId] }), /second file/);
  assert.equal(provider(f), f.source); assert.deepEqual(await fs.readFile(f.file), f.original); assert.deepEqual(await fs.readFile(second), secondOriginal);
});
test('outside paths and foreign backups are never overwritten', async t => {
  const f = await setup(t); const db = new DatabaseSync(path.join(f.manager.home, 'state_5.sqlite'));
  db.prepare('UPDATE threads SET rollout_path=?').run(path.join(f.manager.dataDir, 'external.jsonl')); db.close();
  let preview = await f.service.scan(); assert.equal(preview.entries[0].eligible, false); assert.match(preview.entries[0].reason, /外部会话/);
  const restore = new DatabaseSync(path.join(f.manager.home, 'state_5.sqlite')); restore.prepare('UPDATE threads SET rollout_path=?').run(f.file); restore.close();
  await apply(f); const changed = await fs.readFile(f.file);
  f.manager.origin = 'another-computer'; await assert.rejects(f.service.undo(), /另一台电脑/); assert.deepEqual(await fs.readFile(f.file), changed);
});
test('malformed metadata does not expose any part of the source text in errors', () => {
  assert.throws(() => replaceSessionProvider(Buffer.from('{"secret":"PRIVATE_FIXTURE",broken}\n'), id, 'old', 'new'), error => !error.message.includes('PRIVATE_FIXTURE'));
});

test('portable foreign backup cannot undo locally but permits fresh local repair', async t => {
  const f = await setup(t); await apply(f);
  f.manager.origin = 'another-computer';
  await assert.rejects(f.service.undo(), /另一台电脑/);
  const preview = await f.service.scan(); assert.equal(preview.undo, false); assert.equal(preview.pending, false);
  await fs.writeFile(f.file, f.original);
  const db = new DatabaseSync(path.join(f.manager.home, 'state_5.sqlite'));
  db.prepare('UPDATE threads SET model_provider=?').run(f.source); db.close();
  await apply(f); assert.equal(provider(f), f.target);
  assert.equal((await f.service.saved()).origin, 'another-computer');
  assert.ok((await fs.readdir(path.dirname(f.service.journal))).length >= 2);
});
test('undo rejects newly hydrated index rows even if the rollout file stayed unchanged', async t => {
  const f = await setup(t); await apply(f); const before = await fs.readFile(f.file);
  const db = new DatabaseSync(path.join(f.manager.home, 'thread_history_1.sqlite'));
  db.prepare('INSERT INTO thread_turns VALUES (?,?,?,?)').run(f.id, 'hydrated-later', 0, before.length); db.close();
  await assert.rejects(f.service.undo(), /索引已新增或重建/);
  assert.deepEqual(await fs.readFile(f.file), before); assert.equal(provider(f), f.target);
});
