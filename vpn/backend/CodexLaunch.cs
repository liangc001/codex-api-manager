namespace CampusLink;

internal static class CodexLaunch
{
    internal sealed record Installation(string Executable);

    internal static async Task<Installation> Find(CancellationToken ct)
    {
        // Resolve the current user's installed package on this computer, never a copied WindowsApps path.
        var shell = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
        var info = new ProcessStartInfo(shell)
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true
        };
        foreach (var arg in new[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
            "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1 -ExpandProperty InstallLocation" })
            info.ArgumentList.Add(arg);
        using var process = Process.Start(info) ?? throw new InvalidOperationException("无法查找 Codex，请确认已安装桌面版。");
        var stdout = process.StandardOutput.ReadToEndAsync(ct);
        var stderr = process.StandardError.ReadToEndAsync(ct);
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct); limit.CancelAfter(TimeSpan.FromSeconds(15));
        try { await process.WaitForExitAsync(limit.Token); }
        catch { if (!process.HasExited) process.Kill(true); throw; }
        string root = (await stdout).Trim(); _ = await stderr;
        if (process.ExitCode != 0 || string.IsNullOrEmpty(root) || !Path.IsPathFullyQualified(root) || root.Contains('\n'))
            throw new InvalidOperationException("未找到 Codex 桌面版，请先在这台电脑安装 Codex。");
        string executable = Path.Combine(root, "app", "ChatGPT.exe");
        if (!File.Exists(executable)) throw new InvalidOperationException("Codex 安装不完整，请先修复或更新 Codex。");
        return new(executable);
    }

    internal static bool IsRunning(Installation app)
    {
        foreach (var name in new[] { "ChatGPT", "Codex" })
            foreach (var process in Process.GetProcessesByName(name))
                using (process)
                {
                    try
                    {
                        if (!process.HasExited && string.Equals(process.MainModule?.FileName, app.Executable, StringComparison.OrdinalIgnoreCase)) return true;
                    }
                    catch (System.ComponentModel.Win32Exception)
                    { throw new InvalidOperationException("无法核对 Codex 进程，请先完全退出 Codex，再点击打开。"); }
                    catch (InvalidOperationException) { /* A process may exit during enumeration. */ }
                }
        return false;
    }

    internal static ProcessStartInfo StartInfo(Installation app, int port)
    {
        if (port is <= 0 or > 65535) throw new ArgumentOutOfRangeException(nameof(port));
        string endpoint = $"http://127.0.0.1:{port}";
        var info = new ProcessStartInfo(app.Executable) { UseShellExecute = false };
        foreach (var name in new[] { "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy" })
            info.Environment[name] = endpoint;
        foreach (var name in new[] { "NO_PROXY", "no_proxy" }) info.Environment[name] = "localhost,127.0.0.1,::1";
        info.ArgumentList.Add("--proxy-server=" + endpoint);
        info.ArgumentList.Add("--proxy-bypass-list=localhost;127.0.0.1;[::1]");
        return info;
    }

    internal static async Task Open(Func<CancellationToken, Task<int>> ensureProxy, CancellationToken ct,
        Func<CancellationToken, Task<Installation>>? discover = null, Func<Installation, bool>? running = null,
        Action<ProcessStartInfo>? launch = null)
    {
        var app = await (discover ?? Find)(ct);
        var isRunning = running ?? IsRunning;
        const string existing = "请先保存工作并完全退出 Codex，再点击打开。";
        if (isRunning(app)) throw new InvalidOperationException(existing);
        int port = await ensureProxy(ct);
        ct.ThrowIfCancellationRequested();
        // The user might open Codex while the proxy is being prepared.
        if (isRunning(app)) throw new InvalidOperationException(existing);
        var info = StartInfo(app, port);
        try
        {
            if (launch != null) launch(info);
            else using (var child = Process.Start(info))
                if (child == null) throw new InvalidOperationException("Codex 未能启动，请稍后重试。");
        }
        catch (System.ComponentModel.Win32Exception)
        { throw new InvalidOperationException("无法启动 Codex，请检查安装是否完整。"); }
    }
}
