using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Fortress.Agent.Core;

namespace Fortress.Agent.Tests;

/// <summary>A stand-in for the API: records every request (checking its signature) and answers from a route table.</summary>
internal sealed class FakeFortress : HttpMessageHandler
{
    public sealed record Seen(string Method, string Path, string Body, string? AgentId, bool SignatureValid);

    public List<Seen> Requests { get; } = [];
    public Dictionary<string, Func<Seen, HttpResponseMessage>> Routes { get; } = new(StringComparer.Ordinal);

    /// <summary>The public key requests should be signed with (null: take it from the registration body).</summary>
    public ECDsa? Verifier { get; set; }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var bytes = request.Content is null ? [] : await request.Content.ReadAsByteArrayAsync(ct);
        var body = Encoding.UTF8.GetString(bytes);
        var path = request.RequestUri!.PathAndQuery;
        string? H(string name) => request.Headers.TryGetValues(name, out var v) ? v.First() : null;
        var agentId = H(RequestSigner.HeaderAgentId);
        var headers = new SignedHeaders(agentId, H(RequestSigner.HeaderTimestamp) ?? "", H(RequestSigner.HeaderNonce) ?? "", H(RequestSigner.HeaderSignature) ?? "");
        var verifier = Verifier;
        if (path.EndsWith("/register", StringComparison.Ordinal))
        {
            verifier = ECDsa.Create();
            verifier.ImportSubjectPublicKeyInfo(Convert.FromBase64String(JsonNode.Parse(body)!["signingKey"]!.GetValue<string>()), out _);
        }
        var valid = verifier is not null && headers.Signature.Length > 0 &&
                    RequestSigner.Verify(verifier, request.Method.Method, path, bytes, agentId ?? RequestSigner.RegistrationSubject, headers);
        var seen = new Seen(request.Method.Method, path, body, agentId, valid);
        Requests.Add(seen);
        var route = Routes.Keys.Where(k => path.EndsWith(k, StringComparison.Ordinal)).OrderByDescending(k => k.Length).FirstOrDefault();
        if (route is null) throw new InvalidOperationException($"No fake route for {path}");
        return Routes[route](seen);
    }

    public static HttpResponseMessage Json(object body, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(System.Text.Json.JsonSerializer.Serialize(body, AgentApiClientJson.Options), Encoding.UTF8, "application/json") };

    public static HttpResponseMessage Error(HttpStatusCode status, string code, string message) =>
        new(status) { Content = new StringContent(new JsonObject { ["error"] = new JsonObject { ["code"] = code, ["message"] = message } }.ToJsonString(), Encoding.UTF8, "application/json") };

    public static HttpResponseMessage NoContent() => new(HttpStatusCode.NoContent);
}

internal static class AgentApiClientJson
{
    public static readonly System.Text.Json.JsonSerializerOptions Options = new(System.Text.Json.JsonSerializerDefaults.Web);
}

internal static class TestIdentity
{
    public static AgentIdentity Make(string apiUrl = "https://fortress.example.com/api/v1")
    {
        var (s, e) = AgentIdentity.NewKeys();
        return new AgentIdentity
        {
            ApiUrl = apiUrl, AgentId = "11111111-2222-4333-8444-555555555555", OrganisationId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            OrganisationName = "Acme Engineering", Name = "Newcastle factory", RegisteredAt = DateTimeOffset.Parse("2026-11-15T09:00:00Z"), SigningKey = s, SealingKey = e,
        };
    }

    public static ECDsa PublicHalf(AgentIdentity id)
    {
        var k = ECDsa.Create();
        k.ImportSubjectPublicKeyInfo(Convert.FromBase64String(id.SigningPublicKey), out _);
        return k;
    }
}
