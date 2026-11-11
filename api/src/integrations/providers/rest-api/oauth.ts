import { createHash } from 'node:crypto';
import { ConnectorError } from '../../core/connector.interface';
import { SafeHttpClient, SafeHttpError } from '../../core/safe-http';
import type { RestConfig } from './rest-config';

/**
 * OAuth 2.0 client credentials (RFC 6749 §4.4) for REST connections (docs/email-oauth-plan.md, O1).
 *
 * - The client id and secret are one Vault credential, JSON `{clientId, clientSecret}`.
 * - The token is asked for through `SafeHttpClient` (https on 443, public addresses only, pinned socket, no redirects, the organisation's allow-list), so the
 *   token address can be a different host from the API (Microsoft Entra, Auth0, Okta…) without opening anything else.
 * - The access token is **kept in memory only**, until a minute before it expires, keyed by a hash of everything that would change it (so a replaced secret
 *   or scope never reuses an old token). It is never stored, logged or returned.
 */

export interface OAuthClientSecret {
  clientId: string;
  clientSecret: string;
}

export function readClientSecret(secret: string | null): OAuthClientSecret {
  if (!secret) throw new ConnectorError('Store the credential for this connection first', 'auth', false);
  let j: Partial<OAuthClientSecret> = {};
  try {
    j = JSON.parse(secret) as Partial<OAuthClientSecret>;
  } catch {
    // checked when the credential was stored
  }
  if (typeof j.clientId !== 'string' || !j.clientId || typeof j.clientSecret !== 'string' || !j.clientSecret) {
    throw new ConnectorError('The stored credential needs a client id and a client secret', 'auth', false);
  }
  return { clientId: j.clientId, clientSecret: j.clientSecret };
}

interface Cached {
  token: string;
  expiresAt: number;
}

const MAX_CACHED = 200;
/** A token is used until this long before it expires. */
const EARLY_MS = 60_000;
/** When the server does not say how long a token lasts. */
const DEFAULT_LIFETIME_S = 300;

const errorText = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.trim() ? v.trim().replace(/[\r\n]+/g, ' ').slice(0, max) : null);

export class OAuthTokens {
  private readonly cache = new Map<string, Cached>();

  constructor(
    private readonly http: SafeHttpClient,
    private readonly now: () => number = Date.now,
  ) {}

  private key(config: RestConfig, client: OAuthClientSecret): string {
    return createHash('sha256')
      .update(JSON.stringify([config.oauthTokenUrl, config.oauthScope ?? '', config.oauthAudience ?? '', config.oauthClientAuth ?? 'body', client.clientId, client.clientSecret]))
      .digest('hex');
  }

  /** Forget the token for this connection (the API refused it). */
  drop(config: RestConfig, secret: string | null): void {
    try {
      this.cache.delete(this.key(config, readClientSecret(secret)));
    } catch {
      // nothing cached for a credential that cannot be read
    }
  }

  /** A valid access token: the cached one, or a new one from the token address. */
  async token(config: RestConfig, secret: string | null, allowedHosts?: string[]): Promise<string> {
    const client = readClientSecret(secret);
    const key = this.key(config, client);
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt - EARLY_MS > this.now()) return hit.token;
    this.cache.delete(key);

    let url: URL;
    try {
      url = new URL(config.oauthTokenUrl ?? '');
    } catch {
      throw new ConnectorError('The token address is not a valid address', 'auth', false);
    }
    const form: Record<string, string> = { grant_type: 'client_credentials' };
    if (config.oauthScope) form.scope = config.oauthScope;
    if (config.oauthAudience) form.audience = config.oauthAudience;
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'Fortress-QMS-Connector/1' };
    if ((config.oauthClientAuth ?? 'body') === 'basic') {
      // RFC 6749 §2.3.1: both parts form-encoded before they are joined.
      const enc = (v: string) => encodeURIComponent(v).replace(/%20/g, '+');
      headers.Authorization = `Basic ${Buffer.from(`${enc(client.clientId)}:${enc(client.clientSecret)}`, 'utf8').toString('base64')}`;
    } else {
      form.client_id = client.clientId;
      form.client_secret = client.clientSecret;
    }

    let res;
    try {
      res = await this.http.postForm(url, form, { headers, timeoutMs: (config.timeoutSeconds ?? 30) * 1000, maxBytes: 64 * 1024, allowedHosts });
    } catch (e) {
      if (e instanceof SafeHttpError) {
        const retry = e.kind === 'timeout' || e.kind === 'network';
        throw new ConnectorError(`The sign-in server: ${e.message}`, retry ? 'transient' : 'auth', retry);
      }
      throw e;
    }

    let body: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(res.body.toString('utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      // judged below
    }
    if (res.status === 429 || res.status >= 500) throw new ConnectorError(`The sign-in server had a problem (${res.status})`, 'transient', true);
    if (res.status < 200 || res.status >= 300) {
      const code = errorText(body.error, 60);
      const why = errorText(body.error_description);
      throw new ConnectorError(`The sign-in server refused the client (${res.status}${code ? ` ${code}` : ''})${why ? `: ${why}` : ''}`, 'auth', false);
    }
    const token = body.access_token;
    if (typeof token !== 'string' || !token || token.length > 8000 || /[\r\n]/.test(token)) throw new ConnectorError('The sign-in server did not give an access token', 'auth', false);
    const type = body.token_type;
    if (type !== undefined && (typeof type !== 'string' || type.toLowerCase() !== 'bearer')) throw new ConnectorError(`The sign-in server gave a ${String(type)} token; only bearer tokens are supported`, 'auth', false);
    const lifetime = Number(body.expires_in);
    const seconds = Number.isFinite(lifetime) && lifetime > 0 ? Math.min(lifetime, 24 * 3600) : DEFAULT_LIFETIME_S;

    if (this.cache.size >= MAX_CACHED) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, { token, expiresAt: this.now() + seconds * 1000 });
    return token;
  }
}
