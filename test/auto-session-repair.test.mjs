import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoSessionRepair } from '../auto-session-repair.mjs';

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
  const f = fixture(); f.running(true); await f.worker.tick(); assert.equal(f.worker.state().phase, 'waiting'); assert.equal(f.scans.length, 0);
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
