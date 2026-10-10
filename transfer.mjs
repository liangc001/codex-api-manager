import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite, normalizeUrl } from './core.mjs';

const MAX_ITEMS = 500;
const MAX_BYTES = 8 * 1024 * 1024;
const identity = p => JSON.stringify([p.name, p.url]);
const inside = (parent, child) => { const rel = path.relative(parent, child); return !rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };

export function parseBundle(text) {
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('配置文件不能超过 8 MiB。');
  let raw;
  try { raw = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('配置文件不是有效的 JSON。'); }
  if (!raw || raw.format !== 'codex-api-manager' || raw.version !== 1 || !Array.isArray(raw.profiles) || !raw.profiles.length || raw.profiles.length > MAX_ITEMS) {
    throw new Error('请选择本工具导出的配置文件（最多 500 个 API）。');
  }
  const seen = new Set();
  return raw.profiles.map((input, index) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`第 ${index + 1} 个 API 格式无效。`);
    const { name, model, effort, adapter, url, key } = input;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80 || typeof model !== 'string' || !model.trim() || model.trim().length > 100) throw new Error(`第 ${index + 1} 个 API 的名称或模型无效。`);
    if (typeof url !== 'string' || url.length > 2000) throw new Error(`第 ${index + 1} 个 API 地址无效。`);
    let normalized;
    try { normalized = normalizeUrl(url); } catch { throw new Error(`第 ${index + 1} 个 API 需要有效的 HTTPS 地址。`); }
    if (!['minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort) || !['auto', 'newapi', 'sub2api', 'none'].includes(adapter)) throw new Error(`第 ${index + 1} 个 API 的选项无效。`);
    if (typeof key !== 'string' || !key.trim() || key.length > 8192 || /[\r\n]/.test(key)) throw new Error(`第 ${index + 1} 个 API 缺少有效的 Key。`);
    const profile = { name: name.trim(), url: normalized, model: model.trim(), effort, adapter, key: key.trim() };
    const id = identity(profile);
    if (seen.has(id)) throw new Error('文件中存在同名、同地址的重复 API。');
    seen.add(id);
    return profile;
  });
}

function selection(values, allowed) {
  if (!Array.isArray(values) || !values.length || values.length > MAX_ITEMS || new Set(values).size !== values.length || values.some(v => !allowed.has(v))) throw new Error('请选择有效的 API。');
  return new Set(values);
}

export class TransferService {
  constructor(manager, monitor) { this.manager = manager; this.monitor = monitor; }
  discard() { clearTimeout(this.expiryTimer); this.pending = null; }
  preview(text, fileName = '') {
    this.discard();
    const profiles = parseBundle(text);
    const token = crypto.randomUUID();
    this.pending = { token, profiles };
    this.expiryTimer = setTimeout(() => this.discard(), 15 * 60 * 1000);
    this.expiryTimer.unref();
    return { token, fileName: path.basename(fileName), profiles: profiles.map(({ key, ...p }, index) => ({ ...p, index, hasKey: !!key,
      duplicate: this.manager.store.profiles.some(existing => identity(existing) === identity(p)) })) };
  }
  async openFile(file) {
    this.discard();
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('请选择不超过 8 MiB 的配置文件。');
      return this.preview(await handle.readFile('utf8'), file);
    } finally { await handle.close(); }
  }
  async exportBundle(ids) {
    const selected = selection(ids, new Set(this.manager.store.profiles.map(p => p.id)));
    const profiles = [];
    const seen = new Set();
    for (const p of this.manager.store.profiles) {
      if (!selected.has(p.id)) continue;
      const duplicateId = identity(p);
      if (seen.has(duplicateId)) throw new Error('所选 API 有同名、同地址的重复项，请修改名称或分开导出。');
      seen.add(duplicateId);
      const row = { name: p.name, url: p.url, model: p.model, effort: p.effort, adapter: p.adapter };
      if (!p.encryptedKey) throw new Error('所选 API 尚未填写 Key，请先补填。');
      row.key = await this.manager.codec.decrypt(p.encryptedKey);
      profiles.push(row);
    }
    return { format: 'codex-api-manager', version: 1, profiles };
  }
  async exportTo(file, ids) {
    if (path.extname(file).toLowerCase() !== '.json') throw new Error('请保存为 .json 文件。');
    const parent = await fs.realpath(path.dirname(file));
    const target = path.join(parent, path.basename(file));
    for (const folder of [this.manager.dataDir, this.manager.home]) {
      const actual = await fs.realpath(folder).catch(e => { if (e.code === 'ENOENT') return path.resolve(folder); throw e; });
      if (inside(actual, target)) throw new Error('请导出到数据目录和 Codex 配置目录之外，避免覆盖运行文件。');
    }
    const bundle = await this.exportBundle(ids);
    const text = JSON.stringify(bundle, null, 2) + '\n';
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('所选配置超过 8 MiB，请分批导出。');
    await atomicWrite(target, text);
    return { count: bundle.profiles.length };
  }
  async apply({ token, indices, duplicates }) {
    if (!this.pending || token !== this.pending.token) throw new Error('预览已过期，请重新选择文件。');
    if (!['skip', 'replace'].includes(duplicates)) throw new Error('重复项处理方式无效。');
    const selected = selection(indices, new Set(this.pending.profiles.map((_, index) => index)));
    const previous = this.manager.store;
    const next = { ...previous, profiles: [...previous.profiles] };
    const counts = { added: 0, updated: 0, skipped: 0 };
    for (const index of selected) {
      const { key, ...fields } = this.pending.profiles[index];
      const existingIndex = next.profiles.findIndex(p => identity(p) === identity(fields));
      const existing = next.profiles[existingIndex];
      if (existing && duplicates === 'skip') { counts.skipped++; continue; }
      if (existing && this.monitor?.enabled && existing.id === this.monitor.profile.id) throw new Error('请先关闭监控，再覆盖当前 API。');
      const profile = { ...fields, id: existing?.id || crypto.randomUUID(), encryptedKey: await this.manager.codec.encrypt(key), favorite: existing?.favorite === true };
      if (existing) { next.profiles[existingIndex] = profile; counts.updated++; }
      else { next.profiles.push(profile); counts.added++; }
    }
    if (counts.added || counts.updated) {
      this.manager.store = next;
      try { await this.manager.persist(); } catch (e) { this.manager.store = previous; throw e; }
      for (const p of next.profiles) {
        if (previous.profiles.find(old => old.id === p.id) !== p) this.manager.connectionTests.delete(p.id);
      }
    }
    this.discard();
    return counts;
  }
}
