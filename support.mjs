import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from './core.mjs';

const advice = {
  ok: ['连接成功', '模型已完成测试请求。'],
  auth: ['Key 认证失败', '检查 Key 是否完整、有效，以及所属服务商是否正确。'],
  permission: ['没有调用权限', '检查服务商分组、模型权限和账户状态。'],
  model: ['模型不可用', '核对模型名称；请服务商检查分组和上游模型权限。'],
  limited: ['上游限流', '稍后重试，或在服务商后台更换可用分组。'],
  quota: ['额度不足', '检查服务商后台的余额、套餐和 Key 限额。'],
  endpoint: ['接口地址不正确', '检查 API 地址是否包含 /v1，是否支持 Responses 接口。'],
  redirect: ['接口发生跳转', '填写最终 API 地址；测试不会携带 Key 跟随跳转。'],
  timeout: ['连接超时', '稍后重试，检查网络和服务商是否正常。'],
  certificate: ['HTTPS 证书校验失败', '核对地址或联系服务商修复证书。'],
  network: ['无法连接', '检查地址、网络、代理和服务商状态。'],
  upstream: ['上游服务异常', '稍后重试，或联系服务商排查。'],
  format: ['响应不完整或不兼容', '请服务商检查 Responses 接口和流式响应格式。'],
  rejected: ['请求被拒绝', '核对模型和服务商配置，或导出诊断信息排查。'],
};

export function classifyFailure(status, message = '', code = '') {
  const text = `${code} ${message}`.toLowerCase();
  if (status === 401 || /invalid_api_key|invalid api key/.test(text)) return 'auth';
  if (/insufficient_quota|余额不足|额度不足|quota_exceeded|credit.*(?:insufficient|exhausted)/.test(text)) return 'quota';
  if (status === 429 || /rate.limit|rate_limit|too many requests/.test(text)) return 'limited';
  if (/model_not_found|unsupported_model|model.*(?:not supported|not found|does not exist)|模型.*(?:不支持|不存在)/.test(text)) return 'model';
  if (status === 403) return 'permission';
  if (status === 402) return 'quota';
  if (status >= 300 && status < 400) return 'redirect';
  if (status === 404 || status === 405) return 'endpoint';
  if (status >= 500) return 'upstream';
  return 'rejected';
}

const safeStatus = n => Number.isInteger(n) && n >= 100 && n <= 599 ? n : undefined;
const safeDate = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) ? v : undefined;
const safeDuration = n => Number.isFinite(n) && n >= 0 && n <= 86400000 ? Math.round(n) : undefined;

export function safeTestResult(result) {
  if (!result || !Object.hasOwn(advice, result.kind)) return undefined;
  const [message, hint] = advice[result.kind];
  return { kind: result.kind, status: result.kind === 'ok' ? 'ok' : 'error', message, hint,
    httpStatus: safeStatus(result.httpStatus), durationMs: safeDuration(result.durationMs), checkedAt: safeDate(result.checkedAt) };
}

async function readBounded(response, onLine) {
  if (!response.body) return '';
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let size = 0, text = '', pending = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) { pending += decoder.decode(); if (pending && onLine) onLine(pending); break; }
      size += value.byteLength;
      if (size > 1024 * 1024) throw new Error('response-size');
      const chunk = decoder.decode(value, { stream: true });
      if (!onLine) { text += chunk; continue; }
      pending += chunk;
      let index;
      while ((index = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, index).replace(/\r$/, ''); pending = pending.slice(index + 1);
        if (onLine(line)) return '';
      }
    }
    return text + (onLine ? '' : decoder.decode());
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function testConnection(profile, key, fetcher = fetch) {
  const start = Date.now(); let status;
  const result = kind => safeTestResult({ kind, httpStatus: status, durationMs: Date.now() - start, checkedAt: new Date().toISOString() });
  try {
    const response = await fetcher(profile.url + '/responses', { method: 'POST', redirect: 'manual',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: profile.model, instructions: 'Reply briefly in Chinese.',
        input: [{ role: 'user', content: [{ type: 'input_text', text: '你好' }] }], store: false, stream: true }),
      signal: AbortSignal.timeout(45000) });
    status = response.status;
    if (status >= 300 && status < 400) { await response.body?.cancel(); return result('redirect'); }
    if (!response.ok) {
      const body = await readBounded(response); let raw;
      try { raw = JSON.parse(body); } catch {}
      return result(classifyFailure(status, raw?.error?.message || raw?.message, raw?.error?.code || raw?.code));
    }
    let kind = 'format';
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      await readBounded(response, line => {
        if (!line.startsWith('data:')) return false;
        let event; try { event = JSON.parse(line.slice(5).trim()); } catch { return false; }
        if (event.type === 'response.completed' && event.response?.status === 'completed') { kind = 'ok'; return true; }
        if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) {
          const error = event.response?.error || event.error || event;
          kind = event.type === 'response.incomplete' ? 'format' : classifyFailure(status, error.message, error.code);
          return true;
        }
        return false;
      });
    } else {
      let raw; try { raw = JSON.parse(await readBounded(response)); } catch {}
      if (raw?.status === 'completed' && Array.isArray(raw.output) && raw.output.length) kind = 'ok';
      else if (raw?.error) kind = classifyFailure(status, raw.error.message, raw.error.code);
    }
    return result(kind);
  } catch (error) {
    const code = error.cause?.code || error.code || '';
    return result(error.name === 'TimeoutError' || error.name === 'AbortError' ? 'timeout'
      : /CERT|SSL|TLS|SELF_SIGNED/.test(code) ? 'certificate'
      : error.message === 'response-size' ? 'format' : 'network');
  }
}

