using System.Collections.Concurrent;
using System.Net.Http;

namespace CampusLink;

public sealed partial class ConnectionService
{
    private readonly ConcurrentDictionary<string, string> sourceStatuses = new();
    private readonly ConcurrentDictionary<string, byte> discoveredCountries = new();
    public event Action? SourcesChanged;
    internal string SourceStatus(string id) => sourceStatuses.TryGetValue(id, out var label) ? label : store.Has(id) ? "未检测" : "未导入";

    private void SetSourceStatus(string id, string label)
    {
        sourceStatuses[id] = label;
        SourcesChanged?.Invoke();
    }

    private ExitCatalog.CandidateLine[] ReadSource(string profile)
    {
        if (!store.Has(profile)) return Array.Empty<ExitCatalog.CandidateLine>();
        try { return ExitCatalog.Read(profile, store.Load(profile)).ToArray(); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or System.Security.Cryptography.CryptographicException)
        { return Array.Empty<ExitCatalog.CandidateLine>(); }
    }

    internal IReadOnlyList<ExitOption> GetExitOptions()
    {
        var codes = ProfileStore.Ids.SelectMany(ReadSource).Select(l => l.Country).OfType<string>()
            .Concat(discoveredCountries.Keys).Distinct(StringComparer.Ordinal);
        var measured = FreshBenchmarks().GroupBy(m => m.Country!).ToDictionary(g => g.Key, g => g.Min(m => m.Milliseconds!.Value));
        codes = codes.Concat(measured.Keys).Distinct();
        return new[] { new ExitOption(ExitCatalog.Auto, ExitCatalog.Name(ExitCatalog.Auto)) }
            .Concat(codes.OrderBy(c => measured.TryGetValue(c, out var ms) ? ms : long.MaxValue).ThenBy(c => c == "US" ? 0 : 1)
                .ThenBy(ExitCatalog.Name).Select(c => new ExitOption(c, ExitCatalog.Name(c) +
                    (measured.TryGetValue(c, out var ms) ? $" · {ms} ms" : "")))).ToArray();
    }

    private async Task<Health?> VerifyRegion(Running candidate, CancellationToken ct)
    {
        if (probe != null)
        {
            var simulated = await probe(candidate.Port, ct);
            return simulated.InternetOk && !candidate.Process.HasExited ? simulated : null;
        }
        var clock = Stopwatch.StartNew();
        var exitTask = ExitCatalog.Verify(candidate.Port, ct);
        var schoolTask = candidate.Id == "racknerd" ? Connectivity.School(ct, store.Policy) : Task.FromResult((Ok: false, Detail: ""));
        await Task.WhenAll(exitTask, schoolTask);
        if (exitTask.Result is not { } exit || candidate.Process.HasExited) return null;
        var school = schoolTask.Result;
        if (discoveredCountries.TryAdd(exit.Country, 0)) SourcesChanged?.Invoke();
        return new Health(true, exit.Ip, school.Ok, school.Detail, clock.ElapsedMilliseconds, DateTimeOffset.Now,
            candidate.Id == "racknerd", exit.Country);
    }

    private static bool CandidateFailure(Exception e) => e is IOException or HttpRequestException or InvalidOperationException or
        System.ComponentModel.Win32Exception or OperationCanceledException or System.Net.Sockets.SocketException;

