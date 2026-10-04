import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

test('restart resolves the destination computer installation and rejects ordinary ChatGPT', { skip: process.platform !== 'win32' }, async t => {
  createRequire(import.meta.url)('../desktop/restart-codex.cjs');
  const source = await fs.readFile(new URL('../desktop/restart-codex.cjs', import.meta.url), 'utf8');
  const script = source.match(/const script = String.raw`([\s\S]*?)`;/)[1];
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-restart-detection-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const mocks = String.raw`
function Get-AppxPackage {
  if ($env:TEST_PACKAGE) { [PSCustomObject]@{ InstallLocation = $env:TEST_PACKAGE; PackageFamilyName = 'Destination.Codex'; Version = '9.0' } }
}
function Get-CimInstance {
  if ($env:TEST_RUNNING) {
    [PSCustomObject]@{ Name = 'ChatGPT.exe'; ExecutablePath = $env:TEST_RUNNING; ProcessId = 123; ParentProcessId = 0; CreationDate = [DateTime]::Parse('2026-01-01T00:00:00Z').ToUniversalTime() }
    [PSCustomObject]@{ Name = 'ChatGPT.exe'; ExecutablePath = $env:TEST_RUNNING; ProcessId = 124; ParentProcessId = 123; CreationDate = [DateTime]::Parse('2026-01-01T00:01:00Z').ToUniversalTime() }
  }
}
function Get-ItemProperty {
  if ($env:TEST_REGISTRY) { [PSCustomObject]@{ DisplayName = 'Codex'; InstallLocation = $env:TEST_REGISTRY } }
}
function Get-Item { [PSCustomObject]@{ VersionInfo = [PSCustomObject]@{ ProductName = $env:TEST_PRODUCT } } }
`;
  async function probe(name, settings, expected, running = false) {
    const local = path.join(temp, name);
    await fs.mkdir(local, { recursive: true });
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(mocks + script, 'utf16le').toString('base64')], {
      windowsHide: true, input: JSON.stringify({ action: 'probe' }), encoding: 'utf8', timeout: 15000,
      env: { ...process.env, LOCALAPPDATA: local, ProgramFiles: local, 'ProgramFiles(x86)': local,
        TEST_PACKAGE: '', TEST_RUNNING: '', TEST_REGISTRY: '', TEST_PRODUCT: 'Codex', ...settings },
    });
    assert.ifError(result.error);
    const output = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
    if (!expected) { assert.equal(result.status, 1); assert.match(output.error, /Codex/); }
    else {
      assert.equal(result.status, 0, output.error); assert.equal(output.executable, expected); assert.equal(output.running, running);
      assert.equal(output.startedAt, running ? Date.parse('2026-01-01T00:00:00Z') : null);
    }
  }
  const packageDir = path.join(temp, 'destination-package');
  await fs.mkdir(path.join(packageDir, 'app'), { recursive: true });
  const packagedExe = path.join(packageDir, 'app', 'ChatGPT.exe');
  await fs.writeFile(packagedExe, '');
  await fs.writeFile(path.join(packageDir, 'AppxManifest.xml'), '<Package><Applications><Application Id="App" Executable="app\\ChatGPT.exe" /></Applications></Package>');
  await probe('package', { TEST_PACKAGE: packageDir, TEST_RUNNING: packagedExe }, packagedExe, true);
  const commonExe = path.join(temp, 'common', 'Programs', 'Codex', 'Codex.exe');
  await fs.mkdir(path.dirname(commonExe), { recursive: true }); await fs.writeFile(commonExe, '');
  await probe('common', {}, commonExe);
  const registryDir = path.join(temp, 'custom-location'); await fs.mkdir(registryDir);
  const customExe = path.join(registryDir, 'ChatGPT.exe'); await fs.writeFile(customExe, '');
  await probe('registry', { TEST_REGISTRY: registryDir }, customExe);
  await probe('running', { TEST_RUNNING: customExe }, customExe, true);
  await probe('chatgpt', { TEST_RUNNING: customExe, TEST_PRODUCT: 'ChatGPT' }, null);
});
