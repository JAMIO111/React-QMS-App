using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Fortress.Agent.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Fortress.Agent.Tests;

/// <summary>
/// AG6a: keys rotated every 90 days or on request, never locking the agent out (the new keys are written down first and taken up when Fortress
/// already has them), the previous sealing key kept so a password sealed just before still opens, and a bounded, redacted diagnostics bundle.
/// </summary>
public sealed class MaintenanceTests : IDisposable
{
    private readonly string dir = Path.Combine(Path.GetTempPath(), "fortress-agent-maint-" + Guid.NewGuid().ToString("N"));
    private readonly FakeFortress fake = new();
    private readonly Clock clock = new(DateTimeOffset.Parse("2026-11-16T09:00:00Z"));
    private readonly AgentIdentity id = TestIdentity.Make();
    private readonly IdentityStore store;
    private readonly List<string> rotatedTo = [];

    public MaintenanceTests()
    {
        Directory.CreateDirectory(dir);
        store = new IdentityStore(Path.Combine(dir, "agent.json"), new FilePermissionKeyProtector());
        store.Save(id);
        fake.Verifier = TestIdentity.PublicHalf(id);
        fake.Routes["/integrations/agent/keys/rotate"] = seen =>
        {
            if (!seen.SignatureValid) return FakeFortress.Error(HttpStatusCode.Unauthorized, "agent_unauthenticated", "The request's signature does not match this agent's key");
            var signing = JsonNode.Parse(seen.Body)!["signingKey"]!.GetValue<string>();
            rotatedTo.Add(signing);
            fake.Verifier = Public(signing);
            return FakeFortress.Json(new { rotated = true });
        };
    }

    public void Dispose()
    {
        id.Dispose();
        if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
    }

    private sealed class Clock(DateTimeOffset now) : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = now;
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private static System.Security.Cryptography.ECDsa Public(string spki)
    {
        var k = System.Security.Cryptography.ECDsa.Create();
        k.ImportSubjectPublicKeyInfo(Convert.FromBase64String(spki), out _);
        return k;
    }

    private KeyRotation Rotation => new(store, NullLogger.Instance, clock);
    private AgentApiClient Api => new(new HttpClient(fake));

    [Fact]
    public void Rotation_is_due_after_90_days_or_when_a_rotation_did_not_finish()
    {
        clock.Now = id.RegisteredAt.AddDays(89);
        Assert.False(Rotation.Due(id));
        clock.Now = id.RegisteredAt.AddDays(90);
        Assert.True(Rotation.Due(id));
        clock.Now = id.RegisteredAt.AddDays(1);
        id.PendingSigningKey = AgentIdentity.NewKeys().Signing;
        Assert.True(Rotation.Due(id));
    }

    [Fact]
    public async Task Rotates_signed_with_the_old_key_and_keeps_the_previous_sealing_key_for_30_days()
    {
        var oldSealing = id.SealingPublicKey;
        var fingerprint = await Rotation.RotateAsync(id, Api, default);
        Assert.Equal(id.Fingerprint, fingerprint);
        Assert.Single(rotatedTo);
        Assert.Equal(id.SigningPublicKey, rotatedTo[0]);
        Assert.True(fake.Requests[^1].SignatureValid);                           // the rotation itself was signed with the old key
        Assert.Equal(clock.Now, id.KeysCreatedAt);
        Assert.Equal(clock.Now.AddDays(30), id.PreviousSealingUntil);
        Assert.Equal(oldSealing, Convert.ToBase64String(id.PreviousSealingKey!.ExportSubjectPublicKeyInfo()));
        Assert.Null(id.PendingSigningKey);
        Assert.Equal(2, id.SealingKeys(clock.Now).Count);
        Assert.Single(id.SealingKeys(clock.Now.AddDays(31)));

        using var reloaded = store.Load()!;
        Assert.Equal(id.SigningPublicKey, reloaded.SigningPublicKey);
        Assert.Equal(oldSealing, Convert.ToBase64String(reloaded.PreviousSealingKey!.ExportSubjectPublicKeyInfo()));
        Assert.Null(reloaded.PendingSigningKey);
        Assert.Equal(clock.Now, reloaded.KeysCreatedAt);
    }

