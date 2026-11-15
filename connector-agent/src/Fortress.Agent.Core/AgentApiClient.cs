using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Fortress.Agent.Core;

/// <summary>
/// The agent's side of the API (`/integrations/agent/...`, api/src/integrations/agents/agents.controller.ts). Every request is signed; the agent
/// only ever calls out. Bodies are serialised once and the same bytes are hashed and sent, so the signature always matches what the server reads.
/// </summary>
public sealed class AgentApiClient(HttpClient http, TimeProvider? clock = null)
{
    private readonly TimeProvider clock = clock ?? TimeProvider.System;

    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>Register with a one-time token. Signed with the key being registered (the API checks the agent holds it).</summary>
    public async Task<RegisterResponse> RegisterAsync(string apiUrl, RegisterRequest body, ECDsa signingKey, CancellationToken ct)
    {
        using var res = await SendAsync(apiUrl, "integrations/agent/register", body, signingKey, RequestSigner.RegistrationSubject, ct);
        return await ReadAsync<RegisterResponse>(res, ct) ?? throw new AgentApiException(0, "empty", "Fortress sent no answer to the registration");
    }

    public async Task<HeartbeatResponse> HeartbeatAsync(AgentIdentity id, HeartbeatRequest body, CancellationToken ct)
    {
        using var res = await SendAsync(id, "integrations/agent/heartbeat", body, ct);
        return await ReadAsync<HeartbeatResponse>(res, ct) ?? new HeartbeatResponse();
    }

    /// <summary>The next job leased to this agent, or null when there is none (204).</summary>
    public async Task<AgentJob?> NextJobAsync(AgentIdentity id, CancellationToken ct)
    {
        using var res = await SendAsync(id, "integrations/agent/jobs/next", null, ct);
        return res.StatusCode == HttpStatusCode.NoContent ? null : await ReadAsync<AgentJob>(res, ct);
    }

    public Task<JobReportResponse> AckAsync(AgentIdentity id, string jobId, CancellationToken ct) => ReportAsync(id, jobId, "ack", null, ct);

    public Task<JobReportResponse> ProgressAsync(AgentIdentity id, string jobId, JsonObject progress, CancellationToken ct) =>
        ReportAsync(id, jobId, "progress", new { progress }, ct);

    public Task<JobReportResponse> CompleteAsync(AgentIdentity id, string jobId, JsonNode? result, CancellationToken ct) =>
        ReportAsync(id, jobId, "complete", new { result }, ct);

    public Task<JobReportResponse> FailAsync(AgentIdentity id, string jobId, JobFailure failure, CancellationToken ct) =>
        ReportAsync(id, jobId, "fail", failure, ct);

    /// <summary>Replace the agent's keys. Signed with the current key; every later request must be signed with the new one.</summary>
    public async Task RotateKeysAsync(AgentIdentity id, string signingKey, string sealingKey, CancellationToken ct)
    {
        using var res = await SendAsync(id, "integrations/agent/keys/rotate", new { signingKey, sealingKey }, ct);
    }

    /// <summary>The agent is being uninstalled: it revokes itself so its key can never be used again.</summary>
    public async Task DeregisterAsync(AgentIdentity id, CancellationToken ct)
    {
        using var res = await SendAsync(id, "integrations/agent/deregister", null, ct);
    }

    private async Task<JobReportResponse> ReportAsync(AgentIdentity id, string jobId, string action, object? body, CancellationToken ct)
    {
        using var res = await SendAsync(id, $"integrations/agent/jobs/{Uri.EscapeDataString(jobId)}/{action}", body, ct);
        return await ReadAsync<JobReportResponse>(res, ct) ?? new JobReportResponse();
    }

    private Task<HttpResponseMessage> SendAsync(AgentIdentity id, string relative, object? body, CancellationToken ct) =>
        SendAsync(id.ApiUrl, relative, body, id.SigningKey, id.AgentId, ct);

    private async Task<HttpResponseMessage> SendAsync(string apiUrl, string relative, object? body, ECDsa key, string agentId, CancellationToken ct)
    {
        var uri = Endpoint(apiUrl, relative);
        var bytes = body is null ? Array.Empty<byte>() : JsonSerializer.SerializeToUtf8Bytes(body, Json);
        var headers = RequestSigner.Sign(key, "POST", uri.PathAndQuery, bytes, agentId, clock.GetUtcNow());
        using var request = new HttpRequestMessage(HttpMethod.Post, uri) { Content = new ByteArrayContent(bytes) };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        if (headers.AgentId is not null) request.Headers.Add(RequestSigner.HeaderAgentId, headers.AgentId);
        request.Headers.Add(RequestSigner.HeaderTimestamp, headers.Timestamp);
        request.Headers.Add(RequestSigner.HeaderNonce, headers.Nonce);
        request.Headers.Add(RequestSigner.HeaderSignature, headers.Signature);
        request.Headers.UserAgent.Add(new ProductInfoHeaderValue("FortressConnectorAgent", AgentInfo.Version));

        HttpResponseMessage res;
        try
        {
            res = await http.SendAsync(request, ct);
        }
        catch (HttpRequestException e)
        {
            throw new AgentNetworkException($"Could not reach Fortress at {uri.Host}: {e.Message}", e);
        }
        catch (TaskCanceledException e) when (!ct.IsCancellationRequested)
        {
            throw new AgentNetworkException($"Fortress at {uri.Host} did not answer in time", e);
        }
        if (res.IsSuccessStatusCode) return res;
        using (res) throw await ErrorFromAsync(res, ct);
    }

