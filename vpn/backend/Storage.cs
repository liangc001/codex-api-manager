using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using YamlDotNet.Serialization;

namespace CampusLink;

public static class Paths
{
    internal static string? BackendHome { get; set; }
    internal static string? RuntimeRoot { get; set; }
    public static string Home => BackendHome ?? AppContext.BaseDirectory;
    public static string Data => Path.Combine(Home, "data");
    public static string Local => RuntimeRoot ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ApiSwitchboard", "Vpn");
    public static string Runtime => Path.Combine(Local, "runtime");
    public static string Lease => Path.Combine(Local, "proxy-lease.json");
    public static string Executable => Environment.ProcessPath!;
    public static long OwnerStartTicks { get; } = GetStartTicks();
    public static string OwnerStamp => $"{Environment.ProcessId}-{OwnerStartTicks}";
    private static long GetStartTicks() { using var process = Process.GetCurrentProcess(); return process.StartTime.ToUniversalTime().Ticks; }
    public static void PrivateDirectory(string path)
    {
        Directory.CreateDirectory(path);
        var acl = new DirectorySecurity();
        acl.SetAccessRuleProtection(true, false);
        var me = WindowsIdentity.GetCurrent().User!;
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        foreach (var sid in new[] { me, system })
            acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        new DirectoryInfo(path).SetAccessControl(acl);
    }
    public static void Initialize()
    {
        PrivateDirectory(Data); PrivateDirectory(Local); PrivateDirectory(Runtime);
    }
    public static void Atomic(string path, string value)
    {
        var temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        File.WriteAllText(temp, value, new UTF8Encoding(false));
        File.Move(temp, path, true);
    }
}

public static class Vault
{
    private static readonly byte[] Magic = Encoding.ASCII.GetBytes("VPNPORT1");
    private static readonly byte[] Context = Encoding.ASCII.GetBytes("VPN portable profile v1");
    private static readonly object KeySync = new();
    public static bool IsPortable(string path) => File.ReadAllBytes(path).AsSpan().StartsWith(Magic);
    private static byte[] Key(string root, bool create)
    {
        lock (KeySync)
        {
            var path = Path.Combine(root, "portable.key");
            if (!File.Exists(path))
            {
                if (!create) throw new InvalidOperationException("缺少 data 中的 portable.key，请重新复制完整的便携文件夹。");
                if (Directory.EnumerateFiles(root, "*.protected").Any(IsPortable))
                    throw new InvalidOperationException("缺少 portable.key，已保留现有配置；请重新复制完整的 data 文件夹。");
                using var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                var generated = RandomNumberGenerator.GetBytes(32);
                try { file.Write(generated); file.Flush(true); } finally { CryptographicOperations.ZeroMemory(generated); }
            }
            var key = File.ReadAllBytes(path);
            if (key.Length != 32) throw new InvalidOperationException("便携密钥已损坏，请重新复制完整的 data 文件夹。");
            return key;
        }
    }
    internal static void EnsureKey(string root, bool create)
    { var key = Key(root, create); CryptographicOperations.ZeroMemory(key); }
    [StructLayout(LayoutKind.Sequential)] private struct Blob { public int Size; public IntPtr Data; }
    [DllImport("crypt32.dll", SetLastError = true)] private static extern bool CryptProtectData(ref Blob input, string? description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, out Blob output);
    [DllImport("crypt32.dll", SetLastError = true)] private static extern bool CryptUnprotectData(ref Blob input, IntPtr description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, out Blob output);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr p);
    private static byte[] Convert(byte[] bytes, bool encrypt)
    {
        var input = new Blob { Size = bytes.Length, Data = Marshal.AllocHGlobal(bytes.Length) };
        Marshal.Copy(bytes, 0, input.Data, bytes.Length);
        Blob output = default;
        try
        {
            bool ok = encrypt ? CryptProtectData(ref input, "CampusLink profile", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, out output)
                : CryptUnprotectData(ref input, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, out output);
            if (!ok) throw new InvalidOperationException("无法读取本机凭据。换电脑后，请重新导入原配置。");
            var result = new byte[output.Size]; Marshal.Copy(output.Data, result, 0, result.Length); return result;
        }
        finally { Marshal.FreeHGlobal(input.Data); if (output.Data != IntPtr.Zero) LocalFree(output.Data); }
    }
    internal static void SaveLegacyForTest(string path, string text) => File.WriteAllBytes(path, Convert(Encoding.UTF8.GetBytes(text), true));
    public static void Save(string path, string text, string? keyRoot = null)
    {
        var key = Key(keyRoot ?? Path.GetDirectoryName(path)!, true);
        var plain = Encoding.UTF8.GetBytes(text); var data = new byte[Magic.Length + 12 + 16 + plain.Length];
        Magic.CopyTo(data, 0); RandomNumberGenerator.Fill(data.AsSpan(Magic.Length, 12));
        var temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using var aes = new AesGcm(key, 16);
            aes.Encrypt(data.AsSpan(8, 12), plain, data.AsSpan(36), data.AsSpan(20, 16), Context);
            File.WriteAllBytes(temp, data); File.Move(temp, path, true);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(key); CryptographicOperations.ZeroMemory(plain);
            if (File.Exists(temp)) File.Delete(temp);
        }
    }
    public static string Load(string path, string? keyRoot = null)
    {
        var data = File.ReadAllBytes(path);
        if (!data.AsSpan().StartsWith(Magic)) return Encoding.UTF8.GetString(Convert(data, false));
        if (data.Length < 36) throw new InvalidOperationException("便携配置已损坏，请从完整备份重新复制。");
        var key = Key(keyRoot ?? Path.GetDirectoryName(path)!, false); var plain = new byte[data.Length - 36];
        try
        {
            using var aes = new AesGcm(key, 16);
            aes.Decrypt(data.AsSpan(8, 12), data.AsSpan(36), data.AsSpan(20, 16), plain, Context);
            return Encoding.UTF8.GetString(plain);
        }
        catch (CryptographicException) { throw new InvalidOperationException("便携配置无法解密，请确认 data 与 portable.key 来自同一份文件夹。"); }
        finally { CryptographicOperations.ZeroMemory(key); CryptographicOperations.ZeroMemory(plain); }
    }
}