const operations = new Set(['save', 'delete', 'switch', 'restore', 'monitor', 'import', 'export', 'refresh', 'restart-codex', 'test-connection', 'export-diagnostics']);
const outcomes = new Set(['ok', 'error', 'unsupported', 'completed', 'cancelled', 'network']);
export function safeLogRow(row) {
  if (!['startup', 'shutdown', 'operation', 'request', 'settings', 'logs-cleared'].includes(row?.event) || !safeDate(row.time)) return null;
  const safe = { time: row.time, event: row.event };
  if (operations.has(row.operation)) safe.operation = row.operation;
  if (outcomes.has(row.outcome)) safe.outcome = row.outcome;
  if (safeStatus(row.status)) safe.status = row.status;
  for (const key of ['durationMs', 'firstByteMs']) if (safeDuration(row[key]) !== undefined) safe[key] = safeDuration(row[key]);
  if (Object.hasOwn(advice, row.errorKind) && row.errorKind !== 'ok') safe.errorKind = row.errorKind;
  return safe;
}

export async function diagnosticReport(manager, storage, monitor, version) {
  await storage.tail;
  const state = await manager.state();
  const rows = [];
  const files = (await fs.readdir(storage.logDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; }))
    .filter(f => /^events-\d{4}-\d{2}-\d{2}-[a-f0-9-]+\.jsonl$/.test(f));
  const ranked = await Promise.all(files.map(async f => ({ f, stat: await fs.lstat(path.join(storage.logDir, f)) })));
  let budget = 12 * 1024 * 1024;
  for (const { f, stat } of ranked.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)) {
    if (!stat.isFile() || stat.size > budget) continue;
    budget -= stat.size;
    for (const line of (await fs.readFile(path.join(storage.logDir, f), 'utf8')).split('\n')) {
      try { const safe = safeLogRow(JSON.parse(line)); if (safe) rows.push(safe); } catch {}
    }
    if (rows.length >= 200) break;
  }
  return { format: 'codex-api-manager-diagnostics', version: 1, appVersion: version,
    generatedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
    connection: { configured: !!state.current.url, matchedSavedProfile: state.profiles.some(p => p.active),
      needsLegacySync: state.current.needsLegacySync, environmentOverrides: state.conflicts.length > 0 },
    monitoring: { enabled: !!monitor.enabled, pendingRecovery: !!monitor.recoveryWarning },
    logging: { enabled: storage.settings.logging, retentionDays: storage.settings.retentionDays },
    profiles: state.profiles.map((p, index) => ({ index: index + 1, hasKey: p.hasKey, active: p.active,
      usageStatus: ['ok', 'error', 'unsupported'].includes(p.usage?.status) ? p.usage.status : 'not_checked',
      test: safeTestResult(manager.connectionTests?.get(p.id)) })),
    events: rows.sort((a, b) => a.time.localeCompare(b.time)).slice(-200) };
}

export async function exportDiagnostics(file, manager, storage, monitor, version) {
  if (path.extname(file).toLowerCase() !== '.json') throw new Error('请保存为 .json 文件。');
  const target = path.join(await fs.realpath(path.dirname(file)), path.basename(file));
  for (const folder of [manager.dataDir, manager.home]) {
    const actual = await fs.realpath(folder).catch(e => { if (e.code === 'ENOENT') return path.resolve(folder); throw e; });
    const relative = path.relative(actual, target);
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('请导出到 data 和 Codex 配置目录之外。');
    }
  }
  await atomicWrite(target, JSON.stringify(await diagnosticReport(manager, storage, monitor, version), null, 2) + '\n');
}
