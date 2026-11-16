using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Fortress.Agent.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Fortress.Agent.Tests;

/// <summary>
/// AG6b: the agent accepts only a release signed by a key built into it, for its platform and newer than itself; it downloads exactly the signed
/// bytes, unpacks them safely and stages them; it reports applied or rolled back once; the updater swaps, and puts the old version back when the
/// new one does not check in.
/// </summary>
public sealed class UpdateTests : IDisposable
{
    private readonly string dir = Directory.CreateTempSubdirectory("fortress-update-").FullName;
    private readonly ECDsa key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
    private string Spki => Convert.ToBase64String(key.ExportSubjectPublicKeyInfo());

    public void Dispose()
    {
        key.Dispose();
        Directory.Delete(dir, recursive: true);
    }

    private static byte[] Zip(params (string Name, string Text)[] files)
    {
        using var ms = new MemoryStream();
        using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
            foreach (var (name, text) in files)
            {
                using var w = new StreamWriter(zip.CreateEntry(name).Open());
                w.Write(text);
            }
        return ms.ToArray();
    }

    private static string Manifest(string version, byte[] package, string platform = "linux-x64", string url = "https://releases.example.com/agent.zip", long? size = null) =>
        new JsonObject
        {
            ["format"] = "fortress-agent-release-v1", ["version"] = version, ["platform"] = platform, ["url"] = url,
            ["sha256"] = Convert.ToHexStringLower(SHA256.HashData(package)), ["size"] = size ?? package.Length, ["notes"] = "Fixes",
        }.ToJsonString();

    private string Sign(string text, ECDsa? with = null) =>
        Convert.ToBase64String((with ?? key).SignData(Encoding.UTF8.GetBytes(text), HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation));

    private ReleaseManifest Verify(string manifest, string sig, string platform = "linux-x64", string current = "0.6.0") =>
        ReleaseManifest.Verify(manifest, sig, [Spki], platform, current);

    [Fact]
    public void Only_a_release_signed_by_a_built_in_key_for_this_platform_and_newer_is_read()
    {
        var pkg = Zip(("FortressAgent.dll", "new"));
        var m = Manifest("0.7.0", pkg);
        Assert.Equal("0.7.0", Verify(m, Sign(m)).Version);

        using var stranger = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        string Refusal(Action a) => Assert.Throws<JobFailedException>(a).Message;
        Assert.Contains("not signed by a key this agent trusts", Refusal(() => Verify(m, Sign(m, stranger))));
        Assert.Contains("not signed by a key this agent trusts", Refusal(() => Verify(m.Replace("Fixes", "Fixed"), Sign(m))));
        Assert.Contains("no release key built in", Refusal(() => ReleaseManifest.Verify(m, Sign(m), [], "linux-x64", "0.6.0")));
        Assert.Contains("runs on win-x64", Refusal(() => Verify(m, Sign(m), platform: "win-x64")));
        Assert.Contains("not newer", Refusal(() => Verify(m, Sign(m), current: "0.7.0")));
        Assert.Contains("not newer", Refusal(() => Verify(m, Sign(m), current: "1.0.0")));
        var http = Manifest("0.7.0", pkg, url: "http://releases.example.com/agent.zip");
        Assert.Contains("not https", Refusal(() => Verify(http, Sign(http))));
        var big = Manifest("0.7.0", pkg, size: ReleaseManifest.MaxSize + 1);
        Assert.Contains("size", Refusal(() => Verify(big, Sign(big))));
    }

    [Fact]
    public void Versions_compare_as_numbers()
    {
        Assert.True(ReleaseManifest.Compare("0.10.0", "0.9.9") > 0);
        Assert.True(ReleaseManifest.Compare("1.0.0", "1.0.0") == 0);
        Assert.True(ReleaseManifest.Compare("0.6.0", "junk") > 0);
        Assert.Null(ReleaseManifest.Parts("1.0"));
    }

