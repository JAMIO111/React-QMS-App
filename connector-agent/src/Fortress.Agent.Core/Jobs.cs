using System.Text.Json.Nodes;

namespace Fortress.Agent.Core;

/// <summary>Something Fortress can ask the agent to do (ping now; test, discover, preview and extract from AG2 on).</summary>
public interface IJobHandler
{
    string Kind { get; }
    Task<JsonNode?> RunAsync(AgentJob job, JobContext context, CancellationToken ct);
}

/// <summary>What a handler may use while it runs: report progress (which also tells it when the job was cancelled in Fortress) and the clock.</summary>
public sealed class JobContext(Func<JsonObject, CancellationToken, Task<bool>> reportProgress, TimeProvider clock)
{
    public TimeProvider Clock { get; } = clock;

    /// <summary>Report progress; returns false when Fortress has cancelled the job, in which case the handler should stop.</summary>
    public Task<bool> ReportProgressAsync(JsonObject progress, CancellationToken ct) => reportProgress(progress, ct);
}

/// <summary>A handler's way of saying why it could not do the job, in words safe to show in Fortress (never a password or row contents).</summary>
public sealed class JobFailedException(string kind, string message, bool transient = false) : Exception(message)
{
    public string Kind { get; } = kind;
    public bool Transient { get; } = transient;
}

/// <summary>"Are you there?" from the agent's page in Fortress. Answers with the agent's version and clock, so a clock that is off shows.</summary>
public sealed class PingHandler : IJobHandler
{
    public string Kind => "ping";

    public Task<JsonNode?> RunAsync(AgentJob job, JobContext context, CancellationToken ct) =>
        Task.FromResult<JsonNode?>(new JsonObject
        {
            ["pong"] = true,
            ["version"] = AgentInfo.Version,
            ["agentTime"] = context.Clock.GetUtcNow().ToString("O"),
        });
}

public sealed class JobHandlers
{
    private readonly Dictionary<string, IJobHandler> handlers;
    private readonly IReadOnlyCollection<string> engines;

    public JobHandlers(IEnumerable<IJobHandler> handlers, IReadOnlyCollection<string>? engines = null)
    {
        this.handlers = handlers.ToDictionary(h => h.Kind, StringComparer.Ordinal);
        this.engines = engines ?? [];
    }

    /// <summary>Every job this agent does: ping, and for database connections the password, test, browse and preview (AG2).</summary>
    public static JobHandlers ForDatabases(IDatabaseAdapterFactory adapters, CredentialStore credentials, string allowListPath, Func<System.Security.Cryptography.ECDiffieHellman> sealingKey)
    {
        var databases = new DatabaseJobContext(adapters, credentials, allowListPath);
        return new JobHandlers(
            [new PingHandler(), new StoreCredentialHandler(sealingKey, credentials), new TestConnectionHandler(databases), new DiscoverHandler(databases), new PreviewHandler(databases)],
            adapters.Engines);
    }

    public static JobHandlers Default() => new([new PingHandler()]);

    public IJobHandler? For(string kind) => handlers.GetValueOrDefault(kind);

    public IReadOnlyCollection<string> Kinds => handlers.Keys;

    /// <summary>What the agent tells Fortress it can do; reported at registration and with every heartbeat.</summary>
    public JsonObject Capabilities() => new()
    {
        ["jobs"] = new JsonArray(handlers.Keys.Order(StringComparer.Ordinal).Select(k => (JsonNode)JsonValue.Create(k)!).ToArray()),
        ["adapters"] = new JsonArray(engines.Order(StringComparer.Ordinal).Select(k => (JsonNode)JsonValue.Create(k)!).ToArray()),
        ["maxBatchRows"] = 1000,
    };
}
