import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { Updater, newerVersion, releaseAsset, installScript } from '../updater.mjs';

const bytes = Buffer.from('fake-new-executable-for-test-only');
const digest = crypto.createHash('sha256').update(bytes).digest('hex');
const release = { tag_name: 'v1.0.25', assets: [{ name: 'Codex-API-Manager.exe', state: 'uploaded', size: bytes.length,
  browser_download_url: 'https://github.com/liangc001/codex-api-manager/releases/download/v1.0.25/Codex-API-Manager.exe', digest: 'sha256:' + digest }] };

async function fixture(t, response = () => new Response(bytes)) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'manager updater & quote-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const target = path.join(temp, "custom name's app.exe"); await fs.writeFile(target, 'original-executable');
  const data = path.join(temp, 'data'); await fs.mkdir(data); await fs.writeFile(path.join(data, 'profiles.json'), 'private-fixture-do-not-touch');
  const requests = [];
  const updater = new Updater({ version: '1.0.24', target, root: path.join(data, 'cache', 'updates'), fetcher: async (url, options) => {
    requests.push({ url, options });
    return url.includes('api.github.com') ? Response.json(release) : response();
  } });
  return { temp, target, data, updater, requests };
}
test('updates compare numeric stable versions and reject wrong assets, URLs and missing hashes', () => {
  assert.equal(newerVersion('1.0.25', '1.0.24'), true); assert.equal(newerVersion('1.0.9', '1.0.24'), false);
  assert.equal(newerVersion('1.0.25-beta', '1.0.24'), false); assert.equal(newerVersion('2.0.0', '1.9.99'), true);
  assert.equal(releaseAsset(release, '1.0.25'), null);
  for (const field of [{ digest: null }, { browser_download_url: 'https://other.example/file.exe' }, { size: 400 * 1024 * 1024 }, { name: 'wrong.exe' }]) {
    assert.throws(() => releaseAsset({ ...release, assets: [{ ...release.assets[0], ...field }] }, '1.0.24'));
  }
  assert.throws(() => releaseAsset({ ...release, prerelease: true }, '1.0.24'));
  const legacy = { ...release.assets[0], name: 'Codex-API-Manager-1.0.25-Windows-x64.exe', browser_download_url: 'https://github.com/liangc001/codex-api-manager/releases/download/v1.0.25/Codex-API-Manager-1.0.25-Windows-x64.exe' };
  assert.equal(releaseAsset({ ...release, assets: [legacy] }, '1.0.24').url, legacy.browser_download_url);
  assert.equal(releaseAsset({ ...release, assets: [legacy, release.assets[0]] }, '1.0.24').url, release.assets[0].browser_download_url);
});
test('update downloads are authenticated by release digest and never change the executable or personal data before exit', async t => {
  const { updater, target, data, requests } = await fixture(t);
  assert.equal((await updater.check()).phase, 'available');
  const jobPath = await updater.prepare(); const job = JSON.parse(await fs.readFile(jobPath, 'utf8'));
  assert.equal(job.digest, digest); assert.equal(job.target, target); assert.equal(updater.state().progress, 100);
  assert.equal(await fs.readFile(target, 'utf8'), 'original-executable');
  assert.equal(await fs.readFile(path.join(data, 'profiles.json'), 'utf8'), 'private-fixture-do-not-touch');
  for (const request of requests) {
    assert.equal(request.options.credentials, 'omit'); assert.equal(request.options.headers?.Authorization, undefined);
    assert.equal(Object.hasOwn(request.options, 'body'), false);
  }
  assert.ok(!JSON.stringify(updater.state()).includes(target)); assert.ok(!JSON.stringify(updater.state()).includes(jobPath));
});
test('truncated or mismatched updates leave existing software and configuration intact', async t => {
  for (const contents of [Buffer.from('bad'), Buffer.alloc(bytes.length)]) {
    const { updater, target, data } = await fixture(t, () => new Response(contents));
    await updater.check(); await assert.rejects(() => updater.prepare(), /旧版本已保留/);
    assert.equal(await fs.readFile(target, 'utf8'), 'original-executable');
    assert.equal(await fs.readFile(path.join(data, 'profiles.json'), 'utf8'), 'private-fixture-do-not-touch');
    assert.deepEqual(await fs.readdir(updater.root), []);
  }
});
test('check errors are fixed messages and can be retried without leaking transport content', async t => {
  const { updater } = await fixture(t); const original = updater.fetcher;
  updater.fetcher = async () => { throw new Error('fake-secret private-path https://private.example'); };
  const result = await updater.check(); assert.equal(result.phase, 'error'); assert.ok(!JSON.stringify(result).includes('fake-secret'));
  updater.fetcher = original; assert.equal((await updater.check()).phase, 'available');
});
test('Windows updater waits for readiness, replaces only the EXE and restores it on launch failure', { skip: process.platform !== 'win32' }, async t => {
  for (const mode of ['success', 'launch-failure', 'no-ready', 'tampered']) {
    const { updater, target, data } = await fixture(t); await updater.check(); const jobPath = await updater.prepare();
    const job = JSON.parse(await fs.readFile(jobPath, 'utf8')); job.pid = 99999999; await fs.writeFile(jobPath, JSON.stringify(job));
    if (mode !== 'no-ready') await fs.writeFile(jobPath + '.ready', 'ready');
    if (mode === 'tampered') await fs.writeFile(path.join(path.dirname(jobPath), 'app.exe'), 'tampered');
    const mock = mode === 'launch-failure' ? "function Start-Process { throw 'simulated launch failure' }\n" : "function Start-Process {}\n";
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(mock + installScript, 'utf16le').toString('base64')],
      { env: { ...process.env, CODEX_MANAGER_UPDATE_JOB: jobPath }, windowsHide: true, encoding: 'utf8', timeout: 15000 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    assert.equal(await fs.readFile(target, 'utf8'), mode === 'success' ? bytes.toString() : 'original-executable', result.stdout);
    assert.equal(await fs.readFile(path.join(data, 'profiles.json'), 'utf8'), 'private-fixture-do-not-touch');
    if (mode === 'success') {
      updater.version = '1.0.25'; await updater.cleanCompleted(); assert.deepEqual(await fs.readdir(updater.root), []);
    }
  }
});

