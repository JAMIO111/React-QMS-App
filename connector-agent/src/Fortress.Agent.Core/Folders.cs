using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Fortress.Agent.Core;

/// <summary>
/// A folder of files read through the agent (AG5b). The folder is named as this machine knows it (a drive path, a share, or an absolute path) and is
/// read only when this agent's own allow-list names it or a folder above it (<c>"folders"</c> in allowlist.json): unlike databases, no list means
/// no folder at all, because a folder is reached with the service account's own rights. Only files directly in the folder are seen.
/// The agent never parses a file: it sends the bytes to Fortress in signed parts and Fortress reads them with the reader it uses for uploads.
/// </summary>
public static partial class FolderJobs
{
    public const long MaxFileBytes = 26_214_400;
    /// <summary>Under the API's 1 MB body limit for a part.</summary>
    public const int PartBytes = 786_432;
    public const int MaxListed = 500;
    public static readonly IReadOnlySet<string> Extensions = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { ".csv", ".txt", ".tsv", ".xlsx" };

    [GeneratedRegex(@"^([A-Za-z]:\\|\\\\[A-Za-z0-9._$-]+\\[^\\]+|/)")]
    private static partial Regex FolderPattern();
    [GeneratedRegex(@"(^|[\\/])\.\.([\\/]|$)|[\x00-\x1f""<>|*?]")]
    private static partial Regex FolderBad();
    [GeneratedRegex(@"[\\/:\x00-\x1f""<>|]")]
    private static partial Regex FileNameBad();

    public static bool IsFolder(AgentJob job) => job.Spec?["connection"]?["engine"]?.GetValue<string>() == "folder";

    /// <summary>The connection's folder, checked as Fortress checks it, then against this agent's allow-list, then that it exists.</summary>
    public static DirectoryInfo Open(AgentJob job, string allowListPath)
    {
        var folder = job.Spec?["connection"]?["folder"] is JsonValue v && v.TryGetValue<string>(out var s) ? s : throw new JobFailedException("invalid", "The job does not say which folder");
        if (folder.Length is < 3 or > 260 || !FolderPattern().IsMatch(folder) || FolderBad().IsMatch(folder) || !Path.IsPathFullyQualified(folder))
            throw new JobFailedException("invalid", $"The folder {folder} is not a whole path this machine can read");
        var allow = LocalAllowList.Load(allowListPath);
        if (!allow.AllowsFolder(folder))
            throw new JobFailedException("refused", $"The folder {folder} is not on this agent's allow-list: add it to \"folders\" in {Path.GetFileName(allowListPath)} on the agent's machine");
        var dir = new DirectoryInfo(folder);
        try
        {
            if (!dir.Exists) throw new JobFailedException("not_found", $"There is no folder {folder} that this agent's service account can see");
            // A link (junction, symbolic link) at or below the allowed folder could lead anywhere, the agent's own keys included (AG6d review).
            if (allow.LinkBelowAllowed(folder))
                throw new JobFailedException("refused", $"The folder {folder} is reached through a link (junction or symbolic link) below the folder on the allow-list; list the real folder instead");
        }
        catch (UnauthorizedAccessException)
        {
            throw new JobFailedException("refused", $"This agent's service account may not read the folder {folder}");
        }
        return dir;
    }

    public sealed record FileEntry(string Name, long Size, DateTime ModifiedUtc, bool Supported);

    /// <summary>The files directly in the folder (no sub-folders, links, hidden or system files), by name.</summary>
    public static List<FileEntry> List(DirectoryInfo dir)
    {
        try
        {
            return dir.EnumerateFiles("*", SearchOption.TopDirectoryOnly)
                .Where(f => (f.Attributes & (FileAttributes.Hidden | FileAttributes.System | FileAttributes.ReparsePoint)) == 0)
                .Select(f => new FileEntry(f.Name, f.Length, f.LastWriteTimeUtc, Extensions.Contains(f.Extension)))
                .OrderBy(f => f.Name, StringComparer.OrdinalIgnoreCase)
                .ToList();
        }
        catch (UnauthorizedAccessException)
        {
            throw new JobFailedException("refused", $"This agent's service account may not list the folder {dir.FullName}");
        }
        catch (IOException e)
        {
            throw new JobFailedException("network", $"The folder {dir.FullName} could not be read: {e.Message}", transient: true);
        }
    }

