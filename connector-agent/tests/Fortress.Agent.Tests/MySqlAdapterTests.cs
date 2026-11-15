using Fortress.Agent.Adapters;
using Fortress.Agent.Core;
using MySqlConnector;

namespace Fortress.Agent.Tests;

/// <summary>
/// The MySQL adapter against a real server: <c>AGENT_TEST_MYSQL</c> = a root connection string over TCP (mysql-check.sh starts a throwaway
/// MariaDB or MySQL and sets it). Without it these tests do nothing, so `dotnet test` still runs anywhere.
/// </summary>
public sealed class MySqlAdapterTests : IAsyncLifetime
{
    private static readonly string? Admin = Environment.GetEnvironmentVariable("AGENT_TEST_MYSQL");
    private MySqlConnectionStringBuilder? admin;

    public async Task InitializeAsync()
    {
        if (Admin is null) return;
        admin = new MySqlConnectionStringBuilder(Admin);
        await using var c = new MySqlConnection(Admin);
        await c.OpenAsync();
        foreach (var sql in new[]
        {
            "drop database if exists agent_erp", "drop database if exists agent_hr",
            "drop user if exists 'agent_reader'@'%'",
            "create database agent_erp", "create database agent_hr",
            "create table agent_erp.parts (id bigint primary key, `part no` varchar(40) not null unique)",
            """
            create table agent_erp.`work orders` (
              id bigint primary key, `order no` varchar(40) not null, part_id bigint, qty decimal(12,3), due date, `on hold` tinyint(1),
              raised datetime(6), ref char(36), drawing blob, notes text, zero_day date,
              constraint wo_part foreign key (part_id) references agent_erp.parts (id))
            """,
            "create view agent_erp.v_open_orders as select id, `order no` from agent_erp.`work orders` where not coalesce(`on hold`, 0)",
            "create table agent_erp.salaries (id int primary key, amount decimal(12,2))",
            "create table agent_hr.people (id int primary key)",
            "insert into agent_erp.parts values (1, 'P-100'), (2, 'P-200')",
            """
            insert into agent_erp.`work orders`
            with recursive g (n) as (select 1 union all select n + 1 from g where n < 60)
            select n, concat('WO-', n), 1 + n % 2, n * 1.5, date '2026-01-01' + interval n day, n % 5 = 0,
                   timestamp '2026-01-01 08:00:00' + interval n hour, concat('00000000-0000-4000-8000-', lpad(n, 12, '0')), x'0102',
                   case when n = 3 then repeat('x', 3000) end, null
              from g
            """,
            "create user 'agent_reader'@'%' identified by 'reader-pass'",
            "grant select on agent_erp.parts to 'agent_reader'@'%'",
            "grant select on agent_erp.`work orders` to 'agent_reader'@'%'",
            "grant select on agent_erp.v_open_orders to 'agent_reader'@'%'",
            "grant select on agent_hr.people to 'agent_reader'@'%'",
        })
        {
            await using var cmd = new MySqlCommand(sql, c);
            await cmd.ExecuteNonQueryAsync();
        }
        // A zero date can only be written with strict mode off for this session.
        await using (var off = new MySqlCommand("set session sql_mode = ''; update agent_erp.`work orders` set zero_day = '0000-00-00' where id = 1", c)) await off.ExecuteNonQueryAsync();
    }

    public Task DisposeAsync() => Task.CompletedTask;

    private ConnectionSettings Settings(string database = "agent_erp", int? port = null) =>
        new("mysql", admin!.Server, port ?? (int)admin.Port, null, database, "password", false, false, 5);

    private static readonly DbCredential Reader = new("agent_reader", "reader-pass");

