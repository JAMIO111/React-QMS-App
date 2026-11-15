using Fortress.Agent.Core;

namespace Fortress.Agent.Adapters;

/// <summary>The engines this agent can read, by the connection's <c>engine</c> setting.</summary>
public sealed class DatabaseAdapters : IDatabaseAdapterFactory
{
    public IReadOnlyCollection<string> Engines { get; } = ["sqlserver", "postgres"];

    public Task<IDatabaseAdapter> OpenAsync(ConnectionSettings settings, DbCredential? credential, CancellationToken ct) => settings.Engine switch
    {
        "postgres" => PostgresAdapter.OpenAsync(settings, credential, ct),
        "sqlserver" => SqlServerAdapter.OpenAsync(settings, credential, ct),
        _ => throw new JobFailedException("invalid", $"This agent cannot read {settings.Engine} databases"),
    };
}
