using System.Buffers;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Fortress.Agent.Core;

/// <summary>
/// An internal REST API read through this agent (AG5c): its address as this machine reaches it (http or https, any port, a private address is fine —
/// that is why the agent reads it), how it signs in, and an optional path to test. The database checks the same rules in
/// app.integration_agent_rest_config_problem; they are checked again here so a setting can only ever choose a path on the connection's own address.
/// </summary>
public sealed partial record RestSettings(Uri BaseUri, string AuthType, string? ApiKeyHeader, int TimeoutSeconds, string? TestPath)
{
    [GeneratedRegex(@"^https?://([A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]{2,45}\])(:[0-9]{1,5})?(/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$")]
    private static partial Regex UrlPattern();
    [GeneratedRegex(@"^[A-Za-z0-9-]{1,60}$")]
    private static partial Regex HeaderPattern();

    public static readonly IReadOnlySet<string> ForbiddenHeaders = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "host", "connection", "content-length", "transfer-encoding", "te", "upgrade", "keep-alive", "expect", "cookie", "proxy-authorization",
        "proxy-connection", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "authorization",
    };

    public bool NeedsSecret => AuthType is "api_key" or "bearer" or "basic";

    public static bool IsRest(AgentJob job) => job.Spec?["connection"]?["engine"]?.GetValue<string>() == "rest";

    public static RestSettings Parse(JsonObject? c)
    {
        if (c is null) throw Invalid("The job did not say which API to use");
        string? Opt(string key) => c[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
        var url = Opt("baseUrl") ?? throw Invalid("The connection's address is missing");
        if (url.Length > 300 || !UrlPattern().IsMatch(url) || url.Contains('@') || Regex.IsMatch(url, @"://[^/]+/.*//") || Regex.IsMatch(url, @"/\.{1,2}(/|$)")
            || url.Contains("%2e", StringComparison.OrdinalIgnoreCase))
            throw Invalid("The API's address is not valid");
        var uri = new Uri(url, UriKind.Absolute);
        if (uri.Scheme is not ("http" or "https") || !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment))
            throw Invalid("The API's address is not valid");
        var auth = Opt("authType") ?? "none";
        if (auth is not ("none" or "api_key" or "bearer" or "basic")) throw Invalid("The API signs in with nothing, an API key, a bearer token or a user name and password");
        var header = Opt("apiKeyHeader");
        if (auth == "api_key" && (header is null || !HeaderPattern().IsMatch(header) || ForbiddenHeaders.Contains(header))) throw Invalid("The API key's header is not valid");
        var timeout = Math.Clamp(c["timeoutSeconds"] is JsonValue t && t.TryGetValue<int>(out var n) ? n : 30, 1, 120);
        var test = Opt("testPath");
        if (test is not null && !RestEndpoint.PathOk(test)) throw Invalid("The test path is not valid");
        return new RestSettings(uri, auth, auth == "api_key" ? header : null, timeout, test);
    }

    /// <summary>The address joined with a path below it ("http://erp:8080/api" + "/v1/parts"). Never leaves the address's scheme, host and port.</summary>
    public Uri Join(string? path)
    {
        var basePath = BaseUri.AbsolutePath.TrimEnd('/');
        var b = new UriBuilder(BaseUri) { Path = basePath + (path ?? ""), Query = "", Fragment = "" };
        var u = b.Uri;
        if (!SameOrigin(u)) throw new JobFailedException("refused", "The path left the connection's address");
        return u;
    }

    public bool SameOrigin(Uri u) =>
        string.Equals(u.Scheme, BaseUri.Scheme, StringComparison.OrdinalIgnoreCase) && string.Equals(u.IdnHost, BaseUri.IdnHost, StringComparison.OrdinalIgnoreCase) && u.Port == BaseUri.Port;

    private static JobFailedException Invalid(string message) => new("invalid", message);
}

public sealed record RestPaging(string Style, int PageSize, string? PageParam, string? SizeParam, int? FirstPage, string? OffsetParam, string? LimitParam,
    string? CursorParam, string? NextCursorPath, string? NextLinkPath);

