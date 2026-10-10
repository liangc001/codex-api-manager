import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite, updateConfig, parseConfig, restoreMonitorConfig } from './core.mjs';

const digest = text => crypto.createHash('sha256').update(text ?? '<absent>').digest('hex');
async function read(file) {
  try { return await fs.readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function headers(source, extra = {}) {
  const denied = new Set(['host', 'authorization', 'cookie', 'set-cookie', 'origin', 'referer', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'accept-encoding']);
  for (const name of String(source.connection || '').split(',')) denied.add(name.trim().toLowerCase());
  return { ...Object.fromEntries(Object.entries(source).filter(([name]) => !denied.has(name.toLowerCase()))), ...extra };
}

export class RequestMonitor {
  constructor(manager, { requester = (url, opts, cb) => (url.protocol === 'https:' ? https : http).request(url, opts, cb) } = {}) {
    this.manager = manager;
    this.requester = requester;
    this.sessionFile = path.join(manager.dataDir, 'monitor-session.json');
    this.server = null;
    this.enabled = false;
    this.profile = null;
    this.token = crypto.randomBytes(32).toString('hex');
    this.active = new Map();
    this.finished = [];
    this.byProvider = new Map();
    this.startedAt = Date.now();
    this.recoveryWarning = '';
    this.drainWaiters = [];
  }
  async recover() {
    const saved = await read(this.sessionFile);
    if (!saved) return;
    const snapshot = JSON.parse(await this.manager.codec.decrypt(saved));
    if (snapshot.origin && snapshot.origin !== this.manager.origin) {
      const destination = path.join(this.manager.dataDir, 'backups', `monitor-other-machine-${crypto.randomUUID()}.json`);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.rename(this.sessionFile, destination);
      this.recoveryNotice = '监控备份来自另一台电脑，已保留备份，没有覆盖本机 Codex 配置。';
      return;
    }
    await this.restoreSession(snapshot);
  }
  async restoreSession(snapshot) {
    const config = await read(this.manager.configPath), auth = await read(this.manager.authPath);
    let nextConfig = config, nextAuth = auth;
    const unchanged = digest(config) === snapshot.configHash && digest(auth) === snapshot.authHash;
    const alreadyRestored = config === snapshot.config && auth === snapshot.auth;
    if (unchanged) { nextConfig = snapshot.config; nextAuth = snapshot.auth; }
    else if (!alreadyRestored) {
      // Restore only monitor-owned connection fields; preserve settings and credentials edited elsewhere.
      try {
        const originalConfig = parseConfig(snapshot.config || ''), currentConfig = parseConfig(config || '');
        const originalUrl = originalConfig.model_providers?.[originalConfig.model_provider]?.base_url;
        const alreadyDirect = !!originalUrl && currentConfig.model_provider === originalConfig.model_provider
          && currentConfig.model_providers?.[currentConfig.model_provider]?.base_url === originalUrl;
        let expected = snapshot.monitoredConfig;
        if (!expected) {
          const before = parseConfig(snapshot.config || '');
          const p = before.model_providers?.[before.model_provider];
          const current = parseConfig(config || '');
          const local = current.model_providers?.codex_api_manager?.base_url;
          if (p && local) {
            for (const syncLegacy of [true, false]) {
              const candidate = updateConfig(snapshot.config || '', { name: p.name, url: local, model: before.model, effort: before.model_reasoning_effort }, { syncLegacy });
              if (digest(candidate) === snapshot.configHash) { expected = candidate; break; }
            }
          }
        }
        if (expected) nextConfig = restoreMonitorConfig(config, snapshot.config, expected);
        if (nextConfig !== config || alreadyDirect || config === snapshot.config) {
          if (digest(auth) === snapshot.authHash) nextAuth = snapshot.auth;
          else {
            const currentAuth = JSON.parse(auth || '{}');
            const expectedAuth = snapshot.monitoredAuth || JSON.stringify({ OPENAI_API_KEY: currentAuth.OPENAI_API_KEY }, null, 2) + '\n';
            if (digest(expectedAuth) === snapshot.authHash && currentAuth.OPENAI_API_KEY === JSON.parse(expectedAuth).OPENAI_API_KEY) {
              const originalAuth = JSON.parse(snapshot.auth || '{}');
              if (Object.hasOwn(originalAuth, 'OPENAI_API_KEY')) currentAuth.OPENAI_API_KEY = originalAuth.OPENAI_API_KEY;
              else delete currentAuth.OPENAI_API_KEY;
              nextAuth = JSON.stringify(currentAuth, null, 2) + '\n';
            }
          }
        }
      } catch {
        nextConfig = config; nextAuth = auth;
      }
      const archived = path.join(this.manager.dataDir, 'backups', `monitor-conflict-${crypto.randomUUID()}.json`);
      await fs.mkdir(path.dirname(archived), { recursive: true });
      await fs.copyFile(this.sessionFile, archived, fs.constants.COPYFILE_EXCL);
      this.recoveryNotice = nextConfig !== config ? '已关闭监控，保留外部配置修改及加密备份；请重启 Codex。'
        : '已停止监控并保留外部配置及加密备份；请重新切换 API 并重启 Codex。';
    }
    if (nextConfig !== config || nextAuth !== auth) {
      if (await read(this.manager.configPath) !== config || await read(this.manager.authPath) !== auth) throw new Error('恢复期间 Codex 配置发生变化，请重试。');
      try { await this.manager.writePair(nextConfig, nextAuth); }
      catch (e) {
        const actualConfig = await read(this.manager.configPath), actualAuth = await read(this.manager.authPath);
        if ((actualConfig === config || actualConfig === nextConfig) && (actualAuth === auth || actualAuth === nextAuth)) await this.manager.writePair(config, auth);
        throw e;
      }
    }
    await fs.rm(this.sessionFile, { force: true });
    this.recoveryWarning = '';
  }
  async startServer() {
    if (this.server) return;
    this.server = http.createServer((req, res) => { this.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(502); res.end(); }); });
    this.server.requestTimeout = 120000;
    this.server.headersTimeout = 30000;
    try { await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); }); }
    catch (e) { this.server = null; throw e; }
    this.localUrl = `http://127.0.0.1:${this.server.address().port}/v1`;
  }
  async enable(id) {
    if (this.recoveryWarning) throw new Error(this.recoveryWarning);
    if (await read(this.sessionFile)) throw new Error('存在未恢复的监控备份，请重新启动程序恢复后再开启监控。');
    const p = this.manager.store.profiles.find(p => p.id === id);
    if (!p?.encryptedKey) throw new Error('请先选择已配置 Key 的 API。');
    const key = await this.manager.codec.decrypt(p.encryptedKey);
    await this.startServer();
    const config = await read(this.manager.configPath), auth = await read(this.manager.authPath);
    const nextConfig = updateConfig(config || '', { ...p, url: this.localUrl });
    const nextAuth = JSON.stringify({ OPENAI_API_KEY: this.token }, null, 2) + '\n';
    const snapshot = { config, auth, monitoredConfig: nextConfig, monitoredAuth: nextAuth,
      configHash: digest(nextConfig), authHash: digest(nextAuth), origin: this.manager.origin };
    await atomicWrite(this.sessionFile, await this.manager.codec.encrypt(JSON.stringify(snapshot)));
    try {
      if (await read(this.manager.configPath) !== config || await read(this.manager.authPath) !== auth) throw new Error('Codex 配置发生变化，请重试。');
      await this.manager.writePair(nextConfig, nextAuth);
      this.profile = { ...p, key };
      this.enabled = true;
      this.snapshot = snapshot;
    } catch (e) {
      // Only roll back files actually written by this operation.
      const actualConfig = await read(this.manager.configPath), actualAuth = await read(this.manager.authPath);
      if ((actualConfig === config || actualConfig === nextConfig) && (actualAuth === auth || actualAuth === nextAuth)) {
        await this.manager.writePair(config, auth);
        await fs.rm(this.sessionFile, { force: true });
      } else this.recoveryWarning = '监控配置发生冲突，已保留加密备份。';
      throw e;
    }
  }
  async disable({ keepRouting = false } = {}) {
    if (!this.enabled) return;
    await this.restoreSession(this.snapshot);
    if (!keepRouting) { this.enabled = false; this.profile = null; }
  }
  summary() {
    const now = Date.now();
    const totals = [...this.byProvider.values()];
    const completed = totals.reduce((n, s) => n + s.success + s.failed, 0);
    const pendingWithHeaders = [...this.active.values()].filter(r => r.firstByte != null);
    const firstByteSamples = totals.reduce((n, s) => n + s.firstByteSamples, 0) + pendingWithHeaders.length;
    const recent = [...this.active.values(), ...this.finished].sort((a, b) => b.startedAt - a.startedAt).slice(0, 30).map(r => ({ ...r, duration: (r.endedAt || now) - r.startedAt }));
    const provider = {};
    for (const [id, s] of this.byProvider) provider[id] = { ...s, active: [...this.active.values()].filter(r => r.profileId === id).length };
    return { enabled: this.enabled, active: this.active.size, peak: this.peak || 0, startedAt: this.startedAt,
      rpm: [...this.active.values(), ...this.finished].filter(r => now - r.startedAt < 60000).length,
      success: totals.reduce((n, s) => n + s.success, 0), failed: totals.reduce((n, s) => n + s.failed, 0),
      limited: totals.reduce((n, s) => n + s.limited, 0),
      successRate: completed ? totals.reduce((n, s) => n + s.success, 0) / completed : null,
      firstByte: firstByteSamples ? (totals.reduce((n, s) => n + s.firstByteTotal, 0) + pendingWithHeaders.reduce((n, r) => n + r.firstByte, 0)) / firstByteSamples : null,
      provider, recent, recoveryWarning: this.recoveryWarning || this.recoveryNotice || '' };
  }
  async handle(req, res) {
    const fail = (status, text) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: text } })); };
    if (req.headers.origin || req.headers.authorization !== `Bearer ${this.token}`) return fail(401, 'Local monitor authentication required');
    if (!this.enabled || !this.profile) return fail(503, 'Monitoring disabled; restart Codex to use direct configuration');
    const requestUrl = new URL(req.url, 'http://localhost');
    const route = requestUrl.pathname;
    const allowed = route === '/v1/models' && req.method === 'GET' ||
      ['/v1/responses', '/v1/responses/compact', '/v1/chat/completions'].includes(route) && req.method === 'POST' ||
      /^\/v1\/responses\/[a-zA-Z0-9_-]+$/.test(route) && ['GET', 'DELETE'].includes(req.method);
    if (!allowed) return fail(404, 'Unsupported API route');
    // Pin each accepted request to its provider so switching cannot redirect an existing stream.
    const profile = this.profile;
    const record = { id: crypto.randomUUID(), profileId: profile.id, provider: profile.name, model: req.method === 'POST' ? profile.model : '—',
      method: req.method, route, startedAt: Date.now(), status: null, firstByte: null, endedAt: null };
    const s = this.byProvider.get(profile.id) || { success: 0, failed: 0, limited: 0, firstByteTotal: 0, firstByteSamples: 0 };
    this.byProvider.set(profile.id, s);
    this.active.set(record.id, record);
    this.peak = Math.max(this.peak || 0, this.active.size);
    let done = false, upstream;
    const finish = (status, label) => {
      if (done) return;
      done = true; record.status = status; record.label = label; record.endedAt = Date.now();
      this.active.delete(record.id); this.finished.unshift(record);
      // Keep metadata for RPM counting for one minute; the visible table shows the latest 30.
      this.finished = this.finished.filter((r, index) => index < 100 || Date.now() - r.startedAt < 60000);
      if (status >= 200 && status < 300 && label !== 'cancelled') s.success++; else s.failed++;
      if (status === 429) s.limited++;
      if (record.firstByte != null) { s.firstByteTotal += record.firstByte; s.firstByteSamples++; }
      this.manager.storage?.record('request', { profileId: record.profileId, status, outcome: label, failureSource: record.failureSource,
        durationMs: record.endedAt - record.startedAt, firstByteMs: record.firstByte });
      if (!this.active.size) { for (const resolve of this.drainWaiters.splice(0)) resolve(); }
    };
    res.on('finish', () => finish(record.status || 502, 'completed'));
    res.on('close', () => { if (!done) { upstream?.destroy(); finish(499, 'cancelled'); } });
    req.on('aborted', () => { upstream?.destroy(); finish(499, 'cancelled'); });
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 64 * 1024 * 1024) { record.status = 413; fail(413, 'Request too large'); return; }
        chunks.push(chunk);
      }
      if (done) return;
      const body = Buffer.concat(chunks);
      if (body.length && !req.headers['content-encoding']) {
        try { const model = JSON.parse(body.toString()).model; if (typeof model === 'string') record.model = model.slice(0, 100); } catch {}
      }
      const url = new URL(profile.url.replace(/\/$/, '') + route.slice(3));
      url.search = requestUrl.search;
      const outgoing = headers(req.headers, { authorization: `Bearer ${profile.key}`, 'accept-encoding': 'identity', 'content-length': body.length });
      upstream = this.requester(url, { method: req.method, headers: outgoing }, response => {
        if (done) { response.destroy(); return; }
        record.firstByte = Date.now() - record.startedAt;
        record.status = response.statusCode;
        if (response.statusCode >= 400) record.failureSource = 'upstream';
        res.writeHead(response.statusCode, headers(response.headers));
        response.on('error', () => { record.failureSource = 'transport'; finish(502, 'network'); res.destroy(); });
        response.on('aborted', () => { record.failureSource = 'transport'; finish(502, 'network'); res.destroy(); });
        response.pipe(res);
      });
      upstream.setTimeout(20 * 60 * 1000, () => { upstream.destroy(); });
      upstream.on('error', () => {
        if (done) return;
        record.status = 502;
        record.failureSource = 'transport';
        if (!res.headersSent) fail(502, 'Upstream connection failed'); else { finish(502, 'network'); res.destroy(); }
      });
      upstream.end(body);
    } catch { record.status = 502; record.failureSource = 'local'; if (!res.headersSent) fail(502, 'Local proxy failed'); else { finish(502, 'network'); res.destroy(); } }
  }
  async shutdown() {
    await this.disable();
    if (this.server) {
      const close = new Promise(resolve => this.server.close(resolve));
      this.server.closeIdleConnections();
      if (this.active.size) await new Promise(resolve => this.drainWaiters.push(resolve));
      await close; this.server = null;
    }
  }
}

