using System.Net.Http;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace CampusLink;

public sealed partial class ConnectionService
{
    private static readonly TimeSpan AgyCheckInterval = TimeSpan.FromSeconds(45);
    private readonly SemaphoreSlim agyGate = new(1, 1);
    private readonly Task agyMonitor;
    private readonly string agyHistoryPath;
    private CancellationTokenSource? agySession;
    private AgyEndpoint? agyEndpoint;
    private Running? agyCore;
    private string? agyLineKey;
    private DateTimeOffset agyNextCheck;
    private int networkEpoch;
    private int verifiedEpoch;
    private int readyAgyPort;
    public event Action? AgyChanged;
    public string AgyStatus { get; private set; } = "agy 美国代理未连接";
    public bool AgyActive => Volatile.Read(ref agyEndpoint) != null;
    public int? AgyPort => Volatile.Read(ref readyAgyPort) is 0 ? null : AgyLaunch.Port;
    internal int? AgyCorePid => agyCore?.Process.Id;

    private void OnAgyNetworkChange(object? sender, EventArgs e) => NotifyNetworkChanged();
    internal void NotifyNetworkChanged()
    {
        Interlocked.Increment(ref networkEpoch);
        InvalidateRankings();
        try { recoveryOperation?.Cancel(); } catch (ObjectDisposedException) { }
    }
    private void SetAgy(string status, bool ready = false)
    {
        AgyStatus = status;
        Volatile.Write(ref readyAgyPort, ready ? AgyLaunch.Port : 0);
        AgyChanged?.Invoke();
    }

