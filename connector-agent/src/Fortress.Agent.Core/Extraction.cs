using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Fortress.Agent.Core;

/// <summary>
/// Read a table or view for an import (AG3) and send it to Fortress in batches. The request names only the schema, the table, the column that
/// identifies each row, which columns (or all) and simple filters; everything is checked against what the database itself lists, and the agent
/// builds the one read-only SELECT. Rows are read in key order, a page at a time ("rows after the last key sent"), so a job taken again after a
/// restart carries on where Fortress's batches end — Fortress tells it the next batch number and the last key it holds.
/// </summary>
public sealed class ExtractHandler(DatabaseJobContext databases) : IJobHandler
{
    public string Kind => "extract";

    public const int MaxBatchRows = 1000;
    /// <summary>Under the API's 1 MB body limit, with room for the signature headers.</summary>
    public const int MaxGzipBytes = 900_000;
    /// <summary>Fortress refuses a batch that inflates past 8 MB; split well before.</summary>
    public const int MaxJsonBytes = 7_000_000;

    public async Task<JsonNode?> RunAsync(AgentJob job, JobContext context, CancellationToken ct)
    {
        if (FolderJobs.IsFolder(job)) return await FolderJobs.ExtractAsync(job, databases.AllowListPath, context, ct);
        var request = DatabaseJobContext.Request(job);
        string Name(string key, string what) => request[key] is JsonValue v && v.TryGetValue<string>(out var s) && s.Length > 0 ? s : throw new JobFailedException("invalid", $"The job does not say {what}");
        var schema = Name("schema", "which schema");
        var name = Name("object", "which table or view");
        var keyName = Name("keyColumn", "which column identifies each row");
        var batchRows = Math.Clamp(request["batchRows"] is JsonValue b && b.TryGetValue<int>(out var br) ? br : MaxBatchRows, 1, MaxBatchRows);
        long? maxRows = request["maxRows"] is JsonValue m && m.TryGetValue<long>(out var mr) ? mr : null;
        string? Opt(string key) => request[key] is JsonValue v && v.TryGetValue<string>(out var s) && s.Length > 0 ? s : null;
        var changedName = Opt("changedColumn");
        var changedSince = Opt("changedSince");

        var (db, _, allow) = await databases.OpenAsync(job, ct);
        await using (db)
        {
            if (!allow.AllowsObject(schema, name)) throw DiscoverHandler.NotAllowed($"{schema}.{name}");
            var shape = await db.ColumnsAsync(schema, name, ct) ?? throw DiscoverHandler.NotFound(schema, name);
            if (shape.Columns.Count == 0) throw new JobFailedException("refused", $"This sign-in cannot read any column of {schema}.{name}");
            DbColumn Column(string col, string role) => shape.Columns.FirstOrDefault(c => c.Name == col)
                ?? throw new JobFailedException("not_found", $"The {role} {col} is not in {schema}.{name}, or this sign-in cannot read it");

            var key = Column(keyName, "column that identifies each row,");
            var columns = request["columns"] is JsonArray list
                ? list.Select(x => Column(x?.GetValue<string>() ?? "", "column")).ToList()
                : shape.Columns.ToList();
            if (!columns.Any(c => c.Name == key.Name)) columns.Insert(0, key);
            // Incremental reads (AG4): rows changed at or after the mark of the last finished import; the highest changed value read is reported back.
            var changed = changedName is null ? null : Column(changedName, "column that shows when a row changed,");
            if (changed is not null && !columns.Any(c => c.Name == changed.Name)) columns.Add(changed);
            var filters = new List<ExtractFilter>();
            if (request["filters"] is JsonArray fs)
            {
                foreach (var f in fs.OfType<JsonObject>())
                {
                    var op = f["op"]?.GetValue<string>() ?? "";
                    if (!ExtractFilter.Ops.Contains(op)) throw new JobFailedException("invalid", $"A filter cannot test \"{op}\"");
                    var value = ExtractFilter.NoValue.Contains(op) ? null : f["value"] switch
                    {
                        JsonValue v when v.TryGetValue<string>(out var s) => s,
                        JsonValue v when v.TryGetValue<bool>(out var flag) => flag ? "true" : "false",
                        JsonValue v => v.ToJsonString(),
                        _ => throw new JobFailedException("invalid", "A filter needs its value"),
                    };
                    filters.Add(new ExtractFilter(Column(f["column"]?.GetValue<string>() ?? "", "filter column"), op, value));
                }
            }

            if (changed is not null && changedSince is not null) filters.Add(new ExtractFilter(changed, "gte", changedSince));

            var seq = job.Resume?.NextSeq ?? 0;
            var mark = job.Resume?.ChangedUpTo ?? (changed is null ? null : changedSince);
            var afterKey = job.Resume?.AfterKey;
            var total = job.Resume?.Rows ?? 0;
            var truncated = false;
            while (true)
            {
                ct.ThrowIfCancellationRequested();
                var limit = batchRows;
                if (maxRows is { } max)
                {
                    if (total >= max) { truncated = true; break; }
                    limit = (int)Math.Min(limit, max - total);
                }
                var page = await db.ExtractPageAsync(new ExtractQuery(shape, columns, key, filters, afterKey, limit), ct);
                if (page.Count == 0) break;
                foreach (var part in Split(page, columns))
                {
                    if (changed is not null)
                        foreach (var row in part.Rows)
                            if (row.Values.TryGetValue(changed.Name, out var v) && v is not null && v is not DBNull) mark = DbValues.HigherMark(mark, v);
                    var receipt = await context.SendBatchAsync(part.Batch(seq, changed is null ? null : mark), ct);
                    if (receipt.Cancelled) { ct.ThrowIfCancellationRequested(); throw new OperationCanceledException("The job was cancelled in Fortress"); }
                    seq++;
                    total += part.Rows.Count;
                    afterKey = part.Rows[^1].KeyText;
                }
                if (page.Count < limit) break;
            }
            return new JsonObject
            {
                ["batches"] = seq,
                ["rows"] = total,
                ["columns"] = new JsonArray(columns.Select(c => (JsonNode)new JsonObject { ["name"] = c.Name, ["type"] = c.DataType }).ToArray()),
                ["truncated"] = truncated,
                ["changedUpTo"] = changed is null ? null : mark,
            };
        }
    }

