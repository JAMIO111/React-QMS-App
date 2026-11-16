using System.Net.Sockets;
using Fortress.Agent.Core;
using Npgsql;

namespace Fortress.Agent.Adapters;

/// <summary>
/// PostgreSQL, read only (AG0 §13 proved the pattern against a real server): every call runs in its own READ ONLY transaction with a statement
/// timeout, the catalogue is read from pg_catalog (information_schema hides keys from a login that can only SELECT), and the one data query is
/// built from the columns the catalogue listed, quoted, with LIMIT as a parameter.
/// </summary>
public sealed class PostgresAdapter : IDatabaseAdapter
{
    private readonly NpgsqlConnection connection;
    private readonly int commandTimeout;

    private PostgresAdapter(NpgsqlConnection connection, int commandTimeout)
    {
        this.connection = connection;
        this.commandTimeout = commandTimeout;
    }

    public static string ConnectionString(ConnectionSettings s, DbCredential? credential)
    {
        var b = new NpgsqlConnectionStringBuilder
        {
            Host = s.Server,
            Port = s.Port ?? 5432,
            Database = s.Database,
            Username = credential?.Username,
            Password = credential?.Password,
            Timeout = s.TimeoutSeconds,
            CommandTimeout = 60,
            ApplicationName = "Fortress Connector Agent",
            SslMode = !s.Encrypt ? SslMode.Disable : s.TrustServerCertificate ? SslMode.Require : SslMode.VerifyFull,
            Pooling = false,
            IncludeErrorDetail = false,
        };
        return b.ConnectionString;
    }

    public static async Task<IDatabaseAdapter> OpenAsync(ConnectionSettings settings, DbCredential? credential, CancellationToken ct)
    {
        var connection = new NpgsqlConnection(ConnectionString(settings, credential));
        try
        {
            await connection.OpenAsync(ct);
            return new PostgresAdapter(connection, 60);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            await connection.DisposeAsync();
            throw Translate(e, settings);
        }
    }

    public ValueTask DisposeAsync() => connection.DisposeAsync();

    private async Task<T> ReadAsync<T>(Func<NpgsqlCommand, Task<T>> work, CancellationToken ct)
    {
        try
        {
            await using var tx = await connection.BeginTransactionAsync(ct);
            await using (var ro = new NpgsqlCommand("SET TRANSACTION READ ONLY", connection, tx)) await ro.ExecuteNonQueryAsync(ct);
            await using var cmd = new NpgsqlCommand { Connection = connection, Transaction = tx, CommandTimeout = commandTimeout };
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
        cmd.CommandText = "select current_setting('server_version'), current_user, current_database()";
        await using var r = await cmd.ExecuteReaderAsync(ct);
        await r.ReadAsync(ct);
        var version = r.GetString(0).Split(' ')[0];
        return ($"PostgreSQL {version}", r.GetString(1), r.GetString(2));
    }, ct);

