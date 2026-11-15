using System.Net;
using System.Text.Json.Nodes;
using Fortress.Agent.Core;
using Fortress.Agent.Host;

namespace Fortress.Agent.Tests;

public sealed class IdentityAndRegistrationTests : IDisposable
{
    private readonly string dir = Path.Combine(Path.GetTempPath(), "fortress-agent-tests-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
    }

    private IdentityStore Store() => new(Path.Combine(dir, "agent.json"), new FilePermissionKeyProtector());

    [Fact]
    public void Keeps_the_identity_and_both_keys_and_reads_them_back()
    {
        using var id = TestIdentity.Make();
        var store = Store();
        store.Save(id);
        using var back = store.Load()!;
        Assert.Equal(id.AgentId, back.AgentId);
        Assert.Equal(id.OrganisationName, back.OrganisationName);
        Assert.Equal(id.SigningPublicKey, back.SigningPublicKey);
        Assert.Equal(id.SealingPublicKey, back.SealingPublicKey);
        Assert.False(File.Exists(store.Path + ".tmp"));
        if (!OperatingSystem.IsWindows())
            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(store.Path));
        var text = File.ReadAllText(store.Path);
        Assert.Contains("\"protection\": \"file-permissions\"", text);
    }

    [Fact]
    public void Refuses_an_identity_written_by_a_newer_agent()
    {
        var store = Store();
        Directory.CreateDirectory(dir);
        File.WriteAllText(store.Path, """{"format":2,"apiUrl":"https://x","agentId":"a","signingKey":"","sealingKey":""}""");
        Assert.Throws<InvalidDataException>(() => store.Load());
        Assert.Null(new IdentityStore(Path.Combine(dir, "none.json"), new FilePermissionKeyProtector()).Load());
    }

    [Theory]
    [InlineData(null, "Give the registration token")]
    [InlineData("FAGT-short", "not a registration token")]
    [InlineData("fagt-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ", "not a registration token")]
    public void Checks_the_token(string? token, string words) => Assert.Contains(words, AgentRegistration.TokenProblem(token));

    [Theory]
    [InlineData("https://fortress.example.com/api/v1", null)]
    [InlineData("http://127.0.0.1:3000/api/v1", null)]
    [InlineData("http://localhost:3000/api/v1", null)]
    [InlineData("http://fortress.example.com/api/v1", "must start with https://")]
    [InlineData("https://me:secret@fortress.example.com/api/v1", "user name or password")]
    [InlineData("fortress.example.com", "Give Fortress's address")]
    public void Checks_the_address(string url, string? words)
    {
        var problem = AgentRegistration.ApiUrlProblem(url);
        if (words is null) Assert.Null(problem);
        else Assert.Contains(words, problem);
    }

    [Fact]
    public void Keeps_any_path_in_the_address() =>
        Assert.Equal("https://f.example.com/api/v1/integrations/agent/heartbeat",
            AgentApiClient.Endpoint("https://f.example.com/api/v1/", "integrations/agent/heartbeat").ToString());

    private const string Token = "FAGT-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

    [Fact]
    public async Task Registers_signed_with_the_new_key_and_keeps_the_identity_but_never_the_token()
    {
        var fake = new FakeFortress();
        fake.Routes["/integrations/agent/register"] = _ => FakeFortress.Json(new
        {
            agentId = "11111111-2222-4333-8444-555555555555", organisationId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            organisationName = "Acme Engineering", name = "Newcastle factory", pollSeconds = 60, fingerprint = "x",
        }, HttpStatusCode.Created);
        var store = Store();
        using var identity = await AgentRegistration.RegisterAsync(new AgentApiClient(new HttpClient(fake)), store, "https://fortress.example.com/api/v1/", Token,
            JobHandlers.Default(), replace: false, null, default);

        var r = Assert.Single(fake.Requests);
        Assert.Equal("/api/v1/integrations/agent/register", r.Path);
        Assert.Null(r.AgentId);
        Assert.True(r.SignatureValid);
        var body = JsonNode.Parse(r.Body)!;
        Assert.Equal(identity.SigningPublicKey, body["signingKey"]!.GetValue<string>());
        Assert.Equal(identity.SealingPublicKey, body["sealingKey"]!.GetValue<string>());
        Assert.NotEqual(body["signingKey"]!.GetValue<string>(), body["sealingKey"]!.GetValue<string>());
        Assert.Equal("ping", body["capabilities"]!["jobs"]![0]!.GetValue<string>());
        Assert.Equal("https://fortress.example.com/api/v1", identity.ApiUrl);
        Assert.Equal("Acme Engineering", store.Load()!.OrganisationName);
        Assert.DoesNotContain(Token, File.ReadAllText(store.Path));
    }

    [Fact]
    public async Task Will_not_register_over_an_identity_unless_told_to_and_keeps_nothing_when_refused()
    {
        var fake = new FakeFortress();
        fake.Routes["/integrations/agent/register"] = _ => FakeFortress.Error(HttpStatusCode.Conflict, "integration_rule", "This registration token has already been used");
        var store = Store();
        using (var existing = TestIdentity.Make()) store.Save(existing);
        var api = new AgentApiClient(new HttpClient(fake));
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            AgentRegistration.RegisterAsync(api, store, "https://f.example.com/api/v1", Token, JobHandlers.Default(), false, null, default));
        Assert.Empty(fake.Requests);
        var e = await Assert.ThrowsAsync<AgentApiException>(() =>
            AgentRegistration.RegisterAsync(api, store, "https://f.example.com/api/v1", Token, JobHandlers.Default(), true, null, default));
        Assert.Equal("integration_rule", e.Code);
        Assert.Equal("This registration token has already been used", e.Message);
        Assert.Equal("Newcastle factory", store.Load()!.Name);
    }

    [Fact]
    public void Parses_the_commands()
    {
        Assert.Equal("run", CommandLine.Parse([]).Command);
        var r = CommandLine.Parse(["register", "--api", "https://f.example.com/api/v1", "--token", Token, "--replace", "--data-dir", "/tmp/x"]);
        Assert.Null(r.Error);
        Assert.True(r.Replace);
        Assert.Equal("/tmp/x", r.DataDir);
        Assert.Contains("must start with https://", CommandLine.Parse(["register", "--api", "http://f.example.com", "--token", Token]).Error);
        Assert.Contains("Unknown command", CommandLine.Parse(["explode"]).Error);
        Assert.Contains("Unknown option", CommandLine.Parse(["status", "--loud"]).Error);
        Assert.True(CommandLine.Parse(["deregister", "--force"]).Force);
        Assert.Equal("help", CommandLine.Parse(["--help"]).Command);
    }
}
