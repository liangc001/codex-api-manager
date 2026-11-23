using System.Net;
using System.Net.Sockets;

namespace CampusLink;

internal sealed class AgyEndpoint : IAsyncDisposable
{
    private readonly TcpListener listener;
    private readonly CancellationTokenSource shutdown = new();
    private readonly object sync = new();
    private readonly HashSet<Task> connections = new();
    private readonly Task accept;
    private (int Port, CancellationTokenSource Cancel)? upstream;
    internal int Port => ((IPEndPoint)listener.LocalEndpoint).Port;

    internal AgyEndpoint(int port)
    {
        listener = new TcpListener(IPAddress.Loopback, port) { ExclusiveAddressUse = true };
        try { listener.Start(); }
        catch { listener.Stop(); shutdown.Dispose(); throw; }
        accept = Accept();
    }

    internal void SetUpstream(int? port)
    {
        lock (sync)
        {
            if (upstream is { } old) { old.Cancel.Cancel(); old.Cancel.Dispose(); }
            upstream = port is int ready ? (ready, new CancellationTokenSource()) : null;
        }
    }

    private async Task Accept()
    {
        try
        {
            while (true)
            {
                var client = await listener.AcceptTcpClientAsync(shutdown.Token).ConfigureAwait(false);
                lock (sync)
                {
                    connections.RemoveWhere(task => task.IsCompleted);
                    if (upstream is not { } target || connections.Count >= 128) { client.Dispose(); continue; }
                    connections.Add(Bridge(client, target.Port, target.Cancel.Token));
                }
            }
        }
        catch (OperationCanceledException) when (shutdown.IsCancellationRequested) { }
        catch (SocketException) when (shutdown.IsCancellationRequested) { }
    }

    private static async Task Bridge(TcpClient client, int port, CancellationToken ct)
    {
        using (client)
        using (var target = new TcpClient(AddressFamily.InterNetwork))
        using (var link = CancellationTokenSource.CreateLinkedTokenSource(ct))
        {
            try
            {
                await target.ConnectAsync(IPAddress.Loopback, port, link.Token).ConfigureAwait(false);
                client.NoDelay = target.NoDelay = true;
                async Task Copy(TcpClient source, TcpClient destination)
                {
                    try
                    {
                        await source.GetStream().CopyToAsync(destination.GetStream(), link.Token).ConfigureAwait(false);
                        destination.Client.Shutdown(SocketShutdown.Send);
                    }
                    catch (Exception e) when (e is IOException or SocketException or OperationCanceledException or ObjectDisposedException)
                    { await link.CancelAsync().ConfigureAwait(false); }
                }
                await Task.WhenAll(Copy(client, target), Copy(target, client)).ConfigureAwait(false);
            }
            catch (Exception e) when (e is IOException or SocketException or OperationCanceledException or ObjectDisposedException) { }
        }
    }

    public async ValueTask DisposeAsync()
    {
        shutdown.Cancel();
        await accept.ConfigureAwait(false);
        SetUpstream(null);
        listener.Stop();
        await Task.WhenAll(connections).ConfigureAwait(false);
        shutdown.Dispose();
    }
}
