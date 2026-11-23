namespace CampusLink;

public static class PortableStorageTests
{
    private static void Require(bool value, string message) { if (!value) throw new InvalidOperationException(message); }
    public static int Run(string report)
    {
        var results = new List<object>(); string? error = null;
        var root = Path.Combine(Paths.Local, "portable-test-" + Guid.NewGuid().ToString("N")); Paths.PrivateDirectory(root);
        void Pass(string name) => results.Add(new { name, passed = true });
        try
        {
            string legacyRoot = Path.Combine(root, "legacy"); Paths.PrivateDirectory(legacyRoot);
            string expected = "{\"secret\":\"portable-test-only-密钥🔒\"}";
            foreach (var id in ProfileStore.Ids) Vault.SaveLegacyForTest(Path.Combine(legacyRoot, id + ".protected"), expected);
            Vault.SaveLegacyForTest(Path.Combine(legacyRoot, "subscription.protected"), "https://subscription.invalid/test");
            var store = new ProfileStore(legacyRoot);
            Require(ProfileStore.Ids.All(id => store.Load(id).ToJsonString() == JsonNode.Parse(expected)!.ToJsonString()), "Legacy profiles changed");
            Require(Directory.GetFiles(legacyRoot, "*.protected").All(Vault.IsPortable) && store.Subscription == "https://subscription.invalid/test", "Legacy conversion incomplete");
            Pass("migrate-all-three-dpapi-profiles-and-subscription");
            string copy = Path.Combine(root, "复制到另一目录"); Paths.PrivateDirectory(copy);
            foreach (var file in Directory.GetFiles(legacyRoot)) File.Copy(file, Path.Combine(copy, Path.GetFileName(file)));
            var copied = new ProfileStore(copy);
            Require(ProfileStore.Ids.All(id => copied.Load(id).ToJsonString() == store.Load(id).ToJsonString()) && copied.Subscription == store.Subscription, "Copied folder cannot decrypt");
            Pass("copied-folder-loads-all-profiles-with-its-own-key");
            var keyFile = Path.Combine(copy, "portable.key"); var key = File.ReadAllBytes(keyFile);
            File.Delete(keyFile);
            bool rejected = false; try { _ = new ProfileStore(copy); } catch (InvalidOperationException) { rejected = true; }
            Require(rejected && !File.Exists(keyFile), "Missing key was silently recreated");
            rejected = false; try { copied.Save("clash", new JsonObject { ["test"] = true }); } catch (InvalidOperationException) { rejected = true; }
            Require(rejected && !File.Exists(keyFile), "Live save recreated a missing key");
            File.WriteAllBytes(keyFile, key); Require(copied.Load("clash").ToJsonString() == store.Load("clash").ToJsonString(), "Missing-key failure overwrote profile");
            Pass("missing-key-rejected-without-regeneration-or-overwrite");
            var target = Path.Combine(copy, "clash.protected"); var original = File.ReadAllBytes(target); var damaged = original.ToArray(); damaged[^1] ^= 1;
            File.WriteAllBytes(target, damaged); rejected = false;
            try { copied.Load("clash"); } catch (InvalidOperationException) { rejected = true; }
            Require(rejected, "Tampered ciphertext accepted"); File.WriteAllBytes(target, original);
            var wrongKey = key.ToArray(); wrongKey[0] ^= 1; File.WriteAllBytes(keyFile, wrongKey); rejected = false;
            try { copied.Load("clash"); } catch (InvalidOperationException) { rejected = true; }
            Require(rejected, "Wrong key accepted"); File.WriteAllBytes(keyFile, key);
            Pass("authentication-rejects-tampering-and-wrong-key");
            var before = File.ReadAllBytes(target); copied.Save("clash", copied.Load("clash"));
            Require(!before.SequenceEqual(File.ReadAllBytes(target)), "AES nonce reused on save"); Pass("save-uses-fresh-authenticated-encryption");
            string blockedRoot = Path.Combine(root, "rollback"); Paths.PrivateDirectory(blockedRoot);
            foreach (var id in ProfileStore.Ids) Vault.SaveLegacyForTest(Path.Combine(blockedRoot, id + ".protected"), expected);
            var snapshots = Directory.GetFiles(blockedRoot).ToDictionary(p => p, File.ReadAllBytes);
            rejected = false;
            using (var blocked = new FileStream(Path.Combine(blockedRoot, "researchlab.protected"), FileMode.Open, FileAccess.Read, FileShare.Read))
                try { _ = new ProfileStore(blockedRoot); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { rejected = true; }
            Require(rejected && snapshots.All(p => File.ReadAllBytes(p.Key).SequenceEqual(p.Value)) && !File.Exists(Path.Combine(blockedRoot, "portable.key")), "Migration failure did not roll back");
            _ = new ProfileStore(blockedRoot); Require(Directory.GetFiles(blockedRoot, "*.protected").All(Vault.IsPortable), "Migration retry failed");
            Pass("migration-write-failure-rolls-back-and-retries");
            var stable = Directory.GetFiles(legacyRoot).ToDictionary(p => p, File.ReadAllBytes); _ = new ProfileStore(legacyRoot);
            Require(stable.All(p => File.ReadAllBytes(p.Key).SequenceEqual(p.Value)), "Second startup rewrote valid portable files");
            Pass("portable-startup-is-idempotent");
        }
        catch (Exception e) { error = e is InvalidOperationException ? e.Message : e.GetType().Name; }
        finally
        {
            var absolute = Path.GetFullPath(root);
            if (absolute.StartsWith(Path.GetFullPath(Paths.Local) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) && Path.GetFileName(absolute).StartsWith("portable-test-")) Directory.Delete(absolute, true);
        }
        Paths.Atomic(report, JsonSerializer.Serialize(new { success = error == null, error, results }, new JsonSerializerOptions { WriteIndented = true }));
        return error == null ? 0 : 1;
    }
    public static int VerifyPackage(string report)
    {
        try
        {
            var store = new ProfileStore();
            Require(ProfileStore.Ids.All(store.Has), "便携包缺少线路配置。");
            foreach (var id in ProfileStore.Ids)
            {
                _ = store.Load(id);
                Require(Vault.IsPortable(Path.Combine(Paths.Data, id + ".protected")), "仍有绑定原电脑的配置。");
                Require(File.Exists(Configuration.Core(id)), "便携包缺少核心。");
            }
            _ = store.Policy; string? subscription = store.Subscription;
            if (subscription != null) Require(Vault.IsPortable(Path.Combine(Paths.Data, "subscription.protected")), "订阅未转换为便携配置。");
            Paths.Atomic(report, JsonSerializer.Serialize(new { success = true, profiles = ProfileStore.Ids, subscriptionIncluded = subscription != null, keyBytes = new FileInfo(Path.Combine(Paths.Data, "portable.key")).Length }));
            return 0;
        }
        catch (Exception e)
        {
            Paths.Atomic(report, JsonSerializer.Serialize(new { success = false, error = e is InvalidOperationException ? e.Message : e.GetType().Name })); return 1;
        }
    }
}
