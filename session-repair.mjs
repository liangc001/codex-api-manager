import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseConfig } from './core.mjs';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => { const r = path.relative(root, file); return r && !r.startsWith('..') && !path.isAbsolute(r); };
const fail = message => { throw new Error(message); };
const idPattern = /^[a-f0-9-]{36}$/i;
const limits = { header: 4 * 1024 * 1024, file: 128 * 1024 * 1024, batch: 512 * 1024 * 1024 };

export async function assertCodexStopped() {
  if (process.platform !== 'win32') fail('此版本只支持 Windows 本机会话修复。');
  const script = "$ErrorActionPreference='Stop'; $p=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'codex.exe' -or ($_.Name -ieq 'ChatGPT.exe' -and $_.ExecutablePath -match 'Codex') }); [Console]::Out.Write($p.Count)";
  let stdout;
  try { ({ stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000 })); }
  catch { fail('无法确认 Codex 是否已退出，请检查权限后重试。'); }
  if (!/^\d+$/.test(stdout.trim())) fail('无法确认 Codex 是否已退出。');
  if (Number(stdout.trim())) throw Object.assign(new Error('请先正常退出 Codex App 和所有 Codex CLI，再重试。'), { kind: 'codex-running' });
}

// Locate only a direct object member. Preserve every other byte, including future metadata.
function member(text, wanted) {
  let i = 0; const ws = () => { while (/\s/.test(text[i] || '') && i < text.length) i++; };
  const string = () => { const start = i++; while (i < text.length) { if (text[i] === '\\') i += 2; else if (text[i++] === '"') return [start, i]; } fail('会话元数据格式不支持。'); };
  const value = () => {
    ws(); const start = i;
    if (text[i] === '"') string();
    else if (text[i] === '{' || text[i] === '[') {
      const end = text[i++] === '{' ? '}' : ']';
      while (i < text.length && text[i] !== end) { if (text[i] === '"') string(); else if (text[i] === '{' || text[i] === '[') value(); else i++; }
      i++;
    } else { while (i < text.length && !/[,}\]\s]/.test(text[i])) i++; }
    return [start, i];
  };
  ws(); if (text[i++] !== '{') fail('会话元数据格式不支持。');
  const found = [];
  while (i < text.length) {
    ws(); if (text[i] === '}') break;
    if (text[i] !== '"') fail('会话元数据格式不支持。');
    const key = string(); ws(); if (text[i++] !== ':') fail('会话元数据格式不支持。');
    const range = value(); if (JSON.parse(text.slice(...key)) === wanted) found.push(range);
    ws(); if (text[i] === ',') i++; else if (text[i] !== '}') fail('会话元数据格式不支持。');
  }
  if (found.length !== 1) fail('会话元数据缺失或重复，已跳过。');
  return found[0];
}

export function replaceSessionProvider(header, id, source, target) {
  const text = header.toString('utf8');
  if (!Buffer.from(text).equals(header) || !text.endsWith('\n')) fail('会话文件编码或首行格式不支持。');
  let meta;
  try { meta = JSON.parse(text); } catch { fail('会话元数据不是有效 JSON，已跳过。'); }
  if (meta.type !== 'session_meta' || meta.payload?.id !== id || meta.payload.model_provider !== source) fail('会话文件与数据库不一致，已停止修复。');
  const payload = member(text, 'payload');
  const field = member(text.slice(...payload), 'model_provider');
  let edited = text.slice(0, payload[0] + field[0]) + JSON.stringify(target) + text.slice(payload[0] + field[1]);
  // Keep offsets unchanged whenever the new ID fits, by adding legal JSON whitespace.
  const padding = header.length - Buffer.byteLength(edited);
  if (padding > 0) edited = edited.replace(/\r?\n$/, ending => ' '.repeat(padding) + ending);
  const result = Buffer.from(edited);
  if (JSON.parse(edited).payload.model_provider !== target) fail('会话修复校验失败。');
  return result;
}

async function atomic(file, bytes) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  const handle = await fs.open(temp, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { await fs.rename(temp, file); } finally { await fs.rm(temp, { force: true }); }
}

