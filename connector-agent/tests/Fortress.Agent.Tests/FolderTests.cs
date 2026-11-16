using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Fortress.Agent.Core;

namespace Fortress.Agent.Tests;

/// <summary>
/// Folders (AG5b): only folders on the agent's own allow-list, only files directly in the folder, the newest file matching a name or pattern, the
/// bytes sent in parts with checksums, nothing sent when the file is the one Fortress already has, and refusals in words.
/// </summary>
public sealed class FolderTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "fortress-agent-folder-" + Guid.NewGuid().ToString("N"));
    private readonly string exports;
    private readonly string allowList;
    private readonly List<FilePart> parts = [];

    public FolderTests()
    {
        exports = Path.Combine(root, "exports");
        Directory.CreateDirectory(exports);
        Directory.CreateDirectory(Path.Combine(exports, "old"));
        allowList = Path.Combine(root, "allowlist.json");
        Allow(root);
    }

    public void Dispose()
    {
        if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
    }

    private void Allow(params string[] folders) =>
        File.WriteAllText(allowList, new JsonObject { ["folders"] = new JsonArray(folders.Select(f => (JsonNode)JsonValue.Create(f)!).ToArray()) }.ToJsonString());

    private string Write(string name, string text, DateTime? modified = null)
    {
        var path = Path.Combine(exports, name);
        File.WriteAllText(path, text);
        if (modified is not null) File.SetLastWriteTimeUtc(path, modified.Value);
        return path;
    }

    private JobHandlers Handlers => JobHandlers.ForDatabases(new FakeDatabase(), new CredentialStore(Path.Combine(root, "credentials"), new FilePermissionKeyProtector()),
        allowList, () => throw new InvalidOperationException());

    private JobContext Ctx(Func<FilePart, FilePartReceipt>? answer = null) => new((_, _) => Task.FromResult(true), TimeProvider.System, null,
        (p, _) => { parts.Add(p); return Task.FromResult(answer?.Invoke(p) ?? new FilePartReceipt { Stored = true, Status = "running" }); });

    private AgentJob Job(string kind, JsonObject? request = null, string? folder = null) => new()
    {
        Id = Guid.NewGuid().ToString(),
        Kind = kind,
        Spec = new JsonObject
        {
            ["connectionId"] = "5f0c2b8e-3a51-4d6c-9e2f-7b8a1c4d0e93",
            ["connection"] = new JsonObject { ["engine"] = "folder", ["folder"] = folder ?? exports, ["authType"] = "none" },
            ["request"] = request ?? new JsonObject(),
        },
    };

    private async Task<JsonObject> Run(string kind, JsonObject? request = null, string? folder = null, JobContext? ctx = null) =>
        (JsonObject)(await Handlers.For(kind)!.RunAsync(Job(kind, request, folder), ctx ?? Ctx(), default))!;

    [Fact]
    public async Task Tests_and_lists_only_the_files_directly_in_an_allowed_folder()
    {
        Write("machines-2026-11-01.csv", "code\nM1\n");
        Write("notes.docx", "x");
        Write(".hidden.csv", "code\n");
        if (!OperatingSystem.IsWindows()) File.SetAttributes(Path.Combine(exports, ".hidden.csv"), FileAttributes.Hidden);
        File.WriteAllText(Path.Combine(exports, "old", "machines-2025.csv"), "code\nOLD\n");

        var test = await Run("test_connection");
        Assert.True(test["ok"]!.GetValue<bool>());
        Assert.StartsWith($"The folder {exports} can be read", test["message"]!.GetValue<string>());

        var listed = await Run("discover");
        var names = listed["files"]!.AsArray().Select(f => f!["name"]!.GetValue<string>()).ToArray();
        Assert.Equal(["machines-2026-11-01.csv", "notes.docx"], names); // no sub-folder, no hidden file
        Assert.False(listed["files"]![1]!["supported"]!.GetValue<bool>());
        Assert.Equal("files", listed["level"]!.GetValue<string>());
        Assert.Equal(["discover", "extract", "ping", "preview", "store_credential", "test_connection"], Handlers.Capabilities()["jobs"]!.AsArray().Select(x => x!.GetValue<string>()));
        Assert.Contains("folder", Handlers.Capabilities()["adapters"]!.AsArray().Select(x => x!.GetValue<string>()));
    }

    [Fact]
    public async Task Refuses_a_folder_the_allow_list_does_not_name_and_reads_none_without_a_list()
    {
        Allow(Path.Combine(root, "elsewhere"));
        var refused = await Assert.ThrowsAsync<JobFailedException>(() => Run("discover"));
        Assert.Equal("refused", refused.Kind);
        Assert.Contains("\"folders\" in allowlist.json", refused.Message);
        File.Delete(allowList);
        Assert.Equal("refused", (await Assert.ThrowsAsync<JobFailedException>(() => Run("test_connection"))).Kind);
        // A folder whose name starts like an allowed one is not inside it.
        Allow(exports);
        Directory.CreateDirectory(exports + "-private");
        Assert.Equal("refused", (await Assert.ThrowsAsync<JobFailedException>(() => Run("discover", folder: exports + "-private"))).Kind);
        // A sub-folder of an allowed one is allowed; ".." never.
        Assert.Equal("files", (await Run("discover", folder: Path.Combine(exports, "old")))["level"]!.GetValue<string>());
        Assert.Equal("invalid", (await Assert.ThrowsAsync<JobFailedException>(() => Run("discover", folder: Path.Combine(exports, "..", "exports")))).Kind);
        Assert.Equal("not_found", (await Assert.ThrowsAsync<JobFailedException>(() => Run("discover", folder: Path.Combine(exports, "missing")))).Kind);
    }

    [Fact]
    public async Task Sends_the_newest_matching_file_in_parts_with_checksums()
    {
        Write("machines-2026-11-01.csv", "code\nOLD\n", new DateTime(2026, 11, 1, 6, 0, 0, DateTimeKind.Utc));
        var big = "code,name\n" + string.Concat(Enumerable.Range(1, 60_000).Select(i => $"M{i},Machine number {i}\n"));
        Write("machines-2026-11-02.csv", big, new DateTime(2026, 11, 2, 6, 0, 0, DateTimeKind.Utc));
        Write("parts-2026-11-03.csv", "code\nP1\n", new DateTime(2026, 11, 3, 6, 0, 0, DateTimeKind.Utc));

        var result = await Run("extract", new JsonObject { ["file"] = "machines-*.csv", ["changedColumn"] = "@file" });
        var bytes = Encoding.UTF8.GetBytes(big);
        var sha = Convert.ToHexStringLower(SHA256.HashData(bytes));
        Assert.Equal("machines-2026-11-02.csv", result["file"]!["name"]!.GetValue<string>());
        Assert.Equal(sha, result["file"]!["sha256"]!.GetValue<string>());
        Assert.Equal(sha, result["changedUpTo"]!.GetValue<string>());
        Assert.True(parts.Count > 1);
        Assert.Equal(parts.Count, result["parts"]!.GetValue<int>());
        Assert.Equal(Enumerable.Range(0, parts.Count), parts.Select(p => p.Seq));
        Assert.All(parts, p => Assert.True(p.Bytes.Length <= FolderJobs.PartBytes));
        Assert.All(parts, p => Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(p.Bytes)), p.Checksum));
        Assert.Equal(bytes, parts.SelectMany(p => p.Bytes).ToArray());
        Assert.False(result.ContainsKey("unchanged"));
    }

    [Fact]
    public async Task Sends_nothing_when_the_newest_file_is_the_one_Fortress_already_has()
    {
        Write("machines.csv", "code\nM1\n");
        var sha = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("code\nM1\n")));
        var result = await Run("extract", new JsonObject { ["file"] = "machines.csv", ["changedSince"] = sha });
        Assert.True(result["unchanged"]!.GetValue<bool>());
        Assert.Equal(0, result["batches"]!.GetValue<int>());
        Assert.Equal(0, result["rows"]!.GetValue<int>());
        Assert.Equal(sha, result["changedUpTo"]!.GetValue<string>());
        Assert.Empty(parts);
        // A changed file is sent again.
        Write("machines.csv", "code\nM1\nM2\n");
        var again = await Run("extract", new JsonObject { ["file"] = "machines.csv", ["changedSince"] = sha });
        Assert.False(again.ContainsKey("unchanged"));
        Assert.Single(parts);
    }

    [Fact]
    public async Task A_preview_sends_the_file_named()
    {
        Write("machines.csv", "code\nM1\n");
        var result = await Run("preview", new JsonObject { ["file"] = "machines.csv", ["limit"] = 10 });
        Assert.Equal("machines.csv", result["file"]!["name"]!.GetValue<string>());
        Assert.Equal(1, result["parts"]!.GetValue<int>());
        Assert.Equal("code\nM1\n", Encoding.UTF8.GetString(parts[0].Bytes));
    }

    [Theory]
    [InlineData("../secret.csv")]
    [InlineData("old/machines-2025.csv")]
    [InlineData("C:x.csv")]
    [InlineData("")]
    public async Task A_file_name_never_leaves_the_folder(string name)
    {
        File.WriteAllText(Path.Combine(root, "secret.csv"), "code\nSECRET\n");
        var e = await Assert.ThrowsAsync<JobFailedException>(() => Run("extract", new JsonObject { ["file"] = name }));
        Assert.Equal("invalid", e.Kind);
        Assert.Empty(parts);
    }

    [Fact]
    public async Task Says_when_nothing_matches_and_refuses_files_over_25_MB()
    {
        Write("notes.docx", "x");
        var none = await Assert.ThrowsAsync<JobFailedException>(() => Run("extract", new JsonObject { ["file"] = "*.docx" }));
        Assert.Equal("not_found", none.Kind);
        Assert.Contains("No CSV or Excel file", none.Message);
        var path = Path.Combine(exports, "huge.csv");
        using (var f = File.Create(path)) f.SetLength(FolderJobs.MaxFileBytes + 1);
        var huge = await Assert.ThrowsAsync<JobFailedException>(() => Run("extract", new JsonObject { ["file"] = "huge.csv" }));
        Assert.Equal("refused", huge.Kind);
        Assert.Empty(parts);
    }

    [Fact]
    public async Task Stops_when_Fortress_cancels_the_job()
    {
        Write("machines.csv", new string('x', FolderJobs.PartBytes * 3));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            Run("extract", new JsonObject { ["file"] = "machines.csv" }, ctx: Ctx(p => new FilePartReceipt { Cancelled = true, Status = "cancelled" })));
        Assert.Single(parts);
    }

    [Theory]
    [InlineData("machines-*.csv", "Machines-2026.CSV", true)]
    [InlineData("machines-????.csv", "machines-2026.csv", true)]
    [InlineData("machines.csv", "machines.csv.bak", false)]
    [InlineData("m*.csv", "parts.csv", false)]
    public void Matches_a_name_or_pattern_ignoring_case(string pattern, string name, bool matches) =>
        Assert.Equal(matches, FolderJobs.Matches(pattern, name));
}
