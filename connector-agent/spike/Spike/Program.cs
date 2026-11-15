// AG0 spike (docs/connector-agent-plan.md §13): proves on .NET 10 what the agent needs, against the Node side in ../verify.mjs.
//   dotnet run -- keys <dir>    make the agent's signing key (ECDSA P-256) and sealing key (ECDH P-256); public halves to <dir>/agent-public.json
//   dotnet run -- run <dir>     sign a request, open the credential sealed by verify.mjs, gzip a 1,000-row batch; results to <dir>/agent-out.json
// Spike only: private keys are written to <dir> in plain so the two halves can run separately. The agent keeps them in DPAPI.
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

var mode = args.ElementAtOrDefault(0);
var dir = args.ElementAtOrDefault(1) ?? ".";
Directory.CreateDirectory(dir);

if (mode == "keys")
{
    using var sign = ECDsa.Create(ECCurve.NamedCurves.nistP256);
    using var seal = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
    File.WriteAllText(Path.Combine(dir, "agent-private.json"), JsonSerializer.Serialize(new
    {
        sign = Convert.ToBase64String(sign.ExportPkcs8PrivateKey()),
        seal = Convert.ToBase64String(seal.ExportPkcs8PrivateKey()),
    }));
    File.WriteAllText(Path.Combine(dir, "agent-public.json"), JsonSerializer.Serialize(new
    {
        signingKey = Convert.ToBase64String(sign.ExportSubjectPublicKeyInfo()),
        sealingKey = Convert.ToBase64String(seal.ExportSubjectPublicKeyInfo()),
        ed25519InBcl = Type.GetType("System.Security.Cryptography.Ed25519, System.Security.Cryptography") != null,
        runtime = Environment.Version.ToString(),
    }));
    Console.WriteLine("keys written");
    return;
}

if (mode == "pg")
{
    await using var db = Npgsql.NpgsqlDataSource.Create(args[1]);
    var cols = await PgSpike.Columns(db, "erp", "work orders");
    var spec = new ExtractSpec("erp", "work orders", ["order no", "qty", "due", "on hold", "notes"], "id", "modified at", null, 1000);
    var all = new List<Dictionary<string, object?>>();
    await foreach (var row in PgSpike.Extract(db, spec)) all.Add(row);
    var since = new ExtractSpec("erp", "work orders", ["order no"], "id", "modified at", "2026-04-01T00:00:00Z", 1000);
    var changed = 0; await foreach (var _ in PgSpike.Extract(db, since)) changed++;
    string refused = "";
    try { await foreach (var _ in PgSpike.Extract(db, spec with { Columns = ["order no\" from pg_shadow --"] })) { } } catch (InvalidOperationException e) { refused = e.Message; }
    string writeRefused = "";
    try { await using var c = await db.OpenConnectionAsync(); await using var t = await c.BeginTransactionAsync(); await using (var ro = new Npgsql.NpgsqlCommand("set transaction read only", c, t)) await ro.ExecuteNonQueryAsync(); await using var w = new Npgsql.NpgsqlCommand("delete from erp.\"work orders\"", c, t); await w.ExecuteNonQueryAsync(); } catch (Npgsql.PostgresException e) { writeRefused = e.SqlState; }
    Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new { columns = cols, rows = all.Count, first = all[0], changedSince = changed, injectionRefused = refused, writeInReadOnlyRefused = writeRefused }));
    return;
}

if (mode != "run") { Console.Error.WriteLine("usage: keys <dir> | run <dir>"); Environment.Exit(2); }

var priv = JsonDocument.Parse(File.ReadAllText(Path.Combine(dir, "agent-private.json"))).RootElement;

// 1. A signed request. The canonical string binds method, path, body, time, nonce and agent, so nothing can be replayed or moved.
using var signer = ECDsa.Create();
signer.ImportPkcs8PrivateKey(Convert.FromBase64String(priv.GetProperty("sign").GetString()!), out _);
var agentId = "7b0c5a3e-9d4f-4f1e-9a63-2a5e5a1d1c01";
var body = Encoding.UTF8.GetBytes("{\"version\":\"0.1.0\",\"os\":\"Windows Server 2022\"}");
var timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString();
var nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
var canonical = string.Join('\n', "FORTRESS-AGENT-V1", "POST", "/api/v1/integrations/agent/heartbeat",
    Convert.ToHexString(SHA256.HashData(body)).ToLowerInvariant(), timestamp, nonce, agentId);
var signature = signer.SignData(Encoding.UTF8.GetBytes(canonical), HashAlgorithmName.SHA256); // IEEE P1363 (r||s), 64 bytes

