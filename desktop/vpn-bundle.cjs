const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { pipeline } = require('node:stream/promises');
const { Readable, Transform } = require('node:stream');
const { createGzip, createGunzip } = require('node:zlib');
const { execFile } = require('node:child_process');

const derive = promisify(crypto.scrypt), run = promisify(execFile);
const magic = Buffer.from('ASVPN001');
const headerSize = 52, maxExpanded = 600 * 1024 * 1024;
const allowed = new Map([
  ['data/portable.key', 32], ['data/policy.json', 32 * 1024 * 1024],
  ...['racknerd', 'researchlab', 'clash', 'subscription'].map(name => ['data/' + name + '.protected', 16 * 1024 * 1024]),
  ['cores/mihomo.exe', 256 * 1024 * 1024], ['cores/sing-box.exe', 256 * 1024 * 1024],
]);
const required = ['data/portable.key', 'data/policy.json', 'cores/mihomo.exe', 'cores/sing-box.exe'];

async function regularFile(file, max) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > max) throw new Error('Invalid VPN resource.');
  return stat;
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function privateDirectory(folder) {
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') return;
  const script = String.raw`
    $ErrorActionPreference = 'Stop'
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true,$false)
    foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
    }
    ([IO.DirectoryInfo]::new($env:SWITCHBOARD_VPN_STAGE)).SetAccessControl($acl)
  `;
  await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env: { ...process.env, SWITCHBOARD_VPN_STAGE: folder }, windowsHide: true, timeout: 15000, maxBuffer: 4096 });
}

async function noRedirect(folder) {
  let current = path.resolve(folder);
  while (true) {
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Redirected VPN directory.');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function readExact(handle, length, position) {
  const bytes = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const part = await handle.read(bytes, read, length - read, position + read);
    if (!part.bytesRead) throw new Error('Incomplete VPN resource.');
    read += part.bytesRead;
  }
  return bytes;
}

async function bundleInfo(file) {
  await regularFile(file, 200 * 1024 * 1024);
  const handle = await fs.open(file, 'r');
  try {
    const header = await readExact(handle, headerSize, 0);
    if (!header.subarray(0, 8).equals(magic)) throw new Error('Invalid VPN bundle format.');
    const salt = header.subarray(8, 24);
    return { header, salt, id: salt.toString('hex') };
  } finally { await handle.close(); }
}

