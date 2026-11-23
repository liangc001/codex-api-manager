namespace CampusLink;

public sealed partial class ConnectionService
{
    private Task<LatencySample> MeasureNormalLatency(int port, CancellationToken ct) =>
        latencyProbe?.Invoke(port, ct) ?? Connectivity.MeasureLatency(port, ct);
    private readonly Task latencyMonitor;
    private Running? latencyConnection;
    private int latencyEpoch;
    private bool latencyInFlight;
    private TaskCompletionSource? latencyCompletion;
    private DateTimeOffset nextLatencyCheck;
    public LatencySample? Latency { get; private set; }
    public event Action? LatencyChanged;

    private void SetLatency(LatencySample? sample)
    {
        Latency = sample;
        LatencyChanged?.Invoke();
    }

    private void ObserveLatencyConnection()
    {
        if (ReferenceEquals(latencyConnection, current)) return;
        latencyConnection = current;
        recoverySchedule.Reset();
        latencyEpoch = Volatile.Read(ref networkEpoch);
        nextLatencyCheck = DateTimeOffset.MinValue;
        SetLatency(current == null ? null : LatencySample.Pending);
    }

    public async Task RefreshLatency()
    {
        Running selected;
        int epoch;
        TaskCompletionSource completion;
        await gate.WaitAsync(lifetime.Token);
        try
        {
            if (current == null || current.Process.HasExited || State.Busy || latencyInFlight) return;
            selected = current;
            epoch = Volatile.Read(ref networkEpoch);
            latencyInFlight = true;
            latencyCompletion = completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
            SetLatency(LatencySample.Pending);
        }
        finally { gate.Release(); }
        LatencySample? sample = null;
        try { sample = await MeasureNormalLatency(selected.Port, lifetime.Token); }
        finally
        {
            await gate.WaitAsync();
            try
            {
                latencyInFlight = false;
                // Discard results from an old core or a previous network environment.
                if (sample != null && ReferenceEquals(current, selected) && epoch == Volatile.Read(ref networkEpoch))
                {
                    latencyEpoch = epoch;
                    recoverySchedule.Observe(sample.Milliseconds.HasValue);
                    nextLatencyCheck = DateTimeOffset.UtcNow.AddSeconds(sample.Milliseconds == null && recoverySchedule.Failures == 1 ? 3 : 30);
                    SetLatency(sample);
                    if (State.Health is { } health && !State.Busy)
                    {
                        bool ok = sample.Milliseconds.HasValue;
                        Set(State with
                        {
                            Health = health with { InternetOk = ok },
                            Message = ok ? (State.Phase is "external" or "modified" ? State.Message : "当前线路 HTTPS 检测通过。")
                                : "当前线路 HTTPS 检测失败，请重新连接所选地区或选择其他线路。"
                        });
                    }
                }
            }
            finally { gate.Release(); completion.TrySetResult(); }
        }
    }

    private async Task WaitForLatencyShutdown()
    {
        Task pending;
        await gate.WaitAsync();
        try { pending = latencyCompletion?.Task ?? Task.CompletedTask; }
        finally { gate.Release(); }
        // A manual refresh also needs to finish before the semaphore is disposed.
        await pending;
    }

    internal void CancelRecovery()
    {
        Interlocked.Increment(ref recoveryRevision);
        try { recoveryOperation?.Cancel(); } catch (ObjectDisposedException) { }
    }

    internal async Task TryRecoverNormal()
    {
        string? region = null; int revision = 0, epoch = 0;
        if (!await gate.WaitAsync(0, lifetime.Token)) return;
        try
        {
            if (current != null && !current.Process.HasExited && !State.Busy && State.Health?.Country != null && OwnedPhase == "connected" &&
                Preferences.Value.AutoRecover && recoverySchedule.Due(DateTimeOffset.UtcNow))
            {
                region = State.RequestedRegion ?? ExitCatalog.Auto;
                revision = Volatile.Read(ref recoveryRevision); epoch = Volatile.Read(ref networkEpoch);
            }
        }
        finally { gate.Release(); }
        if (region == null) return;
        try { await ConnectRegion(region, automaticRecovery: true, revision: revision, epoch: epoch); }
        catch (InvalidOperationException) { /* Connection state carries the recovery result. */ }
    }

    private async Task MonitorLatency()
    {
        try
        {
            while (!lifetime.IsCancellationRequested)
            {
                await Task.Delay(1000, lifetime.Token);
                if (!await gate.WaitAsync(0, lifetime.Token)) continue;
                bool measure = false;
                try
                {
                    if (current == null || State.Busy || current.Process.HasExited) continue;
                    int epoch = Volatile.Read(ref networkEpoch);
                    if (latencyEpoch != epoch)
                    {
                        latencyEpoch = epoch;
                        recoverySchedule.Reset();
                        nextLatencyCheck = DateTimeOffset.UtcNow.AddSeconds(2);
                        SetLatency(LatencySample.Pending);
                    }
                    measure = !latencyInFlight && DateTimeOffset.UtcNow >= nextLatencyCheck;
                }
                finally { gate.Release(); }
                if (measure)
                {
                    try { await RefreshLatency(); await TryRecoverNormal(); }
                    catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { throw; }
                    catch (Exception)
                    {
                        nextLatencyCheck = DateTimeOffset.UtcNow.AddSeconds(30);
                        AddLog("延迟检测未完成，将稍后重试。");
                    }
                }
            }
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
    }
}