/// <summary>An endpoint of the API: where the records are, how it pages, and how to ask for only what changed. Never SQL, never another address.</summary>
public sealed partial record RestEndpoint(string Path, string? RecordsPath, IReadOnlyList<KeyValuePair<string, string>> Query, RestPaging Paging,
    string? KeyColumn, string? ChangedColumn, string? ChangedParam)
{
    [GeneratedRegex(@"^/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$")]
    private static partial Regex PathPattern();
    [GeneratedRegex(@"^[A-Za-z0-9_$@-]{1,60}(\.[A-Za-z0-9_$@-]{1,60}){0,9}$")]
    private static partial Regex JsonPathPattern();
    [GeneratedRegex(@"^[][A-Za-z0-9_.-]{1,60}$")]
    private static partial Regex ParamPattern();

    public static bool PathOk(string p) =>
        p.Length <= 300 && PathPattern().IsMatch(p) && !p.Contains("//") && !p.Contains("%2e", StringComparison.OrdinalIgnoreCase) && !Regex.IsMatch(p, @"/\.{1,2}(/|$)");

    public static RestEndpoint Parse(JsonObject r)
    {
        string? Opt(JsonObject o, string key) => o[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
        int? Num(JsonObject o, string key) => o[key] is JsonValue v && v.TryGetValue<int>(out var n) ? n : null;
        string Param(string? p, string what) => p is null || ParamPattern().IsMatch(p) ? p! : throw Invalid($"The {what} parameter is not valid");
        var path = Opt(r, "path") ?? throw Invalid("The job does not say which path to read");
        if (!PathOk(path)) throw Invalid("The path is not valid: it starts with / and stays below the address");
        var records = Opt(r, "recordsPath");
        if (records is not null && !JsonPathPattern().IsMatch(records)) throw Invalid("Where the records are in the answer is not valid");
        var query = new List<KeyValuePair<string, string>>();
        if (r["query"] is JsonObject q)
        {
            foreach (var (k, v) in q)
            {
                if (!ParamPattern().IsMatch(k) || v is not JsonValue jv || !jv.TryGetValue<string>(out var s) || s.Length > 200) throw Invalid("A query parameter is not valid");
                query.Add(new(k, s));
            }
            if (query.Count > 20) throw Invalid("At most 20 query parameters");
        }
        var pg = r["paging"] as JsonObject ?? [];
        var style = Opt(pg, "style") ?? "none";
        if (style is not ("none" or "page" or "offset" or "cursor" or "next_link")) throw Invalid("The paging style is not valid");
        var nextCursor = Opt(pg, "nextCursorPath");
        var nextLink = Opt(pg, "nextLinkPath");
        if (nextCursor is not null && !JsonPathPattern().IsMatch(nextCursor)) throw Invalid("Where the next cursor is in the answer is not valid");
        if (nextLink is not null && nextLink != "header" && !JsonPathPattern().IsMatch(nextLink)) throw Invalid("Where the next page's link is is not valid");
        if (style == "cursor" && nextCursor is null) throw Invalid("Say where the answer gives the next cursor");
        if (style == "next_link" && nextLink is null) throw Invalid("Say where the answer gives the next page's link");
        var paging = new RestPaging(style, Math.Clamp(Num(pg, "pageSize") ?? 100, 1, 1000), Param(Opt(pg, "pageParam"), "page"), Param(Opt(pg, "sizeParam"), "page size"),
            Num(pg, "firstPage") is 0 ? 0 : Num(pg, "firstPage") is 1 ? 1 : null, Param(Opt(pg, "offsetParam"), "offset"), Param(Opt(pg, "limitParam"), "limit"),
            Param(Opt(pg, "cursorParam"), "cursor"), nextCursor, nextLink);
        var changedParam = Opt(r, "changedParam");
        if (changedParam is not null) Param(changedParam, "changed-since");
        return new RestEndpoint(path, records, query, paging, Opt(r, "keyColumn"), Opt(r, "changedColumn"), changedParam);
    }

    private static JobFailedException Invalid(string message) => new("invalid", message);
}

/// <summary>
/// A JSON answer read the way the cloud REST connector (a JavaScript program) reads it, so a record flattens to exactly the same columns and text
/// whichever side reads the API: object keys in JavaScript's order (integer-like keys first, ascending, then the rest as written; a repeated key
/// keeps its first place and its last value), numbers as JavaScript prints them, nested values as JSON.stringify writes them. The expected output
/// is pinned by connector-agent/contract/rest-flatten.json, which both this code and the API's tests check.
/// </summary>
public abstract record JsNode
{
    public sealed record Obj(IReadOnlyList<KeyValuePair<string, JsNode>> Members) : JsNode;
    public sealed record Arr(IReadOnlyList<JsNode> Items) : JsNode;
    public sealed record Str(string Value) : JsNode;
    public sealed record Num(double Value) : JsNode;
    public sealed record Bool(bool Value) : JsNode;
    public sealed record Null : JsNode
    {
        public static readonly Null Instance = new();
    }

    public static JsNode Parse(ReadOnlySpan<byte> utf8)
    {
        var reader = new Utf8JsonReader(utf8, new JsonReaderOptions { MaxDepth = 256 });
        if (!reader.Read()) throw new JsonException("The answer is empty");
        var node = Read(ref reader);
        if (reader.Read()) throw new JsonException("The answer holds more than one value");
        return node;
    }

    public static JsNode Parse(string json) => Parse(Encoding.UTF8.GetBytes(json));

    private static JsNode Read(ref Utf8JsonReader reader)
    {
        switch (reader.TokenType)
        {
            case JsonTokenType.StartObject:
            {
                var order = new List<string>();
                var values = new Dictionary<string, JsNode>(StringComparer.Ordinal);
                while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
                {
                    var name = Text(ref reader);
                    reader.Read();
                    var value = Read(ref reader);
                    if (!values.ContainsKey(name)) order.Add(name);
                    values[name] = value;
                }
                var indices = order.Where(IsArrayIndex).OrderBy(k => uint.Parse(k, CultureInfo.InvariantCulture)).ToList();
                return new Obj(indices.Concat(order.Where(k => !IsArrayIndex(k))).Select(k => new KeyValuePair<string, JsNode>(k, values[k])).ToArray());
            }
            case JsonTokenType.StartArray:
            {
                var items = new List<JsNode>();
                while (reader.Read() && reader.TokenType != JsonTokenType.EndArray) items.Add(Read(ref reader));
                return new Arr(items);
            }
            case JsonTokenType.String: return new Str(Text(ref reader));
            case JsonTokenType.Number:
                return new Num(double.Parse(Encoding.UTF8.GetString(reader.HasValueSequence ? reader.ValueSequence.ToArray() : reader.ValueSpan), NumberStyles.Float, CultureInfo.InvariantCulture));
            case JsonTokenType.True: return new Bool(true);
            case JsonTokenType.False: return new Bool(false);
            default: return Null.Instance;
        }
    }

    /// <summary>A string or property name as JavaScript reads it: escapes undone one code unit at a time, so a lone surrogate (\ud800) is kept, not refused.</summary>
    private static string Text(ref Utf8JsonReader reader)
    {
        var raw = reader.HasValueSequence ? reader.ValueSequence.ToArray() : reader.ValueSpan.ToArray();
        if (!reader.ValueIsEscaped) return Encoding.UTF8.GetString(raw);
        var s = Encoding.UTF8.GetString(raw);
        var sb = new StringBuilder(s.Length);
        for (var i = 0; i < s.Length; i++)
        {
            var c = s[i];
            if (c != '\\' || i + 1 >= s.Length) { sb.Append(c); continue; }
            var e = s[++i];
            switch (e)
            {
                case 'b': sb.Append('\b'); break;
                case 'f': sb.Append('\f'); break;
                case 'n': sb.Append('\n'); break;
                case 'r': sb.Append('\r'); break;
                case 't': sb.Append('\t'); break;
                case 'u': sb.Append((char)Convert.ToUInt16(s.Substring(i + 1, 4), 16)); i += 4; break;
                default: sb.Append(e); break;   // " \ /
            }
        }
        return sb.ToString();
    }

    /// <summary>A key JavaScript keeps first: the canonical text of a whole number from 0 to 2^32 − 2.</summary>
    private static bool IsArrayIndex(string k) =>
        k.Length is > 0 and <= 10 && k.All(char.IsAsciiDigit) && (k == "0" || k[0] != '0') && ulong.Parse(k, CultureInfo.InvariantCulture) < uint.MaxValue;

    /// <summary>Own-key walk of a dotted path; a key that itself holds dots ("@odata.nextLink") is found too, the longest run first.</summary>
    public static JsNode? AtPath(JsNode value, string? path)
    {
        if (string.IsNullOrEmpty(path)) return value;
        var keys = path.Split('.');
        var v = value;
        var i = 0;
        while (i < keys.Length)
        {
            if (v is not Obj o) return null;
            var j = keys.Length;
            JsNode? found = null;
            for (; j > i; j--)
            {
                var k = string.Join('.', keys[i..j]);
                var m = o.Members.FirstOrDefault(x => x.Key == k);
                if (m.Key is not null) { found = m.Value; break; }
            }
            if (found is null) return null;
            v = found;
            i = j;
        }
        return v;
    }

    /// <summary>String(n) in JavaScript: the shortest digits that read back as the same number, in JavaScript's layout (ECMA-262 Number::toString).</summary>
    public static string NumberText(double d)
    {
        if (double.IsNaN(d)) return "NaN";
        if (double.IsInfinity(d)) return d > 0 ? "Infinity" : "-Infinity";
        if (d == 0) return "0";
        var sign = d < 0 ? "-" : "";
        // the shortest digits that read back as the same number
        var shortest = Math.Abs(d).ToString("R", CultureInfo.InvariantCulture);
        string digits;
        int exp10;
        var eAt = shortest.IndexOfAny(['E', 'e']);
        var mantissa = eAt >= 0 ? shortest[..eAt] : shortest;
        var e = eAt >= 0 ? int.Parse(shortest[(eAt + 1)..], CultureInfo.InvariantCulture) : 0;
        var dot = mantissa.IndexOf('.');
        var intPart = dot >= 0 ? mantissa[..dot] : mantissa;
        var fracPart = dot >= 0 ? mantissa[(dot + 1)..] : "";
        digits = intPart + fracPart;
        var n = intPart.Length + e;              // the number is 0.digits × 10^n
        var lead = digits.Length - digits.TrimStart('0').Length;
        digits = digits.TrimStart('0');
        n -= lead;
        digits = digits.TrimEnd('0');
        if (digits.Length == 0) return "0";
        exp10 = n;
        var k = digits.Length;
        string body;
        if (k <= exp10 && exp10 <= 21) body = digits + new string('0', exp10 - k);
        else if (0 < exp10 && exp10 <= 21) body = digits[..exp10] + "." + digits[exp10..];
        else if (-6 < exp10 && exp10 <= 0) body = "0." + new string('0', -exp10) + digits;
        else
        {
            var ex = exp10 - 1;
            var es = (ex < 0 ? "-" : "+") + Math.Abs(ex).ToString(CultureInfo.InvariantCulture);
            body = k == 1 ? digits + "e" + es : digits[..1] + "." + digits[1..] + "e" + es;
        }
        return sign + body;
    }

    /// <summary>JSON.stringify of a value read from JSON.</summary>
    public static string Stringify(JsNode node)
    {
        var sb = new StringBuilder();
        Write(sb, node);
        return sb.ToString();
    }

    private static void Write(StringBuilder sb, JsNode node)
    {
        switch (node)
        {
            case Obj o:
                sb.Append('{');
                for (var i = 0; i < o.Members.Count; i++)
                {
                    if (i > 0) sb.Append(',');
                    Quote(sb, o.Members[i].Key);
                    sb.Append(':');
                    Write(sb, o.Members[i].Value);
                }
                sb.Append('}');
                break;
            case Arr a:
                sb.Append('[');
                for (var i = 0; i < a.Items.Count; i++)
                {
                    if (i > 0) sb.Append(',');
                    Write(sb, a.Items[i]);
                }
                sb.Append(']');
                break;
            case Str s: Quote(sb, s.Value); break;
            case Num n: sb.Append(double.IsFinite(n.Value) ? NumberText(n.Value) : "null"); break;
            case Bool b: sb.Append(b.Value ? "true" : "false"); break;
            default: sb.Append("null"); break;
        }
    }

    private static void Quote(StringBuilder sb, string s)
    {
        sb.Append('"');
        for (var i = 0; i < s.Length; i++)
        {
            var c = s[i];
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else if (char.IsHighSurrogate(c) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1])) { sb.Append(c).Append(s[i + 1]); i++; }
                    else if (char.IsSurrogate(c)) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
    }
}

