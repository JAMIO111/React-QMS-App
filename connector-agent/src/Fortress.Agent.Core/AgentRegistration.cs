using System.Text.RegularExpressions;

namespace Fortress.Agent.Core;

/// <summary>
/// First run: make the agent's keys, register them with Fortress using the one-time token from Settings → Integrations → Connector agents,
/// and keep the identity. The token is used once and never stored.
/// </summary>
public static partial class AgentRegistration
{
    [GeneratedRegex("^FAGT-[A-Za-z0-9_-]{43}$")]
    private static partial Regex TokenPattern();

    public static string? TokenProblem(string? token) =>
        string.IsNullOrWhiteSpace(token) ? "Give the registration token from Fortress"
        : TokenPattern().IsMatch(token.Trim()) ? null
        : "That is not a registration token from Fortress: it starts FAGT- and has 48 characters";

    /// <summary>
    /// The address must be https. Plain http is accepted only for this machine (development and tests), never across a network.
    /// </summary>
    public static string? ApiUrlProblem(string? apiUrl)
    {
        if (string.IsNullOrWhiteSpace(apiUrl) || !Uri.TryCreate(apiUrl.Trim(), UriKind.Absolute, out var uri))
            return "Give Fortress's address for the agent, as shown with the token (https://…/api/v1)";
        if (!string.IsNullOrEmpty(uri.UserInfo)) return "The address must not contain a user name or password";
        if (uri.Scheme == Uri.UriSchemeHttps) return null;
        if (uri.Scheme == Uri.UriSchemeHttp && uri.IsLoopback) return null;
        return "The address must start with https://";
    }

    public static async Task<AgentIdentity> RegisterAsync(
        AgentApiClient api, IdentityStore store, string apiUrl, string token, JobHandlers handlers, bool replace, TimeProvider? clock, CancellationToken ct)
    {
        if (ApiUrlProblem(apiUrl) is { } urlProblem) throw new ArgumentException(urlProblem, nameof(apiUrl));
        if (TokenProblem(token) is { } tokenProblem) throw new ArgumentException(tokenProblem, nameof(token));
        if (store.Exists && !replace)
            throw new InvalidOperationException($"This machine already has a registered agent ({store.Path}). Use --replace to register it afresh.");

        var (signing, sealing) = AgentIdentity.NewKeys();
        try
        {
            var body = new RegisterRequest(
                token.Trim(),
                Convert.ToBase64String(signing.ExportSubjectPublicKeyInfo()),
                Convert.ToBase64String(sealing.ExportSubjectPublicKeyInfo()),
                AgentInfo.Version, AgentInfo.OperatingSystem, AgentInfo.Machine, handlers.Capabilities());
            var r = await api.RegisterAsync(apiUrl.Trim(), body, signing, ct);
            var identity = new AgentIdentity
            {
                ApiUrl = apiUrl.Trim().TrimEnd('/'),
                AgentId = r.AgentId,
                OrganisationId = r.OrganisationId,
                OrganisationName = r.OrganisationName,
                Name = r.Name,
                RegisteredAt = (clock ?? TimeProvider.System).GetUtcNow(),
                SigningKey = signing,
                SealingKey = sealing,
            };
            store.Save(identity);
            return identity;
        }
        catch
        {
            signing.Dispose();
            sealing.Dispose();
            throw;
        }
    }
}
