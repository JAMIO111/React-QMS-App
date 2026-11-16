using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Fortress.Agent.Core;

/// <summary>
/// What the agent is once registered: the Fortress address, its id and organisation, and its two private keys — one for signing requests
/// (ECDSA P-256) and one for opening credentials sealed to it in the browser (ECDH P-256, used from AG2). The private keys never leave this
/// machine; Fortress holds only the public halves.
/// </summary>
public sealed class AgentIdentity : IDisposable
{
    public required string ApiUrl { get; init; }
    public required string AgentId { get; init; }
    public required string OrganisationId { get; init; }
    public required string OrganisationName { get; init; }
    public required string Name { get; init; }
    public required DateTimeOffset RegisteredAt { get; init; }
    public required ECDsa SigningKey { get; set; }
    public required ECDiffieHellman SealingKey { get; set; }

    /// <summary>When the current keys were made (the registration, or the last rotation, AG6a). The agent rotates them every 90 days.</summary>
    public DateTimeOffset? KeysCreatedAt { get; set; }

    /// <summary>
    /// The sealing key before the last rotation, kept for 30 days so a password sealed in the browser just before the rotation still opens. Fortress
    /// never sees it; it signs nothing.
    /// </summary>
    public ECDiffieHellman? PreviousSealingKey { get; set; }
    public DateTimeOffset? PreviousSealingUntil { get; set; }

    /// <summary>
    /// New keys written down before Fortress is told of them. If the agent stops between the two, its next start finds Fortress no longer accepts the
    /// old key and moves to these (<see cref="KeyRotation"/>), so a rotation can never lock the agent out.
    /// </summary>
    public ECDsa? PendingSigningKey { get; set; }
    public ECDiffieHellman? PendingSealingKey { get; set; }

    public DateTimeOffset KeysMadeAt => KeysCreatedAt ?? RegisteredAt;

    /// <summary>The keys that may open a sealed password now: the current one, then the previous one while it is kept.</summary>
    public IReadOnlyList<ECDiffieHellman> SealingKeys(DateTimeOffset now) =>
        PreviousSealingKey is not null && PreviousSealingUntil is { } until && until > now ? [SealingKey, PreviousSealingKey] : [SealingKey];

    public string SigningPublicKey => Convert.ToBase64String(SigningKey.ExportSubjectPublicKeyInfo());
    public string SealingPublicKey => Convert.ToBase64String(SealingKey.ExportSubjectPublicKeyInfo());
    public string Fingerprint => RequestSigner.Fingerprint(SigningPublicKey);

    public static (ECDsa Signing, ECDiffieHellman Sealing) NewKeys() =>
        (ECDsa.Create(ECCurve.NamedCurves.nistP256), ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256));

    public void Dispose()
    {
        SigningKey.Dispose();
        SealingKey.Dispose();
        PreviousSealingKey?.Dispose();
        PendingSigningKey?.Dispose();
        PendingSealingKey?.Dispose();
    }
}

/// <summary>
/// Keeps the identity in one file. The private keys inside it are protected by <see cref="IKeyProtector"/> (DPAPI for the machine on Windows),
/// and the install script limits the folder to the service account and administrators. Writes go to a temporary file first, then replace the
/// old one, so a crash never leaves half a file.
/// </summary>
public sealed class IdentityStore(string path, IKeyProtector protector)
{
    public string Path { get; } = path;

    public bool Exists => File.Exists(Path);

    public AgentIdentity? Load()
    {
        if (!File.Exists(Path)) return null;
        var file = JsonSerializer.Deserialize(File.ReadAllText(Path), AgentJson.Default.IdentityFile)
            ?? throw new InvalidDataException($"{Path} is empty or not an agent identity");
        if (file.Format != 1) throw new InvalidDataException($"{Path} was written by a newer agent (format {file.Format})");
        var signing = ECDsa.Create();
        signing.ImportPkcs8PrivateKey(protector.Unprotect(Convert.FromBase64String(file.SigningKey)), out _);
        var sealing = ECDiffieHellman.Create();
        sealing.ImportPkcs8PrivateKey(protector.Unprotect(Convert.FromBase64String(file.SealingKey)), out _);
        ECDiffieHellman? Dh(string? b64)
        {
            if (string.IsNullOrEmpty(b64)) return null;
            var k = ECDiffieHellman.Create();
            k.ImportPkcs8PrivateKey(protector.Unprotect(Convert.FromBase64String(b64)), out _);
            return k;
        }
        ECDsa? Dsa(string? b64)
        {
            if (string.IsNullOrEmpty(b64)) return null;
            var k = ECDsa.Create();
            k.ImportPkcs8PrivateKey(protector.Unprotect(Convert.FromBase64String(b64)), out _);
            return k;
        }
        return new AgentIdentity
        {
            ApiUrl = file.ApiUrl, AgentId = file.AgentId, OrganisationId = file.OrganisationId, OrganisationName = file.OrganisationName,
            Name = file.Name, RegisteredAt = file.RegisteredAt, SigningKey = signing, SealingKey = sealing,
            KeysCreatedAt = file.KeysCreatedAt, PreviousSealingKey = Dh(file.PreviousSealingKey), PreviousSealingUntil = file.PreviousSealingUntil,
            PendingSigningKey = Dsa(file.PendingSigningKey), PendingSealingKey = Dh(file.PendingSealingKey),
        };
    }

