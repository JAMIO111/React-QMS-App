using Fortress.Agent.Adapters;
using Fortress.Agent.Core;
using Microsoft.Data.SqlClient;

namespace Fortress.Agent.Tests;

/// <summary>
/// The SQL Server adapter against a real server (AG6c, AG-D11): <c>AGENT_TEST_SQLSERVER</c> = an sa connection string over TCP (the connector
/// agent workflow in .github/workflows runs SQL Server 2022 beside the tests and sets it). Without it these tests do nothing, so `dotnet test` still
/// runs anywhere. Windows authentication is not covered here (it needs a domain or a Windows machine): that stays on the acceptance list.
/// </summary>
public sealed class SqlServerAdapterTests : IAsyncLifetime
{
    private static readonly string? Admin = Environment.GetEnvironmentVariable("AGENT_TEST_SQLSERVER");
    private SqlConnectionStringBuilder? admin;
    private const string Db = "agent_test";

    private static async Task Exec(SqlConnection c, string sql)
    {
        await using var cmd = new SqlCommand(sql, c) { CommandTimeout = 120 };
        await cmd.ExecuteNonQueryAsync();
    }

    public async Task InitializeAsync()
    {
        if (Admin is null) return;
        admin = new SqlConnectionStringBuilder(Admin);
        await using (var master = new SqlConnection(Admin))
        {
            await master.OpenAsync();
            await Exec(master, $"""
                IF DB_ID('{Db}') IS NOT NULL BEGIN ALTER DATABASE [{Db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{Db}]; END;
                IF SUSER_ID('agent_reader') IS NOT NULL DROP LOGIN agent_reader;
                CREATE DATABASE [{Db}];
                CREATE LOGIN agent_reader WITH PASSWORD = 'Reader-pass-1!', CHECK_POLICY = OFF;
                """);
        }
        var b = new SqlConnectionStringBuilder(Admin) { InitialCatalog = Db };
        await using var c = new SqlConnection(b.ConnectionString);
        await c.OpenAsync();
        await Exec(c, "CREATE SCHEMA erp;");
        await Exec(c, "CREATE SCHEMA hr;");
        await Exec(c, """
            CREATE TABLE erp.parts (id bigint PRIMARY KEY, [part no] nvarchar(40) NOT NULL UNIQUE);
            CREATE TABLE erp.[work orders] (
              id bigint PRIMARY KEY, [order no] nvarchar(40) NOT NULL, part_id bigint REFERENCES erp.parts (id), qty decimal(12,3), due date,
              [on hold] bit, raised datetime2(7), ref uniqueidentifier, drawing varbinary(max), notes nvarchar(max), [odd]]name] int);
            CREATE TABLE erp.salaries (id int PRIMARY KEY, amount decimal(12,2));
            CREATE TABLE hr.people (id int PRIMARY KEY);
            INSERT INTO erp.parts VALUES (1, N'P-100'), (2, N'P-200');
            """);
        await Exec(c, "CREATE VIEW erp.v_open_orders AS SELECT id, [order no] FROM erp.[work orders] WHERE ISNULL([on hold], 0) = 0;");
        await Exec(c, """
            WITH g AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM g WHERE n < 60)
            INSERT INTO erp.[work orders] (id, [order no], part_id, qty, due, [on hold], raised, ref, drawing, notes, [odd]]name])
            SELECT n, CONCAT(N'WO-', n), 1 + n % 2, n * 1.5, DATEADD(day, n, '2026-01-01'), CASE WHEN n % 5 = 0 THEN 1 ELSE 0 END,
                   DATEADD(hour, n, CAST('2026-01-01T08:00:00' AS datetime2(7))),
                   CAST(CONCAT('00000000-0000-4000-8000-', RIGHT(CONCAT('000000000000', n), 12)) AS uniqueidentifier), 0x0102,
                   CASE WHEN n = 3 THEN REPLICATE(CAST(N'x' AS nvarchar(max)), 3000) END, n
              FROM g OPTION (MAXRECURSION 100);
            """);
        await Exec(c, """
            CREATE USER agent_reader FOR LOGIN agent_reader;
            GRANT SELECT ON erp.parts TO agent_reader;
            GRANT SELECT ON erp.[work orders] TO agent_reader;
            GRANT SELECT ON erp.v_open_orders TO agent_reader;
            """);
    }

    public Task DisposeAsync() => Task.CompletedTask;

    private ConnectionSettings Settings(string database = Db, int? port = null)
    {
        var (host, p) = HostAndPort(admin!.DataSource);
        return new ConnectionSettings("sqlserver", host, port ?? p, null, database, "sql", false, true, 10);
    }

    private static (string Host, int? Port) HostAndPort(string dataSource)
    {
        var s = dataSource.StartsWith("tcp:", StringComparison.OrdinalIgnoreCase) ? dataSource[4..] : dataSource;
        var comma = s.IndexOf(',');
        return comma < 0 ? (s, null) : (s[..comma], int.Parse(s[(comma + 1)..], System.Globalization.CultureInfo.InvariantCulture));
    }