    [Fact]
    public async Task A_rotation_cut_off_half_way_is_finished_from_the_keys_written_down()
    {
        // Fortress takes the new keys, but the answer never reaches the agent.
        var inner = fake.Routes["/integrations/agent/keys/rotate"];
        fake.Routes["/integrations/agent/keys/rotate"] = seen =>
        {
            inner(seen);
            throw new HttpRequestException("connection reset");
        };
        await Assert.ThrowsAsync<AgentNetworkException>(() => Rotation.RotateAsync(id, Api, default));
        using (var written = store.Load()!)
        {
            Assert.NotNull(written.PendingSigningKey);                               // the new keys were on disk before Fortress was told
            Assert.Equal(rotatedTo[0], Convert.ToBase64String(written.PendingSigningKey!.ExportSubjectPublicKeyInfo()));
        }
        // The agent starts again from what is on disk; Fortress now refuses the old key, so the agent moves to the pending one.
        using var restarted = store.Load()!;
        Assert.True(new KeyRotation(store, NullLogger.Instance, clock).TryRecover(restarted));
        Assert.Equal(rotatedTo[0], restarted.SigningPublicKey);
        Assert.Null(store.Load()!.PendingSigningKey);
        Assert.False(new KeyRotation(store, NullLogger.Instance, clock).TryRecover(restarted));  // nothing left to take up
    }

    [Fact]
    public async Task New_keys_Fortress_refuses_are_forgotten_and_the_current_ones_kept()
    {
        fake.Routes["/integrations/agent/keys/rotate"] = _ => FakeFortress.Error(HttpStatusCode.BadRequest, "invalid_key", "The agent's keys must be two different P-256 public keys");
        var before = id.SigningPublicKey;
        await Assert.ThrowsAsync<AgentApiException>(() => Rotation.RotateAsync(id, Api, default));
        Assert.Equal(before, id.SigningPublicKey);
        Assert.Null(id.PendingSigningKey);
        Assert.Null(store.Load()!.PendingSigningKey);
    }

    [Fact]
    public async Task A_password_sealed_to_the_previous_key_still_opens()
    {
        var sealedFor = id.SealingPublicKey;
        await Rotation.RotateAsync(id, Api, default);
        var connection = "5f0c2b8e-3a51-4d6c-9e2f-7b8a1c4d0e93";
        var (epk, iv, ct) = SealedBox.Seal(sealedFor, connection, Encoding.UTF8.GetBytes("""{"username":"reader","password":"hunter2"}"""));
        var credentials = new CredentialStore(Path.Combine(dir, "credentials"), new FilePermissionKeyProtector());
        var handler = new StoreCredentialHandler(() => id.SealingKeys(clock.Now), credentials);
        var job = new AgentJob { Id = Guid.NewGuid().ToString(), Kind = "store_credential", Spec = new JsonObject { ["connectionId"] = connection, ["connection"] = new JsonObject { ["engine"] = "postgres", ["server"] = "db", ["database"] = "erp", ["authType"] = "password" }, ["sealed"] = new JsonObject { ["epk"] = epk, ["iv"] = iv, ["ct"] = ct } } };
        var ctx = new JobContext((_, _) => Task.FromResult(true), clock);
        await handler.RunAsync(job, ctx, default);
        Assert.Equal("hunter2", credentials.Load(connection, ConnectionTarget.Of((JsonObject)job.Spec!["connection"]!))!.Password);

        // After 30 days the previous key is no longer tried.
        var late = new StoreCredentialHandler(() => id.SealingKeys(clock.Now.AddDays(31)), credentials);
        var e = await Assert.ThrowsAsync<JobFailedException>(() => late.RunAsync(job, ctx, default));
        Assert.Contains("could not be opened", e.Message);
    }

