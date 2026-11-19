import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Manager, atomicWrite, normalizeUrl } from './core.mjs';
import { RequestMonitor } from './monitor.mjs';

const fields = { bearer: 'ANTHROPIC_AUTH_TOKEN', 'api-key': 'ANTHROPIC_API_KEY' };
const base = 'ANTHROPIC_BASE_URL', modelField = 'ANTHROPIC_MODEL';
const routing = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
const conflictFields = [base, ...Object.values(fields), modelField, 'ANTHROPIC_CUSTOM_HEADERS', ...routing];
const read = file => fs.readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const value = x => typeof x === 'string' ? x.trim() : '';

export function normalizeClaudeUrl(input) {
  if (typeof input !== 'string' || input.length > 2000) throw new Error('请输入有效的 HTTPS 网关地址。');
  let url;
  try { url = normalizeUrl(input.trim()); } catch { throw new Error('请输入有效的 HTTPS 网关地址。'); }
  return url.replace(/\/v1(?:\/messages)?$/, '');
}

export function claudeProfile(input) {
  const { name, url, model, auth, key } = input;
  const adapter = input.adapter ?? 'auto';
  if (!['auto', 'newapi', 'sub2api', 'none'].includes(adapter)) throw new Error('查询类型无效。');
  const result = { name: value(name), url: normalizeClaudeUrl(url), model: value(model), auth, key: value(key), adapter };
  if (!result.name || result.name.length > 80 || result.model.length > 100 || /[\r\n\0]/.test(result.model)) throw new Error('请输入有效的名称和模型 ID。');
  if (!Object.hasOwn(fields, auth)) throw new Error('请选择有效的认证方式。');
  if (result.key.length > 8192 || /[^\x21-\x7e]/.test(result.key)) throw new Error('Key 格式无效。');
  return result;
}

function parseSettings(raw) {
  let settings;
  try { settings = raw === null ? {} : JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch { throw new Error('Claude Code 的 settings.json 不是有效的 JSON。'); }
  if (!object(settings) || (settings.env !== undefined && !object(settings.env))) throw new Error('Claude Code 的 settings.json 格式无效。');
  return settings;
}

export class ClaudeManager extends Manager {
  constructor({ claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), ...options }) {
    super({ ...options, codexHome: path.resolve(claudeHome) });
    this.storePath = path.join(this.dataDir, 'claude-profiles.json');
    this.configPath = path.join(this.home, 'settings.json');
  }
  async state() {
    const raw = await read(this.configPath);
    let env = {}, configError = '';
    try { env = parseSettings(raw).env || {}; } catch (e) { configError = e.message; }
    let url = '';
    try { url = normalizeClaudeUrl(env[base]); } catch {}
    const auth = env[fields.bearer] ? 'bearer' : 'api-key';
    const key = env[fields.bearer] && env[fields['api-key']] ? '' : env[fields[auth]];
    const profiles = [];
    for (const { encryptedKey, ...p } of this.store.profiles) {
      const active = !!(url === p.url && key && auth === p.auth && (env[modelField] || '') === p.model && encryptedKey && await this.codec.decrypt(encryptedKey) === key);
      profiles.push({ ...p, adapter: p.adapter ?? 'auto', active: active && !profiles.some(row => row.active), hasKey: !!encryptedKey, connectionTest: this.connectionTests.get(p.id) });
    }
    const backup = this.store.lastBackup;
    return { profiles, current: { url, model: value(env[modelField]) }, configError, configDir: this.home, dataDir: this.dataDir,
      conflicts: conflictFields.filter(k => process.env[k]),
      canRestore: !!backup && backup.origin === this.origin && raw !== null && backup.hash === digest(raw) };
  }
  async save(input) {
    const existing = this.store.profiles.find(p => p.id === input.id);
    if (input.id && !existing) throw new Error('API 不存在。');
    const { key, ...profile } = claudeProfile(input);
    if (!key && (!existing?.encryptedKey || profile.url !== existing.url)) throw new Error('请填写此网关的 Key；修改地址时需要重新填写。');
    const next = { ...profile, id: existing?.id || crypto.randomUUID(), favorite: existing?.favorite === true,
      encryptedKey: key ? await this.codec.encrypt(key) : existing.encryptedKey };
    const previous = this.store;
    this.store = { ...previous, profiles: existing ? previous.profiles.map(p => p === existing ? next : p) : [...previous.profiles, next] };
    try { await this.persist(); } catch (e) { this.store = previous; throw e; }
    this.connectionTests.delete(next.id);
  }
  async listModels(input, fetcher) {
    const url = normalizeClaudeUrl(input.url);
    if (!Object.hasOwn(fields, input.auth)) throw new Error('请选择有效的认证方式。');
    let key = value(input.key);
    if (!key && input.id) {
      const p = this.store.profiles.find(row => row.id === input.id);
      if (p?.url !== url) throw new Error('修改地址后请填写该服务商的 Key。');
      key = await this.readKey(input.id);
    }
    const { queryModels } = await import('./models.mjs');
    return queryModels(url, key, fetcher, input.auth);
  }
  async importCurrent() {
    const env = parseSettings(await read(this.configPath)).env || {};
    if (!env[base] || !!env[fields.bearer] === !!env[fields['api-key']]) return false;
    const url = normalizeClaudeUrl(env[base]), auth = env[fields.bearer] ? 'bearer' : 'api-key';
    const key = env[fields[auth]], model = value(env[modelField]);
    let existing;
    for (const p of this.store.profiles) {
      if (p.url === url && p.auth === auth && await this.readKey(p.id) === key) { existing = p; break; }
    }
    const host = new URL(url).hostname;
    let name = host;
    for (let n = 2; this.store.profiles.some(p => p.url === url && p.name === name); n++) name = host + ' (' + n + ')';
    await this.save({ id: existing?.id, name: existing?.name || name, url, auth, key, model, adapter: existing?.adapter });
    return true;
  }
  async switchTo(id) {
    const profile = this.store.profiles.find(p => p.id === id);
    if (!profile?.encryptedKey) throw new Error('请选择已保存 Key 的 Claude API。');
    const { key, url, auth, model } = claudeProfile({ ...profile, key: await this.codec.decrypt(profile.encryptedKey) });
    if (!key) throw new Error('此 API 缺少 Key。');
    const raw = await read(this.configPath), settings = parseSettings(raw), env = { ...settings.env };
    if (settings.apiKeyHelper || env.ANTHROPIC_CUSTOM_HEADERS || routing.some(name => env[name] === '1' || env[name] === 'true')) {
      throw new Error('Claude 用户设置启用了其他认证或云路由，请先关闭这些设置。');
    }
    const previousModel = env[modelField] || '';
    if (env[base] === url && env[fields[auth]] === key && !env[fields[auth === 'bearer' ? 'api-key' : 'bearer']] && previousModel === model) return;
    for (const name of Object.values(fields)) delete env[name];
    env[base] = url;
    env[fields[auth]] = key;
    if (model) env[modelField] = model; else delete env[modelField];
    const next = JSON.stringify({ ...settings, env }, null, 2) + '\n';
    const file = `claude-${crypto.randomUUID()}.enc`;
    await atomicWrite(path.join(this.dataDir, 'backups', file), await this.codec.encrypt(JSON.stringify({ raw })));
    await this.commit(raw, next, { file, hash: digest(next), origin: this.origin });
  }
  async restore() {
    const backup = this.store.lastBackup;
    if (!backup || backup.origin !== this.origin) throw new Error('没有可在本机撤销的 Claude 切换。');
    const current = await read(this.configPath);
    if (current === null || digest(current) !== backup.hash) throw new Error('Claude 配置已被其他程序修改，无法撤销。');
    const { raw } = JSON.parse(await this.codec.decrypt(await fs.readFile(path.join(this.dataDir, 'backups', backup.file), 'utf8')));
    parseSettings(raw);
    await this.commit(current, raw, null);
  }
  async commit(before, after, backup) {
    const write = text => text === null ? fs.rm(this.configPath, { force: true }) : atomicWrite(this.configPath, text);
    if (await read(this.configPath) !== before) throw new Error('Claude 配置已变化，请重试。');
    await write(after);
    const previous = this.store;
    this.store = { ...previous, lastBackup: backup };
    try { await this.persist(); }
    catch (e) { this.store = previous; if (await read(this.configPath) === after) await write(before); throw e; }
  }
}

