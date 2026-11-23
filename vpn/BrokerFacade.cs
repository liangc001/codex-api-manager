using System.Net.Sockets;

namespace CampusLink;

internal sealed class BrokerFacade(bool fixture, int basePort, int relayPort) : IAsyncDisposable
{
    private ConnectionService? service;
    private ScopedProxy? proxy;
    private ProfileStore? profiles;
    private Task? command;
    private CancellationTokenSource? connectCancellation;
    private IReadOnlyList<ExitOption>? regions;
    private readonly System.Collections.Concurrent.ConcurrentQueue<DiagnosticEvent> history = new();
    private sealed record DiagnosticEvent(DateTimeOffset At, string Action, string Result);
    private string operation = "", lastError = "", notice = "";
    private bool imported = File.Exists(Path.Combine(Paths.Data, "portable.key"));
    internal bool Exited { get; private set; }

    private sealed class ScopedProxy(ProfileStore store) : ISystemProxy
    {
        private readonly ProxyGuard guard = new(() => Configuration.BypassFor(store.Policy));
        internal bool System { get; set; }
        public bool IsOwned => !System || guard.IsOwned;
        public bool BypassMatches => !System || guard.BypassMatches;
        public void ProtectLifetime() => guard.ProtectLifetime();
        public void Apply(int port, params string[] files) { if (System) guard.Apply(port, files); }
        public string Restore() => System ? guard.Restore() : "";
    }

    private ConnectionService Service()
    {
        if (service != null) return service;
        if (!imported) throw new BrokerError("请先导入完整 VPN 便携文件夹。");
        ProfileStore store;
        try { store = PortableImport.Open(Paths.BackendHome!); }
        catch { throw new BrokerError("VPN 数据不完整或密钥无效，请使用完整的便携目录。"); }
        profiles = store;
        proxy = new ScopedProxy(store);
        Func<int, CancellationToken, Task<Health>>? probe = null;
        Func<int, CancellationToken, Task<LatencySample>>? latency = null;
        if (fixture)
        {
            probe = async (_, ct) => { await Task.Delay(800, ct); return new(true, "192.0.2.10", false, "", 27, Country: "US"); };
            latency = (_, _) => Task.FromResult(new LatencySample(27, DateTimeOffset.UtcNow));
        }
        service = new(store, basePort, probe, proxyController: proxy, latencyProbe: latency) { OrdinaryRelayPort = relayPort };
        service.SourcesChanged += () => Volatile.Write(ref regions, null);
        service.RankingsChanged += () => Volatile.Write(ref regions, null);
        string phase = "";
        service.Changed += state =>
        {
            if (phase != state.Phase) Record("phase", state.Phase);
            phase = state.Phase;
        };
        return service;
    }

    private void Record(string action, string result)
    {
        history.Enqueue(new(DateTimeOffset.UtcNow, action, result));
        while (history.Count > 40) history.TryDequeue(out _);
    }

    private IReadOnlyList<ExitOption> Regions(ConnectionService s) =>
        Volatile.Read(ref regions) ?? (regions = s.GetExitOptions());

    internal object Status(bool diagnostic = false)
    {
        var s = service; var state = s?.State; var health = state?.Health;
        return new
        {
            version = 1, imported, phase = state?.Phase ?? "disconnected", connected = state?.Connected == true,
            busy = command is { IsCompleted: false } || state?.Busy == true, operation, error = lastError, notice,
            mode = proxy?.System == true ? "system" : "app", requestedRegion = state?.RequestedRegion,
            preferredRegion = s?.Preferences.Value.LastRegion, preferredMode = s?.Preferences.Value.LastMode,
            autoConnect = s?.Preferences.Value.AutoConnect == true, autoRecover = s?.Preferences.Value.AutoRecover != false,
            country = health?.Country, exitIp = diagnostic ? null : health?.ExitIp,
            checkedAt = health?.CheckedAt, probeMs = health?.Milliseconds,
            campusReachable = health?.SchoolChecked == true ? health.SchoolOk : (bool?)null,
            history = history.ToArray(),
            latencyMs = s?.Latency?.Milliseconds, latencyAt = s?.Latency?.CheckedAt, checkingLatency = s?.Latency?.Checking == true, healthy = health?.InternetOk,
            proxyPort = s?.OrdinaryEndpoint, agyReady = s?.AgyPort.HasValue == true, agyActive = s?.AgyActive == true || operation == "agy",
            sources = s == null ? null : ProfileStore.Ids.Select(id => new { id, status = s.SourceStatus(id) }),
            hasSubscription = !diagnostic && File.Exists(Path.Combine(Paths.Data, "subscription.protected")),
            rankingBusy = s?.RankingBusy == true, rankingStatus = s?.RankingStatus,
            rankings = s?.RegionLatencies.Select(r => new { r.Code, r.Country, r.Milliseconds, r.Status }),
            regions = diagnostic || s == null ? null : Regions(s),
        };
    }