    private string? ReadAgyHistory()
    {
        try { return File.Exists(agyHistoryPath) ? File.ReadAllText(agyHistoryPath).Trim() : null; }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return null; }
    }

    private void RememberAgy(string key)
    {
        try { if (ReadAgyHistory() != key) Paths.Atomic(agyHistoryPath, key); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        { AddLog("agy：无法写入上一次成功线路，下次将重新搜索。"); }
    }

    private void ReadyAgy(string ip, int epoch, bool resume)
    {
        if (resume) agyEndpoint!.SetUpstream(agyCore!.Port);
        verifiedEpoch = epoch;
        agyNextCheck = DateTimeOffset.UtcNow + AgyCheckInterval;
        SetAgy($"美国出口 {ip} · 127.0.0.1:{AgyLaunch.Port}", true);
    }

    internal async Task<(string ExitIp, int Port, string Profile)> ConnectAgy()
    {
        await agyGate.WaitAsync(lifetime.Token);
        try
        {
            if (agyEndpoint != null) throw new InvalidOperationException("agy 美国代理已连接或正在搜索。");
            try { agyEndpoint = new AgyEndpoint(AgyLaunch.Port); }
            catch (SocketException e)
            {
                SetAgy($"127.0.0.1:{AgyLaunch.Port} 无法监听。请检查端口是否被其他软件占用。");
                throw new InvalidOperationException(AgyStatus, e);
            }
            agySession = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
            SetAgy("正在查找美国线路…");
            try { return await FindAgy(null, agySession.Token); }
            catch (OperationCanceledException)
            {
                await StopAgy("已取消连接美国代理。");
                throw;
            }
            catch (Exception e)
            {
                await StopAgy(e is InvalidOperationException ? e.Message : "美国代理连接失败，请查看诊断。");
                throw new InvalidOperationException(AgyStatus, e);
            }
        }
        finally { agyGate.Release(); }
    }

    private async Task<(string ExitIp, int Port, string Profile)> FindAgy(string? failedLine, CancellationToken ct)
    {
        int epoch = Volatile.Read(ref networkEpoch);
        var history = ReadAgyHistory();
        var candidates = new List<(AgyLaunch.Line Line, string Key)>();
        foreach (var profile in ProfileStore.Ids.Where(store.Has))
        {
            try { candidates.AddRange(AgyLaunch.Lines(profile, store.Load(profile)).Select(line => (line, line.Key)).ToArray()); }
            catch (Exception e) when (e is JsonException or IOException or InvalidOperationException or System.Security.Cryptography.CryptographicException)
            { AddLog($"agy：无法读取 {ProfileStore.Name(profile)} 线路。"); }
        }
        if (candidates.Count == 0) throw new InvalidOperationException("没有可用的节点配置。请先更新或导入美国节点。");
        int index = 0;
        var search = Stopwatch.StartNew();
        foreach (var (line, key) in candidates.OrderBy(c => c.Key == failedLine ? 4 : c.Key == history ? -1 : c.Line.Priority))
        {
            ct.ThrowIfCancellationRequested();
            var remaining = TimeSpan.FromSeconds(60) - search.Elapsed;
            if (remaining <= TimeSpan.Zero) break;
            var action = failedLine == null ? "正在验证美国出口" : "正在恢复美国代理";
            SetAgy($"{action} · {++index}/{candidates.Count}");
            using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct);
            limit.CancelAfter(remaining < TimeSpan.FromSeconds(8) ? remaining : TimeSpan.FromSeconds(8));
            Running? candidate = null;
            try
            {
                candidate = await Candidate(line.Profile, line.Raw, limit.Token, line);
                var ip = await AgyLaunch.Verify(candidate.Port, limit.Token);
                if (ip == null || candidate.Process.HasExited) continue;
                ct.ThrowIfCancellationRequested();
                agyCore = candidate; agyLineKey = key; candidate = null;
                ReadyAgy(ip, epoch, true);
                RememberAgy(key);
                AddLog($"agy：{ProfileStore.Name(line.Profile)} 已验证美国出口。");
                return (ip, AgyLaunch.Port, line.Profile);
            }
            catch (Exception e) when (!ct.IsCancellationRequested &&
                e is OperationCanceledException or HttpRequestException or InvalidOperationException or IOException or System.ComponentModel.Win32Exception)
            { AddLog($"agy：{ProfileStore.Name(line.Profile)} 的候选线路未通过验证。"); }
            finally { await Stop(candidate); }
        }
        ct.ThrowIfCancellationRequested();
        throw new InvalidOperationException("未找到可用的美国出口，请检查网络或更新节点。");
    }

    private async Task MonitorAgy()
    {
        try
        {
            while (!lifetime.IsCancellationRequested)
            {
                var beforeDelay = DateTimeOffset.UtcNow;
                await Task.Delay(1000, lifetime.Token);
                if (DateTimeOffset.UtcNow - beforeDelay > TimeSpan.FromSeconds(5)) Interlocked.Increment(ref networkEpoch);
                if (!await agyGate.WaitAsync(0, lifetime.Token)) continue;
                try
                {
                    if (agySession == null || agySession.IsCancellationRequested) continue;
                    int epoch = Volatile.Read(ref networkEpoch);
                    bool changed = epoch != verifiedEpoch;
                    bool exited = agyCore?.Process.HasExited == true;
                    if (!changed && !exited && DateTimeOffset.UtcNow < agyNextCheck) continue;
                    if (agyCore != null && !exited)
                    {
                        if (changed)
                        {
                            agyEndpoint!.SetUpstream(null);
                            SetAgy("网络已变化，正在复检美国线路…");
                        }
                        using var limit = CancellationTokenSource.CreateLinkedTokenSource(agySession.Token);
                        limit.CancelAfter(TimeSpan.FromSeconds(8));
                        string? ip = null;
                        try { ip = await AgyLaunch.Verify(agyCore.Port, limit.Token); }
                        catch (Exception e) when (e is HttpRequestException or IOException or OperationCanceledException) { }
                        if (agySession.IsCancellationRequested) continue;
                        if (ip != null && !agyCore.Process.HasExited)
                        {
                            ReadyAgy(ip, epoch, changed);
                            continue;
                        }
                    }

                    agyEndpoint!.SetUpstream(null);
                    SetAgy("美国线路中断，正在恢复…");
                    var old = agyCore; agyCore = null;
                    await Stop(old);
                    await FindAgy(agyLineKey, agySession.Token);
                }
                catch (OperationCanceledException) when (agySession?.IsCancellationRequested == true) { }
                catch (Exception e)
                {
                    agyEndpoint?.SetUpstream(null);
                    var failed = agyCore; agyCore = null;
                    await Stop(failed);
                    AddLog("agy 恢复未完成：" + e.GetType().Name);
                    verifiedEpoch = Volatile.Read(ref networkEpoch);
                    agyNextCheck = DateTimeOffset.UtcNow + TimeSpan.FromSeconds(30);
                    SetAgy("暂无可用美国线路 · 30 秒后重试");
                }
                finally { agyGate.Release(); }
            }
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
    }

    private async Task StopAgy(string status)
    {
        var endpoint = agyEndpoint; var old = agyCore;
        agyEndpoint = null; agyCore = null; agyLineKey = null;
        agySession?.Dispose(); agySession = null;
        SetAgy(status);
        try { if (endpoint != null) await endpoint.DisposeAsync(); }
        finally { await Stop(old); }
    }

    internal void CancelAgy()
    {
        try { Volatile.Read(ref agySession)?.Cancel(); } catch (ObjectDisposedException) { }
    }

    internal async Task DisconnectAgy()
    {
        CancelAgy();
        await agyGate.WaitAsync();
        try { await StopAgy("agy 美国代理已断开"); }
        finally { agyGate.Release(); }
    }
}
