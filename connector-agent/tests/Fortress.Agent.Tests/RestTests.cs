using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Fortress.Agent.Core;

namespace Fortress.Agent.Tests;

/// <summary>
/// Internal REST APIs (AG5c): records flattened exactly as the cloud connector flattens them (the shared contract), only hosts on the agent's own
/// allow-list, no redirects, no link-local addresses, paging by page, cursor and next link, incremental reads by a changed field, resume after a
/// restart, the sign-in sealed to the agent, and failures in words.
/// </summary>
public sealed class RestTests : IDisposable
{
    private const string ConnectionId = "6a1d3c9e-2b47-4f8a-9c3d-5e7f1a2b4c6d";
    private readonly string root = Path.Combine(Path.GetTempPath(), "fortress-agent-rest-" + Guid.NewGuid().ToString("N"));
    private readonly string allowList;
    private readonly CredentialStore credentials;
    private readonly FakeApi api = new();
    private readonly List<RowBatch> sent = [];

    public RestTests()
    {
        Directory.CreateDirectory(root);
        allowList = Path.Combine(root, "allowlist.json");
        credentials = new CredentialStore(Path.Combine(root, "credentials"), new FilePermissionKeyProtector());
        AllowHosts($"127.0.0.1:{api.Port}");
    }

    public void Dispose()
    {
        api.Dispose();
        if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
    }

    private void AllowHosts(params string[] hosts) => AllowHosts(false, hosts);

    private void AllowHosts(bool plainHttpSignIn, params string[] hosts) =>
        File.WriteAllText(allowList, new JsonObject
        {
            ["hosts"] = new JsonArray(hosts.Select(h => (JsonNode)JsonValue.Create(h)!).ToArray()),
            ["plainHttpSignIn"] = plainHttpSignIn,
        }.ToJsonString());

    private JobHandlers Handlers => JobHandlers.ForDatabases(new FakeDatabase(), credentials, allowList, () => throw new InvalidOperationException());

    private JobContext Ctx => new((_, _) => Task.FromResult(true), TimeProvider.System, (b, _) => { sent.Add(b); return Task.FromResult(new BatchReceipt { Stored = true, Status = "running" }); });

    private AgentJob Job(string kind, JsonObject? request = null, JsonObject? connection = null, JobResume? resume = null) => new()
    {
        Id = Guid.NewGuid().ToString(),
        Kind = kind,
        Resume = resume,
        Spec = new JsonObject
        {
            ["connectionId"] = ConnectionId,
            ["connection"] = connection?.DeepClone() ?? new JsonObject { ["engine"] = "rest", ["baseUrl"] = $"http://127.0.0.1:{api.Port}/api", ["authType"] = "none", ["testPath"] = "/health" },
            ["request"] = request?.DeepClone() ?? new JsonObject(),
        },
    };

    private async Task<JsonObject> Run(string kind, JsonObject? request = null, JsonObject? connection = null, JobResume? resume = null) =>
        (JsonObject)(await Handlers.For(kind)!.RunAsync(Job(kind, request, connection, resume), Ctx, default))!;

    private static JsonObject Machines(int pageSize = 100) => new()
    {
        ["path"] = "/v1/machines", ["recordsPath"] = "data", ["keyColumn"] = "code",
        ["paging"] = new JsonObject { ["style"] = "page", ["pageSize"] = pageSize },
    };

    private List<JsonObject> Rows() => sent.SelectMany(b =>
    {
        using var gz = new GZipStream(new MemoryStream(b.Gzip), CompressionMode.Decompress);
        using var buffer = new MemoryStream();
        gz.CopyTo(buffer);
        return JsonNode.Parse(buffer.ToArray())!["rows"]!.AsArray().Select(r => r!.AsObject());
    }).ToList();