    internal async Task<object> Dispatch(JsonObject request)
    {
        if (request["v"]?.GetValue<int>() != 1) throw new BrokerError("VPN 控制协议版本不兼容。");
        string op = request["op"]?.GetValue<string>() ?? "";
        switch (op)
        {
            case "status":
            case "regions":
                if (imported && service == null && command is not { IsCompleted: false }) Service();
                return Status();
            case "diagnostics": return Status(true);
            case "import":
                if (service != null || imported) throw new BrokerError("已配置 VPN 数据。此版本不覆盖已有导入。");
                Start(op, async () =>
                {
                    await Task.Run(() => PortableImport.Copy(request["directory"]!.GetValue<string>(), Paths.BackendHome!));
                    imported = true;
                });
                break;
            case "set-preference":
            {
                var s = Service();
                string key = request["key"]!.GetValue<string>();
                bool value = request["value"]!.GetValue<bool>();
                if (key is not ("autoConnect" or "autoRecover")) throw new BrokerError("未知 VPN 设置。");
                s.Preferences.Update(p => key == "autoConnect" ? p with { AutoConnect = value } : p with { AutoRecover = value });
                if (key == "autoRecover" && !value) s.CancelRecovery();
                break;
            }
            case "check-sources": Start(op, Service().CheckSources, "线路检测完成。"); break;
            case "update-researchlab":
                if (fixture) throw new BrokerError("测试模式不下载真实订阅。");
                if (!File.Exists(Path.Combine(Paths.Data, "subscription.protected"))) throw new BrokerError("尚未导入 ResearchLab 订阅。");
                var updating = Service();
                Start(op, () => updating.UpdateResearchLab(), "ResearchLab 已更新，下次连接生效。");
                break;
            case "import-clash":
            case "import-v2ray":
            {
                var s = Service();
                if (s.OrdinaryEndpoint != null || s.State.Busy || s.AgyActive || s.RankingBusy)
                    throw new BrokerError("请先断开线路并结束测速，再导入配置。");
                string input = Path.GetFullPath(request["directory"]!.GetValue<string>());
                Start(op, async () =>
                {
                    if (op == "import-clash")
                    {
                        PortableImport.CheckPath(input, 4_000_000);
                        await s.ImportClash(input);
                    }
                    else
                    {
                        await Task.Run(() => profiles!.Import(input));
                        s.InvalidateRankings("配置已更新，请重测");
                    }
                    Volatile.Write(ref regions, null);
                }, "配置已导入。");
                break;
            }
            case "agy-settings":
                if (service?.AgyPort is not int port) throw new BrokerError("请先启动 agy 美国代理。");
                return new { version = 1, text = AgyLaunch.PowerShellSettings(port) };
            case "connect":
            case "open-codex":
            {
                if (op == "open-codex" && fixture) throw new BrokerError("测试模式不启动外部应用。");
                var s = Service();
                string region = request["region"]?.GetValue<string>() ?? s.Preferences.Value.LastRegion;
                string mode = request["mode"]?.GetValue<string>() ?? s.Preferences.Value.LastMode;
                if (mode is not ("app" or "system") || (fixture && mode == "system")) throw new BrokerError("无效的代理模式。");
                if (!Regions(s).Any(r => r.Code == region)) throw new BrokerError("请选择列表中的地区。");
                if ((s.OrdinaryEndpoint != null || s.State.Connected || s.State.Busy) && proxy!.System != (mode == "system"))
                    throw new BrokerError("请先断开，再切换代理模式。");
                if (command is { IsCompleted: false }) throw new BrokerError("正在处理另一项 VPN 操作。");
                connectCancellation?.Dispose();
                connectCancellation = new();
                var ct = connectCancellation.Token;
                proxy!.System = mode == "system";
                Start(op, async () =>
                {
                    ct.ThrowIfCancellationRequested();
                    if (op == "open-codex") await s.OpenCodex(region, ct);
                    else
                    {
                        s.RequireOrdinaryRelay();
                        await s.ConnectRegion(region, cancellation: ct);
                    }
                    s.Preferences.Update(p => p with { LastMode = mode });
                }, op == "open-codex" ? "已通过 VPN 打开 Codex。" : "");
                break;
            }
            case "disconnect":
                if (command is { IsCompleted: false } previous)
                {
                    if (operation != "connect") throw new BrokerError("请等待当前操作完成。");
                    CancelConnect();
                    await previous;
                }
                else CancelConnect();
                if (service != null) Start(op, service.Disconnect);
                break;
            case "cancel-connect": CancelConnect(); break;
            case "benchmark":
                if (operation is "import-v2ray" or "import-clash") throw new BrokerError("请等待导入完成。");
                _ = Service().MeasureRegions(); break;
            case "cancel-benchmark": service?.CancelRegionScan(); break;
            case "latency": if (service != null) Start(op, service.RefreshLatency); break;
            case "agy":
                if (fixture) throw new BrokerError("测试模式不启用 agy。");
                Start(op, async () => { await Service().ConnectAgy(); }); break;
            case "disconnect-agy":
                if (operation == "agy") service?.CancelAgy();
                else if (service != null) Start(op, service.DisconnectAgy);
                break;
            case "shutdown": await DisposeAsync(); break;
            default: throw new BrokerError("未知 VPN 操作。");
        }
        return Status();
    }