// 2. Open the credential the browser sealed to the agent's sealing key (ECDH P-256 → HKDF-SHA256 → AES-256-GCM, the connection id as AAD).
string? opened = null;
var sealedPath = Path.Combine(dir, "sealed.json");
if (File.Exists(sealedPath))
{
    var s = JsonDocument.Parse(File.ReadAllText(sealedPath)).RootElement;
    using var mine = ECDiffieHellman.Create();
    mine.ImportPkcs8PrivateKey(Convert.FromBase64String(priv.GetProperty("seal").GetString()!), out _);
    using var theirs = ECDiffieHellman.Create();
    theirs.ImportSubjectPublicKeyInfo(Convert.FromBase64String(s.GetProperty("epk").GetString()!), out _);
    var shared = mine.DeriveRawSecretAgreement(theirs.PublicKey);
    var key = HKDF.DeriveKey(HashAlgorithmName.SHA256, shared, 32, Array.Empty<byte>(), Encoding.UTF8.GetBytes("fortress-agent-credential-v1"));
    var iv = Convert.FromBase64String(s.GetProperty("iv").GetString()!);
    var ct = Convert.FromBase64String(s.GetProperty("ct").GetString()!); // WebCrypto appends the 16-byte tag
    var aad = Encoding.UTF8.GetBytes(s.GetProperty("connectionId").GetString()!);
    var plain = new byte[ct.Length - 16];
    using var gcm = new AesGcm(key, 16);
    gcm.Decrypt(iv, ct.AsSpan(0, ct.Length - 16), ct.AsSpan(ct.Length - 16), plain, aad);
    opened = Encoding.UTF8.GetString(plain);
}

// 3. A batch of 1,000 typed rows (20 columns, ERP-like values), gzipped.
var rnd = new Random(42);
var rows = Enumerable.Range(1, 1000).Select(i => new Dictionary<string, object?>
{
    ["ORDER_NO"] = $"WO-{100000 + i}", ["LINE"] = i % 7 + 1, ["PART_NO"] = $"P-{rnd.Next(10000, 99999)}", ["REV"] = "C",
    ["DESCRIPTION"] = $"Machined housing, anodised, batch {rnd.Next(1, 500)}", ["QTY_ORDERED"] = rnd.Next(1, 5000),
    ["QTY_DONE"] = rnd.Next(0, 5000), ["UNIT"] = "EA", ["UNIT_COST"] = Math.Round(rnd.NextDouble() * 400, 4),
    ["DUE_DATE"] = new DateOnly(2026, 1, 1).AddDays(rnd.Next(0, 365)).ToString("yyyy-MM-dd"),
    ["MODIFIED_AT"] = DateTime.UtcNow.AddMinutes(-rnd.Next(0, 100000)).ToString("o"), ["STATUS"] = rnd.Next(0, 4) switch { 0 => "PLANNED", 1 => "RELEASED", 2 => "IN_PROGRESS", _ => "COMPLETE" },
    ["CUSTOMER"] = $"CUST-{rnd.Next(100, 999)}", ["SITE"] = "NCL", ["WORK_CENTRE"] = $"WC{rnd.Next(10, 60)}", ["PRIORITY"] = rnd.Next(1, 5),
    ["ON_HOLD"] = rnd.Next(0, 10) == 0, ["NOTES"] = rnd.Next(0, 3) == 0 ? null : "Customer drawing rev C applies; deburr all edges.",
    ["WEIGHT_KG"] = Math.Round(rnd.NextDouble() * 20, 3), ["LOT"] = $"L{rnd.Next(100000, 999999)}",
}).ToList();
var batchJson = JsonSerializer.SerializeToUtf8Bytes(new { jobId = "job-1", seq = 1, rows });
using var gz = new MemoryStream();
using (var z = new GZipStream(gz, CompressionLevel.Optimal, leaveOpen: true)) z.Write(batchJson);
File.WriteAllBytes(Path.Combine(dir, "batch-1.json.gz"), gz.ToArray());

File.WriteAllText(Path.Combine(dir, "agent-out.json"), JsonSerializer.Serialize(new
{
    agentId, timestamp, nonce, canonical, body = Encoding.UTF8.GetString(body), signature = Convert.ToBase64String(signature),
    opened, batch = new { rows = rows.Count, rawBytes = batchJson.Length, gzipBytes = gz.Length, sha256 = Convert.ToHexString(SHA256.HashData(gz.ToArray())).ToLowerInvariant() },
    drivers = new
    {
        sqlClient = typeof(Microsoft.Data.SqlClient.SqlConnection).Assembly.GetName().Version?.ToString(),
        npgsql = typeof(Npgsql.NpgsqlConnection).Assembly.GetName().Version?.ToString(),
        mysql = typeof(MySqlConnector.MySqlConnection).Assembly.GetName().Version?.ToString(),
        sqlServerBuilder = new Microsoft.Data.SqlClient.SqlConnectionStringBuilder { DataSource = @"ERP01\SQLEXPRESS", InitialCatalog = "ERP", IntegratedSecurity = true, Encrypt = Microsoft.Data.SqlClient.SqlConnectionEncryptOption.Mandatory, ApplicationIntent = Microsoft.Data.SqlClient.ApplicationIntent.ReadOnly }.ConnectionString,
    },
}, new JsonSerializerOptions { WriteIndented = true }));
Console.WriteLine("run done");