    // ---------------------------------------------------------------------------------------------------------------------------------------------------
    // Flattening: the same as the cloud connector, case by case
    // ---------------------------------------------------------------------------------------------------------------------------------------------------
    [Fact]
    public void Flattens_every_contract_case_exactly_as_the_cloud_connector()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "contract", "rest-flatten.json");
        // Read with JsNode: an expected value may hold a lone surrogate, which System.Text.Json refuses to read.
        var contract = (JsNode.Obj)JsNode.Parse(File.ReadAllBytes(path));
        string Text(JsNode n) => ((JsNode.Str)n).Value;
        var cases = ((JsNode.Arr)contract.Members.First(m => m.Key == "cases").Value).Items;
        Assert.True(cases.Count >= 10);
        foreach (var c in cases.Cast<JsNode.Obj>())
        {
            var record = (JsNode.Obj)JsNode.Parse(Text(c.Members.First(m => m.Key == "record").Value));
            var expected = ((JsNode.Arr)c.Members.First(m => m.Key == "expected").Value).Items.Cast<JsNode.Arr>()
                .Select(p => new KeyValuePair<string, string>(Text(p.Items[0]), Text(p.Items[1]))).ToList();
            Assert.Equal(expected, RestFlatten.Flatten(record));
        }
    }

    [Theory]
    [InlineData(1.0, "1")]
    [InlineData(0.1, "0.1")]
    [InlineData(1e21, "1e+21")]
    [InlineData(1e20, "100000000000000000000")]
    [InlineData(1e-7, "1e-7")]
    [InlineData(1.5e-6, "0.0000015")]
    [InlineData(-2.5, "-2.5")]
    [InlineData(123456789.125, "123456789.125")]
    public void Prints_numbers_as_javascript_does(double d, string text) => Assert.Equal(text, JsNode.NumberText(d));

    [Fact]
    public void Compares_incremental_values_as_the_cloud_connector()
    {
        Assert.True(RestFlatten.Greater("10", "9"));          // numbers as numbers
        Assert.False(RestFlatten.Greater("9", "10"));
        Assert.True(RestFlatten.Greater("2026-11-16", "2026-11-15"));   // text as text
        Assert.True(RestFlatten.Greater("a", null));
    }

    // ---------------------------------------------------------------------------------------------------------------------------------------------------
    // Where the agent may call
    // ---------------------------------------------------------------------------------------------------------------------------------------------------
    [Fact]
    public void Allows_only_listed_hosts_and_ports()
    {
        var allow = new LocalAllowList { Hosts = ["erp.factory.local", "10.0.4.12:8080", "*.mes.local", "[fd00::12]:9000"] };
        Assert.True(allow.AllowsHost(new Uri("http://erp.factory.local/api")));
        Assert.True(allow.AllowsHost(new Uri("https://ERP.factory.local:8443/api")));      // any port when none is listed
        Assert.False(allow.AllowsHost(new Uri("http://erp.factory.local.evil.com/")));
        Assert.False(allow.AllowsHost(new Uri("http://sub.erp.factory.local/")));          // a plain name is that host only
        Assert.True(allow.AllowsHost(new Uri("http://10.0.4.12:8080/")));
        Assert.False(allow.AllowsHost(new Uri("http://10.0.4.12:9090/")));                 // only that port
        Assert.True(allow.AllowsHost(new Uri("http://line1.mes.local/")));
        Assert.False(allow.AllowsHost(new Uri("http://mes.local/")));                      // "*." is sub-domains only
        Assert.True(allow.AllowsHost(new Uri("http://[fd00::12]:9000/")));
        Assert.False(new LocalAllowList().AllowsHost(new Uri("http://erp.factory.local/"))); // no list, no API
    }

    [Theory]
    [InlineData("169.254.169.254", true)]
    [InlineData("0.0.0.0", true)]
    [InlineData("224.0.0.1", true)]
    [InlineData("fe80::1", true)]
    [InlineData("::ffff:169.254.169.254", true)]
    [InlineData("10.0.4.12", false)]
    [InlineData("127.0.0.1", false)]
    [InlineData("fd00::12", false)]
    public void Refuses_link_local_any_and_multicast_addresses(string address, bool refused) => Assert.Equal(refused, RestHttp.Refused(IPAddress.Parse(address)));

    [Fact]
    public async Task Refuses_an_api_that_is_not_on_the_allow_list_or_at_a_metadata_address()
    {
        AllowHosts("erp.factory.local");
        var e = await Assert.ThrowsAsync<JobFailedException>(() => Run("test_connection"));
        Assert.Equal("refused", e.Kind);
        Assert.Contains("is not on this agent's allow-list", e.Message);

        AllowHosts("169.254.169.254");
        var meta = new JsonObject { ["engine"] = "rest", ["baseUrl"] = "http://169.254.169.254/latest", ["authType"] = "none" };
        e = await Assert.ThrowsAsync<JobFailedException>(() => Run("test_connection", connection: meta));
        Assert.Equal("refused", e.Kind);
        Assert.Contains("cannot be at", e.Message);
    }

    [Fact]
    public async Task Never_follows_a_redirect_or_a_next_link_to_another_address()
    {
        var e = await Assert.ThrowsAsync<JobFailedException>(() => Run("preview", new JsonObject { ["path"] = "/redirect" }));
        Assert.Contains("redirect, which is not followed", e.Message);
        Assert.Equal(0, api.Hits("/elsewhere"));

        e = await Assert.ThrowsAsync<JobFailedException>(() => Run("extract", new JsonObject
        {
            ["path"] = "/v1/link-away", ["recordsPath"] = "value", ["keyColumn"] = "code",
            ["paging"] = new JsonObject { ["style"] = "next_link", ["nextLinkPath"] = "@odata.nextLink" },
        }));
        Assert.Contains("goes to another address", e.Message);
    }

    // ---------------------------------------------------------------------------------------------------------------------------------------------------
    // Test, preview, extract
    // ---------------------------------------------------------------------------------------------------------------------------------------------------
    [Fact]
    public async Task Tests_an_allowed_api()
    {
        var test = await Run("test_connection");
        Assert.True(test["ok"]!.GetValue<bool>());
        Assert.Equal("The API answered 200 at /api/health", test["message"]!.GetValue<string>());
    }

    [Fact]
    public async Task Previews_the_first_records_of_an_address_as_flat_columns()
    {
        var preview = await Run("preview", new JsonObject { ["path"] = "/v1/machines", ["recordsPath"] = "data", ["limit"] = 5, ["paging"] = new JsonObject { ["style"] = "page" } });
        Assert.Equal(["code", "name", "site.code", "updatedAt"], preview["columns"]!.AsArray().Select(c => c!["name"]!.GetValue<string>()));
        var rows = preview["rows"]!.AsArray();
        Assert.Equal(5, rows.Count);
        Assert.Equal("M001", rows[0]!["code"]!.GetValue<string>());
        Assert.Equal("NCL", rows[0]!["site.code"]!.GetValue<string>());
        Assert.True(preview["truncated"]!.GetValue<bool>());
        Assert.True(preview["morePages"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Reads_every_page_and_reports_the_highest_changed_value()
    {
        var request = Machines(100);
        request["changedColumn"] = "updatedAt";
        request["changedParam"] = "since";
        var result = await Run("extract", request);
        Assert.Equal(250, result["rows"]!.GetValue<long>());
        Assert.Equal(3, api.Hits("/api/v1/machines"));
        Assert.Equal("2026-11-16T04:10:00Z", result["changedUpTo"]!.GetValue<string>());
        var rows = Rows();
        Assert.Equal(250, rows.Count);
        Assert.Equal("M250", rows[^1]["code"]!.GetValue<string>());
        Assert.All(rows, r => Assert.Equal(JsonValueKind.String, r["site.code"]!.GetValueKind()));
    }

    [Fact]
    public async Task Reads_only_what_changed_since_the_mark()
    {
        var request = Machines(100);
        request["changedColumn"] = "updatedAt";
        request["changedParam"] = "since";
        request["changedSince"] = "2026-11-16T04:00:00Z";
        var result = await Run("extract", request);
        Assert.Equal(11, result["rows"]!.GetValue<long>());       // updatedAt from 04:00 to 04:10
        Assert.Contains(api.Queries("/api/v1/machines"), q => q.Contains("since=2026-11-16T04%3A00%3A00Z"));
        Assert.Equal("2026-11-16T04:10:00Z", result["changedUpTo"]!.GetValue<string>());
    }

    [Fact]
    public async Task Carries_on_after_a_restart_from_the_page_fortress_holds()
    {
        await Run("extract", Machines(100));
        var firstBatchLastKey = RestJobs.PageState.FromJson(LastKey(sent[0]));
        Assert.Equal(2, firstBatchLastKey!.Page);                 // the next page to ask for
        sent.Clear();
        api.Reset();
        var result = await Run("extract", Machines(100), resume: new JobResume { NextSeq = 1, AfterKey = LastKey(BatchOf(firstBatchLastKey)), Rows = 100 });
        Assert.Equal(250, result["rows"]!.GetValue<long>());
        Assert.Equal(2, api.Hits("/api/v1/machines"));            // pages 2 and 3 only
        Assert.Equal("M101", Rows()[0]["code"]!.GetValue<string>());
    }

    private static RowBatch BatchOf(RestJobs.PageState state)
    {
        var json = JsonSerializer.SerializeToUtf8Bytes(new JsonObject { ["seq"] = 0, ["lastKey"] = state.ToJson(), ["rows"] = new JsonArray() });
        using var output = new MemoryStream();
        using (var gz = new GZipStream(output, CompressionLevel.Fastest, leaveOpen: true)) gz.Write(json);
        return new RowBatch(0, 0, output.ToArray(), "");
    }

    private static string LastKey(RowBatch b)
    {
        using var gz = new GZipStream(new MemoryStream(b.Gzip), CompressionMode.Decompress);
        using var buffer = new MemoryStream();
        gz.CopyTo(buffer);
        return JsonNode.Parse(buffer.ToArray())!["lastKey"]!.GetValue<string>();
    }

    [Fact]
    public async Task Pages_by_cursor_and_by_next_link()
    {
        var byCursor = await Run("extract", new JsonObject
        {
            ["path"] = "/v1/cursor", ["recordsPath"] = "data", ["keyColumn"] = "code",
            ["paging"] = new JsonObject { ["style"] = "cursor", ["nextCursorPath"] = "meta.next", ["cursorParam"] = "after" },
        });
        Assert.Equal(6, byCursor["rows"]!.GetValue<long>());
        Assert.Contains(api.Queries("/api/v1/cursor"), q => q.Contains("after=c2"));

        sent.Clear();
        var byLink = await Run("extract", new JsonObject
        {
            ["path"] = "/v1/link", ["recordsPath"] = "value", ["keyColumn"] = "code",
            ["paging"] = new JsonObject { ["style"] = "next_link", ["nextLinkPath"] = "@odata.nextLink" },
        });
        Assert.Equal(4, byLink["rows"]!.GetValue<long>());
    }

    [Fact]
    public async Task Signs_in_with_the_token_held_by_the_agent()
    {
        var connection = new JsonObject { ["engine"] = "rest", ["baseUrl"] = $"http://127.0.0.1:{api.Port}/api", ["authType"] = "bearer", ["testPath"] = "/secure" };
        credentials.Save(ConnectionId, new DbCredential("", "s3cret-token"), ConnectionTarget.Of(connection));
        // A key or password goes over plain http only when the allow-list says so (AG6d): the token was never sent.
        var e = await Assert.ThrowsAsync<JobFailedException>(() => Run("test_connection", connection: connection));
        Assert.Equal("refused", e.Kind);
        Assert.Contains("plainHttpSignIn", e.Message);
        Assert.Equal(0, api.Hits("/api/secure"));
        AllowHosts(true, $"127.0.0.1:{api.Port}");
        credentials.Forget(ConnectionId);

        e = await Assert.ThrowsAsync<JobFailedException>(() => Run("test_connection", connection: connection));
        Assert.Equal("auth", e.Kind);
        Assert.Contains("no key or password", e.Message);

        credentials.Save(ConnectionId, new DbCredential("", "wrong"), ConnectionTarget.Of(connection));
        e = await Assert.ThrowsAsync<JobFailedException>(() => Run("test_connection", connection: connection));
        Assert.Equal("The API refused the sign-in (401)", e.Message);

        credentials.Save(ConnectionId, new DbCredential("", "s3cret-token"), ConnectionTarget.Of(connection));
        Assert.True((await Run("test_connection", connection: connection))["ok"]!.GetValue<bool>());

        var keyed = new JsonObject { ["engine"] = "rest", ["baseUrl"] = $"http://127.0.0.1:{api.Port}/api", ["authType"] = "api_key", ["apiKeyHeader"] = "X-Api-Key", ["testPath"] = "/keyed" };
        // The token was typed for a bearer sign-in: a connection changed to send it in a header must have it typed again (AG6d).
        e = await Assert.ThrowsAsync<JobFailedException>(() => Run("test_connection", connection: keyed));
        Assert.Equal(CredentialStore.TargetChanged, e.Message);
        Assert.Equal(1, api.Hits("/api/secure") > 0 ? 1 : 0);
        credentials.Save(ConnectionId, new DbCredential("", "s3cret-token"), ConnectionTarget.Of(keyed));
        Assert.True((await Run("test_connection", connection: keyed))["ok"]!.GetValue<bool>());

        // Moved to another address, the agent will not send the token there at all.
        var moved = (JsonObject)keyed.DeepClone();
        moved["baseUrl"] = $"http://127.0.0.1:{api.Port}/elsewhere";
        e = await Assert.ThrowsAsync<JobFailedException>(() => Run("test_connection", connection: moved));
        Assert.Equal("auth", e.Kind);
    }

    [Fact]
    public async Task Tries_a_busy_api_again_and_says_what_went_wrong_otherwise()
    {
        Assert.True((await Run("preview", new JsonObject { ["path"] = "/busy" }))["rows"]!.AsArray().Count == 1);
        Assert.Equal(2, api.Hits("/api/busy"));

        var e = await Assert.ThrowsAsync<JobFailedException>(() => Run("preview", new JsonObject { ["path"] = "/notjson" }));
        Assert.Equal("The API's answer at /api/notjson is not JSON", e.Message);
        e = await Assert.ThrowsAsync<JobFailedException>(() => Run("preview", new JsonObject { ["path"] = "/v1/machines", ["recordsPath"] = "items" }));
        Assert.Equal("The answer has no list of records at \"items\"", e.Message);
        e = await Assert.ThrowsAsync<JobFailedException>(() => Run("preview", new JsonObject { ["path"] = "/missing" }));
        Assert.Equal("The API answered 404 at /api/missing", e.Message);
        e = await Assert.ThrowsAsync<JobFailedException>(() => Run("discover"));
        Assert.Contains("not browsed", e.Message);
        e = await Assert.ThrowsAsync<JobFailedException>(() => Run("preview", new JsonObject { ["path"] = "/../admin" }));
        Assert.Equal("invalid", e.Kind);
    }

    /// <summary>A small API on 127.0.0.1: machines paged by page number with an updatedAt field, a cursor list, an OData-style next link and a few failures.</summary>
    private sealed class FakeApi : IDisposable
    {
        private readonly HttpListener listener = new();
        private readonly Dictionary<string, List<string>> hits = [];
        private int busy;
        public int Port { get; }

        public FakeApi()
        {
            var probe = new TcpListener(IPAddress.Loopback, 0);
            probe.Start();
            Port = ((IPEndPoint)probe.LocalEndpoint).Port;
            probe.Stop();
            listener.Prefixes.Add($"http://127.0.0.1:{Port}/");
            listener.Start();
            _ = Task.Run(Loop);
        }

        public int Hits(string path) { lock (hits) return hits.TryGetValue(path, out var l) ? l.Count : 0; }
        public List<string> Queries(string path) { lock (hits) return hits.TryGetValue(path, out var l) ? [.. l] : []; }
        public void Reset() { lock (hits) hits.Clear(); }

        private async Task Loop()
        {
            while (listener.IsListening)
            {
                HttpListenerContext ctx;
                try { ctx = await listener.GetContextAsync(); } catch { return; }
                try { Answer(ctx); } catch { ctx.Response.StatusCode = 500; ctx.Response.Close(); }
            }
        }

        private static readonly List<(string Code, string Updated)> Data = Enumerable.Range(1, 250)
            .Select(i => ($"M{i:000}", new DateTime(2026, 11, 16, 0, 0, 0, DateTimeKind.Utc).AddMinutes(i).ToString("yyyy-MM-ddTHH:mm:ssZ"))).ToList();

        private void Answer(HttpListenerContext ctx)
        {
            var path = ctx.Request.Url!.AbsolutePath;
            var q = ctx.Request.QueryString;
            lock (hits) { if (!hits.TryGetValue(path, out var l)) hits[path] = l = []; l.Add(ctx.Request.Url.Query); }
            void Send(int status, string body, string type = "application/json")
            {
                var bytes = Encoding.UTF8.GetBytes(body);
                ctx.Response.StatusCode = status;
                ctx.Response.ContentType = type;
                ctx.Response.OutputStream.Write(bytes);
                ctx.Response.Close();
            }
            string Rec(int i) => $"{{\"code\":\"{Data[i].Code}\",\"name\":\"Machine {i + 1}\",\"site\":{{\"code\":\"NCL\"}},\"updatedAt\":\"{Data[i].Updated}\"}}";
            switch (path)
            {
                case "/api/health": Send(200, "{\"ok\":true}"); return;
                case "/api/secure": Send(ctx.Request.Headers["Authorization"] == "Bearer s3cret-token" ? 200 : 401, "{}"); return;
                case "/api/keyed": Send(ctx.Request.Headers["X-Api-Key"] == "s3cret-token" ? 200 : 401, "{}"); return;
                case "/api/redirect":
                    ctx.Response.StatusCode = 302;
                    ctx.Response.RedirectLocation = $"http://127.0.0.1:{Port}/elsewhere";
                    ctx.Response.Close();
                    return;
                case "/api/busy":
                    if (Interlocked.Increment(ref busy) == 1) { ctx.Response.AddHeader("Retry-After", "0"); Send(503, "{}"); return; }
                    Send(200, "[{\"code\":\"B1\"}]");
                    return;
                case "/api/notjson": Send(200, "<html>", "text/html"); return;
                case "/api/v1/machines":
                {
                    var page = int.Parse(q["page"] ?? "1");
                    var size = int.Parse(q["per_page"] ?? "100");
                    var since = q["since"];
                    var all = Enumerable.Range(0, Data.Count).Where(i => since is null || string.CompareOrdinal(Data[i].Updated, since) >= 0).ToList();
                    var items = all.Skip((page - 1) * size).Take(size).Select(Rec);
                    Send(200, $"{{\"data\":[{string.Join(',', items)}],\"total\":{all.Count}}}");
                    return;
                }
                case "/api/v1/cursor":
                {
                    var after = q["after"];
                    var (items, next) = after switch { null => ("0,1", "c1"), "c1" => ("2,3", "c2"), _ => ("4,5", "") };
                    var recs = items.Split(',').Select(i => Rec(int.Parse(i)));
                    Send(200, $"{{\"data\":[{string.Join(',', recs)}],\"meta\":{{\"next\":\"{next}\"}}}}");
                    return;
                }
                case "/api/v1/link":
                {
                    var skip = int.Parse(q["skip"] ?? "0");
                    var recs = Enumerable.Range(skip, 2).Select(Rec);
                    var link = skip == 0 ? $",\"@odata.nextLink\":\"/api/v1/link?skip=2\"" : "";
                    Send(200, $"{{\"value\":[{string.Join(',', recs)}]{link}}}");
                    return;
                }
                case "/api/v1/link-away":
                    Send(200, $"{{\"value\":[{Rec(0)}],\"@odata.nextLink\":\"http://other.example:{Port}/api/v1/link\"}}");
                    return;
                default: Send(404, "{}"); return;
            }
        }

        public void Dispose()
        {
            listener.Stop();
            listener.Close();
        }
    }
}
