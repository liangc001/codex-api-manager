import { test } from 'node:test';
import assert from 'node:assert/strict';
import client from '../desktop/vpn-client.cjs';

test('VPN network partitions keep local/normal requests direct and isolate explicit proxy sessions', async () => {
  const events = [];
  let active = null;
  const transport = client.createVpnNetwork({ async proxyUrl() {
    if (active instanceof Error) throw active;
    return active;
  } }, { fromPartition: scope => ({
    async setProxy(config) { events.push([scope, config.mode, config.proxyRules]); },
    async fetch(_, options) { assert.equal(options.credentials, 'omit'); return scope; }
  }) });
  const request = transport('qa', async () => 'direct');
  assert.equal(await request('https://api.invalid/v1'), 'direct');
  active = 'http://127.0.0.1:44000';
  assert.equal(await request('https://api.invalid/v1'), 'vpn-qa-44000');
  assert.equal(await request('https://api.invalid/v1'), 'vpn-qa-44000');
  assert.deepEqual(events, [['vpn-qa-44000', 'fixed_servers', active]]);
  assert.equal(await request('http://127.0.0.1:15555/v1'), 'direct');
  assert.deepEqual(client.childProxyEnvironment(active), { HTTP_PROXY: active, HTTPS_PROXY: active, ALL_PROXY: active, NO_PROXY: 'localhost,127.0.0.1,::1' });
  active = new Error('proxy down');
  await assert.rejects(request('https://api.invalid/v1'), /proxy down/);
  assert.equal(await request('http://localhost:15555/v1'), 'direct');
});
