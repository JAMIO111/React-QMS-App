using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Fortress.Agent.Adapters;
using Fortress.Agent.Core;

namespace Fortress.Agent.Tests;

/// <summary>A database that answers from memory, recording what it was asked.</summary>
internal sealed class FakeDatabase : IDatabaseAdapterFactory, IDatabaseAdapter
{
    public IReadOnlyCollection<string> Engines => ["postgres", "sqlserver"];
    public List<string> Calls { get; } = [];
    public DbCredential? OpenedWith { get; private set; }
    public Exception? FailOpen { get; set; }

    public Task<IDatabaseAdapter> OpenAsync(ConnectionSettings settings, DbCredential? credential, CancellationToken ct)
    {
        if (FailOpen is not null) throw FailOpen;
        OpenedWith = credential;
        Calls.Add($"open {settings.Engine} {settings.Server}/{settings.Database}");
        return Task.FromResult<IDatabaseAdapter>(this);
    }

    public Task<(string Product, string User, string Database)> DescribeAsync(CancellationToken ct) => Task.FromResult(("PostgreSQL 16.4", "reader", "erp"));
    public Task<IReadOnlyList<string>> SchemasAsync(CancellationToken ct) => Task.FromResult<IReadOnlyList<string>>(["erp", "hr", "public"]);
    public Task<IReadOnlyList<DbObject>> ObjectsAsync(string schema, CancellationToken ct) =>
        Task.FromResult<IReadOnlyList<DbObject>>([new DbObject("orders", "table", 2500), new DbObject("v_open_orders", "view", null), new DbObject("salaries", "table", 10)]);
    public Task<TableShape?> ColumnsAsync(string schema, string name, CancellationToken ct) => Task.FromResult<TableShape?>(name == "missing" ? null : new TableShape(schema, name,
        [new DbColumn("id", "bigint", false, true), new DbColumn("order no", "text", false, false), new DbColumn("qty", "numeric(12,3)", true, false), new DbColumn("due", "date", true, false), new DbColumn("notes", "text", true, false)],
        [new DbForeignKey("orders_part_fkey", ["part id"], "erp", "parts", ["id"])]));
    public Task<IReadOnlyList<IReadOnlyDictionary<string, object?>>> PreviewAsync(TableShape shape, int limit, CancellationToken ct)
    {
        Calls.Add($"preview {shape.Schema}.{shape.Name} {limit}");
        return Task.FromResult<IReadOnlyList<IReadOnlyDictionary<string, object?>>>(Enumerable.Range(1, limit).Select(i => (IReadOnlyDictionary<string, object?>)new Dictionary<string, object?>
        {
            ["id"] = (long)i, ["order no"] = $"WO-{i}", ["qty"] = 1.500m * i, ["due"] = new DateOnly(2026, 1, i % 28 + 1),
        }).ToList());
    }
    /// <summary>Rows for extraction: ids 1..ExtractRows, in id order, with optional long notes.</summary>
    public int ExtractRows { get; set; } = 25;
    public int NotesLength { get; set; }
    public List<ExtractQuery> Extracts { get; } = [];