    public Task<IReadOnlyList<string>> SchemasAsync(CancellationToken ct) => ReadAsync<IReadOnlyList<string>>(async cmd =>
    {
        cmd.CommandText = """
            select n.nspname from pg_catalog.pg_namespace n
             where n.nspname not like 'pg\_%' and n.nspname <> 'information_schema' and has_schema_privilege(n.oid, 'USAGE')
             order by n.nspname
            """;
        var list = new List<string>();
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct)) list.Add(r.GetString(0));
        return list;
    }, ct);

    public Task<IReadOnlyList<DbObject>> ObjectsAsync(string schema, CancellationToken ct) => ReadAsync<IReadOnlyList<DbObject>>(async cmd =>
    {
        cmd.CommandText = """
            select c.relname, c.relkind::text, case when c.reltuples >= 0 then c.reltuples::bigint end
              from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
             where n.nspname = $1 and c.relkind in ('r', 'v', 'm', 'p', 'f') and has_table_privilege(c.oid, 'SELECT')
             order by c.relname
            """;
        cmd.Parameters.Add(new NpgsqlParameter { Value = schema });
        var list = new List<DbObject>();
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct))
            list.Add(new DbObject(r.GetString(0), r.GetString(1) is "v" or "m" ? "view" : "table", r.IsDBNull(2) ? null : r.GetInt64(2)));
        return list;
    }, ct);

    public Task<TableShape?> ColumnsAsync(string schema, string name, CancellationToken ct) => ReadAsync<TableShape?>(async cmd =>
    {
        cmd.CommandText = """
            select a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod), not a.attnotnull,
                   exists (select 1 from pg_catalog.pg_index i where i.indrelid = c.oid and i.indisprimary and a.attnum = any (i.indkey))
              from pg_catalog.pg_class c
              join pg_catalog.pg_namespace n on n.oid = c.relnamespace
              join pg_catalog.pg_attribute a on a.attrelid = c.oid
             where n.nspname = $1 and c.relname = $2 and c.relkind in ('r', 'v', 'm', 'p', 'f')
               and a.attnum > 0 and not a.attisdropped and has_column_privilege(c.oid, a.attnum, 'SELECT')
             order by a.attnum
            """;
        cmd.Parameters.Add(new NpgsqlParameter { Value = schema });
        cmd.Parameters.Add(new NpgsqlParameter { Value = name });
        var columns = new List<DbColumn>();
        await using (var r = await cmd.ExecuteReaderAsync(ct))
            while (await r.ReadAsync(ct)) columns.Add(new DbColumn(r.GetString(0), r.GetString(1), r.GetBoolean(2), r.GetBoolean(3)));
        if (columns.Count == 0)
        {
            cmd.CommandText = """
                select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = $1 and c.relname = $2 and has_table_privilege(c.oid, 'SELECT')
                """;
            if (await cmd.ExecuteScalarAsync(ct) is null) return null;
        }
        cmd.CommandText = """
            select con.conname,
                   array(select a.attname from unnest(con.conkey) with ordinality k(n, o) join pg_catalog.pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n order by k.o),
                   rn.nspname, rc.relname,
                   array(select a.attname from unnest(con.confkey) with ordinality k(n, o) join pg_catalog.pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.n order by k.o)
              from pg_catalog.pg_constraint con
              join pg_catalog.pg_class c on c.oid = con.conrelid
              join pg_catalog.pg_namespace n on n.oid = c.relnamespace
              join pg_catalog.pg_class rc on rc.oid = con.confrelid
              join pg_catalog.pg_namespace rn on rn.oid = rc.relnamespace
             where n.nspname = $1 and c.relname = $2 and con.contype = 'f'
             order by con.conname
            """;
        var keys = new List<DbForeignKey>();
        await using (var r = await cmd.ExecuteReaderAsync(ct))
            while (await r.ReadAsync(ct))
                keys.Add(new DbForeignKey(r.GetString(0), r.GetFieldValue<string[]>(1), r.GetString(2), r.GetString(3), r.GetFieldValue<string[]>(4)));
        return new TableShape(schema, name, columns, keys);
    }, ct);

    public Task<IReadOnlyList<IReadOnlyDictionary<string, object?>>> PreviewAsync(TableShape shape, int limit, CancellationToken ct) =>
        ReadAsync<IReadOnlyList<IReadOnlyDictionary<string, object?>>>(async cmd =>
        {
            cmd.CommandText = PreviewSql(shape);
            cmd.Parameters.Add(new NpgsqlParameter { Value = Math.Clamp(limit, 1, 50) });
            var rows = new List<IReadOnlyDictionary<string, object?>>();
            await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct))
            {
                var row = new Dictionary<string, object?>(StringComparer.Ordinal);
                for (var i = 0; i < shape.Columns.Count; i++)
                {
                    object? v;
                    try { v = r.IsDBNull(i) ? null : r.GetValue(i); }
                    catch (InvalidCastException) { v = r.GetProviderSpecificValue(i)?.ToString(); }
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
            // Values go as untyped text: PostgreSQL reads each as the type of the column it is compared with (a date, a number, a boolean…).
            foreach (var v in values) cmd.Parameters.Add(new NpgsqlParameter { Value = v, NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Unknown });
            cmd.Parameters.Add(new NpgsqlParameter { Value = Math.Clamp(q.Limit, 1, 1000) });
            var rows = new List<ExtractedRow>();
            await using var r = await cmd.ExecuteReaderAsync(ct);
            var keyIndex = IndexOf(q.Columns, q.Key);
            while (await r.ReadAsync(ct))
            {
                var row = new Dictionary<string, object?>(StringComparer.Ordinal);
                for (var i = 0; i < q.Columns.Count; i++)
                {
                    object? v;
                    try { v = r.IsDBNull(i) ? null : r.GetValue(i); }
                    catch (InvalidCastException) { v = r.GetProviderSpecificValue(i)?.ToString(); }
                    row[q.Columns[i].Name] = v;
                }
                var key = row[q.Columns[keyIndex].Name] ?? throw new JobFailedException("internal", "A row came back with no key");
                rows.Add(new ExtractedRow(row, DbValues.KeyText(key)));
            }
            return rows;
        }, ct);

    internal static int IndexOf(IReadOnlyList<DbColumn> columns, DbColumn key)
    {
        for (var i = 0; i < columns.Count; i++) if (columns[i].Name == key.Name) return i;
        throw new JobFailedException("invalid", "The column that identifies each row must be read");
    }

    /// <summary>
    /// An extraction page: columns, table and every column in WHERE / ORDER BY as the catalogue named them, quoted; the key of the last row, each
    /// filter's value and the row count are the parameters $1, $2 … in that order (the row count last). Only a SELECT is ever built.
    /// </summary>
    public static (string Sql, IReadOnlyList<string> Values) ExtractSql(ExtractQuery q)
    {
        var values = new List<string>();
        var where = new List<string> { $"{Quote(q.Key.Name)} IS NOT NULL" };
        if (q.AfterKey is not null)
        {
            values.Add(q.AfterKey);
            where.Add($"{Quote(q.Key.Name)} > ${values.Count}");
        }
        foreach (var f in q.Filters)
        {
            var op = ExtractFilter.Sql(f.Op);
            if (ExtractFilter.NoValue.Contains(f.Op)) { where.Add($"{Quote(f.Column.Name)} {op}"); continue; }
            values.Add(f.Value ?? throw new JobFailedException("invalid", $"The filter on {f.Column.Name} has no value"));
            where.Add($"{Quote(f.Column.Name)} {op} ${values.Count}");
        }
        var sql = $"select {string.Join(", ", q.Columns.Select(c => Quote(c.Name)))} from {Quote(q.Shape.Schema)}.{Quote(q.Shape.Name)}" +
                  $" where {string.Join(" and ", where)} order by {Quote(q.Key.Name)} limit ${values.Count + 1}";
        return (sql, values);
    }

    /// <summary>The only data query: columns and table as the catalogue named them, each quoted; the row count is the parameter $1.</summary>
    public static string PreviewSql(TableShape shape) =>
        $"select {string.Join(", ", shape.Columns.Select(c => Quote(c.Name)))} from {Quote(shape.Schema)}.{Quote(shape.Name)} limit $1";

    public static string Quote(string identifier) => "\"" + identifier.Replace("\"", "\"\"") + "\"";

    /// <summary>The driver's error in words safe to send: the database's own reason or what could not be reached, never the connection string.</summary>
    internal static JobFailedException Translate(Exception e, ConnectionSettings? s)
    {
        var where = s is null ? "the database" : $"{s.Server}:{s.Port ?? 5432}";
        return e switch
        {
            PostgresException p when p.SqlState is "28P01" or "28000" => new JobFailedException("auth", $"The database refused the sign-in: {p.MessageText}"),
            PostgresException p when p.SqlState == "3D000" => new JobFailedException("not_found", p.MessageText),
            PostgresException p when p.SqlState == "42501" => new JobFailedException("refused", $"The database refused: {p.MessageText}"),
            PostgresException p when p.SqlState == "57014" => new JobFailedException("timeout", "The database took too long to answer"),
            // The server went away or is restarting, the connection broke, or it is full or in a deadlock: worth another attempt (AG6a, AG6-D5).
            PostgresException p when p.SqlState.StartsWith("08", StringComparison.Ordinal) || p.SqlState is "57P01" or "57P02" or "57P03" or "53300" or "40001" or "40P01" =>
                new JobFailedException("network", $"The database connection was lost: {p.MessageText} ({p.SqlState})", transient: true),
            PostgresException p => new JobFailedException("refused", $"PostgreSQL said: {p.MessageText} ({p.SqlState})"),
            NpgsqlException { InnerException: TimeoutException } or TimeoutException => new JobFailedException("timeout", $"{where} did not answer in time", transient: true),
            NpgsqlException { InnerException: SocketException se } => new JobFailedException("network", $"Could not reach {where}: {se.SocketErrorCode}", transient: true),
            NpgsqlException { InnerException: System.Security.Authentication.AuthenticationException } =>
                new JobFailedException("network", $"The encrypted connection to {where} could not be set up: check the server's certificate, or allow an untrusted certificate in the connection's settings"),
            NpgsqlException n => new JobFailedException("network", $"Could not use {where}: {n.Message}", transient: true),
            _ => new JobFailedException("internal", $"The agent could not read the database ({e.GetType().Name})"),
        };
    }
}
