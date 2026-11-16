using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;

namespace Fortress.Agent.Core;

/// <summary>
/// Key rotation (AG6a, AG6-D1): the agent replaces its signing and sealing keys every 90 days on its own, or when an admin asks from the agent's
/// page. The new keys are written to disk as "pending" before Fortress is told of them, so a stop half-way cannot lock the agent out: if Fortress
/// already moved to the new keys, the old key is refused and the agent moves to the pending ones (<see cref="TryRecover"/>). The previous sealing
/// key is kept for 30 days, so a password sealed in the browser just before the rotation still opens.
/// </summary>
public sealed class KeyRotation(IdentityStore? store, ILogger logger, TimeProvider? clock = null)
{
    public static readonly TimeSpan Every = TimeSpan.FromDays(90);
    public static readonly TimeSpan KeepPreviousSealing = TimeSpan.FromDays(30);
    private readonly TimeProvider clock = clock ?? TimeProvider.System;

    public bool Due(AgentIdentity id) => id.PendingSigningKey is not null || clock.GetUtcNow() - id.KeysMadeAt >= Every;

    /// <summary>Make new keys (or reuse ones written down by a rotation that did not finish), tell Fortress, then use them. Returns the new fingerprint.</summary>
    public async Task<string> RotateAsync(AgentIdentity id, AgentApiClient api, CancellationToken ct)
    {
        if (id.PendingSigningKey is null || id.PendingSealingKey is null)
        {
            var (signing, sealing) = AgentIdentity.NewKeys();
            id.PendingSigningKey = signing;
            id.PendingSealingKey = sealing;
            store?.Save(id);
        }
        try
        {
            await api.RotateKeysAsync(id, Convert.ToBase64String(id.PendingSigningKey.ExportSubjectPublicKeyInfo()),
                Convert.ToBase64String(id.PendingSealingKey!.ExportSubjectPublicKeyInfo()), ct);
        }
        catch (AgentApiException e) when (!e.Revoked && e.Status is >= 400 and < 500 && e.Code != "agent_unauthenticated")
        {
            // Fortress refused the new keys outright: forget them and keep the current ones.
            Forget(id);
            throw;
        }
        Promote(id);
        logger.LogInformation("Keys rotated; the new key fingerprint is {Fingerprint}", id.Fingerprint);
        return id.Fingerprint;
    }

    /// <summary>Fortress refused the current key: when a rotation was written down and not finished, Fortress already has the new keys. Move to them.</summary>
    public bool TryRecover(AgentIdentity id)
    {
        if (id.PendingSigningKey is null || id.PendingSealingKey is null) return false;
        Promote(id);
        logger.LogWarning("Fortress no longer accepts the old key: moved to the keys made by the last rotation (fingerprint {Fingerprint})", id.Fingerprint);
        return true;
    }

    private void Promote(AgentIdentity id)
    {
        var oldSigning = id.SigningKey;
        id.PreviousSealingKey?.Dispose();
        id.PreviousSealingKey = id.SealingKey;
        id.PreviousSealingUntil = clock.GetUtcNow() + KeepPreviousSealing;
        id.SigningKey = id.PendingSigningKey!;
        id.SealingKey = id.PendingSealingKey!;
        id.PendingSigningKey = null;
        id.PendingSealingKey = null;
        id.KeysCreatedAt = clock.GetUtcNow();
        store?.Save(id);
        oldSigning.Dispose();
    }

    private void Forget(AgentIdentity id)
    {
        id.PendingSigningKey?.Dispose();
        id.PendingSealingKey?.Dispose();
        id.PendingSigningKey = null;
        id.PendingSealingKey = null;
        store?.Save(id);
    }
}

/// <summary>Stands for "rotate_keys" in the agent's capabilities; the runner does the work itself, because the job changes the keys it signs with.</summary>
public sealed class RotateKeysHandler : IJobHandler
{
    public string Kind => "rotate_keys";

    public Task<JsonNode?> RunAsync(AgentJob job, JobContext context, CancellationToken ct) =>
        throw new JobFailedException("invalid", "This agent cannot rotate its keys while running as a one-off command");
}

