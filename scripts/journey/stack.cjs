/**
 * The stack the browser journey runs against (docs/onboarding-plan.md §16): the REAL API (compiled, api/dist) on the REAL migrated database,
 * with two stand-ins for outside services:
 *   - a fake Supabase (auth: sign-up, password sign-in, refresh, user, sign-out, single sign-on with a small company sign-in page; REST: the two reads the app makes; storage: uploads kept in memory, which the
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
  'operator:month': 'price_j_op_month', 'operator:year': 'price_j_op_year',
  'organisation:month': 'price_j_org_month', 'organisation:year': 'price_j_org_year',
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

async function startFakeSupabase(admin, stripe, log, storage, sso) {
  const passwords = new Map(); // email -> password
  const refresh = new Map(); // refresh token -> { uid, claims } (a refreshed token keeps how and when the person signed in, as Supabase does)
  const ssoUsers = new Map(); // user id -> SSO provider id, for the identity Supabase gives a company account ("sso:<provider id>")
  const userJson = (u) => ({ id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: u.email_confirmed_at, created_at: u.created_at, app_metadata: {}, user_metadata: u.raw_user_meta_data ?? {},
    identities: [ssoUsers.has(u.id) ? { id: u.id, provider: `sso:${ssoUsers.get(u.id)}` } : { id: u.id, provider: 'email' }], factors: [] });
  // amr lists how the person signed in, with the time, like Supabase's tokens (the API's single sign-on and session-age rules read it).
  const session = async (u, claims = { amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] }) => {
    const rt = crypto.randomBytes(8).toString('hex');
    refresh.set(rt, { uid: u.id, claims });
    return { access_token: await sign(u, claims), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: rt, user: userJson(u) };
  };
  const html = (res, status, page) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page); };
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
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
        // A signed upload (the API signed it, docs/security-plan.md SE3) lands under the same key as a plain one.
        const key = decodeURIComponent(url.pathname.slice('/storage/v1/object/'.length)).replace(/^upload\/sign\//, '');
        if (req.method === 'POST' || req.method === 'PUT') {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          storage.set(key, multipartFile(Buffer.concat(chunks), req.headers['content-type']));
          return reply(200, { Key: key, Id: crypto.randomUUID() });
        }
        return storage.has(key) ? (res.writeHead(200, cors), res.end(storage.get(key))) : reply(404, { message: 'Object not found' });
      }
      if (url.pathname === '/auth/v1/resend') return reply(200, {});
      // Single sign-on (docs/sso-plan.md SSX): signInWithSSO asks for the company's sign-in page by domain or provider id; the stand-in sends the
      // browser to its own small "identity provider" page, which signs the person in and comes back like Supabase's implicit flow does.
      if (url.pathname === '/auth/v1/sso' && req.method === 'POST') {
        const b = await body(req);
        const provider = b.provider_id ? sso.providers.get(b.provider_id) : [...sso.providers.values()].find((p) => p.domains.includes(String(b.domain ?? '').toLowerCase()));
        if (!provider) return reply(404, { code: 404, error_code: 'sso_provider_not_found', msg: 'No SSO provider assigned for this domain' });
        return reply(200, { url: `http://127.0.0.1:${PORTS.supabase}/idp?provider=${provider.id}&redirect_to=${encodeURIComponent(b.redirect_to ?? '')}` });
      }
      if (url.pathname === '/idp' && req.method === 'GET') {
        const p = url.searchParams;
        return html(res, 200, `<!doctype html><title>Journey company sign-in</title><main><h1>Journey company sign-in</h1>
          <form method="post" action="/idp"><input type="hidden" name="provider" value="${esc(p.get('provider'))}"><input type="hidden" name="redirect_to" value="${esc(p.get('redirect_to'))}">
          <label>Company email <input name="email" type="email"></label> <label>Given name <input name="given"></label> <label>Family name <input name="family"></label>
          <button type="submit">Sign in to your company</button></form></main>`);
      }
      if (url.pathname === '/idp' && req.method === 'POST') {
        let raw = ''; for await (const c of req) raw += c;
        const f = new URLSearchParams(raw);
        const provider = sso.providers.get(f.get('provider'));
        const email = String(f.get('email') ?? '').trim().toLowerCase();
        if (!provider || !provider.domains.includes(email.split('@')[1])) return html(res, 400, '<p>This company does not know that address.</p>');
        let u = (await admin.query('select * from auth.users where lower(email) = $1 and is_sso_user', [email])).rows[0];
        if (!u) {
          // Supabase never links a company account to a password account with the same address: it is a new user (SS0 §12).
          const meta = { given_name: f.get('given') || undefined, family_name: f.get('family') || undefined };
          u = (await admin.query('insert into auth.users (email, raw_user_meta_data, email_confirmed_at, is_sso_user) values ($1, $2, now(), true) returning *', [email, JSON.stringify(meta)])).rows[0];
        }
        await admin.query('update auth.users set last_sign_in_at = now() where id = $1', [u.id]);
        ssoUsers.set(u.id, provider.id);
        const s = await session(u, { amr: [{ method: 'sso/saml', timestamp: Math.floor(Date.now() / 1000), provider: provider.id }] });
        const back = new URLSearchParams({ access_token: s.access_token, refresh_token: s.refresh_token, expires_in: '3600', expires_at: String(s.expires_at), token_type: 'bearer' });
        res.writeHead(303, { Location: `${f.get('redirect_to')}#${back}` });
        return res.end();
      }
      if (url.pathname === '/auth/v1/token' && req.method === 'POST') {
        const b = await body(req);
        if (url.searchParams.get('grant_type') === 'refresh_token') {
          const held = refresh.get(b.refresh_token);
          if (!held) return reply(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' });
          const u = (await admin.query('select * from auth.users where id = $1', [held.uid])).rows[0];
          return reply(200, await session(u, held.claims));
        }
        // A password sign-in is never to a company (SSO) account, as in Supabase.
        const u = (await admin.query('select * from auth.users where lower(email) = lower($1) and not is_sso_user', [b.email])).rows[0];
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
    constructor() { super(); this.enabled = true; this.webhookEnabled = false; this.customers = new Map(); this.sessions = new Map(); this.subs = new Map(); this.invoices = new Map(); this.created = new Map(); this.billing = new Map(); this.n = 0; }
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
      this.subs.set(subId, { id: subId, customerId: s.customerId, status: 'trialing', interval, currency: 'gbp', currentPeriodStart: new Date().toISOString(), currentPeriodEnd: new Date(Date.now() + 14 * 864e5).toISOString(), trialStart: new Date().toISOString(), trialEnd: new Date(Date.now() + 14 * 864e5).toISOString(), cancelAtPeriodEnd: false, canceledAt: null, collectionMethod: 'charge_automatically', items: s.items.map((i, k) => ({ itemId: `si_journey${NONCE}${this.n}_${k}`, priceId: i.priceId, quantity: i.quantity })) });
      s.status = 'complete'; s.subscriptionId = subId;
    }
    async retrieveCheckoutSession(id) { const s = this.sessions.get(id); if (!s) throw new ApiError(502, 'billing_provider_error', 'no such session'); return { id, status: s.status, subscriptionId: s.subscriptionId, customerId: s.customerId, organisationId: s.organisationId }; }
    async retrieveSubscription(id) { return structuredClone(this.subs.get(id)); }
    // Paying by invoice (docs/invoice-billing-plan.md): the company goes on the customer, the subscription is send_invoice with its first invoice open,
    // and the journey pays it (or not) with `pay` before asking the API to read it again (the journey has no webhooks).
    async updateCustomerBilling(customerId, details) { this.billing.set(customerId, details); return { vat: details.vatNumber ? 'verified' : 'none' }; }
    async createInvoiceSubscription(input) {
      const key = `${input.organisationId}:${input.clientKey}`;
      if (this.created.has(key)) return this.created.get(key);
      const subId = `sub_journey_inv${NONCE}${++this.n}`; const invoiceId = `in_journey${NONCE}${++this.n}`;
      const first = PLAN_OF[input.items[0].priceId];
      const interval = PRICES[`${first}:year`] === input.items[0].priceId ? 'year' : 'month';
      const subtotal = input.items.reduce((t, i) => t + i.quantity * 2500, 0);
      this.invoices.set(invoiceId, { id: invoiceId, customerId: input.customerId, subscriptionId: subId, number: `JRN-${String(this.invoices.size + 1).padStart(4, '0')}`, status: 'open', currency: 'gbp', subtotal, tax: 0, total: subtotal,
        periodStart: new Date().toISOString(), periodEnd: new Date(Date.now() + 30 * 864e5).toISOString(), created: new Date().toISOString().slice(0, 10), dueDate: new Date(Date.now() + input.daysUntilDue * 864e5).toISOString().slice(0, 10),
        paidAt: null, pdfUrl: `https://invoice.journey.test/pdf/${invoiceId}`, hostedUrl: `https://invoice.journey.test/i/${invoiceId}`, paymentIntentId: null, paymentStatus: null });
      this.subs.set(subId, { id: subId, customerId: input.customerId, status: 'active', interval, currency: 'gbp', currentPeriodStart: new Date().toISOString(), currentPeriodEnd: new Date(Date.now() + 30 * 864e5).toISOString(), trialStart: null, trialEnd: null,
        cancelAtPeriodEnd: false, canceledAt: null, collectionMethod: 'send_invoice', daysUntilDue: input.daysUntilDue, latestInvoiceId: invoiceId, items: input.items.map((i, k) => ({ itemId: `si_journey_inv${NONCE}${this.n}_${k}`, priceId: i.priceId, quantity: i.quantity })) });
      const result = { subscriptionId: subId, invoiceId }; this.created.set(key, result); return result;
    }
    pay(invoiceId) { const i = this.invoices.get(invoiceId); i.status = 'paid'; i.paidAt = new Date().toISOString(); i.paymentStatus = 'succeeded'; }
    async retrieveInvoice(id) { const i = this.invoices.get(id); if (!i) throw new ApiError(502, 'billing_provider_error', 'no such invoice'); return structuredClone(i); }
    async previewSeatChange(input) { const added = input.items.reduce((n, i) => n + (i.remove ? 0 : i.quantity), 0); return { currency: 'gbp', subtotal: added * 100, tax: added * 20, total: added * 120, amountDue: added * 120, timing: 'now', payment: 'card', lines: [{ description: 'Prorated seats', amount: added * 100 }] }; }
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
  const { InspectionFileStore } = require('../../api/dist/measurement-imports/file-store');
  const { FileLinkSigner } = require('../../api/dist/files/file-links');
  const { SupabaseSsoAdmin } = require('../../api/dist/sso/supabase-sso-admin');
  const { DnsTxtResolver } = require('../../api/dist/sso/dns-txt');
  const { PasswordVerifier } = require('../../api/dist/sso/password-verifier');
  const stripe = makeFakeStripe(StripeGateway, ApiError);
  // Single sign-on stand-ins: Supabase's provider registry (Management API), DNS TXT records the journey "publishes", and the password check.
  const sso = { providers: new Map(), dns: new Map() };
  const ssoAdmin = {
    get enabled() { return true; },
    create: async (metadata, domains) => { const id = crypto.randomUUID(); sso.providers.set(id, { id, domains: [...domains] }); return { id, entityId: `https://idp.journey.test/${id}`, domains }; },
    update: async (id, change) => { const p = sso.providers.get(id); if (change.domains) p.domains = [...change.domains]; return { id, entityId: `https://idp.journey.test/${id}`, domains: p.domains }; },
    remove: async (id) => { sso.providers.delete(id); },
  };
  const dns = { txt: async (name) => { if (!sso.dns.has(name)) throw Object.assign(new Error('no record'), { code: 'ENOTFOUND' }); return sso.dns.get(name); } };
  let fakeSupabase;
  const passwordVerifier = {
    get enabled() { return true; },
    verify: async (email, password) => {
      const u = (await admin.query('select id, email from auth.users where lower(email) = lower($1) and not is_sso_user', [email])).rows[0];
      return u && fakeSupabase.passwords.get(u.email.toLowerCase()) === password ? u.id : null;
    },
  };
  // Uploaded import files: the browser stores them in the stand-in, and the API reads them back from the same place.
  const storage = new Map();
  const fromBucket = (bucket) => ({ get enabled() { return true; }, download: async (p) => (storage.has(`${bucket}/${p}`) ? new Uint8Array(storage.get(`${bucket}/${p}`)) : null) });
  const files = fromBucket('integration-files');
  // File links: the API checks the rule as usual, then "signs" links that point at the stand-in.
  const storageBase = `http://127.0.0.1:${PORTS.supabase}/storage/v1`;
  const signer = {
    get enabled() { return true; },
    signDownload: async (bucket, path) => (storage.has(`${bucket}/${path}`) ? `${storageBase}/object/${bucket}/${path}` : null),
    signUpload: async (bucket, path) => ({ token: 'journey', signedUrl: `${storageBase}/object/upload/sign/${bucket}/${path}?token=journey` }),
    remove: async (bucket, path) => { storage.delete(`${bucket}/${path}`); },
  };
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: dbUrl, SUPABASE_JWT_SECRET: JWT_SECRET, JWT_ISSUER: ISSUER, LOG_LEVEL: 'silent', PORT: String(PORTS.api), CORS_ORIGINS: appUrl, APP_BASE_URL: appUrl, RATE_LIMIT_PER_MINUTE: '100000',
    // One proxy hop, as behind Vercel: the security step sets X-Forwarded-For on the browser's requests to stand for an office and a home network.
    TRUST_PROXY_HOPS: '1' });
  const erp = await startFakeErp(log);
  const { ConnectorRegistry } = require('../../api/dist/integrations/core/connector.registry'); // the provider token to replace
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] })
    .overrideProvider(StripeGateway).useValue(stripe)
    .overrideProvider(IntegrationFileStore).useValue(files)
    .overrideProvider(InspectionFileStore).useValue(fromBucket('inspection-files'))
    .overrideProvider(FileLinkSigner).useValue(signer)
    .overrideProvider(ConnectorRegistry).useValue(erpConnectors(erp))
    .overrideProvider(SupabaseSsoAdmin).useValue(ssoAdmin)
    .overrideProvider(DnsTxtResolver).useValue(dns)
    .overrideProvider(PasswordVerifier).useValue(passwordVerifier)
    .compile();
  const nest = moduleRef.createNestApplication({ bufferLogs: true, rawBody: true });
  const api = configureApp(nest, env);
  await api.init();
  await api.listen(PORTS.api, '127.0.0.1');
  const fake = await startFakeSupabase(admin, stripe, log, storage, sso);
  fakeSupabase = fake;
  const { WorkerService } = require('../../api/dist/worker/worker.service');
  // One worker tick, as pg_cron would call it every minute in production.
  const tick = (budgetMs = 30000) => nest.get(WorkerService).tick({ source: 'manual', budgetMs });
  // The journey has no Stripe webhooks: after the fake pays an invoice this asks the API to read the subscription again, as a webhook or the daily reconcile would.
  const { StripeBillingService } = require('../../api/dist/billing/stripe-billing.service');
  const syncSubscription = (organisationId, subscriptionId) => nest.get(StripeBillingService).syncSubscription(organisationId, subscriptionId, undefined, 'journey');
  return {
    admin, api, stripe, erp, sso, passwords: fake.passwords, ports: PORTS, sign, tick, syncSubscription,
    stop: async () => { await new Promise((r) => fake.server.close(r)); await new Promise((r) => erp.server.close(r)); await api.close(); await admin.end(); },
  };
}

module.exports = { startStack, PORTS };