/// <summary>One record as flat text, exactly as the cloud REST connector's flattenRecord: dotted keys, plain lists joined with ", ", deeper values as JSON.</summary>
public static class RestFlatten
{
    public const int MaxKeys = 500;
    public const int MaxDepth = 5;
    public const int MaxCell = 10_000;

    public static List<KeyValuePair<string, string>> Flatten(JsNode.Obj record)
    {
        var output = new List<KeyValuePair<string, string>>();
        Walk(record, "", 0, output);
        // Object.fromEntries: a repeated key keeps its first place and its last value.
        var at = new Dictionary<string, int>(StringComparer.Ordinal);
        var result = new List<KeyValuePair<string, string>>();
        foreach (var kv in output)
        {
            if (at.TryGetValue(kv.Key, out var i)) result[i] = kv;
            else { at[kv.Key] = result.Count; result.Add(kv); }
        }
        return result;
    }

    private static string Cell(JsNode v)
    {
        var s = v switch
        {
            JsNode.Str str => str.Value,
            JsNode.Obj or JsNode.Arr or JsNode.Null => JsNode.Stringify(v),
            JsNode.Num n => JsNode.NumberText(n.Value),
            JsNode.Bool b => b.Value ? "true" : "false",
            _ => "",
        };
        return s.Length > MaxCell ? s[..MaxCell] : s;
    }

