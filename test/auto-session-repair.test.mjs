import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoSessionRepair } from '../auto-session-repair.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { portableCodec } from '../portable.mjs';

function fixture() {
  let clock = 1000; let running = false; let allowed = true; let target = 'codex_api_manager';
  let entries = [{ id: 'one', eligible: true }, { id: 'bad', eligible: false }];
  const calls = [], scans = [];
  const storage = { settings: { autoSessionRepair: true, sessionRepairExclusions: ['excluded'] } };
  const monitor = { enabled: false, active: new Map(), recoveryWarning: '' };
  const repair = {
    preview: { candidates: new Map([['one', { size: 100 }]]) },
    async checkStopped() { if (running) throw Object.assign(new Error('running'), { kind: 'codex-running' }); },
    async config() { return { target }; },
    async scan(options) { scans.push(options); return { token: 'fixture', entries, pending: false, truncated: false }; },
    async apply(input) { calls.push(input); entries = []; return { count: input.ids.length }; },
  };
  const manager = { exclusive: fn => fn() };
  const worker = new AutoSessionRepair(manager, storage, monitor, { repair, now: () => clock, canRun: () => allowed });
  return { worker, repair, calls, scans, storage, monitor, advance: ms => { clock += ms; }, running: value => { running = value; }, allow: value => { allowed = value; }, target: value => { target = value; }, entries: value => { entries = value; } };
}
test('automatic migration waits for a stable process exit and only then uses the existing repair service', async () => {
  const f = fixture(); f.running(true); await f.worker.tick(); assert.equal(f.worker.state().phase, 'waiting'); assert.equal(f.scans.length, 1); assert.equal(f.calls.length, 0);
  f.running(false); await f.worker.tick(); assert.equal(f.calls.length, 0);
  f.advance(4999); await f.worker.tick(); assert.equal(f.calls.length, 0);
  f.advance(1); await f.worker.tick(); assert.deepEqual(f.calls, [{ token: 'fixture', ids: ['one'] }]);
  assert.deepEqual(f.scans[0].excludeIds, ['excluded']); assert.deepEqual(f.scans[0].skipProviders, ['openai', 'ollama', 'lmstudio']);
  assert.equal(f.worker.state().repaired, 1); await f.worker.tick(); assert.equal(f.worker.state().phase, 'idle'); assert.equal(f.calls.length, 1);
});
test('disabled option, independent current provider, monitoring, active requests and quit all prevent writes', async () => {
  const f = fixture(); f.worker.quietMs = 0;
  f.storage.settings.autoSessionRepair = false; await f.worker.tick(); assert.equal(f.scans.length, 0);
  f.storage.settings.autoSessionRepair = true; f.target('independent'); await f.worker.tick(); assert.equal(f.worker.state().phase, 'target');
  f.target('codex_api_manager'); f.monitor.enabled = true; await f.worker.tick(); assert.equal(f.worker.state().phase, 'monitor');
  f.monitor.enabled = false; f.monitor.active.set('request', {}); await f.worker.tick(); assert.equal(f.worker.state().phase, 'monitor');
  f.monitor.active.clear(); f.monitor.recoveryWarning = 'pending'; await f.worker.tick(); assert.equal(f.worker.state().phase, 'monitor');
  f.monitor.recoveryWarning = ''; f.allow(false); await f.worker.tick(); assert.equal(f.calls.length, 0);
});
test('manual repair dialog pauses background changes and release requires a fresh quiet period', async () => {
  const f = fixture(); f.worker.hold(); f.advance(10000); await f.worker.tick(); assert.equal(f.worker.state().phase, 'manual'); assert.equal(f.scans.length, 0);
  f.worker.release(); await f.worker.tick(); assert.equal(f.calls.length, 0); f.advance(5000); await f.worker.tick(); assert.equal(f.calls.length, 1);
});
test('pending crash recovery is never silently overwritten by a new automatic batch', async () => {
  const f = fixture(); f.worker.quietMs = 0;
  f.repair.scan = async () => ({ pending: true }); await f.worker.tick(); assert.equal(f.worker.state().phase, 'attention'); assert.equal(f.calls.length, 0);
});
test('unknown failures back off without disclosing transport errors or account data', async () => {
  const f = fixture(); f.worker.quietMs = 0;
  f.repair.scan = async () => { throw new Error('PRIVATE_FIXTURE'); }; await f.worker.tick();
  assert.equal(f.worker.state().phase, 'error'); assert.ok(!JSON.stringify(f.worker.state()).includes('PRIVATE_FIXTURE'));
  f.repair.scan = async options => { f.scans.push(options); return { pending: false, entries: [], truncated: false }; };
  await f.worker.tick(); assert.equal(f.scans.length, 0); f.advance(300000); await f.worker.tick(); assert.equal(f.scans.length, 1);
});
test('pages past unavailable conversations and caps each batch by file size', async () => {
  const f = fixture(); f.worker.quietMs = 0;
  f.repair.scan = async options => { f.scans.push(options); return options.offset === 0 ? { entries: [], truncated: true } : { entries: [{ id: 'one', eligible: true }], token: 'fixture', truncated: false }; };
  await f.worker.tick(); await f.worker.tick(); assert.equal(f.scans[1].offset, 3000); assert.equal(f.calls.length, 1);
  const g = fixture(); g.worker.quietMs = 0;
  g.entries(Array.from({ length: 5 }, (_, i) => ({ id: String(i), eligible: true })));
  g.repair.preview.candidates = new Map(Array.from({ length: 5 }, (_, i) => [String(i), { size: 128 * 1024 * 1024 }]));
  await g.worker.tick(); assert.equal(g.calls[0].ids.length, 3);
});
test('concurrent timer ticks cannot start overlapping migrations', async () => {
  const f = fixture(); f.worker.quietMs = 0; let release;
  f.repair.apply = async input => { f.calls.push(input); await new Promise(resolve => { release = resolve; }); return { count: 1 }; };
  const first = f.worker.tick();
  for (let i = 0; i < 10 && !release; i++) await new Promise(resolve => setImmediate(resolve));
  await f.worker.tick(); assert.equal(f.calls.length, 1); release(); await first;
});

