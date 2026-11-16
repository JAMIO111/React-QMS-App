using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Fortress.Agent.Core;

/// <summary>What the database job handlers share: the adapters, this agent's passwords and the local allow-list.</summary>
public sealed class DatabaseJobContext(IDatabaseAdapterFactory adapters, CredentialStore credentials, string allowListPath)
{
    public IDatabaseAdapterFactory Adapters { get; } = adapters;
    public CredentialStore Credentials { get; } = credentials;
    public string AllowListPath { get; } = allowListPath;

    public static string ConnectionId(AgentJob job) =>
        job.Spec?["connectionId"]?.GetValue<string>() is { } id && Guid.TryParse(id, out _) ? id : throw new JobFailedException("invalid", "The job did not name its connection");

    public static JsonObject Request(AgentJob job) => job.Spec?["request"] as JsonObject ?? [];

    /// <summary>Open the connection's database, after the allow-list and with this agent's password when it needs one.</summary>
    public async Task<(IDatabaseAdapter Db, ConnectionSettings Settings, LocalAllowList Allow)> OpenAsync(AgentJob job, CancellationToken ct)
    {
        var id = ConnectionId(job);
        var settings = ConnectionSettings.Parse(job.Spec?["connection"] as JsonObject);
        if (!Adapters.Engines.Contains(settings.Engine)) throw new JobFailedException("invalid", $"This agent cannot read {settings.Engine} databases. Update the agent.");
        var allow = LocalAllowList.Load(AllowListPath);
        if (!allow.AllowsDatabase(settings.Database))
            throw new JobFailedException("refused", $"The database {settings.Database} is not on this agent's allow-list ({Path.GetFileName(AllowListPath)} on the agent's machine)");
        DbCredential? credential = null;
        if (settings.NeedsPassword)
        {
            try
            {
                credential = Credentials.Load(id);
            }
            catch (Exception e) when (e is CryptographicException or InvalidDataException or IOException)
            {
                throw new JobFailedException("auth", "The password this agent holds for the connection cannot be read. Type it again in Fortress.");
            }
            if (credential is null) throw new JobFailedException("auth", "This agent has no password for the connection yet. Type it in Fortress.");
        }
        return (await Adapters.OpenAsync(settings, credential, ct), settings, allow);
    }
}

/// <summary>Receive the password sealed in the browser, open it with this agent's sealing key and keep it (protected) for the connection.</summary>
public sealed class StoreCredentialHandler(Func<ECDiffieHellman> sealingKey, CredentialStore credentials) : IJobHandler
{
    public string Kind => "store_credential";

    public Task<JsonNode?> RunAsync(AgentJob job, JobContext context, CancellationToken ct)
    {
        var id = DatabaseJobContext.ConnectionId(job);
        if (job.Spec?["sealed"] is not JsonObject s) throw new JobFailedException("invalid", "The job carries no password. Type it again in Fortress.");
        string Part(string k) => s[k]?.GetValue<string>() ?? throw new JobFailedException("invalid", "The sealed password is incomplete. Type it again in Fortress.");
        byte[] plain;
        try
        {
            plain = SealedBox.Open(sealingKey(), id, Part("epk"), Part("iv"), Part("ct"));
        }
        catch (Exception e) when (e is CryptographicException or FormatException)
        {
            throw new JobFailedException("invalid", "The password could not be opened: it was sealed for another key or connection. Reload the page in Fortress and type it again.");
        }
        try
        {
            var credential = CredentialStore.Parse(plain) ?? throw new JobFailedException("invalid", "The sealed content is not a user name and password. Type them again in Fortress.");
            credentials.Save(id, credential);
            return Task.FromResult<JsonNode?>(new JsonObject { ["stored"] = true, ["username"] = credential.Username });
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plain);
        }
    }
}

/// <summary>Sign in to the database and say what answered. A failure goes back with the database's own reason (never the password).</summary>
public sealed class TestConnectionHandler(DatabaseJobContext databases) : IJobHandler
{
    public string Kind => "test_connection";

    public async Task<JsonNode?> RunAsync(AgentJob job, JobContext context, CancellationToken ct)
    {
        if (FolderJobs.IsFolder(job)) return FolderJobs.Test(job, databases.AllowListPath);
        if (RestSettings.IsRest(job)) return await RestJobs.TestAsync(job, databases, ct);
        var (db, settings, allow) = await databases.OpenAsync(job, ct);
        await using (db)
        {
            var (product, user, database) = await db.DescribeAsync(ct);
            var schemas = (await db.SchemasAsync(ct)).Where(allow.AllowsSchema).ToArray();
            return new JsonObject
            {
                ["ok"] = true,
                ["message"] = $"Signed in to {product} as {user} (database {database}); {schemas.Length} schema{(schemas.Length == 1 ? "" : "s")} can be read" +
                              (allow.Limited ? " within this agent's allow-list" : ""),
                ["product"] = product,
                ["user"] = user,
                ["database"] = database,
                ["engine"] = settings.Engine,
                ["allowListed"] = allow.Limited,
            };
        }
    }
}

/// <summary>List schemas, then the tables and views of one, then the columns, keys and foreign keys of one table or view.</summary>
public sealed class DiscoverHandler(DatabaseJobContext databases) : IJobHandler
{
    public string Kind => "discover";

