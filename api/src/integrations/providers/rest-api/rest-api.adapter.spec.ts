import { ConnectorError } from '../../core/connector.interface';
import { SafeHttpClient, SafeResponse, SendRequest } from '../../core/safe-http';
import { flattenRecord, RestApiAdapter, retryAfterSeconds } from './rest-api.adapter';
import { joinUrl, readRestConfig, REST_PATH } from './rest-config';

/** An adapter whose requests are answered by `answer` (a fake API: every request is recorded; DNS says the host is public). */
function adapter(answer: (url: URL, req: SendRequest) => Partial<SafeResponse> & { json?: unknown }) {
  const seen: SendRequest[] = [];
  const http = new SafeHttpClient({
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    send: async (req) => {
      seen.push(req);
      const a = answer(req.url, req);
      return { status: a.status ?? 200, headers: a.headers ?? {}, body: a.body ?? Buffer.from(JSON.stringify(a.json ?? [])) };
    },
  });
  return { a: new RestApiAdapter(http), seen };
}

const base = { baseUrl: 'https://erp.example.com/api', authType: 'none' };
const parts = (over: Record<string, unknown> = {}) => ({ ...base, entities: { part: { path: '/v1/parts', ...over } } });

const rows = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ id: `P-${from + i}`, name: `Part ${from + i}`, updatedAt: `2026-11-${String(from + i).padStart(2, '0')}T00:00:00Z` }));

/** Read every page the way the sync engine does: call again with the cursor until done. */
async function readAll(a: RestApiAdapter, config: Record<string, unknown>, cursor: string | null = null, secret: string | null = null) {
  const out: Record<string, unknown>[] = [];
  let c = cursor;
  for (let i = 0; i < 50; i++) {
    const page = await a.fetchRecords({ config, secret }, 'part', c);
    out.push(...page.records.map((r) => r.payload));
    c = page.nextCursor;
    if (page.done) return { records: out, cursor: c };
  }
  throw new Error('never done');
}

describe('REST settings', () => {
  it('keeps every path on the connection\'s address', () => {
    for (const p of ['/v1/parts', '/', '/a-b_c.d~e/%20x', '/odata/Items(1)']) expect(REST_PATH.test(p)).toBe(true);
    for (const p of ['v1/parts', '//evil.com/x', '/a/../b', '/..', '/a/./b', '/a?x=1', '/a#b', '/a\\b', '/%2e%2e/x', '/%2E%2E/x', 'https://evil.com']) expect(REST_PATH.test(p)).toBe(false);
    expect(joinUrl('https://erp.example.com/api/', '/v1/parts').toString()).toBe('https://erp.example.com/api/v1/parts');
    expect(joinUrl('https://erp.example.com/api?x=1#y', undefined).toString()).toBe('https://erp.example.com/api');
  });

  it('checks the settings and names the first problem', () => {
    expect(readRestConfig(parts({ paging: { style: 'cursor' } }))).toEqual({ ok: false, problem: expect.stringMatching(/next cursor/) });
    expect(readRestConfig({ ...base, apiKeyHeader: 'Host' })).toEqual({ ok: false, problem: expect.stringMatching(/cannot be set/) });
    expect(readRestConfig({ ...base, headers: { Host: 'x' } })).toMatchObject({ ok: false });
    expect(readRestConfig(parts({ recordsPath: 'data', paging: { style: 'page', pageSize: 50 } }))).toMatchObject({ ok: true });
  });
});

