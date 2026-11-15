using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Fortress.Agent.Core;

/// <summary>
/// How to reach a database, from the connection's settings in Fortress (non-secret only; the password is held by this agent, see <see cref="CredentialStore"/>).
/// The same rules as the database's app.integration_agent_config_problem are checked again here, so a settings value can never become part of a
/// connection string it was not meant for.
/// </summary>
public sealed partial record ConnectionSettings(
    string Engine, string Server, int? Port, string? Instance, string Database, string AuthType, bool Encrypt, bool TrustServerCertificate, int TimeoutSeconds)
{
    [GeneratedRegex(@"^(\(local\)|\.|[A-Za-z0-9]([A-Za-z0-9._-]{0,251}[A-Za-z0-9])?|[0-9A-Fa-f:.]{2,45})$")]
    private static partial Regex ServerPattern();
    [GeneratedRegex(@"^[A-Za-z0-9_$#-]{1,32}$")]
    private static partial Regex InstancePattern();
    [GeneratedRegex(@"^[^;='""\[\]\x00-\x1f]{1,128}$")]
    private static partial Regex DatabasePattern();

    public bool NeedsPassword => AuthType is "sql" or "password";

    public static ConnectionSettings Parse(JsonObject? c)
    {
        if (c is null) throw Invalid("The job did not say which database to use");
        string Text(string key) => c[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : throw Invalid($"The connection's {key} is missing");
        string? Opt(string key) => c[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
        bool Flag(string key, bool fallback) => c[key] is JsonValue v && v.TryGetValue<bool>(out var b) ? b : fallback;
        int? Num(string key) => c[key] is JsonValue v && v.TryGetValue<int>(out var n) ? n : null;

        var engine = Text("engine");
        if (engine is not ("sqlserver" or "postgres")) throw Invalid("This agent reads SQL Server and PostgreSQL databases");
        var server = Text("server");
        if (!ServerPattern().IsMatch(server)) throw Invalid("The database server's name is not valid");
        var port = Num("port");
        if (port is < 1 or > 65535) throw Invalid("The port is not valid");
        var instance = Opt("instance");
        if (instance is not null && (engine != "sqlserver" || !InstancePattern().IsMatch(instance))) throw Invalid("The instance name is not valid");
        var database = Text("database");
        if (!DatabasePattern().IsMatch(database) || database.Trim() != database) throw Invalid("The database name is not valid");
        var auth = Text("authType");
        if (engine == "sqlserver" && auth is not ("windows" or "sql")) throw Invalid("SQL Server signs in with Windows authentication or a SQL login");
        if (engine == "postgres" && auth != "password") throw Invalid("PostgreSQL signs in with a user name and password");
        var timeout = Math.Clamp(Num("timeoutSeconds") ?? 15, 5, 120);
        return new ConnectionSettings(engine, server, port, instance, database, auth, Flag("encrypt", true), Flag("trustServerCertificate", false), timeout);
    }

    private static JobFailedException Invalid(string message) => new("invalid", message);
}

/// <summary>A database sign-in held by this agent. Never sent to Fortress, never logged.</summary>
public sealed record DbCredential(string Username, string Password)
{
    public override string ToString() => $"DbCredential({Username}, ***)";
}

public sealed record DbObject(string Name, string Kind, long? RowEstimate);
public sealed record DbColumn(string Name, string DataType, bool Nullable, bool PrimaryKey);
public sealed record DbForeignKey(string Name, IReadOnlyList<string> Columns, string ReferencedSchema, string ReferencedObject, IReadOnlyList<string> ReferencedColumns);
public sealed record TableShape(string Schema, string Name, IReadOnlyList<DbColumn> Columns, IReadOnlyList<DbForeignKey> ForeignKeys);

/// <summary>
/// One open database. Every adapter reads only: each call runs in a read-only transaction (PostgreSQL) or with read-only intent and read
/// committed isolation (SQL Server), and the only query that touches data is <see cref="PreviewAsync"/>, built from names the database itself
/// listed in <see cref="ColumnsAsync"/>, quoted, with the row count as a parameter. Adapters turn the driver's errors into
/// <see cref="JobFailedException"/>s whose words never contain a connection string or password.
/// </summary>
public interface IDatabaseAdapter : IAsyncDisposable
{
    /// <summary>"PostgreSQL 16.4", signed in as, database.</summary>
    Task<(string Product, string User, string Database)> DescribeAsync(CancellationToken ct);
    Task<IReadOnlyList<string>> SchemasAsync(CancellationToken ct);
    Task<IReadOnlyList<DbObject>> ObjectsAsync(string schema, CancellationToken ct);
    /// <summary>Null when the table or view does not exist or this sign-in cannot read it.</summary>
    Task<TableShape?> ColumnsAsync(string schema, string name, CancellationToken ct);
    Task<IReadOnlyList<IReadOnlyDictionary<string, object?>>> PreviewAsync(TableShape shape, int limit, CancellationToken ct);
}

public interface IDatabaseAdapterFactory
{
    IReadOnlyCollection<string> Engines { get; }
    Task<IDatabaseAdapter> OpenAsync(ConnectionSettings settings, DbCredential? credential, CancellationToken ct);
}

/// <summary>
/// Values as they go to Fortress (AG-D7): numbers that fit stay numbers, decimals become text so no digit is lost, dates and times become ISO
/// text, binary is described, long text is cut. The import mapping reads the text forms it already understands.
/// </summary>
public static class DbValues
{
    public const int MaxText = 1000;

    public static JsonNode? ToJson(object? value) => value switch
    {
        null or DBNull => null,
        bool b => JsonValue.Create(b),
        byte or sbyte or short or ushort or int or uint or long => JsonValue.Create(Convert.ToInt64(value, CultureInfo.InvariantCulture)),
        ulong u => JsonValue.Create(u.ToString(CultureInfo.InvariantCulture)),
        float f when float.IsFinite(f) => JsonValue.Create((double)f),
        double d when double.IsFinite(d) => JsonValue.Create(d),
        float or double => JsonValue.Create(Convert.ToString(value, CultureInfo.InvariantCulture)),
        decimal m => JsonValue.Create(m.ToString(CultureInfo.InvariantCulture)),
        DateOnly d => JsonValue.Create(d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)),
        TimeOnly t => JsonValue.Create(t.ToString("HH:mm:ss.FFFFFFF", CultureInfo.InvariantCulture)),
        DateTime dt => JsonValue.Create(dt.Kind == DateTimeKind.Unspecified && dt.TimeOfDay == TimeSpan.Zero
            ? dt.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)
            : dt.ToString(dt.Kind == DateTimeKind.Utc ? "yyyy-MM-dd'T'HH:mm:ss.FFFFFFF'Z'" : "yyyy-MM-dd'T'HH:mm:ss.FFFFFFF", CultureInfo.InvariantCulture)),
        DateTimeOffset o => JsonValue.Create(o.ToString("O", CultureInfo.InvariantCulture)),
        TimeSpan ts => JsonValue.Create(ts.ToString("c", CultureInfo.InvariantCulture)),
        Guid g => JsonValue.Create(g.ToString()),
        byte[] bytes => JsonValue.Create($"(binary, {bytes.Length} bytes)"),
        string s => JsonValue.Create(s.Length <= MaxText ? s : s[..MaxText] + "…"),
        _ => JsonValue.Create(Cut(Convert.ToString(value, CultureInfo.InvariantCulture) ?? "")),
    };

    private static string Cut(string s) => s.Length <= MaxText ? s : s[..MaxText] + "…";
}