    public Task<IReadOnlyList<ExtractedRow>> ExtractPageAsync(ExtractQuery q, CancellationToken ct)
    {
        Extracts.Add(q);
        var after = q.AfterKey is null ? 0 : long.Parse(q.AfterKey, System.Globalization.CultureInfo.InvariantCulture);
        var rnd = new Random(7);
        return Task.FromResult<IReadOnlyList<ExtractedRow>>(Enumerable.Range(1, ExtractRows).Where(i => i > after).Take(q.Limit).Select(i =>
        {
            var all = new Dictionary<string, object?>
            {
                ["id"] = (long)i, ["order no"] = $"WO-{i}", ["qty"] = 1.500m * i, ["due"] = new DateOnly(2026, 1, i % 28 + 1),
                ["notes"] = NotesLength == 0 ? null : new string(Enumerable.Range(0, NotesLength).Select(_ => (char)rnd.Next('a', 'z' + 1)).ToArray()),
            };
            return new ExtractedRow(q.Columns.ToDictionary(c => c.Name, c => all.GetValueOrDefault(c.Name)), i.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }).ToList());
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}

public sealed class DatabaseJobTests : IDisposable
{
    private readonly string dir = Path.Combine(Path.GetTempPath(), "fortress-agent-db-" + Guid.NewGuid().ToString("N"));
    private readonly FakeDatabase db = new();
    private readonly CredentialStore credentials;
    private const string ConnectionId = "5f0c2b8e-3a51-4d6c-9e2f-7b8a1c4d0e93";
    private static readonly JobContext Ctx = new((_, _) => Task.FromResult(true), TimeProvider.System);

    public DatabaseJobTests() => credentials = new CredentialStore(Path.Combine(dir, "credentials"), new FilePermissionKeyProtector());

    public void Dispose()
    {
        if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
    }

    private string AllowList => Path.Combine(dir, "allowlist.json");
    private JobHandlers Handlers(ECDiffieHellman? sealing = null) => JobHandlers.ForDatabases(db, credentials, AllowList, () => sealing ?? throw new InvalidOperationException());

    private static AgentJob Job(string kind, object? request = null, JsonObject? connection = null) => new()
    {
        Id = Guid.NewGuid().ToString(),
        Kind = kind,
        Spec = new JsonObject
        {
            ["connectionId"] = ConnectionId,
            ["connection"] = connection ?? new JsonObject { ["engine"] = "postgres", ["server"] = "erp-db.factory.local", ["port"] = 5432, ["database"] = "erp", ["authType"] = "password", ["encrypt"] = false },
            ["request"] = request is null ? new JsonObject() : JsonNode.Parse(System.Text.Json.JsonSerializer.Serialize(request)),
        },
    };

    private static JsonNode Fixture(string name) => JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "contract", name)))!;

    [Fact]
    public void Opens_a_password_sealed_by_the_browser_and_only_for_its_own_connection()
    {
        var v = Fixture("sealed-credential.json");
        using var key = ECDiffieHellman.Create();
        key.ImportPkcs8PrivateKey(Convert.FromBase64String(v["sealingPrivateKey"]!.GetValue<string>()), out _);
        var s = v["sealed"]!;
        var plain = SealedBox.Open(key, v["connectionId"]!.GetValue<string>(), s["epk"]!.GetValue<string>(), s["iv"]!.GetValue<string>(), s["ct"]!.GetValue<string>());
        Assert.Equal(v["plaintext"]!.GetValue<string>(), Encoding.UTF8.GetString(plain));
        Assert.ThrowsAny<CryptographicException>(() => SealedBox.Open(key, Guid.NewGuid().ToString(), s["epk"]!.GetValue<string>(), s["iv"]!.GetValue<string>(), s["ct"]!.GetValue<string>()));
        using var other = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
        Assert.ThrowsAny<CryptographicException>(() => SealedBox.Open(other, v["connectionId"]!.GetValue<string>(), s["epk"]!.GetValue<string>(), s["iv"]!.GetValue<string>(), s["ct"]!.GetValue<string>()));
    }

    [Fact]
    public async Task Stores_the_password_protected_and_never_answers_with_it()
    {
        using var sealing = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
        var (epk, iv, ct) = SealedBox.Seal(Convert.ToBase64String(sealing.ExportSubjectPublicKeyInfo()), ConnectionId, """{"username":"reader","password":"hunter2"}"""u8.ToArray());
        var job = Job("store_credential");
        job.Spec!["sealed"] = new JsonObject { ["epk"] = epk, ["iv"] = iv, ["ct"] = ct };
        var result = await Handlers(sealing).For("store_credential")!.RunAsync(job, Ctx, default);
        Assert.DoesNotContain("hunter2", result!.ToJsonString());
        Assert.Equal(new DbCredential("reader", "hunter2"), credentials.Load(ConnectionId));
        Assert.DoesNotContain("hunter2", new DbCredential("reader", "hunter2").ToString());
        if (!OperatingSystem.IsWindows())
            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(Path.Combine(dir, "credentials", ConnectionId + ".bin")));

        job.Spec!["sealed"] = new JsonObject { ["epk"] = epk, ["iv"] = iv, ["ct"] = ct[..^4] + "AAA=" };
        var e = await Assert.ThrowsAsync<JobFailedException>(() => Handlers(sealing).For("store_credential")!.RunAsync(job, Ctx, default));
        Assert.Contains("could not be opened", e.Message);
    }

    [Fact]
    public async Task Tests_the_connection_with_the_stored_password()
    {
        var e = await Assert.ThrowsAsync<JobFailedException>(() => Handlers().For("test_connection")!.RunAsync(Job("test_connection"), Ctx, default));
        Assert.Equal("auth", e.Kind);
        Assert.Contains("no password", e.Message);

        credentials.Save(ConnectionId, new DbCredential("reader", "hunter2"));
        var r = await Handlers().For("test_connection")!.RunAsync(Job("test_connection"), Ctx, default);
        Assert.True(r!["ok"]!.GetValue<bool>());
        Assert.Equal("Signed in to PostgreSQL 16.4 as reader (database erp); 3 schemas can be read", r["message"]!.GetValue<string>());
        Assert.Equal(new DbCredential("reader", "hunter2"), db.OpenedWith);

        // Windows authentication needs no password
        var win = new JsonObject { ["engine"] = "sqlserver", ["server"] = "SQL01", ["instance"] = "SQLEXPRESS", ["database"] = "ERP", ["authType"] = "windows" };
        await Handlers().For("test_connection")!.RunAsync(Job("test_connection", connection: win), Ctx, default);
        Assert.Null(db.OpenedWith);
    }

    [Theory]
    [InlineData("server", "db;Password=x", "server")]
    [InlineData("database", "erp;Integrated Security=true", "database name")]
    [InlineData("engine", "oracle", "SQL Server, PostgreSQL and MySQL")]
    [InlineData("authType", "windows", "PostgreSQL signs in")]
    public async Task Refuses_settings_that_could_change_the_connection_string(string key, string value, string words)
    {
        credentials.Save(ConnectionId, new DbCredential("reader", "hunter2"));
        var c = Job("test_connection").Spec!["connection"]!.AsObject();
        c[key] = value;
        var e = await Assert.ThrowsAsync<JobFailedException>(() => Handlers().For("test_connection")!.RunAsync(Job("test_connection", connection: c.DeepClone().AsObject()), Ctx, default));
        Assert.Contains(words, e.Message);
        Assert.Empty(db.Calls);
    }

    [Fact]
    public async Task Browses_schemas_tables_and_columns()
    {
        credentials.Save(ConnectionId, new DbCredential("reader", "hunter2"));
        var schemas = await Handlers().For("discover")!.RunAsync(Job("discover", new { level = "schemas" }), Ctx, default);
        Assert.Equal(["erp", "hr", "public"], schemas!["schemas"]!.AsArray().Select(x => x!["name"]!.GetValue<string>()));
        var objects = await Handlers().For("discover")!.RunAsync(Job("discover", new { level = "objects", schema = "erp" }), Ctx, default);
        Assert.Equal("view", objects!["objects"]![1]!["kind"]!.GetValue<string>());
        Assert.Equal(2500, objects["objects"]![0]!["rowEstimate"]!.GetValue<long>());
        var columns = await Handlers().For("discover")!.RunAsync(Job("discover", new { level = "columns", schema = "erp", @object = "orders" }), Ctx, default);
        Assert.True(columns!["columns"]![0]!["primaryKey"]!.GetValue<bool>());
        Assert.Equal("parts", columns["foreignKeys"]![0]!["references"]!["object"]!.GetValue<string>());
        var missing = await Assert.ThrowsAsync<JobFailedException>(() => Handlers().For("discover")!.RunAsync(Job("discover", new { level = "columns", schema = "erp", @object = "missing" }), Ctx, default));
        Assert.Equal("not_found", missing.Kind);
    }

    [Fact]
    public async Task Previews_with_typed_values_and_at_most_fifty_rows()
    {
        credentials.Save(ConnectionId, new DbCredential("reader", "hunter2"));
        var r = await Handlers().For("preview")!.RunAsync(Job("preview", new { schema = "erp", @object = "orders", limit = 500 }), Ctx, default);
        Assert.Contains("preview erp.orders 50", db.Calls);
        var row = r!["rows"]![0]!;
        Assert.Equal(1, row["id"]!.GetValue<long>());
        Assert.Equal("1.500", row["qty"]!.GetValue<string>());
        Assert.Equal("2026-01-02", row["due"]!.GetValue<string>());
        Assert.Equal(["id", "order no", "qty", "due", "notes"], r["columns"]!.AsArray().Select(c => c!["name"]!.GetValue<string>()));
    }

    [Fact]
    public async Task The_local_allow_list_limits_what_can_be_read()
    {
        credentials.Save(ConnectionId, new DbCredential("reader", "hunter2"));
        Directory.CreateDirectory(dir);
        File.WriteAllText(AllowList, """{ "objects": ["erp.orders", "erp.v_*"] }""");
        var schemas = await Handlers().For("discover")!.RunAsync(Job("discover", new { level = "schemas" }), Ctx, default);
        Assert.Equal(["erp"], schemas!["schemas"]!.AsArray().Select(x => x!["name"]!.GetValue<string>()));
        Assert.True(schemas["allowListed"]!.GetValue<bool>());
        var objects = await Handlers().For("discover")!.RunAsync(Job("discover", new { level = "objects", schema = "ERP" }), Ctx, default);
        Assert.Equal(["orders", "v_open_orders"], objects!["objects"]!.AsArray().Select(x => x!["name"]!.GetValue<string>()));
        var refused = await Assert.ThrowsAsync<JobFailedException>(() => Handlers().For("preview")!.RunAsync(Job("preview", new { schema = "erp", @object = "salaries" }), Ctx, default));
        Assert.Equal("refused", refused.Kind);
        Assert.Contains("allow-list", refused.Message);
        Assert.DoesNotContain(db.Calls, c => c.Contains("salaries"));

        File.WriteAllText(AllowList, """{ "databases": ["mes"] }""");
        var db2 = await Assert.ThrowsAsync<JobFailedException>(() => Handlers().For("discover")!.RunAsync(Job("discover"), Ctx, default));
        Assert.Contains("The database erp is not on this agent's allow-list", db2.Message);

        File.WriteAllText(AllowList, "{ not json");
        var bad = await Assert.ThrowsAsync<JobFailedException>(() => Handlers().For("discover")!.RunAsync(Job("discover"), Ctx, default));
        Assert.Contains("not valid JSON", bad.Message);
    }

    [Fact]
    public void Values_go_to_Fortress_without_losing_digits()
    {
        Assert.Equal("12345678901234567890.123", DbValues.ToJson(12345678901234567890.123m)!.GetValue<string>());
        Assert.Equal(42, DbValues.ToJson((short)42)!.GetValue<long>());
        Assert.Equal("2026-03-04", DbValues.ToJson(new DateTime(2026, 3, 4))!.GetValue<string>());
        Assert.Equal("2026-03-04T05:06:07Z", DbValues.ToJson(new DateTime(2026, 3, 4, 5, 6, 7, DateTimeKind.Utc))!.GetValue<string>());
        Assert.Equal("(binary, 3 bytes)", DbValues.ToJson(new byte[] { 1, 2, 3 })!.GetValue<string>());
        Assert.Null(DbValues.ToJson(DBNull.Value));
        Assert.Equal(DbValues.MaxText + 1, DbValues.ToJson(new string('x', 5000))!.GetValue<string>().Length);
        Assert.Equal("NaN", DbValues.ToJson(double.NaN)!.GetValue<string>());
    }

    [Fact]
    public void The_one_data_query_quotes_every_name_it_was_given_by_the_catalogue()
    {
        var shape = new TableShape("erp", "work \"orders\"]", [new DbColumn("order no", "text", false, false), new DbColumn("x\"; drop table y; --", "text", true, false)], []);
        Assert.Equal("select \"order no\", \"x\"\"; drop table y; --\" from \"erp\".\"work \"\"orders\"\"]\" limit $1", PostgresAdapter.PreviewSql(shape));
        Assert.Equal("SELECT TOP (@limit) [order no], [x\"; drop table y; --] FROM [erp].[work \"orders\"]]]", SqlServerAdapter.PreviewSql(shape));
    }

    [Fact]
    public void Connection_strings_come_from_builders_and_keep_settings_in_their_place()
    {
        var pg = ConnectionSettings.Parse(JsonNode.Parse("""{"engine":"postgres","server":"db1","port":5433,"database":"erp","authType":"password","encrypt":true}""")!.AsObject());
        var cs = PostgresAdapter.ConnectionString(pg, new DbCredential("reader", "p;w'd"));
        Assert.Contains("SSL Mode=VerifyFull", cs);
        Assert.Contains("Port=5433", cs);
        var ss = ConnectionSettings.Parse(JsonNode.Parse("""{"engine":"sqlserver","server":"SQL01","instance":"SQLEXPRESS","database":"ERP","authType":"windows","trustServerCertificate":true}""")!.AsObject());
        var sql = SqlServerAdapter.ConnectionString(ss, null);
        Assert.Contains(@"Data Source=SQL01\SQLEXPRESS", sql);
        Assert.Contains("Integrated Security=True", sql);
        Assert.Contains("Application Intent=ReadOnly", sql);
        Assert.Contains("Encrypt=True", sql);
        Assert.DoesNotContain("Password", sql);
    }

    [Fact]
    public void Says_which_databases_it_reads()
    {
        var caps = Handlers().Capabilities();
        Assert.Equal(["discover", "extract", "ping", "preview", "store_credential", "test_connection"], caps["jobs"]!.AsArray().Select(x => x!.GetValue<string>()));
        Assert.Equal(["postgres", "sqlserver"], caps["adapters"]!.AsArray().Select(x => x!.GetValue<string>()));
    }
}