async function bundleKey(password, salt) {
  if (typeof password !== 'string' || !password.length || password.length > 512) throw new Error('Invalid bundle password.');
  return derive(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function verifyManifest(manifest) {
  if (manifest?.v !== 1 || !Array.isArray(manifest.files) || manifest.files.length > allowed.size)
    throw new Error('Invalid VPN manifest.');
  const seen = new Set();
  let total = 0;
  for (const item of manifest.files) {
    if (!allowed.has(item.name) || seen.has(item.name) || !Number.isSafeInteger(item.size) || item.size < 1 ||
        item.size > allowed.get(item.name) || !/^[a-f0-9]{64}$/.test(item.sha256) ||
        (item.name === 'data/portable.key' && item.size !== 32)) throw new Error('Invalid VPN file entry.');
    seen.add(item.name); total += item.size;
  }
  if (total > maxExpanded || !required.every(name => seen.has(name)) ||
      !['racknerd', 'researchlab', 'clash'].some(name => seen.has('data/' + name + '.protected')))
    throw new Error('Incomplete VPN bundle.');
  return total;
}

async function packBundle({ source, output, password, salt = crypto.randomBytes(16) }) {
  source = path.resolve(source); output = path.resolve(output);
  await noRedirect(source);
  for (const dir of ['data', 'cores']) await noRedirect(path.join(source, dir));
  const files = [];
  for (const [name, max] of allowed) {
    const file = path.join(source, name);
    const stat = await regularFile(file, max).catch(error => { if (error.code === 'ENOENT' && !required.includes(name)) return null; throw error; });
    if (stat) files.push({ name, size: stat.size, sha256: await hashFile(file) });
  }
  verifyManifest({ v: 1, files });
  const manifest = Buffer.from(JSON.stringify({ v: 1, files }));
  const length = Buffer.alloc(4); length.writeUInt32BE(manifest.length);
  const key = await bundleKey(password, salt), iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const header = Buffer.concat([magic, salt, iv, Buffer.alloc(16)]);
  cipher.setAAD(header.subarray(0, 36));
  const temp = output + '.' + crypto.randomUUID() + '.tmp';
  await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  async function* contents() {
    yield length; yield manifest;
    for (const item of files) yield* createReadStream(path.join(source, item.name));
  }
  try {
    await fs.writeFile(temp, header, { flag: 'wx', mode: 0o600 });
    await pipeline(Readable.from(contents()), createGzip({ level: 6 }), cipher, createWriteStream(temp, { flags: 'a' }));
    const handle = await fs.open(temp, 'r+');
    try { await handle.write(cipher.getAuthTag(), 0, 16, 36); } finally { await handle.close(); }
    await fs.rename(temp, output);
    return { id: salt.toString('hex'), files: files.length };
  } finally { key.fill(0); await fs.rm(temp, { force: true }).catch(() => {}); }
}

async function needsSetup(home) {
  try {
    await noRedirect(home);
    for (const name of required) {
      await noRedirect(path.dirname(path.join(home, name)));
      await regularFile(path.join(home, name), allowed.get(name));
    }
    return false;
  } catch (error) {
    // Missing or damaged data in an existing directory belongs to the user.
    try { await fs.lstat(home); }
    catch (missing) { if (missing.code === 'ENOENT') return true; throw missing; }
    throw new Error('现有 VPN 配置不完整，已保留。请恢复完整的 VPN 数据目录。');
  }
}

async function installBundle({ bundle, home, key, validate }) {
  home = path.resolve(home);
  if (!await needsSetup(home)) return { installed: false };
  const info = await bundleInfo(bundle);
  const parent = path.dirname(home);
  await fs.mkdir(parent, { recursive: true });
  await noRedirect(parent);
  const stage = path.join(parent, 'vpn-bootstrap-' + crypto.randomUUID());
  const payload = path.join(stage, 'payload.bin');
  const extracted = path.join(stage, 'vpn');
  try {
    await privateDirectory(stage);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, info.header.subarray(24, 36));
    decipher.setAAD(info.header.subarray(0, 36));
    decipher.setAuthTag(info.header.subarray(36, 52));
    let total = 0;
    const limit = new Transform({ transform(chunk, _encoding, callback) {
      total += chunk.length;
      callback(total > maxExpanded + 32772 ? new Error('Expanded VPN resource too large.') : null, chunk);
    } });
    // Nothing is activated or executed until authentication and decompression finish.
    await pipeline(createReadStream(bundle, { start: headerSize }), decipher, createGunzip(), limit,
      createWriteStream(payload, { flags: 'wx', mode: 0o600 }));
    const handle = await fs.open(payload, 'r');
    try {
      const length = (await readExact(handle, 4, 0)).readUInt32BE();
      if (length < 1 || length > 32768) throw new Error('Invalid VPN manifest size.');
      const manifest = JSON.parse((await readExact(handle, length, 4)).toString('utf8'));
      const expectedBytes = verifyManifest(manifest);
      if (total !== 4 + length + expectedBytes) throw new Error('VPN resource size mismatch.');
      await fs.mkdir(extracted, { mode: 0o700 });
      for (const folder of ['data', 'cores']) await fs.mkdir(path.join(extracted, folder), { mode: 0o700 });
      let offset = 4 + length;
      for (const item of manifest.files) {
        const file = path.join(extracted, item.name);
        await pipeline(createReadStream(payload, { start: offset, end: offset + item.size - 1 }),
          createWriteStream(file, { flags: 'wx', mode: 0o600 }));
        if (await hashFile(file) !== item.sha256) throw new Error('VPN file checksum mismatch.');
        offset += item.size;
      }
    } finally { await handle.close(); }
    await validate(extracted);
    try { await fs.lstat(home); throw new Error('VPN destination appeared during setup.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rename(extracted, home);
    return { installed: true };
  } finally { await fs.rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

module.exports = { bundleInfo, bundleKey, packBundle, needsSetup, installBundle };
