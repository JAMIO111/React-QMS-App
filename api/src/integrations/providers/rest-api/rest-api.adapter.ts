import { AdapterContext, ConnectionTestResult, ConnectorAdapter, ConnectorError, ConnectorMetadata, FetchResult } from '../../core/connector.interface';
import { SafeHttpClient, SafeHttpError, SafeResponse } from '../../core/safe-http';
import { atPath, joinUrl, readRestConfig, RestConfig, RestEntity } from './rest-config';

/** Most records taken from one answer, and most pages in one import (a guard against an API that never says it is done). */
export const MAX_RECORDS_PER_PAGE = 1000;
export const MAX_PAGES = 10_000;
const MAX_KEYS = 500;
const MAX_DEPTH = 5;
const MAX_CELL = 10_000;
const MAX_CURSOR = 2000;

/** Where a run is: pages done, how to ask for the next one, the high-water mark the run started from and the highest seen so far. */
interface CursorState {
  n?: number;
  page?: number;
  offset?: number;
  token?: string;
  link?: string;
  w?: string;
  m?: string;
}

function readCursor(cursor: string | null): CursorState {
  if (!cursor) return {};
  try {
    const c = JSON.parse(cursor) as CursorState;
    return c && typeof c === 'object' && !Array.isArray(c) ? c : {};
  } catch {
    // A cursor from before (or from somewhere else) is only a high-water mark.
    return { w: cursor };
  }
}

/** One record as flat text: nested objects become dotted keys ("address.city"), lists of plain values are joined with ", ", anything deeper is JSON. */
export function flattenRecord(record: Record<string, unknown>): Record<string, string> {
  const out: Array<[string, string]> = [];
  const cell = (v: unknown) => {
    const s = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return s.length > MAX_CELL ? s.slice(0, MAX_CELL) : s;
  };
  const walk = (value: unknown, key: string, depth: number) => {
    if (out.length >= MAX_KEYS) return;
    if (value === null || value === undefined) return void out.push([key, '']);
    if (Array.isArray(value)) {
      const plain = value.every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x));
      return void out.push([key, plain ? value.filter((x) => x !== null).map(String).join(', ') : cell(value)]);
    }
    if (typeof value === 'object') {
      if (depth >= MAX_DEPTH) return void out.push([key, cell(value)]);
      for (const k of Object.keys(value as object)) walk((value as Record<string, unknown>)[k], key ? `${key}.${k}` : k, depth + 1);
      return;
    }
    out.push([key, cell(value)]);
  };
  walk(record, '', 0);
  return Object.fromEntries(out);
}

const greater = (a: string, b: string | undefined) => {
  if (b === undefined || b === '') return true;
  const x = Number(a);
  const y = Number(b);
  if (a.trim() !== '' && b.trim() !== '' && Number.isFinite(x) && Number.isFinite(y)) return x > y;
  return a > b;
};

/** Seconds to wait from a Retry-After header (seconds or an HTTP date), at most an hour. */
export function retryAfterSeconds(header: string | undefined): number | undefined {
  if (!header) return undefined;
  const n = Number(header);
  if (Number.isFinite(n) && n >= 0) return Math.min(Math.ceil(n), 3600);
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.min(Math.max(Math.ceil((at - Date.now()) / 1000), 1), 3600);
  return undefined;
}

/** The next-page link in a Link header ('<https://…>; rel="next"'). */
function linkHeaderNext(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(',')) {
    const m = /<([^>]+)>\s*;(.*)$/.exec(part.trim());
    if (m && /(^|;)\s*rel\s*=\s*"?([^";]*\s)?next(\s[^";]*)?"?\s*(;|$)/i.test(m[2])) return m[1];
  }
  return undefined;
}

const RUN_ERROR = (e: SafeHttpError): ConnectorError => {
  switch (e.kind) {
    case 'timeout':
      return new ConnectorError(e.message, 'timeout', true);
    case 'network':
      return new ConnectorError(e.message, 'transient', true);
    case 'too_large':
      return new ConnectorError(`${e.message} (10 MB per answer): ask for smaller pages`, 'limit', false);
    case 'redirect':
      return new ConnectorError(e.message, 'malformed', false);
    default:
      return new ConnectorError(e.message, 'limit', false);
  }
};

/**
 * Generic REST connector (IN7, connectors plan §8). Reads records page by page with a GET per page, through `SafeHttpClient` only (https, public addresses
 * only, the checked address pinned, no redirects, timeouts and a size cap). Signs in with an API key header, a bearer token or a basic user name and password
 * from the credential in Vault. Pages by page number, offset, a cursor token from the answer, or a next link (in the answer or the Link header — which must
 * stay on the connection's own address). An incremental import sends the highest value of a chosen field seen by the last finished import. 429 and 5xx are
 * tried again later (Retry-After honoured); 401 and 403 stop the import. Every record is flattened to text so the mapping reads it like a file's row.
 */