    public async Task<JsonNode?> RunAsync(AgentJob job, JobContext context, CancellationToken ct)
    {
        if (FolderJobs.IsFolder(job)) return FolderJobs.Discover(job, databases.AllowListPath);
        if (RestSettings.IsRest(job)) throw new JobFailedException("invalid", "An API is not browsed: try one of its addresses");
        var request = DatabaseJobContext.Request(job);
        var level = request["level"]?.GetValue<string>() ?? "schemas";
        var schema = request["schema"]?.GetValue<string>();
        var name = request["object"]?.GetValue<string>();
        var (db, _, allow) = await databases.OpenAsync(job, ct);
        await using (db)
        {
            switch (level)
            {
                case "schemas":
                    return new JsonObject
                    {
                        ["level"] = "schemas",
                        ["schemas"] = new JsonArray((await db.SchemasAsync(ct)).Where(allow.AllowsSchema).Select(s => (JsonNode)new JsonObject { ["name"] = s }).ToArray()),
                        ["allowListed"] = allow.Limited,
                    };
                case "objects":
                    if (schema is null) throw new JobFailedException("invalid", "Choose the schema");
                    if (!allow.AllowsSchema(schema)) throw NotAllowed(schema);
                    var objects = (await db.ObjectsAsync(schema, ct)).Where(o => allow.AllowsObject(schema, o.Name)).Take(2000).ToArray();
                    return new JsonObject
                    {
                        ["level"] = "objects",
                        ["schema"] = schema,
                        ["objects"] = new JsonArray(objects.Select(o => (JsonNode)new JsonObject { ["name"] = o.Name, ["kind"] = o.Kind, ["rowEstimate"] = o.RowEstimate }).ToArray()),
                        ["allowListed"] = allow.Limited,
                    };
                case "columns":
                    if (schema is null || name is null) throw new JobFailedException("invalid", "Choose the table or view");
                    if (!allow.AllowsObject(schema, name)) throw NotAllowed($"{schema}.{name}");
                    var shape = await db.ColumnsAsync(schema, name, ct) ?? throw NotFound(schema, name);
                    return new JsonObject
                    {
                        ["level"] = "columns",
                        ["schema"] = schema,
                        ["object"] = name,
                        ["columns"] = new JsonArray(shape.Columns.Select(c => (JsonNode)new JsonObject
                        {
                            ["name"] = c.Name, ["type"] = c.DataType, ["nullable"] = c.Nullable, ["primaryKey"] = c.PrimaryKey,
                        }).ToArray()),
                        ["foreignKeys"] = new JsonArray(shape.ForeignKeys.Select(f => (JsonNode)new JsonObject
                        {
                            ["name"] = f.Name,
                            ["columns"] = new JsonArray(f.Columns.Select(x => (JsonNode)JsonValue.Create(x)).ToArray()),
                            ["references"] = new JsonObject
                            {
                                ["schema"] = f.ReferencedSchema, ["object"] = f.ReferencedObject,
                                ["columns"] = new JsonArray(f.ReferencedColumns.Select(x => (JsonNode)JsonValue.Create(x)).ToArray()),
                            },
                        }).ToArray()),
                    };
                default:
                    throw new JobFailedException("invalid", "Browse schemas, tables and views, or columns");
            }
        }
    }

    internal static JobFailedException NotAllowed(string what) => new("refused", $"{what} is not on this agent's allow-list (allowlist.json on the agent's machine)");
    internal static JobFailedException NotFound(string schema, string name) => new("not_found", $"There is no table or view {schema}.{name} that this sign-in can read");
}

/// <summary>
/// The first rows of a table or view. The agent builds the query itself, from the columns the database listed for that table: the request only
/// names the schema, the table and how many rows (at most 50).
/// </summary>
public sealed class PreviewHandler(DatabaseJobContext databases) : IJobHandler
{
    public string Kind => "preview";

    /// <summary>Job results are kept small (Fortress takes at most 200 kB); rows are dropped from the end to fit.</summary>
    public const int MaxResultBytes = 180_000;

    public async Task<JsonNode?> RunAsync(AgentJob job, JobContext context, CancellationToken ct)
    {
        if (FolderJobs.IsFolder(job)) return await FolderJobs.PreviewAsync(job, databases.AllowListPath, context, ct);
        if (RestSettings.IsRest(job)) return await RestJobs.PreviewAsync(job, databases, ct);
        var request = DatabaseJobContext.Request(job);
        var schema = request["schema"]?.GetValue<string>() ?? throw new JobFailedException("invalid", "Choose the table or view to preview");
        var name = request["object"]?.GetValue<string>() ?? throw new JobFailedException("invalid", "Choose the table or view to preview");
        var limit = Math.Clamp(request["limit"]?.GetValue<int>() ?? 20, 1, 50);
        var (db, _, allow) = await databases.OpenAsync(job, ct);
        await using (db)
        {
            if (!allow.AllowsObject(schema, name)) throw DiscoverHandler.NotAllowed($"{schema}.{name}");
            var shape = await db.ColumnsAsync(schema, name, ct) ?? throw DiscoverHandler.NotFound(schema, name);
            if (shape.Columns.Count == 0) throw new JobFailedException("refused", $"This sign-in cannot read any column of {schema}.{name}");
            var rows = await db.PreviewAsync(shape, limit, ct);
            var jsonRows = new JsonArray();
            var truncated = false;
            var size = 0;
            foreach (var row in rows)
            {
                var o = new JsonObject();
                foreach (var c in shape.Columns) o[c.Name] = DbValues.ToJson(row.TryGetValue(c.Name, out var v) ? v : null);
                var bytes = JsonSerializer.SerializeToUtf8Bytes(o).Length;
                if (size + bytes > MaxResultBytes) { truncated = true; break; }
                size += bytes;
                jsonRows.Add(o);
            }
            return new JsonObject
            {
                ["schema"] = schema,
                ["object"] = name,
                ["columns"] = new JsonArray(shape.Columns.Select(c => (JsonNode)new JsonObject { ["name"] = c.Name, ["type"] = c.DataType }).ToArray()),
                ["rows"] = jsonRows,
                ["truncated"] = truncated,
            };
        }
    }
}
