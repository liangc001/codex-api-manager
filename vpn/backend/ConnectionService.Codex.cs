namespace CampusLink;

public sealed partial class ConnectionService
{
    internal const int CodexPort = 10839;
    internal int OrdinaryRelayPort { get; init; } = CodexPort;
    internal int? OrdinaryEndpoint => codexTargetPort.HasValue ? codexEndpoint?.Port : null;
    private AgyEndpoint? codexEndpoint;
    internal string? CodexProxyError { get; private set; }
    private int? codexTargetPort;

    internal async Task OpenCodex(string region, CancellationToken cancellation = default)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token, cancellation);
        await CodexLaunch.Open(ct => EnsureCodexProxy(region, ct), linked.Token);
    }

    private void SyncCodexProxy()
    {
        if (codexEndpoint == null && current != null && !current.Process.HasExited)
        {
            try { RequireOrdinaryRelay(); }
            catch (System.Net.Sockets.SocketException)
            {
                if (CodexProxyError == null) AddLog($"Codex 本机端口 {CodexPort} 被占用，普通连接不受影响。");
                CodexProxyError = $"Codex 本机端口 {CodexPort} 被占用，请关闭占用程序后重试；普通连接可继续使用。";
            }
        }
        if (codexEndpoint == null) return;
        int? target = current != null && !current.Process.HasExited ? current.Port : null;
        if (target == codexTargetPort) return;
        codexEndpoint.SetUpstream(target);
        codexTargetPort = target;
    }

    internal void RequireOrdinaryRelay()
    {
        if (codexEndpoint != null) return;
        codexEndpoint = new AgyEndpoint(OrdinaryRelayPort);
        CodexProxyError = null;
    }

    private async Task<int> EnsureCodexProxy(string region, CancellationToken ct)
    {
        bool needsConnection;
        await gate.WaitAsync(ct);
        try { needsConnection = current == null || current.Process.HasExited || State.RequestedRegion != region; }
        finally { gate.Release(); }
        if (needsConnection)
        {
            RequireOrdinaryRelay();
            await ConnectRegion(region, cancellation: ct);
        }
        await gate.WaitAsync(ct);
        try
        {
            if (current == null || current.Process.HasExited || State.RequestedRegion != region || State.Health?.InternetOk != true)
                throw new InvalidOperationException("所选线路尚未连接，请连接后再打开 Codex。");
            ct.ThrowIfCancellationRequested();
            // Keep a stable local address for Codex while normal connections switch core ports.
            // This relay uses exactly the active normal core, including its routing rules.
            SyncCodexProxy();
            if (codexEndpoint == null) throw new InvalidOperationException(CodexProxyError ?? "Codex 代理入口未能启动，请重试。");
            return codexEndpoint.Port;
        }
        finally { gate.Release(); }
    }
}