export class MonitorController {
  constructor(manager, options) { this.manager = manager; this.monitor = new RequestMonitor(manager, options); }
  async init() { await this.monitor.recover(); }
  async state() {
    const state = await this.manager.state();
    const m = this.monitor;
    if (m.enabled) {
      for (const p of state.profiles) p.active = p.id === m.profile.id;
      state.current = { ...state.current, url: m.profile.url, model: m.profile.model, needsProfileSync: false };
      state.canRestore = false;
    }
    return { ...state, monitor: m.summary() };
  }
  async setMonitoring(enabled) {
    if (enabled && !this.monitor.enabled) {
      const state = await this.manager.state();
      const active = state.profiles.find(p => p.active);
      if (!active) throw new Error('请先导入当前配置，或切换到一个已保存 Key 的 API。');
      await this.monitor.enable(active.id);
    } else if (!enabled) await this.monitor.disable();
  }
  async switchTo(id) {
    const monitored = this.monitor.enabled;
    if (monitored) await this.monitor.disable({ keepRouting: true });
    try { await this.manager.switchTo(id); if (monitored) await this.monitor.enable(id); }
    catch (e) { this.monitor.enabled = false; this.monitor.profile = null; throw e; }
  }
  async save(input) {
    if (this.monitor.enabled && input.id === this.monitor.profile.id) throw new Error('请先关闭实时监控，再编辑当前 API。');
    await this.manager.save(input);
  }
  async remove(id) {
    if (this.monitor.enabled && id === this.monitor.profile.id) throw new Error('无法删除正在监控的 API。');
    return this.manager.remove(id);
  }
  async restore() {
    if (this.monitor.enabled) throw new Error('请先关闭实时监控，再撤销切换。');
    await this.manager.restore();
  }
  async importCurrent() {
    if (this.monitor.enabled) throw new Error('请先关闭实时监控，再导入配置。');
    return this.manager.importCurrent();
  }
}
