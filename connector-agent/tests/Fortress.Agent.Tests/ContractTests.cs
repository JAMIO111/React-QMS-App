using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Fortress.Agent.Core;

namespace Fortress.Agent.Tests;

/// <summary>The agent against connector-agent/contract: the same files the API's tests read.</summary>
public class ContractTests
{
    private static JsonNode Fixture(string name) => JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "contract", name)))!;

    [Fact]
    public void Builds_the_same_canonical_string_and_accepts_the_vector_signature()
    {
        var v = Fixture("signature-vector.json");
        var body = Encoding.UTF8.GetBytes(v["body"]!.GetValue<string>());
        Assert.Equal(v["bodySha256"]!.GetValue<string>(), RequestSigner.Sha256Hex(body));
        var canonical = RequestSigner.CanonicalString(v["method"]!.GetValue<string>(), v["path"]!.GetValue<string>(), body,
            v["timestamp"]!.GetValue<string>(), v["nonce"]!.GetValue<string>(), v["agentId"]!.GetValue<string>());
        Assert.Equal(v["canonical"]!.GetValue<string>(), canonical);

        using var key = ECDsa.Create();
        key.ImportSubjectPublicKeyInfo(Convert.FromBase64String(v["publicKey"]!.GetValue<string>()), out _);
        var headers = new SignedHeaders(v["agentId"]!.GetValue<string>(), v["timestamp"]!.GetValue<string>(), v["nonce"]!.GetValue<string>(), v["signature"]!.GetValue<string>());
        Assert.True(RequestSigner.Verify(key, "POST", v["path"]!.GetValue<string>(), body, v["agentId"]!.GetValue<string>(), headers));
        // Anything changed after signing is refused.
        Assert.False(RequestSigner.Verify(key, "POST", v["path"]!.GetValue<string>(), Encoding.UTF8.GetBytes(v["body"]!.GetValue<string>() + " "), v["agentId"]!.GetValue<string>(), headers));
        Assert.False(RequestSigner.Verify(key, "POST", "/api/v1/integrations/agent/deregister", body, v["agentId"]!.GetValue<string>(), headers));
        Assert.Equal(v["fingerprint"]!.GetValue<string>(), RequestSigner.Fingerprint(v["publicKey"]!.GetValue<string>()));
    }

    [Fact]
    public void Its_signatures_are_64_byte_r_and_s_over_a_lowercase_nonce()
    {
        using var id = TestIdentity.Make();
        var body = "{}"u8.ToArray();
        var h = RequestSigner.Sign(id.SigningKey, "post", "/api/v1/integrations/agent/heartbeat", body, id.AgentId, DateTimeOffset.FromUnixTimeSeconds(1794787200), "ABCDEF0123456789ABCDEF0123456789");
        Assert.Equal(64, Convert.FromBase64String(h.Signature).Length);
        Assert.Equal("1794787200", h.Timestamp);
        using var pub = TestIdentity.PublicHalf(id);
        Assert.True(RequestSigner.Verify(pub, "POST", "/api/v1/integrations/agent/heartbeat", body, id.AgentId, h with { Nonce = "abcdef0123456789abcdef0123456789" }));
        Assert.Null(RequestSigner.Sign(id.SigningKey, "POST", "/x", body, RequestSigner.RegistrationSubject, DateTimeOffset.UtcNow).AgentId);
    }

    private static string[] Fields(JsonNode node) => node.AsObject().Select(p => p.Key).Order(StringComparer.Ordinal).ToArray();

    private static JsonNode Serialised(object body) => JsonNode.Parse(JsonSerializer.Serialize(body, AgentApiClient.Json))!;

    [Fact]
    public void Sends_exactly_the_fields_of_each_contract_message()
    {
        var caps = JobHandlers.Default().Capabilities();
        Assert.Equal(Fields(Fixture("messages/register.json")),
            Fields(Serialised(new RegisterRequest("FAGT-x", "k", "s", "0.1.0", "os", "m", caps))));
        Assert.Equal(Fields(Fixture("messages/register.json")["capabilities"]!), Fields(caps));
        Assert.Equal(Fields(Fixture("messages/heartbeat.json")), Fields(Serialised(new HeartbeatRequest("0.1.0", "os", "m", caps, 42))));
        // AG6b: after an update the heartbeat also says how it went, once.
        var report = Serialised(new HeartbeatRequest("0.7.0", "os", "m", caps, 5) { UpdateReport = new UpdateReport("u", "rolled_back", "did not check in") });
        Assert.Equal(Fields(Fixture("messages/heartbeat-update.json")), Fields(report));
        Assert.Equal(Fields(Fixture("messages/heartbeat-update.json")["updateReport"]!), Fields(report["updateReport"]!));
        Assert.Equal(Fields(Fixture("messages/fail.json")), Fields(Serialised(new JobFailure("invalid", "x", false))));
        Assert.Equal(Fields(Fixture("messages/progress.json")), Fields(Serialised(new { progress = new JsonObject { ["rows"] = 1 } })));
    }

    [Fact]
    public async Task The_ping_answer_has_the_fields_of_the_contract()
    {
        var result = await new PingHandler().RunAsync(new AgentJob { Id = "j", Kind = "ping" }, new JobContext((_, _) => Task.FromResult(true), TimeProvider.System), default);
        Assert.Equal(Fields(Fixture("messages/complete-ping.json")["result"]!), Fields(result!));
        Assert.True(result!["pong"]!.GetValue<bool>());
    }
}