    private sealed class Serve(byte[] body, HttpStatusCode status = HttpStatusCode.OK) : HttpMessageHandler
    {
        public int Calls;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Calls++;
            return Task.FromResult(new HttpResponseMessage(status) { Content = new ByteArrayContent(body), RequestMessage = request });
        }
    }

    private (UpdateHandler Handler, Serve Server) Handler(byte[] served)
    {
        var s = new Serve(served);
        return (new UpdateHandler(dir, () => new HttpClient(s), NullLogger.Instance, () => [Spki], () => "linux-x64", () => "0.6.0"), s);
    }

    private static AgentJob Job(string manifest, string signature, string version = "0.7.0") => new()
    {
        Id = "j1", Kind = "update_agent",
        Spec = new JsonObject { ["updateId"] = "u1", ["version"] = version, ["manifest"] = manifest, ["signature"] = signature },
    };

    private static JobContext Context() => new((_, _) => Task.FromResult(true), TimeProvider.System);

    [Fact]
    public async Task Stages_exactly_the_signed_package()
    {
        var pkg = Zip(("FortressAgent.dll", "new agent"), ("lib/helper.dll", "helper"));
        var m = Manifest("0.7.0", pkg);
        var (handler, _) = Handler(pkg);
        var result = await handler.RunAsync(Job(m, Sign(m)), Context(), CancellationToken.None);
        Assert.True(result!["staged"]!.GetValue<bool>());
        var pending = new UpdateFiles(dir).ReadPending()!;
        Assert.Equal(("u1", "0.7.0"), (pending.UpdateId, pending.Version));
        Assert.Equal("new agent", File.ReadAllText(Path.Combine(pending.Staged, "FortressAgent.dll")));
        Assert.Equal("helper", File.ReadAllText(Path.Combine(pending.Staged, "lib", "helper.dll")));
        Assert.False(File.Exists(Path.Combine(dir, "updates", "0.7.0", "package.zip")));
    }

    [Fact]
    public async Task Refuses_a_download_that_is_not_the_signed_one_or_unsafe_to_unpack()
    {
        var pkg = Zip(("FortressAgent.dll", "new agent"));
        var m = Manifest("0.7.0", pkg);
        var flipped = (byte[])pkg.Clone();
        flipped[flipped.Length / 2] ^= 0xff;
        async Task<string> Fails(byte[] served, string manifest, string version = "0.7.0") =>
            (await Assert.ThrowsAsync<JobFailedException>(() => Handler(served).Handler.RunAsync(Job(manifest, Sign(manifest), version), Context(), CancellationToken.None))).Message;

        Assert.Contains("SHA-256", await Fails(flipped, m));
        Assert.Contains("larger than", await Fails([.. pkg, 1, 2, 3], m));
        Assert.Contains("says", await Fails(pkg[..^1], m));
        Assert.Contains("version is not the signed release's", await Fails(pkg, m, version: "0.8.0"));
        var slip = Zip(("../outside.dll", "x"), ("FortressAgent.dll", "y"));
        Assert.Contains("outside its folder", await Fails(slip, Manifest("0.7.0", slip)));
        Assert.False(File.Exists(Path.Combine(dir, "updates", "0.7.0", "outside.dll")));
        var empty = Zip(("readme.txt", "no agent here"));
        Assert.Contains("does not contain the agent", await Fails(empty, Manifest("0.7.0", empty)));
        var notZip = "not a zip at all"u8.ToArray();
        Assert.Contains("not a zip", await Fails(notZip, Manifest("0.7.0", notZip)));
        Assert.Null(new UpdateFiles(dir).ReadPending());
    }

    [Fact]
    public void Says_applied_or_rolled_back_once_and_tidies_up()
    {
        var files = new UpdateFiles(dir);
        files.Write(files.Pending, new PendingUpdate("u1", "0.7.0", Path.Combine(dir, "x"), new string('a', 64), DateTimeOffset.UtcNow));
        Assert.Null(new UpdateState(dir, NullLogger.Instance, () => "0.6.0").Report());
        var applied = new UpdateState(dir, NullLogger.Instance, () => "0.7.0");
        var report = applied.Report()!;
        Assert.Equal(("u1", "applied"), (report.UpdateId, report.Outcome));
        applied.Reported(report);
        Assert.True(File.Exists(files.Applied));
        Assert.Null(files.ReadPending());
        Assert.Null(applied.Report());

        files.Write(files.Pending, new PendingUpdate("u2", "0.8.0", Path.Combine(dir, "x"), new string('a', 64), DateTimeOffset.UtcNow));
        files.Write(files.RolledBack, new RolledBackUpdate("u2", "0.8.0", "did not check in", DateTimeOffset.UtcNow));
        var old = new UpdateState(dir, NullLogger.Instance, () => "0.7.0");
        var rb = old.Report()!;
        Assert.Equal(("u2", "rolled_back", "did not check in"), (rb.UpdateId, rb.Outcome, rb.Message));
        old.Reported(rb);
        Assert.False(File.Exists(files.RolledBack));
        Assert.Null(old.Report());
    }

    private sealed class FakeService(Action? onStart = null) : IServiceControl
    {
        public readonly List<string> Calls = [];
        public Task StopAsync(CancellationToken ct) { Calls.Add("stop"); return Task.CompletedTask; }
        public Task StartAsync(CancellationToken ct) { Calls.Add("start"); onStart?.Invoke(); return Task.CompletedTask; }
    }

    private (string Install, UpdateFiles Files) Installed()
    {
        var install = Path.Combine(dir, "Program Files", "Fortress");
        Directory.CreateDirectory(install);
        File.WriteAllText(Path.Combine(install, "FortressAgent.exe"), "old");
        var staged = Path.Combine(dir, "updates", "0.7.0", "staged");
        Directory.CreateDirectory(staged);
        File.WriteAllText(Path.Combine(staged, "FortressAgent.exe"), "new");
        var files = new UpdateFiles(dir);
        files.Write(files.Pending, new PendingUpdate("u1", "0.7.0", staged, new string('a', 64), DateTimeOffset.UtcNow));
        return (install, files);
    }

    [Fact]
    public async Task The_updater_swaps_and_keeps_the_previous_version()
    {
        var (install, files) = Installed();
        var starts = 0;
        // The new agent writes applied.json after its first good heartbeat; here, as soon as it is started.
        var service = new FakeService(() => { if (++starts == 1) files.Write(files.Applied, new { updateId = "u1" }); });
        var outcome = await new UpdateSwapper(dir, install, service, NullLogger.Instance, (_, _) => Task.CompletedTask).ApplyAsync(CancellationToken.None);
        Assert.Equal("applied", outcome);
        Assert.Equal(["stop", "start"], service.Calls);
        Assert.Equal("new", File.ReadAllText(Path.Combine(install, "FortressAgent.exe")));
        Assert.Equal("old", File.ReadAllText(Path.Combine(install + ".previous", "FortressAgent.exe")));
    }

    [Fact]
    public async Task The_updater_puts_the_old_version_back_when_the_new_one_does_not_check_in()
    {
        var (install, files) = Installed();
        var service = new FakeService();
        var waited = TimeSpan.Zero;
        var outcome = await new UpdateSwapper(dir, install, service, NullLogger.Instance, (t, _) => { waited += t; return Task.CompletedTask; })
            .ApplyAsync(CancellationToken.None);
        Assert.Equal("rolled_back", outcome);
        Assert.Equal(UpdateSwapper.DefaultWait, waited);
        Assert.Equal(["stop", "start", "stop", "start"], service.Calls);
        Assert.Equal("old", File.ReadAllText(Path.Combine(install, "FortressAgent.exe")));
        Assert.Equal("new", File.ReadAllText(Path.Combine(install + ".failed-0.7.0", "FortressAgent.exe")));
        var rb = files.ReadRolledBack()!;
        Assert.Equal("u1", rb.UpdateId);
        Assert.Contains("did not check in within 5 minutes", rb.Message);
    }
}
