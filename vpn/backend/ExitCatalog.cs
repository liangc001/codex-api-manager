using System.Globalization;
using System.Net;
using System.Net.Http;

namespace CampusLink;

public sealed record ExitOption(string Code, string Label);

internal static class ExitCatalog
{
    internal const string Auto = "auto";
    internal sealed record CandidateLine(string Profile, JsonObject Raw, string? Country, int Priority);
    private static readonly (string Code, string Label, string[] Aliases)[] Regions =
    {
        ("US", "美国", new[] { "美国", "美國", "United States", "Los Angeles", "San Jose" }),
        ("DE", "德国", new[] { "德国", "德國", "Germany", "Nuremberg", "Frankfurt" }),
        ("JP", "日本", new[] { "日本", "Japan", "Tokyo", "Osaka" }),
        ("HK", "中国香港", new[] { "香港", "Hong Kong" }),
        ("SG", "新加坡", new[] { "新加坡", "Singapore" }),
        ("TW", "中国台湾", new[] { "台湾", "臺灣", "台灣", "Taiwan", "Taipei" }),
        ("GB", "英国", new[] { "英国", "英國", "United Kingdom", "London" }),
        ("CA", "加拿大", new[] { "加拿大", "Canada", "Toronto" }),
        ("AU", "澳大利亚", new[] { "澳大利亚", "澳洲", "Australia", "Sydney" }),
        ("FR", "法国", new[] { "法国", "法國", "France", "Paris" }),
        ("KR", "韩国", new[] { "韩国", "韓國", "Korea", "Seoul" }),
        ("IN", "印度", new[] { "印度", "India" }),
        ("AR", "阿根廷", new[] { "阿根廷", "Argentina" }),
        ("RU", "俄罗斯", new[] { "俄罗斯", "俄羅斯", "Russia" }),
        ("TR", "土耳其", new[] { "土耳其", "Turkey" }),
        ("UA", "乌克兰", new[] { "乌克兰", "烏克蘭", "Ukraine" })
    };

    internal static string Name(string? code)
    {
        if (code == Auto) return "自动选择";
        if (string.IsNullOrEmpty(code)) return "未验证";
        var known = Regions.FirstOrDefault(r => r.Code == code).Label;
        if (known != null) return known;
        try { return new RegionInfo(code).DisplayName; } catch (ArgumentException) { return code; }
    }

    private static string? Guess(string name)
    {
        foreach (var region in Regions)
            if (region.Aliases.Any(a => name.Contains(a, StringComparison.OrdinalIgnoreCase))) return region.Code;
        var flag = name.EnumerateRunes().Select(r => r.Value).Where(v => v is >= 0x1f1e6 and <= 0x1f1ff).Take(2)
            .Select(v => (char)('A' + v - 0x1f1e6)).ToArray();
        if (flag.Length == 2)
        {
            var code = new string(flag);
            return code == "UM" ? "US" : code;
        }
        return AgyLaunch.Priority(name) == 0 ? "US" : null;
    }

    internal static IEnumerable<CandidateLine> Read(string profile, JsonObject raw)
    {
        if (profile == "racknerd")
        {
            var node = Configuration.RacknerdOutbound(raw);
            var country = Guess(node["tag"]?.ToString() ?? "");
            yield return new(profile, raw, country, 1);
            yield break;
        }
        if (raw["proxies"] is not JsonArray nodes) yield break;
        foreach (var node in nodes.OfType<JsonObject>())
        {
            var name = node["name"]?.ToString();
            if (string.IsNullOrWhiteSpace(name) || node["dialer-proxy"] != null || name is "VPN" or "DIRECT" or "REJECT" ||
                node["type"]?.ToString() is null or "direct" or "reject" or "pass" or "dns" ||
                name.Contains("下载专用", StringComparison.OrdinalIgnoreCase)) continue;
            var pinned = ProfileStore.NormalizeClash(new JsonObject { ["proxies"] = new JsonArray(node.DeepClone()) });
            var priority = profile == "researchlab" ? 0 : name.Contains("免费", StringComparison.OrdinalIgnoreCase) ? 3 : 0;
            yield return new(profile, pinned, Guess(name), priority);
        }
    }

    internal static async Task<(string Ip, string Country)?> Verify(int port, CancellationToken ct)
    {
        using var client = new HttpClient(new HttpClientHandler
        {
            Proxy = new WebProxy(AgyLaunch.Endpoint(port)), UseProxy = true, AllowAutoRedirect = false
        });
        using var response = await client.GetAsync("https://www.cloudflare.com/cdn-cgi/trace", ct);
        if (!response.IsSuccessStatusCode) return null;
        var fields = (await response.Content.ReadAsStringAsync(ct)).Split('\n', StringSplitOptions.TrimEntries);
        var ips = fields.Where(f => f.StartsWith("ip=", StringComparison.Ordinal)).ToArray();
        var regions = fields.Where(f => f.StartsWith("loc=", StringComparison.Ordinal)).ToArray();
        if (ips.Length != 1 || regions.Length != 1) return null;
        var ip = ips[0][3..];
        var country = regions[0][4..];
        return country.Length == 2 && country.All(c => c is >= 'A' and <= 'Z') &&
            country is not ("XX" or "ZZ" or "T1") && Connectivity.IsPublicIpv4(ip) ? (ip, country) : null;
    }
}
