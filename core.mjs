import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { spawn } from 'node:child_process';
import { parseForESLint, getStaticTOMLValue } from 'toml-eslint-parser';

export function normalizeUrl(input) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /https?:/i.test(url.pathname)) {
    throw new Error('请输入完整的 HTTPS API 地址，不包含账号、查询参数或片段。');
  }
  return url.href.replace(/\/+$/, '');
}

export function parseConfig(text) {
  return getStaticTOMLValue(parseForESLint(text).ast);
}

function sharedAuthProviders(config) {
  return Object.entries(config.model_providers || {}).filter(([id, p]) => id !== 'codex_api_manager'
    && p.requires_openai_auth === true && p.wire_api === 'responses' && p.base_url
    && !p.env_key && !p.experimental_bearer_token
    && !Object.keys({ ...p.http_headers, ...p.env_http_headers }).some(k => k.toLowerCase() === 'authorization'));
}

export function updateConfig(text, profile, { syncLegacy = true } = {}) {
  const ast = parseForESLint(text).ast;
  const top = ast.body[0];
  const edits = [];
  const additions = [];
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  // Old conversations retain provider IDs. Shared auth requires their URLs to move together.
  if (syncLegacy) {
    for (const [id] of sharedAuthProviders(getStaticTOMLValue(ast))) {
      const table = top.body.find(n => n.type === 'TOMLTable' && n.resolvedKey.join('.') === `model_providers.${id}`);
      const base = table?.body.find(n => n.type === 'TOMLKeyValue' && getStaticTOMLValue(n.key).join('.') === 'base_url');
      if (!base) throw new Error('旧对话服务商地址格式不支持自动同步，请检查 Codex 配置。');
      edits.push({ start: base.value.range[0], end: base.value.range[1], text: JSON.stringify(profile.url) });
    }
  }
  const fields = { model_provider: 'codex_api_manager', model: profile.model,
    model_reasoning_effort: profile.effort };
  for (const [key, value] of Object.entries(fields)) {
    const item = top.body.find(n => n.type === 'TOMLKeyValue' && getStaticTOMLValue(n.key).join('.') === key);
    if (item) edits.push({ start: item.value.range[0], end: item.value.range[1], text: JSON.stringify(value) });
    else additions.push(`${key} = ${JSON.stringify(value)}`);
  }
  // AST ranges preserve comments, project settings, plugins, and formatting elsewhere.
  const table = top.body.find(n => n.type === 'TOMLTable' && n.resolvedKey.join('.') === 'model_providers.codex_api_manager');
  if (table) edits.push({ start: table.range[0], end: table.range[1], text: providerTable(profile, newline) });
  else edits.push({ start: text.length, end: text.length, text: newline + newline + providerTable(profile, newline) + newline });
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  text = (additions.length ? additions.join(newline) + newline : '') + text;
  const parsed = parseConfig(text);
  if (parsed.model_providers.codex_api_manager.base_url !== profile.url) throw new Error('配置校验失败。');
  return text;
}

function providerTable(p, nl) {
  return ['[model_providers.codex_api_manager]', `name = ${JSON.stringify(p.name)}`,
    `base_url = ${JSON.stringify(p.url)}`, 'wire_api = "responses"', 'requires_openai_auth = true'].join(nl);
}

