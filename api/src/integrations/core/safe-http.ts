import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

/**
 * The only way Fortress calls a customer's server (connectors plan §8, SSRF defence). Every request from a connector goes through `safeFetch`:
 *
 * - **https only**, port 443 only, no user name or password in the address, a host name (never an IP literal) that is not `localhost` or an internal suffix;
 * - the host name is **resolved here** and every address it resolves to must be public: loopback, private (RFC 1918, CGNAT), link-local (incl. the cloud
 *   metadata address 169.254.169.254), unique-local and other special ranges are refused, for IPv4, IPv6 and IPv4-mapped IPv6 alike;
 * - the socket connects to **the address that was checked** (the lookup handed to the TLS socket is the guarded one, so a DNS answer cannot change between the
 *   check and the connection — no rebinding), while the certificate is still verified against the host name;
 * - **redirects are never followed**: a 3xx answer is an error naming the problem;
 * - the request and the answer are bounded: connect timeout, overall timeout, response size cap (the body is dropped as soon as it is over the cap);
 * - the caller cannot set `Host` or any hop-by-hop header.
 *
 * The pieces are injectable (`resolve`, `addressAllowed`, `send`) so tests can point a public-looking name at a local fake server; production uses none of that.
 */

export class SafeHttpError extends Error {
  constructor(
    message: string,
    /** `blocked`: refused by the SSRF rules (never retried). `timeout` / `network`: the server could not be reached in time (tried again later). `too_large`, `redirect`: the answer was refused. */
    readonly kind: 'blocked' | 'timeout' | 'network' | 'too_large' | 'redirect',
  ) {
    super(message);
  }
}

export interface SafeResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface SendRequest {
  url: URL;
  address: ResolvedAddress;
  headers: Record<string, string>;
  connectTimeoutMs: number;
  timeoutMs: number;
  maxBytes: number;
}

export interface SafeHttpOptions {
  /** Resolve a host name to every address it has (default: the system resolver, all addresses). */
  resolve?: (host: string) => Promise<ResolvedAddress[]>;
  /** Whether an address may be connected to (default: public addresses only). */
  addressAllowed?: (address: string) => boolean;
  /** Send the request to the checked address (default: https with the address pinned). */
  send?: (req: SendRequest) => Promise<SafeResponse>;
}

export interface SafeFetchOptions {
  headers?: Record<string, string>;
  /** Overall time allowed for the request, in milliseconds (default 30 s, at most 60 s). */
  timeoutMs?: number;
  /** Largest answer accepted, in bytes (default and maximum 10 MB). */
  maxBytes?: number;
  /** Host names the organisation allows (empty: any public host). An entry allows that host and its sub-domains. */
  allowedHosts?: string[];
}

export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 10_000;

// ---- addresses -----------------------------------------------------------------------------------------------------------

const blocked = new BlockList();
// IPv4: "this network", private, CGNAT, loopback, link-local (incl. 169.254.169.254 metadata), IETF protocol assignments, documentation, benchmarking, multicast, reserved, broadcast.
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, prefix, 'ipv4');
// IPv6: unspecified, loopback, IPv4-compatible/-mapped/-translated (checked again as IPv4 below), discard, Teredo, documentation, 6to4, unique-local (incl. fd00:ec2::254 metadata), link-local, site-local, multicast.
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) blocked.addSubnet(net, prefix, 'ipv6');

/** The IPv4 address inside an IPv4-mapped (::ffff:a.b.c.d or ::ffff:hhhh:hhhh) IPv6 address, if it is one. */
function mappedIPv4(address: string): string | null {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (m) return m[1];
  const h = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (h) {
    const a = parseInt(h[1], 16);
    const b = parseInt(h[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return null;
}

/** True only for an address on the public internet. Anything that is not a valid IP address is not public. */
export function isPublicAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = isIP(bare);
  if (family === 4) return !blocked.check(bare, 'ipv4');
  if (family === 6) {
    const v4 = mappedIPv4(bare.toLowerCase());
    if (v4) return isIP(v4) === 4 && !blocked.check(v4, 'ipv4');
    return !blocked.check(bare, 'ipv6');
  }
  return false;
}

// ---- addresses (the URL) -------------------------------------------------------------------------------------------------

const HOST_NAME = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const INTERNAL_SUFFIX = /\.(local|localhost|internal|lan|home|corp|intranet)$/;

/** Why a URL may not be called at all (before any lookup), or null. The same rules as the database's `app.integration_url_problem`. */
export function urlProblem(url: URL): string | null {
  if (url.protocol !== 'https:') return 'The address must start with https://';
  if (url.username || url.password) return 'The address must not contain a user name or password';
  if (url.port && url.port !== '443') return 'The address must not use a port other than 443';
  const host = url.hostname.toLowerCase();
  if (isIP(host.replace(/^\[|\]$/g, ''))) return 'The address must use a host name, not an IP address';
  if (!HOST_NAME.test(host)) return 'The address must use a host name';
  if (host === 'localhost' || INTERNAL_SUFFIX.test(host)) return 'The address must be a public host name';
  return null;
}

/** Whether the organisation's allow-list (empty: everything public) lets this host through. */
export function hostAllowed(host: string, allowedHosts: string[] | undefined): boolean {
  if (!allowedHosts || allowedHosts.length === 0) return true;
  const h = host.toLowerCase();
  return allowedHosts.some((a) => {
    const e = a.toLowerCase().replace(/^\.+/, '');
    return h === e || h.endsWith(`.${e}`);
  });
}

// ---- headers ------------------------------------------------------------------------------------------------------------------

/** Headers a connection may never set: they would change where or how the request is sent. */
export const FORBIDDEN_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'te', 'upgrade', 'keep-alive', 'expect', 'cookie', 'proxy-authorization', 'proxy-connection', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip']);
const HEADER_NAME = /^[A-Za-z0-9-]{1,60}$/;

export function headerProblem(name: string): string | null {
  if (!HEADER_NAME.test(name)) return 'A header name is letters, digits and hyphens';
  if (FORBIDDEN_HEADERS.has(name.toLowerCase()) || name.toLowerCase().startsWith('proxy-')) return `The ${name} header cannot be set by a connection`;
  return null;
}

// ---- defaults -----------------------------------------------------------------------------------------------------------------

const systemResolve = (host: string): Promise<ResolvedAddress[]> =>
  new Promise((resolve, reject) =>
    dnsLookup(host, { all: true, verbatim: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 })));
    }),
  );

