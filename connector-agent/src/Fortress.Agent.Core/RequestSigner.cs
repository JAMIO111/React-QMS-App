using System.Security.Cryptography;
using System.Text;

namespace Fortress.Agent.Core;

/// <summary>
/// How the agent proves who it is on every request (docs/connector-agent-plan.md AG-D2, amended by AG0 §13). The agent signs a canonical
/// string with its own ECDSA P-256 key (SHA-256, IEEE P1363 r‖s, 64 bytes). The string binds the method, the path with its query, a hash of
/// the exact body bytes, the time, a one-off nonce and the agent id. The API checks it in api/src/integrations/agents/agent-signature.ts;
/// the two must stay byte-for-byte the same.
/// </summary>
public static class RequestSigner
{
    public const string Version = "FORTRESS-AGENT-V1";

    /// <summary>At registration there is no agent id yet; this word stands in its place.</summary>
    public const string RegistrationSubject = "register";

    public const string HeaderAgentId = "X-Agent-Id";
    public const string HeaderTimestamp = "X-Agent-Timestamp";
    public const string HeaderNonce = "X-Agent-Nonce";
    public const string HeaderSignature = "X-Agent-Signature";

    public static string Sha256Hex(ReadOnlySpan<byte> data) => Convert.ToHexString(SHA256.HashData(data)).ToLowerInvariant();

    public static string CanonicalString(string method, string pathAndQuery, ReadOnlySpan<byte> body, string timestamp, string nonce, string agentId) =>
        string.Join('\n', Version, method.ToUpperInvariant(), pathAndQuery, Sha256Hex(body), timestamp, nonce.ToLowerInvariant(), agentId);

    public static string NewNonce() => Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();

    public static string Timestamp(DateTimeOffset now) => now.ToUnixTimeSeconds().ToString(System.Globalization.CultureInfo.InvariantCulture);

    /// <summary>The headers for one request. The signature is base64 of the 64-byte r‖s form, as Node's <c>dsaEncoding: 'ieee-p1363'</c> expects.</summary>
    public static SignedHeaders Sign(ECDsa key, string method, string pathAndQuery, ReadOnlySpan<byte> body, string agentId, DateTimeOffset now, string? nonce = null)
    {
        var ts = Timestamp(now);
        var n = nonce ?? NewNonce();
        var canonical = CanonicalString(method, pathAndQuery, body, ts, n, agentId);
        var signature = key.SignData(Encoding.UTF8.GetBytes(canonical), HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        return new SignedHeaders(agentId == RegistrationSubject ? null : agentId, ts, n, Convert.ToBase64String(signature));
    }

    public static bool Verify(ECDsa publicKey, string method, string pathAndQuery, ReadOnlySpan<byte> body, string agentId, SignedHeaders headers)
    {
        var canonical = CanonicalString(method, pathAndQuery, body, headers.Timestamp, headers.Nonce, agentId);
        return publicKey.VerifyData(Encoding.UTF8.GetBytes(canonical), Convert.FromBase64String(headers.Signature), HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
    }

    /// <summary>The first 16 hex characters of the SHA-256 of the public key, in fours, as Fortress shows it on the agent's page.</summary>
    public static string Fingerprint(string spkiBase64)
    {
        var hex = Sha256Hex(Convert.FromBase64String(spkiBase64))[..16];
        return string.Join(' ', Enumerable.Range(0, 4).Select(i => hex.Substring(i * 4, 4)));
    }
}

public sealed record SignedHeaders(string? AgentId, string Timestamp, string Nonce, string Signature);