    /// <summary>A page as one batch, or halves of it while a batch would be too big to send.</summary>
    internal static IEnumerable<BatchPart> Split(IReadOnlyList<ExtractedRow> rows, IReadOnlyList<DbColumn> columns)
    {
        var part = new BatchPart(rows, columns);
        if (rows.Count > 1 && part.TooBig)
        {
            var half = rows.Count / 2;
            foreach (var p in Split(rows.Take(half).ToList(), columns)) yield return p;
            foreach (var p in Split(rows.Skip(half).ToList(), columns)) yield return p;
            yield break;
        }
        if (part.TooBig) throw new JobFailedException("refused", "One row is too large to send to Fortress (over 900 kB compressed). Read fewer or shorter columns.");
        yield return part;
    }

    internal sealed class BatchPart
    {
        private readonly IReadOnlyList<DbColumn> columns;

        public BatchPart(IReadOnlyList<ExtractedRow> rows, IReadOnlyList<DbColumn> columns)
        {
            Rows = rows;
            this.columns = columns;
        }

        public IReadOnlyList<ExtractedRow> Rows { get; }

        /// <summary>Measured without the sequence number, which only adds a few bytes.</summary>
        public bool TooBig
        {
            get
            {
                var bytes = Json(0);
                return bytes.Length > MaxJsonBytes || Compress(bytes).Length > MaxGzipBytes;
            }
        }

        public RowBatch Batch(int seq, string? changedUpTo = null)
        {
            var json = Json(seq, changedUpTo);
            return new RowBatch(seq, Rows.Count, Compress(json), Convert.ToHexStringLower(SHA256.HashData(json)));
        }

        private byte[] Json(int seq, string? changedUpTo = null)
        {
            var array = new JsonArray();
            foreach (var row in Rows)
            {
                var o = new JsonObject();
                foreach (var c in columns) o[c.Name] = DbValues.ToJson(row.Values.TryGetValue(c.Name, out var v) ? v : null, DbValues.MaxExtractText);
                array.Add(o);
            }
            var body = new JsonObject { ["seq"] = seq, ["lastKey"] = Rows.Count > 0 ? Rows[^1].KeyText : null, ["rows"] = array };
            if (changedUpTo is not null) body["changedUpTo"] = changedUpTo;
            return JsonSerializer.SerializeToUtf8Bytes(body);
        }

        internal static byte[] Compress(byte[] bytes)
        {
            using var output = new MemoryStream();
            using (var gz = new GZipStream(output, CompressionLevel.Optimal, leaveOpen: true)) gz.Write(bytes);
            return output.ToArray();
        }
    }
}
