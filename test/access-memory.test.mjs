import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import memory from '../desktop/access-memory.cjs';

test('remembered login is encrypted, bound to the current password and can be cleared', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'access-memory-'));
  const file = path.join(root, 'cache', 'startup-access.bin');
  const key = crypto.randomBytes(32);
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString(text) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decryptString(bytes) {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
  const record = { salt: 'fixture-salt', hash: 'fixture-verifier' };
  const login = memory.createLoginMemory({ file, safeStorage, record });
  try {
    assert.equal(await login.trusted(), false);
    await login.remember();
    assert.equal(await login.trusted(), true);
    const bundleKey = crypto.randomBytes(32);
    await login.remember({ bundleId: 'fixture-bundle-id', bundleKey });
    assert.deepEqual(await login.bundleKey('fixture-bundle-id'), bundleKey);
    assert.equal(await login.bundleKey('different-bundle-id'), null);
    const encrypted = await fs.readFile(file);
    assert.equal(encrypted.includes(Buffer.from('fingerprint')), false);
    assert.equal(encrypted.includes(bundleKey), false);
    assert.equal(await memory.createLoginMemory({ file, safeStorage, record: { ...record, hash: 'changed' } }).trusted(), false);
    assert.equal(await memory.createLoginMemory({ file, safeStorage: { ...safeStorage, decryptString() { throw new Error('different user'); } }, record }).trusted(), false);
    await fs.writeFile(file, 'tampered');
    assert.equal(await login.trusted(), false);
    await login.remember(); await login.forget();
    assert.equal(await login.trusted(), false);
    const unencrypted = memory.createLoginMemory({ file, safeStorage: { isEncryptionAvailable: () => false }, record });
    await assert.rejects(unencrypted.remember());
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
