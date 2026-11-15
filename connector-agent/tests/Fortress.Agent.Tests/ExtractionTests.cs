using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Fortress.Agent.Adapters;
using Fortress.Agent.Core;

namespace Fortress.Agent.Tests;

/// <summary>Extraction (AG3): batches in order with checksums over what is inside, resume, limits, refusals, splitting, cancellation and the SQL built.</summary>
public sealed class ExtractionTests : IDisposable
{
    private readonly string dir = Path.Combine(Path.GetTempPath(), "fortress-agent-extract-" + Guid.NewGuid().ToString("N"));
    private readonly FakeDatabase db = new();
    private readonly CredentialStore credentials;
    private const string ConnectionId = "5f0c2b8e-3a51-4d6c-9e2f-7b8a1c4d0e93";
    private readonly List<RowBatch> sent = [];
    private Func<RowBatch, BatchReceipt> answer = b => new BatchReceipt { Stored = true, Status = "running" };

    public ExtractionTests()
    {
        credentials = new CredentialStore(Path.Combine(dir, "credentials"), new FilePermissionKeyProtector());
        credentials.Save(ConnectionId, new DbCredential("reader", "hunter2"));
    }

    public void Dispose()
    {
        if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
    }

    private JobContext Ctx => new((_, _) => Task.FromResult(true), TimeProvider.System, (b, _) => { sent.Add(b); return Task.FromResult(answer(b)); });
    private IJobHandler Handler => JobHandlers.ForDatabases(db, credentials, Path.Combine(dir, "allowlist.json"), () => throw new InvalidOperationException()).For("extract")!;

    private static AgentJob Job(JsonObject request, JobResume? resume = null) => new()
    {
        Id = Guid.NewGuid().ToString(),
        Kind = "extract",
        Spec = new JsonObject
        {
            ["connectionId"] = ConnectionId,
            ["connection"] = new JsonObject { ["engine"] = "postgres", ["server"] = "erp-db.factory.local", ["database"] = "erp", ["authType"] = "password" },
            ["request"] = request,
        },
        Resume = resume,
    };

    private static JsonObject Request(int batchRows = 10, long? maxRows = null, JsonArray? columns = null, JsonArray? filters = null)
    {
        var r = new JsonObject { ["schema"] = "erp", ["object"] = "orders", ["keyColumn"] = "id", ["batchRows"] = batchRows };
        if (maxRows is not null) r["maxRows"] = maxRows;
        if (columns is not null) r["columns"] = columns;
        if (filters is not null) r["filters"] = filters;
        return r;
    }

    private static JsonObject Open(RowBatch b, out byte[] json)
    {
        using var gz = new GZipStream(new MemoryStream(b.Gzip), CompressionMode.Decompress);
        using var ms = new MemoryStream();
        gz.CopyTo(ms);
        json = ms.ToArray();
        return JsonNode.Parse(json)!.AsObject();
    }

