using Microsoft.Win32;
using System.Security.Cryptography;

namespace CampusLink;

public sealed record ClientPreferences
{
    public bool AutoRecover { get; init; } = true;
    public bool AutoConnect { get; init; }
    public string LastMode { get; init; } = "system";
    public string LastRegion { get; init; } = ExitCatalog.Auto;
    public Dictionary<string, string> LastLines { get; init; } = new();
}

public sealed class PreferencesStore
{
    private readonly string file;
    private readonly object sync = new();
    public ClientPreferences Value { get; private set; }
    public PreferencesStore(string? file = null)
    {
        this.file = file ?? Path.Combine(Paths.Data, "preferences.json");
        try { Value = Validate(JsonSerializer.Deserialize<ClientPreferences>(File.ReadAllText(this.file)) ?? new()); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException or ArgumentException) { Value = new(); }
    }
    private static bool Region(string? value) => value == ExitCatalog.Auto || value is { Length: 2 } && value.All(c => c is >= 'A' and <= 'Z');
    private static ClientPreferences Validate(ClientPreferences value) => value with
    {
        LastRegion = Region(value.LastRegion) ? value.LastRegion : ExitCatalog.Auto,
        LastMode = value.LastMode == "app" ? "app" : "system",
        LastLines = (value.LastLines ?? new()).Where(p => Region(p.Key) && p.Value != null &&
            p.Value.Length == 64 && p.Value.All(Uri.IsHexDigit)).Take(64).ToDictionary(p => p.Key, p => p.Value)
    };
    public void Update(Func<ClientPreferences, ClientPreferences> update)
    {
        lock (sync)
        {
            var next = Validate(update(Value));
            Paths.Atomic(file, JsonSerializer.Serialize(next, new JsonSerializerOptions { WriteIndented = true }));
            Value = next;
        }
    }
    internal static string LineKey(ExitCatalog.CandidateLine line) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(line.Profile + "\n" + line.Raw.ToJsonString())));
    internal void Remember(string region, string key) => Update(p => p with
    {
        LastRegion = region, LastLines = new(p.LastLines) { [region] = key }
    });
}

internal static class StartupRegistration
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string Name = "CampusLinkVPN";
    internal static string Command(string executable) => "\"" + Path.GetFullPath(executable) + "\" --startup";
    internal static bool Enabled
    {
        get { using var key = Registry.CurrentUser.OpenSubKey(RunKey); return key?.GetValue(Name) as string == Command(Paths.Executable); }
        set
        {
            using var key = Registry.CurrentUser.CreateSubKey(RunKey);
            if (value) key.SetValue(Name, Command(Paths.Executable), RegistryValueKind.String);
            else if (key.GetValue(Name) as string == Command(Paths.Executable)) key.DeleteValue(Name, false);
        }
    }
}

internal sealed class RecoverySchedule
{
    internal int Failures { get; private set; }
    internal int Attempts { get; private set; }
    internal DateTimeOffset NextAttempt { get; private set; }
    internal void Reset() { Failures = 0; Attempts = 0; NextAttempt = DateTimeOffset.MinValue; }
    internal void Observe(bool ok) { if (ok) Reset(); else Failures++; }
    internal bool Due(DateTimeOffset now) => Failures >= 2 && now >= NextAttempt;
    internal void Attempt(DateTimeOffset now)
    {
        Attempts++;
        NextAttempt = now.AddSeconds(Math.Min(120, 15 * Math.Pow(2, Math.Min(Attempts - 1, 3))));
    }
}