    private static readonly DbCredential Reader = new("agent_reader", "Reader-pass-1!");

    [Fact]
    public async Task Reads_what_the_reader_login_may_read_and_nothing_else()
    {
        if (admin is null) return;
        await using var db = await new DatabaseAdapters().OpenAsync(Settings(), Reader, default);
        var (product, user, database) = await db.DescribeAsync(default);
        Assert.StartsWith("SQL Server ", product);
        Assert.Equal("agent_reader", user);
        Assert.Equal(Db, database);

        var schemas = await db.SchemasAsync(default);
        Assert.Contains("erp", schemas);
        Assert.DoesNotContain("hr", schemas); // nothing in it this login may see

        var objects = await db.ObjectsAsync("erp", default);
        Assert.Equal(["parts", "v_open_orders", "work orders"], objects.Select(o => o.Name));
        Assert.Equal("view", objects.Single(o => o.Name == "v_open_orders").Kind);
        Assert.Null(await db.ColumnsAsync("erp", "salaries", default)); // exists, but this login may not read it

        var shape = (await db.ColumnsAsync("erp", "work orders", default))!;
        Assert.Equal("id", shape.Columns[0].Name);
        Assert.True(shape.Columns[0].PrimaryKey);
        Assert.Equal("decimal(12,3)", shape.Columns.Single(c => c.Name == "qty").DataType);
        Assert.Equal("nvarchar(max)", shape.Columns.Single(c => c.Name == "notes").DataType);
        Assert.False(shape.Columns.Single(c => c.Name == "order no").Nullable);
        var fk = Assert.Single(shape.ForeignKeys);
        Assert.Equal(("parts", "part_id", "id"), (fk.ReferencedObject, fk.Columns[0], fk.ReferencedColumns[0]));

        var rows = await db.PreviewAsync(shape, 5, default);
        Assert.Equal(5, rows.Count);
        var r = rows[0];
        Assert.Equal(1L, r["id"]);
        Assert.Equal("WO-1", r["order no"]);
        Assert.Equal("1.500", DbValues.ToJson(r["qty"])!.GetValue<string>());
        Assert.Equal("2026-01-02", DbValues.ToJson(r["due"])!.GetValue<string>());
        Assert.Equal("(binary, 2 bytes)", DbValues.ToJson(r["drawing"])!.GetValue<string>());
        Assert.Equal(DbValues.MaxText + 1, DbValues.ToJson(rows[2]["notes"])!.GetValue<string>().Length);
        Assert.Equal(1, r["odd]name"]); // a bracket in a column name is quoted, not broken
    }

    [Fact]
    public async Task Extracts_in_key_order_page_by_page_with_typed_filters_given_as_text()
    {
        if (admin is null) return;
        await using var db = await new DatabaseAdapters().OpenAsync(Settings(), Reader, default);
        var shape = (await db.ColumnsAsync("erp", "work orders", default))!;
        DbColumn C(string n) => shape.Columns.Single(c => c.Name == n);
        var columns = new[] { C("id"), C("order no"), C("due"), C("on hold") };
        var filters = new[] { new ExtractFilter(C("due"), "gte", "2026-01-11"), new ExtractFilter(C("on hold"), "eq", "0"), new ExtractFilter(C("qty"), "lt", "75"), new ExtractFilter(C("notes"), "is_null", null) };
        var keys = new List<long>();
        string? after = null;
        while (true)
        {
            var page = await db.ExtractPageAsync(new ExtractQuery(shape, columns, C("id"), filters, after, 7), default);
            if (page.Count == 0) break;
            keys.AddRange(page.Select(r => (long)r.Values["id"]!));
            after = page[^1].KeyText;
            Assert.Equal(columns.Select(c => c.Name), page[0].Values.Keys);
            if (page.Count < 7) break;
        }
        var expected = Enumerable.Range(10, 40).Where(i => i % 5 != 0).Select(i => (long)i).ToList();
        Assert.Equal(expected, keys);

        // A text key and a date key carry on from the last one read, as text.
        var parts = (await db.ColumnsAsync("erp", "parts", default))!;
        var byNo = await db.ExtractPageAsync(new ExtractQuery(parts, parts.Columns, parts.Columns.Single(c => c.Name == "part no"), [], "P-100", 10), default);
        Assert.Equal(["P-200"], byNo.Select(r => (string)r.Values["part no"]!));
        var byDue = await db.ExtractPageAsync(new ExtractQuery(shape, columns, C("due"), [], "2026-03-01", 10), default);
        Assert.Equal([60L], byDue.Select(r => (long)r.Values["id"]!));
        Assert.Equal("2026-03-02", byDue[0].KeyText);
    }