export function restoreMonitorConfig(text, original, expected) {
  if (text === expected) return original;
  const currentAst = parseForESLint(text || '').ast.body[0];
  const originalAst = parseForESLint(original || '').ast.body[0];
  const current = parseConfig(text || ''), before = parseConfig(original || ''), managed = parseConfig(expected);
  const provider = managed.model_provider;
  const edits = [];
  const field = (body, key) => body.find(n => n.type === 'TOMLKeyValue' && getStaticTOMLValue(n.key).join('.') === key);
  // Recover legacy aliases independently, even if another program changed the default provider.
  for (const [id, expectedProvider] of sharedAuthProviders(managed)) {
    const originalUrl = before.model_providers?.[id]?.base_url;
    if (!originalUrl || originalUrl === expectedProvider.base_url
      || current.model_providers?.[id]?.base_url !== expectedProvider.base_url) continue;
    const table = currentAst.body.find(n => n.type === 'TOMLTable' && n.resolvedKey.join('.') === `model_providers.${id}`);
    const base = table && field(table.body, 'base_url');
    if (base) edits.push({ start: base.value.range[0], end: base.value.range[1], text: JSON.stringify(originalUrl) });
  }
  const ownsDefault = current.model_provider === provider
    && current.model_providers?.[provider]?.base_url === managed.model_providers?.[provider]?.base_url;
  for (const key of ['model_provider', 'model', 'model_reasoning_effort']) {
    if (!ownsDefault) continue;
    if (!isDeepStrictEqual(current[key], managed[key])) continue;
    const item = field(currentAst.body, key), prior = field(originalAst.body, key);
    if (!item) continue;
    edits.push(prior ? { start: item.value.range[0], end: item.value.range[1], text: original.slice(...prior.value.range) }
      : { start: item.range[0], end: item.range[1], text: '' });
  }
  const tableKey = `model_providers.${provider}`;
  const table = currentAst.body.find(n => n.type === 'TOMLTable' && n.resolvedKey.join('.') === tableKey);
  const prior = originalAst.body.find(n => n.type === 'TOMLTable' && n.resolvedKey.join('.') === tableKey);
  if (ownsDefault && table && isDeepStrictEqual(current.model_providers[provider], managed.model_providers[provider])) {
    edits.push({ start: table.range[0], end: table.range[1], text: prior ? original.slice(...prior.range) : '' });
  } else if (ownsDefault && table) {
    const base = field(table.body, 'base_url');
    if (base) edits.push(prior && before.model_providers?.[provider]?.base_url
      ? { start: base.value.range[0], end: base.value.range[1], text: JSON.stringify(before.model_providers[provider].base_url) }
      : { start: base.range[0], end: base.range[1], text: '' });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  parseConfig(text);
  return text;
}

export function dpapi(action, input) {
  if (process.platform !== 'win32') throw new Error('此版本的密钥保护需要 Windows。');
  if (action !== 'encrypt') throw new Error('Invalid encryption operation');
  const script = "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; Add-Type -AssemblyName System.Security; $v = [Console]::In.ReadToEnd(); $b = [Convert]::FromBase64String($v); $r = [Security.Cryptography.ProtectedData]::Protect($b, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))";
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
    let stdout = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.resume();
    child.on('error', () => reject(new Error('无法启动 Windows 密钥保护。')));
    child.on('close', code => code ? reject(new Error('Windows 密钥保护失败。')) : resolve(stdout.trim()));
    child.stdin.on('error', () => {});
    child.stdin.end(Buffer.from(input, 'utf8').toString('base64'));
  });
}

// Encryption accepts UTF-8; decryption accepts the ciphertext bytes, without re-encoding.
export function windowsCodec() {
  return { encrypt: value => dpapi('encrypt', value), decrypt: value => decryptDpapi(value) };
}

