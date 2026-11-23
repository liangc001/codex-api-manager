namespace CampusLink;

internal static class RecoveryTests
{
    private sealed class Proxy : ISystemProxy
    {
        internal bool Owns = true;
        internal int Applies;
        public bool IsOwned => Owns;
        public bool BypassMatches => true;
        public void ProtectLifetime() { }
        public void Apply(int port, params string[] files) { Owns = true; Interlocked.Increment(ref Applies); }
        public string Restore() { Owns = false; return ""; }
    }
    private static void Require(bool value, string message) { if (!value) throw new InvalidOperationException(message); }
    internal static async Task<int> Run(string report, int basePort, int relayPort)
    {
        var results = new List<string>(); string? error = null;
        var baseline = ProxySnapshot.Read(); var effective = ProxySnapshot.ReadEffective();
        var root = Path.Combine(Paths.Runtime, "recovery-test-" + Guid.NewGuid().ToString("N")); Paths.PrivateDirectory(root);
        ConnectionService? service = null;
        try
        {
            var store = new ProfileStore(root);
            File.WriteAllText(Path.Combine(root, "policy.json"), new ProfileStore().Policy.ToJsonString());
            var nodes = new JsonArray();
            foreach (string name in new[] { "美国 One", "美国 Two", "德国 Three" })
                nodes.Add(new JsonObject { ["name"] = name, ["type"] = "socks5", ["server"] = "127.0.0.1", ["port"] = 9 });
            store.Save("clash", ProfileStore.NormalizeClash(new JsonObject { ["proxies"] = nodes }));
            var preferences = new PreferencesStore(Path.Combine(root, "preferences.json"));
            preferences.Update(p => p with { AutoRecover = false });
            var proxy = new Proxy();
            int failedPort = -1, rejectNext = 0, probes = 0;
            bool mismatch = false;
            TaskCompletionSource? started = null, release = null;
            async Task<Health> Probe(int port, CancellationToken ct)
            {
                Interlocked.Increment(ref probes);
                if (started != null)
                {
                    var signal = started; var resume = release!;
                    signal.TrySetResult(); await resume.Task.WaitAsync(ct);
                }
                bool ok = Interlocked.Exchange(ref rejectNext, 0) == 0;
                return new(ok, "8.8.8.8", false, "", 1, DateTimeOffset.Now, Country: mismatch ? "DE" : "US");
            }
            Task<LatencySample> Latency(int port, CancellationToken ct) => Task.FromResult(new LatencySample(port == failedPort ? null : 10, DateTimeOffset.Now));
            service = new(store, basePort, Probe, Path.Combine(root, "agy-history.txt"), preferences, proxy, Latency) { OrdinaryRelayPort = relayPort };
            await service.ConnectRegion("US");
            Require(proxy.Applies == 1 && service.State.Health?.Country == "US", "Fixture connection failed");
            async Task FailCurrent()
            {
                preferences.Update(p => p with { AutoRecover = false });
                failedPort = service.CurrentPort!.Value;
                await service.RefreshLatency(); await service.RefreshLatency();
                Require(service.State.Health?.InternetOk == false, "Fixture did not fail current line");
                preferences.Update(p => p with { AutoRecover = true });
            }
            await FailCurrent();
            int original = service.CurrentPid!.Value; rejectNext = 1; int beforeProbes = probes;
            await service.TryRecoverNormal();
            Require(proxy.Applies == 2 && service.CurrentPid != original && service.State.RequestedRegion == "US" && service.State.Health?.Country == "US" && probes - beforeProbes >= 2,
                "Recovery did not retry original then validate alternative in selected region");
            results.Add("recovery-retries-original-then-alternative-and-preserves-selected-region");
            results.Add("failed-candidate-does-not-replace-old-core-before-verification");

            await FailCurrent(); proxy.Owns = false; int beforeApplies = proxy.Applies;
            await service.TryRecoverNormal();
            Require(proxy.Applies == beforeApplies, "Recovery stole proxy from another client");
            results.Add("external-proxy-ownership-pauses-automatic-recovery");
            proxy.Owns = true;
            started = new(TaskCreationOptions.RunContinuationsAsynchronously); release = new(TaskCreationOptions.RunContinuationsAsynchronously);
            original = service.CurrentPid!.Value;
            var stale = service.TryRecoverNormal();
            await started.Task.WaitAsync(TimeSpan.FromSeconds(12));
            service.NotifyNetworkChanged(); release.TrySetResult();
            await stale.WaitAsync(TimeSpan.FromSeconds(12));
            started = release = null;
            Require(proxy.Applies == beforeApplies && service.CurrentPid == original, "Old network result replaced current connection");
            results.Add("network-change-during-verification-discards-stale-candidate");

            await FailCurrent(); mismatch = true;
            await service.TryRecoverNormal(); mismatch = false;
            Require(proxy.Applies == beforeApplies && service.CurrentPid == original && service.State.RequestedRegion == "US", "Recovery switched to a different country");
            results.Add("country-mismatch-keeps-original-core-and-requested-region");
            failedPort = -1; await service.RefreshLatency();
            await FailCurrent();
            started = new(TaskCreationOptions.RunContinuationsAsynchronously); release = new(TaskCreationOptions.RunContinuationsAsynchronously);
            var recovering = service.TryRecoverNormal();
            await started.Task.WaitAsync(TimeSpan.FromSeconds(12));
            var disconnect = service.Disconnect();
            await Task.WhenAll(recovering, disconnect).WaitAsync(TimeSpan.FromSeconds(12));
            started = release = null;
            Require(service.CurrentPid == null && service.State.Phase == "disconnected" && proxy.Applies == beforeApplies, "Disconnect did not cancel recovery before commit");
            await service.TryRecoverNormal();
            Require(service.CurrentPid == null, "Recovery reconnected after user disconnect");
            results.Add("disconnect-cancels-in-flight-recovery-and-prevents-reconnection");
            Require(ProxySnapshot.Read() == baseline && ProxySnapshot.ReadEffective() == effective, "Recovery tests changed real system proxy");
            results.Add("real-cores-tested-with-isolated-proxy-controller-and-unchanged-system-network");
        }
        catch (Exception e) { error = e is InvalidOperationException ? e.Message : e.GetType().Name; }
        finally
        {
            if (service != null) await service.DisposeAsync();
            Directory.Delete(root, true);
            Paths.Atomic(report, JsonSerializer.Serialize(new { success = error == null, error, results }, new JsonSerializerOptions { WriteIndented = true }));
        }
        return error == null ? 0 : 1;
    }
}
