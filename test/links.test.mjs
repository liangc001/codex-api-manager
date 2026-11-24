import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { LinkStore, DEFAULT_LINKS, linkUrl } from '../links.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-links-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return new LinkStore(directory);
}
test('curated links need no startup writes, stay local, and edited links survive reopening', async t => {
  const store = await fixture(t);
  const initial = await store.list();
  assert.equal(initial.length, 55);
  assert.equal(initial.filter(link => link.pinned).length, 6);
  await assert.rejects(fs.stat(store.file), { code: 'ENOENT' });
  assert.equal(initial.find(link => link.id === 'linuxdo').url, 'https://linux.do/');
  initial[0].name = 'Mutated copy';
  assert.equal((await store.list())[0].name, 'ChatGPT');
  const saved = await store.save({ name: 'My tool', url: 'https://example.com/tool#editor', group: 'tools' });
  const added = saved.find(link => link.name === 'My tool');
  assert.ok(added.id);
  assert.equal(await new LinkStore(path.dirname(store.file)).resolve(added.id), 'https://example.com/tool#editor');
  await store.save({ ...added, name: 'Renamed', url: 'https://example.com/updated' });
  assert.equal((await store.list()).filter(link => link.id === added.id).length, 1);
  const removed = await store.remove('chatgpt');
  assert.ok(!removed.some(link => link.id === 'chatgpt'));
  await assert.rejects(store.resolve('chatgpt'));
  await store.save(DEFAULT_LINKS[0]);
  assert.equal(await store.resolve('chatgpt'), 'https://chatgpt.com/');
});
test('only explicit HTTPS pages can open; unsafe inputs and corrupt files are never persisted', async t => {
  const store = await fixture(t);
  for (const url of ['javascript:alert(1)', 'file:///C:/Windows/notepad.exe', 'https://user:pass@example.com/',
    'https://example.com\\@evil.example/', 'http://example.com/', ' https://example.com/', 'https://example.com/\n'])
    assert.throws(() => linkUrl(url));
  for (const input of [{ name: 'X', group: 'tools', url: 'ms-settings:privacy' },
    { name: 'X', group: '__proto__', url: 'https://example.com/' },
    { name: 'X', id: '../../data', group: 'tools', url: 'https://example.com/' }]) await assert.rejects(store.save(input));
  await assert.rejects(fs.stat(store.file), { code: 'ENOENT' });
  const corrupt = '{"version":1,"links":[{"url":"javascript:alert(1)"}]}';
  await fs.writeFile(store.file, corrupt);
  await assert.rejects(store.list(), /原文件已保留/);
  await assert.rejects(store.save({ name: 'Valid', group: 'tools', url: 'https://example.com/' }));
  assert.equal(await fs.readFile(store.file, 'utf8'), corrupt);
});
test('overlapping edits keep every link, and an intentionally empty list does not reset itself', async t => {
  const store = await fixture(t);
  await Promise.all(Array.from({ length: 8 }, (_, i) => store.save({ name: 'Tool ' + i, group: 'tools', url: 'https://example.com/' + i })));
  const saved = await store.list(); assert.equal(saved.length, DEFAULT_LINKS.length + 8);
  await Promise.all(saved.map(link => store.remove(link.id)));
  assert.deepEqual(await new LinkStore(path.dirname(store.file)).list(), []);
});
test('home shortcuts are editable, bounded, and survive removal, undo and a restart', async t => {
  const store = await fixture(t);
  await store.setPinned('chatgpt', false);
  await store.setPinned('scholar', true);
  assert.equal((await new LinkStore(path.dirname(store.file)).list()).find(link => link.id === 'scholar').pinned, true);
  await Promise.all(['perplexity', 'kimi'].map(id => store.setPinned(id, true)));
  const before = await fs.readFile(store.file, 'utf8');
  await assert.rejects(store.setPinned('grok', true), /最多固定/);
  assert.equal(await fs.readFile(store.file, 'utf8'), before);
  const original = (await store.list()).find(link => link.id === 'scholar');
  await store.remove('scholar'); await store.save(original);
  assert.equal((await store.list()).filter(link => link.pinned).length, 8);
});
