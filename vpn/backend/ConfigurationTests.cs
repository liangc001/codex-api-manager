namespace CampusLink;

internal static class ConfigurationTests
{
    internal static async Task<int> Run(string report)
    {
        var results = new List<string>(); string? error = null;
        string root = Path.Combine(Paths.Local, "configuration-test-" + Guid.NewGuid().ToString("N"));
        Paths.PrivateDirectory(root);
        void Require(bool condition, string text) { if (!condition) throw new InvalidOperationException(text); }
        try
        {
            var raw = ProfileStore.NormalizeClash(new JsonObject { ["proxies"] = new JsonArray(new JsonObject {
                ["name"] = "United States fixture", ["type"] = "socks5", ["server"] = "127.0.0.1", ["port"] = 9 }) });
            var policy = new JsonObject {
                ["schoolCidrs"] = new JsonArray("192.0.2.254/32"), ["privateCidrs"] = new JsonArray("127.0.0.0/8"),
                ["directDomains"] = new JsonArray("campus.example.invalid"), ["proxyDomains"] = new JsonArray("chatgpt.com"),
                ["ruleSets"] = new JsonArray() };
            var bypass = Configuration.BypassFor(policy);
            Require(bypass.Contains("campus.example.invalid") && bypass.Contains("192.0.2.254"), "Imported bypass rules were lost");
            var config = new Configuration(policy).Build("clash", raw, 45000);
            Require(config["rules"]!.AsArray().Any(n => n!.ToString() == "DOMAIN-SUFFIX,campus.example.invalid,DIRECT"), "Imported direct domain was lost");
            results.Add("system-bypass-and-core-rules-follow-imported-policy");
            var noSchool = await Connectivity.School(default, new JsonObject());
            Require(!noSchool.Ok, "Absent school configuration started a probe");
            results.Add("missing-school-address-is-handled-without-a-network-probe");
            string original = Path.Combine(root, "original"), gui = Path.Combine(original, "guiConfigs");
            Paths.PrivateDirectory(gui);
            var rack = new JsonObject {
                ["outbounds"] = new JsonArray(new JsonObject { ["type"] = "ssh", ["tag"] = "fixture", ["server"] = "127.0.0.1" }),
                ["route"] = new JsonObject {
                    ["rules"] = new JsonArray(
                        new JsonObject { ["ip_cidr"] = policy["schoolCidrs"]!.DeepClone(), ["outbound"] = "direct" },
                        new JsonObject { ["domain_suffix"] = policy["directDomains"]!.DeepClone(), ["outbound"] = "direct" },
                        new JsonObject { ["domain_suffix"] = policy["proxyDomains"]!.DeepClone(), ["outbound"] = "fixture" }),
                    ["rule_set"] = new JsonArray() } };
            File.WriteAllText(Path.Combine(gui, "racknerd-native-ssh.json"), rack.ToJsonString());
            File.WriteAllText(Path.Combine(gui, "researchlab-fixture.yaml"), Configuration.Serialize("clash", raw));
            string target = Path.Combine(root, "imported"); Paths.PrivateDirectory(target);
            var store = new ProfileStore(target);
            store.Import(original);
            Require(store.Policy["schoolCidrs"]!.AsArray().Any(n => n!.ToString() == "192.0.2.254/32") &&
                store.Policy["directDomains"]!.AsArray().Any(n => n!.ToString() == "campus.example.invalid"), "Original direct rules were not imported");
            results.Add("v2ray-reimport-preserves-configured-addresses-without-host-specific-defaults");
        }
        catch (Exception e) { error = e is InvalidOperationException ? e.Message : e.GetType().Name; }
        finally { Directory.Delete(root, true); }
        Paths.Atomic(report, JsonSerializer.Serialize(new { success = error == null, error, results }));
        return error == null ? 0 : 1;
    }
}
