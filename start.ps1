$ErrorActionPreference = 'Stop'
$appDir = $PSScriptRoot
$runtime = (Get-Command node -ErrorAction Stop).Source
$dataDir = Join-Path $env:LOCALAPPDATA 'CodexApiManager'
$statusFile = Join-Path $dataDir 'server.json'
function Get-RunningUrl {
    if (-not (Test-Path -LiteralPath $statusFile)) { return $null }
    try {
        $status = Get-Content -Raw -LiteralPath $statusFile | ConvertFrom-Json
        $uri = [Uri]$status.url
        if ($uri.Host -ne '127.0.0.1' -or $uri.Scheme -ne 'http') { return $null }
        $response = Invoke-WebRequest -Uri $status.url -UseBasicParsing -TimeoutSec 2
        if ($response.Content.Contains('name="manager-token"')) { return $status.url }
    } catch { return $null }
    return $null
}
try {
    $url = Get-RunningUrl
    if (-not $url) {
        if (-not (Test-Path -LiteralPath (Join-Path $appDir 'node_modules'))) { throw 'Dependencies missing. Run npm install in the app folder.' }
        New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
        Start-Process -FilePath $runtime -ArgumentList @('server.mjs') -WorkingDirectory $appDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataDir 'server.log') -RedirectStandardError (Join-Path $dataDir 'error.log') | Out-Null
        for ($attempt = 0; $attempt -lt 40; $attempt++) {
            Start-Sleep -Milliseconds 300
            $url = Get-RunningUrl
            if ($url) { break }
        }
        if (-not $url) { throw "App did not start. See $dataDir\error.log" }
    }
    Start-Process $url
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Codex API Manager') | Out-Null
    exit 1
}
