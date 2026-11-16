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
        if (engine is not ("sqlserver" or "postgres" or "mysql")) throw Invalid("This agent reads SQL Server, PostgreSQL and MySQL databases");
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
        if (engine == "mysql" && auth != "password") throw Invalid("MySQL signs in with a user name and password");
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
    /// <summary>
    /// The next page of an extraction: rows whose key is not empty and after <see cref="ExtractQuery.AfterKey"/>, matching the filters, in key
    /// order. Values (the filters' and the key's) are parameters, never part of the SQL text.
    /// </summary>
    Task<IReadOnlyList<ExtractedRow>> ExtractPageAsync(ExtractQuery query, CancellationToken ct);
}

/// <summary>One filter of a record source: column (as the catalogue named it), a test from a fixed list, and the value as text (null for the empty tests).</summary>
public sealed record ExtractFilter(DbColumn Column, string Op, string? Value)
{
    public static readonly IReadOnlySet<string> Ops = new HashSet<string>(StringComparer.Ordinal) { "eq", "ne", "gt", "gte", "lt", "lte", "is_null", "not_null" };
    public static readonly IReadOnlySet<string> NoValue = new HashSet<string>(StringComparer.Ordinal) { "is_null", "not_null" };

    /// <summary>The SQL comparison for a test from the fixed list; anything else is refused before a query is built.</summary>
    public static string Sql(string op) => op switch
    {
        "eq" => "=", "ne" => "<>", "gt" => ">", "gte" => ">=", "lt" => "<", "lte" => "<=", "is_null" => "IS NULL", "not_null" => "IS NOT NULL",
        _ => throw new JobFailedException("invalid", $"A filter cannot test \"{op}\""),
    };
}

/// <summary>
/// One page of an extraction (AG3): the columns to read (catalogue names), the key column the rows are ordered by, filters, the key of the last row
/// already sent (keyset paging: rows after it), and how many rows. Built only from what <see cref="IDatabaseAdapter.ColumnsAsync"/> listed.
/// </summary>
public sealed record ExtractQuery(TableShape Shape, IReadOnlyList<DbColumn> Columns, DbColumn Key, IReadOnlyList<ExtractFilter> Filters, string? AfterKey, int Limit);

