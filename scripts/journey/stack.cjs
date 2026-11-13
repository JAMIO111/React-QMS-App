/**
 * The stack the browser journey runs against (docs/onboarding-plan.md §16): the REAL API (compiled, api/dist) on the REAL migrated database,
 * with two stand-ins for outside services:
 *   - a fake Supabase (auth: sign-up, password sign-in, refresh, user, sign-out; REST: the two reads the app makes; storage: uploads kept in memory, which the
 *     API's file store reads back for file imports), and
 *   - a fake Stripe gateway (Checkout page included) in place of api.stripe.com.
 * Nothing here is used in production. Needs DATABASE_URL and DATABASE_ADMIN_URL (scripts/db-check.sh sets them).
 */
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const apiRequire = (m) => require(require.resolve(m, { paths: [path.resolve(__dirname, '../../api')] }));
const { Pool } = apiRequire('pg');
const { SignJWT, jwtVerify } = apiRequire('jose');

const JWT_SECRET = 'journey-secret-that-is-at-least-32-characters-long';
const ISSUER = 'journey-issuer';
const NONCE = crypto.randomBytes(3).toString('hex');
const PORTS = { supabase: 54331, api: 3401 };

const PRICES = {
  'controller:month': 'price_j_ctrl_month', 'controller:year': 'price_j_ctrl_year',
  'contributor:month': 'price_j_contrib_month', 'contributor:year': 'price_j_contrib_year',
  'observer:month': 'price_j_obs_month', 'observer:year': 'price_j_obs_year',
};
const PLAN_OF = Object.fromEntries(Object.entries(PRICES).map(([k, v]) => [v, k.split(':')[0]]));

