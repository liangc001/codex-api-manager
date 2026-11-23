namespace CampusLink;

internal static class PortableImport
{
    private static readonly string[] profiles = ["racknerd.protected", "researchlab.protected", "clash.protected", "subscription.protected"];
    private static readonly string[] cores = ["mihomo.exe", "sing-box.exe"];

    internal static void CheckPath(string file, long max, bool directory = false)
    {
        FileSystemInfo item = directory ? new DirectoryInfo(file) : new FileInfo(file);
        if (!item.Exists || item.Attributes.HasFlag(FileAttributes.ReparsePoint) || (!directory && ((FileInfo)item).Length > max))
            throw new IOException("Invalid portable file");
    }

    internal static ProfileStore Open(string home)
    {
        var data = Path.Combine(home, "data");
        CheckPath(home, 0, true);
        CheckPath(data, 0, true);
        CheckPath(Path.Combine(home, "cores"), 0, true);
        CheckPath(Path.Combine(data, "portable.key"), 32);
        Vault.EnsureKey(data, false);
        var ids = ProfileStore.Ids.Where(id => File.Exists(Path.Combine(data, id + ".protected"))).ToArray();
        if (ids.Length == 0) throw new IOException("No profiles");
        foreach (string name in profiles.Where(n => File.Exists(Path.Combine(data, n))))
        {
            var file = Path.Combine(data, name);
            CheckPath(file, 16 * 1024 * 1024);
            if (!Vault.IsPortable(file)) throw new IOException("Only portable profiles are accepted");
            var decoded = Vault.Load(file);
            if (name != "subscription.protected" && JsonNode.Parse(decoded) is not JsonObject) throw new IOException("Invalid profile");
        }
        foreach (var core in cores) CheckPath(Path.Combine(home, "cores", core), 256 * 1024 * 1024);
        var policy = Path.Combine(data, "policy.json");
        CheckPath(policy, 32 * 1024 * 1024);
        if (JsonNode.Parse(File.ReadAllText(policy)) is not JsonObject config ||
            new[] { "ruleSets", "privateCidrs", "schoolCidrs", "proxyDomains", "directDomains" }.Any(k => config[k] is not JsonArray))
            throw new IOException("Invalid policy");
        return new ProfileStore(data);
    }

    internal static void Copy(string input, string target)
    {
        string source = Path.GetFullPath(input);
        CheckPath(source, 0, true);
        if (Directory.Exists(target)) throw new IOException("Destination already exists");
        string parent = Path.GetDirectoryName(target)!;
        Directory.CreateDirectory(parent);
        string stage = Path.Combine(parent, "vpn-import-" + Guid.NewGuid().ToString("N"));
        Paths.PrivateDirectory(stage);
        try
        {
            foreach (var folder in new[] { "data", "cores" })
            {
                var from = Path.Combine(source, folder);
                CheckPath(from, 0, true);
                var to = Path.Combine(stage, folder);
                Paths.PrivateDirectory(to);
                var names = folder == "data" ? profiles.Where(n => File.Exists(Path.Combine(from, n))).Concat(["portable.key", "policy.json"]) : cores;
                foreach (var name in names)
                {
                    var file = Path.Combine(from, name);
                    CheckPath(file, folder == "cores" ? 256 * 1024 * 1024 : 32 * 1024 * 1024);
                    File.Copy(file, Path.Combine(to, name));
                }
            }
            Open(stage);
            Directory.Move(stage, target);
        }
        finally { if (Directory.Exists(stage)) Directory.Delete(stage, true); }
    }
}