public sealed class ProfileStore
{
    private static readonly object Sync = new();
    private readonly string dataRoot;
    public ProfileStore(string? dataRoot = null)
    {
        this.dataRoot = dataRoot ?? Paths.Data; Paths.PrivateDirectory(this.dataRoot);
        MigrateToPortable();
    }
    private void MigrateToPortable()
    {
        lock (Sync)
        {
            var files = Ids.Select(id => id + ".protected").Append("subscription.protected")
                .Select(n => Path.Combine(dataRoot, n)).Where(File.Exists).ToArray();
            bool hasPortable = files.Any(Vault.IsPortable);
            if (hasPortable) Vault.EnsureKey(dataRoot, false);
            var legacy = files.Where(p => !Vault.IsPortable(p)).ToArray();
            if (legacy.Length == 0) { Vault.EnsureKey(dataRoot, true); return; }
            // Decrypt every legacy file before changing any of them. No plaintext touches disk.
            var texts = legacy.ToDictionary(p => p, p => Vault.Load(p, dataRoot));
            var before = legacy.ToDictionary(p => p, File.ReadAllBytes);
            var keyPath = Path.Combine(dataRoot, "portable.key"); bool hadKey = File.Exists(keyPath);
            var stage = Path.Combine(dataRoot, "portable-migration-" + Guid.NewGuid().ToString("N")); Paths.PrivateDirectory(stage);
            var committed = new List<string>();
            try
            {
                foreach (var path in legacy)
                {
                    var temp = Path.Combine(stage, Path.GetFileName(path)); Vault.Save(temp, texts[path], dataRoot);
                    if (Vault.Load(temp, dataRoot) != texts[path]) throw new InvalidOperationException("便携配置转换验证失败。");
                }
                foreach (var path in legacy)
                { File.Move(Path.Combine(stage, Path.GetFileName(path)), path, true); committed.Add(path); }
            }
            catch
            {
                foreach (var path in committed) File.WriteAllBytes(path, before[path]);
                if (!hadKey && !hasPortable && File.Exists(keyPath)) File.Delete(keyPath);
                throw;
            }
            finally { foreach (var path in Directory.GetFiles(stage)) File.Delete(path); Directory.Delete(stage); }
        }
    }
    public static readonly string[] Ids = { "racknerd", "researchlab", "clash" };
    public static string Name(string id) => id switch { "racknerd" => "RackNerd", "researchlab" => "ResearchLab", "clash" => "Clash", _ => throw new ArgumentException("未知线路。") };
    private string FileFor(string id)
    {
        if (!Ids.Contains(id)) throw new ArgumentException("未知线路。");
        return Path.Combine(dataRoot, id + ".protected");
    }
    public bool Has(string id) => File.Exists(FileFor(id));
    public JsonObject Load(string id) { lock (Sync) return JsonNode.Parse(Vault.Load(FileFor(id)))!.AsObject(); }
    public void Save(string id, JsonObject raw) { lock (Sync) Vault.Save(FileFor(id), raw.ToJsonString()); }
    public string? Subscription { get { lock (Sync) return File.Exists(Path.Combine(dataRoot, "subscription.protected")) ? Vault.Load(Path.Combine(dataRoot, "subscription.protected")) : null; } }
    public JsonObject Policy { get { lock (Sync) return JsonNode.Parse(File.ReadAllText(Path.Combine(dataRoot, "policy.json")))!.AsObject(); } }
    public static JsonObject ParseYaml(string text)
    {
        if (text.Length > 4_000_000) throw new InvalidOperationException("订阅内容过大，已保留原线路。");
        var obj = new DeserializerBuilder().WithAttemptingUnquotedStringTypeDeserialization().Build().Deserialize<object>(text);
        var json = new SerializerBuilder().JsonCompatible().Build().Serialize(obj);
        return JsonNode.Parse(json)?.AsObject() ?? throw new InvalidOperationException("订阅格式不正确。");
    }
    public static JsonObject NormalizeClash(JsonObject raw)
    {
        var nodes = raw["proxies"] as JsonArray ?? raw["Proxy"] as JsonArray;
        if (nodes == null || nodes.Count == 0) throw new InvalidOperationException("Clash 配置中没有内置节点，请导入包含 proxies 的完整 YAML 配置。");
        var names = nodes.Select(n => n?["name"]?.GetValue<string>()).ToArray();
        if (names.Any(string.IsNullOrWhiteSpace) || names.Distinct(StringComparer.Ordinal).Count() != names.Length || names.Any(n => n is "VPN" or "DIRECT" or "REJECT"))
            throw new InvalidOperationException("Clash 节点名称重复、为空或与内置线路组冲突。");
        if (nodes.Any(n => n?["dialer-proxy"] != null)) throw new InvalidOperationException("Clash 配置包含节点串联，请提供独立节点配置。");
        // Keep only independent nodes. Use our shared routing and no source controllers, listeners or providers.
        return new JsonObject
        {
            ["proxies"] = nodes.DeepClone(),
            ["proxy-groups"] = new JsonArray(new JsonObject
            {
                ["name"] = "VPN", ["type"] = "fallback", ["proxies"] = JsonSerializer.SerializeToNode(names),
                ["url"] = "https://www.google.com/generate_204", ["interval"] = 300, ["timeout"] = 4000, ["lazy"] = true
            })
        };
    }
    public void Import(string original)
    {
        var folder = Path.Combine(original, "guiConfigs");
        var rack = JsonNode.Parse(File.ReadAllText(Path.Combine(folder, "racknerd-native-ssh.json")))!.AsObject();
        var selectedRack = rack;
        // Reimporting the retained v2rayN snapshot must not downgrade a migrated native Trojan line.
        if (Has("racknerd") && Configuration.RacknerdOutbound(rack)["type"]?.ToString() == "ssh")
        {
            var currentRack = Load("racknerd");
            if (Configuration.RacknerdOutbound(currentRack)["type"]?.ToString() == "trojan") selectedRack = currentRack;
        }
        var files = Directory.GetFiles(folder, "researchlab-*.yaml");
        if (files.Length != 1) throw new InvalidOperationException("无法唯一确定 ResearchLab 配置文件。");
        var research = ParseYaml(File.ReadAllText(files[0]));
        if (research["proxies"] is not JsonArray nodes || nodes.Count == 0) throw new InvalidOperationException("线路没有可用节点。");
        var rules = rack["route"]!["rules"]!.AsArray();
        var directRules = rules.Where(r => r?["outbound"]?.ToString() == "direct").ToArray();
        var school = new JsonArray(directRules.SelectMany(r => r?["ip_cidr"] as JsonArray ?? new())
            .Select(n => n!.DeepClone()).ToArray());
        var directDomains = directRules.SelectMany(r => r?["domain_suffix"] as JsonArray ?? new()).Select(n => n!.ToString())
            .Concat(["lan", "local"]).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        var policy = new JsonObject
        {
            ["schoolCidrs"] = school,
            ["privateCidrs"] = JsonSerializer.SerializeToNode(new[] { "127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "fe80::/10", "fc00::/7" }),
            ["directDomains"] = JsonSerializer.SerializeToNode(directDomains),
            ["proxyDomains"] = rules.First(r => r?["domain_suffix"] is JsonArray domains && domains.Any(x => x?.ToString() == "chatgpt.com"))!["domain_suffix"]!.DeepClone(),
            ["ruleSets"] = rack["route"]!["rule_set"]!.DeepClone(),
            ["importedAt"] = DateTimeOffset.Now.ToString("O")
        };
        var subscription = Path.Combine(original, "guiTemps", "researchlab-subscription", "subscription-url.txt");
        string? subscriptionUrl = null;
        if (File.Exists(subscription))
        {
            var url = File.ReadAllText(subscription).Trim();
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != "https") throw new InvalidOperationException("订阅地址格式不正确，未导入任何配置。");
            subscriptionUrl = url;
        }
        // Stage every file before replacing any live profile; restore old files on commit failure.
        lock (Sync)
        {
            var stage = Path.Combine(dataRoot, "import-" + Guid.NewGuid().ToString("N")); Paths.PrivateDirectory(stage);
            var names = new[] { "racknerd.protected", "researchlab.protected", "policy.json", "subscription.protected" };
            var before = names.ToDictionary(n => n, n => File.Exists(Path.Combine(dataRoot, n)) ? File.ReadAllBytes(Path.Combine(dataRoot, n)) : null);
            bool committing = false;
            try
            {
                Vault.Save(Path.Combine(stage, names[0]), selectedRack.ToJsonString(), dataRoot);
                Vault.Save(Path.Combine(stage, names[1]), research.ToJsonString(), dataRoot);
                File.WriteAllText(Path.Combine(stage, names[2]), policy.ToJsonString());
                if (subscriptionUrl != null) Vault.Save(Path.Combine(stage, names[3]), subscriptionUrl, dataRoot);
                committing = true;
                foreach (var name in names)
                {
                    var target = Path.Combine(dataRoot, name); var staged = Path.Combine(stage, name);
                    if (File.Exists(staged)) File.Move(staged, target, true); else File.Delete(target);
                }
            }
            catch
            {
                if (committing) foreach (var name in names)
                {
                    var target = Path.Combine(dataRoot, name);
                    if (before[name] != null)
                    {
                        if (!File.Exists(target) || !File.ReadAllBytes(target).SequenceEqual(before[name]!)) File.WriteAllBytes(target, before[name]!);
                    }
                    else File.Delete(target);
                }
                throw;
            }
            finally { foreach (var f in Directory.GetFiles(stage)) File.Delete(f); Directory.Delete(stage); }
        }
    }
}