function sign(user, extra = {}) {
  return new SignJWT({ role: 'authenticated', email: user.email, aal: 'aal1', session_id: crypto.randomUUID(), ...extra })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(user.id).setIssuer(ISSUER).setAudience('authenticated').setIssuedAt().setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

/** The file of a multipart upload (supabase-js sends a File as form data with one file part). */
function multipartFile(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  if (!m) return buf;
  const boundary = Buffer.from(`--${m[1] ?? m[2]}`);
  let at = buf.indexOf(boundary);
  while (at !== -1) {
    const next = buf.indexOf(boundary, at + boundary.length);
    if (next === -1) break;
    const part = buf.subarray(at + boundary.length, next);
    const headEnd = part.indexOf('\r\n\r\n');
    if (headEnd !== -1 && /filename=/i.test(part.subarray(0, headEnd).toString())) return part.subarray(headEnd + 4, part.length - 2);
    at = next;
  }
  return buf;
}

async function startFakeSupabase(admin, stripe, log, storage) {
  const passwords = new Map(); // email -> password
  const refresh = new Map(); // refresh token -> user id
  const userJson = (u) => ({ id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: u.email_confirmed_at, created_at: u.created_at, app_metadata: {}, user_metadata: u.raw_user_meta_data ?? {}, identities: [{ id: u.id }], factors: [] });
  const session = async (u) => {
    const rt = crypto.randomBytes(8).toString('hex');
    refresh.set(rt, u.id);
    return { access_token: await sign(u), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: rt, user: userJson(u) };
  };
  const body = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } }); });
  const send = (res, status, data, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(data === undefined ? '' : JSON.stringify(data)); };
  const authed = async (req) => {
    const t = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    try { const { payload } = await jwtVerify(t, new TextEncoder().encode(JWT_SECRET), { issuer: ISSUER }); return payload.sub; } catch { return null; }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const cors = { 'Access-Control-Allow-Origin': req.headers.origin ?? '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Expose-Headers': '*', Vary: 'Origin' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const reply = (status, data) => send(res, status, data, cors);
    try {
      // The fake Stripe Checkout page: paying completes the session, then sends the person back.
      if (url.pathname.startsWith('/pay/')) {
        const id = url.pathname.split('/')[2];
        const s = stripe.sessions.get(id);
        if (!s) { res.writeHead(404); return res.end('no such session'); }
        if (url.searchParams.get('cancel')) { res.writeHead(302, { Location: s.cancelUrl }); return res.end(); }
        stripe.complete(id);
        res.writeHead(302, { Location: s.successUrl.replace('{CHECKOUT_SESSION_ID}', id) });
        return res.end();
      }
      if (url.pathname === '/auth/v1/signup' && req.method === 'POST') {
        const b = await body(req);
        const exists = (await admin.query('select 1 from auth.users where lower(email) = lower($1)', [b.email])).rowCount;
        if (exists) return reply(200, userJson({ id: crypto.randomUUID(), email: b.email, created_at: new Date().toISOString(), raw_user_meta_data: {} })); // no enumeration, like Supabase
        const r = await admin.query('insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning *', [b.email, JSON.stringify(b.data ?? {})]);
        passwords.set(b.email.toLowerCase(), b.password);
        return reply(200, userJson(r.rows[0]));
      }
      if (url.pathname.startsWith('/storage/v1/object/')) {
        const key = decodeURIComponent(url.pathname.slice('/storage/v1/object/'.length));
        if (req.method === 'POST' || req.method === 'PUT') {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          storage.set(key, multipartFile(Buffer.concat(chunks), req.headers['content-type']));
          return reply(200, { Key: key, Id: crypto.randomUUID() });
        }
        return storage.has(key) ? (res.writeHead(200, cors), res.end(storage.get(key))) : reply(404, { message: 'Object not found' });
      }
      if (url.pathname === '/auth/v1/resend') return reply(200, {});
      if (url.pathname === '/auth/v1/token' && req.method === 'POST') {
        const b = await body(req);
        if (url.searchParams.get('grant_type') === 'refresh_token') {
          const uid = refresh.get(b.refresh_token);
          if (!uid) return reply(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' });
          const u = (await admin.query('select * from auth.users where id = $1', [uid])).rows[0];
          return reply(200, await session(u));
        }
        const u = (await admin.query('select * from auth.users where lower(email) = lower($1)', [b.email])).rows[0];
        if (!u || passwords.get(u.email.toLowerCase()) !== b.password) return reply(400, { error: 'invalid_grant', error_description: 'Invalid login credentials', error_code: 'invalid_credentials' });
        if (!u.email_confirmed_at) return reply(400, { error: 'invalid_grant', error_description: 'Email not confirmed', error_code: 'email_not_confirmed' });
        return reply(200, await session(u));
      }
      if (url.pathname === '/auth/v1/user') {
        const uid = await authed(req);
        if (!uid) return reply(401, { message: 'invalid JWT' });
        return reply(200, userJson((await admin.query('select * from auth.users where id = $1', [uid])).rows[0]));
      }
      if (url.pathname === '/auth/v1/logout') return reply(204);
      if (url.pathname === '/rest/v1/profiles') {
        const id = (url.searchParams.get('id') ?? '').replace('eq.', '');
        const rows = (await admin.query('select id, first_name, surname, job_title, avatar_path from public.profiles where id = $1', [id])).rows;
        if ((req.headers.accept ?? '').includes('vnd.pgrst.object')) return rows.length ? reply(200, rows[0]) : reply(406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: 'The result contains 0 rows' });
        return reply(200, rows);
      }
      if (url.pathname === '/rest/v1/organisation_users') {
        const uid = (url.searchParams.get('user_id') ?? '').replace('eq.', '');
        const rows = (await admin.query(
          `select m.id, m.status, json_build_object('id', o.id, 'name', o.name, 'slug', o.slug,
             'settings', (select json_build_object('base_currency', s.base_currency, 'vat_rate', s.vat_rate, 'ncr_reference_prefix', s.ncr_reference_prefix) from public.organisation_settings s where s.organisation_id = o.id)) as organisation
           from public.organisation_users m join public.organisations o on o.id = m.organisation_id where m.user_id = $1 and m.status = 'active' and o.status = 'active'`, [uid])).rows;
        return reply(200, rows);
      }
      log(`fake supabase: nothing for ${req.method} ${url.pathname}`);
      return reply(404, { message: 'not found in the journey stand-in' });
    } catch (e) {
      log(`fake supabase error: ${e.stack}`);
      return reply(500, { message: String(e) });
    }
  });
  await new Promise((r) => server.listen(PORTS.supabase, '127.0.0.1', r));
  return { server, passwords };
}

