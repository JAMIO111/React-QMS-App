using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Fortress.Agent.Core;

/// <summary>
/// Opens a database password sealed in the browser to this agent's sealing key (AG-D4, proven in AG0 §13): the browser makes a one-off ECDH P-256
/// key, agrees a secret with ours, derives an AES-256 key with HKDF-SHA256 (no salt, info "fortress-agent-credential-v1") and encrypts with
/// AES-256-GCM, the connection id as associated data so a sealed password cannot be moved to another connection. WebCrypto appends the 16-byte tag
/// to the ciphertext.
/// </summary>
public static class SealedBox
{
    public static readonly byte[] Info = "fortress-agent-credential-v1"u8.ToArray();

    public static byte[] Open(ECDiffieHellman sealingKey, string connectionId, string epk, string iv, string ct)
    {
        using var theirs = ECDiffieHellman.Create();
        theirs.ImportSubjectPublicKeyInfo(Convert.FromBase64String(epk), out _);
        var shared = sealingKey.DeriveRawSecretAgreement(theirs.PublicKey);
        var key = HKDF.DeriveKey(HashAlgorithmName.SHA256, shared, 32, [], Info);
        CryptographicOperations.ZeroMemory(shared);
        var nonce = Convert.FromBase64String(iv);
        var all = Convert.FromBase64String(ct);
        if (nonce.Length != 12 || all.Length < 17) throw new CryptographicException("The sealed password is not in the expected form");
        var cipher = all.AsSpan(0, all.Length - 16);
        var plain = new byte[cipher.Length];
        using (var aes = new AesGcm(key, 16)) aes.Decrypt(nonce, cipher, all.AsSpan(all.Length - 16), plain, Encoding.UTF8.GetBytes(connectionId));
        CryptographicOperations.ZeroMemory(key);
        return plain;
    }

    /// <summary>Seal as the browser does (tests, and a local command later). The browser's own code is in src/lib/sealCredential.js.</summary>
    public static (string Epk, string Iv, string Ct) Seal(string sealingPublicKey, string connectionId, byte[] plain)
    {
        using var mine = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
        using var theirs = ECDiffieHellman.Create();
        theirs.ImportSubjectPublicKeyInfo(Convert.FromBase64String(sealingPublicKey), out _);
        var key = HKDF.DeriveKey(HashAlgorithmName.SHA256, mine.DeriveRawSecretAgreement(theirs.PublicKey), 32, [], Info);
        var nonce = RandomNumberGenerator.GetBytes(12);
        var output = new byte[plain.Length + 16];
        using (var aes = new AesGcm(key, 16)) aes.Encrypt(nonce, plain, output.AsSpan(0, plain.Length), output.AsSpan(plain.Length), Encoding.UTF8.GetBytes(connectionId));
        return (Convert.ToBase64String(mine.ExportSubjectPublicKeyInfo()), Convert.ToBase64String(nonce), Convert.ToBase64String(output));
    }
}

/// <summary>
/// Where a connection's password may be sent (AG6d security review): the settings that say which server and which sign-in it is for. A password is
/// kept with the target of the connection it was typed for, and is only used while the connection still names that target, so changing a
/// connection's server, port, database or address in Fortress can never send the stored password somewhere else.
/// </summary>
public static class ConnectionTarget
{
    private static readonly string[] Keys = ["engine", "server", "port", "instance", "database", "authType", "baseUrl", "apiKeyHeader"];

    public static string Of(JsonObject? config)
    {
        if (config is null) throw new JobFailedException("invalid", "The job did not say which connection the password is for. Update Fortress.");
        var sb = new StringBuilder("fortress-agent-target-v1");
        foreach (var k in Keys)
        {
            var text = config[k] is JsonValue v ? v.ToJsonString() : "null";
            // Host names and instance names do not care about case; the rest are kept as Fortress sends them.
            if (k is "server" or "instance" or "baseUrl") text = text.ToLowerInvariant();
            sb.Append('\n').Append(k).Append('=').Append(text);
        }
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(sb.ToString())));
    }
}

/// <summary>
/// The database passwords this agent holds, one file per connection under credentials/, protected like the agent's keys (<see cref="IKeyProtector"/>:
/// DPAPI for the machine on Windows) in the folder the install script limits to SYSTEM, administrators and the service. Each is kept with the
/// <see cref="ConnectionTarget"/> it was typed for and refused for any other.
/// </summary>
public sealed class CredentialStore(string folder, IKeyProtector protector)
{
    public const string TargetChanged = "The connection's server, database or address has changed since its password was typed, so this agent will not send it there. Type it again in Fortress.";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public string Folder { get; } = folder;

    private string PathFor(string connectionId) =>
        Guid.TryParse(connectionId, out var g) ? Path.Combine(Folder, g.ToString("D") + ".bin") : throw new ArgumentException("Not a connection id", nameof(connectionId));

    public void Save(string connectionId, DbCredential credential, string target)
    {
        Directory.CreateDirectory(Folder);
        var path = PathFor(connectionId);
        var temp = path + ".tmp";
        var plain = JsonSerializer.SerializeToUtf8Bytes(new { username = credential.Username, password = credential.Password, target }, Json);
        try
        {
            File.WriteAllBytes(temp, protector.Protect(plain));
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plain);
        }
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(temp, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        File.Move(temp, path, overwrite: true);
    }

    /// <summary>The password for the connection when it was typed for this very target; a password kept for another target is refused.</summary>
    public DbCredential? Load(string connectionId, string target)
    {
        var path = PathFor(connectionId);
        if (!File.Exists(path)) return null;
        var plain = protector.Unprotect(File.ReadAllBytes(path));
        try
        {
            var credential = Parse(plain) ?? throw new InvalidDataException("The stored password could not be read");
            var kept = JsonNode.Parse(plain)?["target"] is JsonValue t && t.TryGetValue<string>(out var x) ? x : null;
            // A password kept before targets were recorded has none: it is refused too, so it is typed again once.
            if (kept is null || !CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(kept), Encoding.ASCII.GetBytes(target)))
                throw new JobFailedException("auth", TargetChanged);
            return credential;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plain);
        }
    }

    public bool Forget(string connectionId)
    {
        var path = PathFor(connectionId);
        if (!File.Exists(path)) return false;
        File.Delete(path);
        return true;
    }

    /// <summary>The sealed content: JSON <c>{"username": "…", "password": "…"}</c>, as the browser builds it.</summary>
    public static DbCredential? Parse(byte[] plain)
    {
        try
        {
            var node = JsonNode.Parse(plain);
            var user = node?["username"]?.GetValue<string>();
            var password = node?["password"]?.GetValue<string>();
            // An API key or token (AG5c) has no user name: it is sealed as an empty one.
            return user is null || password is null || user.Length > 256 || password.Length > 4096 || (user.Length == 0 && password.Length == 0) ? null : new DbCredential(user, password);
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException or FormatException)
        {
            return null;
        }
    }
}
