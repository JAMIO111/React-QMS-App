using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;

namespace Fortress.Agent.Core;

/// <summary>
/// The public keys this agent trusts to sign releases (AG6b, AG6-D3). A release whose manifest is not signed by one of them is refused, whatever
/// Fortress says: an update can only ever install what the holder of a release key built and signed. Add your key's public half (base64 SPKI, from
/// connector-agent/release/make-release-key.mjs) to <see cref="Built"/>; until then this agent accepts no update.
/// </summary>
public static class ReleaseKeys
{
    /// <summary>The release keys built into the agent (base64 SPKI, P-256). Empty would mean no update is accepted.</summary>
    public static readonly IReadOnlyList<string> Built =
    [
        // Fortress release key 1, key id bbbe9b808fda7ca1 (made 2026-11-16; the private half is kept off this repository).
        "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE+jSp+sdQen1pRtlSiq38xvwMmEHXjdXprQe4/74ACgAFUJOBdVGbcoBAVcso8P46hMB+TLrXTvvLhX5r348x+Q==",
    ];

    /// <summary>A test key, honoured only by a Debug build or one built with FortressTestHooks=true (the tests); a shipped build ignores the setting entirely.</summary>
    public const string TestKeySetting = "FORTRESS_AGENT_TEST_RELEASE_KEY";

    /// <summary>A test-build-only setting that fetches the package from this address instead of the manifest's (the tests serve it locally).</summary>
    public const string TestDownloadSetting = "FORTRESS_AGENT_TEST_DOWNLOAD";

    public static IReadOnlyList<string> Trusted()
    {
#if DEBUG || FORTRESS_TEST_HOOKS
        var test = Environment.GetEnvironmentVariable(TestKeySetting);
        if (!string.IsNullOrWhiteSpace(test)) return [.. Built, test.Trim()];
#endif
        return Built;
    }

    public static string? TestDownloadOverride()
    {
#if DEBUG || FORTRESS_TEST_HOOKS
        var v = Environment.GetEnvironmentVariable(TestDownloadSetting);
        return string.IsNullOrWhiteSpace(v) ? null : v.Trim();
#else
        return null;
#endif
    }

    /// <summary>The key id Fortress shows: the first 16 hex characters of the SHA-256 of the public key's SPKI bytes.</summary>
    public static string KeyId(string spkiBase64) => Convert.ToHexStringLower(SHA256.HashData(Convert.FromBase64String(spkiBase64)))[..16];
}

/// <summary>What a release manifest says (the signed JSON text, docs/connector-agent-plan.md AG6b).</summary>
public sealed record ReleaseManifest(string Version, string Platform, Uri Url, string Sha256, long Size, string? Notes)
{
    public const string Format = "fortress-agent-release-v1";
    public const long MaxSize = 300L * 1024 * 1024;

