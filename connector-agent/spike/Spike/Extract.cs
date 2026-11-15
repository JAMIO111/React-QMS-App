// AG0 spike: the shape of an adapter's discovery and extraction, run against a real PostgreSQL (the SQL Server adapter will follow the same pattern).
// Discovery reads the catalogue; extraction is a SELECT the agent builds itself from a structured spec: identifiers checked against discovery and quoted,
// values as parameters, keyset paging (no OFFSET), inside a READ ONLY transaction, streamed row by row (never the whole table in memory).
using System.Runtime.CompilerServices;
using Npgsql;
using NpgsqlTypes;

public record ColumnInfo(string Name, string Type, bool Nullable, bool PrimaryKey);
public record ExtractSpec(string Schema, string Table, string[] Columns, string KeyColumn, string? ChangedSinceColumn, string? ChangedSince, int PageSize);

public static class PgSpike
{
    public static async Task<List<ColumnInfo>> Columns(NpgsqlDataSource db, string schema, string table)
    {
        // pg_catalog, not information_schema: information_schema.table_constraints hides keys from a login that only has SELECT (found in this spike).
        const string sql = @"select a.attname, format_type(a.atttypid, a.atttypmod), not a.attnotnull,
                                    coalesce(a.attnum = any (i.indkey::int2[]), false)
                               from pg_attribute a
                               join pg_class t on t.oid = a.attrelid join pg_namespace n on n.oid = t.relnamespace
                               left join pg_index i on i.indrelid = t.oid and i.indisprimary
                              where n.nspname = $1 and t.relname = $2 and a.attnum > 0 and not a.attisdropped
                              order by a.attnum";
        await using var cmd = db.CreateCommand(sql);
        cmd.Parameters.AddWithValue(schema); cmd.Parameters.AddWithValue(table);
        var list = new List<ColumnInfo>();
        await using var r = await cmd.ExecuteReaderAsync();
        while (await r.ReadAsync()) list.Add(new ColumnInfo(r.GetString(0), r.GetString(1), r.GetBoolean(2), r.GetBoolean(3)));
        return list;
    }

    static string Quote(string ident) => "\"" + ident.Replace("\"", "\"\"") + "\"";

    /// Refuses any identifier that discovery did not return, so a spec can never name something else; quoting is a second line of defence.
    public static async IAsyncEnumerable<Dictionary<string, object?>> Extract(NpgsqlDataSource db, ExtractSpec spec, [EnumeratorCancellation] CancellationToken ct = default)
    {
        var known = (await Columns(db, spec.Schema, spec.Table)).Select(c => c.Name).ToHashSet();
        if (known.Count == 0) throw new InvalidOperationException("Unknown table");
        foreach (var c in spec.Columns.Append(spec.KeyColumn).Concat(spec.ChangedSinceColumn is null ? [] : [spec.ChangedSinceColumn]))
            if (!known.Contains(c)) throw new InvalidOperationException($"Unknown column {c}");
        var cols = string.Join(", ", spec.Columns.Select(Quote));
        var from = $"{Quote(spec.Schema)}.{Quote(spec.Table)}";
        object? lastKey = null;
        await using var conn = await db.OpenConnectionAsync(ct);
        while (true)
        {
            await using var tx = await conn.BeginTransactionAsync(ct);
            await using (var ro = new NpgsqlCommand("set transaction read only", conn, tx)) await ro.ExecuteNonQueryAsync(ct);
            var where = new List<string>();
            await using var cmd = new NpgsqlCommand { Connection = conn, Transaction = tx };
            if (spec.ChangedSinceColumn is not null && spec.ChangedSince is not null)
            {
                where.Add($"{Quote(spec.ChangedSinceColumn)} > @since");
                cmd.Parameters.AddWithValue("since", NpgsqlDbType.TimestampTz, DateTime.Parse(spec.ChangedSince).ToUniversalTime());
            }
            if (lastKey is not null) { where.Add($"{Quote(spec.KeyColumn)} > @last"); cmd.Parameters.AddWithValue("last", lastKey); }
            cmd.CommandText = $"select {cols}, {Quote(spec.KeyColumn)} as __key from {from}" + (where.Count > 0 ? " where " + string.Join(" and ", where) : "")
                + $" order by {Quote(spec.KeyColumn)} limit {spec.PageSize}";
            var n = 0;
            await using (var r = await cmd.ExecuteReaderAsync(ct))
            {
                while (await r.ReadAsync(ct))
                {
                    n++;
                    var row = new Dictionary<string, object?>();
                    for (var i = 0; i < spec.Columns.Length; i++) row[spec.Columns[i]] = r.IsDBNull(i) ? null : r.GetValue(i);
                    lastKey = r.GetValue(spec.Columns.Length);
                    yield return row;
                }
            }
            await tx.CommitAsync(ct);
            if (n < spec.PageSize) yield break;
        }
    }
}
