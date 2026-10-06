import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createMonitorRequester } = createRequire(import.meta.url)('../desktop/monitor-transport.cjs');

test('native monitor timeout before headers aborts transport and reports a terminal failure', async () => {
  let signal;
  const requester = createMonitorRequester({ fetch: async (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('private error must not escape')), { once: true }));
  } });
  const request = requester(new URL('https://fake.example/v1/responses'), { method: 'POST', headers: {} }, () => assert.fail('unexpected response'));
  const failure = new Promise(resolve => request.once('error', resolve));
  request.setTimeout(20, () => request.destroy()); request.end(Buffer.from('{}'));
  const error = await failure;
  assert.equal(signal.aborted, true); assert.equal(error.message, 'Monitor request aborted');
});