/// <summary>
/// The customer's own limit on what this agent may read (AG-D5), in allowlist.json beside the agent's identity, read afresh for every job:
/// <code>{ "databases": ["ERP"], "schemas": ["dbo"], "objects": ["erp.orders", "erp.v_*"] }</code>
/// Each list is optional; names ignore case and * matches any run of characters. No file, or empty lists, means whatever the database sign-in
/// can read — which stays the real boundary: give the agent a login that can only read what Fortress needs.
/// </summary>
public sealed class LocalAllowList
{
    public IReadOnlyList<string> Databases { get; init; } = [];
    public IReadOnlyList<string> Schemas { get; init; } = [];
    public IReadOnlyList<string> Objects { get; init; } = [];

    public static LocalAllowList Everything { get; } = new();

    public bool Limited => Databases.Count > 0 || Schemas.Count > 0 || Objects.Count > 0;

    public static LocalAllowList Load(string path)
    {
        if (!File.Exists(path)) return Everything;
        JsonNode? node;
        try
        {
            node = JsonNode.Parse(File.ReadAllText(path));
        }
        catch (System.Text.Json.JsonException e)
        {
            throw new JobFailedException("invalid", $"The agent's allow-list ({Path.GetFileName(path)}) is not valid JSON: {e.Message}. Fix it on the agent's machine.");
        }
        IReadOnlyList<string> List(string key) => node?[key] is JsonArray a
            ? a.Select(x => x?.GetValue<string>()?.Trim()).Where(x => !string.IsNullOrEmpty(x)).Select(x => x!).ToArray()
            : [];
        return new LocalAllowList { Databases = List("databases"), Schemas = List("schemas"), Objects = List("objects") };
    }

    public bool AllowsDatabase(string database) => Databases.Count == 0 || Databases.Any(d => Matches(d, database));

    public bool AllowsSchema(string schema) =>
        (Schemas.Count == 0 && Objects.Count == 0) || Schemas.Any(s => Matches(s, schema)) || Objects.Any(o => SchemaOf(o) is { } s && Matches(s, schema));

    public bool AllowsObject(string schema, string name)
    {
        if (Schemas.Count == 0 && Objects.Count == 0) return true;
        if (Schemas.Any(s => Matches(s, schema))) return true;
        return Objects.Any(o => SchemaOf(o) is { } s && Matches(s, schema) && Matches(o[(o.IndexOf('.') + 1)..], name));
    }

    private static string? SchemaOf(string pattern) => pattern.IndexOf('.') is var i and > 0 ? pattern[..i] : null;

    public static bool Matches(string pattern, string value) =>
        Regex.IsMatch(value, "^" + Regex.Escape(pattern).Replace("\\*", ".*") + "$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
}