    /// <summary>
    /// Read a manifest only after its signature checks out against a trusted key. Refuses (with the reason in words) anything else: an untrusted
    /// key, a changed text, another format, a version that is not three numbers, a platform that is not this agent's, a version that is not newer,
    /// an address that is not https, a SHA-256 or size that is not right.
    /// </summary>
    public static ReleaseManifest Verify(string manifest, string signatureBase64, IReadOnlyList<string> trustedKeys, string? platform, string currentVersion)
    {
        if (trustedKeys.Count == 0) throw new JobFailedException("refused", "This agent has no release key built in, so it accepts no update; install the new version by hand");
        byte[] signature;
        try { signature = Convert.FromBase64String(signatureBase64); }
        catch (FormatException) { throw new JobFailedException("refused", "The release's signature is not base64"); }
        var bytes = Encoding.UTF8.GetBytes(manifest);
        var signedBy = trustedKeys.FirstOrDefault(k =>
        {
            using var key = ECDsa.Create();
            try { key.ImportSubjectPublicKeyInfo(Convert.FromBase64String(k), out _); }
            catch (Exception e) when (e is CryptographicException or FormatException) { return false; }
            return signature.Length == 64 && key.VerifyData(bytes, signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        });
        if (signedBy is null) throw new JobFailedException("refused", "The release is not signed by a key this agent trusts");

        JsonObject m;
        try { m = JsonNode.Parse(manifest) as JsonObject ?? throw new JobFailedException("refused", "The release manifest is not a JSON object"); }
        catch (JsonException) { throw new JobFailedException("refused", "The release manifest is not JSON"); }
        string Text(string name) => m[name] is JsonValue v && v.TryGetValue<string>(out var s) ? s : "";
        if (Text("format") != Format) throw new JobFailedException("refused", $"The release manifest is not format {Format}");
        var version = Text("version");
        if (Parts(version) is null) throw new JobFailedException("refused", "The release's version is not three whole numbers");
        var target = Text("platform");
        if (platform is null || target != platform) throw new JobFailedException("refused", $"The release is for {target}, but this agent runs on {platform ?? "an unknown platform"}");
        if (Compare(version, currentVersion) <= 0) throw new JobFailedException("refused", $"The release ({version}) is not newer than this agent ({currentVersion})");
        if (!Uri.TryCreate(Text("url"), UriKind.Absolute, out var url) || url.Scheme != Uri.UriSchemeHttps || !string.IsNullOrEmpty(url.UserInfo))
            throw new JobFailedException("refused", "The release's address is not https");
        var sha = Text("sha256");
        if (sha.Length != 64 || !sha.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f')) throw new JobFailedException("refused", "The release's SHA-256 is not right");
        if (m["size"] is not JsonValue sv || !sv.TryGetValue<long>(out var size) || size < 1 || size > MaxSize)
            throw new JobFailedException("refused", "The release's size is not right (at most 300 MB)");
        return new ReleaseManifest(version, target, url, sha, size, Text("notes") is { Length: > 0 } n ? n : null);
    }

    public static int[]? Parts(string? v)
    {
        var p = (v ?? "").Split('.');
        if (p.Length != 3) return null;
        var n = new int[3];
        for (var i = 0; i < 3; i++)
            if (p[i].Length is < 1 or > 6 || !p[i].All(char.IsAsciiDigit) || !int.TryParse(p[i], out n[i])) return null;
        return n;
    }

    /// <summary>Compares two "a.b.c" versions; one that does not read sorts before any that does.</summary>
    public static int Compare(string a, string b)
    {
        var x = Parts(a); var y = Parts(b);
        if (x is null || y is null) return x is null ? (y is null ? 0 : -1) : 1;
        for (var i = 0; i < 3; i++) if (x[i] != y[i]) return x[i].CompareTo(y[i]);
        return 0;
    }
}

/// <summary>The files that carry an update from the old agent, through the updater, to the new one (all under <c>updates/</c> in the data folder).</summary>
public sealed class UpdateFiles(string dataDir)
{
    public string Folder => Path.Combine(dataDir, "updates");
    /// <summary>Written by the old agent once a release is staged: which update, which version, where it is.</summary>
    public string Pending => Path.Combine(Folder, "pending.json");
    /// <summary>Written by the new agent after its first good heartbeat: the updater's sign that the swap worked.</summary>
    public string Applied => Path.Combine(Folder, "applied.json");
    /// <summary>Written by the updater when it put the old version back: the old agent reports it.</summary>
    public string RolledBack => Path.Combine(Folder, "rolled-back.json");
    public string StagingFor(string version) => Path.Combine(Folder, version);

    public PendingUpdate? ReadPending() => Read<PendingUpdate>(Pending);
    public RolledBackUpdate? ReadRolledBack() => Read<RolledBackUpdate>(RolledBack);

    public void Write<T>(string path, T value)
    {
        Directory.CreateDirectory(Folder);
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(value, AgentApiClient.Json));
        File.Move(tmp, path, overwrite: true);
    }

    private static T? Read<T>(string path)
    {
        try { return File.Exists(path) ? JsonSerializer.Deserialize<T>(File.ReadAllText(path), AgentApiClient.Json) : default; }
        catch (JsonException) { return default; }
    }
}

public sealed record PendingUpdate(string UpdateId, string Version, string Staged, string Sha256, DateTimeOffset StagedAt)
{
    /// <summary>The signed manifest, its signature and the downloaded package as the agent received them: the updater checks them all again itself.</summary>
    public string? Manifest { get; init; }
    public string? Signature { get; init; }
    public string? Package { get; init; }
}
public sealed record RolledBackUpdate(string UpdateId, string Version, string Message, DateTimeOffset At);

/// <summary>
/// The update_agent job (AG6b): check the release's signature with the keys built into this agent, download the package (https; a test build may be
/// pointed elsewhere), check its size and SHA-256 against the signed manifest, unpack it into <c>updates/&lt;version&gt;/staged</c> (refusing any
/// entry that would land outside it) and write <c>updates/pending.json</c>. It never runs anything it downloaded; the swap is the updater's.
/// </summary>
public sealed class UpdateHandler(string dataDir, Func<HttpClient> downloader, ILogger logger, Func<IReadOnlyList<string>>? trustedKeys = null,
    Func<string?>? platform = null, Func<string>? currentVersion = null) : IJobHandler
{
    public string Kind => "update_agent";
    public const long MaxUnpacked = 1024L * 1024 * 1024;
    public const int MaxEntries = 5000;

    public async Task<JsonNode?> RunAsync(AgentJob job, JobContext context, CancellationToken ct)
    {
        var spec = job.Spec ?? throw new JobFailedException("invalid", "The update job has no details");
        string Field(string name) => spec[name] is JsonValue v && v.TryGetValue<string>(out var s) ? s : throw new JobFailedException("invalid", $"The update job has no {name}");
        var updateId = Field("updateId");
        var manifest = ReleaseManifest.Verify(Field("manifest"), Field("signature"), (trustedKeys ?? ReleaseKeys.Trusted)(),
            (platform ?? (() => AgentInfo.Platform))(), (currentVersion ?? (() => AgentInfo.Version))());
        if (manifest.Version != Field("version")) throw new JobFailedException("refused", "The update job's version is not the signed release's");

        var files = new UpdateFiles(dataDir);
        var folder = files.StagingFor(manifest.Version);
        if (Directory.Exists(folder)) Directory.Delete(folder, recursive: true);
        Directory.CreateDirectory(folder);
        var package = Path.Combine(folder, "package.zip");
        if (!await context.ReportProgressAsync(new JsonObject { ["step"] = "downloading", ["version"] = manifest.Version }, ct)) throw new OperationCanceledException();
        await DownloadAsync(manifest, package, ct);

        if (!await context.ReportProgressAsync(new JsonObject { ["step"] = "unpacking", ["version"] = manifest.Version }, ct)) throw new OperationCanceledException();
        var staged = Path.Combine(folder, "staged");
        Unpack(package, staged);
        if (!File.Exists(Path.Combine(staged, "FortressAgent.exe")) && !File.Exists(Path.Combine(staged, "FortressAgent.dll")))
            throw new JobFailedException("refused", "The release does not contain the agent (FortressAgent.exe)");

        // The package is kept: the updater (SYSTEM on Windows) does not trust this folder, which the agent's own account can write, and checks the
        // signature and the package's SHA-256 again before it unpacks the package somewhere only it can write (AG6d review).
        files.Write(files.Pending, new PendingUpdate(updateId, manifest.Version, staged, manifest.Sha256, context.Clock.GetUtcNow())
        {
            Manifest = Field("manifest"),
            Signature = Field("signature"),
            Package = package,
        });
        logger.LogInformation("Update to {Version} checked and staged in {Folder}", manifest.Version, staged);
        return new JsonObject { ["staged"] = true, ["version"] = manifest.Version, ["sha256"] = manifest.Sha256 };
    }

    private async Task DownloadAsync(ReleaseManifest manifest, string path, CancellationToken ct)
    {
        var from = ReleaseKeys.TestDownloadOverride() is { } o ? new Uri(o) : manifest.Url;
        using var res = await downloader().GetAsync(from, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!res.IsSuccessStatusCode) throw new JobFailedException("network", $"The release could not be downloaded ({(int)res.StatusCode})", transient: (int)res.StatusCode >= 500);
        if (res.RequestMessage?.RequestUri is { } final && final.Scheme != Uri.UriSchemeHttps && ReleaseKeys.TestDownloadOverride() is null)
            throw new JobFailedException("refused", "The release's address sent the download somewhere that is not https");
        await using var input = await res.Content.ReadAsStreamAsync(ct);
        await using var output = File.Create(path);
        using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[81920];
        long total = 0;
        int read;
        while ((read = await input.ReadAsync(buffer, ct)) > 0)
        {
            total += read;
            if (total > manifest.Size) throw new JobFailedException("refused", "The download is larger than the signed release says");
            sha.AppendData(buffer, 0, read);
            await output.WriteAsync(buffer.AsMemory(0, read), ct);
        }
        if (total != manifest.Size) throw new JobFailedException("refused", $"The download is {total} bytes, but the signed release says {manifest.Size}");
        if (Convert.ToHexStringLower(sha.GetHashAndReset()) != manifest.Sha256) throw new JobFailedException("refused", "The download's SHA-256 is not the signed release's");
    }

    /// <summary>Unpack, refusing an entry whose path would leave the folder, more than 5,000 entries or more than 1 GB unpacked.</summary>
    internal static void Unpack(string package, string into)
    {
        Directory.CreateDirectory(into);
        var root = Path.GetFullPath(into) + Path.DirectorySeparatorChar;
        try
        {
            using var zip = ZipFile.OpenRead(package);
            if (zip.Entries.Count > MaxEntries) throw new JobFailedException("refused", "The release has too many files");
            long total = 0;
            foreach (var entry in zip.Entries)
            {
                var target = Path.GetFullPath(Path.Combine(into, entry.FullName));
                if (!target.StartsWith(root, StringComparison.Ordinal)) throw new JobFailedException("refused", "The release contains a file that would land outside its folder");
                if (entry.FullName.EndsWith('/') || entry.FullName.EndsWith('\\'))
                {
                    Directory.CreateDirectory(target);
                    continue;
                }
                total += entry.Length;
                if (total > MaxUnpacked) throw new JobFailedException("refused", "The release unpacks to more than 1 GB");
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                entry.ExtractToFile(target, overwrite: false);
            }
        }
        catch (InvalidDataException)
        {
            throw new JobFailedException("refused", "The release is not a zip file");
        }
    }
}

/// <summary>
/// What the agent tells Fortress about an update once it has started again (AG6b): applied (this process runs the staged version), or rolled back
/// (the updater put the old version back). Said in the next heartbeat; once Fortress has it, the files are tidied and, for an applied update,
/// <c>updates/applied.json</c> tells a waiting updater that the new version came up.
/// </summary>
public sealed class UpdateState(string dataDir, ILogger logger, Func<string>? currentVersion = null)
{
    private readonly UpdateFiles files = new(dataDir);