export class ClaudeMonitor extends RequestMonitor {
  constructor(manager, options) {
    super(manager, options);
    this.sessionFile = path.join(manager.dataDir, 'claude-monitor-session.enc');
  }
  async enable(id) {
    if (await read(this.sessionFile)) throw new Error('存在未恢复的 Claude 监控配置，请重启管理工具。');
    const p = this.manager.store.profiles.find(row => row.id === id);
    if (!p || !(await this.manager.state()).profiles.find(row => row.id === id)?.active) throw new Error('请先切换到要监控的 Claude API。');
    const { key, ...profile } = claudeProfile({ ...p, key: await this.manager.readKey(id) });
    const config = await read(this.manager.configPath), settings = parseSettings(config);
    if (!key || settings.apiKeyHelper || settings.env?.ANTHROPIC_CUSTOM_HEADERS || routing.some(k => ['1', 'true'].includes(settings.env?.[k]))) {
      throw new Error('当前 Claude 认证或路由与请求监控不兼容。');
    }
    await this.startServer();
    const env = { ...settings.env, [base]: this.localUrl.slice(0, -3), [fields.bearer]: this.token };
    delete env[fields['api-key']];
    const monitoredConfig = JSON.stringify({ ...settings, env }, null, 2) + '\n';
    const snapshot = { config, monitoredConfig, origin: this.manager.origin };
    await atomicWrite(this.sessionFile, await this.manager.codec.encrypt(JSON.stringify(snapshot)));
    if (await read(this.manager.configPath) !== config) {
      await fs.rm(this.sessionFile, { force: true }); throw new Error('Claude 配置已变化，请重试。');
    }
    await atomicWrite(this.manager.configPath, monitoredConfig);
    this.profile = { ...profile, id, key }; this.snapshot = snapshot; this.enabled = true; this.recoveryWarning = '';
  }
  async restoreSession(snapshot) {
    const current = await read(this.manager.configPath);
    let next = current;
    if (current === snapshot.monitoredConfig) next = snapshot.config;
    else if (current !== snapshot.config) {
      const settings = parseSettings(current), env = { ...settings.env };
      const monitored = parseSettings(snapshot.monitoredConfig).env;
      const original = parseSettings(snapshot.config).env;
      const ownFields = [base, ...Object.values(fields)];
      if (ownFields.every(k => env[k] === monitored[k])) {
        for (const k of ownFields) {
          if (Object.hasOwn(original, k)) env[k] = original[k]; else delete env[k];
        }
        next = JSON.stringify({ ...settings, env }, null, 2) + '\n';
      } else if (env[base] === monitored[base] || env[fields.bearer] === monitored[fields.bearer]) {
        throw new Error('Claude 监控配置已被其他程序改动，未覆盖现有设置。');
      }
    }
    if (next !== current) {
      if (await read(this.manager.configPath) !== current) throw new Error('Claude 配置已变化，请重试。');
      await atomicWrite(this.manager.configPath, next);
    }
    await fs.rm(this.sessionFile, { force: true });
    this.recoveryWarning = '';
  }
}
