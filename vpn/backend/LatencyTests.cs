using System.Net;
using System.Net.Http;

namespace CampusLink;

internal static class LatencyTests
{
    private sealed class Handler(Func<CancellationToken, Task<HttpResponseMessage>> send) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            if (request.RequestUri?.AbsoluteUri != "https://www.google.com/generate_204") throw new InvalidOperationException("Unexpected latency target");
            return send(ct);
        }
    }
    internal static async Task<int> Run(string report)
    {
        var results = new List<string>(); string? error = null;
        void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
        try
        {
            using (var client = new HttpClient(new Handler(async ct => { await Task.Delay(70, ct); return new(HttpStatusCode.NoContent); })))
            {
                var sample = await Connectivity.MeasureLatency(client, default);
                Require(sample.Milliseconds is >= 55 && sample.CheckedAt != null && !sample.Checking, "HTTPS response duration not measured");
                results.Add("measures-response-time-and-records-timestamp");
            }
            using (var client = new HttpClient(new Handler(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden)))))
            {
                var sample = await Connectivity.MeasureLatency(client, default);
                Require(sample.Milliseconds == null && sample.CheckedAt != null, "Blocked response was reported as successful latency");
                results.Add("blocked-http-response-is-not-a-successful-latency");
            }
            using (var client = new HttpClient(new Handler(_ => throw new HttpRequestException("fixture"))))
            {
                var sample = await Connectivity.MeasureLatency(client, default);
                Require(sample.Milliseconds == null, "Transport failure converted to zero milliseconds");
                results.Add("transport-failure-never-displays-zero-ms");
            }
            using (var client = new HttpClient(new Handler(async ct => { await Task.Delay(Timeout.Infinite, ct); return new(HttpStatusCode.NoContent); })))
            using (var cancel = new CancellationTokenSource(50))
            {
                bool cancelled = false;
                try { await Connectivity.MeasureLatency(client, cancel.Token); } catch (OperationCanceledException) { cancelled = true; }
                Require(cancelled, "Application shutdown cancellation was swallowed");
                results.Add("shutdown-cancels-in-flight-measurement");
            }
        }
        catch (Exception e) { error = e is InvalidOperationException ? e.Message : e.GetType().Name; }
        Paths.Atomic(report, JsonSerializer.Serialize(new { success = error == null, error, results }, new JsonSerializerOptions { WriteIndented = true }));
        return error == null ? 0 : 1;
    }
}