/// <summary>A row read for an extraction, and its key as text (to carry on after it, and to resume after a restart).</summary>
public sealed record ExtractedRow(IReadOnlyDictionary<string, object?> Values, string KeyText);

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

    /// <summary>Text cut for an extraction: longer than a preview, as long as Fortress's longest text field.</summary>
    public const int MaxExtractText = 5000;

    public static JsonNode? ToJson(object? value) => ToJson(value, MaxText);

    public static JsonNode? ToJson(object? value, int maxText) => value switch
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
        string s => JsonValue.Create(Cut(s, maxText)),
        _ => JsonValue.Create(Cut(Convert.ToString(value, CultureInfo.InvariantCulture) ?? "", maxText)),
    };

    private static string Cut(string s, int max) => s.Length <= max ? s : s[..max] + "…";

    /// <summary>
    /// The higher of a high-water mark (as text, from Fortress or from earlier rows) and a value just read, as text (AG4). Compared by the value's
    /// own type — numbers as numbers, dates and times as instants — so "10" is above "9"; text compares ordinally. A mark that cannot be read as
    /// the value's type gives way to the value.
    /// </summary>
    public static string HigherMark(string? mark, object value)
    {
        var text = KeyText(value);
        if (mark is null) return text;
        var inv = CultureInfo.InvariantCulture;
        int? cmp = value switch
        {
            byte or sbyte or short or ushort or int or uint or long or ulong or decimal =>
                decimal.TryParse(mark, NumberStyles.Number | NumberStyles.AllowExponent, inv, out var m) ? Convert.ToDecimal(value, inv).CompareTo(m) : null,
            float or double => double.TryParse(mark, NumberStyles.Float, inv, out var d) ? Convert.ToDouble(value, inv).CompareTo(d) : null,
            DateTimeOffset o => DateTimeOffset.TryParse(mark, inv, DateTimeStyles.RoundtripKind, out var mo) ? o.CompareTo(mo) : null,
            DateTime dt => DateTime.TryParse(mark, inv, DateTimeStyles.RoundtripKind, out var md) ? dt.CompareTo(md) : null,
            DateOnly dd => DateOnly.TryParse(mark, inv, DateTimeStyles.None, out var mdd) ? dd.CompareTo(mdd) : null,
            TimeOnly tt => TimeOnly.TryParse(mark, inv, DateTimeStyles.None, out var mt) ? tt.CompareTo(mt) : null,
            _ => string.CompareOrdinal(text, mark),
        };
        return cmp is null or > 0 ? text : mark;
    }

    /// <summary>
    /// A key value as text the database reads back as the same value (never cut): ISO dates and times with every fraction digit, decimals with a dot.
    /// Sent as a parameter for "rows after this one", and kept by Fortress so a restarted extraction carries on from it.
    /// </summary>
    public static string KeyText(object value) => value switch
    {
        bool b => b ? "true" : "false",
        DateOnly d => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        TimeOnly t => t.ToString("HH:mm:ss.fffffff", CultureInfo.InvariantCulture),
        DateTime dt => dt.ToString(dt.Kind == DateTimeKind.Utc ? "yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'" : "yyyy-MM-dd'T'HH:mm:ss.fffffff", CultureInfo.InvariantCulture),
        DateTimeOffset o => o.ToString("O", CultureInfo.InvariantCulture),
        byte[] bytes => Convert.ToHexString(bytes),
        IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
        _ => Convert.ToString(value, CultureInfo.InvariantCulture) ?? "",
    };
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
    /// <summary>Folders this agent may read (AG5b), each with everything below it. Unlike the other lists, none means no folder at all.</summary>
    public IReadOnlyList<string> Folders { get; init; } = [];
    /// <summary>
    /// Hosts of internal APIs this agent may call (AG5c): "erp.factory.local", "10.0.4.12", "erp.factory.local:8080" or "*.factory.local". A name
    /// allows that host only (a "*." entry its sub-domains); with a port, only that port. None means no API at all.
    /// </summary>
    public IReadOnlyList<string> Hosts { get; init; } = [];
    /// <summary>
    /// Database servers this agent may sign in to (AG6d): host names or addresses, "*." for sub-domains. When listed, only those servers; when not,
    /// any server for a password sign-in, but none for Windows authentication, which signs in as this agent's own service account.
    /// </summary>
    public IReadOnlyList<string> Servers { get; init; } = [];

    /// <summary>
    /// An internal API's key, token or password may be sent over plain http (AG6d review). Off unless <c>"plainHttpSignIn": true</c>: without it a
    /// connection that signs in must use https, so the secret does not cross the network readable.
    /// </summary>
    public bool PlainHttpSignIn { get; init; }

    public static LocalAllowList Everything { get; } = new();

    public bool AllowsServer(string server, string authType)
    {
        if (Servers.Count == 0) return authType != "windows";
        var host = server.Trim().TrimEnd('.').ToLowerInvariant();
        return Servers.Any(raw =>
        {
            var entry = raw.Trim().TrimEnd('.').ToLowerInvariant();
            if (entry.StartsWith("*.")) return host.EndsWith(entry[1..], StringComparison.Ordinal) && host.Length > entry.Length - 1;
            return entry == host;
        });
    }

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
        return new LocalAllowList { Databases = List("databases"), Schemas = List("schemas"), Objects = List("objects"), Folders = List("folders"), Hosts = List("hosts"), Servers = List("servers"),
            PlainHttpSignIn = node?["plainHttpSignIn"] is JsonValue p && p.TryGetValue<bool>(out var plain) && plain };
    }

    /// <summary>The folder or one above it is listed. Paths are compared whole, after resolving them, ignoring case on Windows.</summary>
    public bool AllowsFolder(string folder)
    {
        if (Folders.Count == 0) return false;
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        static string Full(string p) => Path.TrimEndingDirectorySeparator(Path.GetFullPath(p));
        string target;
        try { target = Full(folder); } catch (Exception e) when (e is ArgumentException or NotSupportedException or PathTooLongException) { return false; }
        foreach (var allowed in Folders)
        {
            string root;
            try { root = Full(allowed); } catch (Exception e) when (e is ArgumentException or NotSupportedException or PathTooLongException) { continue; }
            if (string.Equals(target, root, comparison)) return true;
            if (target.StartsWith(root + Path.DirectorySeparatorChar, comparison) || target.StartsWith(root + Path.AltDirectorySeparatorChar, comparison)) return true;
        }
        return false;
    }

    /// <summary>
    /// The folder, or a folder between it and the allowed folder that contains it, is a link (junction or symbolic link). The allowed folder itself
    /// may be one: an administrator listed it knowingly.
    /// </summary>
    public bool LinkBelowAllowed(string folder)
    {
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        static string Full(string p) => Path.TrimEndingDirectorySeparator(Path.GetFullPath(p));
        var target = Full(folder);
        var root = Folders.Select(f => { try { return Full(f); } catch (Exception e) when (e is ArgumentException or NotSupportedException or PathTooLongException) { return null; } })
            .Where(r => r is not null && (string.Equals(target, r, comparison) || target.StartsWith(r + Path.DirectorySeparatorChar, comparison)))
            .OrderBy(r => r!.Length).FirstOrDefault();
        if (root is null) return true;
        for (var dir = new DirectoryInfo(target); dir is not null && !string.Equals(Full(dir.FullName), root, comparison); dir = dir.Parent)
            if (dir.Exists && (dir.Attributes & FileAttributes.ReparsePoint) != 0) return true;
        return false;
    }

    /// <summary>The address's host (and port, when the entry names one) is listed. Host names ignore case; addresses compare as addresses.</summary>
    public bool AllowsHost(Uri uri)
    {
        if (Hosts.Count == 0) return false;
        var host = uri.IdnHost.Trim('[', ']').ToLowerInvariant();
        foreach (var raw in Hosts)
        {
            var entry = raw.Trim().ToLowerInvariant();
            int? port = null;
            // "host:port" or "[v6]:port"; a bare IPv6 address has more than one colon and no port.
            if (entry.StartsWith('['))
            {
                var close = entry.IndexOf(']');
                if (close < 0) continue;
                if (close + 1 < entry.Length)
                {
                    if (entry[close + 1] != ':' || !int.TryParse(entry[(close + 2)..], out var p6)) continue;
                    port = p6;
                }
                entry = entry[1..close];
            }
            else if (entry.Count(c => c == ':') == 1)
            {
                var colon = entry.IndexOf(':');
                if (!int.TryParse(entry[(colon + 1)..], out var p)) continue;
                port = p;
                entry = entry[..colon];
            }
            if (port is { } want && want != uri.Port) continue;
            if (System.Net.IPAddress.TryParse(entry, out var listed))
            {
                if (System.Net.IPAddress.TryParse(host, out var asked) && listed.Equals(asked)) return true;
                continue;
            }
            if (entry.StartsWith("*."))
            {
                if (host.EndsWith(entry[1..], StringComparison.Ordinal) && host.Length > entry.Length - 1) return true;
                continue;
            }
            if (host == entry.TrimEnd('.')) return true;
        }
        return false;
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