/// <summary>
/// A bounded diagnostics bundle for Fortress (AG6a, AG6-D2): version, operating system and runtime, uptime and memory, the adapters, the allow-list
/// (the customer's own file), the key's fingerprint and age, the agent's clock, and the last log lines — at most 64 kB, never a password, key, token
/// or row contents. Log lines hold none to begin with (the agent logs ids, kinds, counts and Fortress's own messages); anything shaped like a
/// secret is redacted again here all the same.
/// </summary>
public sealed partial class DiagnosticsHandler(string logFolder, string allowListPath, Func<AgentIdentity?> identity, Func<JsonObject> capabilities) : IJobHandler
{
    public const int MaxBytes = 64 * 1024;
    public const int MaxLogLines = 200;
    private static readonly Stopwatch Started = Stopwatch.StartNew();

    public string Kind => "diagnostics";

    [GeneratedRegex(@"(?i)(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}")]
    private static partial Regex AuthHeader();
    [GeneratedRegex(@"(?i)(password|pwd|secret|token|api[_-]?key)\s*[=:]\s*[^\s;,""']+")]
    private static partial Regex NamedSecret();
    [GeneratedRegex(@"FAGT-[A-Za-z0-9_-]+")]
    private static partial Regex RegistrationToken();
    [GeneratedRegex(@"[A-Za-z0-9+/_-]{40,}={0,2}")]
    private static partial Regex LongOpaque();

    /// <summary>Anything that looks like a credential becomes [redacted]; ids (UUIDs) and words stay.</summary>
    public static string Redact(string line)
    {
        line = AuthHeader().Replace(line, m => m.Groups[1].Value + " [redacted]");
        line = NamedSecret().Replace(line, m => m.Value[..(m.Value.IndexOfAny(['=', ':']) + 1)] + "[redacted]");
        line = RegistrationToken().Replace(line, "FAGT-[redacted]");
        return LongOpaque().Replace(line, "[redacted]");
    }

    public Task<JsonNode?> RunAsync(AgentJob job, JobContext context, CancellationToken ct)
    {
        var id = identity();
        var now = context.Clock.GetUtcNow();
        var bundle = new JsonObject
        {
            ["version"] = AgentInfo.Version,
            ["os"] = AgentInfo.OperatingSystem,
            ["machine"] = AgentInfo.Machine,
            ["runtime"] = RuntimeInformation.FrameworkDescription,
            ["architecture"] = RuntimeInformation.ProcessArchitecture.ToString(),
            ["agentTime"] = now.ToString("O"),
            ["uptimeSeconds"] = (long)Started.Elapsed.TotalSeconds,
            ["memoryMb"] = Math.Round(Environment.WorkingSet / 1048576.0, 1),
            ["capabilities"] = capabilities(),
            ["keyFingerprint"] = id?.Fingerprint,
            ["keyAgeDays"] = id is null ? null : (int)(now - id.KeysMadeAt).TotalDays,
            ["previousSealingKeyKeptUntil"] = id?.PreviousSealingKey is null ? null : id.PreviousSealingUntil?.ToString("O"),
            ["rotationPending"] = id?.PendingSigningKey is not null,
            ["allowList"] = AllowListText(),
        };
        var lines = LastLogLines();
        var log = new JsonArray();
        bundle["log"] = log;
        foreach (var line in lines) log.Add(Redact(line));
        // Keep it bounded: drop the oldest lines until it fits.
        while (Encoding.UTF8.GetByteCount(bundle.ToJsonString()) > MaxBytes && log.Count > 0) log.RemoveAt(0);
        bundle["logLines"] = log.Count;
        return Task.FromResult<JsonNode?>(bundle);
    }

    private string? AllowListText()
    {
        if (!File.Exists(allowListPath)) return null;
        var text = File.ReadAllText(allowListPath);
        return text.Length <= 8192 ? Redact(text) : Redact(text[..8192]) + "…";
    }

    /// <summary>The newest log files' last lines (the log rolls daily), oldest first, each line at most 500 characters.</summary>
    private List<string> LastLogLines()
    {
        var result = new List<string>();
        if (!Directory.Exists(logFolder)) return result;
        foreach (var file in new DirectoryInfo(logFolder).GetFiles("*.log").OrderByDescending(f => f.LastWriteTimeUtc).Take(2))
        {
            string[] all;
            try
            {
                using var stream = new FileStream(file.FullName, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using var reader = new StreamReader(stream);
                all = reader.ReadToEnd().Split('\n', StringSplitOptions.RemoveEmptyEntries);
            }
            catch (IOException)
            {
                continue;
            }
            result.InsertRange(0, all.TakeLast(MaxLogLines - result.Count).Select(l => l.TrimEnd('\r')).Select(l => l.Length <= 500 ? l : l[..500] + "…"));
            if (result.Count >= MaxLogLines) break;
        }
        return result;
    }
}
