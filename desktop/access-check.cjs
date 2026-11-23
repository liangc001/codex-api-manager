const { scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const derive = promisify(scrypt);

function createPasswordCheck(record, now = Date.now) {
  if (!/^[a-f0-9]{32}$/.test(record?.salt) || !/^[a-f0-9]{64}$/.test(record?.hash))
    throw new Error('启动密码校验配置不完整，请重新下载软件。');
  const salt = Buffer.from(record.salt, 'hex'), expected = Buffer.from(record.hash, 'hex');
  let pending = false, failures = 0, nextAttempt = 0;
  return async password => {
    const remaining = nextAttempt - now();
    if (pending || remaining > 0)
      return { ok: false, error: '请稍候再试。', retryAfterMs: Math.max(remaining, 500) };
    if (typeof password !== 'string' || !password.length || password.length > 512)
      return { ok: false, error: '请输入启动密码。', retryAfterMs: 0 };
    pending = true;
    let actual;
    try {
      actual = await derive(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      if (timingSafeEqual(expected, actual)) {
        failures = 0; nextAttempt = 0;
        return { ok: true };
      }
      const retryAfterMs = Math.min(30000, 500 * 2 ** Math.min(failures++, 6));
      nextAttempt = now() + retryAfterMs;
      return { ok: false, error: '密码不正确，请重新输入。', retryAfterMs };
    } finally { actual?.fill(0); pending = false; }
  };
}

module.exports = { createPasswordCheck };