    [Fact]
    public async Task Reads_what_the_reader_login_may_read_in_its_own_database_and_nothing_else()
    {
        if (admin is null) return;
        await using var db = await new DatabaseAdapters().OpenAsync(Settings(), Reader, default);
        var (product, user, database) = await db.DescribeAsync(default);
        Assert.Matches("^(MySQL|MariaDB) ", product);
        Assert.StartsWith("agent_reader@", user);
        Assert.Equal("agent_erp", database);

        // The connection's database is the one schema, even though the login could read agent_hr too.
        Assert.Equal(["agent_erp"], await db.SchemasAsync(default));
        var other = await Assert.ThrowsAsync<JobFailedException>(() => db.ObjectsAsync("agent_hr", default));
        Assert.Equal("not_found", other.Kind);
        Assert.Null(await db.ColumnsAsync("agent_hr", "people", default));

        var objects = await db.ObjectsAsync("agent_erp", default);
        Assert.Equal(["parts", "v_open_orders", "work orders"], objects.Select(o => o.Name));
        Assert.Equal("view", objects.Single(o => o.Name == "v_open_orders").Kind);
        Assert.Null(await db.ColumnsAsync("agent_erp", "salaries", default)); // exists, but this login may not read it

        var shape = (await db.ColumnsAsync("agent_erp", "work orders", default))!;
        Assert.Equal("id", shape.Columns[0].Name);
        Assert.True(shape.Columns[0].PrimaryKey);
        Assert.Equal("decimal(12,3)", shape.Columns.Single(c => c.Name == "qty").DataType);
        Assert.False(shape.Columns.Single(c => c.Name == "order no").Nullable);
        var fk = Assert.Single(shape.ForeignKeys);
        Assert.Equal(("parts", "part_id", "id"), (fk.ReferencedObject, fk.Columns[0], fk.ReferencedColumns[0]));

        var rows = await db.PreviewAsync(shape, 5, default);
        Assert.Equal(5, rows.Count);
        var r = rows[0];
        Assert.Equal(1L, DbValues.ToJson(r["id"])!.GetValue<long>());
        Assert.Equal("WO-1", r["order no"]);
        Assert.Equal("1.500", DbValues.ToJson(r["qty"])!.GetValue<string>());
        Assert.Equal("2026-01-02", DbValues.ToJson(r["due"])!.GetValue<string>());
        Assert.Equal("2026-01-01T09:00:00", DbValues.ToJson(r["raised"])!.GetValue<string>());
        Assert.False(DbValues.ToJson(r["on hold"])!.GetValue<bool>());
        Assert.Equal("(binary, 2 bytes)", DbValues.ToJson(r["drawing"])!.GetValue<string>());
        Assert.Equal("0000-00-00", DbValues.ToJson(r["zero_day"])!.GetValue<string>());
        Assert.Equal(DbValues.MaxText + 1, DbValues.ToJson(rows[2]["notes"])!.GetValue<string>().Length);
    }

    [Fact]
    public async Task Extracts_in_key_order_page_by_page_with_typed_filters_given_as_text()
    {
        if (admin is null) return;
        await using var db = await new DatabaseAdapters().OpenAsync(Settings(), Reader, default);
        var shape = (await db.ColumnsAsync("agent_erp", "work orders", default))!;
        DbColumn C(string n) => shape.Columns.Single(c => c.Name == n);
        var columns = new[] { C("id"), C("order no"), C("due"), C("on hold") };
        var filters = new[] { new ExtractFilter(C("due"), "gte", "2026-01-11"), new ExtractFilter(C("on hold"), "eq", "0"), new ExtractFilter(C("qty"), "lt", "75"), new ExtractFilter(C("notes"), "is_null", null) };
        var keys = new List<long>();
        string? after = null;
        while (true)
        {
            var page = await db.ExtractPageAsync(new ExtractQuery(shape, columns, C("id"), filters, after, 7), default);
            if (page.Count == 0) break;
            keys.AddRange(page.Select(r => Convert.ToInt64(r.Values["id"])));
            after = page[^1].KeyText;
            Assert.Equal(columns.Select(c => c.Name), page[0].Values.Keys);
            if (page.Count < 7) break;
        }
        // due >= 2026-01-11 → id >= 10; qty < 75 → id < 50; not on hold → id % 5 <> 0; notes empty → not id 3.
        Assert.Equal(Enumerable.Range(10, 40).Where(i => i % 5 != 0).Select(i => (long)i), keys);

        // A numeric key compares as a number (10 after 9), a text key and a date key carry on from the last one read, as text.
        var after9 = await db.ExtractPageAsync(new ExtractQuery(shape, [C("id")], C("id"), [], "9", 2), default);
        Assert.Equal([10L, 11L], after9.Select(r => Convert.ToInt64(r.Values["id"])));
        var parts = (await db.ColumnsAsync("agent_erp", "parts", default))!;
        var byNo = await db.ExtractPageAsync(new ExtractQuery(parts, parts.Columns, parts.Columns.Single(c => c.Name == "part no"), [], "P-100", 10), default);
        Assert.Equal(["P-200"], byNo.Select(r => (string)r.Values["part no"]!));
        var byDue = await db.ExtractPageAsync(new ExtractQuery(shape, columns, C("due"), [], "2026-03-01", 10), default);
        Assert.Equal([60L], byDue.Select(r => Convert.ToInt64(r.Values["id"])));
        Assert.Equal("2026-03-02", DbValues.ToJson(byDue[0].Values["due"])!.GetValue<string>());
    }

