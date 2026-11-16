using System.Net.Sockets;
using Fortress.Agent.Core;
using MySqlConnector;

namespace Fortress.Agent.Adapters;

/// <summary>
/// MySQL and MariaDB, read only (AG5). In MySQL a "schema" is a database, so the connection's database is the one schema offered: browsing and
/// reading stay inside the database the connection names. Every call runs in its own <c>START TRANSACTION READ ONLY</c>; the catalogue is read
/// from information_schema, which in MySQL lists only what the sign-in may read; the one data query is built from the columns the catalogue listed,
/// quoted with backticks, and every value (the last key, the filters' values, the row count) is a parameter.
/// </summary>
public sealed class MySqlAdapter : IDatabaseAdapter
{
    private readonly MySqlConnection connection;
    private readonly string database;

    private MySqlAdapter(MySqlConnection connection, string database)
    {
        this.connection = connection;
        this.database = database;
    }

    public static string ConnectionString(ConnectionSettings s, DbCredential? credential)
    {
        var b = new MySqlConnectionStringBuilder
        {
            Server = s.Server,
            Port = (uint)(s.Port ?? 3306),
            Database = s.Database,
            UserID = credential?.Username,
            Password = credential?.Password,
            ConnectionTimeout = (uint)s.TimeoutSeconds,
            DefaultCommandTimeout = 60,
            ApplicationName = "Fortress Connector Agent",
            SslMode = !s.Encrypt ? MySqlSslMode.None : s.TrustServerCertificate ? MySqlSslMode.Required : MySqlSslMode.VerifyFull,
            Pooling = false,
            // Dates such as 0000-00-00 are read as text rather than failing the whole page.
            AllowZeroDateTime = true,
            // LOAD DATA LOCAL could make the server ask the agent for a file: never allowed.
            AllowLoadLocalInfile = false,
            AllowUserVariables = false,
        };
        return b.ConnectionString;
    }

    public static async Task<IDatabaseAdapter> OpenAsync(ConnectionSettings settings, DbCredential? credential, CancellationToken ct)
    {
        var connection = new MySqlConnection(ConnectionString(settings, credential));
        try
        {
            await connection.OpenAsync(ct);
            return new MySqlAdapter(connection, settings.Database);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            await connection.DisposeAsync();
            throw Translate(e, settings);
        }
    }

    public ValueTask DisposeAsync() => connection.DisposeAsync();

    private async Task<T> ReadAsync<T>(Func<MySqlCommand, Task<T>> work, CancellationToken ct)
    {
        try
        {
            await using (var start = new MySqlCommand("START TRANSACTION READ ONLY", connection)) await start.ExecuteNonQueryAsync(ct);
            try
            {
                await using var cmd = new MySqlCommand { Connection = connection, CommandTimeout = 60 };
                return await work(cmd);
            }
            finally
            {
                await using var end = new MySqlCommand("ROLLBACK", connection);
                await end.ExecuteNonQueryAsync(CancellationToken.None);
            }
        }
        catch (Exception e) when (e is not (OperationCanceledException or JobFailedException))
        {
            throw Translate(e, null);
        }
    }

    public Task<(string Product, string User, string Database)> DescribeAsync(CancellationToken ct) => ReadAsync(async cmd =>
    {
        cmd.CommandText = "select version(), current_user(), database()";
        await using var r = await cmd.ExecuteReaderAsync(ct);
        await r.ReadAsync(ct);
        var version = r.GetString(0);
        var product = version.Contains("MariaDB", StringComparison.OrdinalIgnoreCase) ? $"MariaDB {version.Split('-')[0]}" : $"MySQL {version.Split('-')[0]}";
        return (product, r.GetString(1), r.IsDBNull(2) ? database : r.GetString(2));
    }, ct);

    /// <summary>The connection's database is the one schema: MySQL has no level between a database and its tables.</summary>
    public Task<IReadOnlyList<string>> SchemasAsync(CancellationToken ct) => ReadAsync<IReadOnlyList<string>>(async cmd =>
    {
        cmd.CommandText = "select schema_name from information_schema.schemata where schema_name = @db";
        cmd.Parameters.AddWithValue("@db", database);
        return await cmd.ExecuteScalarAsync(ct) is string s ? [s] : [];
    }, ct);

    private void OwnDatabase(string schema)
    {
        if (!string.Equals(schema, database, StringComparison.Ordinal))
            throw new JobFailedException("not_found", $"This connection reads the database {database}; {schema} is another database");
    }