    public UpdateReport? Report()
    {
        if (files.ReadRolledBack() is { } r) return new UpdateReport(r.UpdateId, "rolled_back", r.Message);
        if (files.ReadPending() is { } p && p.Version == (currentVersion ?? (() => AgentInfo.Version))())
            return new UpdateReport(p.UpdateId, "applied", null);
        return null;
    }

    /// <summary>Fortress has the report: tidy up; for an applied update, tell the updater.</summary>
    public void Reported(UpdateReport report)
    {
        try
        {
            if (report.Outcome == "applied")
            {
                files.Write(files.Applied, new { report.UpdateId, at = DateTimeOffset.UtcNow });
                File.Delete(files.Pending);
                logger.LogInformation("The update is in place; Fortress has been told");
            }
            else
            {
                File.Delete(files.RolledBack);
                File.Delete(files.Pending);
                logger.LogWarning("The update was rolled back; Fortress has been told");
            }
        }
        catch (IOException e)
        {
            logger.LogWarning("The update's files could not be tidied: {Message}", e.Message);
        }
    }
}

public sealed record UpdateReport(string UpdateId, string Outcome, string? Message);

/// <summary>
/// What the updater does before it touches anything (AG6d review): it trusts nothing in the agent's data folder, which the agent's own account can
/// write. It checks the release's signature again against the keys built into itself, that the release is for this platform and newer than what is
/// installed, then copies the package into its own staging folder (somewhere the agent's account cannot write), checks the copy's size and SHA-256
/// against the signed manifest, and unpacks that copy. The folder it returns is the one swapped in.
/// </summary>
public static class UpdatePreparer
{
    public static string Prepare(PendingUpdate pending, string stagingRoot, IReadOnlyList<string> trustedKeys, string? platform, string installedVersion)
    {
        if (pending.Manifest is null || pending.Signature is null || pending.Package is null)
            throw new JobFailedException("refused", "The staged update does not carry its signed release; approve it again in Fortress");
        var manifest = ReleaseManifest.Verify(pending.Manifest, pending.Signature, trustedKeys, platform, installedVersion);
        if (manifest.Version != pending.Version) throw new JobFailedException("refused", "The staged update is not the signed release's version");
        if (Directory.Exists(stagingRoot)) Directory.Delete(stagingRoot, recursive: true);
        Directory.CreateDirectory(stagingRoot);
        var copy = Path.Combine(stagingRoot, "package.zip");
        using (var input = File.OpenRead(pending.Package))
        using (var output = File.Create(copy))
        using (var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256))
        {
            var buffer = new byte[81920];
            long total = 0;
            int read;
            while ((read = input.Read(buffer)) > 0)
            {
                total += read;
                if (total > manifest.Size) throw new JobFailedException("refused", "The staged package is larger than the signed release says");
                sha.AppendData(buffer, 0, read);
                output.Write(buffer, 0, read);
            }
            if (total != manifest.Size) throw new JobFailedException("refused", "The staged package is not the size the signed release says");
            if (Convert.ToHexStringLower(sha.GetHashAndReset()) != manifest.Sha256) throw new JobFailedException("refused", "The staged package's SHA-256 is not the signed release's");
        }
        var app = Path.Combine(stagingRoot, "app");
        UpdateHandler.Unpack(copy, app);
        File.Delete(copy);
        if (!File.Exists(Path.Combine(app, "FortressAgent.exe")) && !File.Exists(Path.Combine(app, "FortressAgent.dll")))
            throw new JobFailedException("refused", "The release does not contain the agent (FortressAgent.exe)");
        return app;
    }
}

