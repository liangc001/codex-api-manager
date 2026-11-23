import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import access from '../desktop/access-check.cjs';

const password = 'fixture-access-password';
const salt = crypto.randomBytes(16);
const record = { salt: salt.toString('hex'), hash: crypto.scryptSync(password, salt, 32).toString('hex') };

test('startup check accepts the exact password and delays failed attempts', async () => {
  let time = 1000;
  const check = access.createPasswordCheck(record, () => time);
  const failed = await check('wrong');
  assert.equal(failed.ok, false);
  assert.equal(failed.retryAfterMs, 500);
  assert.equal((await check(password)).ok, false);
  time += 500;
  assert.deepEqual(await check(password), { ok: true });
  assert.equal((await check(password + ' ')).ok, false);
});

test('startup check rejects malformed input and overlapping guesses without exposing the password', async () => {
  const check = access.createPasswordCheck(record);
  for (const input of ['', null, {}, 'x'.repeat(513)])
    assert.equal((await check(input)).ok, false);
  const first = check(password);
  assert.equal((await check(password)).ok, false);
  assert.equal((await first).ok, true);
  assert.throws(() => access.createPasswordCheck({ salt: '', hash: '' }));
});