export class RestApiAdapter implements ConnectorAdapter {
  constructor(private readonly http: SafeHttpClient = new SafeHttpClient()) {}

  getMetadata(): ConnectorMetadata {
    return { key: 'rest_api', name: 'REST API', kind: 'api', authTypes: ['api_key', 'bearer', 'basic'], capabilities: { testable: true, incremental: true, webhooks: false, writeBack: false } };
  }

  private headers(config: RestConfig, secret: string | null): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'Fortress-QMS-Connector/1' };
    const auth = config.authType ?? 'none';
    if (auth === 'none') return headers;
    if (!secret) throw new ConnectorError('Store the credential for this connection first', 'auth', false);
    if (auth === 'api_key') headers[config.apiKeyHeader ?? 'X-Api-Key'] = secret;
    else if (auth === 'bearer') headers.Authorization = `Bearer ${secret}`;
    else {
      let u: { username?: string; password?: string } = {};
      try {
        u = JSON.parse(secret) as typeof u;
      } catch {
        // checked when the credential was stored
      }
      if (!u.username || !u.password) throw new ConnectorError('The stored sign-in needs a user name and a password', 'auth', false);
      headers.Authorization = `Basic ${Buffer.from(`${u.username}:${u.password}`, 'utf8').toString('base64')}`;
    }
    return headers;
  }

  private async get(config: RestConfig, url: URL, headers: Record<string, string>, allowedHosts?: string[]): Promise<SafeResponse> {
    return this.http.get(url, { headers, timeoutMs: (config.timeoutSeconds ?? 30) * 1000, allowedHosts });
  }

  async testConnection(ctx: AdapterContext): Promise<ConnectionTestResult> {
    const read = readRestConfig(ctx.config);
    if (!read.ok) return { ok: false, message: read.problem };
    const config = read.config;
    let headers: Record<string, string>;
    try {
      headers = this.headers(config, ctx.secret);
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
    try {
      const url = joinUrl(config.baseUrl, config.testPath);
      const res = await this.get(config, url, headers, ctx.allowedHosts);
      if (res.status >= 200 && res.status < 300) return { ok: true, message: `The API answered ${res.status} at ${url.pathname}` };
      if (res.status === 401 || res.status === 403) return { ok: false, message: `The API refused the credential (${res.status})` };
      return { ok: false, message: `The API answered ${res.status} at ${url.pathname}` };
    } catch (e) {
      return { ok: false, message: e instanceof SafeHttpError || e instanceof Error ? e.message : 'The API could not be reached' };
    }
  }

  async fetchRecords(ctx: AdapterContext, entity: string, cursor: string | null): Promise<FetchResult> {
    const read = readRestConfig(ctx.config);
    if (!read.ok) throw new ConnectorError(`The connection's settings are not valid: ${read.problem}`, 'mapping', false);
    const config = read.config;
    const spec: RestEntity | undefined = config.entities && Object.prototype.hasOwnProperty.call(config.entities, entity) ? config.entities[entity] : undefined;
    if (!spec) throw new ConnectorError(`This connection does not say where to read ${entity.replace(/_/g, ' ')} records`, 'mapping', false);
    const headers = this.headers(config, ctx.secret);
    const state = readCursor(cursor);
    const n = state.n ?? 0;
    if (n >= MAX_PAGES) throw new ConnectorError(`An import reads at most ${MAX_PAGES.toLocaleString('en-GB')} pages`, 'limit', false);
    const paging = spec.paging ?? { style: 'none' as const };
    const size = paging.pageSize ?? 100;

    // The address of this page: a next link handed back by the API (same address only), else the path with its parameters.
    let url: URL;
    const base = joinUrl(config.baseUrl, spec.path);
    if (state.link) {
      try {
        url = new URL(state.link, base);
      } catch {
        throw new ConnectorError('The API gave a next-page link that is not an address', 'malformed', false);
      }
      if (url.origin !== base.origin) throw new ConnectorError(`The API's next-page link goes to another address (${url.host}), which is not followed`, 'limit', false);
    } else {
      url = base;
      for (const [k, v] of Object.entries(spec.query ?? {})) url.searchParams.set(k, v);
      if (spec.incremental && state.w) url.searchParams.set(spec.incremental.param, state.w);
      if (paging.style === 'page') {
        url.searchParams.set(paging.pageParam ?? 'page', String(state.page ?? paging.firstPage ?? 1));
        url.searchParams.set(paging.sizeParam ?? 'per_page', String(size));
      } else if (paging.style === 'offset') {
        url.searchParams.set(paging.offsetParam ?? 'offset', String(state.offset ?? 0));
        url.searchParams.set(paging.limitParam ?? 'limit', String(size));
      } else if (paging.style === 'cursor') {
        if (state.token) url.searchParams.set(paging.cursorParam ?? 'cursor', state.token);
        if (paging.sizeParam) url.searchParams.set(paging.sizeParam, String(size));
      } else if (paging.style === 'next_link' && paging.sizeParam) {
        url.searchParams.set(paging.sizeParam, String(size));
      }
    }

    let res: SafeResponse;
    try {
      res = await this.get(config, url, headers, ctx.allowedHosts);
    } catch (e) {
      if (e instanceof SafeHttpError) throw RUN_ERROR(e);
      throw e;
    }
    const where = `${url.pathname}`;
    if (res.status === 401 || res.status === 403) throw new ConnectorError(`The API refused the credential (${res.status})`, 'auth', false);
    if (res.status === 429) throw new ConnectorError('The API asked us to slow down (429)', 'rate_limit', true, retryAfterSeconds(res.headers['retry-after']));
    if (res.status === 408 || res.status >= 500) throw new ConnectorError(`The API had a problem (${res.status}) at ${where}`, 'transient', true, retryAfterSeconds(res.headers['retry-after']));
    if (res.status < 200 || res.status >= 300) throw new ConnectorError(`The API answered ${res.status} at ${where}`, 'malformed', false);

    let body: unknown;
    try {
      body = JSON.parse(res.body.toString('utf8'));
    } catch {
      throw new ConnectorError(`The API's answer at ${where} is not JSON`, 'malformed', false);
    }
    const list = atPath(body, spec.recordsPath);
    if (!Array.isArray(list)) throw new ConnectorError(spec.recordsPath ? `The answer has no list of records at "${spec.recordsPath}"` : 'The answer is not a list of records: say where the list is', 'malformed', false);
    if (list.length > MAX_RECORDS_PER_PAGE) throw new ConnectorError(`A page holds at most ${MAX_RECORDS_PER_PAGE} records; ask for smaller pages`, 'limit', false);
    const records = list.map((r, i) => {
      if (r === null || typeof r !== 'object' || Array.isArray(r)) throw new ConnectorError(`Record ${i + 1} of the page is not an object`, 'malformed', false);
      return { payload: flattenRecord(r as Record<string, unknown>) };
    });

    // The highest value of the incremental field seen in this run.
    let m = state.m;
    if (spec.incremental) {
      for (const r of records) {
        const v = r.payload[spec.incremental.field];
        if (v !== undefined && v !== '' && greater(v, m)) m = v;
      }
    }

    // Is there another page?
    const next: CursorState = { n: n + 1, w: state.w, m };
    let more = false;
    if (paging.style === 'page') {
      more = records.length >= size && records.length > 0;
      next.page = (state.page ?? paging.firstPage ?? 1) + 1;
    } else if (paging.style === 'offset') {
      more = records.length >= size && records.length > 0;
      next.offset = (state.offset ?? 0) + records.length;
    } else if (paging.style === 'cursor') {
      const token = atPath(body, paging.nextCursorPath);
      if ((typeof token === 'string' && token !== '') || typeof token === 'number') {
        next.token = String(token);
        more = next.token !== state.token;
      }
    } else if (paging.style === 'next_link') {
      const link = paging.nextLinkPath === 'header' ? linkHeaderNext(res.headers.link) : atPath(body, paging.nextLinkPath);
      if (typeof link === 'string' && link !== '') {
        next.link = link;
        more = link !== state.link;
      }
    }
    if (more && records.length === 0) more = false;

    if (more) {
      const encoded = JSON.stringify(next);
      if (encoded.length > MAX_CURSOR) throw new ConnectorError('The API\'s next-page cursor is too long', 'limit', false);
      return { records, nextCursor: encoded, done: false };
    }
    // The last page: what the next incremental import starts from (nothing to remember for a source that cannot filter).
    const mark = spec.incremental ? (m ?? state.w) : undefined;
    const last = mark ? JSON.stringify({ w: mark }) : null;
    if (last && last.length > MAX_CURSOR) throw new ConnectorError(`The values of ${spec.incremental!.field} are too long to remember for the next import`, 'limit', false);
    return { records, nextCursor: last, done: true };
  }
}