    private static string Plain(JsNode v) => v switch
    {
        JsNode.Str s => s.Value,
        JsNode.Num n => JsNode.NumberText(n.Value),
        JsNode.Bool b => b.Value ? "true" : "false",
        _ => "",
    };

    private static void Walk(JsNode value, string key, int depth, List<KeyValuePair<string, string>> output)
    {
        if (output.Count >= MaxKeys) return;
        switch (value)
        {
            case JsNode.Null:
                output.Add(new(key, ""));
                return;
            case JsNode.Arr a:
                var plain = a.Items.All(x => x is JsNode.Null or JsNode.Str or JsNode.Num or JsNode.Bool);
                output.Add(new(key, plain ? string.Join(", ", a.Items.Where(x => x is not JsNode.Null).Select(Plain)) : Cell(a)));
                return;
            case JsNode.Obj o:
                if (depth >= MaxDepth) { output.Add(new(key, Cell(o))); return; }
                foreach (var m in o.Members) Walk(m.Value, key.Length > 0 ? $"{key}.{m.Key}" : m.Key, depth + 1, output);
                return;
            default:
                output.Add(new(key, Cell(value)));
                return;
        }
    }

    /// <summary>The cloud connector's comparison of incremental values: as numbers when both are numbers, else as text.</summary>
    public static bool Greater(string a, string? b)
    {
        if (string.IsNullOrEmpty(b)) return true;
        if (a.Trim().Length > 0 && b.Trim().Length > 0 && JsNumber(a) is { } x && JsNumber(b) is { } y) return x > y;
        return string.CompareOrdinal(a, b) > 0;
    }

    /// <summary>Number(s) in JavaScript for the forms an API sends (decimal, exponent, hex); null when it is not a finite number.</summary>
    private static double? JsNumber(string s)
    {
        var t = s.Trim();
        if (t.Length == 0) return 0;
        if (t.StartsWith("0x", StringComparison.OrdinalIgnoreCase) && ulong.TryParse(t[2..], NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var hex)) return hex;
        if (!Regex.IsMatch(t, @"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")) return null;
        return double.TryParse(t, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) && double.IsFinite(d) ? d : null;
    }
}

/// <summary>
/// The agent's HTTP client for internal APIs. Every request: a host on this agent's allow-list ("hosts" in allowlist.json; none = no API), every
/// address it resolves to checked (never link-local — cloud metadata lives there — "any", multicast or broadcast) and the connection made to that
/// checked address; redirects never followed; no cookies, no proxy; 10 MB per answer; the connection's timeout.
/// </summary>
public sealed class RestHttp : IDisposable
{
    public const int MaxBodyBytes = 10 * 1024 * 1024;
    private readonly HttpClient client;
    private readonly LocalAllowList allow;
    private readonly string allowListName;

