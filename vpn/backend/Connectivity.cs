using System.Net;
using System.Net.Http;
using System.Net.Sockets;

namespace CampusLink;

public sealed record Health(bool InternetOk, string ExitIp, bool SchoolOk, string SchoolDetail, long Milliseconds, DateTimeOffset? CheckedAt = null, bool SchoolChecked = false, string? Country = null);
public sealed record LatencySample(long? Milliseconds, DateTimeOffset? CheckedAt, bool Checking = false)
{
    public static LatencySample Pending => new(null, null, true);
}

public static class Connectivity
{
    public static async Task<LatencySample> MeasureLatency(int port, CancellationToken ct = default)
    {
        using var client = Client(port);
        return await MeasureLatency(client, ct);
    }
    internal static async Task<LatencySample> MeasureLatency(HttpClient client, CancellationToken ct)
    {
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct);
        limit.CancelAfter(TimeSpan.FromSeconds(8));
        var timer = Stopwatch.StartNew();
        try
        {
            using var response = await client.GetAsync("https://www.google.com/generate_204", HttpCompletionOption.ResponseHeadersRead, limit.Token);
            return new((int)response.StatusCode == 204 ? timer.ElapsedMilliseconds : null, DateTimeOffset.Now);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException or IOException)
        { return new(null, DateTimeOffset.Now); }
    }
    public static HttpClient Client(int? port = null)
    {
        var handler = new HttpClientHandler();
        if (port.HasValue) { handler.UseProxy = true; handler.Proxy = new WebProxy($"socks5://127.0.0.1:{port}"); }
        else handler.UseProxy = false;
        return new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(16) };
    }
    private static async Task<(bool Ok, string Body)> Fetch(HttpClient client, string url, int expected, CancellationToken ct)
    {
        try
        {
            using var response = await client.GetAsync(url, ct);
            if ((int)response.StatusCode != expected) return (false, "");
            var body = await response.Content.ReadAsStringAsync(ct);
            return (true, body.Length < 50_000 ? body : body[..50_000]);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch { return (false, ""); }
    }
    public static async Task<(bool Ok, string Detail)> School(CancellationToken ct, JsonObject? policy = null)
    {
        string? address = policy?["schoolProbe"]?["host"]?.ToString() ??
            (policy?["schoolCidrs"] as JsonArray)?.Select(n => n?.ToString()).FirstOrDefault(n => n?.EndsWith("/32", StringComparison.Ordinal) == true)?.Split('/')[0];
        int port = policy?["schoolProbe"]?["port"]?.GetValue<int>() ?? 50014;
        if (address == null || port is < 1 or > 65535) return (false, "未配置校园网检测地址。");
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct); limit.CancelAfter(TimeSpan.FromSeconds(5));
        try
        {
            using var client = new TcpClient(); await client.ConnectAsync(address, port, limit.Token);
            var buffer = new byte[128]; int n = await client.GetStream().ReadAsync(buffer, limit.Token);
            return (n >= 4 && Encoding.ASCII.GetString(buffer, 0, 4) == "SSH-", "学校 SSH 端口可达；未登录服务器。");
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch { return (false, "学校 SSH 尚不可达，请检查校园网或 aTrust 登录。"); }
    }
    public static async Task<Health> Probe(int port, CancellationToken ct = default, bool checkSchool = false, JsonObject? policy = null)
    {
        var timer = Stopwatch.StartNew();
        using var client = Client(port);
        var ip = Fetch(client, "https://api.ipify.org", 200, ct);
        var google = Fetch(client, "https://www.google.com/generate_204", 204, ct);
        var trace = Fetch(client, "https://chatgpt.com/cdn-cgi/trace", 200, ct);
        var school = checkSchool ? School(ct, policy) : Task.FromResult((Ok: false, Detail: ""));
        await Task.WhenAll(ip, google, trace, school);
        var exit = ip.Result.Ok && IPAddress.TryParse(ip.Result.Body.Trim(), out var addr) ? addr.ToString() : "";
        if (exit == "" && trace.Result.Ok)
        {
            var field = trace.Result.Body.Split('\n').FirstOrDefault(x => x.StartsWith("ip="));
            if (field != null && IPAddress.TryParse(field[3..].Trim(), out addr)) exit = addr.ToString();
        }
        bool publicIp = IsPublicIpv4(exit);
        return new Health(publicIp && (google.Result.Ok || trace.Result.Ok), exit, school.Result.Ok, school.Result.Detail, timer.ElapsedMilliseconds, DateTimeOffset.Now, checkSchool);
    }
    public static bool PortFree(int port)
    {
        try { var listener = new TcpListener(IPAddress.Loopback, port); listener.Start(); listener.Stop(); return true; } catch (SocketException) { return false; }
    }
    internal static bool IsPublicIpv4(string text)
    {
        if (!IPAddress.TryParse(text, out var address) || address.AddressFamily != AddressFamily.InterNetwork) return false;
        var a = address.GetAddressBytes();
        return a[0] is not (0 or 10 or 127) && a[0] < 224 &&
            !(a[0] == 169 && a[1] == 254) && !(a[0] == 100 && a[1] >= 64 && a[1] <= 127) &&
            !(a[0] == 172 && a[1] >= 16 && a[1] <= 31) && !(a[0] == 192 && a[1] == 168) &&
            !(a[0] == 198 && a[1] is 18 or 19) && !(a[0] == 192 && a[1] == 0 && a[2] == 2) &&
            !(a[0] == 198 && a[1] == 51 && a[2] == 100) && !(a[0] == 203 && a[1] == 0 && a[2] == 113);
    }
}