    [Fact]
    public async Task Sends_the_table_in_numbered_batches_whose_checksum_is_of_what_is_inside()
    {
        var result = await Handler.RunAsync(Job(Request(batchRows: 10, columns: ["id", "order no", "due"])), Ctx, default);
        Assert.Equal([0, 1, 2], sent.Select(b => b.Seq));
        Assert.Equal([10, 10, 5], sent.Select(b => b.RowCount));
        var first = Open(sent[0], out var json);
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(json)), sent[0].Checksum);
        Assert.Equal(0, first["seq"]!.GetValue<int>());
        Assert.Equal("10", first["lastKey"]!.GetValue<string>());
        Assert.Equal(["id", "order no", "due"], first["rows"]![0]!.AsObject().Select(p => p.Key));
        Assert.Equal("2026-01-02", first["rows"]![0]!["due"]!.GetValue<string>());
        Assert.Equal(3, result!["batches"]!.GetValue<int>());
        Assert.Equal(25, result["rows"]!.GetValue<long>());
        Assert.False(result["truncated"]!.GetValue<bool>());
        // Each page carried on after the last key of the one before.
        Assert.Equal([null, "10", "20"], db.Extracts.Select(q => q.AfterKey));
    }

    [Fact]
    public async Task Carries_on_where_Fortress_says_its_batches_end()
    {
        var result = await Handler.RunAsync(Job(Request(batchRows: 10), new JobResume { NextSeq = 2, AfterKey = "20", Rows = 20 }), Ctx, default);
        Assert.Equal([2], sent.Select(b => b.Seq));
        Assert.Equal("21", Open(sent[0], out _)["rows"]![0]!["order no"]!.GetValue<string>()[3..]);
        Assert.Equal(3, result!["batches"]!.GetValue<int>());
        Assert.Equal(25, result["rows"]!.GetValue<long>());
    }

    [Fact]
    public async Task A_preview_reads_no_more_than_it_may()
    {
        var result = await Handler.RunAsync(Job(Request(batchRows: 10, maxRows: 12)), Ctx, default);
        Assert.Equal([10, 2], sent.Select(b => b.RowCount));
        Assert.True(result!["truncated"]!.GetValue<bool>());
    }

    [Fact]
    public async Task An_empty_table_sends_nothing_and_says_so()
    {
        db.ExtractRows = 0;
        var result = await Handler.RunAsync(Job(Request()), Ctx, default);
        Assert.Empty(sent);
        Assert.Equal(0, result!["batches"]!.GetValue<int>());
    }

    [Fact]
    public async Task A_batch_Fortress_already_has_still_counts()
    {
        answer = b => new BatchReceipt { Duplicate = true, Status = "running" };
        var result = await Handler.RunAsync(Job(Request(batchRows: 25)), Ctx, default);
        Assert.Equal(1, result!["batches"]!.GetValue<int>());
    }

    [Fact]
    public async Task Stops_when_Fortress_has_cancelled_the_job()
    {
        answer = b => new BatchReceipt { Cancelled = true, Status = "cancelled" };
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Handler.RunAsync(Job(Request()), Ctx, default));
        Assert.Single(sent);
    }

    [Fact]
    public async Task Refuses_columns_filters_and_tables_the_database_does_not_list()
    {
        var e = await Assert.ThrowsAsync<JobFailedException>(() => Handler.RunAsync(Job(Request(columns: ["id", "salary"])), Ctx, default));
        Assert.Equal("not_found", e.Kind);
        Assert.Contains("salary", e.Message);
        var key = Request();
        key["keyColumn"] = "nope";
        Assert.Contains("identifies each row", (await Assert.ThrowsAsync<JobFailedException>(() => Handler.RunAsync(Job(key), Ctx, default))).Message);
        var op = await Assert.ThrowsAsync<JobFailedException>(() => Handler.RunAsync(Job(Request(filters: [new JsonObject { ["column"] = "id", ["op"] = "; drop", ["value"] = 1 }])), Ctx, default));
        Assert.Equal("invalid", op.Kind);
        var missing = Request();
        missing["object"] = "missing";
        Assert.Equal("not_found", (await Assert.ThrowsAsync<JobFailedException>(() => Handler.RunAsync(Job(missing), Ctx, default))).Kind);
        File.WriteAllText(Path.Combine(dir, "allowlist.json"), """{ "objects": ["erp.v_*"] }""");
        Assert.Equal("refused", (await Assert.ThrowsAsync<JobFailedException>(() => Handler.RunAsync(Job(Request()), Ctx, default))).Kind);
        Assert.Empty(sent);
        Assert.Empty(db.Extracts);
    }

    [Fact]
    public async Task Filters_reach_the_query_with_their_values_as_text()
    {
        await Handler.RunAsync(Job(Request(filters: [new JsonObject { ["column"] = "qty", ["op"] = "gte", ["value"] = 3 }, new JsonObject { ["column"] = "due", ["op"] = "is_null" }])), Ctx, default);
        var q = db.Extracts[0];
        Assert.Equal([("qty", "gte", "3"), ("due", "is_null", (string?)null)], q.Filters.Select(f => (f.Column.Name, f.Op, f.Value)));
    }

    [Fact]
    public async Task A_page_too_big_to_send_goes_in_smaller_batches()
    {
        db.ExtractRows = 400;
        db.NotesLength = 5000; // random text: 400 rows ≈ 2 MB of JSON that hardly compresses
        var result = await Handler.RunAsync(Job(Request(batchRows: 400)), Ctx, default);
        Assert.True(sent.Count > 1);
        Assert.All(sent, b => Assert.True(b.Gzip.Length <= ExtractHandler.MaxGzipBytes));
        Assert.Equal(400, sent.Sum(b => b.RowCount));
        Assert.Equal(Enumerable.Range(0, sent.Count), sent.Select(b => b.Seq));
        Assert.Equal(sent.Count, result!["batches"]!.GetValue<int>());
    }

    [Fact]
    public void Sql_server_builds_the_same_shape_of_query_with_bracketed_names()
    {
        var shape = new TableShape("dbo", "work]orders", [new DbColumn("id", "int", false, true), new DbColumn("order no", "nvarchar", false, false)], []);
        var (sql, values) = SqlServerAdapter.ExtractSql(new ExtractQuery(shape, shape.Columns, shape.Columns[0],
            [new ExtractFilter(shape.Columns[1], "ne", "x'; drop table t; --"), new ExtractFilter(shape.Columns[1], "not_null", null)], "41", 1000));
        Assert.Equal("SELECT TOP (@limit) [id], [order no] FROM [dbo].[work]]orders] WHERE [id] IS NOT NULL AND [id] > @p1 AND [order no] <> @p2 AND [order no] IS NOT NULL ORDER BY [id]", sql);
        Assert.Equal(["41", "x'; drop table t; --"], values);
    }
}