    internal async Task<Health> ConnectRegion(string region, bool verifyOnly = false, bool automaticRecovery = false, int revision = 0, int epoch = 0, CancellationToken cancellation = default)
    {
        await gate.WaitAsync(lifetime.Token);
        using var operation = BeginOperation(cancellation);
        var ct = operation.Token;
        var before = State;
        Running? candidate = null;
        try
        {
            ct.ThrowIfCancellationRequested();
            if (automaticRecovery)
            {
                if (revision != Volatile.Read(ref recoveryRevision) || epoch != Volatile.Read(ref networkEpoch) ||
                    !Preferences.Value.AutoRecover || current == null || before.Busy || before.Health?.Country == null || OwnedPhase != "connected")
                    throw new OperationCanceledException();
                recoveryOperation = operation;
            }
            else if (!verifyOnly)
            {
                Interlocked.Increment(ref recoveryRevision);
                recoverySchedule.Reset();
            }
            string targetRegion = automaticRecovery ? before.Health?.Country ?? region : region;
            Set(before with { Phase = automaticRecovery ? "recovering" : current == null ? "connecting" : "switching",
                Message = automaticRecovery ? "正在恢复连接，可随时断开。" : $"正在验证{(region == ExitCatalog.Auto ? "可用" : ExitCatalog.Name(region))}出口…" });
            Preferences.Value.LastLines.TryGetValue(region, out var remembered);
            bool chooseByLatency = targetRegion == ExitCatalog.Auto && !automaticRecovery;
            var measured = chooseByLatency ? await EnsureAutoBenchmarks(ct) : FreshBenchmarks();
            var scores = measured.ToDictionary(m => m.Key);
            int selectionEpoch = chooseByLatency ? measured[0].Epoch : Volatile.Read(ref networkEpoch);
            var all = ProfileStore.Ids.SelectMany(ReadSource);
            var choices = all.Where(l =>
                chooseByLatency || targetRegion == ExitCatalog.Auto ||
                    l.Country == targetRegion || l.Country == null || scores.TryGetValue(PreferencesStore.LineKey(l), out var score) && score.Country == targetRegion)
                .OrderBy(l => chooseByLatency ? scores.ContainsKey(PreferencesStore.LineKey(l)) ? 0 : 1 : automaticRecovery && PreferencesStore.LineKey(l) == currentLineKey ? 0 :
                    scores.ContainsKey(PreferencesStore.LineKey(l)) ? 1 : PreferencesStore.LineKey(l) == remembered ? 2 : 3)
                .ThenBy(l => scores.TryGetValue(PreferencesStore.LineKey(l), out var score) ? score.Milliseconds!.Value : long.MaxValue)
                .ThenBy(l => l.Country == targetRegion ? 0 : 1).ThenBy(l => l.Priority).ToArray();
            var search = Stopwatch.StartNew();
            foreach (var line in choices)
            {
                ct.ThrowIfCancellationRequested();
                var remaining = TimeSpan.FromSeconds(48) - search.Elapsed;
                if (remaining <= TimeSpan.Zero) break;
                using var attempt = CancellationTokenSource.CreateLinkedTokenSource(ct);
                attempt.CancelAfter(remaining < TimeSpan.FromSeconds(8) ? remaining : TimeSpan.FromSeconds(8));
                Health? health;
                LatencySample? verifiedLatency = null;
                try
                {
                    candidate = await Candidate(line.Profile, line.Raw, attempt.Token);
                    health = await VerifyRegion(candidate, attempt.Token);
                    if ((automaticRecovery || chooseByLatency) && health != null)
                    {
                        verifiedLatency = await MeasureNormalLatency(candidate.Port, attempt.Token);
                        if (verifiedLatency.Milliseconds == null) health = null;
                    }
                    if (health != null) SetSourceStatus(line.Profile, "可用");
                    else if (SourceStatus(line.Profile) == "未检测") SetSourceStatus(line.Profile, "未测通");
                }
                catch (Exception e) when (!ct.IsCancellationRequested && CandidateFailure(e))
                {
                    health = null;
                    if (SourceStatus(line.Profile) == "未检测") SetSourceStatus(line.Profile, "未测通");
                }
                if (candidate != null && health != null && MatchesRegion(targetRegion, health.Country))
                {
                    ct.ThrowIfCancellationRequested();
                    if (chooseByLatency && selectionEpoch != Volatile.Read(ref networkEpoch))
                        throw new InvalidOperationException("网络已变化，请重新连接并测速。");
                    if (verifyOnly) { Set(before); return health; }
                    if (automaticRecovery && (revision != Volatile.Read(ref recoveryRevision) || epoch != Volatile.Read(ref networkEpoch) ||
                        !Preferences.Value.AutoRecover || OwnedPhase != "connected")) throw new OperationCanceledException();
                    proxy.Apply(candidate.Port, candidate.Config);
                    var old = current;
                    current = candidate;
                    candidate = null;
                    currentLineKey = PreferencesStore.LineKey(line);
                    if (chooseByLatency && verifiedLatency?.Milliseconds is long ms)
                    {
                        lock (rankingSync)
                            lineBenchmarks[currentLineKey] = new(currentLineKey, health.Country, line.Country, line.Profile,
                                ms, DateTimeOffset.UtcNow, selectionEpoch);
                    }
                    recoverySchedule.Reset();
                    try { Preferences.Remember(region, currentLineKey); }
                    catch (Exception e) when (e is IOException or UnauthorizedAccessException) { AddLog("无法记住上次线路，当前连接不受影响。"); }
                    Set(new("connected", line.Profile, automaticRecovery ? "网络连接已恢复。" : "已验证实际出口。", health, region));
                    AddLog($"{ProfileStore.Name(line.Profile)} 连接成功：{ExitCatalog.Name(health.Country)} · {health.ExitIp}。");
                    await Stop(old);
                    return health;
                }
                await Stop(candidate); candidate = null;
            }
            throw new InvalidOperationException(region == ExitCatalog.Auto ? "暂未测通任何线路，请检测线路状态。"
                : $"未找到可用的{ExitCatalog.Name(region)}出口。");
        }
        catch (Exception e)
        {
            var message = e is OperationCanceledException ? "操作已取消。" : e is InvalidOperationException ? e.Message : "连接未完成，请查看诊断。";
            if (automaticRecovery && e is OperationCanceledException)
                Set(before with { Phase = OwnedPhase });
            else
            {
                if (automaticRecovery) recoverySchedule.Attempt(DateTimeOffset.UtcNow);
                Set(current != null ? before with { Phase = OwnedPhase, Message = automaticRecovery
                    ? "暂未恢复连接，将稍后重试；可点击重新连接或从托盘断开。" : $"已保留原连接。{message}" }
                    : new("error", before.Profile, message));
                AddLog(message);
            }
            if (e is OperationCanceledException && cancellation.IsCancellationRequested) throw;
            throw new InvalidOperationException(message);
        }
        finally { await Stop(candidate); recoveryOperation = null; activeOperation = null; gate.Release(); }
    }