    /// <summary>The API address with the agent route under it, keeping any path in the address (e.g. https://host/api/v1).</summary>
    public static Uri Endpoint(string apiUrl, string relative)
    {
        var baseUri = new Uri(apiUrl.TrimEnd('/') + "/", UriKind.Absolute);
        return new Uri(baseUri, relative);
    }

    private static async Task<T?> ReadAsync<T>(HttpResponseMessage res, CancellationToken ct)
    {
        if (res.StatusCode == HttpStatusCode.NoContent || res.Content.Headers.ContentLength == 0) return default;
        var text = await res.Content.ReadAsStringAsync(ct);
        return string.IsNullOrWhiteSpace(text) ? default : JsonSerializer.Deserialize<T>(text, Json);
    }

    private static async Task<AgentApiException> ErrorFromAsync(HttpResponseMessage res, CancellationToken ct)
    {
        var status = (int)res.StatusCode;
        string code = $"http_{status}", message = res.ReasonPhrase ?? "Request refused";
        try
        {
            var text = await res.Content.ReadAsStringAsync(ct);
            if (JsonNode.Parse(text)?["error"] is JsonObject error)
            {
                code = error["code"]?.GetValue<string>() ?? code;
                message = error["message"]?.GetValue<string>() ?? message;
            }
        }
        catch (JsonException)
        {
            // Not Fortress's error shape (a proxy page, say): keep the status words.
        }
        var retryAfter = res.Headers.RetryAfter?.Delta;
        return new AgentApiException(status, code, message, retryAfter);
    }
}

/// <summary>Fortress answered and refused. <see cref="Code"/> is the API's error code (agent_revoked, agent_clock, network_not_allowed…).</summary>
public sealed class AgentApiException(int status, string code, string message, TimeSpan? retryAfter = null) : Exception(message)
{
    public int Status { get; } = status;
    public string Code { get; } = code;
    public TimeSpan? RetryAfter { get; } = retryAfter;

    /// <summary>The agent's key no longer works: it was revoked in Fortress, or it deregistered. It must stop and be registered again.</summary>
    public bool Revoked => Code is "agent_revoked";

    /// <summary>Worth trying again later: rate limits, server trouble, a clock that may be put right.</summary>
    public bool Transient => Status is 0 or 408 or 429 or >= 500 || Code is "agent_clock";
}

/// <summary>Fortress could not be reached at all (DNS, proxy, TLS, timeout). Always tried again.</summary>
public sealed class AgentNetworkException(string message, Exception inner) : Exception(message, inner);

public sealed record RegisterRequest(
    string Token, string SigningKey, string SealingKey, string Version, string Os, string Machine, JsonObject? Capabilities);

public sealed record RegisterResponse
{
    public string AgentId { get; init; } = "";
    public string OrganisationId { get; init; } = "";
    public string OrganisationName { get; init; } = "";
    public string Name { get; init; } = "";
    public int PollSeconds { get; init; } = 60;
    public string Fingerprint { get; init; } = "";
}

public sealed record HeartbeatRequest(string Version, string Os, string Machine, JsonObject Capabilities, long UptimeSeconds);

public sealed record HeartbeatResponse
{
    public bool Revoked { get; init; }
    public bool JobsWaiting { get; init; }
    public DateTimeOffset? FastPollUntil { get; init; }
    public int PollSeconds { get; init; } = 60;
    public DateTimeOffset? ServerTime { get; init; }
}

public sealed record AgentJob
{
    public string Id { get; init; } = "";
    public string Kind { get; init; } = "";
    public JsonObject? Spec { get; init; }
    public int Attempt { get; init; }
    public DateTimeOffset? LeasedUntil { get; init; }
}

public sealed record JobReportResponse
{
    public string Status { get; init; } = "";
    public bool Cancelled { get; init; }
}

/// <summary>Why a job could not be done. <see cref="Kind"/> is one of auth, network, timeout, not_found, refused, invalid, internal.</summary>
public sealed record JobFailure(string Kind, string Message, bool? Transient = null);

public static class AgentInfo
{
    public static string Version { get; } =
        typeof(AgentInfo).Assembly.GetName().Version is { } v ? $"{v.Major}.{v.Minor}.{v.Build}" : "0.0.0";

    public static string OperatingSystem => System.Runtime.InteropServices.RuntimeInformation.OSDescription.Trim() is { Length: > 0 } os
        ? os[..Math.Min(os.Length, 120)] : "unknown";

    public static string Machine => Environment.MachineName is { Length: > 0 } m ? m[..Math.Min(m.Length, 120)] : "unknown";
}
