namespace CampusLink;

public sealed record RegionLatencyRow(string Code, string Country, long? Milliseconds, string Status, string Source)
{
    public string Delay => Milliseconds is long ms ? $"{ms} ms" : Status;
}
internal sealed record LineBenchmark(string Key, string? Country, string? Hint, string Profile, long? Milliseconds, DateTimeOffset CheckedAt, int Epoch)
{
    internal bool Fresh(int epoch, DateTimeOffset now) => Epoch == epoch && Milliseconds.HasValue && Country != null &&
        CheckedAt <= now && now - CheckedAt <= TimeSpan.FromMinutes(5);
}

public sealed partial class ConnectionService
{
    private readonly object rankingSync = new();
    private readonly SemaphoreSlim candidateGate = new(1, 1);
    private Task rankingTask = Task.CompletedTask;
    private CancellationTokenSource? rankingOperation;
    private Dictionary<string, LineBenchmark> lineBenchmarks = new();
    private RegionLatencyRow[] rankingRows = Array.Empty<RegionLatencyRow>();
    private int rankingBusy;
    private int rankingVersion;
    private string rankingStatus = "尚未测速";
    public bool RankingBusy => Volatile.Read(ref rankingBusy) != 0;
    public IReadOnlyList<RegionLatencyRow> RegionLatencies => Volatile.Read(ref rankingRows);
    public string RankingStatus => Volatile.Read(ref rankingStatus);
    public event Action? RankingsChanged;
    internal string? CurrentLineKey => currentLineKey;

    internal LineBenchmark[] FreshBenchmarks()
    {
        var allowed = ProfileStore.Ids.SelectMany(ReadSource).Select(PreferencesStore.LineKey).ToHashSet();
        lock (rankingSync)
        {
            int epoch = Volatile.Read(ref networkEpoch); var now = DateTimeOffset.UtcNow;
            return lineBenchmarks.Values.Where(m => allowed.Contains(m.Key) && m.Fresh(epoch, now)).OrderBy(m => m.Milliseconds).ThenBy(m => m.Key).ToArray();
        }
    }
    public Task MeasureRegions(CancellationToken ct = default)
        => StartRegionScan(false, ct);