function makeFakeStripe(StripeGateway, ApiError) {
  class FakeStripe extends StripeGateway {
    constructor() { super(); this.enabled = true; this.webhookEnabled = false; this.customers = new Map(); this.sessions = new Map(); this.subs = new Map(); this.n = 0; }
    async createCustomer(input) { const id = `cus_journey${NONCE}${++this.n}`; this.customers.set(id, input); return id; }
    async createCheckoutSession(input) {
      const id = `cs_test_journey${NONCE}${++this.n}`;
      this.sessions.set(id, { status: 'open', customerId: input.customerId, organisationId: input.organisationId, items: input.items, subscriptionId: null, successUrl: input.successUrl, cancelUrl: input.cancelUrl });
      return { id, url: `http://127.0.0.1:${PORTS.supabase}/pay/${id}` };
    }
    complete(sessionId) {
      const s = this.sessions.get(sessionId); const subId = `sub_journey${NONCE}${++this.n}`;
      const first = PLAN_OF[s.items[0].priceId];
      const interval = PRICES[`${first}:year`] === s.items[0].priceId ? 'year' : 'month';
      this.subs.set(subId, { id: subId, customerId: s.customerId, status: 'trialing', interval, currency: 'gbp', currentPeriodStart: new Date().toISOString(), currentPeriodEnd: new Date(Date.now() + 14 * 864e5).toISOString(), trialStart: new Date().toISOString(), trialEnd: new Date(Date.now() + 14 * 864e5).toISOString(), cancelAtPeriodEnd: false, canceledAt: null, items: s.items.map((i, k) => ({ itemId: `si_journey${NONCE}${this.n}_${k}`, priceId: i.priceId, quantity: i.quantity })) });
      s.status = 'complete'; s.subscriptionId = subId;
    }
    async retrieveCheckoutSession(id) { const s = this.sessions.get(id); if (!s) throw new ApiError(502, 'billing_provider_error', 'no such session'); return { id, status: s.status, subscriptionId: s.subscriptionId, customerId: s.customerId, organisationId: s.organisationId }; }
    async retrieveSubscription(id) { return structuredClone(this.subs.get(id)); }
    async retrieveInvoice() { throw new Error('no invoices in the journey'); }
    async previewSeatChange(input) { const added = input.items.reduce((n, i) => n + (i.remove ? 0 : i.quantity), 0); return { currency: 'gbp', subtotal: added * 100, tax: added * 20, total: added * 120, amountDue: added * 120, lines: [{ description: 'Prorated seats', amount: added * 100 }] }; }
    async updateSeats() { /* not used */ }
    async createPortalSession() { return 'http://127.0.0.1/portal'; }
    constructEvent() { throw ApiError.badRequest('invalid_signature', 'webhooks are not part of the journey'); }
  }
  return new FakeStripe();
}

/**
 * A fake ERP for the integrations step (IN9): a REST API at "erp.journey-erp.com" that needs a bearer token and pages its machines. The journey changes
 * `erp.machines` between imports (fix a rejected record, add one). The API's connector is the real one (RestApiAdapter over SafeHttpClient, every rule
 * applied); only DNS (that one name → 127.0.0.1, which is allowed here and nowhere else) and the last hop (plain HTTP to this server) are swapped.
 */