    private void CancelConnect()
    {
        connectCancellation?.Cancel();
        service?.CancelConnection();
        service?.CancelRecovery();
    }

    private void Start(string name, Func<Task> action, string success = "")
    {
        if (command is { IsCompleted: false }) throw new BrokerError("正在处理另一项 VPN 操作。");
        lastError = ""; notice = ""; operation = name;
        command = Task.Run(async () =>
        {
            Record(name, "started");
            try { await action(); notice = success; }
            catch (SocketException) { lastError = "普通代理端口被占用，未更改现有代理。"; }
            catch (OperationCanceledException) { lastError = "已取消。"; }
            catch { lastError = name switch {
                "import" => "导入失败。请确认所选目录包含完整 data、原配密钥和 cores。",
                "connect" => "未能连接所选地区；不会自动换到其他地区。",
                "open-codex" => "未能打开 Codex。请确认已安装，且已保存工作并完全退出已有 Codex。",
                "agy" => "agy 美国线路未能就绪。",
                "import-clash" or "import-v2ray" => "配置导入失败，已保留原配置。",
                "update-researchlab" => "ResearchLab 更新失败，已保留原配置。",
                _ => "VPN 操作未完成，请检查脱敏诊断。"
            }; }
            finally { Record(name, lastError.Length == 0 ? "completed" : "not-completed"); operation = ""; }
        });
    }

    public async ValueTask DisposeAsync()
    {
        if (Exited) return;
        Exited = true;
        CancelConnect();
        service?.CancelPending();  // This is terminal, unlike the ordinary Cancel actions.
        service?.CancelRegionScan();
        if (command != null) await command;
        try { if (service != null) await service.DisposeAsync(); }
        finally { service = null; connectCancellation?.Dispose(); }
    }
}