    public RestHttp(LocalAllowList allow, string allowListPath, int timeoutSeconds)
    {
        this.allow = allow;
        allowListName = Path.GetFileName(allowListPath);
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            UseCookies = false,
            UseProxy = false,
            AutomaticDecompression = DecompressionMethods.All,
            ConnectTimeout = TimeSpan.FromSeconds(Math.Min(timeoutSeconds, 30)),
            PooledConnectionLifetime = TimeSpan.FromMinutes(2),
            ConnectCallback = ConnectAsync,
        };
        client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(timeoutSeconds) };
    }

    public static bool Refused(IPAddress a)
    {
        if (a.IsIPv4MappedToIPv6) a = a.MapToIPv4();
        if (a.Equals(IPAddress.Any) || a.Equals(IPAddress.IPv6Any) || a.Equals(IPAddress.Broadcast)) return true;
        if (a.AddressFamily == AddressFamily.InterNetwork)
        {
            var b = a.GetAddressBytes();
            return (b[0] == 169 && b[1] == 254) || b[0] >= 224 || b[0] == 0;
        }
        return a.IsIPv6LinkLocal || a.IsIPv6Multicast;
    }

    private static async ValueTask<Stream> ConnectAsync(SocketsHttpConnectionContext context, CancellationToken ct)
    {
        var host = context.DnsEndPoint.Host.Trim('[', ']');
        var addresses = IPAddress.TryParse(host, out var literal) ? [literal] : await Dns.GetHostAddressesAsync(host, ct);
        if (addresses.Length == 0) throw new HttpRequestException($"{host} does not resolve to any address");
        // Every address the name resolves to must be one an API can be at; the connection goes to one of those checked addresses.
        if (addresses.Any(Refused)) throw new HttpRequestException($"{host} resolves to an address an API cannot be at (link-local, multicast or \"any\")");
        Exception? last = null;
        foreach (var address in addresses)
        {
            var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
            try
            {
                await socket.ConnectAsync(new IPEndPoint(address, context.DnsEndPoint.Port), ct);
                return new NetworkStream(socket, ownsSocket: true);
            }
            catch (Exception e) when (e is SocketException or OperationCanceledException && !ct.IsCancellationRequested)
            {
                socket.Dispose();
                last = e;
            }
        }
        throw new HttpRequestException($"Could not connect to {host}", last);
    }

    public sealed record Answer(int Status, HttpResponseHeaders Headers, byte[] Body, Uri Url);

    public async Task<Answer> GetAsync(Uri url, IReadOnlyDictionary<string, string> headers, CancellationToken ct)
    {
        if (!allow.AllowsHost(url))
            throw new JobFailedException("refused", $"{url.Authority} is not on this agent's allow-list: add it under \"hosts\" in {allowListName} on the agent's machine");
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        foreach (var (k, v) in headers) request.Headers.TryAddWithoutValidation(k, v);
        HttpResponseMessage response;
        try
        {
            response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new JobFailedException("timeout", $"The API did not answer in time at {url.AbsolutePath}", transient: true);
        }
        catch (HttpRequestException e)
        {
            var refused = e.Message.Contains("cannot be at", StringComparison.Ordinal);
            throw new JobFailedException(refused ? "refused" : "network", refused ? e.Message : $"The API could not be reached at {url.Authority}: {e.Message}", transient: !refused);
        }
        using (response)
        {
            var status = (int)response.StatusCode;
            if (status is >= 300 and < 400)
                throw new JobFailedException("refused", $"The API answered {status} at {url.AbsolutePath} with a redirect, which is not followed: give the address it redirects to");
            if (response.Content.Headers.ContentLength > MaxBodyBytes) throw TooLarge();
            await using var stream = await response.Content.ReadAsStreamAsync(ct);
            using var buffer = new MemoryStream();
            var chunk = new byte[81920];
            int read;
            while ((read = await stream.ReadAsync(chunk, ct)) > 0)
            {
                buffer.Write(chunk, 0, read);
                if (buffer.Length > MaxBodyBytes) throw TooLarge();
            }
            return new Answer(status, response.Headers, buffer.ToArray(), url);
        }
    }

    private static JobFailedException TooLarge() => new("limit", "The API's answer is over 10 MB: ask for smaller pages");

    public void Dispose() => client.Dispose();
}

/// <summary>Test, preview and extract jobs for an internal API.</summary>
public static class RestJobs
{
    public const int MaxRecordsPerPage = 1000;
    public const int MaxPages = 10_000;
    public const int MaxState = 1900;

    /// <summary>Where a read is: the page to ask for next and how many of its records were already sent (a job taken again carries on there).</summary>
    public sealed record PageState(int N, int? Page, long? Offset, string? Token, string? Link, int Skip)
    {
        public string ToJson() => new JsonObject
        {
            ["n"] = N, ["page"] = Page, ["offset"] = Offset, ["token"] = Token, ["link"] = Link, ["skip"] = Skip,
        }.ToJsonString();

        public static PageState? FromJson(string? text)
        {
            if (string.IsNullOrEmpty(text)) return null;
            try
            {
                if (JsonNode.Parse(text) is not JsonObject o) return null;
                return new PageState(o["n"]?.GetValue<int>() ?? 0, o["page"]?.GetValue<int>(), o["offset"]?.GetValue<long>(), o["token"]?.GetValue<string>(),
                    o["link"]?.GetValue<string>(), o["skip"]?.GetValue<int>() ?? 0);
            }
            catch (Exception e) when (e is JsonException or InvalidOperationException or FormatException)
            {
                return null;
            }
        }
    }

