using System.Collections.Concurrent;

namespace CampusLink;

internal static class BenchmarkTests
{
    private sealed class Proxy(bool allowApply) : ISystemProxy
    {
        internal int Applies;
        public bool IsOwned => allowApply;
        public bool BypassMatches => true;
        public void ProtectLifetime() { }
        public void Apply(int port, params string[] files)
        {
            if (!allowApply) throw new InvalidOperationException("Read-only benchmark attempted proxy takeover");
            Interlocked.Increment(ref Applies);
        }
        public string Restore() => "";
    }
    private static void Require(bool ok, string message) { if (!ok) throw new InvalidOperationException(message); }
    internal static async Task<int> Run(string report, int basePort, int relayPort)
    {
        var checks = new List<string>(); string? error = null; ConnectionService? service = null;
        var baseline = ProxySnapshot.Read(); var effective = ProxySnapshot.ReadEffective();
        var root = Path.Combine(Paths.Runtime, "benchmark-test-" + Guid.NewGuid().ToString("N")); Paths.PrivateDirectory(root);
        try
        {
            var now = DateTimeOffset.UtcNow;
            var valid = new LineBenchmark("fixture", "JP", "JP", "clash", 80, now.AddSeconds(-5), 3);
            Require(valid.Fresh(3, now) && !valid.Fresh(4, now) && !(valid with { CheckedAt = now.AddMinutes(-6) }).Fresh(3, now) &&
                !(valid with { CheckedAt = now.AddSeconds(5) }).Fresh(3, now) && !(valid with { Milliseconds = null }).Fresh(3, now), "Stale, future, failed or other-network score is reused");
            checks.Add("only-recent-successes-from-same-network-are-selectable");
            var store = new ProfileStore(root);
            File.WriteAllText(Path.Combine(root, "policy.json"), new ProfileStore().Policy.ToJsonString());
            var nodes = new JsonArray();
            foreach (string name in new[] { "美国 One", "美国 Two", "德国 Three", "日本 Four" })
                nodes.Add(new JsonObject { ["name"] = name, ["type"] = "socks5", ["server"] = "127.0.0.1", ["port"] = 9 });
            var raw = ProfileStore.NormalizeClash(new JsonObject { ["proxies"] = nodes }); store.Save("clash", raw);
            var lines = ExitCatalog.Read("clash", raw).ToArray();
            var preferences = new PreferencesStore(Path.Combine(root, "preferences.json")); preferences.Update(p => p with { AutoRecover = false });
            preferences.Remember(ExitCatalog.Auto, PreferencesStore.LineKey(lines[0]));
            var proxy = new Proxy(true);
            var timings = new ConcurrentDictionary<int, (string Country, long Ms)>();
            int mode = 0, index = 0, active = 0, maximum = 0;
            string selectionCountry = "US";
            TaskCompletionSource? started = null;
            async Task<Health> Probe(int port, CancellationToken ct)
            {
                if (mode == 2) { started!.TrySetResult(); await Task.Delay(Timeout.Infinite, ct); }
                if (mode == 1)
                {
                    int item = Interlocked.Increment(ref index) - 1;
                    var values = new[] { ("US", 900L), ("DE", 220L), ("JP", 80L), ("US", 600L) };
                    timings[port] = values[item % values.Length];
                    int concurrent = Interlocked.Increment(ref active);
                    maximum = Math.Max(maximum, concurrent);
                    try { await Task.Delay(250, ct); } finally { Interlocked.Decrement(ref active); }
                }
                else timings[port] = (selectionCountry, 100);
                return new(true, "8.8.8.8", false, "", 1, DateTimeOffset.Now, Country: timings[port].Country);
            }
            Task<LatencySample> Latency(int port, CancellationToken ct) => Task.FromResult(new LatencySample(timings.TryGetValue(port, out var value) ? value.Ms : 100, DateTimeOffset.Now));
            service = new(store, basePort, Probe, Path.Combine(root, "agy.txt"), preferences, proxy, Latency) { OrdinaryRelayPort = relayPort };
            await service.ConnectRegion("US"); int? original = service.CurrentPid;
            mode = 1;
            var scan = service.MeasureRegions();
            Require(ReferenceEquals(scan, service.MeasureRegions()), "Repeated scan starts duplicate core batches");
            await scan.WaitAsync(TimeSpan.FromSeconds(25));
            Require(index == lines.Length && maximum <= 3 && service.CurrentPid == original && proxy.Applies == 1,
                "Benchmark skipped nodes, exceeded concurrency or replaced active connection");
            checks.Add("all-fixture-nodes-tested-with-bounded-concurrency-and-shared-scan-task");
            checks.Add("benchmark-keeps-existing-core-and-proxy-ownership");
            var ranked = service.RegionLatencies.Where(row => row.Milliseconds.HasValue).ToArray();
            Require(ranked.Length == 3 && ranked[0].Code == "JP" && ranked[0].Milliseconds == 80 && ranked[1].Code == "DE" && ranked[1].Milliseconds == 220 &&
                ranked[2].Code == "US" && ranked[2].Milliseconds == 600, "Countries are not grouped by verified exit and sorted by their lowest successful HTTPS latency");
            checks.Add("verified-countries-sorted-by-best-successful-https-result");
            var options = service.GetExitOptions();
            Require(options[0].Code == ExitCatalog.Auto && options[1].Code == "JP" && options[1].Label.Contains("80 ms"), "Exit picker lacks measured ordering and latency");
            checks.Add("country-picker-shows-latency-and-keeps-auto-first");
            var best = service.FreshBenchmarks().First(); selectionCountry = best.Country!; mode = 0;
            await service.ConnectRegion(ExitCatalog.Auto);
            Require(service.CurrentLineKey == best.Key && service.State.RequestedRegion == ExitCatalog.Auto && service.State.Health?.Country == "JP" && proxy.Applies == 2 && index == lines.Length,
                "Auto selection chose remembered/first node instead of lowest measured latency or needlessly rescanned");
            checks.Add("auto-selects-lowest-measured-line-over-remembered-node-and-reverifies-before-commit");
            var remaining = lines.First(line => PreferencesStore.LineKey(line) != best.Key);
            store.Save("clash", remaining.Raw);
            Require(service.FreshBenchmarks().All(score => score.Key != best.Key), "Deleted node is still selectable from cached scores");
            store.Save("clash", raw);
            service.InvalidateRankings("配置已更新，请重测");
            Require(service.FreshBenchmarks().Length == 0 && service.RegionLatencies.All(row => row.Milliseconds == null), "Updated profiles retain old latency scores");
            checks.Add("profile-changes-invalidate-scores-and-deleted-nodes-cannot-be-selected");
            service.NotifyNetworkChanged();
            Require(service.FreshBenchmarks().Length == 0 && service.RegionLatencies.All(row => row.Milliseconds == null), "Network change keeps old selectable scores");
            checks.Add("network-change-clears-ranking-values-and-selection-cache");
            original = service.CurrentPid;
            mode = 2; started = new(TaskCreationOptions.RunContinuationsAsynchronously);
            scan = service.MeasureRegions(); await started.Task.WaitAsync(TimeSpan.FromSeconds(10)); service.CancelRegionScan();
            await scan.WaitAsync(TimeSpan.FromSeconds(10));
            Require(!service.RankingBusy && service.CurrentPid == original && proxy.Applies == 2 && service.RegionLatencies.All(row => row.Milliseconds == null),
                "Cancelled scan switched active line or reported fabricated latency");
            checks.Add("scan-cancellation-preserves-current-line-and-does-not-fabricate-results");
            started = new(TaskCreationOptions.RunContinuationsAsynchronously);
            scan = service.MeasureRegions(); await started.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await service.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(10)); service = null;
            await scan;
            checks.Add("shutdown-cancels-and-cleans-independent-benchmark-cores");
            Require(ProxySnapshot.Read() == baseline && ProxySnapshot.ReadEffective() == effective, "Benchmark tests changed real Windows proxy");
            checks.Add("real-system-proxy-and-wininet-unchanged");
        }
        catch (Exception e) { error = e is InvalidOperationException ? e.Message : e.GetType().Name; }
        finally
        {
            if (service != null) await service.DisposeAsync();
            Directory.Delete(root, true);
            Paths.Atomic(report, JsonSerializer.Serialize(new { success = error == null, error, results = checks }, new JsonSerializerOptions { WriteIndented = true }));
        }
        return error == null ? 0 : 1;
    }
    internal static async Task<int> Live(string report)
    {
        var baseline = ProxySnapshot.Read(); var effective = ProxySnapshot.ReadEffective();
        var proxy = new Proxy(false);
        await using var service = new ConnectionService(new ProfileStore(), 11318, proxyController: proxy);
        void Write() => Paths.Atomic(report, JsonSerializer.Serialize(new
        {
            success = service.RegionLatencies.Any(row => row.Milliseconds.HasValue),
            status = service.RankingStatus, busy = service.RankingBusy, measuredAt = DateTimeOffset.Now,
            rows = service.RegionLatencies,
            systemProxyUnchanged = ProxySnapshot.Read() == baseline && ProxySnapshot.ReadEffective() == effective,
            proxyApplications = proxy.Applies
        }, new JsonSerializerOptions { WriteIndented = true }));
        service.RankingsChanged += Write;
        await service.MeasureRegions(); Write();
        return proxy.Applies == 0 && service.RegionLatencies.Any(row => row.Milliseconds.HasValue) &&
            ProxySnapshot.Read() == baseline && ProxySnapshot.ReadEffective() == effective ? 0 : 1;
    }
}