    private Task StartRegionScan(bool quick, CancellationToken ct)
    {
        lock (rankingSync)
        {
            if (!rankingTask.IsCompleted) return rankingTask;
            lifetime.Token.ThrowIfCancellationRequested(); ct.ThrowIfCancellationRequested();
            rankingOperation?.Dispose();
            rankingOperation = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token, ct);
            int version = ++rankingVersion, epoch = Volatile.Read(ref networkEpoch);
            var lines = ProfileStore.Ids.SelectMany(ReadSource).GroupBy(PreferencesStore.LineKey).Select(g => g.First()).ToArray();
            if (quick)
            {
                Preferences.Value.LastLines.TryGetValue(ExitCatalog.Auto, out var remembered);
                // Sample different sources/regions before trying every sibling of one region.
                lines = lines.GroupBy(l => (l.Profile, l.Country)).SelectMany(group => group
                    .OrderBy(l => PreferencesStore.LineKey(l) == remembered ? 0 : 1).ThenBy(l => l.Priority)
                    .Select((line, round) => (line, round)))
                    .OrderBy(item => PreferencesStore.LineKey(item.line) == remembered ? -1 : item.round)
                    .ThenBy(item => item.line.Priority).Select(item => item.line).ToArray();
            }
            Volatile.Write(ref rankingBusy, 1);
            var token = rankingOperation.Token;
            rankingTask = Task.Run(() => ScanRegions(lines, version, epoch, quick, token));
            return rankingTask;
        }
    }
    public void CancelRegionScan()
    {
        lock (rankingSync) { try { rankingOperation?.Cancel(); } catch (ObjectDisposedException) { } }
    }
    internal void InvalidateRankings(string reason = "网络已变化，请重测")
    {
        lock (rankingSync)
        {
            rankingVersion++;
            try { rankingOperation?.Cancel(); } catch (ObjectDisposedException) { }
            lineBenchmarks = new();
            rankingRows = rankingRows.Select(row => row with { Milliseconds = null, Status = "需重测", Source = "" }).ToArray();
            rankingStatus = rankingRows.Length == 0 ? "尚未测速" : reason;
        }
        RankingsChanged?.Invoke();
    }
    private async Task<LineBenchmark> BenchmarkLine(ExitCatalog.CandidateLine line, int epoch, CancellationToken ct)
    {
        Running? candidate = null;
        string? observedCountry = null;
        using var attempt = CancellationTokenSource.CreateLinkedTokenSource(ct);
        attempt.CancelAfter(TimeSpan.FromSeconds(8));
        try
        {
            candidate = await Candidate(line.Profile, line.Raw, attempt.Token);
            var health = await VerifyRegion(candidate, attempt.Token);
            observedCountry = health?.Country;
            if (health != null)
            {
                var sample = await MeasureNormalLatency(candidate.Port, attempt.Token);
                if (sample.Milliseconds is long ms && !candidate.Process.HasExited)
                    return new(PreferencesStore.LineKey(line), health.Country, line.Country, line.Profile, ms, DateTimeOffset.UtcNow, epoch);
            }
        }
        catch (Exception e) when (!ct.IsCancellationRequested && CandidateFailure(e)) { }
        finally { await Stop(candidate); }
        ct.ThrowIfCancellationRequested();
        return new(PreferencesStore.LineKey(line), observedCountry, line.Country, line.Profile, null, DateTimeOffset.UtcNow, epoch);
    }
    internal static RegionLatencyRow[] BuildRankingRows(IEnumerable<ExitCatalog.CandidateLine> lines, IEnumerable<LineBenchmark> results, bool finished)
    {
        var all = lines.ToArray(); var measured = results.ToArray();
        bool unresolved = all.Any(l => l.Country == null && !measured.Any(m => m.Key == PreferencesStore.LineKey(l) && m.Country != null));
        var codes = all.Select(l => l.Country).OfType<string>().Concat(measured.Select(m => m.Country).OfType<string>())
            .Concat(unresolved ? new[] { "unknown" } : Array.Empty<string>()).Distinct();
        return codes.Select(code =>
        {
            var best = measured.Where(m => m.Country == code && m.Milliseconds.HasValue).OrderBy(m => m.Milliseconds).FirstOrDefault();
            bool completed = all.Where(l => (l.Country ?? "unknown") == code).All(l => measured.Any(m => m.Key == PreferencesStore.LineKey(l)));
            string status = completed ? "未测通" : finished ? "未完成" : "待测";
            return new RegionLatencyRow(code, code == "unknown" ? "未识别地区" : ExitCatalog.Name(code), best?.Milliseconds,
                best != null ? "已测" : status, best == null ? "" : ProfileStore.Name(best.Profile));
        }).OrderBy(row => row.Milliseconds ?? long.MaxValue).ThenBy(row => row.Country).ToArray();
    }
    private async Task ScanRegions(ExitCatalog.CandidateLine[] lines, int version, int epoch, bool quick, CancellationToken ct)
    {
        var results = new Dictionary<string, LineBenchmark>();
        // A manual rescan must not erase still-valid successes while probes are pending.
        var retained = FreshBenchmarks().ToDictionary(m => m.Key);
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
        budget.CancelAfter(quick ? TimeSpan.FromSeconds(24) : TimeSpan.FromMinutes(2));
        bool complete = false;
        void Publish(bool finished)
        {
            lock (rankingSync)
            {
                if (rankingVersion != version || epoch != Volatile.Read(ref networkEpoch)) return;
                lineBenchmarks = new(retained);
                foreach (var result in results.Values) lineBenchmarks[result.Key] = result;
                rankingRows = BuildRankingRows(lines, lineBenchmarks.Values, finished);
                rankingStatus = quick ? !finished ? "正在筛选可用线路…" : results.Values.Any(m => m.Milliseconds.HasValue)
                    ? "快速筛选完成" : "快速筛选结束" : !finished ? $"测速中 {results.Count} / {lines.Length}" : complete
                    ? $"已测 {results.Count} / {lines.Length} · {DateTime.Now:HH:mm}"
                    : $"已停止 {results.Count} / {lines.Length}";
            }
            RankingsChanged?.Invoke(); SourcesChanged?.Invoke();
        }
        try
        {
            Publish(false);
            await Parallel.ForEachAsync(lines, new ParallelOptions { MaxDegreeOfParallelism = 3, CancellationToken = budget.Token }, async (line, token) =>
            {
                var result = await BenchmarkLine(line, epoch, token);
                lock (rankingSync) { results[result.Key] = result; Publish(false); }
            });
            complete = true;
        }
        catch (OperationCanceledException) when (budget.IsCancellationRequested) { }
        catch (Exception e) { AddLog("地区测速未完成：" + e.GetType().Name); }
        finally
        {
            Publish(true);
            Volatile.Write(ref rankingBusy, 0);
            RankingsChanged?.Invoke();
        }
    }
    private async Task<LineBenchmark[]> EnsureAutoBenchmarks(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var measured = FreshBenchmarks();
        if (measured.Length != 0) return measured;

        Task scan; bool ownsScan; int version;
        lock (rankingSync)
        {
            ownsScan = rankingTask.IsCompleted;
            scan = StartRegionScan(true, ct);
            version = rankingVersion;
        }
        try
        {
            // Do not wait for the slowest node or an entire manual scan. Allow a short
            // comparison window after the first success, then choose its lowest latency.
            var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            void Observe()
            {
                if (FreshBenchmarks().Length != 0) ready.TrySetResult();
            }
            RankingsChanged += Observe;
            try
            {
                Observe();
                using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct);
                var deadline = Task.Delay(TimeSpan.FromSeconds(24), limit.Token);
                await Task.WhenAny(scan, ready.Task, deadline).WaitAsync(ct);
                limit.Cancel();
                if (ready.Task.IsCompleted)
                    await Task.WhenAny(scan, Task.Delay(500, ct)).WaitAsync(ct);
            }
            finally { RankingsChanged -= Observe; }
            ct.ThrowIfCancellationRequested();
            measured = FreshBenchmarks();
        }
        finally
        {
            // Only stop the short scan started by this connection. A user-requested
            // full scan has its own lifecycle and must continue independently.
            if (ownsScan)
            {
                lock (rankingSync)
                    if (rankingVersion == version) rankingOperation?.Cancel();
                await scan;
            }
        }
        ct.ThrowIfCancellationRequested();
        if (measured.Length == 0) throw new InvalidOperationException("暂无可用的延迟实测结果，请检查网络后重新测速。");
        return measured;
    }
    public void CancelConnection()
    {
        try { activeOperation?.Cancel(); } catch (ObjectDisposedException) { }
    }
    private async Task StopRegionScans()
    {
        Task task; lock (rankingSync) task = rankingTask;
        await task;
        lock (rankingSync) { rankingOperation?.Dispose(); rankingOperation = null; }
    }
}
