using System.IO.Pipes;
using System.Net.Sockets;
using System.Text.RegularExpressions;

namespace CampusLink;

internal static class Program
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static int Main(string[] args)
    {
        try
        {
            if (args is ["--validate-data", var dataHome])
            {
                PortableImport.Open(Path.GetFullPath(dataHome));
                return 0;
            }
            if (args is ["--watchdog", var pid, var ticks, var root])
            {
                Paths.RuntimeRoot = Path.GetFullPath(root);
                if (Directory.Exists(Paths.Runtime)) ProxyGuard.Watch(int.Parse(pid), long.Parse(ticks));
                return 0;
            }
#if VPN_FIXTURES
            if (args is ["--make-fixture", var fixtureHome])
            {
                string data = Path.Combine(Path.GetFullPath(fixtureHome), "data");
                Paths.PrivateDirectory(data);
                var store = new ProfileStore(data);
                var nodes = new JsonArray();
                foreach (string label in new[] { "United States fixture", "Germany fixture" })
                    nodes.Add(new JsonObject { ["name"] = label, ["type"] = "socks5", ["server"] = "127.0.0.1", ["port"] = 9 });
                store.Save("clash", ProfileStore.NormalizeClash(new JsonObject { ["proxies"] = nodes }));
                Paths.Atomic(Path.Combine(data, "policy.json"),
                    """{"ruleSets":[],"privateCidrs":["127.0.0.0/8"],"schoolCidrs":["192.0.2.0/24"],"proxyDomains":["example.invalid"],"directDomains":["localhost"]}""");
                return 0;
            }
            if (args is ["--test", var name, var home, var local, var report, var testPort, var testRelayPort])
            {
                Configure(home, local);
                Paths.Initialize();
                return (name switch
                {
                    "ranking" => BenchmarkTests.Run(report, int.Parse(testPort), int.Parse(testRelayPort)),
                    "recovery" => RecoveryTests.Run(report, int.Parse(testPort), int.Parse(testRelayPort)),
                    "storage" => Task.FromResult(PortableStorageTests.Run(report)), "latency" => LatencyTests.Run(report),
                    "configuration" => ConfigurationTests.Run(report),
                    _ => throw new ArgumentException()
                }).GetAwaiter().GetResult();
            }
            if (args is ["--fixture", var testPipe, var testParent, var testHome, var testLocal, var testBase, var testRelay])
            {
                Configure(testHome, testLocal);
                Paths.PrivateDirectory(Paths.Local); Paths.PrivateDirectory(Paths.Runtime);
                return Serve(testPipe, int.Parse(testParent), true, int.Parse(testBase), int.Parse(testRelay)).GetAwaiter().GetResult();
            }
#endif
            if (args is not ["--serve", var pipe, var parent, var appHome]) return 2;
            Paths.BackendHome = Path.GetFullPath(appHome);
            // Interoperate with the legacy desktop mutex as well as the shared settings mutex in ProxyGuard.
            using var legacy = new Mutex(false, @"Local\CampusLink-Desktop-v1");
            try { if (!legacy.WaitOne(0)) return 12; }
            catch (AbandonedMutexException) { }
            try
            {
                Paths.PrivateDirectory(Paths.Local); Paths.PrivateDirectory(Paths.Runtime);
                ProxyGuard.RecoverStale();
                return Serve(pipe, int.Parse(parent)).GetAwaiter().GetResult();
            }
            finally { legacy.ReleaseMutex(); }
        }
        catch { return 1; }
    }

    private static void Configure(string home, string local)
    {
        Paths.BackendHome = Path.GetFullPath(home);
        Paths.RuntimeRoot = Path.GetFullPath(local);
    }

    private static async Task<int> Serve(string name, int parentPid, bool fixture = false, int basePort = 10818, int relay = 10839)
    {
        if (!Regex.IsMatch(name, "^api-switchboard-vpn-[0-9a-f]{32}$", RegexOptions.CultureInvariant)) return 2;
        using var parent = Process.GetProcessById(parentPid);
        using var accept = new CancellationTokenSource();
        var watch = WatchHost();
        async Task WatchHost()
        {
            try { await parent.WaitForExitAsync(accept.Token); accept.Cancel(); }
            catch (OperationCanceledException) { }
        }
        var facade = new BrokerFacade(fixture, basePort, relay);
        int exitCode = 0;
        try
        {
            do
            {
                using var pipe = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await pipe.WaitForConnectionAsync(accept.Token);
                using var requestTimeout = CancellationTokenSource.CreateLinkedTokenSource(accept.Token);
                requestTimeout.CancelAfter(TimeSpan.FromSeconds(3));
                object response;
                try
                {
                    var request = await ReadRequest(pipe, requestTimeout.Token);
                    response = new { ok = true, result = await facade.Dispatch(request) };
                }
                catch (BrokerError e) { response = new { ok = false, error = e.Message }; }
                catch (Exception e) when (e is OperationCanceledException or IOException) { continue; }
                catch
                {
                    if (facade.Exited) exitCode = 1;
                    response = new { ok = false, error = facade.Exited
                        ? "VPN 退出清理失败，请检查 Windows 代理设置。"
                        : "VPN 操作失败。请检查配置或复制脱敏诊断。" };
                }
                try
                {
                    using var replyTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                    await pipe.WriteAsync(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(response, Json) + "\n"), replyTimeout.Token);
                }
                catch (Exception e) when (e is IOException or OperationCanceledException) { }
            } while (!facade.Exited && !accept.IsCancellationRequested);
        }
        catch (OperationCanceledException) when (accept.IsCancellationRequested) { }
        finally
        {
            accept.Cancel();
            await watch;
            await facade.DisposeAsync();
        }
        return exitCode;
    }

    private static async Task<JsonObject> ReadRequest(Stream pipe, CancellationToken ct)
    {
        using var line = new MemoryStream();
        byte[] buffer = new byte[1024];
        while (line.Length <= 8192)
        {
            int count = await pipe.ReadAsync(buffer, ct);
            if (count == 0) break;
            int end = Array.IndexOf(buffer, (byte)'\n', 0, count);
            line.Write(buffer, 0, end < 0 ? count : end);
            if (end >= 0 && line.Length <= 8192)
                return JsonNode.Parse(line.ToArray()) as JsonObject ?? throw new BrokerError("请求格式无效。");
        }
        throw new BrokerError("请求格式无效。");
    }
}

internal sealed class BrokerError(string message) : Exception(message);
