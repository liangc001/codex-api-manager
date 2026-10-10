import { normalizeUrl } from './core.mjs';

class ModelQueryError extends Error {}

export async function queryModels(url, key, fetcher = fetch) {
  const base = normalizeUrl(url);
  if (typeof key !== 'string' || !key.trim() || key.length > 8192 || /[\r\n]/.test(key)) throw new ModelQueryError('请填写有效的 API Key。');
  key = key.trim();
  let response;
  try {
    response = await fetcher(base + '/models', { method: 'GET', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (response.status === 401) throw new ModelQueryError('Key 无效，无法查询模型。');
    if (response.status === 403) throw new ModelQueryError('此 Key 没有模型列表查询权限，可手动填写模型。');
    if (response.status === 404 || response.status === 405) throw new ModelQueryError('服务商不支持模型列表查询，请手动填写。');
    if (response.status >= 300 && response.status < 400) throw new ModelQueryError('模型接口发生跳转，请检查地址；未向跳转地址发送 Key。');
    if (!response.ok) throw new ModelQueryError('模型查询失败，请稍后重试或手动填写。');
    if (!response.body) throw new ModelQueryError('模型列表格式不兼容，请手动填写。');
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 1024 * 1024) throw new ModelQueryError('模型列表过大，请手动填写。');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    let raw;
    try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ModelQueryError('模型列表格式不兼容，请手动填写。'); }
    if (!Array.isArray(raw.data)) throw new ModelQueryError('模型列表格式不兼容，请手动填写。');
    const models = [...new Set(raw.data.map(item => item?.id).filter(id => typeof id === 'string'
      && id.length <= 100 && /^[a-zA-Z0-9][a-zA-Z0-9._:/+\-]*$/.test(id) && !id.includes(key)))].sort().slice(0, 2000);
    if (!models.length) throw new ModelQueryError('此 Key 未返回可用模型，请手动填写。');
    return models;
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new ModelQueryError('查询超时，请稍后重试。');
    // Never display provider response bodies or transport errors that could contain credentials.
    if (error instanceof ModelQueryError) throw error;
    throw new ModelQueryError('无法查询模型，请检查地址、网络和 HTTPS 证书。');
  } finally { await response?.body?.cancel().catch(() => {}); }
}
