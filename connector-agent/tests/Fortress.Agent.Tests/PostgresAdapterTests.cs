using Fortress.Agent.Adapters;
using Fortress.Agent.Core;
using Npgsql;

namespace Fortress.Agent.Tests;

/// <summary>
/// The PostgreSQL adapter against a real server: <c>AGENT_TEST_PG</c> = a superuser connection string over TCP (run-e2e.sh sets it to the
/// throwaway cluster it starts). Without it these tests do nothing, so `dotnet test` still runs anywhere.
/// The throwaway cluster trusts every local sign-in, so a wrong password is not tested here (it is a database setting, not the adapter's).
/// </summary>
public sealed class PostgresAdapterTests : IAsyncLifetime
{
    private static readonly string? Admin = Environment.GetEnvironmentVariable("AGENT_TEST_PG");
    private NpgsqlConnectionStringBuilder? admin;

    public async Task InitializeAsync()
    {
        if (Admin is null) return;
        admin = new NpgsqlConnectionStringBuilder(Admin);
        await using var c = new NpgsqlConnection(Admin);
        await c.OpenAsync();
        await using var cmd = new NpgsqlCommand("""
            drop schema if exists agent_erp cascade; drop schema if exists agent_hr cascade;
            do $$ begin if exists (select 1 from pg_roles where rolname = 'agent_reader') then drop owned by agent_reader; drop role agent_reader; end if; end $$;
            create schema agent_erp; create schema agent_hr;
            create table agent_erp.parts (id bigint primary key, "part no" text not null unique);
            create table agent_erp."work orders" (
              id bigint primary key, "order no" text not null, part_id bigint references agent_erp.parts (id), qty numeric(12,3), due date,
              "on hold" boolean, raised timestamptz, ref uuid, drawing bytea, notes text);
            create view agent_erp.v_open_orders as select id, "order no" from agent_erp."work orders" where not coalesce("on hold", false);
            create table agent_erp.salaries (id int primary key, amount numeric);
            create table agent_hr.people (id int primary key);
            insert into agent_erp.parts values (1, 'P-100'), (2, 'P-200');
            insert into agent_erp."work orders"
              select g, 'WO-' || g, 1 + g % 2, g * 1.5, date '2026-01-01' + g, g % 5 = 0, timestamptz '2026-01-01 08:00Z' + (g || ' hours')::interval,
                     ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, '\x0102'::bytea, case when g = 3 then repeat('x', 3000) end
                from generate_series(1, 60) g;
            create role agent_reader login password 'reader-pass';
            grant usage on schema agent_erp to agent_reader;
            grant select on agent_erp.parts, agent_erp."work orders", agent_erp.v_open_orders to agent_reader;
            """, c);
        await cmd.ExecuteNonQueryAsync();
    }

    public Task DisposeAsync() => Task.CompletedTask;

    private ConnectionSettings Settings(string database = "postgres", int? port = null) =>
        new("postgres", admin!.Host!, port ?? admin.Port, null, database, "password", false, false, 5);

    private static readonly DbCredential Reader = new("agent_reader", "reader-pass");

    [Fact]
    public async Task Reads_what_the_reader_login_may_read_and_nothing_else()
    {
        if (admin is null) return;
        await using var db = await new DatabaseAdapters().OpenAsync(Settings(), Reader, default);
        var (product, user, database) = await db.DescribeAsync(default);
        Assert.StartsWith("PostgreSQL ", product);
        Assert.Equal("agent_reader", user);
        Assert.Equal("postgres", database);

        var schemas = await db.SchemasAsync(default);
        Assert.Contains("agent_erp", schemas);
        Assert.DoesNotContain("agent_hr", schemas); // no USAGE on it
        Assert.DoesNotContain("pg_catalog", schemas);

        var objects = await db.ObjectsAsync("agent_erp", default);
        Assert.Equal(["parts", "v_open_orders", "work orders"], objects.Select(o => o.Name));
        Assert.Equal("view", objects.Single(o => o.Name == "v_open_orders").Kind);
        Assert.Null(await db.ColumnsAsync("agent_erp", "salaries", default)); // exists, but this login may not read it

        var shape = (await db.ColumnsAsync("agent_erp", "work orders", default))!;
        Assert.Equal("id", shape.Columns[0].Name);
        Assert.True(shape.Columns[0].PrimaryKey);
        Assert.Equal("numeric(12,3)", shape.Columns.Single(c => c.Name == "qty").DataType);
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
        Assert.Equal("2026-01-01T09:00:00Z", DbValues.ToJson(r["raised"])!.GetValue<string>());
        Assert.Equal("(binary, 2 bytes)", DbValues.ToJson(r["drawing"])!.GetValue<string>());
        Assert.Equal(DbValues.MaxText + 1, DbValues.ToJson(rows[2]["notes"])!.GetValue<string>().Length);
    }

    [Fact]
    public async Task Says_why_it_could_not_connect_without_echoing_the_password()
    {
        if (admin is null) return;
        var missing = await Assert.ThrowsAsync<JobFailedException>(() => new DatabaseAdapters().OpenAsync(Settings("no_such_db"), Reader, default));
        Assert.Equal("not_found", missing.Kind);
        Assert.Contains("no_such_db", missing.Message);
        var closed = await Assert.ThrowsAsync<JobFailedException>(() => new DatabaseAdapters().OpenAsync(Settings(port: 1), Reader, default));
        Assert.Equal("network", closed.Kind);
        Assert.DoesNotContain("reader-pass", missing.Message + closed.Message);
    }

    [Fact]
    public async Task Every_read_runs_in_a_read_only_transaction()
    {
        if (admin is null) return;
        // The adapter never issues a write; prove the session it opens refuses one even inside its own transaction pattern.
        await using var c = new NpgsqlConnection(PostgresAdapter.ConnectionString(Settings(), new DbCredential("postgres", "")));
        await c.OpenAsync();
        await using var tx = await c.BeginTransactionAsync();
        await using (var ro = new NpgsqlCommand("SET TRANSACTION READ ONLY", c, tx)) await ro.ExecuteNonQueryAsync();
        await using var write = new NpgsqlCommand("delete from agent_erp.parts", c, tx);
        var e = await Assert.ThrowsAsync<PostgresException>(() => write.ExecuteNonQueryAsync());
        Assert.Equal("25006", e.SqlState);
    }
}