    [Fact]
    public async Task The_runner_rotates_on_request_and_on_schedule()
    {
        var waits = 0;
        using var stop = new CancellationTokenSource();
        fake.Routes["/integrations/agent/heartbeat"] = _ => FakeFortress.Json(new { revoked = false, jobsWaiting = true, pollSeconds = 60, serverTime = clock.Now });
        var queue = new Queue<AgentJob>([new AgentJob { Id = Guid.NewGuid().ToString(), Kind = "rotate_keys", Spec = [] }]);
        fake.Routes["/integrations/agent/jobs/next"] = _ => queue.Count > 0 ? FakeFortress.Json(queue.Dequeue()) : FakeFortress.NoContent();
        fake.Routes["/ack"] = _ => FakeFortress.Json(new { status = "running", cancelled = false });
        JsonNode? completed = null;
        fake.Routes["/complete"] = seen =>
        {
            Assert.True(seen.SignatureValid);                                     // signed with the new key
            completed = JsonNode.Parse(seen.Body);
            return FakeFortress.Json(new { status = "completed", cancelled = false });
        };
        var runner = new AgentRunner(id, Api, new JobHandlers([new PingHandler(), new RotateKeysHandler()]), NullLogger<AgentRunner>.Instance, clock,
            (_, _) => { if (++waits >= 1) stop.Cancel(); return Task.CompletedTask; }, Rotation);
        await runner.RunAsync(stop.Token);
        Assert.Single(rotatedTo);
        Assert.Equal(id.Fingerprint, completed!["result"]!["fingerprint"]!.GetValue<string>());

        // 90 days on, the next cycle rotates again by itself.
        clock.Now = clock.Now.AddDays(90);
        waits = 0;
        using var stop2 = new CancellationTokenSource();
        var runner2 = new AgentRunner(id, Api, new JobHandlers([new PingHandler(), new RotateKeysHandler()]), NullLogger<AgentRunner>.Instance, clock,
            (_, _) => { stop2.Cancel(); return Task.CompletedTask; }, Rotation);
        await runner2.RunAsync(stop2.Token);
        Assert.Equal(2, rotatedTo.Count);
    }

    [Fact]
    public void Redacts_anything_shaped_like_a_secret_and_keeps_ids()
    {
        Assert.Equal("Authorization: Bearer [redacted]", DiagnosticsHandler.Redact("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc"));
        Assert.Equal("Server=x;Password=[redacted];", DiagnosticsHandler.Redact("Server=x;Password=hunter2;"));
        Assert.Equal("token FAGT-[redacted] used", DiagnosticsHandler.Redact("token FAGT-abc_DEF-123 used"));
        Assert.Equal("key [redacted]", DiagnosticsHandler.Redact("key MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEabcdefghijklmnop"));
        Assert.Equal("Job 6a1d3c9e-2b47-4f8a-9c3d-5e7f1a2b4c6d done in 12 ms", DiagnosticsHandler.Redact("Job 6a1d3c9e-2b47-4f8a-9c3d-5e7f1a2b4c6d done in 12 ms"));
    }

    [Fact]
    public async Task The_diagnostics_bundle_is_bounded_and_redacted()
    {
        var logs = Path.Combine(dir, "logs");
        Directory.CreateDirectory(logs);
        var lines = Enumerable.Range(1, 400).Select(i => $"2026-11-16 09:00:{i % 60:00} [INF] Job {i} done; Password=hunter2 " + new string('x', 400)).ToList();
        File.WriteAllLines(Path.Combine(logs, "agent-20261116.log"), lines);
        File.WriteAllText(Path.Combine(dir, "allowlist.json"), """{ "hosts": ["erp.factory.local"] }""");
        var handler = new DiagnosticsHandler(logs, Path.Combine(dir, "allowlist.json"), () => id, () => new JsonObject { ["jobs"] = new JsonArray("ping") });
        var bundle = (JsonObject)(await handler.RunAsync(new AgentJob { Id = "j", Kind = "diagnostics" }, new JobContext((_, _) => Task.FromResult(true), clock), default))!;
        var text = bundle.ToJsonString();
        Assert.True(Encoding.UTF8.GetByteCount(text) <= DiagnosticsHandler.MaxBytes);
        Assert.DoesNotContain("hunter2", text);
        Assert.Equal(AgentInfo.Version, bundle["version"]!.GetValue<string>());
        Assert.Equal(id.Fingerprint, bundle["keyFingerprint"]!.GetValue<string>());
        Assert.Contains("erp.factory.local", bundle["allowList"]!.GetValue<string>());
        var kept = bundle["log"]!.AsArray();
        Assert.InRange(kept.Count, 1, DiagnosticsHandler.MaxLogLines);
        Assert.Contains("Job 400 done", kept[^1]!.GetValue<string>());        // the newest lines are the ones kept
        Assert.Equal(kept.Count, bundle["logLines"]!.GetValue<int>());
    }
}