test('a running Codex does not hide a mismatched target or simultaneous monitoring blocker', async () => {
  const f = fixture(); f.running(true); f.target('custom'); f.monitor.enabled = true;
  await f.worker.tick(); const s = f.worker.state();
  assert.equal(s.phase, 'target'); assert.equal(s.currentProvider, 'custom'); assert.equal(s.blockers.length, 3);
  assert.equal(f.calls.length, 0); assert.equal(f.scans.length, 1);
  assert.equal(f.scans[0].targetProvider, 'codex_api_manager');
  assert.equal(s.counts.eligible, 1);
});

test('running preflight exposes skipped work and scan-only counts without modifying chats', async () => {
  const f = fixture(); f.running(true); await f.worker.tick();
  assert.deepEqual(f.worker.state().counts, { scanned: 2, eligible: 1, skipped: 1, truncated: false });
  assert.ok(f.worker.state().checkedAt); assert.equal(f.worker.details().entries.length, 2); assert.equal(f.calls.length, 0);
  f.entries([{ id: 'bad', eligible: false, reason: 'missing fixture' }]); f.running(false); f.worker.quietMs = 0;
  await f.worker.tick(); assert.match(f.worker.state().message, /1 个已跳过/);
  const scans = f.scans.length; await f.worker.tick(); assert.equal(f.scans.length, scans);
  f.worker.requestCheck(); await f.worker.tick(); assert.equal(f.scans.length, scans + 1);
});

test('activity is encrypted, survives restart, records undo and excludes foreign computers', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-repair-records-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const f = fixture(); Object.assign(f.worker.manager, { dataDir: root, home: path.join(root, 'codex'), origin: 'fixture-origin', codec: await portableCodec(root) });
  f.repair.saved = async () => null; f.repair.isLocal = () => false;
  await f.worker.record({ count: 1, batchAt: '2026-11-07T01:00:00.000Z' }, [{ id: 'one', title: 'PRIVATE_TITLE_FIXTURE', provider: 'old' }]);
  assert.ok(!(await fs.readFile(f.worker.activityFile, 'utf8')).includes('PRIVATE_TITLE_FIXTURE'));
  const restarted = new AutoSessionRepair(f.worker.manager, f.storage, f.monitor, { repair: f.repair }); await restarted.init();
  assert.equal(restarted.details().records[0].entries[0].title, 'PRIVATE_TITLE_FIXTURE');
  assert.equal(restarted.state().lastRun.count, 1); assert.equal(restarted.state().lastRun.entries, undefined);
  await restarted.recordUndo({ batchAt: '2026-11-07T01:00:00.000Z' }); assert.ok(restarted.details().records[0].undoneAt);
  const foreign = new AutoSessionRepair({ ...f.worker.manager, origin: 'other-machine' }, f.storage, f.monitor, { repair: f.repair }); await foreign.init();
  assert.equal(foreign.details().records.length, 0);
});

test('specific known errors are actionable and manual check bypasses the retry delay', async () => {
  const f = fixture(); f.worker.quietMs = 0;
  f.repair.config = async () => { throw new Error('没有找到本机 Codex 会话数据库。'); };
  await f.worker.tick(); assert.match(f.worker.state().message, /先在 Codex 中创建对话/); assert.ok(f.worker.state().retryAt);
  f.repair.config = async () => ({ target: 'codex_api_manager' }); f.worker.requestCheck(); await f.worker.tick();
  assert.equal(f.calls.length, 1);
});
