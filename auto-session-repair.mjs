import { SessionRepair } from './session-repair.mjs';

// One worker per manager. All file/database changes share the manager's operation queue.
export class AutoSessionRepair {
  constructor(manager, storage, monitor, { repair = new SessionRepair(manager), now = Date.now, quietMs = 5000, canRun = () => true, onChange = () => {} } = {}) {
    Object.assign(this, { manager, storage, monitor, repair, now, quietMs, canRun, onChange });
    this.status = { phase: 'off', message: '未开启', repaired: 0 };
    this.holdUntil = 0; this.stoppedSince = null; this.offset = 0; this.retryAt = 0;
  }
  state() { return { ...this.status, enabled: this.storage.settings.autoSessionRepair === true, exclusions: [...(this.storage.settings.sessionRepairExclusions || [])] }; }
  set(phase, message) {
    const changed = this.status.phase !== phase || this.status.message !== message;
    this.status = { ...this.status, phase, message };
    if (changed) { try { this.onChange(this.state()); } catch {} }
  }
  hold() { this.holdUntil = this.now() + 15 * 60000; this.stoppedSince = null; }
  release() { this.holdUntil = 0; this.stoppedSince = null; }
  reset() { this.offset = 0; this.retryAt = 0; this.stoppedSince = null; this.set(this.storage.settings.autoSessionRepair ? 'waiting' : 'off', this.storage.settings.autoSessionRepair ? '等待 Codex 完全退出后自动兼容' : '未开启'); }
  async tick() {
    if (this.active) return;
    this.active = true;
    try { await this.manager.exclusive(() => this.cycle()); }
    finally { this.active = false; }
  }
  async cycle() {
    if (!this.canRun()) { this.stoppedSince = null; return; }
    if (!this.storage.settings.autoSessionRepair) { this.stoppedSince = null; this.set('off', '未开启'); return; }
    if (this.now() < this.holdUntil) { this.stoppedSince = null; this.set('manual', '正在查看修复列表，自动兼容暂缓'); return; }
    if (this.monitor.enabled || this.monitor.active.size || this.monitor.recoveryWarning) { this.stoppedSince = null; this.set('monitor', '等待请求监控关闭'); return; }
    if (this.now() < this.retryAt) return;
    try {
      await this.repair.checkStopped();
      if (this.stoppedSince === null) this.stoppedSince = this.now();
      if (this.now() - this.stoppedSince < this.quietMs) { this.set('waiting', 'Codex 已退出，正在等待文件写入结束'); return; }
      const config = await this.repair.config();
      if (config.target !== 'codex_api_manager') { this.set('target', '请先使用本工具切换一次 API，统一连接入口'); return; }
      const preview = await this.repair.scan({ excludeIds: this.storage.settings.sessionRepairExclusions || [], skipProviders: ['openai', 'ollama', 'lmstudio'], offset: this.offset });
      if (preview.pending) { this.set('attention', '上次修复未完成，请在「修复旧对话」中撤回恢复'); return; }
      let size = 0; const ids = [];
      for (const entry of preview.entries) {
        if (!entry.eligible || ids.length >= 100) continue;
        const bytes = this.repair.preview.candidates.get(entry.id).size;
        if (size + bytes <= 384 * 1024 * 1024) { ids.push(entry.id); size += bytes; }
      }
      if (!ids.length) {
        if (preview.truncated) { this.offset += 3000; this.set('scanning', '正在继续检查较早的旧对话'); }
        else { this.offset = 0; this.set('idle', this.status.repaired ? `本次已自动兼容 ${this.status.repaired} 个旧对话` : '暂无需要自动兼容的对话'); }
        return;
      }
      if (!this.canRun() || !this.storage.settings.autoSessionRepair) return;
      this.set('repairing', '正在备份并兼容旧对话，请稍候再打开 Codex');
      const result = await this.repair.apply({ token: preview.token, ids });
      this.status.repaired += result.count; this.offset = 0;
      this.set('complete', `已自动兼容 ${this.status.repaired} 个旧对话，可以打开 Codex`);
    } catch (error) {
      if (error.kind === 'codex-running') { this.stoppedSince = null; this.set('waiting', '等待 Codex 完全退出后自动兼容'); }
      else {
        this.stoppedSince = null; this.retryAt = this.now() + 5 * 60000;
        this.set('error', error.code ? '自动兼容暂缓，请检查数据目录或在修复列表中处理' : '自动兼容暂缓，请在「修复旧对话」中查看原因');
      }
    }
  }
}
