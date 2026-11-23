import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import bundle from '../desktop/vpn-bundle.cjs';

test('bundled VPN authenticates encrypted data, installs only allowed files, and preserves existing data', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vpn-bundle-'));
  const source = path.join(root, 'source'), home = path.join(root, 'installed'), file = path.join(root, 'bootstrap.enc');
  const password = 'synthetic bundle password';
  const contents = new Map([
    ['data/portable.key', Buffer.alloc(32, 6)],
    ['data/policy.json', Buffer.from('{"fixture":"private-policy-marker"}')],
    ['data/clash.protected', Buffer.from('synthetic-private-node-password')],
    ['cores/mihomo.exe', Buffer.from('synthetic-core-one')],
    ['cores/sing-box.exe', Buffer.from('synthetic-core-two')],
  ]);
  let key, wrong;
  try {
    for (const [relative, bytes] of contents) {
      const target = path.join(source, relative);
      await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
    }
    await fs.writeFile(path.join(source, 'data/preferences.json'), '{"AutoConnect":true}');
    await fs.writeFile(path.join(source, 'data/profiles.json'), '{"apiKey":"must-not-distribute"}');
    await fs.writeFile(path.join(source, 'data/extra.txt'), 'not-allowed');
    await bundle.packBundle({ source, output: file, password });
    const bytes = await fs.readFile(file), info = await bundle.bundleInfo(file);
    for (const marker of ['private-policy-marker', 'synthetic-private-node-password', password, 'must-not-distribute'])
      assert.equal(bytes.includes(Buffer.from(marker)), false);
    assert.equal(info.id.length, 32);
    key = await bundle.bundleKey(password, info.salt);
    wrong = await bundle.bundleKey('wrong', info.salt);
    let validationCalls = 0;
    const validate = async stage => {
      validationCalls++;
      for (const [relative, expected] of contents) assert.deepEqual(await fs.readFile(path.join(stage, relative)), expected);
    };
    assert.equal(await bundle.needsSetup(home), true);
    await assert.rejects(bundle.installBundle({ bundle: file, home, key: wrong, validate }));
    assert.equal(validationCalls, 0);
    await assert.rejects(fs.stat(home), { code: 'ENOENT' });
    assert.equal((await fs.readdir(root)).some(n => n.startsWith('vpn-bootstrap-')), false);
    await assert.rejects(bundle.installBundle({ bundle: file, home, key, validate: async () => { throw new Error('invalid decrypted profiles'); } }));
    await assert.rejects(fs.stat(home), { code: 'ENOENT' });
    assert.equal((await fs.readdir(root)).some(n => n.startsWith('vpn-bootstrap-')), false);
    const damaged = path.join(root, 'tampered.enc'), altered = Buffer.from(bytes);
    altered[altered.length - 1] ^= 1; await fs.writeFile(damaged, altered);
    await assert.rejects(bundle.installBundle({ bundle: damaged, home, key, validate }));
    assert.equal(validationCalls, 0);
    assert.deepEqual(await bundle.installBundle({ bundle: file, home, key, validate }), { installed: true });
    assert.equal(validationCalls, 1);
    assert.equal(await bundle.needsSetup(home), false);
    assert.deepEqual((await fs.readdir(path.join(home, 'data'))).sort(), ['clash.protected', 'policy.json', 'portable.key']);
    await fs.writeFile(path.join(home, 'data/clash.protected'), 'changed by user');
    assert.deepEqual(await bundle.installBundle({ bundle: file, home, key, validate }), { installed: false });
    assert.equal(await fs.readFile(path.join(home, 'data/clash.protected'), 'utf8'), 'changed by user');
    await fs.unlink(path.join(home, 'data/portable.key'));
    await assert.rejects(bundle.needsSetup(home), /已保留/);
    await assert.rejects(bundle.installBundle({ bundle: file, home, key, validate }), /已保留/);
    await assert.rejects(fs.stat(path.join(home, 'data/portable.key')), { code: 'ENOENT' });
  } finally { key?.fill(0); wrong?.fill(0); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
