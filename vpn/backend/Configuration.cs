using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace CampusLink;

public sealed class Configuration
{
    public const string RacknerdTag = "racknerd-proxy";
    private readonly JsonObject policy;
    public Configuration(JsonObject policy) { this.policy = policy; }
    private JsonNode Copy(string key) => policy[key]!.DeepClone();
    private static JsonObject Route(string field, JsonNode value, string outbound = "direct") => new() { [field] = value, ["action"] = "route", ["outbound"] = outbound };
    public static JsonObject RacknerdOutbound(JsonObject raw)
    {
        var nodes = raw["outbounds"]?.AsArray().Where(x => x?["type"]?.ToString() is "ssh" or "trojan").ToArray();
        if (nodes?.Length != 1) throw new InvalidOperationException("RackNerd 配置必须包含一条独立的 SSH 或 Trojan 线路。");
        return nodes[0]!.AsObject();
    }
    public static bool LocalIpv6Available() => NetworkInterface.GetAllNetworkInterfaces().Any(n =>
        n.OperationalStatus == OperationalStatus.Up && n.GetIPProperties().GatewayAddresses.Any(g =>
            g.Address.AddressFamily == AddressFamily.InterNetworkV6 && !g.Address.Equals(IPAddress.IPv6Any)) &&
        n.GetIPProperties().UnicastAddresses.Any(u => u.Address.AddressFamily == AddressFamily.InterNetworkV6 &&
            !u.Address.IsIPv6LinkLocal && !u.Address.IsIPv6Multicast && !IPAddress.IsLoopback(u.Address) && (u.Address.GetAddressBytes()[0] & 0xfe) != 0xfc));
    public JsonObject Build(string id, JsonObject raw, int port)
    {
        return id == "racknerd" ? SingBox(raw, port) : Mihomo(raw, port);
    }
    public static string Serialize(string id, JsonObject config)
    {
        if (id == "racknerd") return config.ToJsonString();
        // Mihomo reads YAML: JSON surrogate-pair escapes in emoji names are invalid YAML.
        using var document = JsonDocument.Parse(config.ToJsonString());
        static object? Clr(JsonElement value) => value.ValueKind switch
        {
            JsonValueKind.Object => value.EnumerateObject().ToDictionary(p => p.Name, p => Clr(p.Value)),
            JsonValueKind.Array => value.EnumerateArray().Select(Clr).ToArray(),
            JsonValueKind.String => value.GetString(),
            JsonValueKind.Number => value.TryGetInt64(out long n) ? (object)n : value.GetDouble(),
            JsonValueKind.True => true, JsonValueKind.False => false, _ => null
        };
        return new YamlDotNet.Serialization.SerializerBuilder().DisableAliases().Build().Serialize(Clr(document.RootElement));
    }
    private JsonObject SingBox(JsonObject raw, int port)
    {
        var c = raw.DeepClone().AsObject();
        var node = RacknerdOutbound(c);
        string oldTag = node["tag"]?.ToString() ?? "racknerd-ssh";
        if (node["type"]?.ToString() == "trojan" &&
            (node["tls"]?["enabled"]?.GetValue<bool>() != true || node["tls"]?["insecure"]?.GetValue<bool>() == true))
            throw new InvalidOperationException("RackNerd Trojan 必须启用 TLS 和证书校验。");
        void Retag(JsonNode? value)
        {
            if (value is JsonObject obj) foreach (var pair in obj.ToArray())
            {
                if ((pair.Key is "outbound" or "detour" or "final") && pair.Value is JsonValue && pair.Value.ToString() == oldTag) obj[pair.Key] = RacknerdTag;
                else Retag(pair.Value);
            }
            else if (value is JsonArray array) foreach (var item in array) Retag(item);
        }
        Retag(c);
        node["tag"] = RacknerdTag;
        node.Remove("detour");
        c["outbounds"] = new JsonArray(node.DeepClone(), new JsonObject { ["type"] = "direct", ["tag"] = "direct" });
        c["route"]!["final"] = RacknerdTag;
        c["log"] = new JsonObject { ["level"] = "warn", ["timestamp"] = true };
        c["inbounds"] = new JsonArray(new JsonObject { ["type"] = "mixed", ["tag"] = "mixed-in", ["listen"] = "127.0.0.1", ["listen_port"] = port });
        var rules = new JsonArray();
        if (!LocalIpv6Available()) rules.Add(new JsonObject { ["domain"] = new JsonArray("ipv6.msftconnecttest.com"), ["port"] = new JsonArray(80, 443), ["action"] = "reject", ["method"] = "default", ["no_drop"] = true });
        else rules.Add(new JsonObject { ["domain"] = new JsonArray("ipv6.msftconnecttest.com"), ["action"] = "resolve", ["server"] = "local", ["strategy"] = "prefer_ipv6" });
        rules.Add(Route("domain_suffix", new JsonArray("msftconnecttest.com", "msftncsi.com")));
        var loop = Route("domain_suffix", new JsonArray("localhost", "localhost.localdomain")); loop["override_address"] = "127.0.0.1"; rules.Add(loop);
        rules.Add(Route("ip_cidr", Copy("privateCidrs")));
        rules.Add(Route("domain_suffix", new JsonArray("localhost", "lan", "local")));
        rules.Add(Route("ip_cidr", Copy("schoolCidrs")));
        var proxy = Route("domain_suffix", Copy("proxyDomains"), RacknerdTag); proxy["network"] = "tcp"; rules.Add(proxy);
        rules.Add(Route("process_name", new JsonArray("steam.exe", "steamwebhelper.exe")));
        rules.Add(Route("domain_suffix", Copy("directDomains")));
        rules.Add(Route("ip_is_private", JsonValue.Create(true)!));
        rules.Add(Route("rule_set", new JsonArray("geosite-cn")));
        rules.Add(new JsonObject { ["action"] = "resolve" });
        rules.Add(Route("ip_cidr", new JsonArray(policy["privateCidrs"]!.AsArray().Concat(policy["schoolCidrs"]!.AsArray()).Select(x => x!.DeepClone()).ToArray())));
        rules.Add(Route("ip_is_private", JsonValue.Create(true)!));
        rules.Add(Route("rule_set", new JsonArray("geoip-cn")));
        rules.Add(new JsonObject { ["network"] = "udp", ["action"] = "reject", ["no_drop"] = true });
        c["route"]!["rules"] = rules; c["route"]!["rule_set"] = Copy("ruleSets");
        return c;
    }
    public JsonObject MihomoMixin()
    {
        var domains = new JsonArray(); var ips = new JsonArray();
        foreach (var set in policy["ruleSets"]!.AsArray()) foreach (var rule in set!["rules"]!.AsArray())
        {
            foreach (var (field, prefix) in new[] { ("domain", "DOMAIN,"), ("domain_suffix", "DOMAIN-SUFFIX,"), ("domain_regex", "DOMAIN-REGEX,") })
                if (rule?[field] is JsonArray entries) foreach (var entry in entries) domains.Add(prefix + entry!.ToString());
            if (rule?["ip_cidr"] is JsonArray cidrs) foreach (var cidr in cidrs) ips.Add(cidr!.ToString());
        }
        var rules = new JsonArray();
        if (!LocalIpv6Available()) rules.Add("DOMAIN,ipv6.msftconnecttest.com,REJECT");
        foreach (var d in new[] { "localhost", "lan", "local", "msftconnecttest.com", "msftncsi.com" }) rules.Add($"DOMAIN-SUFFIX,{d},DIRECT");
        foreach (var item in policy["privateCidrs"]!.AsArray().Concat(policy["schoolCidrs"]!.AsArray()))
            rules.Add($"{(item!.ToString().Contains(':') ? "IP-CIDR6" : "IP-CIDR")},{item},DIRECT,no-resolve");
        foreach (var domain in policy["proxyDomains"]!.AsArray()) rules.Add($"DOMAIN-SUFFIX,{domain},VPN");
        foreach (var domain in policy["directDomains"]!.AsArray()) rules.Add($"DOMAIN-SUFFIX,{domain},DIRECT");
        rules.Add("PROCESS-NAME,steam.exe,DIRECT"); rules.Add("PROCESS-NAME,steamwebhelper.exe,DIRECT");
        rules.Add("RULE-SET,campuslink-cn-domains,DIRECT"); rules.Add("RULE-SET,campuslink-cn-ip,DIRECT");
        return new JsonObject
        {
            ["prepend-rules"] = rules,
            ["rule-providers"] = new JsonObject
            {
                ["campuslink-cn-domains"] = new JsonObject { ["type"] = "inline", ["behavior"] = "classical", ["payload"] = domains },
                ["campuslink-cn-ip"] = new JsonObject { ["type"] = "inline", ["behavior"] = "ipcidr", ["payload"] = ips }
            }
        };
    }
    private JsonObject Mihomo(JsonObject raw, int port)
    {
        var c = raw.DeepClone().AsObject();
        if (c["proxies"] is not JsonArray proxies || proxies.Count == 0) throw new InvalidOperationException("线路没有节点，已保留当前连接。");
        if (c["proxy-groups"] is not JsonArray groups || !groups.Any(g => g?["name"]?.ToString() == "VPN")) throw new InvalidOperationException("订阅缺少 VPN 线路组，已保留当前连接。");
        foreach (var group in groups)
            if (group?["name"]?.ToString() == "VPN" && group["proxies"] is JsonArray entries)
                for (int i = entries.Count - 1; i >= 0; i--) if (entries[i]?.ToString() is "DIRECT" or "REJECT") entries.RemoveAt(i);
        if (!groups.Any(g => g?["name"]?.ToString() == "VPN" && g["proxies"] is JsonArray a && a.Count > 0)) throw new InvalidOperationException("线路组为空。");
        foreach (var field in new[] { "port", "socks-port", "redir-port", "tproxy-port", "listeners", "external-controller", "external-controller-tls", "external-controller-unix", "external-controller-pipe", "secret", "tun", "dns" }) c.Remove(field);
        c["mixed-port"] = port; c["allow-lan"] = false; c["bind-address"] = "127.0.0.1"; c["mode"] = "rule"; c["ipv6"] = false; c["log-level"] = "warning";
        var mixin = MihomoMixin(); c["rule-providers"] = mixin["rule-providers"]!.DeepClone();
        var rules = mixin["prepend-rules"]!.DeepClone().AsArray(); rules.Add("MATCH,VPN"); c["rules"] = rules;
        c["profile"] = new JsonObject { ["store-selected"] = false };
        return c;
    }
    public static string Core(string id) => Path.Combine(Paths.Home, "cores", id == "racknerd" ? "sing-box.exe" : "mihomo.exe");
    public static string[] CheckArgs(string id, string path) => id == "racknerd" ? new[] { "check", "-c", path } : new[] { "-t", "-d", Paths.Runtime, "-f", path };
    public static string[] RunArgs(string id, string path) => id == "racknerd" ? new[] { "run", "-c", path } : new[] { "-d", Paths.Runtime, "-f", path };
    public static string Bypass => "<local>;localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;local.alipcsec.com;*.msftconnecttest.com;msftconnecttest.com;*.msftncsi.com;msftncsi.com";
    internal static string BypassFor(JsonObject policy)
    {
        var entries = new List<string> { Bypass };
        foreach (var value in (policy["directDomains"] as JsonArray ?? new()))
        {
            string domain = value?.ToString().Trim('.') ?? "";
            if (Uri.CheckHostName(domain) == UriHostNameType.Dns) { entries.Add(domain); entries.Add("*." + domain); }
        }
        foreach (var value in (policy["schoolCidrs"] as JsonArray ?? new()))
        {
            var parts = (value?.ToString() ?? "").Split('/');
            if (parts.Length == 2 && parts[1] is "32" or "128" && IPAddress.TryParse(parts[0], out var ip)) entries.Add(ip.ToString());
        }
        return string.Join(';', entries);
    }
}