    public sealed record PageResult(IReadOnlyList<List<KeyValuePair<string, string>>> Records, PageState? Next);

    private sealed class Session(RestSettings settings, RestHttp http, Dictionary<string, string> headers) : IDisposable
    {
        public RestSettings Settings { get; } = settings;
        public RestHttp Http { get; } = http;
        public Dictionary<string, string> Headers { get; } = headers;
        public void Dispose() => Http.Dispose();
    }

    private static Session Open(AgentJob job, DatabaseJobContext context)
    {
        var settings = RestSettings.Parse(job.Spec?["connection"] as JsonObject);
        var allow = LocalAllowList.Load(context.AllowListPath);
        if (!allow.AllowsHost(settings.BaseUri))
            throw new JobFailedException("refused", $"{settings.BaseUri.Authority} is not on this agent's allow-list: add it under \"hosts\" in {Path.GetFileName(context.AllowListPath)} on the agent's machine");
        var headers = new Dictionary<string, string> { ["Accept"] = "application/json", ["User-Agent"] = $"Fortress-Connector-Agent/{AgentInfo.Version}" };
        if (settings.NeedsSecret && settings.BaseUri.Scheme == Uri.UriSchemeHttp && !allow.PlainHttpSignIn)
            throw new JobFailedException("refused", $"{settings.BaseUri.Authority} is plain http, so its key or password would cross the network readable. Use https, or set \"plainHttpSignIn\": true in {Path.GetFileName(context.AllowListPath)} on the agent's machine");
        if (settings.NeedsSecret)
        {
            DbCredential? credential;
            try
            {
                credential = context.Credentials.Load(DatabaseJobContext.ConnectionId(job), ConnectionTarget.Of(job.Spec?["connection"] as JsonObject));
            }
            catch (Exception e) when (e is System.Security.Cryptography.CryptographicException or InvalidDataException or IOException)
            {
                throw new JobFailedException("auth", "The key or password this agent holds for the API cannot be read. Type it again in Fortress.");
            }
            if (credential is null) throw new JobFailedException("auth", "This agent has no key or password for the API yet. Type it in Fortress.");
            switch (settings.AuthType)
            {
                case "api_key": headers[settings.ApiKeyHeader!] = credential.Password; break;
                case "bearer": headers["Authorization"] = "Bearer " + credential.Password; break;
                default:
                    if (credential.Username.Length == 0) throw new JobFailedException("auth", "The API signs in with a user name and password: type both in Fortress.");
                    headers["Authorization"] = "Basic " + Convert.ToBase64String(Encoding.UTF8.GetBytes($"{credential.Username}:{credential.Password}"));
                    break;
            }
        }
        return new Session(settings, new RestHttp(allow, context.AllowListPath, settings.TimeoutSeconds), headers);
    }

    /// <summary>A GET with retries for a busy or failing API (429, 408, 5xx, timeouts): three tries, waiting as asked (at most a minute) or 1, 2, 4 s.</summary>
    private static async Task<RestHttp.Answer> GetAsync(Session s, Uri url, CancellationToken ct)
    {
        for (var attempt = 1; ; attempt++)
        {
            RestHttp.Answer? answer = null;
            JobFailedException? failure = null;
            try
            {
                answer = await s.Http.GetAsync(url, s.Headers, ct);
            }
            catch (JobFailedException e) when (e.Transient)
            {
                failure = e;
            }
            var busy = answer is { Status: 429 or 408 or >= 500 };
            if (failure is null && !busy) return answer!;
            if (attempt >= 3)
            {
                if (failure is not null) throw failure;
                throw answer!.Status == 429
                    ? new JobFailedException("rate_limit", "The API asked us to slow down (429)", transient: true)
                    : new JobFailedException("transient", $"The API had a problem ({answer.Status}) at {url.AbsolutePath}", transient: true);
            }
            var wait = TimeSpan.FromSeconds(Math.Pow(2, attempt - 1));
            if (answer?.Headers.RetryAfter is { } ra)
                wait = ra.Delta ?? (ra.Date is { } at ? at - DateTimeOffset.UtcNow : wait);
            wait = TimeSpan.FromSeconds(Math.Clamp(wait.TotalSeconds, 0, 60));
            await Task.Delay(wait, ct);
        }
    }

    private static JobFailedException Status(RestHttp.Answer a) => a.Status switch
    {
        401 or 403 => new JobFailedException("auth", $"The API refused the sign-in ({a.Status})"),
        _ => new JobFailedException("refused", $"The API answered {a.Status} at {a.Url.AbsolutePath}"),
    };

    public static async Task<JsonObject> TestAsync(AgentJob job, DatabaseJobContext context, CancellationToken ct)
    {
        using var s = Open(job, context);
        var url = s.Settings.Join(s.Settings.TestPath);
        var answer = await GetAsync(s, url, ct);
        if (answer.Status is < 200 or >= 300) throw Status(answer);
        return new JsonObject
        {
            ["ok"] = true,
            ["message"] = $"The API answered {answer.Status} at {url.AbsolutePath}",
            ["status"] = answer.Status,
            ["engine"] = "rest",
            ["host"] = url.Authority,
        };
    }

