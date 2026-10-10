import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { atomicWrite } from './core.mjs';

const logPattern = /^events-\d{4}-\d{2}-\d{2}-[a-f0-9-]+\.jsonl$/;
const inside = (parent, child) => { const relative = path.relative(parent, child); return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };

export class StorageSettings {
  constructor(root = path.join(process.env.LOCALAPPDATA || os.homedir(), 'CodexApiManager'), { portable = false } = {}) {
    this.root = path.resolve(root);
    this.settingsFile = path.join(this.root, 'settings.json');
    this.tail = Promise.resolve();
    this.warning = '';
    this.portable = portable;
  }
  async init() {
    let saved;
    try { saved = JSON.parse(await fs.readFile(this.settingsFile, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    this.settings = { dataDir: this.root, logging: true, retentionDays: 30, autoUpdates: true, ...saved };
    if (this.portable) this.settings.dataDir = this.root;
    this.validate(this.settings);
    // A disconnected custom drive must not silently create a fresh empty store.
    if (this.settings.dataDir !== this.root) await fs.access(path.join(this.settings.dataDir, 'profiles.json'));
    await fs.mkdir(this.settings.dataDir, { recursive: true });
    await this.persist();
    await this.prune().catch(() => { this.warning = '日志清理失败，请检查目录权限。'; });
  }
  validate(input) {
    if (typeof input.dataDir !== 'string' || !path.isAbsolute(input.dataDir) || input.dataDir.length > 2000) throw new Error('请选择完整的本地文件夹路径。');
    if (typeof input.logging !== 'boolean' || ![7, 30, 90].includes(input.retentionDays)) throw new Error('日志设置无效。');
    if (input.autoUpdates !== undefined && typeof input.autoUpdates !== 'boolean') throw new Error('更新设置无效。');
  }
  get logDir() { return path.join(this.settings.dataDir, 'logs'); }
  state() { return { ...this.settings, portable: this.portable, settingsFile: this.settingsFile, logDir: this.logDir, warning: this.warning }; }
  async persist(settings = this.settings) {
    const saved = this.portable ? { format: 'portable-v1', logging: settings.logging, retentionDays: settings.retentionDays, autoUpdates: settings.autoUpdates } : settings;
    await atomicWrite(this.settingsFile, JSON.stringify(saved, null, 2));
  }
  record(event, details = {}) {
    // Only fixed event names and numeric/enum metadata reach disk; never serialize inputs or errors.
    if (!['startup', 'shutdown', 'operation', 'request', 'settings', 'logs-cleared'].includes(event)) return Promise.resolve();
    const row = { time: new Date().toISOString(), event };
    if (['upstream', 'transport', 'local'].includes(details.failureSource)) row.failureSource = details.failureSource;
    if (['save', 'delete', 'switch', 'restore', 'monitor', 'import', 'export', 'refresh', 'restart-codex', 'test-connection', 'export-diagnostics'].includes(details.operation)) row.operation = details.operation;
    if (['auth', 'permission', 'model', 'limited', 'quota', 'endpoint', 'redirect', 'timeout', 'certificate', 'network', 'upstream', 'format', 'rejected'].includes(details.errorKind)) row.errorKind = details.errorKind;
    if (['ok', 'error', 'unsupported', 'completed', 'cancelled', 'network'].includes(details.outcome)) row.outcome = details.outcome;
    if (typeof details.profileId === 'string' && /^[a-f0-9-]{36}$/.test(details.profileId)) row.profileId = details.profileId;
    for (const key of ['status', 'durationMs', 'firstByteMs']) if (Number.isFinite(details[key])) row[key] = details[key];
    const next = this.tail.then(async () => {
      if (!this.settings.logging) return;
      await fs.mkdir(this.logDir, { recursive: true });
      const day = row.time.slice(0, 10);
      if (!this.logFile || this.logDay !== day || this.logSize >= 10 * 1024 * 1024) {
        this.logDay = day; this.logSize = 0;
        this.logFile = path.join(this.logDir, `events-${day}-${crypto.randomUUID()}.jsonl`);
        await this.prune();
      }
      const line = JSON.stringify(row) + '\n';
      await fs.appendFile(this.logFile, line, { mode: 0o600 });
      this.logSize += Buffer.byteLength(line);
      this.warning = '';
    });
    this.tail = next.catch(() => { this.warning = '日志写入失败，请检查保存目录和磁盘空间。'; });
    return this.tail;
  }
  async prune() {
    let entries;
    try { entries = await fs.readdir(this.logDir, { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    const files = [];
    const cutoff = Date.now() - this.settings.retentionDays * 86400000;
    for (const entry of entries) {
      if (!entry.isFile() || !logPattern.test(entry.name)) continue;
      const file = path.join(this.logDir, entry.name), stat = await fs.stat(file);
      if (stat.mtimeMs < cutoff) await fs.rm(file);
      else files.push({ file, size: stat.size, time: stat.mtimeMs });
    }
    let total = files.reduce((n, f) => n + f.size, 0);
    for (const f of files.sort((a, b) => a.time - b.time)) {
      if (total <= 90 * 1024 * 1024) break;
      await fs.rm(f.file); total -= f.size;
    }
  }
  async clearLogs() {
    await this.tail;
    let entries;
    try { entries = await fs.readdir(this.logDir, { withFileTypes: true }); }
    catch (e) { if (e.code !== 'ENOENT') throw e; entries = []; }
    for (const entry of entries) if (entry.isFile() && logPattern.test(entry.name)) await fs.rm(path.join(this.logDir, entry.name));
    this.logFile = null; this.warning = '';
  }
  async update(input, manager, monitor) {
    this.validate(input);
    const next = { dataDir: path.resolve(input.dataDir), logging: input.logging, retentionDays: input.retentionDays, autoUpdates: input.autoUpdates ?? this.settings.autoUpdates ?? true };
    this.validate(next);
    await this.tail;
    let migrated = false;
    if (this.portable && next.dataDir.toLowerCase() !== this.root.toLowerCase()) throw new Error('便携版数据固定保存在 EXE 旁的 data 文件夹；改变位置时请关闭软件并移动整个文件夹。');
    if (next.dataDir.toLowerCase() !== this.settings.dataDir.toLowerCase()) {
      if (monitor.enabled || monitor.active.size || monitor.recoveryWarning) throw new Error('请先关闭实时监控并等待请求完成，处理恢复提示后再迁移目录。');
      try { await fs.access(monitor.sessionFile); throw new Error('存在未恢复的监控备份，请先重新启动程序处理恢复。'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      await fs.mkdir(next.dataDir, { recursive: true });
      next.dataDir = await fs.realpath(next.dataDir);
      const source = await fs.realpath(this.settings.dataDir), home = await fs.realpath(manager.home).catch(() => path.resolve(manager.home));
      if (inside(source, next.dataDir) || inside(next.dataDir, source) || inside(home, next.dataDir) || inside(next.dataDir, home) || inside(next.dataDir, this.root)) throw new Error('请选择与当前数据目录及 Codex 配置目录独立的空文件夹。');
      if ((await fs.readdir(next.dataDir)).length) throw new Error('目标文件夹必须为空，以免覆盖已有文件。');
      const copied = [];
      try {
        for (const name of ['profiles.json', 'backups', 'logs']) {
          const from = path.join(source, name), to = path.join(next.dataDir, name);
          try { await fs.access(from); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
          copied.push(to);
          await fs.cp(from, to, { recursive: true, force: false, errorOnExist: true });
        }
        await this.persist(next);
      } catch (e) {
        for (const file of copied) await fs.rm(file, { recursive: true, force: true }).catch(() => {});
        throw e;
      }
      manager.dataDir = next.dataDir;
      manager.storePath = path.join(next.dataDir, 'profiles.json');
      monitor.sessionFile = path.join(next.dataDir, 'monitor-session.json');
      this.logFile = null;
      migrated = true;
    } else await this.persist(next);
    this.settings = next;
    await this.prune().catch(() => { this.warning = '日志清理失败，请检查目录权限。'; });
    await this.record('settings', { outcome: 'ok' });
    return { migrated };
  }
}