describe('reading records', () => {
  it('flattens nested records into dotted columns', () => {
    expect(flattenRecord({ id: 7, active: true, address: { city: 'Leeds', geo: { lat: 1 } }, tags: ['a', 'b'], lines: [{ q: 1 }], none: null })).toEqual({
      id: '7', active: 'true', 'address.city': 'Leeds', 'address.geo.lat': '1', tags: 'a, b', lines: '[{"q":1}]', none: '',
    });
    const odd = flattenRecord(JSON.parse('{"__proto__": {"x": 1}, "constructor": "c"}'));
    expect(odd).toEqual({ '__proto__.x': '1', constructor: 'c' });
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('pages by page number until a short page, sending the sign-in header', async () => {
    const all = rows(1, 5);
    const { a, seen } = adapter((url) => {
      const p = Number(url.searchParams.get('page'));
      return { json: { data: all.slice((p - 1) * 2, p * 2) } };
    });
    const config = { ...parts({ recordsPath: 'data', paging: { style: 'page', pageSize: 2 } }), authType: 'api_key', apiKeyHeader: 'X-Api-Key' };
    const { records, cursor } = await readAll(a, config, null, 'secret-key');
    expect(records.map((r) => r.id)).toEqual(['P-1', 'P-2', 'P-3', 'P-4', 'P-5']);
    expect(cursor).toBeNull();
    expect(seen.map((s) => s.url.search)).toEqual(['?page=1&per_page=2', '?page=2&per_page=2', '?page=3&per_page=2']);
    expect(seen[0].url.pathname).toBe('/api/v1/parts');
    expect(seen[0].headers['X-Api-Key']).toBe('secret-key');
  });

  it('pages by offset, by a cursor token and by next links (in the answer or the Link header)', async () => {
    const all = rows(1, 5);
    const off = adapter((url) => ({ json: all.slice(Number(url.searchParams.get('offset')), Number(url.searchParams.get('offset')) + 2) }));
    expect((await readAll(off.a, parts({ paging: { style: 'offset', pageSize: 2 } }))).records).toHaveLength(5);

    const tok = adapter((url) => {
      const at = Number(url.searchParams.get('after') ?? 0);
      return { json: { items: all.slice(at, at + 2), meta: { next: at + 2 < 5 ? String(at + 2) : null } } };
    });
    expect((await readAll(tok.a, parts({ recordsPath: 'items', paging: { style: 'cursor', cursorParam: 'after', nextCursorPath: 'meta.next' } }))).records).toHaveLength(5);
    expect(tok.seen.map((s) => s.url.searchParams.get('after'))).toEqual([null, '2', '4']);

    const link = adapter((url) => {
      const p = Number(url.searchParams.get('p') ?? 1);
      return { json: { value: all.slice((p - 1) * 2, p * 2), next: p < 3 ? `https://erp.example.com/api/v1/parts?p=${p + 1}` : null } };
    });
    expect((await readAll(link.a, parts({ recordsPath: 'value', paging: { style: 'next_link', nextLinkPath: 'next' } }))).records).toHaveLength(5);

    const header = adapter((url) => {
      const p = Number(url.searchParams.get('p') ?? 1);
      return { json: all.slice((p - 1) * 2, p * 2), headers: (p < 3 ? { link: `</api/v1/parts?p=${p + 1}>; rel="next", </api/v1/parts?p=1>; rel="first"` } : {}) as Record<string, string> };
    });
    expect((await readAll(header.a, parts({ paging: { style: 'next_link', nextLinkPath: 'header' } }))).records).toHaveLength(5);
  });

  it('refuses a next link to another host', async () => {
    const { a } = adapter(() => ({ json: { value: rows(1, 1), next: 'https://169.254.169.254/latest/meta-data' } }));
    const config = parts({ recordsPath: 'value', paging: { style: 'next_link', nextLinkPath: 'next' } });
    const first = await a.fetchRecords({ config, secret: null }, 'part', null);
    await expect(a.fetchRecords({ config, secret: null }, 'part', first.nextCursor)).rejects.toMatchObject({ kind: 'limit', transient: false, message: expect.stringMatching(/another address/) });
  });

  it('remembers the highest value of the incremental field and sends it next time', async () => {
    const all = rows(1, 5);
    const { a, seen } = adapter((url) => {
      const since = url.searchParams.get('updated_since');
      return { json: all.filter((r) => !since || r.updatedAt >= since) };
    });
    const config = parts({ incremental: { param: 'updated_since', field: 'updatedAt' } });
    const first = await readAll(a, config);
    expect(first.records).toHaveLength(5);
    expect(JSON.parse(first.cursor!)).toEqual({ w: '2026-11-05T00:00:00Z' });
    const next = await readAll(a, config, first.cursor);
    expect(seen[1].url.searchParams.get('updated_since')).toBe('2026-11-05T00:00:00Z');
    expect(next.records.map((r) => r.id)).toEqual(['P-5']);
    expect(JSON.parse(next.cursor!)).toEqual({ w: '2026-11-05T00:00:00Z' });
  });

  it('turns answers into errors the engine understands', async () => {
    const config = parts();
    const run = (status: number, headers: Record<string, string> = {}, body = '[]') =>
      adapter(() => ({ status, headers, body: Buffer.from(body) })).a.fetchRecords({ config, secret: null }, 'part', null).catch((e: ConnectorError) => e);
    expect(await run(401)).toMatchObject({ kind: 'auth', transient: false });
    expect(await run(429, { 'retry-after': '120' })).toMatchObject({ kind: 'rate_limit', transient: true, retryAfterSeconds: 120 });
    expect(await run(503)).toMatchObject({ kind: 'transient', transient: true });
    expect(await run(404)).toMatchObject({ kind: 'malformed', transient: false });
    expect(await run(301, { location: 'https://10.0.0.1/' })).toMatchObject({ kind: 'malformed', message: expect.stringMatching(/redirect/) });
    expect(await run(200, {}, '<html>')).toMatchObject({ kind: 'malformed', message: expect.stringMatching(/not JSON/) });
    expect(await run(200, {}, '{"data": 1}')).toMatchObject({ kind: 'malformed' });
    expect(await run(200, {}, '[1, 2]')).toMatchObject({ kind: 'malformed', message: expect.stringMatching(/not an object/) });
    expect(await run(200, {}, JSON.stringify(rows(1, 1001)))).toMatchObject({ kind: 'limit' });
    expect(retryAfterSeconds('99999')).toBe(3600);
    expect(retryAfterSeconds(new Date(Date.now() + 30_000).toUTCString())).toBeGreaterThan(20);
  });

  it('needs the credential its sign-in uses, and knows which records it can read', async () => {
    const { a } = adapter(() => ({ json: [] }));
    await expect(a.fetchRecords({ config: { ...parts(), authType: 'bearer' }, secret: null }, 'part', null)).rejects.toMatchObject({ kind: 'auth' });
    await expect(a.fetchRecords({ config: parts(), secret: null }, 'supplier', null)).rejects.toMatchObject({ kind: 'mapping', message: expect.stringMatching(/supplier records/) });
    await expect(a.fetchRecords({ config: parts(), secret: null }, 'constructor', null)).rejects.toMatchObject({ kind: 'mapping' });
  });

  it('signs in with bearer and basic credentials', async () => {
    const { a, seen } = adapter(() => ({ json: [] }));
    await a.fetchRecords({ config: { ...parts(), authType: 'bearer' }, secret: 'tok' }, 'part', null);
    await a.fetchRecords({ config: { ...parts(), authType: 'basic' }, secret: JSON.stringify({ username: 'u', password: 'p' }) }, 'part', null);
    expect(seen[0].headers.Authorization).toBe('Bearer tok');
    expect(seen[1].headers.Authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('tests the connection at its test path', async () => {
    const { a, seen } = adapter((url) => (url.pathname.endsWith('/health') ? { status: 200 } : { status: 404 }));
    expect(await a.testConnection({ config: { ...base, testPath: '/health' }, secret: null })).toEqual({ ok: true, message: 'The API answered 200 at /api/health' });
    expect(await a.testConnection({ config: base, secret: null })).toMatchObject({ ok: false });
    expect(seen).toHaveLength(2);
    const denied = adapter(() => ({ status: 401 }));
    expect(await denied.a.testConnection({ config: base, secret: null })).toEqual({ ok: false, message: 'The API refused the credential (401)' });
    expect(await denied.a.testConnection({ config: { ...base, baseUrl: 'https://erp.example.com' }, secret: null, allowedHosts: ['other.com'] })).toMatchObject({ ok: false, message: expect.stringMatching(/does not allow/) });
  });
});

describe('OAuth client credentials', () => {
  const oauth = (over: Record<string, unknown> = {}) => ({
    ...parts(), authType: 'oauth_client', oauthTokenUrl: 'https://login.example.net/tenant/oauth2/v2.0/token', oauthScope: 'api://erp/.default', ...over,
  });
  const client = JSON.stringify({ clientId: 'app id', clientSecret: 's3cr+t' });
  /** A fake identity provider and API: tokens tok-1, tok-2 …; the API accepts only the latest token unless told otherwise. */
  function idp(options: { tokenAnswer?: (n: number) => Partial<SafeResponse> & { json?: unknown }; apiRefuses?: (token: string) => boolean } = {}) {
    let issued = 0;
    let clock = 1_000_000;
    const seen: SendRequest[] = [];
    const http = new SafeHttpClient({
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      send: async (req) => {
        seen.push(req);
        if (req.url.hostname === 'login.example.net') {
          issued += 1;
          const a = options.tokenAnswer?.(issued) ?? { json: { access_token: `tok-${issued}`, token_type: 'Bearer', expires_in: 3600 } };
          return { status: a.status ?? 200, headers: {}, body: a.body ?? Buffer.from(JSON.stringify(a.json ?? {})) };
        }
        const token = (req.headers.Authorization ?? '').replace(/^Bearer /, '');
        if (options.apiRefuses?.(token)) return { status: 401, headers: {}, body: Buffer.from('{}') };
        return { status: 200, headers: {}, body: Buffer.from('[]') };
      },
    });
    return { a: new RestApiAdapter(http, () => clock), seen, tick: (ms: number) => (clock += ms), issued: () => issued };
  }

  it('asks for a token with the client in the body, then calls the API with it', async () => {
    const { a, seen } = idp();
    await a.fetchRecords({ config: oauth({ oauthAudience: 'https://erp' }), secret: client }, 'part', null);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url.toString()).toBe('https://login.example.net/tenant/oauth2/v2.0/token');
    expect(seen[0].headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(seen[0].headers.Authorization).toBeUndefined();
    expect(Object.fromEntries(new URLSearchParams(seen[0].body!.toString()))).toEqual({
      grant_type: 'client_credentials', scope: 'api://erp/.default', audience: 'https://erp', client_id: 'app id', client_secret: 's3cr+t',
    });
    expect(seen[1].method).toBe('GET');
    expect(seen[1].headers.Authorization).toBe('Bearer tok-1');
  });

  it('can send the client with HTTP basic, each part form-encoded', async () => {
    const { a, seen } = idp();
    await a.fetchRecords({ config: oauth({ oauthClientAuth: 'basic' }), secret: client }, 'part', null);
    expect(seen[0].headers.Authorization).toBe(`Basic ${Buffer.from('app+id:s3cr%2Bt').toString('base64')}`);
    expect(new URLSearchParams(seen[0].body!.toString()).has('client_secret')).toBe(false);
  });

  it('reuses the token until a minute before it expires, and a changed secret never reuses it', async () => {
    const { a, tick, issued } = idp();
    await a.fetchRecords({ config: oauth(), secret: client }, 'part', null);
    await a.fetchRecords({ config: oauth(), secret: client }, 'part', null);
    expect(issued()).toBe(1);
    tick(3600_000 - 61_000);
    await a.fetchRecords({ config: oauth(), secret: client }, 'part', null);
    expect(issued()).toBe(1);
    tick(2_000);
    await a.fetchRecords({ config: oauth(), secret: client }, 'part', null);
    expect(issued()).toBe(2);
    await a.fetchRecords({ config: oauth(), secret: JSON.stringify({ clientId: 'app id', clientSecret: 'other' }) }, 'part', null);
    expect(issued()).toBe(3);
  });

  it('asks again once when the API refuses a cached token', async () => {
    const { a, issued } = idp({ apiRefuses: (t) => t === 'tok-1' });
    await expect(a.fetchRecords({ config: oauth(), secret: client }, 'part', null)).resolves.toMatchObject({ done: true });
    expect(issued()).toBe(2);
    const always = idp({ apiRefuses: () => true });
    await expect(always.a.fetchRecords({ config: oauth(), secret: client }, 'part', null)).rejects.toMatchObject({ kind: 'auth' });
    expect(always.issued()).toBe(2);
  });

  it('names what the sign-in server said, and retries only its own outages', async () => {
    const refused = idp({ tokenAnswer: () => ({ status: 401, json: { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.\r\nTrace' } }) });
    await expect(refused.a.fetchRecords({ config: oauth(), secret: client }, 'part', null)).rejects.toMatchObject({
      kind: 'auth', transient: false, message: 'The sign-in server refused the client (401 invalid_client): AADSTS7000215: Invalid client secret provided. Trace',
    });
    const down = idp({ tokenAnswer: () => ({ status: 503 }) });
    await expect(down.a.fetchRecords({ config: oauth(), secret: client }, 'part', null)).rejects.toMatchObject({ kind: 'transient', transient: true });
    for (const json of [{}, { access_token: 'x', token_type: 'mac' }, { access_token: 'a\r\nb' }]) {
      const odd = idp({ tokenAnswer: () => ({ json }) });
      await expect(odd.a.fetchRecords({ config: oauth(), secret: client }, 'part', null)).rejects.toMatchObject({ kind: 'auth' });
    }
  });

  it('needs a client id and secret, and keeps the token address to allowed public hosts', async () => {
    const { a, seen } = idp();
    for (const secret of [null, 'not json', JSON.stringify({ clientId: 'x' })]) {
      await expect(a.fetchRecords({ config: oauth(), secret }, 'part', null)).rejects.toMatchObject({ kind: 'auth' });
    }
    await expect(a.fetchRecords({ config: oauth(), secret: client, allowedHosts: ['example.com'] }, 'part', null)).rejects.toMatchObject({ kind: 'auth', message: expect.stringMatching(/does not allow connections to login\.example\.net/) });
    await expect(a.fetchRecords({ config: oauth({ oauthTokenUrl: 'http://login.example.net/token' }), secret: client }, 'part', null)).rejects.toMatchObject({ kind: 'auth' });
    expect(seen).toHaveLength(0);
    expect(readRestConfig({ ...base, authType: 'oauth_client' })).toEqual({ ok: false, problem: expect.stringMatching(/token is asked for/) });
    expect(readRestConfig({ ...base, authType: 'oauth_client', oauthTokenUrl: 'https://x.example/t', oauthScope: 'a  b' })).toMatchObject({ ok: false });
  });

  it('says where it signed in when the connection test passes', async () => {
    const { a } = idp();
    expect(await a.testConnection({ config: oauth(), secret: client })).toEqual({ ok: true, message: 'Signed in at login.example.net; The API answered 200 at /api' });
    const refused = idp({ tokenAnswer: () => ({ status: 400, json: { error: 'invalid_scope' } }) });
    expect(await refused.a.testConnection({ config: oauth(), secret: client })).toEqual({ ok: false, message: 'The sign-in server refused the client (400 invalid_scope)' });
  });
});
