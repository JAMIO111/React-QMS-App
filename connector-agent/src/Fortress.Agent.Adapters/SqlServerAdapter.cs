using System.Data;
using Fortress.Agent.Core;
using Microsoft.Data.SqlClient;

namespace Fortress.Agent.Adapters;

/// <summary>
/// SQL Server, read only: ApplicationIntent=ReadOnly, every call in a READ COMMITTED transaction that is rolled back, catalogue from sys.* (it lists
/// only what the login may use), and the one data query built from the columns sys.columns listed, bracket-quoted, with TOP as a parameter.
/// Windows authentication signs in as the agent's service account; a SQL login uses the password this agent holds.
/// Not yet run against a real SQL Server (none in the build container, AG-D11): the first check is on a Windows machine with SQL Server.
/// </summary>
public sealed class SqlServerAdapter : IDatabaseAdapter
{
    private readonly SqlConnection connection;
    private readonly int commandTimeout;

    private SqlServerAdapter(SqlConnection connection, int commandTimeout)
    {
        this.connection = connection;
        this.commandTimeout = commandTimeout;
    }

    public static string ConnectionString(ConnectionSettings s, DbCredential? credential)
    {
        var dataSource = s.Server + (s.Instance is null ? "" : "\\" + s.Instance) + (s.Port is null ? "" : "," + s.Port.Value.ToString(System.Globalization.CultureInfo.InvariantCulture));
        var b = new SqlConnectionStringBuilder
        {
            DataSource = dataSource,
            InitialCatalog = s.Database,
            ApplicationIntent = ApplicationIntent.ReadOnly,
            ApplicationName = "Fortress Connector Agent",
            ConnectTimeout = s.TimeoutSeconds,
            Encrypt = s.Encrypt ? SqlConnectionEncryptOption.Mandatory : SqlConnectionEncryptOption.Optional,
            TrustServerCertificate = s.TrustServerCertificate,
            MultipleActiveResultSets = false,
            Pooling = false,
            PersistSecurityInfo = false,
        };
        if (s.AuthType == "windows")
        {
            b.IntegratedSecurity = true;
        }
        else
        {
            b.UserID = credential?.Username ?? "";
            b.Password = credential?.Password ?? "";
        }
        return b.ConnectionString;
    }

    public static async Task<IDatabaseAdapter> OpenAsync(ConnectionSettings settings, DbCredential? credential, CancellationToken ct)
    {
        var connection = new SqlConnection(ConnectionString(settings, credential));
        try
        {
            await connection.OpenAsync(ct);
            return new SqlServerAdapter(connection, 60);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            await connection.DisposeAsync();
            throw Translate(e, settings);
        }
    }

    public ValueTask DisposeAsync() => connection.DisposeAsync();

    private async Task<T> ReadAsync<T>(Func<SqlCommand, Task<T>> work, CancellationToken ct)
    {
        try
        {
            await using var tx = (SqlTransaction)await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
            await using var cmd = new SqlCommand { Connection = connection, Transaction = tx, CommandTimeout = commandTimeout };
            var result = await work(cmd);
            await tx.RollbackAsync(ct);
            return result;
        }
        catch (Exception e) when (e is not (OperationCanceledException or JobFailedException))
        {
            throw Translate(e, null);
        }
    }

    public Task<(string Product, string User, string Database)> DescribeAsync(CancellationToken ct) => ReadAsync(async cmd =>
    {
        cmd.CommandText = "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(64)), CAST(SERVERPROPERTY('Edition') AS nvarchar(128)), SUSER_SNAME(), DB_NAME()";
        await using var r = await cmd.ExecuteReaderAsync(ct);
        await r.ReadAsync(ct);
        return ($"SQL Server {r.GetString(0)} ({r.GetString(1)})", r.GetString(2), r.GetString(3));
    }, ct);