/// <summary>Stopping and starting the agent's service, for the updater (Windows: the service manager; tests: a fake).</summary>
public interface IServiceControl
{
    Task StopAsync(CancellationToken ct);
    Task StartAsync(CancellationToken ct);
}

/// <summary>
/// The swap (AG6b, Windows): stop the service, keep the installed folder as <c>&lt;install&gt;.previous</c>, move the staged folder in, start the
/// service, then wait up to five minutes for the new agent to write <c>updates/applied.json</c>. If it does not, stop it, put the previous folder
/// back, start that, and write <c>updates/rolled-back.json</c> for the old agent to report.
/// </summary>
public sealed class UpdateSwapper(string dataDir, string installDir, IServiceControl service, ILogger logger,
    Func<TimeSpan, CancellationToken, Task>? delay = null, TimeSpan? waitFor = null, Func<PendingUpdate, string>? prepare = null)
{
    public static readonly TimeSpan DefaultWait = TimeSpan.FromMinutes(5);
    private readonly Func<TimeSpan, CancellationToken, Task> delay = delay ?? ((t, ct) => Task.Delay(t, ct));

    public async Task<string> ApplyAsync(CancellationToken ct)
    {
        var files = new UpdateFiles(dataDir);
        var pending = files.ReadPending() ?? throw new InvalidOperationException("No update is staged");
        string incoming;
        if (prepare is null)
        {
            if (!Directory.Exists(pending.Staged)) throw new InvalidOperationException($"The staged update is missing ({pending.Staged})");
            incoming = pending.Staged;
        }
        else
        {
            try
            {
                incoming = prepare(pending);
            }
            catch (Exception e) when (e is JobFailedException or IOException or UnauthorizedAccessException or System.Security.Cryptography.CryptographicException)
            {
                // Nothing was touched: the installed version keeps running, and the agent reports why the update did not happen.
                logger.LogWarning("The staged update to {Version} was refused: {Message}", pending.Version, e.Message);
                files.Write(files.RolledBack, new RolledBackUpdate(pending.UpdateId, pending.Version, $"The updater refused the staged update: {e.Message}", DateTimeOffset.UtcNow));
                return "refused";
            }
        }
        var install = Path.GetFullPath(installDir).TrimEnd(Path.DirectorySeparatorChar);
        var previous = install + ".previous";
        if (File.Exists(files.Applied)) File.Delete(files.Applied);

        logger.LogInformation("Updating to {Version}: stopping the service", pending.Version);
        await service.StopAsync(ct);
        if (Directory.Exists(previous)) Directory.Delete(previous, recursive: true);
        Directory.Move(install, previous);
        try
        {
            Directory.Move(incoming, install);
        }
        catch
        {
            Directory.Move(previous, install);
            await service.StartAsync(ct);
            throw;
        }
        var limit = waitFor ?? DefaultWait;
        string reason;
        try
        {
            await service.StartAsync(ct);
            reason = $"Version {pending.Version} did not check in within {(int)limit.TotalMinutes} minutes";
            var waited = TimeSpan.Zero;
            var step = TimeSpan.FromSeconds(5);
            while (waited < limit)
            {
                if (File.Exists(files.Applied))
                {
                    logger.LogInformation("Version {Version} is running; the previous one is kept in {Previous}", pending.Version, previous);
                    return "applied";
                }
                await delay(step, ct);
                waited += step;
            }
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            // A version that cannot even start is put back the same way as one that never checks in.
            reason = $"Version {pending.Version} did not start ({e.Message})";
        }

        logger.LogWarning("{Reason}: putting the previous version back", reason);
        try { await service.StopAsync(ct); }
        catch (Exception e) when (e is not OperationCanceledException) { logger.LogWarning("Stopping version {Version} failed ({Message}); going on", pending.Version, e.Message); }
        var failed = install + ".failed-" + pending.Version;
        if (Directory.Exists(failed)) Directory.Delete(failed, recursive: true);
        Directory.Move(install, failed);
        Directory.Move(previous, install);
        files.Write(files.RolledBack, new RolledBackUpdate(pending.UpdateId, pending.Version, $"{reason}; the previous version was put back", DateTimeOffset.UtcNow));
        await service.StartAsync(ct);
        return "rolled_back";
    }
}
