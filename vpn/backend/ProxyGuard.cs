using Microsoft.Win32;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

namespace CampusLink;

public sealed record ProxySnapshot(int? Enable, string? Server, string? Bypass)
{
    private const string Key = @"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    public static ProxySnapshot Read()
    {
        using var key = Registry.CurrentUser.OpenSubKey(Key)!;
        return new(key.GetValue("ProxyEnable") is int v ? v : null, key.GetValue("ProxyServer") as string, key.GetValue("ProxyOverride") as string);
    }
    public void Write()
    {
        SyncWinInet();
        using var key = Registry.CurrentUser.OpenSubKey(Key, true)!;
        WriteValue(key, "ProxyEnable", Enable, RegistryValueKind.DWord);
        WriteValue(key, "ProxyServer", Server, RegistryValueKind.String);
        WriteValue(key, "ProxyOverride", Bypass, RegistryValueKind.String);
        Notify();
    }
    private static void WriteValue(RegistryKey key, string name, object? value, RegistryValueKind kind)
    { if (value == null) key.DeleteValue(name, false); else key.SetValue(name, value, kind); }
    [StructLayout(LayoutKind.Sequential)] private struct ConnectionOption { public int Option; public IntPtr Value; }
    [StructLayout(LayoutKind.Sequential)] private struct ConnectionOptions
    { public int Size; public IntPtr Connection; public int Count; public int Error; public IntPtr Options; }
    [DllImport("wininet.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool InternetSetOption(IntPtr handle, int option, IntPtr buffer, int length);
    [DllImport("wininet.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool InternetQueryOption(IntPtr handle, int option, IntPtr buffer, ref int length);
    [DllImport("kernel32.dll")] private static extern IntPtr GlobalFree(IntPtr memory);
    public static ProxySnapshot ReadEffective()
    {
        int itemSize = Marshal.SizeOf<ConnectionOption>(), listSize = Marshal.SizeOf<ConnectionOptions>();
        IntPtr items = Marshal.AllocHGlobal(itemSize * 3), list = Marshal.AllocHGlobal(listSize);
        bool queried = false;
        try
        {
            for (int i = 0; i < 3; i++) Marshal.StructureToPtr(new ConnectionOption { Option = i + 1 }, IntPtr.Add(items, itemSize * i), false);
            Marshal.StructureToPtr(new ConnectionOptions { Size = listSize, Count = 3, Options = items }, list, false);
            int length = listSize;
            if (!InternetQueryOption(IntPtr.Zero, 75, list, ref length)) throw new InvalidOperationException("无法核对 Windows 当前使用的代理。");
            queried = true;
            var flags = Marshal.PtrToStructure<ConnectionOption>(items).Value.ToInt64();
            var server = Marshal.PtrToStructure<ConnectionOption>(IntPtr.Add(items, itemSize)).Value;
            var bypass = Marshal.PtrToStructure<ConnectionOption>(IntPtr.Add(items, itemSize * 2)).Value;
            return new((flags & 2) != 0 ? 1 : 0, Marshal.PtrToStringUni(server), Marshal.PtrToStringUni(bypass));
        }
        finally
        {
            if (queried) for (int i = 1; i < 3; i++)
            {
                var pointer = Marshal.PtrToStructure<ConnectionOption>(IntPtr.Add(items, itemSize * i)).Value;
                if (pointer != IntPtr.Zero) GlobalFree(pointer);
            }
            Marshal.FreeHGlobal(items); Marshal.FreeHGlobal(list);
        }
    }
    public static bool SameEndpoint(ProxySnapshot? a, ProxySnapshot? b) => a != null && b != null &&
        (a.Enable == 1) == (b.Enable == 1) && (a.Enable != 1 || string.Equals(a.Server?.Trim(), b.Server?.Trim(), StringComparison.OrdinalIgnoreCase));
    public bool MatchesEffective() => SameEndpoint(this, ReadEffective());
    private void SyncWinInet()
    {
        // WinINet consumers use per-connection settings, which can disagree with the flat registry values.
        int itemSize = Marshal.SizeOf<ConnectionOption>(); int listSize = Marshal.SizeOf<ConnectionOptions>();
        IntPtr items = Marshal.AllocHGlobal(itemSize * 3), list = Marshal.AllocHGlobal(listSize);
        IntPtr server = IntPtr.Zero, bypass = IntPtr.Zero;
        try
        {
            Marshal.StructureToPtr(new ConnectionOption { Option = 1 }, items, false);
            Marshal.StructureToPtr(new ConnectionOptions { Size = listSize, Count = 1, Options = items }, list, false);
            int length = listSize;
            if (!InternetQueryOption(IntPtr.Zero, 75, list, ref length)) throw new InvalidOperationException("无法读取 Windows 代理连接设置。");
            long flags = Marshal.PtrToStructure<ConnectionOption>(items).Value.ToInt64();
            flags = (flags & ~2L) | 1L | (Enable == 1 ? 2L : 0L);
            server = Marshal.StringToHGlobalUni(Server ?? ""); bypass = Marshal.StringToHGlobalUni(Bypass ?? "");
            Marshal.StructureToPtr(new ConnectionOption { Option = 1, Value = new IntPtr(flags) }, items, false);
            Marshal.StructureToPtr(new ConnectionOption { Option = 2, Value = server }, IntPtr.Add(items, itemSize), false);
            Marshal.StructureToPtr(new ConnectionOption { Option = 3, Value = bypass }, IntPtr.Add(items, itemSize * 2), false);
            Marshal.StructureToPtr(new ConnectionOptions { Size = listSize, Count = 3, Options = items }, list, false);
            if (!InternetSetOption(IntPtr.Zero, 75, list, listSize)) throw new InvalidOperationException("无法同步 Windows 系统代理设置。");
        }
        finally
        {
            if (server != IntPtr.Zero) Marshal.FreeHGlobal(server);
            if (bypass != IntPtr.Zero) Marshal.FreeHGlobal(bypass);
            Marshal.FreeHGlobal(list); Marshal.FreeHGlobal(items);
        }
    }
    private static void Notify() { InternetSetOption(IntPtr.Zero, 39, IntPtr.Zero, 0); InternetSetOption(IntPtr.Zero, 37, IntPtr.Zero, 0); }
    public ProxySnapshot WithLiveBaseline()
    {
        // Do not leave Windows pointing at an original local proxy which has since exited.
        if (Enable != 1 || Server == null) return this;
        bool removed = false;
        var entries = new List<string>();
        foreach (var entry in Server.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var address = entry.Contains('=') ? entry[(entry.IndexOf('=') + 1)..].Trim() : entry;
            bool local = Regex.IsMatch(address, @"^(?:(?:https?|socks5?)://)?(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::|$)", RegexOptions.IgnoreCase);
            if (!local) { entries.Add(entry); continue; }
            bool alive = false;
            if (Uri.TryCreate(address.Contains("://") ? address : "http://" + address, UriKind.Absolute, out var uri) && uri.Port > 0 && uri.Port <= 65535)
            {
                using var tcp = new TcpClient();
                try { var task = tcp.ConnectAsync(uri.Host.Trim('[', ']'), uri.Port); alive = task.Wait(350) && tcp.Connected; } catch { }
            }
            if (alive) entries.Add(entry); else removed = true;
        }
        if (!removed) return this;
        return entries.Count == 0 ? this with { Enable = 0 } : this with { Server = string.Join(';', entries) };
    }
}

public sealed record ProxyLease(int OwnerPid, long OwnerStartTicks, ProxySnapshot Original, ProxySnapshot Owned, string[] RuntimeFiles, ProxySnapshot? PreviousOwned = null);

public interface ISystemProxy
{
    bool IsOwned { get; }
    bool BypassMatches { get; }
    void ProtectLifetime();
    void Apply(int port, params string[] runtimeFiles);
    string Restore();
}

public sealed class ProxyGuard(Func<string>? bypass = null) : ISystemProxy
{
    private ProxySnapshot? original;
    private Process? watchdog;
    internal int? WatchdogPid => watchdog?.Id;
    public void ProtectLifetime()
    {
        if (watchdog != null && !watchdog.HasExited) return;
        var start = new ProcessStartInfo(Paths.Executable) { UseShellExecute = false, CreateNoWindow = true };
        start.ArgumentList.Add("--watchdog"); start.ArgumentList.Add(Environment.ProcessId.ToString()); start.ArgumentList.Add(Paths.OwnerStartTicks.ToString());
        start.ArgumentList.Add(Paths.Local);
        watchdog = Process.Start(start) ?? throw new InvalidOperationException("无法启动代理恢复保护。");
    }
    private static bool SameEndpoint(ProxySnapshot? a, ProxySnapshot? b) => ProxySnapshot.SameEndpoint(a, b);
    private static Mutex EnterSettings()
    {
        var mutex = new Mutex(false, @"Local\CampusLink-ProxySettings-v1");
        try { if (!mutex.WaitOne(10000)) { mutex.Dispose(); throw new InvalidOperationException("系统代理正在恢复，请稍后重试。"); } }
        catch (AbandonedMutexException) { }
        return mutex;
    }
    public bool IsOwned
    {
        get
        {
            var lease = ReadLease();
            return lease?.OwnerPid == Environment.ProcessId && lease.OwnerStartTicks == Paths.OwnerStartTicks &&
                SameEndpoint(lease.Owned, ProxySnapshot.Read()) && lease.Owned.MatchesEffective();
        }
    }
    public bool BypassMatches => ReadLease()?.Owned.Bypass == ProxySnapshot.Read().Bypass;
    public static ProxyLease? ReadLease()
    {
        try { return JsonSerializer.Deserialize<ProxyLease>(File.ReadAllText(Paths.Lease)); } catch { return null; }
    }
    public void Apply(int port, params string[] runtimeFiles)
    {
        using var settings = EnterSettings();
        try { ApplyLocked(port, runtimeFiles); } finally { settings.ReleaseMutex(); }
    }
    private void ApplyLocked(int port, string[] runtimeFiles)
    {
        var before = ProxySnapshot.Read();
        var effective = ProxySnapshot.ReadEffective();
        var previousLease = ReadLease();
        using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Internet Settings"))
            if (key?.GetValue("AutoConfigURL") is string pac && !string.IsNullOrWhiteSpace(pac))
                throw new InvalidOperationException("系统正在使用自动代理脚本，请先在 Windows 中关闭自动代理脚本，再连接。");
        var originalBeforeAttempt = original;
        if (previousLease?.OwnerPid != Environment.ProcessId || !SameEndpoint(previousLease.Owned, before) || !SameEndpoint(previousLease.Owned, effective))
            original = SameEndpoint(previousLease?.Owned, before) && !SameEndpoint(previousLease?.Owned, effective) ? effective :
                previousLease == null && !SameEndpoint(before, effective) ? effective : before;
        else
        {
            original ??= previousLease.Original;
            if (before.Bypass != previousLease.Owned.Bypass) original = original with { Bypass = before.Bypass };
        }
        var owned = new ProxySnapshot(1, $"127.0.0.1:{port}", bypass?.Invoke() ?? Configuration.Bypass);
        var me = Process.GetCurrentProcess();
        var lease = new ProxyLease(me.Id, me.StartTime.ToUniversalTime().Ticks, original, owned, runtimeFiles,
            previousLease?.OwnerPid == me.Id ? previousLease.Owned : null);
        Paths.Atomic(Paths.Lease, JsonSerializer.Serialize(lease));
        try
        {
            ProtectLifetime();
            owned.Write();
            if (ProxySnapshot.Read() != owned || !owned.MatchesEffective()) throw new InvalidOperationException("系统代理设置未生效。");
            Paths.Atomic(Paths.Lease, JsonSerializer.Serialize(lease with { PreviousOwned = null }));
        }
        catch
        {
            try { before.Write(); }
            finally
            {
                original = originalBeforeAttempt;
                if (previousLease != null) Paths.Atomic(Paths.Lease, JsonSerializer.Serialize(previousLease));
                else if (File.Exists(Paths.Lease)) File.Delete(Paths.Lease);
            }
            throw;
        }
    }
    public string Restore()
    {
        var message = RestoreLease(Process.GetCurrentProcess().Id);
        original = null;
        return message;
    }
    public static string RestoreLease(int ownerPid)
    {
        using var settings = EnterSettings();
        try { return RestoreLocked(ownerPid); } finally { settings.ReleaseMutex(); }
    }
    private static string RestoreLocked(int ownerPid)
    {
        var lease = ReadLease();
        if (lease == null || lease.OwnerPid != ownerPid) return "";
        var result = "";
        var now = ProxySnapshot.Read();
        var effective = ProxySnapshot.ReadEffective();
        bool Ours(ProxySnapshot value) => SameEndpoint(value, lease.Owned) || SameEndpoint(value, lease.PreviousOwned);
        if (Ours(now) && Ours(effective))
        {
            var baseline = lease.Original.WithLiveBaseline();
            bool baselineExpired = !SameEndpoint(baseline, lease.Original);
            // A third party may edit only bypass entries while our listener is still selected.
            // Preserve those edits, but never strand Windows on our soon-to-stop endpoint.
            if (now.Bypass != lease.Owned.Bypass && now.Bypass != lease.PreviousOwned?.Bypass) baseline = baseline with { Bypass = now.Bypass };
            baseline.Write();
            result = baselineExpired ? "原本地代理已退出，已恢复直连。" : "已恢复原系统代理，并保留其他软件修改的绕行项。";
        }
        else if (Ours(now) != Ours(effective))
        {
            // Another program changed only one Windows settings source. Keep its endpoint,
            // and remove our soon-to-stop endpoint from the other source.
            var external = (Ours(now) ? effective : now).WithLiveBaseline(); external.Write();
            result = "已保留其他软件的代理设置，并同步 Windows 连接状态。";
        }
        else result = "系统代理已由其他程序修改，已保留它的新设置。";
        if (File.Exists(Paths.Lease)) File.Delete(Paths.Lease);
        foreach (var path in lease.RuntimeFiles)
        {
            try
            {
                var full = Path.GetFullPath(path);
                if (Path.GetDirectoryName(full) == Path.GetFullPath(Paths.Runtime) && Path.GetFileName(full).StartsWith("runtime-", StringComparison.Ordinal)) File.Delete(full);
            }
            catch { }
        }
        return result;
    }
    public static void RecoverStale()
    {
        var lease = ReadLease(); if (lease == null) return;
        bool alive;
        try { using var owner = Process.GetProcessById(lease.OwnerPid); alive = !owner.HasExited && owner.StartTime.ToUniversalTime().Ticks == lease.OwnerStartTicks; }
        catch { alive = false; }
        if (!alive) RestoreLease(lease.OwnerPid);
    }
    public static void Watch(int pid, long ticks)
    {
        try
        {
            using var parent = Process.GetProcessById(pid);
            if (parent.StartTime.ToUniversalTime().Ticks == ticks) parent.WaitForExit();
        }
        catch { }
        // Let the OS job close core handles before removing temporary configs.
        Thread.Sleep(300);
        var lease = ReadLease();
        if (lease?.OwnerPid == pid && lease.OwnerStartTicks == ticks)
            for (int attempt = 0; attempt < 3; attempt++)
                try { RestoreLease(pid); break; } catch { Thread.Sleep(250); }
        foreach (var path in Directory.GetFiles(Paths.Runtime, $"runtime-{pid}-{ticks}-*.json"))
        { try { File.Delete(path); } catch { } }
    }
}

public sealed class CoreJob : IDisposable
{
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong A, B, C, D, E, F; }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits
    { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr CreateJobObject(IntPtr attrs, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int type, IntPtr data, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    private IntPtr handle;
    public CoreJob()
    {
        handle = CreateJobObject(IntPtr.Zero, null);
        var limits = new ExtendedLimits { Basic = new BasicLimits { LimitFlags = 0x2000 } };
        var data = Marshal.AllocHGlobal(Marshal.SizeOf<ExtendedLimits>());
        try
        {
            Marshal.StructureToPtr(limits, data, false);
            if (handle == IntPtr.Zero || !SetInformationJobObject(handle, 9, data, (uint)Marshal.SizeOf<ExtendedLimits>())) throw new InvalidOperationException("无法初始化核心进程保护。");
        }
        finally { Marshal.FreeHGlobal(data); }
    }
    public void Assign(Process process)
    {
        if (!AssignProcessToJobObject(handle, process.Handle)) throw new InvalidOperationException("无法保护核心进程，已取消连接。");
    }
    public void Dispose() { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
}