    public Task<IReadOnlyList<DbObject>> ObjectsAsync(string schema, CancellationToken ct)
    {
        OwnDatabase(schema);
        return ReadAsync<IReadOnlyList<DbObject>>(async cmd =>
        {
            cmd.CommandText = """
                select table_name, table_type, table_rows from information_schema.tables
                 where table_schema = @db and table_type in ('BASE TABLE', 'VIEW', 'SYSTEM VERSIONED')
                 order by table_name
                """;
            cmd.Parameters.AddWithValue("@db", database);
            var list = new List<DbObject>();
            await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct))
                list.Add(new DbObject(r.GetString(0), r.GetString(1) == "VIEW" ? "view" : "table", r.IsDBNull(2) ? null : Convert.ToInt64(r.GetValue(2))));
            return list;
        }, ct);
    }

    public Task<TableShape?> ColumnsAsync(string schema, string name, CancellationToken ct)
    {
        if (!string.Equals(schema, database, StringComparison.Ordinal)) return Task.FromResult<TableShape?>(null);
        return ReadAsync<TableShape?>(async cmd =>
        {
            cmd.CommandText = """
                select column_name, column_type, is_nullable = 'YES', column_key = 'PRI'
                  from information_schema.columns where table_schema = @db and table_name = @t
                 order by ordinal_position
                """;
            cmd.Parameters.AddWithValue("@db", database);
            cmd.Parameters.AddWithValue("@t", name);
            var columns = new List<DbColumn>();
            await using (var r = await cmd.ExecuteReaderAsync(ct))
                while (await r.ReadAsync(ct)) columns.Add(new DbColumn(r.GetString(0), r.GetString(1), r.GetBoolean(2), r.GetBoolean(3)));
            if (columns.Count == 0) return null;
            cmd.CommandText = """
                select constraint_name, column_name, referenced_table_schema, referenced_table_name, referenced_column_name
                  from information_schema.key_column_usage
                 where table_schema = @db and table_name = @t and referenced_table_name is not null
                 order by constraint_name, ordinal_position
                """;
            var keys = new List<DbForeignKey>();
            await using (var r = await cmd.ExecuteReaderAsync(ct))
            {
                var parts = new List<(string Name, string Col, string RefSchema, string RefTable, string RefCol)>();
                while (await r.ReadAsync(ct)) parts.Add((r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetString(4)));
                foreach (var g in parts.GroupBy(p => p.Name))
                {
                    var first = g.First();
                    keys.Add(new DbForeignKey(g.Key, g.Select(p => p.Col).ToArray(), first.RefSchema, first.RefTable, g.Select(p => p.RefCol).ToArray()));
                }
            }
            return new TableShape(database, name, columns, keys);
        }, ct);
    }

    public Task<IReadOnlyList<IReadOnlyDictionary<string, object?>>> PreviewAsync(TableShape shape, int limit, CancellationToken ct) =>
        ReadAsync<IReadOnlyList<IReadOnlyDictionary<string, object?>>>(async cmd =>
        {
            OwnDatabase(shape.Schema);
            cmd.CommandText = PreviewSql(shape);
            cmd.Parameters.AddWithValue("@limit", Math.Clamp(limit, 1, 50));
            var rows = new List<IReadOnlyDictionary<string, object?>>();
            await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct)) rows.Add(ReadRow(r, shape.Columns));
            return rows;
        }, ct);

    public Task<IReadOnlyList<ExtractedRow>> ExtractPageAsync(ExtractQuery q, CancellationToken ct) =>
        ReadAsync<IReadOnlyList<ExtractedRow>>(async cmd =>
        {
            OwnDatabase(q.Shape.Schema);
            var (sql, values) = ExtractSql(q);
            cmd.CommandText = sql;
            // Values go as text: MySQL converts a text value to the type of the column it is compared with (a date, a number…).
            for (var i = 0; i < values.Count; i++) cmd.Parameters.AddWithValue($"@p{i + 1}", values[i]);
            cmd.Parameters.AddWithValue("@limit", Math.Clamp(q.Limit, 1, 1000));
            var rows = new List<ExtractedRow>();
            await using var r = await cmd.ExecuteReaderAsync(ct);
            var keyIndex = PostgresAdapter.IndexOf(q.Columns, q.Key);
            while (await r.ReadAsync(ct))
            {
                var row = ReadRow(r, q.Columns);
                var key = row[q.Columns[keyIndex].Name] ?? throw new JobFailedException("internal", "A row came back with no key");
                rows.Add(new ExtractedRow(row, DbValues.KeyText(key)));
            }
            return rows;
        }, ct);

    private static Dictionary<string, object?> ReadRow(MySqlDataReader r, IReadOnlyList<DbColumn> columns)
    {
        var row = new Dictionary<string, object?>(StringComparer.Ordinal);
        for (var i = 0; i < columns.Count; i++)
        {
            object? v;
            try
            {
                v = r.IsDBNull(i) ? null : r.GetValue(i);
                // A zero date ("0000-00-00") has no DateTime; keep it as the text the database shows.
                if (v is MySqlDateTime md) v = md.IsValidDateTime ? md.GetDateTime() : md.ToString();
            }
            catch (InvalidCastException) { v = r.GetString(i); }
            row[columns[i].Name] = v;
        }
        return row;
    }

    /// <summary>
    /// An extraction page: columns, table and every column in WHERE / ORDER BY as the catalogue named them, quoted; the key of the last row and each
    /// filter's value are the parameters @p1, @p2 … in that order, and the row count is @limit. Only a SELECT is ever built.
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
        var sql = $"select {string.Join(", ", q.Columns.Select(c => Quote(c.Name)))} from {Quote(q.Shape.Schema)}.{Quote(q.Shape.Name)}" +
                  $" where {string.Join(" and ", where)} order by {Quote(q.Key.Name)} limit @limit";
        return (sql, values);
    }

    /// <summary>The preview query: columns and table as the catalogue named them, each quoted; the row count is @limit.</summary>
    public static string PreviewSql(TableShape shape) =>
        $"select {string.Join(", ", shape.Columns.Select(c => Quote(c.Name)))} from {Quote(shape.Schema)}.{Quote(shape.Name)} limit @limit";

    public static string Quote(string identifier) => "`" + identifier.Replace("`", "``") + "`";

    /// <summary>The driver's error in words safe to send: the database's own reason or what could not be reached, never the connection string.</summary>
    internal static JobFailedException Translate(Exception e, ConnectionSettings? s)
    {
        var where = s is null ? "the database" : $"{s.Server}:{s.Port ?? 3306}";
        return e switch
        {
            MySqlException m when m.ErrorCode == MySqlErrorCode.AccessDenied => new JobFailedException("auth", $"The database refused the sign-in: {m.Message}"),
            MySqlException m when m.ErrorCode == MySqlErrorCode.UnknownDatabase => new JobFailedException("not_found", m.Message),
            MySqlException m when m.ErrorCode is MySqlErrorCode.DatabaseAccessDenied or MySqlErrorCode.TableAccessDenied or MySqlErrorCode.ColumnAccessDenied =>
                new JobFailedException("refused", $"The database refused: {m.Message}"),
            MySqlException m when m.ErrorCode == MySqlErrorCode.CommandTimeoutExpired => new JobFailedException("timeout", "The database took too long to answer"),
            MySqlException m when m.ErrorCode == MySqlErrorCode.UnableToConnectToHost && m.InnerException is SocketException se =>
                new JobFailedException("network", $"Could not reach {where}: {se.SocketErrorCode}", transient: true),
            MySqlException m when m.ErrorCode == MySqlErrorCode.UnableToConnectToHost => new JobFailedException("network", $"Could not reach {where}: {m.Message}", transient: true),
            // The server went away or shut down, the connection broke, too many connections, a deadlock: worth another attempt (AG6a, AG6-D5).
            MySqlException m when m.Number is 1040 or 1053 or 1077 or 1152 or 1153 or 1158 or 1159 or 1160 or 1161 or 1205 or 1213 or 2006 or 2013 =>
                new JobFailedException("network", $"The database connection was lost: {m.Message} ({m.Number})", transient: true),
            MySqlException { InnerException: System.Security.Authentication.AuthenticationException } =>
                new JobFailedException("network", $"The encrypted connection to {where} could not be set up: check the server's certificate, or allow an untrusted certificate in the connection's settings"),
            MySqlException m when m.Number > 0 => new JobFailedException("refused", $"MySQL said: {m.Message} ({m.Number})"),
            MySqlException m => new JobFailedException("network", $"Could not use {where}: {m.Message}", transient: true),
            TimeoutException => new JobFailedException("timeout", $"{where} did not answer in time", transient: true),
            _ => new JobFailedException("internal", $"The agent could not read the database ({e.GetType().Name})"),
        };
    }
}
