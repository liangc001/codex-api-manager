import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// The key travels with the data. This avoids plaintext profiles, but does not protect
// against anyone possessing the entire portable folder.
export async function portableCodec(dataDir) {
  const keyFile = path.join(dataDir, 'secrets.key');
  let key;
  try { key = Buffer.from((await fs.readFile(keyFile, 'utf8')).trim(), 'base64'); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const entries = await fs.readdir(dataDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    if (entries.includes('monitor-session.json') || (entries.includes('backups') && (await fs.readdir(path.join(dataDir, 'backups'))).length)) {
      throw new Error('缺少 secrets.key，请恢复原来的密钥文件以读取加密备份。');
    }
    if (entries.includes('profiles.json')) {
      const store = JSON.parse(await fs.readFile(path.join(dataDir, 'profiles.json'), 'utf8'));
      if (store.profiles?.some(p => p.encryptedKey) || store.lastBackup || entries.includes('monitor-session.json') || entries.includes('backups')) {
        throw new Error('缺少 secrets.key，请连同原来的 data 文件夹完整复制，不能仅复制 profiles.json。');
      }
    }
    key = crypto.randomBytes(32);
    await fs.mkdir(dataDir, { recursive: true });
    // Exclusive creation prevents an accidental second writer from replacing the key.
    try { await fs.writeFile(keyFile, key.toString('base64'), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; key = Buffer.from((await fs.readFile(keyFile, 'utf8')).trim(), 'base64'); }
  }
  if (key.length !== 32) throw new Error('secrets.key 已损坏，请恢复原来的密钥文件。');
  return {
    async encrypt(value) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return ['portable-v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(':');
    },
    async decrypt(value) {
      try {
        const parts = value.split(':');
        if (parts.length !== 4 || parts[0] !== 'portable-v1') throw new Error();
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64'));
        decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
      } catch { throw new Error('无法解密便携配置，请恢复与此数据匹配的 secrets.key。'); }
    },
  };
}