    public static string CheckName(string? name)
    {
        if (string.IsNullOrEmpty(name) || name.Length > 200 || FileNameBad().IsMatch(name) || name is "." or ".." || name.Trim() != name)
            throw new JobFailedException("invalid", "Name a file directly in the folder (no \\ / : or control characters)");
        return name;
    }

    /// <summary>A file name against a name or pattern (* any run of characters, ? one), ignoring case.</summary>
    public static bool Matches(string pattern, string name) =>
        Regex.IsMatch(name, "^" + Regex.Escape(pattern).Replace("\\*", ".*").Replace("\\?", ".") + "$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));

    /// <summary>The newest CSV / Excel file matching the name or pattern (the latest change first, then the name).</summary>
    public static FileEntry Newest(DirectoryInfo dir, string pattern)
    {
        CheckName(pattern);
        var match = List(dir).Where(f => f.Supported && Matches(pattern, f.Name))
            .OrderByDescending(f => f.ModifiedUtc).ThenByDescending(f => f.Name, StringComparer.OrdinalIgnoreCase).FirstOrDefault();
        return match ?? throw new JobFailedException("not_found", $"No CSV or Excel file in {dir.FullName} matches {pattern}");
    }

    public sealed record SentFile(FileEntry File, string Sha256, int Parts, bool Unchanged);

    /// <summary>
    /// Read the file whole (it may be open in the program that writes it) and, unless its SHA-256 is <paramref name="knownSha256"/>, send it in parts.
    /// The hash is of exactly the bytes sent, so a file that changes while it is read is still one consistent copy.
    /// </summary>
    public static async Task<SentFile> SendAsync(DirectoryInfo dir, FileEntry entry, string? knownSha256, JobContext context, CancellationToken ct)
    {
        if (entry.Size > MaxFileBytes) throw new JobFailedException("refused", $"{entry.Name} is {entry.Size / 1048576.0:0.#} MB; a file can be up to 25 MB");
        var path = Path.Combine(dir.FullName, entry.Name);
        if (!string.Equals(Path.GetDirectoryName(Path.GetFullPath(path)), Path.GetFullPath(dir.FullName).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar), StringComparison.Ordinal))
            throw new JobFailedException("invalid", "The file is not directly in the folder");
        byte[] bytes;
        try
        {
            // Listed files are never links; check again in case it was swapped for one since.
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new JobFailedException("refused", $"{entry.Name} is a link, not a file");
            await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 81920, FileOptions.Asynchronous);
            if (stream.Length > MaxFileBytes) throw new JobFailedException("refused", $"{entry.Name} is larger than 25 MB");
            using var memory = new MemoryStream((int)stream.Length);
            await stream.CopyToAsync(memory, ct);
            bytes = memory.ToArray();
        }
        catch (FileNotFoundException)
        {
            throw new JobFailedException("not_found", $"{entry.Name} was removed from the folder while it was being read", transient: true);
        }
        catch (UnauthorizedAccessException)
        {
            throw new JobFailedException("refused", $"This agent's service account may not read {entry.Name}");
        }
        catch (IOException e) when (e is not FileNotFoundException)
        {
            throw new JobFailedException("network", $"{entry.Name} could not be read: {e.Message}", transient: true);
        }
        if (bytes.Length == 0) throw new JobFailedException("invalid", $"{entry.Name} is empty");
        var sha = Convert.ToHexStringLower(SHA256.HashData(bytes));
        if (knownSha256 is not null && string.Equals(sha, knownSha256, StringComparison.OrdinalIgnoreCase))
            return new SentFile(entry with { Size = bytes.Length }, sha, 0, true);
        var parts = 0;
        for (var offset = 0; offset < bytes.Length; offset += PartBytes)
        {
            ct.ThrowIfCancellationRequested();
            var part = bytes.AsSpan(offset, Math.Min(PartBytes, bytes.Length - offset)).ToArray();
            var receipt = await context.SendFilePartAsync(new FilePart(parts, part, Convert.ToHexStringLower(SHA256.HashData(part))), ct);
            if (receipt.Cancelled) { ct.ThrowIfCancellationRequested(); throw new OperationCanceledException("The job was cancelled in Fortress"); }
            parts++;
        }
        return new SentFile(entry with { Size = bytes.Length }, sha, parts, false);
    }

    public static JsonObject Describe(FileEntry f, string? sha256 = null)
    {
        var o = new JsonObject { ["name"] = f.Name, ["size"] = f.Size, ["modifiedAt"] = f.ModifiedUtc.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'") };
        if (sha256 is not null) o["sha256"] = sha256;
        return o;
    }

    // ---- the jobs ----

    public static JsonObject Test(AgentJob job, string allowListPath)
    {
        var dir = Open(job, allowListPath);
        var files = List(dir);
        var supported = files.Count(f => f.Supported);
        return new JsonObject
        {
            ["ok"] = true,
            ["message"] = $"The folder {dir.FullName} can be read: {files.Count} file{(files.Count == 1 ? "" : "s")}, {supported} of them CSV or Excel",
            ["engine"] = "folder",
            ["files"] = files.Count,
            ["supported"] = supported,
        };
    }

    public static JsonObject Discover(AgentJob job, string allowListPath)
    {
        var dir = Open(job, allowListPath);
        var files = List(dir);
        return new JsonObject
        {
            ["level"] = "files",
            ["folder"] = dir.FullName,
            ["files"] = new JsonArray(files.Take(MaxListed).Select(f =>
            {
                var o = Describe(f);
                o["supported"] = f.Supported;
                return (JsonNode)o;
            }).ToArray()),
            ["truncated"] = files.Count > MaxListed,
        };
    }

    /// <summary>A preview sends the newest file matching the name; Fortress reads it and keeps its first rows as the job's result.</summary>
    public static async Task<JsonObject> PreviewAsync(AgentJob job, string allowListPath, JobContext context, CancellationToken ct)
    {
        var request = DatabaseJobContext.Request(job);
        var name = CheckName(request["file"]?.GetValue<string>());
        var dir = Open(job, allowListPath);
        var sent = await SendAsync(dir, Newest(dir, name), null, context, ct);
        return new JsonObject { ["file"] = Describe(sent.File, sent.Sha256), ["parts"] = sent.Parts };
    }

    /// <summary>
    /// An import sends the newest file matching the source's name. Its mark is the file's SHA-256: an incremental run sends the last one, and when
    /// the newest file is that same file nothing is sent and the import finds nothing new.
    /// </summary>
    public static async Task<JsonObject> ExtractAsync(AgentJob job, string allowListPath, JobContext context, CancellationToken ct)
    {
        var request = DatabaseJobContext.Request(job);
        var name = CheckName(request["file"]?.GetValue<string>());
        var known = request["changedSince"] is JsonValue v && v.TryGetValue<string>(out var s) && s.Length == 64 ? s : null;
        var dir = Open(job, allowListPath);
        var sent = await SendAsync(dir, Newest(dir, name), known, context, ct);
        var result = new JsonObject { ["file"] = Describe(sent.File, sent.Sha256), ["parts"] = sent.Parts, ["changedUpTo"] = sent.Sha256 };
        if (sent.Unchanged)
        {
            result["unchanged"] = true;
            result["batches"] = 0;
            result["rows"] = 0;
        }
        return result;
    }
}
