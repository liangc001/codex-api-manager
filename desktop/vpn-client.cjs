const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

function exchange(pipe, op, input, timeout) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    const chunks = [];
    let size = 0;
    socket.on('error', reject);
    socket.on('end', () => reject(new Error('VPN 服务已关闭连接。')));
    socket.setTimeout(timeout, () => socket.destroy(new Error('VPN 服务响应超时。')));
    socket.once('connect', () => socket.write(JSON.stringify({ ...input, v: 1, op }) + '\n'));
    socket.on('data', chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) { socket.destroy(new Error('VPN 返回数据过大。')); return; }
      chunks.push(chunk);
      const end = chunk.indexOf(10);
      if (end === -1) return;
      socket.destroy();
      try {
        const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!raw.ok) reject(new Error(raw.error || 'VPN 操作失败。'));
        else if (raw.result?.version !== 1) reject(new Error('VPN 控制协议版本不兼容。'));
        else resolve(raw.result);
      } catch { reject(new Error('无法读取 VPN 服务响应。')); }
    });
  });
}

class VpnClient {
  constructor({ executable, home, launch = spawn, fixtureArgs }) {
    Object.assign(this, { executable, home, launch, fixtureArgs });
    this.tail = Promise.resolve();
    this.expectedProxy = false;
  }
  call(op, input = {}) {
    const next = this.tail.then(() => this.dispatch(op, input));
    this.tail = next.catch(() => {});
    return next;
  }
  async dispatch(op, input) {
    if (op === 'shutdown' && !this.child) { this.expectedProxy = false; this.disconnectRequested = false; return null; }
    const first = !this.child;
    if (first) {
      const name = 'api-switchboard-vpn-' + randomUUID().replaceAll('-', '');
      this.pipe = '\\\\.\\pipe\\' + name;
      const args = this.fixtureArgs ? ['--fixture', name, String(process.pid), ...this.fixtureArgs] : ['--serve', name, String(process.pid), this.home];
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENAI_|ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|CODEX_API_|GH_TOKEN$|GITHUB_TOKEN$)/i.test(key)));
      const child = this.launch(this.executable, args, { env, cwd: path.dirname(this.executable), stdio: 'ignore', windowsHide: true });
      this.child = child; this.failure = '';
      this.finished = new Promise(resolve => {
        const finish = failure => {
          if (this.child === child) this.child = null;
          this.failure = failure;
          resolve();
        };
        child.once('error', () => finish('无法启动 VPN broker，请先构建或解压完整版本。'));
        child.once('exit', code => finish(code === 12 ? '旧 VPN 或另一份集成服务正在运行。请先从托盘退出它。'
          : code === 0 ? '' : 'VPN 服务退出。请检查本机运行目录和配置。'));
      });
    }
    let status;
    try {
      const deadline = Date.now() + 6500;
      while (true) {
        if (!this.child) throw new Error(this.failure || 'VPN 服务已退出。');
        try { status = await exchange(this.pipe, op, input, op === 'shutdown' ? 60000 : 14000); break; }
        catch (e) {
          if (!['ENOENT', 'EPIPE', 'EBUSY', 'ECONNREFUSED'].includes(e.code) || Date.now() >= deadline) throw e;
          await delay(80);
        }
      }
    } catch (e) {
      if (op === 'shutdown' && !this.child && !this.failure) { this.expectedProxy = false; return null; }
      if (this.failure) throw new Error(this.failure);
      if (e.code) throw new Error('无法连接 VPN 服务，请关闭旧 VPN 后重试。');
      throw e;
    }
    this.last = status;
    if (op === 'connect' || status.proxyPort) this.expectedProxy = true;
    if (op === 'disconnect') this.disconnectRequested = true;
    if (this.disconnectRequested && status.phase === 'disconnected' && !status.busy) {
      this.expectedProxy = false; this.disconnectRequested = false;
    }
    if (op === 'shutdown') {
      await this.finished;
      if (this.failure) throw new Error(this.failure);
      this.last = null; this.expectedProxy = false; this.disconnectRequested = false;
    }
    return status;
  }
  async proxyUrl() {
    const status = this.child ? await this.call('status') : null;
    if (status?.proxyPort && !['disconnected', 'disconnecting', 'error'].includes(status.phase))
      return 'http://127.0.0.1:' + status.proxyPort;
    if (this.expectedProxy) throw new Error('VPN 线路不可用，未回退为直连。请重新连接或断开 VPN。');
    return null;
  }
  async close() { await this.call('shutdown'); }
}

function createVpnNetwork(vpn, sessions) {
  const partitions = new Map();
  return (scope, fallback = fetch) => async (url, options) => {
    if (options?.signal?.aborted) throw options.signal.reason;
    // Keep local monitor and local upstream traffic available during transitions.
    if (/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(String(url))) return fallback(url, options);
    const proxy = await vpn.proxyUrl();
    // Only the application network partitions use the explicit proxy; the renderer stays local.
    if (!proxy) return fallback(url, options);
    const key = scope + ':' + proxy;
    if (!partitions.has(key)) {
      const transport = sessions.fromPartition('vpn-' + scope + '-' + new URL(proxy).port);
      partitions.set(key, transport.setProxy({ mode: 'fixed_servers', proxyRules: proxy, proxyBypassRules: 'localhost;127.0.0.1;[::1]' })
        .then(() => transport).catch(error => { partitions.delete(key); throw error; }));
    }
    const transport = await partitions.get(key);
    return transport.fetch(url, { ...options, credentials: 'omit', bypassCustomProtocolHandlers: true });
  };
}

function childProxyEnvironment(proxy) {
  return proxy ? { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, NO_PROXY: 'localhost,127.0.0.1,::1' } : {};
}

module.exports = { VpnClient, createVpnNetwork, childProxyEnvironment };