    /// <summary>One page of the endpoint, as flat records, and where the next one is (null when this was the last).</summary>
    public static async Task<PageResult> ReadPageAsync(RestSettings settings, Func<Uri, CancellationToken, Task<RestHttp.Answer>> get, RestEndpoint ep, PageState state,
        string? changedSince, CancellationToken ct)
    {
        if (state.N >= MaxPages) throw new JobFailedException("limit", $"An import reads at most {MaxPages:N0} pages");
        var paging = ep.Paging;
        var size = paging.PageSize;
        var basePath = settings.Join(ep.Path);
        Uri url;
        if (state.Link is not null)
        {
            if (!Uri.TryCreate(basePath, state.Link, out var link)) throw new JobFailedException("refused", "The API gave a next-page link that is not an address");
            if (!settings.SameOrigin(link)) throw new JobFailedException("refused", $"The API's next-page link goes to another address ({link.Authority}), which is not followed");
            url = link;
        }
        else
        {
            var q = new List<KeyValuePair<string, string>>(ep.Query);
            void Set(string k, string v) { q.RemoveAll(x => x.Key == k); q.Add(new(k, v)); }
            if (ep.ChangedParam is not null && changedSince is not null) Set(ep.ChangedParam, changedSince);
            switch (paging.Style)
            {
                case "page":
                    Set(paging.PageParam ?? "page", (state.Page ?? paging.FirstPage ?? 1).ToString(CultureInfo.InvariantCulture));
                    Set(paging.SizeParam ?? "per_page", size.ToString(CultureInfo.InvariantCulture));
                    break;
                case "offset":
                    Set(paging.OffsetParam ?? "offset", (state.Offset ?? 0).ToString(CultureInfo.InvariantCulture));
                    Set(paging.LimitParam ?? "limit", size.ToString(CultureInfo.InvariantCulture));
                    break;
                case "cursor":
                    if (state.Token is not null) Set(paging.CursorParam ?? "cursor", state.Token);
                    if (paging.SizeParam is not null) Set(paging.SizeParam, size.ToString(CultureInfo.InvariantCulture));
                    break;
                case "next_link":
                    if (paging.SizeParam is not null) Set(paging.SizeParam, size.ToString(CultureInfo.InvariantCulture));
                    break;
            }
            var b = new UriBuilder(basePath) { Query = string.Join('&', q.Select(x => Uri.EscapeDataString(x.Key) + "=" + Uri.EscapeDataString(x.Value))) };
            url = b.Uri;
        }

        var answer = await get(url, ct);
        if (answer.Status is < 200 or >= 300) throw Status(answer);
        JsNode body;
        try
        {
            body = JsNode.Parse(answer.Body);
        }
        catch (JsonException)
        {
            throw new JobFailedException("malformed", $"The API's answer at {url.AbsolutePath} is not JSON");
        }
        if (JsNode.AtPath(body, ep.RecordsPath) is not JsNode.Arr list)
            throw new JobFailedException("malformed", ep.RecordsPath is not null ? $"The answer has no list of records at \"{ep.RecordsPath}\"" : "The answer is not a list of records: say where the list is");
        if (list.Items.Count > MaxRecordsPerPage) throw new JobFailedException("limit", $"A page holds at most {MaxRecordsPerPage} records; ask for smaller pages");
        var records = list.Items.Select((r, i) => r is JsNode.Obj o ? RestFlatten.Flatten(o) : throw new JobFailedException("malformed", $"Record {i + 1} of the page is not an object")).ToList();

        PageState? next = null;
        var more = false;
        var following = state with { N = state.N + 1, Skip = 0 };
        switch (paging.Style)
        {
            case "page":
                more = records.Count >= size && records.Count > 0;
                following = following with { Page = (state.Page ?? paging.FirstPage ?? 1) + 1 };
                break;
            case "offset":
                more = records.Count >= size && records.Count > 0;
                following = following with { Offset = (state.Offset ?? 0) + records.Count };
                break;
            case "cursor":
                var token = JsNode.AtPath(body, paging.NextCursorPath);
                var text = token switch { JsNode.Str { Value.Length: > 0 } t => t.Value, JsNode.Num n => JsNode.NumberText(n.Value), _ => null };
                if (text is not null)
                {
                    following = following with { Token = text };
                    more = text != state.Token;
                }
                break;
            case "next_link":
                var linkText = paging.NextLinkPath == "header" ? LinkHeaderNext(answer.Headers) : (JsNode.AtPath(body, paging.NextLinkPath) as JsNode.Str)?.Value;
                if (!string.IsNullOrEmpty(linkText))
                {
                    following = following with { Link = linkText };
                    more = linkText != state.Link;
                }
                break;
        }
        if (more && records.Count == 0) more = false;
        if (more)
        {
            if (following.ToJson().Length > MaxState) throw new JobFailedException("limit", "The API's next-page cursor or link is too long to remember");
            next = following;
        }
        return new PageResult(records, next);
    }

