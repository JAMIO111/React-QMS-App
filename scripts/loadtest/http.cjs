/** A small API client for the harness: signs tokens like Supabase does (HS256), keeps connections alive, times every call. */
const path = require('path');
const apiRequire = (m) => require(require.resolve(m, { paths: [path.resolve(__dirname, '../../api')] }));
const { SignJWT } = apiRequire('jose');

const ISSUER = 'loadtest-issuer';
const AUDIENCE = 'authenticated';

class ApiError extends Error {
  constructor(status, method, url, body) {
    super(`${method} ${url} answered ${status}: ${String(body).slice(0, 500)}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * @param base    e.g. http://127.0.0.1:3499/api/v1
 * @param secret  the HS256 secret the child API was started with
 * @param orgId   sent as X-Organisation-Id
 * @param recorder optional Recorder; every call is timed under its label
 */
function client({ base, secret, orgId, recorder }) {
  const key = new TextEncoder().encode(secret);
  const tokens = new Map(); // user id -> { token, exp }
  const token = async (userId) => {
    const cached = tokens.get(userId);
    if (cached && cached.exp - Date.now() > 5 * 60_000) return cached.token;
    const exp = Date.now() + 60 * 60_000;
    const t = await new SignJWT({ role: 'authenticated', email: `${userId.slice(-4)}@loadtest.example`, aal: 'aal1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(Math.floor(exp / 1000))
      .sign(key);
    tokens.set(userId, { token: t, exp });
    return t;
  };

  /** `expect`: statuses that are not a problem (a scenario may allow, say, a 409). */
  async function call(userId, method, url, { body, label, expect = [], retries = 0, timeoutMs = 120_000 } = {}) {
    const started = performance.now();
    let status = 0;
    let text = '';
    for (let attempt = 0; ; attempt += 1) {
      try {
        const res = await fetch(base + url, {
          method,
          headers: { Authorization: `Bearer ${await token(userId)}`, 'X-Organisation-Id': orgId, 'X-Time-Zone': 'Europe/London', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        status = res.status;
        text = await res.text();
      } catch (e) {
        status = 0;
        text = e instanceof Error ? e.message : String(e);
      }
      const transient = status === 0 || status === 429 || status === 502 || status === 503 || status === 504;
      if (!transient || attempt >= retries) break;
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
    const ms = performance.now() - started;
    const ok = status >= 200 && status < 300;
    const kind = ok ? 'ok' : expect.includes(status) ? 'expected' : status >= 500 || status === 0 ? 'server' : 'client';
    if (recorder && label) {
      recorder.record(label, ms, status, kind);
      if (kind === 'server' || kind === 'client') recorder.note(label, text);
    }
    if (!ok && kind !== 'expected') throw new ApiError(status, method, url, text);
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status, json, ms, text };
  }

  const as = (userId) => ({
    get: (url, o) => call(userId, 'GET', url, o),
    post: (url, body, o) => call(userId, 'POST', url, { ...o, body: body ?? {} }),
    patch: (url, body, o) => call(userId, 'PATCH', url, { ...o, body }),
    put: (url, body, o) => call(userId, 'PUT', url, { ...o, body }),
  });
  return { as, token, call };
}

module.exports = { client, ApiError, ISSUER, AUDIENCE };
