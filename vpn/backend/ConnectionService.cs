using System.Net.Http;
using System.Net.Sockets;
using System.Text.RegularExpressions;

namespace CampusLink;

public sealed record LinkState(string Phase, string Profile, string Message, Health? Health = null, string? RequestedRegion = null)
{
    public bool Connected => Phase is "connected" or "external" or "modified" or "recovering";
    public bool Busy => Phase is "connecting" or "switching" or "checking" or "updating" or "disconnecting" or "importing" or "recovering";
}

public sealed partial class ConnectionService : IAsyncDisposable
{
    private sealed record Running(string Id, int Port, Process Process, string Config);
    private readonly ProfileStore store;
    private readonly CoreJob job = new();
    private readonly ISystemProxy proxy;
    private readonly Func<int, CancellationToken, Task<LatencySample>>? latencyProbe;
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly CancellationTokenSource lifetime = new();
    private readonly Task monitor;
    private readonly Queue<string> logs = new();
    private readonly int basePort;
    private readonly Func<int, CancellationToken, Task<Health>>? probe;
    private Running? current;
    private string? currentLineKey;
    private readonly RecoverySchedule recoverySchedule = new();
    private CancellationTokenSource? recoveryOperation;
    private int recoveryRevision;
    internal PreferencesStore Preferences { get; }
    private CancellationTokenSource? activeOperation;
    public LinkState State { get; private set; } = new("disconnected", "racknerd", "选择线路，点击连接。");
    public event Action<LinkState>? Changed;
    public event Action? LogChanged;
    public int? CurrentPid => current?.Process.Id;
    public int? CurrentPort => current?.Port;
    internal int? WatchdogPid => (proxy as ProxyGuard)?.WatchdogPid;
    public string Log { get { lock (logs) return string.Join(Environment.NewLine, logs); } }
    public ConnectionService(ProfileStore store, int basePort = 10818, Func<int, CancellationToken, Task<Health>>? probe = null,
        string? agyHistoryPath = null, PreferencesStore? preferences = null, ISystemProxy? proxyController = null,
        Func<int, CancellationToken, Task<LatencySample>>? latencyProbe = null)
    {
        this.store = store; this.basePort = basePort; this.probe = probe;
        this.proxy = proxyController ?? new ProxyGuard(); this.latencyProbe = latencyProbe;
        Preferences = preferences ?? new PreferencesStore();
        this.agyHistoryPath = agyHistoryPath ?? Path.Combine(Paths.Local, "agy-last-line.txt");
        proxy.ProtectLifetime(); monitor = Task.Run(Monitor);
        System.Net.NetworkInformation.NetworkChange.NetworkAddressChanged += OnAgyNetworkChange;
        agyMonitor = Task.Run(MonitorAgy);
        latencyMonitor = Task.Run(MonitorLatency);
    }
    private Task<Health> Probe(string id, int port, CancellationToken ct) => probe != null ? probe(port, ct) : Connectivity.Probe(port, ct, id == "racknerd", store.Policy);
    private string OwnedPhase => !proxy.IsOwned ? "external" : !proxy.BypassMatches ? "modified" : "connected";
    private static string ExternalMessage()
    {
        var effective = ProxySnapshot.ReadEffective();
        return !ProxySnapshot.SameEndpoint(effective, effective.WithLiveBaseline())
            ? "其他本地代理已退出，点击重新接管可恢复联网。"
            : "系统代理已由其他软件接管，点击重新接管可恢复。";
    }
    private CancellationTokenSource BeginOperation(CancellationToken cancellation = default)
    {
        var operation = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token, cancellation);
        activeOperation = operation; return operation;
    }
    private void Set(LinkState value) { State = value; SyncCodexProxy(); ObserveLatencyConnection(); Changed?.Invoke(value); }
    private void AddLog(string value)
    {
        lock (logs) { logs.Enqueue(DateTime.Now.ToString("HH:mm:ss ") + value); while (logs.Count > 100) logs.Dequeue(); }
        LogChanged?.Invoke();
    }
    private static Func<string, string> Redactor(JsonObject raw)
    {
        var values = new List<string>();
        void Visit(JsonNode? n)
        {
            if (n is JsonObject o) foreach (var kv in o)
            {
                if (kv.Key.Contains("password", StringComparison.OrdinalIgnoreCase) || kv.Key.Contains("uuid", StringComparison.OrdinalIgnoreCase) || kv.Key.Contains("private-key", StringComparison.OrdinalIgnoreCase))
                    if (kv.Value is JsonValue v && v.ToString().Length >= 4) values.Add(v.ToString());
                Visit(kv.Value);
            }
            else if (n is JsonArray a) foreach (var item in a) Visit(item);
        }
        Visit(raw);
        return text =>
        {
            foreach (var value in values) text = text.Replace(value, "[凭据已隐藏]", StringComparison.Ordinal);
            text = Regex.Replace(text, @"https?://[^\s\""<>]+", "[网址已隐藏]", RegexOptions.IgnoreCase);
            return text.Length > 500 ? text[..500] : text;
        };
    }
    private static ProcessStartInfo StartInfo(string id, IEnumerable<string> args)
    {
        var info = new ProcessStartInfo(Configuration.Core(id)) { WorkingDirectory = Paths.Runtime, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var a in args) info.ArgumentList.Add(a); return info;
    }
    private async Task<Running> Candidate(string id, JsonObject raw, CancellationToken ct, AgyLaunch.Line? agyLine = null)
    {
        await candidateGate.WaitAsync(ct);
        try { return await StartCandidate(id, raw, ct, agyLine); }
        finally { candidateGate.Release(); }
    }
    private async Task<Running> StartCandidate(string id, JsonObject raw, CancellationToken ct, AgyLaunch.Line? agyLine)
    {
        int startPort = agyLine == null ? basePort : 10848;
        int port = Enumerable.Range(startPort, 10).FirstOrDefault(p =>
            p != AgyLaunch.Port && p != CodexPort && (agyLine != null || p is < 10848 or > 10857) && Connectivity.PortFree(p));
        if (port == 0) throw new InvalidOperationException($"本地端口 {startPort}～{startPort + 9} 均被占用，未改动当前连接。");
        if (!File.Exists(Configuration.Core(id))) throw new InvalidOperationException("缺少代理核心，请重新解压完整的程序文件夹。");
        var config = agyLine == null ? new Configuration(store.Policy).Build(id, raw, port) : AgyLaunch.Config(agyLine, port);
        string path = Path.Combine(Paths.Runtime, "runtime-" + Paths.OwnerStamp + "-" + Guid.NewGuid().ToString("N") + ".json");
        Paths.Atomic(path, Configuration.Serialize(id, config));
        var redact = Redactor(raw); Process? child = null;
        try
        {
            using (var check = Process.Start(StartInfo(id, Configuration.CheckArgs(id, path)))!)
            {
                try { job.Assign(check); }
                catch { if (!check.HasExited) check.Kill(true); throw; }
                var stdout = check.StandardOutput.ReadToEndAsync(ct); var stderr = check.StandardError.ReadToEndAsync(ct);
                using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct); limit.CancelAfter(TimeSpan.FromSeconds(15));
                try { await check.WaitForExitAsync(limit.Token); }
                catch { if (!check.HasExited) check.Kill(true); throw; }
                var output = await stdout + await stderr;
                if (check.ExitCode != 0)
                { AddLog(redact(output.Trim())); throw new InvalidOperationException("线路配置校验失败，原连接已保留。请重新导入或更新配置。"); }
            }
            ct.ThrowIfCancellationRequested();
            child = Process.Start(StartInfo(id, Configuration.RunArgs(id, path)))!;
            job.Assign(child);
            child.OutputDataReceived += (_, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) AddLog(redact(e.Data)); };
            child.ErrorDataReceived += (_, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) AddLog(redact(e.Data)); };
            child.BeginOutputReadLine(); child.BeginErrorReadLine();
            for (int i = 0; i < 100; i++)
            {
                ct.ThrowIfCancellationRequested();
                if (child.HasExited) throw new InvalidOperationException("代理核心启动失败，请查看诊断详情。");
                try { using var tcp = new TcpClient(); await tcp.ConnectAsync("127.0.0.1", port, ct); return new(id, port, child, path); }
                catch (SocketException) { await Task.Delay(100, ct); }
            }
            throw new InvalidOperationException("代理核心未能及时就绪，未改动系统代理。");
        }
        catch
        {
            if (child != null) { try { if (!child.HasExited) child.Kill(true); } catch { } child.Dispose(); }
            try { File.Delete(path); } catch { }
            throw;
        }
    }
    private static async Task Stop(Running? item)
    {
        if (item == null) return;
        try
        {
            if (!item.Process.HasExited) { item.Process.Kill(true); using var limit = new CancellationTokenSource(4000); await item.Process.WaitForExitAsync(limit.Token); }
        }
        catch { }
        finally { item.Process.Dispose(); try { File.Delete(item.Config); } catch { } }
    }
    private static void Require(Health health, string id, JsonObject raw)
    {
        if (!health.InternetOk)
        {
            if (id == "racknerd")
            {
                var node = Configuration.RacknerdOutbound(raw);
                throw new InvalidOperationException($"RackNerd 连通检测失败（{node["server"]}:{node["server_port"] ?? JsonValue.Create(22)}）。原连接已保留，可选择 ResearchLab 或 Clash。");
            }
            throw new InvalidOperationException("线路未通过外网连通检测。请检查网络或换其他线路；原连接已保留。");
        }
        if (id == "racknerd")
        {
            var server = Configuration.RacknerdOutbound(raw)["server"]!.ToString();
            if (System.Net.IPAddress.TryParse(server, out _) && health.ExitIp != server) throw new InvalidOperationException("RackNerd 实际出口与预期不符，已取消接管。");
        }
    }
    public async Task Connect(string id, JsonObject? testOverride = null)
    {
        await gate.WaitAsync(lifetime.Token);
        using var operation = BeginOperation(); var ct = operation.Token;
        Running? candidate = null;
        try
        {
            var previousHealth = State.Health;
            Set(new(current == null ? "connecting" : "switching", id, "正在启动线路并验证实际出口…", previousHealth));
            if (testOverride == null && !store.Has(id)) throw new InvalidOperationException($"尚未导入 {ProfileStore.Name(id)} 配置，请在“更多”中导入。");
            var raw = testOverride ?? store.Load(id);
            candidate = await Candidate(id, raw, ct);
            var health = await Probe(id, candidate.Port, ct); Require(health, id, raw); ct.ThrowIfCancellationRequested();
            if (candidate.Process.HasExited) throw new InvalidOperationException("线路验证后核心已退出，已取消接管。");
            var old = current;
            proxy.Apply(candidate.Port, candidate.Config);
            current = candidate; candidate = null;
            Set(new("connected", id, "连接已验证，系统代理已接管。", health));
            SetSourceStatus(id, "可用");
            AddLog($"{ProfileStore.Name(id)} 连接成功，出口 {health.ExitIp}。");
            await Stop(old);
        }
        catch (Exception e)
        {
            await Stop(candidate);
            var message = e is OperationCanceledException ? "操作已取消。" : e is InvalidOperationException ? e.Message : "连接未完成，请检查配置和网络。";
            AddLog(message);
            Set(current != null ? new(OwnedPhase, current.Id, $"切换未完成，已保留 {ProfileStore.Name(current.Id)} 线路。{message}", State.Health, State.RequestedRegion)
                : new("error", id, message));
            throw new InvalidOperationException(message);
        }
        finally { activeOperation = null; gate.Release(); }
    }
    public async Task Diagnose(string? profile = null)
    {
        await gate.WaitAsync(lifetime.Token);
        using var operation = BeginOperation(); var ct = operation.Token;
        var before = State;
        try
        {
            if (current == null)
            {
                if ((profile ?? State.Profile) != "racknerd")
                {
                    Set(new("disconnected", profile ?? State.Profile, "尚未连接，请先连接所选线路。")); return;
                }
                var school = await Connectivity.School(ct, store.Policy);
                Set(new("disconnected", "racknerd", school.Detail, new Health(false, "", school.Ok, school.Detail, 0, DateTimeOffset.Now, true))); return;
            }
            Set(State with { Phase = "checking", Message = "正在检查线路与出口…" });
            var health = await Probe(current.Id, current.Port, ct);
            Set(new(OwnedPhase, current.Id,
                !proxy.IsOwned ? ExternalMessage() : !proxy.BypassMatches ? "线路正在工作，但系统绕行规则已被其他软件修改。" : health.InternetOk ? "线路检测完成。" : "线路外网检测未通过，可尝试其他线路。", health, before.RequestedRegion));
        }
        catch
        {
            Set(before with { Message = "检测未完成，当前连接保持运行。" });
            throw new InvalidOperationException("检测未完成，请稍后重试。");
        }
        finally { activeOperation = null; gate.Release(); }
    }
    public async Task UpdateResearchLab(Func<Uri, CancellationToken, Task<string>>? downloadOverride = null)
    {
        await gate.WaitAsync(lifetime.Token); Running? candidate = null;
        using var operation = BeginOperation(); var ct = operation.Token;
        var before = State;
        try
        {
            var url = store.Subscription ?? throw new InvalidOperationException("没有导入订阅地址，请从原配置重新导入。");
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != "https") throw new InvalidOperationException("订阅地址格式不正确。");
            Set(before with { Phase = "updating", Message = "正在更新并试连ResearchLab 线路，当前连接继续工作…" });
            using var handler = new HttpClientHandler();
            if (current != null) handler.Proxy = new System.Net.WebProxy($"socks5://127.0.0.1:{current.Port}");
            using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(25), MaxResponseContentBufferSize = 4_000_000 };
            var body = downloadOverride == null ? await client.GetStringAsync(uri, ct) : await downloadOverride(uri, ct);
            var raw = ProfileStore.ParseYaml(body);
            candidate = await Candidate("researchlab", raw, ct);
            var health = await Probe("researchlab", candidate.Port, ct); Require(health, "researchlab", raw); ct.ThrowIfCancellationRequested();
            await Stop(candidate); candidate = null;
            store.Save("researchlab", raw);
            InvalidateRankings("配置已更新，请重测");
            Set(before with { Message = "ResearchLab 线路已验证并更新，下次连接生效。" }); AddLog("ResearchLab 线路订阅更新成功，原活动连接保持运行。");
        }
        catch (Exception e)
        {
            Set(before with { Message = "ResearchLab 线路更新失败，已保留原配置与当前连接。" }); AddLog("ResearchLab 线路更新失败，原配置未覆盖。");
            AddLog(e is InvalidOperationException ? e.Message : e is HttpRequestException request ? $"订阅服务器连接失败，HTTP 状态：{request.StatusCode?.ToString() ?? "无响应"}。" : "更新中止原因：" + e.GetType().Name);
            throw new InvalidOperationException("ResearchLab 线路更新失败，已保留原配置与当前连接。");
        }
        finally { await Stop(candidate); activeOperation = null; gate.Release(); }
    }
    public async Task ImportClash(string file, CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(lifetime.Token);
        using var operation = BeginOperation();
        using var registration = cancellationToken.Register(operation.Cancel);
        var before = State; Running? candidate = null;
        try
        {
            if (current != null) throw new InvalidOperationException("请先断开连接，再导入 Clash 配置。");
            Set(before with { Phase = "importing", Message = "正在校验 Clash 节点与核心配置…" });
            var raw = ProfileStore.NormalizeClash(ProfileStore.ParseYaml(await File.ReadAllTextAsync(file, operation.Token)));
            candidate = await Candidate("clash", raw, operation.Token);
            await Stop(candidate); candidate = null; operation.Token.ThrowIfCancellationRequested();
            store.Save("clash", raw);
            InvalidateRankings("配置已更新，请重测");
            Set(before with { Message = "Clash 配置已导入，选择 Clash 后即可连接。" });
            AddLog($"Clash 已导入 {raw["proxies"]!.AsArray().Count} 个节点；连接时会验证实际出口。");
        }
        catch (Exception e)
        {
            Set(before with { Message = "Clash 导入未完成，已保留原配置。" });
            AddLog(e is InvalidOperationException ? e.Message : "Clash 导入失败：" + e.GetType().Name);
            throw new InvalidOperationException("Clash 导入未完成，请确认 YAML 包含有效节点；原配置已保留。");
        }
        finally { await Stop(candidate); activeOperation = null; gate.Release(); }
    }
    public async Task Disconnect()
    {
        Interlocked.Increment(ref recoveryRevision);
        try { recoveryOperation?.Cancel(); } catch (ObjectDisposedException) { }
        await gate.WaitAsync();
        try
        {
            Set(State with { Phase = "disconnecting", Message = "正在恢复原系统代理…" });
            string message;
            try { message = proxy.Restore(); }
            catch
            {
                var failed = current; current = null; await Stop(failed);
                Set(new("error", State.Profile, "核心已停止，但系统代理恢复失败，请在 Windows 代理设置中检查。"));
                throw new InvalidOperationException(State.Message);
            }
            var old = current; current = null; await Stop(old);
            Set(new("disconnected", State.Profile, message == "" ? "已断开，可重新选择线路。" : message)); AddLog(State.Message);
        }
        finally { gate.Release(); }
    }
    public void CancelPending() => lifetime.Cancel();
    private async Task Monitor()
    {
        try
        {
            while (!lifetime.IsCancellationRequested)
            {
                await Task.Delay(1000, lifetime.Token);
                try { if (current?.Process.HasExited == true) activeOperation?.Cancel(); }
                catch (ObjectDisposedException) { }
                catch (InvalidOperationException) { }
                await gate.WaitAsync(lifetime.Token);
                try
                {
                    if (current != null && current.Process.HasExited)
                    {
                        var id = current.Id; proxy.Restore(); var old = current; current = null; await Stop(old);
                        Set(new("error", id, "代理核心意外退出，已恢复原网络。点击连接可重试。")); AddLog(State.Message);
                    }
                    else if (current != null && !State.Busy)
                    {
                        string phase = OwnedPhase;
                        string? message = phase == "external" ? ExternalMessage() : null;
                        if (State.Phase != phase || message != null && State.Message != message)
                            Set(State with { Phase = phase, Message = message ?? (phase == "modified" ? "线路正在工作，但系统绕行规则已被其他软件修改。" : "系统代理已恢复由 VPN 接管。") });
                    }
                }
                catch (Exception) { AddLog("状态检查未完成，将继续检查。"); }
                finally { gate.Release(); }
            }
        }
        catch (OperationCanceledException) { }
    }
    public async ValueTask DisposeAsync()
    {
        System.Net.NetworkInformation.NetworkChange.NetworkAddressChanged -= OnAgyNetworkChange;
        lifetime.Cancel();
        try { await Task.WhenAll(monitor, agyMonitor, latencyMonitor); } catch (OperationCanceledException) { }
        await WaitForLatencyShutdown();
        await StopRegionScans();
        try { await Disconnect(); }
        finally
        {
            if (codexEndpoint != null) { await codexEndpoint.DisposeAsync(); codexEndpoint = null; codexTargetPort = null; }
            await DisconnectAgy();
            agyGate.Dispose(); candidateGate.Dispose();
            job.Dispose(); lifetime.Dispose(); gate.Dispose();
        }
    }
}
