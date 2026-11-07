import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from './core.mjs';
import { SessionRepair } from './session-repair.mjs';

const TARGET = 'codex_api_manager';
const knownFailures = new Map([
  ['没有找到本机 Codex 会话数据库。', '没有找到本机对话，请先在 Codex 中创建对话'],
  ['请先切换到要使用的 API，再扫描旧对话。', '请先在本工具中切换一次 API，建立兼容入口'],
  ['会话数据库结构不兼容，未进行修改。', '当前 Codex 数据库结构暂不支持，未修改会话'],
  ['发现新版会话历史数据库，当前版本尚未支持修复。', '当前 Codex 历史数据库版本暂不支持，未修改会话'],
  ['无法确认 Codex 是否已退出，请检查权限后重试。', '无法检查 Codex 进程，请检查系统权限后重试'],
  ['无法确认 Codex 是否已退出。', '无法检查 Codex 进程，请检查系统权限后重试'],
]);

// Status inspection is read-only; mutations still require every Codex process to stop.
export class AutoSessionRepair {
  constructor(manager, storage, monitor, { repair = new SessionRepair(manager), now = Date.now, quietMs = 5000, canRun = () => true, onChange = () => {} } = {}) {
    Object.assign(this, { manager, storage, monitor, repair, now, quietMs, canRun, onChange });
    this.status = { phase: 'off', message: '未开启', repaired: 0, checkedAt: null, currentProvider: null, counts: null, blockers: [] };
    this.holdUntil = 0; this.stoppedSince = null; this.offset = 0; this.retryAt = 0;
    this.records = []; this.entries = []; this.lastInspection = 0;
  }
  get activityFile() { return path.join(this.manager.dataDir, 'session-repairs', 'activity.enc'); }
  async init() {
    if (!this.manager.codec) return;
    try {
      const saved = JSON.parse(await this.manager.codec.decrypt(await fs.readFile(this.activityFile, 'utf8')));
      if (saved.origin === this.manager.origin && saved.home === path.resolve(this.manager.home) && Array.isArray(saved.records)) this.records = saved.records.slice(0, 10);
    } catch (e) { if (e.code !== 'ENOENT') this.status.recordWarning = '处理记录暂不可读，连接备份仍保留'; }
    try {
      const saved = await this.repair.saved({ allowForeign: true });
      if (this.repair.isLocal(saved) && saved.phase === 'applied' && !this.records.some(r => r.batchAt === saved.createdAt)) {
        await this.record({ count: saved.items.length, batchAt: saved.createdAt }, saved.items.map(x => ({ id: x.id, title: `对话 ${x.id.slice(0, 8)}`, provider: x.source })), 'recovered', saved.items[0]?.target);
      }
    } catch { this.status.recordWarning = '上次修复备份需检查，请打开修复列表'; }
    this.reset();
  }
  state() {
    return { ...this.status, target: TARGET, enabled: this.storage.settings.autoSessionRepair === true,
      exclusions: [...(this.storage.settings.sessionRepairExclusions || [])], retryAt: this.retryAt || null,
      lastRun: this.records[0] ? { ...this.records[0], entries: undefined } : null };
  }
  details() { return { ...this.state(), entries: this.entries.slice(0, 200), entryCount: this.entries.length, records: this.records }; }
  emit() { try { this.onChange(this.state()); } catch {} }
  set(phase, message) { this.status = { ...this.status, phase, message }; this.emit(); }
  async persistRecords() {
    if (!this.manager.codec) return;
    try {
      await atomicWrite(this.activityFile, await this.manager.codec.encrypt(JSON.stringify({ version: 1, origin: this.manager.origin, home: path.resolve(this.manager.home), records: this.records })));
      this.status.recordWarning = '';
    } catch { this.status.recordWarning = '处理已完成，但记录保存失败；连接备份仍保留'; }
  }
  async record(result, entries, mode = 'automatic', target = TARGET) {
    const row = { batchAt: result.batchAt || new Date(this.now()).toISOString(), finishedAt: new Date(this.now()).toISOString(), mode, count: result.count, target,
      entries: entries.map(e => ({ id: e.id, title: String(e.title || '未命名对话').slice(0, 180), source: e.provider || e.model_provider, target })) };
    this.records = [row, ...this.records.filter(r => r.batchAt !== row.batchAt)].slice(0, 10);
    await this.persistRecords(); this.emit();
  }
  async recordUndo(result) {
    const row = this.records.find(r => r.batchAt === result.batchAt);
    if (row) row.undoneAt = new Date(this.now()).toISOString();
    await this.persistRecords(); this.emit();
  }
  hold() { this.holdUntil = this.now() + 15 * 60000; this.stoppedSince = null; }
  release() { this.holdUntil = 0; this.stoppedSince = null; }
  requestCheck() { this.retryAt = 0; this.lastInspection = 0; }
  reset() {
    this.offset = 0; this.retryAt = 0; this.lastInspection = 0; this.stoppedSince = null; this.status.blockers = [];
    this.entries = []; this.status.counts = null;
    this.set(this.storage.settings.autoSessionRepair ? 'waiting' : 'off', this.storage.settings.autoSessionRepair ? '已开启，正在检查运行条件；尚未修改对话' : '未开启');
  }
  async tick() {
    if (this.active) return;
    this.active = true;
    try { await this.manager.exclusive(() => this.cycle()); }
    finally { this.active = false; }
  }
  async inspect(config) {
    const preview = await this.repair.scan({ excludeIds: this.storage.settings.sessionRepairExclusions || [], skipProviders: ['openai', 'ollama', 'lmstudio'], offset: this.offset });
    this.entries = preview.entries || [];
    this.status.counts = { scanned: this.entries.length, eligible: this.entries.filter(e => e.eligible).length, skipped: this.entries.filter(e => !e.eligible).length, truncated: !!preview.truncated };
    this.status.currentProvider = config.target;
    this.lastInspection = this.now(); this.lastRevision = config.revision;
    this.status.previewAt = new Date(this.now()).toISOString();
    return preview;
  }
  async cycle() {
    if (!this.canRun()) { this.stoppedSince = null; this.set('paused', '正在退出、重启或更新，自动兼容暂缓'); return; }
    if (!this.storage.settings.autoSessionRepair) { this.stoppedSince = null; this.set('off', '未开启'); return; }
    if (this.now() < this.holdUntil) { this.stoppedSince = null; this.set('manual', '修复列表正在打开，关闭列表后继续'); return; }
    if (this.now() < this.retryAt) return;
    try {
      const config = await this.repair.config();
      if (this.status.currentProvider !== config.target || (this.lastInspection && this.lastRevision !== config.revision)) { this.lastInspection = 0; this.entries = []; this.status.counts = null; }
      this.status.currentProvider = config.target;
      const blockers = [];
      if (config.target !== TARGET) blockers.push('当前连接入口不兼容，请在 API 列表中点击「同步入口」或「切换」');
      if (this.monitor.enabled || this.monitor.active.size || this.monitor.recoveryWarning) blockers.push('请关闭请求监控，并等待请求结束、完成配置恢复');
      try { await this.repair.checkStopped(); }
      catch (e) {
        if (e.kind !== 'codex-running') throw e;
        blockers.push(e.processes?.editor ? `Codex 仍在运行（其中 ${e.processes.editor} 个来自 VS Code / 编辑器），请正常退出 App、CLI 和编辑器中的 Codex` : 'Codex 仍在运行，请正常退出 App、全部 CLI 和编辑器中的 Codex');
      }
      this.status.blockers = blockers;
      this.status.checkedAt = new Date(this.now()).toISOString();
      if (blockers.length) {
        this.stoppedSince = null;
        if (config.target === TARGET && (!this.lastInspection || this.now() - this.lastInspection >= 60000)) await this.inspect(config);
        this.set(config.target !== TARGET ? 'target' : this.monitor.enabled || this.monitor.active.size || this.monitor.recoveryWarning ? 'monitor' : 'waiting', blockers[0]); return;
      }
      if (this.stoppedSince === null) this.stoppedSince = this.now();
      if (this.now() - this.stoppedSince < this.quietMs) { this.set('waiting', 'Codex 已退出，等待文件写入结束；尚未修改对话'); return; }
      if (this.status.phase === 'idle' && this.lastInspection && this.now() - this.lastInspection < 60000) { this.emit(); return; }
      this.set('scanning', '正在检查旧对话和历史索引');
      const preview = await this.inspect(config);
      if (preview.pending) { this.set('attention', '上次修复未完成，请在「修复旧对话」中撤回恢复'); return; }
      let size = 0; const ids = [];
      for (const entry of this.entries) {
        if (!entry.eligible || ids.length >= 100) continue;
        const bytes = this.repair.preview.candidates.get(entry.id).size;
        if (size + bytes <= 384 * 1024 * 1024) { ids.push(entry.id); size += bytes; }
      }
      if (!ids.length) {
        if (preview.truncated) { this.offset += 3000; this.set('scanning', '正在继续检查较早的旧对话'); }
        else { this.offset = 0; this.set('idle', this.status.counts.skipped ? `本轮没有可处理的对话，${this.status.counts.skipped} 个已跳过，查看记录了解原因` : '检查完成，没有需要兼容的对话'); }
        return;
      }
      if (!this.canRun() || !this.storage.settings.autoSessionRepair) return;
      const selected = this.entries.filter(e => ids.includes(e.id));
      this.set('repairing', `正在备份并处理 ${ids.length} 个旧对话，请稍候再打开 Codex`);
      const result = await this.repair.apply({ token: preview.token, ids });
      this.status.repaired += result.count; this.offset = 0;
      await this.record(result, selected);
      this.entries = this.entries.filter(e => !ids.includes(e.id));
      this.status.counts.eligible -= ids.length;
      this.set('complete', `本批已兼容 ${result.count} 个对话，可以打开 Codex`);
    } catch (error) {
      this.stoppedSince = null;
      if (error.kind === 'codex-running') this.set('waiting', '检测到 Codex 已打开，处理暂缓；请退出后重试');
      else {
        this.retryAt = this.now() + 5 * 60000;
        this.set('error', knownFailures.get(error.message) || (['EACCES', 'EPERM', 'ENOSPC', 'ENOENT'].includes(error.code) ? '无法读取或保存本机文件，请检查权限、目录和磁盘空间' : '自动兼容未完成，请打开修复列表查看原因；5 分钟后重试'));
      }
    }
  }
}