/** https with the socket pinned to the address that was checked; the certificate is verified against the host name. No proxy, no redirects, no agent reuse. */
const pinnedHttpsSend = (req: SendRequest): Promise<SafeResponse> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, value?: SafeResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(overall);
      if (error) reject(error);
      else resolve(value!);
    };
    const r = httpsRequest(
      {
        protocol: 'https:',
        host: req.url.hostname,
        servername: req.url.hostname,
        port: 443,
        method: 'GET',
        path: `${req.url.pathname}${req.url.search}`,
        headers: { ...req.headers, host: req.url.host },
        agent: false,
        // The lookup Node uses for this socket answers with the checked address only.
        lookup: (_host, _opts, callback) => (callback as (e: Error | null, a: string, f: number) => void)(null, req.address.address, req.address.family),
        rejectUnauthorized: true,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > req.maxBytes) {
          res.destroy();
          r.destroy();
          return finish(new SafeHttpError('The answer is larger than allowed', 'too_large'));
        }
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > req.maxBytes) {
            res.destroy();
            r.destroy();
            return finish(new SafeHttpError('The answer is larger than allowed', 'too_large'));
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
          finish(null, { status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
        });
        res.on('error', () => finish(new SafeHttpError('The connection was interrupted', 'network')));
      },
    );
    const overall = setTimeout(() => {
      r.destroy();
      finish(new SafeHttpError('The server did not answer in time', 'timeout'));
    }, req.timeoutMs);
    r.setTimeout(req.connectTimeoutMs, () => {
      r.destroy();
      finish(new SafeHttpError('The server did not answer in time', 'timeout'));
    });
    r.on('error', (e: NodeJS.ErrnoException) =>
      finish(
        e.code && /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME|ERR_TLS/i.test(e.code)
          ? new SafeHttpError('The server\'s certificate could not be trusted', 'blocked')
          : new SafeHttpError('The server could not be reached', 'network'),
      ),
    );
    r.end();
  });

// ---- the call -----------------------------------------------------------------------------------------------------------------

export class SafeHttpClient {
  private readonly resolve: (host: string) => Promise<ResolvedAddress[]>;
  private readonly addressAllowed: (address: string) => boolean;
  private readonly send: (req: SendRequest) => Promise<SafeResponse>;

  constructor(options: SafeHttpOptions = {}) {
    this.resolve = options.resolve ?? systemResolve;
    this.addressAllowed = options.addressAllowed ?? isPublicAddress;
    this.send = options.send ?? pinnedHttpsSend;
  }

  /** GET a URL under the rules above. Throws `SafeHttpError`; any HTTP status (other than a redirect) is returned for the caller to judge. */
  async get(url: URL, options: SafeFetchOptions = {}): Promise<SafeResponse> {
    const problem = urlProblem(url);
    if (problem) throw new SafeHttpError(problem, 'blocked');
    if (!hostAllowed(url.hostname, options.allowedHosts)) throw new SafeHttpError(`Your organisation does not allow connections to ${url.hostname}`, 'blocked');
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      const hp = headerProblem(name);
      if (hp) throw new SafeHttpError(hp, 'blocked');
      if (/[\r\n]/.test(value)) throw new SafeHttpError(`The ${name} header holds a line break`, 'blocked');
      headers[name] = value;
    }

    let addresses: ResolvedAddress[];
    try {
      addresses = await this.resolve(url.hostname);
    } catch {
      throw new SafeHttpError(`${url.hostname} could not be found`, 'network');
    }
    if (addresses.length === 0) throw new SafeHttpError(`${url.hostname} could not be found`, 'network');
    // Every address must be public: a name that also points inside a network is refused, whichever address would have been used.
    if (addresses.some((a) => !this.addressAllowed(a.address))) throw new SafeHttpError(`${url.hostname} points to a private or reserved network address, which is not allowed`, 'blocked');

    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 30_000, 1_000), 60_000);
    const maxBytes = Math.min(options.maxBytes ?? MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES);
    const res = await this.send({ url, address: addresses[0], headers, connectTimeoutMs: Math.min(CONNECT_TIMEOUT_MS, timeoutMs), timeoutMs, maxBytes });
    if (res.body.length > maxBytes) throw new SafeHttpError('The answer is larger than allowed', 'too_large');
    if (res.status >= 300 && res.status < 400) {
      throw new SafeHttpError(`The API answered with a redirect (${res.status}); give the final address in the connection instead. Redirects are never followed.`, 'redirect');
    }
    return res;
  }
}