    /// <summary>The next-page link in a Link header ('&lt;https://…&gt;; rel="next"').</summary>
    public static string? LinkHeaderNext(HttpResponseHeaders headers)
    {
        if (!headers.TryGetValues("Link", out var values)) return null;
        foreach (var header in values)
            foreach (var part in header.Split(','))
            {
                var m = Regex.Match(part.Trim(), "<([^>]+)>\\s*;(.*)$");
                if (m.Success && Regex.IsMatch(m.Groups[2].Value, "(^|;)\\s*rel\\s*=\\s*\"?([^\";]*\\s)?next(\\s[^\";]*)?\"?\\s*(;|$)", RegexOptions.IgnoreCase)) return m.Groups[1].Value;
            }
        return null;
    }

    public static async Task<JsonObject> PreviewAsync(AgentJob job, DatabaseJobContext context, CancellationToken ct)
    {
        var request = DatabaseJobContext.Request(job);
        var ep = RestEndpoint.Parse(request);
        var limit = Math.Clamp(request["limit"] is JsonValue l && l.TryGetValue<int>(out var n) ? n : 20, 1, 50);
        using var s = Open(job, context);
        var page = await ReadPageAsync(s.Settings, (u, c) => GetAsync(s, u, c), ep, new PageState(0, null, null, null, null, 0), null, ct);
        var columns = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var rows = new JsonArray();
        var size = 0;
        var truncated = page.Records.Count > limit;
        foreach (var record in page.Records.Take(limit))
        {
            var o = new JsonObject();
            foreach (var (k, v) in record)
            {
                if (seen.Add(k)) columns.Add(k);
                o[k] = v;
            }
            var bytes = o.ToJsonString().Length;
            if (size + bytes > PreviewHandler.MaxResultBytes) { truncated = true; break; }
            size += bytes;
            rows.Add(o);
        }
        return new JsonObject
        {
            ["path"] = ep.Path,
            ["columns"] = new JsonArray(columns.Select(c => (JsonNode)new JsonObject { ["name"] = c, ["type"] = "text" }).ToArray()),
            ["rows"] = rows,
            ["truncated"] = truncated,
            ["pageRecords"] = page.Records.Count,
            ["morePages"] = page.Next is not null,
        };
    }

    public static async Task<JsonObject> ExtractAsync(AgentJob job, DatabaseJobContext context, JobContext jobs, CancellationToken ct)
    {
        var request = DatabaseJobContext.Request(job);
        var ep = RestEndpoint.Parse(request);
        long? maxRows = request["maxRows"] is JsonValue m && m.TryGetValue<long>(out var mr) ? mr : null;
        string? Opt(string key) => request[key] is JsonValue v && v.TryGetValue<string>(out var s) && s.Length > 0 ? s : null;
        var changedSince = Opt("changedSince");
        using var s = Open(job, context);

        var seq = job.Resume?.NextSeq ?? 0;
        var total = job.Resume?.Rows ?? 0;
        var mark = job.Resume?.ChangedUpTo ?? (ep.ChangedColumn is null ? null : changedSince);
        var state = PageState.FromJson(job.Resume?.AfterKey) ?? new PageState(0, null, null, null, null, 0);
        var columns = new List<string>();
        var known = new HashSet<string>(StringComparer.Ordinal);
        var truncated = false;
        while (true)
        {
            ct.ThrowIfCancellationRequested();
            var page = await ReadPageAsync(s.Settings, (u, c) => GetAsync(s, u, c), ep, state, changedSince, ct);
            var rows = new List<ExtractedRow>();
            for (var i = state.Skip; i < page.Records.Count; i++)
            {
                if (maxRows is { } max && total + rows.Count >= max) { truncated = true; break; }
                var record = page.Records[i];
                var values = new Dictionary<string, object?>(StringComparer.Ordinal);
                foreach (var (k, v) in record)
                {
                    values[k] = v;
                    if (known.Add(k)) columns.Add(k);
                }
                if (ep.ChangedColumn is not null && values.TryGetValue(ep.ChangedColumn, out var cv) && cv is string cs && cs.Length > 0 && RestFlatten.Greater(cs, mark))
                {
                    if (cs.Length > MaxState) throw new JobFailedException("limit", $"The values of {ep.ChangedColumn} are too long to remember for the next import");
                    mark = cs;
                }
                // Where a job taken again after this row carries on: the next page once the page is done, else this page past this row.
                var after = i == page.Records.Count - 1 && page.Next is not null ? page.Next : state with { Skip = i + 1 };
                rows.Add(new ExtractedRow(values, after.ToJson()));
            }
            if (rows.Count > 0)
            {
                var dbColumns = columns.Select(c => new DbColumn(c, "text", true, false)).ToList();
                foreach (var part in ExtractHandler.Split(rows, dbColumns, RestFlatten.MaxCell))
                {
                    var receipt = await jobs.SendBatchAsync(part.Batch(seq, ep.ChangedColumn is null ? null : mark), ct);
                    if (receipt.Cancelled) { ct.ThrowIfCancellationRequested(); throw new OperationCanceledException("The job was cancelled in Fortress"); }
                    seq++;
                    total += part.Rows.Count;
                }
            }
            if (truncated || page.Next is null) break;
            state = page.Next;
        }
        return new JsonObject
        {
            ["batches"] = seq,
            ["rows"] = total,
            ["columns"] = new JsonArray(columns.Select(c => (JsonNode)new JsonObject { ["name"] = c, ["type"] = "text" }).ToArray()),
            ["truncated"] = truncated,
            ["changedUpTo"] = ep.ChangedColumn is null ? null : mark,
        };
    }
}