async function startFakeErp(log) {
  const erp = { token: 'journey-erp-token', machines: [], requests: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://erp');
    erp.requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization });
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${erp.token}`) return send(401, { error: 'unauthorised' });
    if (url.pathname === '/api/health') return send(200, { ok: true });
    if (url.pathname === '/api/v1/machines') {
      const page = Number(url.searchParams.get('page') || 1), size = Number(url.searchParams.get('per_page') || 100);
      return send(200, { data: erp.machines.slice((page - 1) * size, page * size), total: erp.machines.length });
    }
    log(`fake erp: nothing for ${url.pathname}`);
    return send(404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  erp.port = server.address().port;
  erp.server = server;
  return erp;
}

function erpConnectors(erp) {
  const { ConnectorRegistry } = require('../../api/dist/integrations/core/connector.registry');
  const { SafeHttpClient, isPublicAddress } = require('../../api/dist/integrations/core/safe-http');
  const { CsvAdapter } = require('../../api/dist/integrations/providers/csv/csv.adapter');
  const { RestApiAdapter } = require('../../api/dist/integrations/providers/rest-api/rest-api.adapter');
  const lastHop = (req) =>
    new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: erp.port, path: `${req.url.pathname}${req.url.search}`, method: 'GET', headers: { ...req.headers, host: req.url.host } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const headers = {};
          for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers[k] = v;
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
        });
      });
      r.on('error', reject);
      r.end();
    });
  const client = new SafeHttpClient({
    resolve: async (host) => { if (host !== 'erp.journey-erp.com') throw new Error('ENOTFOUND'); return [{ address: '127.0.0.1', family: 4 }]; },
    addressAllowed: (a) => a === '127.0.0.1' || isPublicAddress(a),
    send: lastHop,
  });
  return new ConnectorRegistry().register(new CsvAdapter()).register(new RestApiAdapter(client));
}

/** Starts everything but the web app. Returns { admin, api, stripe, passwords, stop }. */
async function startStack({ appUrl, log = console.log }) {
  const dbUrl = process.env.DATABASE_URL, adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!dbUrl || !adminUrl) throw new Error('Run through scripts/db-check.sh (npm run journey): it provides the database.');
  const admin = new Pool({ connectionString: adminUrl });
  // Billing on, prices known: a new organisation is gated until it has paid, as in production.
  await admin.query(`update public.platform_settings set value = 'true'::jsonb where key = 'billing_gate_enabled'`);
  for (const [key, priceId] of Object.entries(PRICES)) {
    const [slug, interval] = key.split(':');
    await admin.query(`update public.subscription_prices set provider_price_id = $1 where active and effective_to is null and currency = 'GBP' and billing_interval = $2 and subscription_plan_id = (select id from public.subscription_plans where slug = $3)`, [priceId, interval, slug]);
  }

  apiRequire('reflect-metadata');
  const { Test } = apiRequire('@nestjs/testing');
  const { AppModule } = require('../../api/dist/app.module');
  const { configureApp } = require('../../api/dist/app.factory');
  const { loadEnv } = require('../../api/dist/config/env');
  const { StripeGateway } = require('../../api/dist/billing/stripe.gateway');
  const { ApiError } = require('../../api/dist/common/api-error');
  const { IntegrationFileStore } = require('../../api/dist/integrations/core/file-store');
  const stripe = makeFakeStripe(StripeGateway, ApiError);
  // Uploaded import files: the browser stores them in the stand-in, and the API reads them back from the same place.
  const storage = new Map();
  const files = { get enabled() { return true; }, download: async (p) => (storage.has(`integration-files/${p}`) ? new Uint8Array(storage.get(`integration-files/${p}`)) : null) };
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: dbUrl, SUPABASE_JWT_SECRET: JWT_SECRET, JWT_ISSUER: ISSUER, LOG_LEVEL: 'silent', PORT: String(PORTS.api), CORS_ORIGINS: appUrl, APP_BASE_URL: appUrl, RATE_LIMIT_PER_MINUTE: '100000' });
  const erp = await startFakeErp(log);
  const { ConnectorRegistry } = require('../../api/dist/integrations/core/connector.registry'); // the provider token to replace
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] })
    .overrideProvider(StripeGateway).useValue(stripe)
    .overrideProvider(IntegrationFileStore).useValue(files)
    .overrideProvider(ConnectorRegistry).useValue(erpConnectors(erp))
    .compile();
  const nest = moduleRef.createNestApplication({ bufferLogs: true, rawBody: true });
  const api = configureApp(nest, env);
  await api.init();
  await api.listen(PORTS.api, '127.0.0.1');
  const fake = await startFakeSupabase(admin, stripe, log, storage);
  const { WorkerService } = require('../../api/dist/worker/worker.service');
  // One worker tick, as pg_cron would call it every minute in production.
  const tick = (budgetMs = 30000) => nest.get(WorkerService).tick({ source: 'manual', budgetMs });
  return {
    admin, api, stripe, erp, passwords: fake.passwords, ports: PORTS, sign, tick,
    stop: async () => { await new Promise((r) => fake.server.close(r)); await new Promise((r) => erp.server.close(r)); await api.close(); await admin.end(); },
  };
}

module.exports = { startStack, PORTS };
