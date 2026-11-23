using System.Net;
using System.Net.Http;
using System.Text.RegularExpressions;

namespace CampusLink;

internal static class AgyLaunch
{
    internal const int Port = 10838;
    internal sealed record Line(string Profile, JsonObject Raw, int Priority)
    {
        internal string Key
        {
            get
            {
                var node = Profile == "racknerd" ? Configuration.RacknerdOutbound(Raw) : Raw;
                var fields = new[] { Profile, node["name"]?.ToString(), node["type"]?.ToString(),
                    node["server"]?.ToString(), (node["port"] ?? node["server_port"])?.ToString() };
                return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(fields))));
            }
        }
    }

    internal static int Priority(string name) => Regex.IsMatch(name,
        @"🇺🇸|美国|美國|(?:^|[\s_\W])(?:US[A]?|United States|Los Angeles|San Jose|Seattle|New York|Dallas|Chicago|SFO|LAX|SJC)(?:$|[\s_\W]|\d)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant) ? 0 : 2;

    internal static IEnumerable<Line> Lines(string profile, JsonObject raw)
    {
        if (profile == "racknerd")
        {
            yield return new(profile, raw, 1);
            yield break;
        }
        if (raw["proxies"] is not JsonArray nodes) yield break;
        foreach (var item in nodes.OfType<JsonObject>())
        {
            var name = item["name"]?.ToString();
            if (string.IsNullOrWhiteSpace(name) || item["dialer-proxy"] != null ||
                item["type"]?.ToString() is null or "direct" or "reject" or "pass" or "dns") continue;
            yield return new(profile, item, Priority(name));
        }
    }

    internal static JsonObject Config(Line line, int port)
    {
        if (line.Profile == "racknerd")
        {
            var node = Configuration.RacknerdOutbound(line.Raw).DeepClone().AsObject();
            if (node["type"]?.ToString() == "trojan" &&
                (node["tls"]?["enabled"]?.GetValue<bool>() != true || node["tls"]?["insecure"]?.GetValue<bool>() == true))
                throw new InvalidOperationException("RackNerd Trojan 必须启用 TLS 和证书校验。");
            node["tag"] = "agy-egress";
            node.Remove("detour");
            return new JsonObject
            {
                ["log"] = new JsonObject { ["level"] = "warn" },
                ["inbounds"] = new JsonArray(new JsonObject { ["type"] = "mixed", ["listen"] = "127.0.0.1", ["listen_port"] = port }),
                ["outbounds"] = new JsonArray(node),
                ["route"] = new JsonObject { ["final"] = "agy-egress" }
            };
        }
        var proxy = line.Raw.DeepClone().AsObject();
        proxy["name"] = "agy-egress";
        proxy.Remove("interface-name");
        proxy.Remove("routing-mark");
        return new JsonObject
        {
            ["mixed-port"] = port, ["allow-lan"] = false, ["bind-address"] = "127.0.0.1",
            ["mode"] = "rule", ["ipv6"] = false, ["log-level"] = "warning",
            ["proxies"] = new JsonArray(proxy), ["rules"] = new JsonArray("MATCH,agy-egress")
        };
    }

    internal static Uri Endpoint(int port) => new($"http://127.0.0.1:{port}");

    internal static string? VerifiedIp(string trace)
    {
        var fields = trace.Split('\n').Select(line => line.Trim()).ToArray();
        if (fields.Count(line => line.StartsWith("loc=", StringComparison.Ordinal)) != 1 ||
            !fields.Contains("loc=US", StringComparer.Ordinal)) return null;
        var addresses = fields.Where(line => line.StartsWith("ip=", StringComparison.Ordinal)).ToArray();
        return addresses.Length == 1 && Connectivity.IsPublicIpv4(addresses[0][3..]) ? addresses[0][3..] : null;
    }

    internal static async Task<string?> Verify(int port, CancellationToken ct)
    {
        using var client = new HttpClient(new HttpClientHandler
        {
            Proxy = new WebProxy(Endpoint(port)), UseProxy = true, AllowAutoRedirect = false
        });
        var traceTask = client.GetAsync("https://www.cloudflare.com/cdn-cgi/trace", ct);
        var googleTask = client.GetAsync("https://oauth2.googleapis.com/token", ct);
        try
        {
            await Task.WhenAll(traceTask, googleTask);
            var trace = traceTask.Result;
            // An unauthenticated GET confirms Google is reachable without sending an OAuth token.
            if (!trace.IsSuccessStatusCode || (int)googleTask.Result.StatusCode is not (200 or 400 or 404 or 405)) return null;
            return VerifiedIp(await trace.Content.ReadAsStringAsync(ct));
        }
        finally
        {
            if (googleTask.IsCompletedSuccessfully) googleTask.Result.Dispose();
            if (traceTask.IsCompletedSuccessfully) traceTask.Result.Dispose();
        }
    }

    internal static string PowerShellSettings(int port) =>
        $"$env:HTTP_PROXY = '{Endpoint(port).GetLeftPart(UriPartial.Authority)}'; " +
        "$env:HTTPS_PROXY = $env:HTTP_PROXY; $env:ALL_PROXY = $env:HTTP_PROXY; $env:NO_PROXY = 'localhost,127.0.0.1,::1'";
}