    public void Save(AgentIdentity identity)
    {
        var file = new IdentityFile
        {
            Format = 1,
            ApiUrl = identity.ApiUrl,
            AgentId = identity.AgentId,
            OrganisationId = identity.OrganisationId,
            OrganisationName = identity.OrganisationName,
            Name = identity.Name,
            RegisteredAt = identity.RegisteredAt,
            Protection = protector.Name,
            SigningKey = Convert.ToBase64String(protector.Protect(identity.SigningKey.ExportPkcs8PrivateKey())),
            SealingKey = Convert.ToBase64String(protector.Protect(identity.SealingKey.ExportPkcs8PrivateKey())),
            KeysCreatedAt = identity.KeysCreatedAt,
            PreviousSealingKey = identity.PreviousSealingKey is { } p ? Convert.ToBase64String(protector.Protect(p.ExportPkcs8PrivateKey())) : null,
            PreviousSealingUntil = identity.PreviousSealingKey is null ? null : identity.PreviousSealingUntil,
            PendingSigningKey = identity.PendingSigningKey is { } ps ? Convert.ToBase64String(protector.Protect(ps.ExportPkcs8PrivateKey())) : null,
            PendingSealingKey = identity.PendingSealingKey is { } pe ? Convert.ToBase64String(protector.Protect(pe.ExportPkcs8PrivateKey())) : null,
        };
        var dir = System.IO.Path.GetDirectoryName(System.IO.Path.GetFullPath(Path))!;
        Directory.CreateDirectory(dir);
        var temp = Path + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(file, AgentJson.Default.IdentityFile));
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(temp, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        File.Move(temp, Path, overwrite: true);
    }

    public void Delete()
    {
        if (File.Exists(Path)) File.Delete(Path);
    }
}

internal sealed class IdentityFile
{
    public int Format { get; set; }
    public string ApiUrl { get; set; } = "";
    public string AgentId { get; set; } = "";
    public string OrganisationId { get; set; } = "";
    public string OrganisationName { get; set; } = "";
    public string Name { get; set; } = "";
    public DateTimeOffset RegisteredAt { get; set; }
    /// <summary>How the keys are protected (dpapi-machine, file-permissions); information for whoever reads the file.</summary>
    public string Protection { get; set; } = "";
    public string SigningKey { get; set; } = "";
    public string SealingKey { get; set; } = "";
    public DateTimeOffset? KeysCreatedAt { get; set; }
    public string? PreviousSealingKey { get; set; }
    public DateTimeOffset? PreviousSealingUntil { get; set; }
    public string? PendingSigningKey { get; set; }
    public string? PendingSealingKey { get; set; }
}

/// <summary>Protects the private keys at rest.</summary>
public interface IKeyProtector
{
    string Name { get; }
    byte[] Protect(byte[] data);
    byte[] Unprotect(byte[] data);
}

/// <summary>Windows: DPAPI for the local machine, with an agent-specific entropy. Only this machine can open the keys; the folder ACL limits who on it.</summary>
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public sealed class DpapiKeyProtector : IKeyProtector
{
    private static readonly byte[] Entropy = "fortress-connector-agent-v1"u8.ToArray();
    public string Name => "dpapi-machine";
    public byte[] Protect(byte[] data) => ProtectedData.Protect(data, Entropy, DataProtectionScope.LocalMachine);
    public byte[] Unprotect(byte[] data) => ProtectedData.Unprotect(data, Entropy, DataProtectionScope.LocalMachine);
}

/// <summary>
/// Elsewhere (development, tests and the Linux build): the keys are stored as they are and protected only by the file's permissions (owner read
/// and write). Only Windows is packaged for customers (plan §12).
/// </summary>
public sealed class FilePermissionKeyProtector : IKeyProtector
{
    public string Name => "file-permissions";
    public byte[] Protect(byte[] data) => data;
    public byte[] Unprotect(byte[] data) => data;
}

public static class KeyProtectors
{
    public static IKeyProtector ForThisMachine() => OperatingSystem.IsWindows() ? new DpapiKeyProtector() : new FilePermissionKeyProtector();
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, WriteIndented = true, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(IdentityFile))]
internal partial class AgentJson : JsonSerializerContext;
