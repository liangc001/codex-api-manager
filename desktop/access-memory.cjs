const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

function createLoginMemory({ file, safeStorage, record }) {
  const fingerprint = createHash('sha256').update(record.salt + ':' + record.hash).digest('hex');
  function available() {
    return safeStorage.isEncryptionAvailable() &&
      (!safeStorage.getSelectedStorageBackend || safeStorage.getSelectedStorageBackend() !== 'basic_text');
  }
  return {
    async trusted() {
      try {
        if (!available()) return false;
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) return false;
        const saved = JSON.parse(safeStorage.decryptString(await fs.readFile(file)));
        return saved.v === 1 && saved.fingerprint === fingerprint && typeof saved.nonce === 'string' && saved.nonce.length === 36;
      } catch { return false; }
    },
    async remember() {
      if (!available()) throw new Error('系统加密暂不可用。');
      const encrypted = safeStorage.encryptString(JSON.stringify({ v: 1, fingerprint, nonce: randomUUID() }));
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temp = file + '.' + randomUUID() + '.tmp';
      try { await fs.writeFile(temp, encrypted, { flag: 'wx', mode: 0o600 }); await fs.rename(temp, file); }
      finally { await fs.rm(temp, { force: true }).catch(() => {}); }
    },
    async forget() { await fs.rm(file, { force: true }); },
  };
}

module.exports = { createLoginMemory };