function decryptDpapi(input) {
  const script = "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; Add-Type -AssemblyName System.Security; $b = [Convert]::FromBase64String([Console]::In.ReadToEnd()); $r = [Security.Cryptography.ProtectedData]::Unprotect($b, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))";
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
    let stdout = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.resume();
    child.on('error', () => reject(new Error('无法解密本机密钥。')));
    child.on('close', code => code ? reject(new Error('无法解密密钥；请使用保存密钥时的 Windows 账号。')) : resolve(Buffer.from(stdout.trim(), 'base64').toString('utf8')));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function atomicWrite(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, text, { mode: 0o600 }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}

const hash = value => crypto.createHash('sha256').update(value ?? '<absent>').digest('hex');
async function readOptional(file) {
  try { return await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export class Manager {
  constructor({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    dataDir = path.join(process.env.LOCALAPPDATA || os.homedir(), 'CodexApiManager'), codec = windowsCodec(),
    origin = hash(`${os.hostname()}|${os.userInfo().username}|${path.resolve(codexHome)}`) } = {}) {
    this.home = codexHome;
    this.dataDir = dataDir;
    this.codec = codec;
    this.origin = origin;
    this.storePath = path.join(dataDir, 'profiles.json');
    this.configPath = path.join(codexHome, 'config.toml');
    this.authPath = path.join(codexHome, 'auth.json');
    this.tail = Promise.resolve();
    this.connectionTests = new Map();
  }
  exclusive(fn) {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => {});
    return next;
  }
  async init() {
    const saved = await readOptional(this.storePath);
    this.store = saved ? JSON.parse(saved) : { profiles: [], lastBackup: null };
    if (!saved) await this.persist();
  }
  async persist() { await atomicWrite(this.storePath, JSON.stringify(this.store, null, 2)); }
  async current() {
    const text = await readOptional(this.configPath) || '';
    const config = parseConfig(text);
    let auth = {};
    const raw = await readOptional(this.authPath);
    if (raw) auth = JSON.parse(raw);
    const provider = config.model_providers?.[config.model_provider] || {};
    return { text, config, url: provider.base_url, key: auth.OPENAI_API_KEY || '', model: config.model, effort: config.model_reasoning_effort };
  }
  async importCurrent() {
    const current = await this.current();
    if (!current.url || !current.key) return false;
    const url = normalizeUrl(current.url);
    let existing;
    for (const p of this.store.profiles) {
      if (normalizeUrl(p.url) === url && p.encryptedKey && await this.codec.decrypt(p.encryptedKey) === current.key) {
        existing = p;
        break;
      }
    }
    const hostname = new URL(url).hostname;
    let name = hostname;
    for (let suffix = 2; this.store.profiles.some(p => normalizeUrl(p.url) === url && p.name === name); suffix++) {
      name = `${hostname} (${suffix})`;
    }
    const p = { ...(existing || { id: crypto.randomUUID(), name, url, adapter: 'auto' }),
      model: current.model || 'gpt-6-sol', effort: current.effort || 'xhigh', encryptedKey: await this.codec.encrypt(current.key) };
    const previous = this.store;
    this.store = { ...previous, profiles: existing ? previous.profiles.map(item => item === existing ? p : item) : [...previous.profiles, p] };
    try { await this.persist(); }
    catch (error) { this.store = previous; throw error; }
    this.connectionTests.delete(p.id);
    return true;
  }
  async state() {
    const current = await this.current();
    const profiles = [];
    for (const p of this.store.profiles) {
      const { encryptedKey, ...safe } = p;
      const active = current.url === p.url && current.model === p.model && current.effort === p.effort && !!encryptedKey && current.key === await this.codec.decrypt(encryptedKey);
      profiles.push({ ...safe, hasKey: !!encryptedKey, active, connectionTest: this.connectionTests.get(p.id) });
    }
    const conflicts = ['OPENAI_API_KEY', 'OPENAI_BASE_URL'].filter(k => !!process.env[k]);
    const needsLegacySync = sharedAuthProviders(current.config).some(([, p]) => p.base_url !== current.url);
    const connectionRevision = hash(JSON.stringify({ provider: current.config.model_provider, providers: current.config.model_providers,
      url: current.url, key: current.key, model: current.model, effort: current.effort }));
    return { profiles, current: { url: current.url, model: current.model, needsLegacySync, connectionRevision }, configDir: this.home, dataDir: this.dataDir,
      canRestore: !!this.store.lastBackup && (!this.store.lastBackup.origin || this.store.lastBackup.origin === this.origin), conflicts };
  }
  async readKey(id) {
    const p = this.store.profiles.find(p => p.id === id);
    if (!p) throw new Error('API 不存在。');
    return p.encryptedKey ? this.codec.decrypt(p.encryptedKey) : '';
  }
  async save(input) {
    const name = String(input.name || '').trim();
    const model = String(input.model || '').trim();
    if (!name || name.length > 80 || !model || model.length > 100) throw new Error('名称和模型不能为空，且不能过长。');
    const url = normalizeUrl(input.url);
    if (!['auto', 'newapi', 'sub2api', 'none'].includes(input.adapter)) throw new Error('查询类型无效。');
    if (!['minimal', 'low', 'medium', 'high', 'xhigh'].includes(input.effort)) throw new Error('推理档位无效。');
    const existing = this.store.profiles.find(p => p.id === input.id);
    const key = typeof input.key === 'string' ? input.key.trim() : '';
    if (key && (key.length > 8192 || /[\r\n]/.test(key))) throw new Error('API Key 格式无效。');
    if (existing?.url !== url && existing?.encryptedKey && !key) throw new Error('修改地址时请重新填写 Key，避免把原密钥发送到另一家服务商。');
    const p = { id: existing?.id || crypto.randomUUID(), name, url, model, effort: input.effort, adapter: input.adapter,
      encryptedKey: key ? await this.codec.encrypt(key) : existing?.encryptedKey || '' };
    if (existing) this.store.profiles[this.store.profiles.indexOf(existing)] = p;
    else this.store.profiles.push(p);
    await this.persist();
    this.connectionTests.delete(p.id);
  }
  async remove(id) {
    const state = await this.state();
    if (state.profiles.find(p => p.id === id)?.active) throw new Error('请先切换到其他 API，再删除当前 API。');
    this.store.profiles = this.store.profiles.filter(p => p.id !== id);
    await this.persist();
    this.connectionTests.delete(id);
  }
  async switchTo(id) {
    const p = this.store.profiles.find(p => p.id === id);
    if (!p?.encryptedKey) throw new Error('请先填写此 API 的 Key。');
    const config = await readOptional(this.configPath);
    const auth = await readOptional(this.authPath);
    const nextConfig = updateConfig(config || '', p);
    const nextAuth = JSON.stringify({ OPENAI_API_KEY: await this.codec.decrypt(p.encryptedKey) }, null, 2) + '\n';
    const backupName = `backup-${Date.now()}-${crypto.randomUUID()}.json`;
    await atomicWrite(path.join(this.dataDir, 'backups', backupName), await this.codec.encrypt(JSON.stringify({ config, auth })));
    if (await readOptional(this.configPath) !== config || await readOptional(this.authPath) !== auth) {
      throw new Error('备份期间 Codex 配置发生变化，请重试切换。');
    }
    const previousBackup = this.store.lastBackup;
    try {
      await atomicWrite(this.authPath, nextAuth);
      await atomicWrite(this.configPath, nextConfig);
      this.store.lastBackup = { file: backupName, configHash: hash(nextConfig), authHash: hash(nextAuth), origin: this.origin };
      await this.persist();
    } catch (error) {
      this.store.lastBackup = previousBackup;
      try { await this.writePair(config, auth); }
      catch { throw new Error('切换未完成，自动恢复失败。请使用数据目录中的加密备份恢复配置。'); }
      throw error;
    }
  }
  async writePair(config, auth) {
    for (const [file, content] of [[this.configPath, config], [this.authPath, auth]]) {
      if (content === null) await fs.rm(file, { force: true }); else await atomicWrite(file, content);
    }
  }
  async restore() {
    const b = this.store.lastBackup;
    if (!b) throw new Error('没有可恢复的备份。');
    if (b.origin && b.origin !== this.origin) throw new Error('这份切换备份来自另一台电脑或账号，不能覆盖本机 Codex 配置。请在本机切换后使用本机备份。');
    const config = await readOptional(this.configPath), auth = await readOptional(this.authPath);
    if (hash(config) !== b.configHash || hash(auth) !== b.authHash) throw new Error('配置已被其他程序修改，已停止恢复以保护这些改动。');
    const raw = await fs.readFile(path.join(this.dataDir, 'backups', b.file), 'utf8');
    const snapshot = JSON.parse(await this.codec.decrypt(raw));
    try { await this.writePair(snapshot.config, snapshot.auth); this.store.lastBackup = null; await this.persist(); }
    catch (error) { this.store.lastBackup = b; await this.writePair(config, auth); throw error; }
  }
  async refresh(id) {
    const p = this.store.profiles.find(p => p.id === id);
    if (!p?.encryptedKey) throw new Error('请先填写此 API 的 Key。');
    const result = await queryUsage(p, await this.codec.decrypt(p.encryptedKey));
    p.usage = result;
    await this.persist();
    return result;
  }
  async testConnection(id) {
    const p = this.store.profiles.find(p => p.id === id);
    if (!p?.encryptedKey) throw new Error('请先填写此 API 的 Key。');
    const { testConnection } = await import('./support.mjs');
    const result = await testConnection(p, await this.codec.decrypt(p.encryptedKey));
    this.connectionTests.set(id, result);
    return result;
  }
}

export function normalizeUsage(adapter, raw) {
  const d = raw.data ?? raw;
  if (raw.success === false || d.isValid === false) throw new Error('服务商拒绝了用量查询。');
  if (adapter === 'newapi') {
    if (!Number.isFinite(d.total_available) || !Number.isFinite(d.total_used)) throw new Error('服务商返回了无法识别的用量格式。');
    return { remaining: d.unlimited_quota ? null : d.total_available, used: d.total_used, unit: '额度',
      unlimited: !!d.unlimited_quota, scope: '此 Key 额度', expiresAt: d.expires_at > 0 ? d.expires_at * 1000 : null };
  }
  if (!Number.isFinite(d.remaining) && !d.usage && !d.subscription && !d.rate_limits) throw new Error('服务商返回了无法识别的用量格式。');
  return { remaining: Number.isFinite(d.remaining) ? d.remaining : null, used: d.quota?.used ?? d.usage?.total?.actual_cost ?? null,
    today: d.usage?.today?.actual_cost ?? null, tokens: d.usage?.today?.total_tokens ?? null, unit: d.unit || 'USD',
    scope: d.quota ? '此 Key 额度' : d.subscription ? '套餐剩余额度' : d.balance !== undefined ? '账户余额' : '服务商用量',
    windows: (d.rate_limits || []).map(w => ({ name: w.window, used: w.used, limit: w.limit })),
    subscription: d.subscription ? ['daily', 'weekly', 'monthly'].filter(w => d.subscription[`${w}_limit_usd`] != null).map(w => ({ name: w, used: d.subscription[`${w}_usage_usd`], limit: d.subscription[`${w}_limit_usd`] })) : [] };
}

export async function queryUsage(profile, key, fetcher = fetch) {
  const checkedAt = new Date().toISOString();
  if (profile.adapter === 'none') return { status: 'unsupported', message: '未配置用量查询', checkedAt };
  const adapters = profile.adapter === 'auto' ? ['sub2api', 'newapi'] : [profile.adapter];
  let lastError;
  for (const adapter of adapters) {
    const root = profile.url.replace(/\/v1\/?$/, '');
    const endpoint = adapter === 'newapi' ? root + '/api/usage/token' : profile.url + '/usage';
    try {
      const options = { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000), redirect: 'manual' };
      let response = await fetcher(endpoint, options);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers?.get('location');
        const target = location && new URL(location, endpoint);
        // Only the exact same-origin trailing-slash variant may receive this key.
        if (!target || target.href !== endpoint + '/') throw new Error('服务商用量接口发生不兼容的跳转');
        await response.body?.cancel();
        response = await fetcher(target.href, { ...options, redirect: 'error' });
      }
      if (response.status === 404 || response.status === 405) { lastError = '该站点不支持此用量接口'; continue; }
      if (response.status === 401 || response.status === 403) throw new Error('Key 无效，或没有用量查询权限');
      if (!response.ok) throw new Error(`查询失败（HTTP ${response.status}）`);
      const body = await response.text();
      if (body.length > 1_000_000) throw new Error('用量响应过大');
      let raw;
      try { raw = JSON.parse(body); } catch { lastError = '该站点未返回用量数据'; continue; }
      return { ...normalizeUsage(adapter, raw), status: 'ok', checkedAt };
    } catch (e) {
      const networkMessage = e.name === 'TimeoutError' ? '连接超时' : e.cause?.message === 'unexpected redirect' ? '服务商用量接口发生不兼容的跳转'
        : e.message === 'fetch failed' ? '连接失败，请检查地址、网络和 HTTPS 证书' : e.message;
      // Never persist remote response bodies or transport errors containing credentials.
      lastError = networkMessage.includes(key) ? '用量查询失败' : networkMessage;
      break;
    }
  }
  return { status: 'error', message: lastError || '暂时无法查询', checkedAt };
}