    internal static bool MatchesRegion(string requested, string? verified) =>
        verified != null && (requested == ExitCatalog.Auto || requested == verified);

    internal async Task CheckSources()
    {
        await gate.WaitAsync(lifetime.Token);
        using var operation = BeginOperation();
        var before = State;
        try
        {
            Set(before with { Phase = "checking", Message = "正在检测线路来源…" });
            foreach (var id in ProfileStore.Ids)
            {
                var lines = ReadSource(id).GroupBy(l => l.Country ?? "").Select(g => g.OrderBy(l => l.Priority).First()).Take(2).ToArray();
                if (lines.Length == 0) { SetSourceStatus(id, store.Has(id) ? "配置不可用" : "未导入"); continue; }
                SetSourceStatus(id, "检测中");
                bool available = false;
                foreach (var line in lines)
                {
                    Running? candidate = null;
                    using var attempt = CancellationTokenSource.CreateLinkedTokenSource(operation.Token);
                    attempt.CancelAfter(TimeSpan.FromSeconds(6));
                    try
                    {
                        candidate = await Candidate(id, line.Raw, attempt.Token);
                        available = await VerifyRegion(candidate, attempt.Token) != null;
                    }
                    catch (Exception e) when (!operation.IsCancellationRequested && CandidateFailure(e)) { }
                    finally { await Stop(candidate); }
                    if (available) break;
                }
                SetSourceStatus(id, available ? "可用" : "未测通");
            }
        }
        finally
        {
            var restored = before with { Phase = current == null ? before.Phase : OwnedPhase, Message = "线路来源检测结束。" };
            Set(restored);
            activeOperation = null; gate.Release();
        }
    }
}