    [Fact]
    public async Task An_incremental_page_reads_rows_changed_at_or_after_the_mark()
    {
        if (admin is null) return;
        await using var db = await new DatabaseAdapters().OpenAsync(Settings(), Reader, default);
        var shape = (await db.ColumnsAsync("erp", "work orders", default))!;
        DbColumn C(string n) => shape.Columns.Single(c => c.Name == n);
        // raised = 2026-01-01 08:00 + n hours (datetime2, no zone). The mark is the text the agent kept from the highest value it read.
        string? mark = null;
        var first = await db.ExtractPageAsync(new ExtractQuery(shape, [C("id"), C("raised")], C("id"), [new ExtractFilter(C("id"), "lte", "49")], null, 100), default);
        foreach (var r in first) mark = DbValues.HigherMark(mark, r.Values["raised"]!);
        Assert.NotNull(mark);
        var rows = await db.ExtractPageAsync(new ExtractQuery(shape, [C("id"), C("raised")], C("id"), [new ExtractFilter(C("raised"), "gte", mark)], null, 100), default);
        Assert.Equal(Enumerable.Range(49, 12).Select(i => (long)i), rows.Select(r => (long)r.Values["id"]!));
    }

    [Fact]
    public async Task An_odd_name_or_a_hostile_value_never_becomes_sql()
    {
        if (admin is null) return;
        await using var db = await new DatabaseAdapters().OpenAsync(Settings(), Reader, default);
        var shape = (await db.ColumnsAsync("erp", "work orders", default))!;
        DbColumn C(string n) => shape.Columns.Single(c => c.Name == n);
        var hostile = "x'; DELETE FROM erp.parts; --";
        var rows = await db.ExtractPageAsync(new ExtractQuery(shape, [C("id"), C("order no")], C("id"), [new ExtractFilter(C("order no"), "eq", hostile)], null, 10), default);
        Assert.Empty(rows);
        var (sql, values) = SqlServerAdapter.ExtractSql(new ExtractQuery(shape, [C("id"), C("odd]name")], C("id"), [new ExtractFilter(C("order no"), "eq", hostile)], "5", 10));
        Assert.DoesNotContain("DELETE", sql);
        Assert.Equal(["5", hostile], values);
        Assert.Equal("SELECT TOP (@limit) [id], [odd]]name] FROM [erp].[work orders] WHERE [id] IS NOT NULL AND [id] > @p1 AND [order no] = @p2 ORDER BY [id]", sql);
        var odd = await db.ExtractPageAsync(new ExtractQuery(shape, [C("id"), C("odd]name")], C("id"), [], "58", 10), default);
        Assert.Equal([59L, 60L], odd.Select(r => (long)r.Values["id"]!));
        var b = new SqlConnectionStringBuilder(Admin) { InitialCatalog = Db };
        await using var c = new SqlConnection(b.ConnectionString);
        await c.OpenAsync();
        await using var count = new SqlCommand("SELECT COUNT(*) FROM erp.parts", c);
        Assert.Equal(2, await count.ExecuteScalarAsync());
    }

    [Fact]
    public async Task The_reader_login_cannot_write_even_on_a_table_it_reads()
    {
        if (admin is null) return;
        // The adapter only ever builds a SELECT; the login it is given should be able to do no more (the install README asks for a read-only login).
        var b = new SqlConnectionStringBuilder(SqlServerAdapter.ConnectionString(Settings(), Reader));
        await using var c = new SqlConnection(b.ConnectionString);
        await c.OpenAsync();
        await using var write = new SqlCommand("DELETE FROM erp.parts", c);
        var e = await Assert.ThrowsAsync<SqlException>(() => write.ExecuteNonQueryAsync());
        Assert.Equal(229, e.Number); // permission denied
        Assert.Equal("refused", SqlServerAdapter.Translate(e, null).Kind);
    }

    [Fact]
    public async Task Says_why_it_could_not_connect_without_echoing_the_password()
    {
        if (admin is null) return;
        var wrong = await Assert.ThrowsAsync<JobFailedException>(() => new DatabaseAdapters().OpenAsync(Settings(), new DbCredential("agent_reader", "Wrong-pass-9!"), default));
        Assert.Equal("auth", wrong.Kind);
        var missing = await Assert.ThrowsAsync<JobFailedException>(() => new DatabaseAdapters().OpenAsync(Settings("no_such_db"), Reader, default));
        Assert.True(missing.Kind is "not_found" or "auth", missing.Kind); // SQL Server answers 4060 or 18456 depending on the version
        var closed = await Assert.ThrowsAsync<JobFailedException>(() => new DatabaseAdapters().OpenAsync(Settings(port: 1), Reader, default));
        Assert.Equal("network", closed.Kind);
        Assert.DoesNotContain("Reader-pass-1!", wrong.Message + missing.Message + closed.Message);
        Assert.DoesNotContain("Wrong-pass-9!", wrong.Message);
    }
}