    public Task<IReadOnlyList<string>> SchemasAsync(CancellationToken ct) => ReadAsync<IReadOnlyList<string>>(async cmd =>
    {
        cmd.CommandText = """
            SELECT s.name FROM sys.schemas s
             WHERE EXISTS (SELECT 1 FROM sys.objects o WHERE o.schema_id = s.schema_id AND o.type IN ('U', 'V') AND o.is_ms_shipped = 0)
             ORDER BY s.name
            """;
        var list = new List<string>();
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct)) list.Add(r.GetString(0));
        return list;
    }, ct);

    public Task<IReadOnlyList<DbObject>> ObjectsAsync(string schema, CancellationToken ct) => ReadAsync<IReadOnlyList<DbObject>>(async cmd =>
    {
        cmd.CommandText = """
            SELECT o.name, o.type, (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = o.object_id AND p.index_id IN (0, 1))
              FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
             WHERE s.name = @schema AND o.type IN ('U', 'V') AND o.is_ms_shipped = 0
             ORDER BY o.name
            """;
        cmd.Parameters.Add(new SqlParameter("@schema", SqlDbType.NVarChar, 128) { Value = schema });
        var list = new List<DbObject>();
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct))
            list.Add(new DbObject(r.GetString(0), r.GetString(1).Trim() == "V" ? "view" : "table", r.IsDBNull(2) ? null : Convert.ToInt64(r.GetValue(2))));
        return list;
    }, ct);

    public Task<TableShape?> ColumnsAsync(string schema, string name, CancellationToken ct) => ReadAsync<TableShape?>(async cmd =>
    {
        cmd.Parameters.Add(new SqlParameter("@schema", SqlDbType.NVarChar, 128) { Value = schema });
        cmd.Parameters.Add(new SqlParameter("@name", SqlDbType.NVarChar, 128) { Value = name });
        cmd.CommandText = """
            SELECT o.object_id FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
             WHERE s.name = @schema AND o.name = @name AND o.type IN ('U', 'V')
            """;
        if (await cmd.ExecuteScalarAsync(ct) is not int objectId) return null;
        cmd.Parameters.Add(new SqlParameter("@id", SqlDbType.Int) { Value = objectId });
        cmd.CommandText = """
            SELECT c.name,
                   t.name + CASE WHEN t.name IN ('varchar', 'char', 'varbinary', 'binary') THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length AS varchar(10)) END + ')'
                                 WHEN t.name IN ('nvarchar', 'nchar') THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length / 2 AS varchar(10)) END + ')'
                                 WHEN t.name IN ('decimal', 'numeric') THEN '(' + CAST(c.precision AS varchar(5)) + ',' + CAST(c.scale AS varchar(5)) + ')'
                                 ELSE '' END,
                   c.is_nullable,
                   CAST(CASE WHEN EXISTS (SELECT 1 FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                                          WHERE i.object_id = c.object_id AND i.is_primary_key = 1 AND ic.column_id = c.column_id) THEN 1 ELSE 0 END AS bit)
              FROM sys.columns c JOIN sys.types t ON t.user_type_id = c.user_type_id
             WHERE c.object_id = @id
             ORDER BY c.column_id
            """;
        var columns = new List<DbColumn>();
        await using (var r = await cmd.ExecuteReaderAsync(ct))
            while (await r.ReadAsync(ct)) columns.Add(new DbColumn(r.GetString(0), r.GetString(1), r.GetBoolean(2), r.GetBoolean(3)));
        cmd.CommandText = """
            SELECT fk.name, pc.name, rs.name, ro.name, rc.name
              FROM sys.foreign_keys fk
              JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
              JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
              JOIN sys.objects ro ON ro.object_id = fkc.referenced_object_id
              JOIN sys.schemas rs ON rs.schema_id = ro.schema_id
              JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
             WHERE fk.parent_object_id = @id
             ORDER BY fk.name, fkc.constraint_column_id
            """;
        var parts = new List<(string Fk, string Col, string RefSchema, string RefObject, string RefCol)>();
        await using (var r = await cmd.ExecuteReaderAsync(ct))
            while (await r.ReadAsync(ct)) parts.Add((r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetString(4)));
        var keys = parts.GroupBy(p => p.Fk)
            .Select(g => new DbForeignKey(g.Key, g.Select(p => p.Col).ToArray(), g.First().RefSchema, g.First().RefObject, g.Select(p => p.RefCol).ToArray()))
            .ToList();
        return new TableShape(schema, name, columns, keys);
    }, ct);

    public Task<IReadOnlyList<IReadOnlyDictionary<string, object?>>> PreviewAsync(TableShape shape, int limit, CancellationToken ct) =>
        ReadAsync<IReadOnlyList<IReadOnlyDictionary<string, object?>>>(async cmd =>
        {
            cmd.CommandText = PreviewSql(shape);
            cmd.Parameters.Add(new SqlParameter("@limit", SqlDbType.Int) { Value = Math.Clamp(limit, 1, 50) });
            var rows = new List<IReadOnlyDictionary<string, object?>>();
            await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct))
            {
                var row = new Dictionary<string, object?>(StringComparer.Ordinal);
                for (var i = 0; i < shape.Columns.Count; i++)
                {
                    var v = ReadValue(r, i);
                    row[shape.Columns[i].Name] = v;
                }
                rows.Add(row);
            }
            return rows;
        }, ct);

    public Task<IReadOnlyList<ExtractedRow>> ExtractPageAsync(ExtractQuery q, CancellationToken ct) =>
        ReadAsync<IReadOnlyList<ExtractedRow>>(async cmd =>
        {
            var (sql, values) = ExtractSql(q);
            cmd.CommandText = sql;
            // Values go as Unicode text; SQL Server converts each to the type of the column it is compared with.
            for (var i = 0; i < values.Count; i++) cmd.Parameters.Add(new SqlParameter($"@p{i + 1}", SqlDbType.NVarChar, 4000) { Value = values[i] });
            cmd.Parameters.Add(new SqlParameter("@limit", SqlDbType.Int) { Value = Math.Clamp(q.Limit, 1, 1000) });
            var rows = new List<ExtractedRow>();
            await using var r = await cmd.ExecuteReaderAsync(ct);
            var keyIndex = PostgresAdapter.IndexOf(q.Columns, q.Key);
            while (await r.ReadAsync(ct))
            {
                var row = new Dictionary<string, object?>(StringComparer.Ordinal);
                for (var i = 0; i < q.Columns.Count; i++)
                {
                    var v = ReadValue(r, i);
                    row[q.Columns[i].Name] = v;
                }
                var key = row[q.Columns[keyIndex].Name] ?? throw new JobFailedException("internal", "A row came back with no key");
                rows.Add(new ExtractedRow(row, DbValues.KeyText(key)));
            }
            return rows;
        }, ct);

    /// <summary>
    /// An extraction page: names bracket-quoted from sys.columns; the key of the last row and each filter's value are @p1, @p2 … and the row
    /// count is @limit. Only a SELECT is ever built.
    /// </summary>
    public static (string Sql, IReadOnlyList<string> Values) ExtractSql(ExtractQuery q)
    {
        var values = new List<string>();
        var where = new List<string> { $"{Quote(q.Key.Name)} IS NOT NULL" };
        if (q.AfterKey is not null)
        {
            values.Add(q.AfterKey);
            where.Add($"{Quote(q.Key.Name)} > @p{values.Count}");
        }
        foreach (var f in q.Filters)
        {
            var op = ExtractFilter.Sql(f.Op);
            if (ExtractFilter.NoValue.Contains(f.Op)) { where.Add($"{Quote(f.Column.Name)} {op}"); continue; }
            values.Add(f.Value ?? throw new JobFailedException("invalid", $"The filter on {f.Column.Name} has no value"));
            where.Add($"{Quote(f.Column.Name)} {op} @p{values.Count}");
        }
        var sql = $"SELECT TOP (@limit) {string.Join(", ", q.Columns.Select(c => Quote(c.Name)))} FROM {Quote(q.Shape.Schema)}.{Quote(q.Shape.Name)}" +
                  $" WHERE {string.Join(" AND ", where)} ORDER BY {Quote(q.Key.Name)}";
        return (sql, values);
    }

    /// <summary>The only data query: columns and table as sys.columns named them, each bracket-quoted; the row count is the parameter @limit.</summary>
    public static string PreviewSql(TableShape shape) =>
        $"SELECT TOP (@limit) {string.Join(", ", shape.Columns.Select(c => Quote(c.Name)))} FROM {Quote(shape.Schema)}.{Quote(shape.Name)}";

    /// <summary>
    /// One column's value. SqlClient hands a <c>date</c> back as a midnight <see cref="DateTime"/> and a <c>time</c> as a <see cref="TimeSpan"/>;
    /// they become <see cref="DateOnly"/> / <see cref="TimeOnly"/> so they read "2026-03-02" and "08:30:00", as from PostgreSQL and MySQL.
    /// </summary>
    internal static object? ReadValue(System.Data.Common.DbDataReader r, int i)
    {
        try
        {
            if (r.IsDBNull(i)) return null;
            var v = r.GetValue(i);
            var type = r.GetDataTypeName(i);
            return (v, type.ToLowerInvariant()) switch
            {
                (DateTime d, "date") => DateOnly.FromDateTime(d),
                (TimeSpan t, "time") when t >= TimeSpan.Zero && t < TimeSpan.FromDays(1) => TimeOnly.FromTimeSpan(t),
                _ => v,
            };
        }
        catch (Exception e) when (e is InvalidCastException or NotSupportedException) { return r.GetProviderSpecificValue(i)?.ToString(); }
    }

    public static string Quote(string identifier) => "[" + identifier.Replace("]", "]]") + "]";

    private static bool HasSocketError(Exception e)
    {
        for (var x = e.InnerException; x is not null; x = x.InnerException)
            if (x is System.Net.Sockets.SocketException) return true;
        return false;
    }

    internal static JobFailedException Translate(Exception e, ConnectionSettings? s)
    {
        var where = s is null ? "the database" : s.Server + (s.Instance is null ? "" : "\\" + s.Instance);
        return e switch
        {
            SqlException q when q.Number is 18456 or 18452 or 18470 or 18487 or 18488 => new JobFailedException("auth", $"SQL Server refused the sign-in: {q.Message}"),
            SqlException q when q.Number == 4060 => new JobFailedException("not_found", $"SQL Server cannot open that database for this sign-in: {q.Message}"),
            SqlException q when q.Number is 229 or 230 => new JobFailedException("refused", $"SQL Server refused: {q.Message}"),
            SqlException q when q.Number == -2 => new JobFailedException("timeout", "SQL Server took too long to answer"),
            // Windows reports the socket or named-pipe error; the managed network layer (Linux, and Windows with it switched on) reports
            // SNI error 35 ("an internal exception was caught") with the refused socket inside.
            SqlException q when q.Number is 53 or 2 or -1 or 40 or 26 or 35 or 10060 or 10061 or 10053 or 10054 or 233 or 64 || HasSocketError(q) =>
                new JobFailedException("network", $"Could not reach {where}: {q.Message}", transient: true),
            // Shutting down, a deadlock victim, the database recovering or unavailable: worth another attempt (AG6a, AG6-D5).
            SqlException q when q.Number is 6005 or 1205 or 40613 or 40197 or 40501 or 49918 or 49919 or 49920 =>
                new JobFailedException("network", $"SQL Server is not available right now: {q.Message} ({q.Number})", transient: true),
            SqlException q => new JobFailedException("refused", $"SQL Server said: {q.Message} ({q.Number})"),
            TimeoutException => new JobFailedException("timeout", $"{where} did not answer in time", transient: true),
            _ => new JobFailedException("internal", $"The agent could not read the database ({e.GetType().Name})"),
        };
    }
}
