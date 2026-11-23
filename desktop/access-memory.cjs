const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

function createLoginMemory({ file, safeStorage, record }) {
  const fingerprint = createHash('sha256').update(record.salt + ':' + record.hash).digest('hex');
  function available() {
    return safeStorage.isEncryptionAvailable() &&
      (!safeStorage.getSelectedStorageBackend || safeStorage.getSelectedStorageBackend() !== 'basic_text');
  }
  async function savedLogin() {
    if (!available()) return null;
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) return null;
    const saved = JSON.parse(safeStorage.decryptString(await fs.readFile(file)));
    return saved.v === 1 && saved.fingerprint === fingerprint && typeof saved.nonce === 'string' && saved.nonce.length === 36 ? saved : null;
  }
  return {
    async trusted() {
      try { return !!await savedLogin(); } catch { return false; }
    },
    async bundleKey(id) {
      try {
        const saved = await savedLogin();
        if (saved?.bundleId !== id || typeof saved.bundleKey !== 'string') return null;
        const key = Buffer.from(saved.bundleKey, 'base64');
        if (key.length === 32) return key;
        key.fill(0);
      } catch {}
      return null;
    },
    async remember({ bundleId, bundleKey } = {}) {
      if (!available()) throw new Error('系统加密暂不可用。');
      const extra = typeof bundleId === 'string' && Buffer.isBuffer(bundleKey) && bundleKey.length === 32
        ? { bundleId, bundleKey: bundleKey.toString('base64') } : {};
      const encrypted = safeStorage.encryptString(JSON.stringify({ v: 1, fingerprint, nonce: randomUUID(), ...extra }));
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temp = file + '.' + randomUUID() + '.tmp';
      try { await fs.writeFile(temp, encrypted, { flag: 'wx', mode: 0o600 }); await fs.rename(temp, file); }
      finally { await fs.rm(temp, { force: true }).catch(() => {}); }
    },
    async forget() { await fs.rm(file, { force: true }); },
  };
}

module.exports = { createLoginMemory };