    [Fact]
    public async Task An_incremental_page_reads_rows_changed_at_or_after_the_mark()
    {
        if (admin is null) return;
        await using var db = await new DatabaseAdapters().OpenAsync(Settings(), Reader, default);
        var shape = (await db.ColumnsAsync("agent_erp", "work orders", default))!;
        DbColumn C(string n) => shape.Columns.Single(c => c.Name == n);
        // raised = 2026-01-01 08:00 + n hours, a DATETIME with no zone: the mark is the same wall-clock text.
        var rows = await db.ExtractPageAsync(new ExtractQuery(shape, [C("id"), C("raised")], C("id"), [new ExtractFilter(C("raised"), "gte", "2026-01-03T10:00:00.0000000")], null, 100), default);
        Assert.Equal(Enumerable.Range(50, 11).Select(i => (long)i), rows.Select(r => Convert.ToInt64(r.Values["id"])));
        string? mark = null;
        foreach (var r in rows) mark = DbValues.HigherMark(mark, r.Values["raised"]!);
        Assert.Equal("2026-01-03T20:00:00.0000000", mark);
    }

    [Fact]
    public async Task An_odd_name_or_a_hostile_value_never_becomes_sql()
    {
        if (admin is null) return;
        await using var db = await new DatabaseAdapters().OpenAsync(Settings(), Reader, default);
        var shape = (await db.ColumnsAsync("agent_erp", "work orders", default))!;
        DbColumn C(string n) => shape.Columns.Single(c => c.Name == n);
        var hostile = "x'; delete from agent_erp.parts; --";
        var rows = await db.ExtractPageAsync(new ExtractQuery(shape, [C("id"), C("order no")], C("id"), [new ExtractFilter(C("order no"), "eq", hostile)], null, 10), default);
        Assert.Empty(rows);
        var (sql, values) = MySqlAdapter.ExtractSql(new ExtractQuery(shape, [C("id"), C("order no")], C("id"), [new ExtractFilter(C("order no"), "eq", hostile)], "5", 10));
        Assert.DoesNotContain("delete", sql);
        Assert.Equal(["5", hostile], values);
        Assert.Equal("select `id`, `order no` from `agent_erp`.`work orders` where `id` IS NOT NULL and `id` > @p1 and `order no` = @p2 order by `id` limit @limit", sql);
        Assert.Equal("`a``b`", MySqlAdapter.Quote("a`b"));
        await using var c = new MySqlConnection(Admin);
        await c.OpenAsync();
        await using var count = new MySqlCommand("select count(*) from agent_erp.parts", c);
        Assert.Equal(2L, Convert.ToInt64(await count.ExecuteScalarAsync()));
    }

    [Fact]
    public async Task Says_why_it_could_not_connect_without_echoing_the_password()
    {
        if (admin is null) return;
        var wrong = await Assert.ThrowsAsync<JobFailedException>(() => new DatabaseAdapters().OpenAsync(Settings(), new DbCredential("agent_reader", "not-it"), default));
        Assert.Equal("auth", wrong.Kind);
        var missing = await Assert.ThrowsAsync<JobFailedException>(() => new DatabaseAdapters().OpenAsync(Settings("no_such_db"), Reader, default));
        Assert.Contains(missing.Kind, new[] { "not_found", "refused", "auth" });
        Assert.Contains("no_such_db", missing.Message);
        var closed = await Assert.ThrowsAsync<JobFailedException>(() => new DatabaseAdapters().OpenAsync(Settings(port: 1), Reader, default));
        Assert.Equal("network", closed.Kind);
        Assert.DoesNotContain("reader-pass", wrong.Message + missing.Message + closed.Message);
        Assert.DoesNotContain("not-it", wrong.Message);
    }

    [Fact]
    public async Task Every_read_runs_in_a_read_only_transaction()
    {
        if (admin is null) return;
        // The adapter never issues a write; prove the transaction it opens refuses one, even for root.
        await using var c = new MySqlConnection(MySqlAdapter.ConnectionString(Settings(), new DbCredential(admin.UserID, admin.Password)));
        await c.OpenAsync();
        await using (var start = new MySqlCommand("START TRANSACTION READ ONLY", c)) await start.ExecuteNonQueryAsync();
        await using var write = new MySqlCommand("delete from agent_erp.parts", c);
        var e = await Assert.ThrowsAsync<MySqlException>(() => write.ExecuteNonQueryAsync());
        Assert.Equal(MySqlErrorCode.CannotExecuteInReadOnlyTransaction, e.ErrorCode);
    }

    [Fact]
    public void Never_lets_the_server_ask_for_a_local_file()
    {
        var b = new MySqlConnectionStringBuilder(MySqlAdapter.ConnectionString(new ConnectionSettings("mysql", "db", null, null, "erp", "password", true, false, 15), new DbCredential("u", "p")));
        Assert.False(b.AllowLoadLocalInfile);
        Assert.Equal(3306u, b.Port);
        Assert.Equal(MySqlSslMode.VerifyFull, b.SslMode);
    }
}
