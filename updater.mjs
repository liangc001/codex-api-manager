import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const API = 'https://api.github.com/repos/liangc001/codex-api-manager/releases/latest';
const PREFIX = 'https://github.com/liangc001/codex-api-manager/releases/download/';
const MAX = 300 * 1024 * 1024;
export function newerVersion(candidate, current) {
  const parse = value => /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value) ? value.split('.').map(Number) : null;
  const a = parse(candidate), b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
export function releaseAsset(raw, current) {
  if (!raw || raw.draft || raw.prerelease || typeof raw.tag_name !== 'string') throw new Error('发布信息无效。');
  const version = raw.tag_name.replace(/^v/, '');
  if (!/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version)) throw new Error('发布版本格式无效。');
  if (!newerVersion(version, current)) return null;
  const name = `Codex-API-Manager-${version}-Windows-x64.exe`;
  const asset = raw.assets?.find(a => a.name === name && a.state === 'uploaded');
  if (!asset || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX
    || asset.browser_download_url !== `${PREFIX}${raw.tag_name}/${name}` || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')) {
    throw new Error('新版缺少有效的安装文件或 SHA256 校验信息。');
  }
  return { version, url: asset.browser_download_url, size: asset.size, digest: asset.digest.slice(7) };
}
async function readJSON(response) {
  if (!response.ok) throw new Error('暂时无法检查更新，请稍后重试。');
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 1024 * 1024) throw new Error('发布信息过大。'); chunks.push(value); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export const installScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$jobPath = $env:CODEX_MANAGER_UPDATE_JOB
$job = Get-Content -LiteralPath $jobPath -Raw -Encoding UTF8 | ConvertFrom-Json
$target = [IO.Path]::GetFullPath($job.target)
$staged = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetDirectoryName($jobPath)) 'app.exe'))
$backup = Join-Path ([IO.Path]::GetDirectoryName($jobPath)) 'previous.exe'
$result = Join-Path ([IO.Path]::GetDirectoryName($jobPath)) 'result.json'
$moved = $false
try {
  [IO.File]::WriteAllText($jobPath + '.helper-ready', [string]$PID)
  $parent = Get-Process -Id $job.pid -ErrorAction SilentlyContinue
  if ($parent) { $parent.WaitForExit() }
  if (-not (Test-Path -LiteralPath ($jobPath + '.ready'))) { exit 0 }
  $stream = [IO.File]::OpenRead($staged)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $sha.Dispose() }
  if ($hash -ne $job.digest) { throw 'checksum' }
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  while ($true) {
    try { [IO.File]::Move($target, $backup); $moved = $true; break }
    catch { if ([DateTime]::UtcNow -ge $deadline) { throw }; Start-Sleep -Milliseconds 500 }
  }
  [IO.File]::Move($staged, $target)
  $null = Start-Process -FilePath $target -WorkingDirectory ([IO.Path]::GetDirectoryName($target)) -WindowStyle Hidden -PassThru
  @{ status = 'installed'; version = $job.version } | ConvertTo-Json -Compress | Set-Content -LiteralPath $result -Encoding UTF8
} catch {
  if ($moved) {
    if (Test-Path -LiteralPath $target) { [IO.File]::Delete($target) }
    [IO.File]::Move($backup, $target)
    try { $null = Start-Process -FilePath $target -WorkingDirectory ([IO.Path]::GetDirectoryName($target)) -WindowStyle Hidden -PassThru } catch {}
  }
  @{ status = 'failed'; version = $job.version } | ConvertTo-Json -Compress | Set-Content -LiteralPath $result -Encoding UTF8
}
`;

const launcherScript = 'Option Explicit\r\nDim shell\r\nSet shell = CreateObject("WScript.Shell")\r\nshell.Run Chr(34) & shell.ExpandEnvironmentStrings("%SystemRoot%") & "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" & Chr(34) & " -NoProfile -NonInteractive -EncodedCommand " & WScript.Arguments(0), 0, False\r\n';

export class Updater {
  constructor({ version, target, root, fetcher, startHelper = spawn }) {
    this.version = version; this.target = target; this.root = path.resolve(root); this.fetcher = fetcher; this.startHelper = startHelper;
    this.status = { currentVersion: version, phase: 'idle', canInstall: !!target, progress: 0 };
  }
  state() { return { ...this.status }; }
  async check() {
    if (this.checking) return this.checking;
    if (['downloading', 'installing'].includes(this.status.phase)) return this.state();
    this.status.phase = 'checking'; this.status.message = '';
    this.checking = (async () => {
      try {
        const response = await this.fetcher(API, { headers: { Accept: 'application/vnd.github+json' }, credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) });
        this.release = releaseAsset(await readJSON(response), this.version);
        this.status = { ...this.status, phase: this.release ? 'available' : 'latest', latestVersion: this.release?.version, message: '' };
      } catch { this.status.phase = 'error'; this.status.message = '检查失败，请检查网络后重试。'; }
      return this.state();
    })();
    try { return await this.checking; } finally { this.checking = null; }
  }
  async prepare() {
    if (!this.target) throw new Error('开发版不支持替换 EXE，请下载便携版。');
    if (!this.release || !['available', 'error'].includes(this.status.phase)) throw new Error('请先检查新版本。');
    this.status.phase = 'downloading'; this.status.progress = 0; this.status.message = '';
    const release = this.release;
    const dir = path.join(this.root, crypto.randomUUID());
    try {
      await fs.access(this.target);
      await fs.mkdir(dir, { recursive: true });
      const probe = path.join(path.dirname(this.target), `.codex-update-${crypto.randomUUID()}.tmp`);
      try { await fs.writeFile(probe, '', { flag: 'wx' }); } finally { await fs.rm(probe, { force: true }); }
      const response = await this.fetcher(release.url, { credentials: 'omit', cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(15 * 60 * 1000) });
      const final = new URL(response.url || release.url);
      if (!response.ok || final.protocol !== 'https:' || final.username || final.password
        || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(final.hostname)) {
        await response.body?.cancel().catch(() => {}); throw new Error('download');
      }
      const reader = response.body.getReader(); const file = await fs.open(path.join(dir, 'app.exe'), 'wx');
      const hash = crypto.createHash('sha256'); let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          bytes += value.byteLength; if (bytes > release.size || bytes > MAX) throw new Error('size');
          hash.update(value); await file.writeFile(value);
          this.status.progress = Math.floor(bytes / release.size * 100);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); await file.close(); }
      if (bytes !== release.size || hash.digest('hex') !== release.digest) throw new Error('checksum');
      const job = path.join(dir, 'job.json');
      await fs.writeFile(job, JSON.stringify({ target: path.resolve(this.target), pid: process.pid, version: release.version, digest: release.digest }), { flag: 'wx' });
      this.job = job; this.status.phase = 'installing'; return job;
    } catch {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      this.status.phase = 'error'; this.status.message = '更新下载或校验失败，旧版本已保留，请重试。';
      throw new Error(this.status.message);
    }
  }
  async launchInstaller() {
    if (!this.job) throw new Error('更新文件未就绪。');
    const launcher = path.join(path.dirname(this.job), 'launcher.vbs');
    await fs.writeFile(launcher, launcherScript, { flag: 'wx' });
    const host = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
    const helper = this.startHelper(host, ['//B', '//NoLogo', launcher, Buffer.from(installScript, 'utf16le').toString('base64')], {
      env: { ...process.env, CODEX_MANAGER_UPDATE_JOB: this.job }, cwd: path.dirname(this.target), windowsHide: true, detached: true, stdio: 'ignore',
    });
    await new Promise((resolve, reject) => { helper.once('spawn', resolve); helper.once('error', () => reject(new Error('无法启动更新程序，请重试。'))); });
    try {
      const deadline = Date.now() + 10000;
      while (true) {
        if (await fs.readFile(this.job + '.helper-ready', 'utf8').then(value => /^[1-9]\d{0,9}$/.test(value), () => false)) break;
        if ((helper.exitCode !== null && helper.exitCode !== 0) || helper.signalCode || Date.now() >= deadline) throw new Error('helper');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await fs.writeFile(this.job + '.ready', 'ready', { flag: 'wx' });
    } catch {
      helper.kill(); throw new Error('更新辅助程序未能就绪，旧版本已保留，请重试。');
    }
    helper.unref();
  }
  async cleanCompleted() {
    for (const name of await fs.readdir(this.root).catch(() => [])) {
      if (!/^[a-f0-9-]{36}$/.test(name)) continue;
      const dir = path.join(this.root, name);
      if (!(await fs.lstat(dir)).isDirectory() || (await fs.lstat(dir)).isSymbolicLink()) continue;
      try {
        const result = JSON.parse((await fs.readFile(path.join(dir, 'result.json'), 'utf8')).replace(/^\uFEFF/, ''));
        if (result.status !== 'installed' || result.version !== this.version) continue;
        for (const file of ['job.json', 'job.json.ready', 'job.json.helper-ready', 'launcher.vbs', 'app.exe', 'previous.exe', 'result.json']) await fs.rm(path.join(dir, file), { force: true });
        await fs.rmdir(dir);
      } catch {}
    }
  }
}