test('Windows hidden update launcher acknowledges a running helper before commit', { skip: process.platform !== 'win32' }, async t => {
  const { updater, target } = await fixture(t);
  await updater.check(); const job = await updater.prepare();
  let child;
  updater.startHelper = (command, args, options) => {
    assert.equal(options.detached, true); assert.equal(options.cwd, path.dirname(target));
    assert.ok(path.isAbsolute(command)); assert.equal(path.basename(command), 'wscript.exe'); assert.equal(options.windowsHide, true);
    child = spawn(command, args, options); return child;
  };
  try {
    await updater.launchInstaller();
    assert.match(await fs.readFile(job + '.helper-ready', 'utf8'), /^[1-9]\d{0,9}$/);
    assert.equal(await fs.readFile(job + '.ready', 'utf8'), 'ready');
    assert.equal(await fs.readFile(target, 'utf8'), 'original-executable');
  } finally {
    // The launcher has exited; the acknowledged helper waits for this test process.
    // Remove the commit marker so it cannot replace the fixture when the test process exits.
    await fs.rm(job + '.ready', { force: true });
    const pid = Number(await fs.readFile(job + '.helper-ready', 'utf8').catch(() => 0));
    if (pid) { try { process.kill(pid); } catch {} }
    await new Promise(resolve => setTimeout(resolve, 200));
    if (child && child.exitCode === null) { child.ref(); const closed = new Promise(resolve => child.once('close', resolve)); child.kill(); await closed; }
  }
});

test('helper exit before acknowledgement prevents update commitment', async t => {
  const { updater, target } = await fixture(t);
  await updater.check(); const job = await updater.prepare();
  updater.startHelper = () => spawn(process.execPath, ['-e', 'process.exit(2)'], { stdio: 'ignore' });
  await assert.rejects(() => updater.launchInstaller(), /未能就绪/);
  await assert.rejects(fs.access(job + '.ready'), { code: 'ENOENT' });
  assert.equal(await fs.readFile(target, 'utf8'), 'original-executable');
});
