import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Manager } from './core.mjs';
import { MonitorController } from './monitor.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const manager = new Manager();
await manager.init();
const controller = new MonitorController(manager);
await controller.init();
const token = crypto.randomBytes(32).toString('hex');
let origin;
const files = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['public/style.css', 'text/css; charset=utf-8']],
  ['/lucide.js', ['node_modules/lucide/dist/umd/lucide.js', 'text/javascript; charset=utf-8']],
]);
const server = http.createServer(async (req, res) => {
  const send = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'");
  if (`http://${req.headers.host}` !== origin || (req.headers.origin && req.headers.origin !== origin)) return send(403, { error: '不允许外部来源访问。' });
  try {
    const route = new URL(req.url, origin).pathname;
    if (route.startsWith('/api/')) {
      if (req.headers['x-manager-token'] !== token) return send(403, { error: '请刷新页面后重试。' });
      if (req.method === 'GET' && route === '/api/metrics') return send(200, controller.monitor.summary());
      if (req.method === 'GET' && route === '/api/state') return send(200, await manager.exclusive(() => controller.state()));
      if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) return send(405, { error: '请求格式不正确。' });
      let body = '';
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 32000) return send(413, { error: '请求过大。' }); }
      const input = JSON.parse(body || '{}');
      const actions = {
        '/api/read-key': async () => ({ key: await manager.readKey(input.id) }),
        '/api/save': () => controller.save(input), '/api/delete': () => controller.remove(input.id),
        '/api/switch': () => controller.switchTo(input.id), '/api/restore': () => controller.restore(),
        '/api/monitor': () => controller.setMonitoring(input.enabled === true),
        '/api/import': async () => { if (!await controller.importCurrent()) throw new Error('当前 Codex 没有可导入的 API 地址和 Key。'); },
        '/api/refresh': () => manager.refresh(input.id),
        '/api/list-models': () => manager.listModels(input),
        '/api/undo-delete': () => manager.undoRemove(input.token),
        '/api/favorite': () => manager.setFavorite(input.id, input.favorite),
      };
      if (!actions[route]) return send(404, { error: '不存在的操作。' });
      const result = await manager.exclusive(actions[route]);
      return send(200, { ok: true, result });
    }
    if (req.method !== 'GET' || !files.has(route)) return send(404, { error: '页面不存在。' });
    const [file, contentType] = files.get(route);
    let data = await fs.readFile(path.join(root, file));
    if (route === '/') data = Buffer.from(data.toString().replace('__MANAGER_TOKEN__', token));
    res.writeHead(200, { 'Content-Type': contentType }); res.end(data);
  } catch (e) {
    const expected = e.code ? '读取或保存本地文件失败，请检查文件权限。' : e.message;
    send(400, { error: expected });
  }
});
const requestedPort = Number(process.env.PORT || 47831);
async function listen(port) {
  await new Promise((resolve, reject) => {
    const fail = e => { server.removeListener('listening', ready); reject(e); };
    const ready = () => { server.removeListener('error', fail); resolve(); };
    server.once('error', fail); server.once('listening', ready); server.listen(port, '127.0.0.1');
  });
}
try { await listen(requestedPort); }
catch (e) { if (e.code === 'EADDRINUSE') await listen(0); else throw e; }
origin = `http://127.0.0.1:${server.address().port}`;
await fs.writeFile(path.join(manager.dataDir, 'server.json'), JSON.stringify({ pid: process.pid, url: origin, startedAt: new Date().toISOString() }));
console.log(`Codex API Manager: ${origin}`);
process.on('SIGINT', () => manager.exclusive(() => controller.monitor.shutdown()).then(() => server.close(() => process.exit(0))).catch(() => process.exit(1)));
