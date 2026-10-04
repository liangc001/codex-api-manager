const { spawn } = require('node:child_process');

const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
function Find-Codex {
  $package = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1
  if ($package) {
    [xml]$manifest = Get-Content -LiteralPath (Join-Path $package.InstallLocation 'AppxManifest.xml')
    $application = @($manifest.Package.Applications.Application) | Where-Object { $_.Executable -match '(^|[/\\])(ChatGPT|Codex)\.exe$' } | Select-Object -First 1
    if ($application) {
      $executable = [IO.Path]::GetFullPath((Join-Path $package.InstallLocation $application.Executable))
      if ($executable.StartsWith($package.InstallLocation + '\', [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $executable -PathType Leaf)) {
        return @{ executable = $executable; appId = $package.PackageFamilyName + '!' + $application.Id }
      }
    }
  }
  # Resolve paths on this computer every time; portable data never stores an installation path.
  foreach ($folder in @('Programs\Codex', 'Programs\OpenAI\Codex', 'OpenAI\Codex\app')) {
    foreach ($name in @('Codex.exe', 'ChatGPT.exe')) {
      $executable = Join-Path (Join-Path $env:LOCALAPPDATA $folder) $name
      if (Test-Path -LiteralPath $executable -PathType Leaf) { return @{ executable = $executable; appId = $null } }
    }
  }
  $locations = @()
  foreach ($registry in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
    $locations += @(Get-ItemProperty -Path $registry -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '^(OpenAI\s+)?Codex(\s|$)' -and $_.InstallLocation } | ForEach-Object { $_.InstallLocation })
  }
  foreach ($root in @($env:ProgramFiles, [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'))) {
    if ($root) { $locations += Join-Path $root 'Codex' }
  }
  $candidates = @($locations | ForEach-Object {
    Join-Path $_ 'Codex.exe'
    Join-Path $_ 'ChatGPT.exe'
  })
  $candidates += @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('Codex.exe', 'ChatGPT.exe') -and $_.ExecutablePath } | ForEach-Object { $_.ExecutablePath })
  foreach ($executable in @($candidates | Select-Object -Unique)) {
    if ((Test-Path -LiteralPath $executable -PathType Leaf) -and (Get-Item -LiteralPath $executable).VersionInfo.ProductName -match '\bCodex\b') {
      return @{ executable = [IO.Path]::GetFullPath($executable); appId = $null }
    }
  }
  throw '未找到 Codex 桌面 App，请先安装或手动打开 Codex。'
}
function Find-Processes($executable) {
  @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $executable })
}
try {
  $target = Find-Codex
  $processes = @(Find-Processes $target.executable)
  if ($inputData.action -eq 'probe') {
    @{ executable = $target.executable; running = $processes.Count -gt 0 } | ConvertTo-Json -Compress
    exit 0
  }
  if ($inputData.action -ne 'restart' -or $target.executable -ne $inputData.expectedExecutable) { throw 'Codex 安装位置发生变化，请重新点击重启。' }
  foreach ($item in $processes) {
    if ($item.ParentProcessId -notin $processes.ProcessId) {
      $process = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
      if ($process -and $process.MainWindowHandle -ne 0) { $null = $process.CloseMainWindow() }
    }
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(8)
  while ((@(Find-Processes $target.executable)).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
  # Only stop GUI processes from the detected installation; never match CLI by name.
  foreach ($item in @(Find-Processes $target.executable)) {
    $live = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $item.ProcessId)
    if ($live -and $live.ExecutablePath -eq $target.executable) { Stop-Process -Id $live.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  while ((@(Find-Processes $target.executable)).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if ((@(Find-Processes $target.executable)).Count -gt 0) { throw '无法关闭 Codex，请检查权限或手动退出后重试。' }
  if ($target.appId) {
    Start-Process -FilePath (Join-Path $env:WINDIR 'explorer.exe') -ArgumentList ('shell:AppsFolder\' + $target.appId) -WindowStyle Hidden
  } else {
    Start-Process -FilePath $target.executable -WorkingDirectory ([IO.Path]::GetDirectoryName($target.executable)) -WindowStyle Hidden
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while ((@(Find-Processes $target.executable)).Count -eq 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 500 }
  if ((@(Find-Processes $target.executable)).Count -eq 0) { throw 'Codex 已关闭，但未能重新启动，请从开始菜单打开 Codex。' }
  @{ restarted = $true } | ConvertTo-Json -Compress
} catch {
  @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
`;

function run(input) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
    let output = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new Error('无法启动 Windows 重启服务。')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('重启 Codex 超时，请手动检查 Codex 是否已打开。'));
      try {
        const result = JSON.parse(output.replace(/^\uFEFF/, '').trim());
        if (code || result.error) reject(new Error(result.error || '重启 Codex 失败。'));
        else resolve(result);
      } catch { reject(new Error('无法识别 Codex 启动状态。')); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

module.exports = {
  probe: () => run({ action: 'probe' }),
  restart: target => run({ action: 'restart', expectedExecutable: target.executable }),
};