export class SessionRepair {
  constructor(manager, { assertStopped = assertCodexStopped, fault = async () => {} } = {}) {
    this.manager = manager; this.assertStopped = assertStopped; this.fault = fault;
    this.journal = path.join(manager.dataDir, 'session-repairs', 'latest.enc');
  }
  async checkStopped() { await this.assertStopped(); }
  async config() {
    const text = await fs.readFile(this.manager.configPath, 'utf8'); const config = parseConfig(text);
    const target = config.model_provider;
    if (typeof target !== 'string' || !/^[\w.-]{1,100}$/.test(target) || !config.model_providers?.[target]?.base_url) fail('请先切换到要使用的 API，再扫描旧对话。');
    return { target, revision: digest(text) };
  }
  async database() {
    const home = await fs.realpath(this.manager.home);
    const names = (await fs.readdir(home)).filter(n => /^state_\d+\.sqlite$/.test(n)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    if (!names.length) fail('没有找到本机 Codex 会话数据库。');
    const state = path.join(home, names[0]); await this.safeFile(state);
    const history = path.join(home, 'thread_history_1.sqlite');
    const present = await fs.stat(history).then(() => true, e => { if (e.code !== 'ENOENT') throw e; return false; });
    if (present) await this.safeFile(history);
    const other = (await fs.readdir(home)).filter(n => /^thread_history_\d+\.sqlite$/.test(n) && n !== 'thread_history_1.sqlite');
    if (other.length) fail('发现新版会话历史数据库，当前版本尚未支持修复。');
    return { home, state, history: present ? history : null };
  }
  async safeFile(file) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || path.resolve(await fs.realpath(file)).toLowerCase() !== path.resolve(file).toLowerCase()) fail('不支持链接文件或远程会话，请使用原始本机数据。');
    return stat;
  }
  async sessionFile(file, home) {
    const absolute = path.resolve(file);
    if (path.extname(absolute) !== '.jsonl' || !['sessions', 'archived_sessions'].some(folder => inside(path.join(home, folder), absolute))) fail('远程或外部会话不支持修复。');
    await this.safeFile(absolute); return absolute;
  }
  async open(info, write = false) {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(info.state, { readOnly: !write });
    try {
      db.exec('PRAGMA busy_timeout=3000');
      const columns = db.prepare('PRAGMA table_info(threads)').all().map(c => c.name);
      for (const name of ['id', 'rollout_path', 'model_provider', 'title', 'updated_at', 'history_mode']) if (!columns.includes(name)) fail('会话数据库结构不兼容，未进行修改。');
      if (info.history) db.prepare('ATTACH DATABASE ? AS history').run(info.history);
      return db;
    } catch (e) { db.close(); throw e; }
  }
  isLocal(value) { return value?.origin === this.manager.origin && value.home === path.resolve(this.manager.home); }
  async saved({ allowForeign = false } = {}) {
    try {
      const value = JSON.parse(await this.manager.codec.decrypt(await fs.readFile(this.journal, 'utf8')));
      if (!allowForeign && !this.isLocal(value)) fail('修复备份来自另一台电脑，不能用于覆盖本机会话。');
      return value;
    } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async save(journal) {
    await fs.mkdir(path.dirname(this.journal), { recursive: true });
    await atomic(this.journal, await this.manager.codec.encrypt(JSON.stringify(journal)));
  }
  async scan({ excludeIds = [], skipProviders = [], offset = 0 } = {}) {
    const config = await this.config(); const info = await this.database(); const db = await this.open(info);
    const candidates = new Map(), entries = [];
    try {
      const rows = db.prepare(`SELECT id, rollout_path, model_provider, title, updated_at, history_mode FROM threads WHERE model_provider<>? ${excludeIds.length ? `AND id NOT IN (${excludeIds.map(() => '?').join(',')})` : ''} ${skipProviders.length ? `AND model_provider NOT IN (${skipProviders.map(() => '?').join(',')})` : ''} ORDER BY updated_at DESC,id LIMIT 3001 OFFSET ?`).all(config.target, ...excludeIds, ...skipProviders, offset);
      for (const row of rows.slice(0, 3000)) {
        if (row.model_provider === config.target) continue;
        const entry = { id: row.id, title: String(row.title || '未命名对话').slice(0, 180), provider: String(row.model_provider || '').slice(0, 100), updatedAt: row.updated_at, eligible: false };
        try {
          if (!idPattern.test(row.id)) fail('此会话标识格式暂不支持。');
          const file = await this.sessionFile(row.rollout_path, info.home); const stat = await fs.stat(file);
          if (stat.size > limits.file) fail('会话文件超过 128 MB，暂不支持自动修复。');
          const handle = await fs.open(file, 'r'); let buffer;
          try { buffer = Buffer.alloc(Math.min(stat.size, limits.header)); const { bytesRead } = await handle.read(buffer); buffer = buffer.subarray(0, bytesRead); } finally { await handle.close(); }
          const end = buffer.indexOf(10); if (end < 0) fail('会话首行过大或格式不支持。');
          const header = buffer.subarray(0, end + 1);
          replaceSessionProvider(header, row.id, row.model_provider, config.target);
          if (!['legacy', 'paginated'].includes(row.history_mode)) fail('未知历史格式，暂不支持自动修复。');
          if (row.history_mode === 'paginated' && !info.history) fail('分页历史索引缺失，暂不支持自动修复。');
          candidates.set(row.id, { ...row, file, headerHash: digest(header), size: stat.size, mtime: stat.mtimeMs }); entry.eligible = true;
        } catch (e) { entry.reason = e.code ? '会话文件不存在或不可访问' : e.message; }
        entries.push(entry);
      }
      const saved = await this.saved({ allowForeign: true });
      this.preview = { token: crypto.randomUUID(), config, info, candidates, expires: Date.now() + 15 * 60000 };
      return { token: this.preview.token, target: config.target, entries, truncated: rows.length > 3000, undo: this.isLocal(saved) && saved.phase !== 'reverted', pending: this.isLocal(saved) && !['applied', 'reverted'].includes(saved.phase) };
    } finally { db.close(); }
  }
  // Only these indexes are supported. Unknown offset-bearing columns stop the operation.
  snapshots(db, id, headerLength, delta) {
    const specs = [{ table: 'thread_turns', keys: ['thread_id', 'turn_id'], fields: ['rollout_byte_offset', 'rollout_end_byte_offset'] },
      { table: 'thread_history_projection_state', keys: ['thread_id'], fields: ['next_rollout_byte_offset'] }];
    if (!db.prepare('PRAGMA database_list').all().some(d => d.name === 'history')) return [];
    const tables = db.prepare("SELECT name FROM history.sqlite_master WHERE type='table'").all().map(t => t.name);
    for (const table of tables) {
      const cols = db.prepare(`PRAGMA history.table_info("${table.replaceAll('"', '""')}")`).all().map(c => c.name);
      const known = specs.find(s => s.table === table);
      if (cols.some(c => /offset/i.test(c) && !known?.fields.includes(c))) fail('发现未知历史偏移字段，已停止修复。');
      if (known && [...known.keys, ...known.fields].some(c => !cols.includes(c))) fail('历史索引结构不兼容，已停止修复。');
    }
    return specs.flatMap(spec => {
      if (!tables.includes(spec.table)) fail('历史索引表缺失，已停止修复。');
      return db.prepare(`SELECT ${[...spec.keys, ...spec.fields].join(',')} FROM history.${spec.table} WHERE thread_id=?`).all(id).map(row => {
        const after = { ...row };
        for (const name of spec.fields) {
          const value = row[name]; if (value == null || value === 0) continue;
          if (!Number.isSafeInteger(value) || value < headerLength) fail('历史偏移格式不支持，已停止修复。');
          after[name] = value + delta;
          if (!Number.isSafeInteger(after[name])) fail('历史偏移超出支持范围，已停止修复。');
        }
        return { table: spec.table, keys: spec.keys, fields: spec.fields, before: { ...row }, after };
      });
    });
  }
  updateIndexes(db, indexes, direction) {
    for (const index of indexes) {
      const desired = index[direction]; const other = index[direction === 'before' ? 'after' : 'before'];
      const where = index.keys.map(k => `${k}=?`).join(' AND ');
      const current = db.prepare(`SELECT ${index.fields.join(',')} FROM history.${index.table} WHERE ${where}`).get(...index.keys.map(k => desired[k]));
      if (!current || ![desired, other].some(row => index.fields.every(k => current[k] === row[k]))) fail('历史索引已被修改，已停止以保护新数据。');
      db.prepare(`UPDATE history.${index.table} SET ${index.fields.map(k => `${k}=?`).join(',')} WHERE ${where}`).run(...index.fields.map(k => desired[k]), ...index.keys.map(k => desired[k]));
    }
  }
  async apply({ token, ids }) {
    await this.checkStopped();
    const p = this.preview;
    if (!p || p.token !== token || p.expires < Date.now() || !Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => !p.candidates.has(id))) fail('请选择有效会话；每次最多修复 100 个，请重新扫描后重试。');
    const previous = await this.saved({ allowForeign: true });
    if (this.isLocal(previous) && !['applied', 'reverted'].includes(previous.phase)) fail('上次修复尚未完成，请先点击撤回恢复。');
    const config = await this.config(); if (config.revision !== p.config.revision) fail('当前 API 配置已改变，请重新扫描。');
    const info = await this.database(); if (JSON.stringify(info) !== JSON.stringify(p.info)) fail('会话数据库已改变，请重新扫描。');
    const db = await this.open(info, true); let journal, total = 0, prepared = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      const items = [];
      for (const id of ids) {
        const candidate = p.candidates.get(id); const row = db.prepare('SELECT model_provider,rollout_path FROM threads WHERE id=?').get(id);
        if (!row || row.model_provider !== candidate.model_provider || row.rollout_path !== candidate.rollout_path) fail('会话已改变，请重新扫描。');
        await this.sessionFile(candidate.file, info.home);
        const bytes = await fs.readFile(candidate.file); total += bytes.length; if (total > limits.batch || bytes.length > limits.file) fail('所选会话过大，请分批修复。');
        const end = bytes.indexOf(10) + 1; if (!end || end > limits.header) fail('会话元数据不支持。');
        const header = bytes.subarray(0, end); const stat = await fs.stat(candidate.file);
        if (digest(header) !== candidate.headerHash || stat.size !== candidate.size || stat.mtimeMs !== candidate.mtime) fail('会话文件已改变，请重新扫描。');
        const next = replaceSessionProvider(header, id, row.model_provider, config.target);
        const after = Buffer.concat([next, bytes.subarray(end)]);
        items.push({ id, file: candidate.file, source: row.model_provider, target: config.target, beforeHeader: header.toString('base64'), afterHeader: next.toString('base64'), beforeHash: digest(bytes), afterHash: digest(after), indexes: this.snapshots(db, id, header.length, next.length - header.length) });
      }
      journal = { version: 1, origin: this.manager.origin, home: path.resolve(this.manager.home), info, createdAt: new Date().toISOString(), phase: 'prepared', items };
      // Archive previous backup without discarding its encrypted bytes.
      if (previous) await fs.copyFile(this.journal, path.join(path.dirname(this.journal), crypto.randomUUID() + '.enc'));
      await this.save(journal); prepared = true;
      await this.checkStopped();
      for (const item of items) {
        const bytes = await fs.readFile(item.file); if (digest(bytes) !== item.beforeHash) fail('会话文件已改变，已停止修复。');
        const next = Buffer.concat([Buffer.from(item.afterHeader, 'base64'), bytes.subarray(Buffer.from(item.beforeHeader, 'base64').length)]);
        await atomic(item.file, next); await this.fault('file');
        this.updateIndexes(db, item.indexes, 'after');
        const changed = db.prepare('UPDATE threads SET model_provider=? WHERE id=? AND model_provider=?').run(item.target, item.id, item.source);
        if (changed.changes !== 1) fail('会话已改变，已停止修复。');
      }
      await this.checkStopped();
      await this.fault('before-commit'); db.exec('COMMIT'); await this.fault('committed');
      journal.phase = 'applied'; await this.save(journal); this.preview = null;
      return { count: items.length };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      if (prepared) {
        // The persistent journal is also the recovery path for abrupt termination.
        db.close();
        try { await this.undo(); } catch { fail('修复未完成，备份已保留。请退出 Codex 后点击撤回恢复。'); }
        throw error;
      }
      throw error;
    } finally { try { db.close(); } catch {} }
  }
  async undo() {
    await this.checkStopped(); const journal = await this.saved();
    if (!journal || journal.phase === 'reverted') fail('没有可撤回的会话修复。');
    const info = await this.database(); if (JSON.stringify(info) !== JSON.stringify(journal.info)) fail('会话数据库已改变，不能自动撤回。');
    const db = await this.open(info, true);
    try {
      db.exec('BEGIN IMMEDIATE');
      // Validate the entire batch before changing any file or database row.
      for (const item of journal.items) {
        const currentIndexes = this.snapshots(db, item.id, 0, 0);
        const identity = index => JSON.stringify([index.table, ...index.keys.map(k => index.before[k])]);
        const expectedIndexes = new Set(item.indexes.map(identity));
        if (currentIndexes.length !== item.indexes.length || currentIndexes.some(index => !expectedIndexes.has(identity(index)))) fail('历史索引已新增或重建，不能直接撤回；备份已保留。');
        await this.sessionFile(item.file, info.home);
        const hash = digest(await fs.readFile(item.file));
        if (hash !== item.beforeHash && hash !== item.afterHash) fail('会话已继续写入或被修改，不能直接撤回；备份已保留。');
        const row = db.prepare('SELECT model_provider,rollout_path FROM threads WHERE id=?').get(item.id);
        if (!row || path.resolve(row.rollout_path) !== item.file || ![item.source, item.target].includes(row.model_provider)) fail('会话记录已改变，不能自动撤回。');
        this.updateIndexes(db, item.indexes, 'before');
      }
      journal.phase = 'reverting'; await this.save(journal); await this.checkStopped();
      for (const item of journal.items) {
        const bytes = await fs.readFile(item.file); const hash = digest(bytes);
        if (hash !== item.beforeHash && hash !== item.afterHash) fail('会话文件已改变，撤回已停止。');
        if (hash === item.afterHash) await atomic(item.file, Buffer.concat([Buffer.from(item.beforeHeader, 'base64'), bytes.subarray(Buffer.from(item.afterHeader, 'base64').length)]));
        db.prepare('UPDATE threads SET model_provider=? WHERE id=?').run(item.source, item.id);
      }
      await this.checkStopped(); db.exec('COMMIT'); journal.phase = 'reverted'; await this.save(journal); this.preview = null;
      return { count: journal.items.length };
    } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    finally { db.close(); }
  }
}
