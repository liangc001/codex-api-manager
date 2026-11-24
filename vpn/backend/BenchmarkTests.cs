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
            int mode = 0, index = 0, active = 0, maximum = 0, cancelledProbes = 0;
            string selectionCountry = "US";
            TaskCompletionSource? started = null, releaseProbe = null;
            async Task<Health> Probe(int port, CancellationToken ct)
            {
                if (mode == 7 && Interlocked.Increment(ref index) == 1)
                    return new(false, "", false, "", 0, DateTimeOffset.Now);
                if (mode == 2) { started!.TrySetResult(); await Task.Delay(Timeout.Infinite, ct); }
                if (mode is 3 or 4 or 5 or 6)
                {
                    int item = Interlocked.Increment(ref index) - 1;
                    if (mode == 3 && item == 0) await started!.Task.WaitAsync(ct);
                    if (mode == 6 && item == 0) await releaseProbe!.Task.WaitAsync(ct);
                    bool slow = mode == 3 ? service!.RankingBusy && item > 0 : mode == 6 ? item > 0 && item < lines.Length : item < 3;
                    if (slow)
                    {
                        if (mode is 3 or 5 || item == 2) started!.TrySetResult();
                        try { await Task.Delay(Timeout.Infinite, ct); }
                        finally { Interlocked.Increment(ref cancelledProbes); }
                    }
                }
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

            service.InvalidateRankings();
            mode = 3; index = 0; cancelledProbes = 0; started = new(TaskCreationOptions.RunContinuationsAsynchronously);
            var quickClock = Stopwatch.StartNew();
            await service.ConnectRegion(ExitCatalog.Auto).WaitAsync(TimeSpan.FromSeconds(12));
            Require(quickClock.Elapsed < TimeSpan.FromSeconds(6) && cancelledProbes > 0 && !service.RankingBusy && service.FreshBenchmarks().Length > 0,
                $"Quick auto: elapsed={quickClock.ElapsedMilliseconds}, cancelled={cancelledProbes}, busy={service.RankingBusy}, cached={service.FreshBenchmarks().Length}, probes={index}");
            checks.Add("cold-auto-connects-on-first-measured-success-and-cleans-slow-probes");

            mode = 4; index = 0; started = new(TaskCreationOptions.RunContinuationsAsynchronously);
            scan = service.MeasureRegions(); await started.Task.WaitAsync(TimeSpan.FromSeconds(10));
            Require(service.FreshBenchmarks().Length > 0, "Manual scan erased valid cached successes");
            await service.ConnectRegion(ExitCatalog.Auto).WaitAsync(TimeSpan.FromSeconds(5));
            Require(service.RankingBusy && !scan.IsCompleted, "Auto waited for or cancelled independent manual scan");
            service.CancelRegionScan(); await scan.WaitAsync(TimeSpan.FromSeconds(10));
            checks.Add("warm-auto-reuses-cache-without-waiting-or-cancelling-manual-scan");

            var cachedKey = service.FreshBenchmarks().First().Key;
            mode = 7; index = 0;
            await service.ConnectRegion(ExitCatalog.Auto).WaitAsync(TimeSpan.FromSeconds(10));
            Require(service.CurrentLineKey != cachedKey && index >= 2 && service.State.Health?.InternetOk == true,
                "A failed cached line prevented auto from trying unmeasured fallback lines");
            checks.Add("failed-cached-line-falls-back-to-another-verified-line");

            service.InvalidateRankings();
            mode = 6; index = 0; started = new(TaskCreationOptions.RunContinuationsAsynchronously);
            releaseProbe = new(TaskCreationOptions.RunContinuationsAsynchronously);
            scan = service.MeasureRegions(); await started.Task.WaitAsync(TimeSpan.FromSeconds(10));
            // A manually started scan has no usable results yet; the first completed
            // probe must unblock auto without waiting for its remaining slow siblings.
            Require(service.FreshBenchmarks().Length == 0, "Cold manual-scan fixture already has a cached success");
            var streamingConnection = service.ConnectRegion(ExitCatalog.Auto);
            releaseProbe.TrySetResult();
            await streamingConnection.WaitAsync(TimeSpan.FromSeconds(6));
            Require(service.RankingBusy && !scan.IsCompleted, "Auto waited for all pending manual probes");
            service.CancelRegionScan(); await scan;
            checks.Add("cold-auto-uses-streaming-manual-result-before-slow-siblings-finish");
            service.InvalidateRankings();
            mode = 5; index = 0; started = new(TaskCreationOptions.RunContinuationsAsynchronously);
            original = service.CurrentPid; int appliesBefore = proxy.Applies;
            var connection = service.ConnectRegion(ExitCatalog.Auto);
            await started.Task.WaitAsync(TimeSpan.FromSeconds(10)); service.CancelConnection();
            try { await connection.WaitAsync(TimeSpan.FromSeconds(10)); throw new InvalidOperationException("Cancelled auto unexpectedly connected"); }
            catch (InvalidOperationException e) when (e.Message.Contains("已取消")) { }
            Require(!service.RankingBusy && service.CurrentPid == original && proxy.Applies == appliesBefore,
                "Cancelling quick auto left probes running or changed the active proxy");
            checks.Add("quick-auto-cancellation-keeps-existing-connection-and-cleans-probes");

            service.InvalidateRankings();
            mode = 5; index = 0; started = new(TaskCreationOptions.RunContinuationsAsynchronously);
            connection = service.ConnectRegion(ExitCatalog.Auto);
            await started.Task.WaitAsync(TimeSpan.FromSeconds(10)); service.NotifyNetworkChanged();
            try { await connection.WaitAsync(TimeSpan.FromSeconds(10)); throw new InvalidOperationException("Changed-network auto unexpectedly connected"); }
            catch (InvalidOperationException e) when (!e.Message.Contains("unexpectedly")) { }
            Require(service.CurrentPid == original && proxy.Applies == appliesBefore && service.FreshBenchmarks().Length == 0,
                "Quick auto committed a result from an invalidated network");
            checks.Add("network-change-prevents-quick-auto-commit");

            mode = 2;
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
