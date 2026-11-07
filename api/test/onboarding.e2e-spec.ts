/**
 * ON2 through the API: starting an organisation (time zone, country), the set-up wizard (state, marking steps, finishing), the billing gate switch and the lock on a gated
 * organisation (billing and set-up only until a valid subscription with a Controller seat held by an Owner), /me access state, and isolation.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('c8');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const asUser = async (user: string, org?: string) => ({ Authorization: `Bearer ${await token(user)}`, ...(org ? { 'X-Organisation-Id': org } : {}) });
const ctx: Record<string, string> = {};

const setGate = (on: boolean) => admin.query(`update public.platform_settings set value = $1::jsonb where key = 'billing_gate_enabled'`, [on ? 'true' : 'false']);
const me = async (user: string) => (await api().get('/api/v1/me').set(await asUser(user)).expect(200)).body;

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-onboarding');
  await setGate(false);
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});

afterAll(async () => {
  await setGate(false);
  await app?.close();
  await admin?.end();
});

describe('starting an organisation (gate off)', () => {
  it('records the time zone and country, and starts the wizard', async () => {
    const res = await api().post('/api/v1/organisations').set(await asUser(ids.outsider)).send({ name: 'Starter Works', site: { name: 'Plant 1', code: 'p1' }, timeZone: 'Europe/Paris', country: 'fr' }).expect(201);
    ctx.org = res.body.id;
    expect(res.body).toMatchObject({ name: 'Starter Works', country: 'FR', legalName: null });
    const site = await admin.query(`select timezone from public.sites where organisation_id = $1`, [ctx.org]);
    expect(site.rows[0].timezone).toBe('Europe/Paris');
    const membership = (await me(ids.outsider)).memberships.find((m: { organisation: { id: string } }) => m.organisation.id === ctx.org);
    expect(membership).toMatchObject({ accessState: 'open', onboarding: 'in_progress' });
    expect(membership.permissions).toContain('ncr.read');
  });

  it('refuses an unknown time zone and a country that is not two letters', async () => {
    const h = await asUser(ids.outsider);
    expect((await api().post('/api/v1/organisations').set(h).send({ name: 'Bad Zone', timeZone: 'Mars/Olympus' })).status).toBe(409);
    await api().post('/api/v1/organisations').set(h).send({ name: 'Bad Country', country: 'FRA' }).expect(400);
  });

  it('is repeat-safe with an idempotency key', async () => {
    const h = { ...(await asUser(ids.outsider)), 'Idempotency-Key': 'on2-key-1' };
    const a = await api().post('/api/v1/organisations').set(h).send({ name: 'Once Only', timeZone: 'Europe/London' }).expect(201);
    const b = await api().post('/api/v1/organisations').set(h).send({ name: 'Once Only', timeZone: 'Europe/London' }).expect(201);
    expect(b.body.id).toBe(a.body.id);
  });
});

describe('the set-up wizard', () => {
  it('says where things stand; organisation and sites are done at once', async () => {
    const h = await asUser(ids.outsider, ctx.org);
    const state = (await api().get('/api/v1/onboarding').set(h).expect(200)).body;
    expect(state).toMatchObject({ billingRequired: false, accessState: 'open', completedAt: null, sites: 1, canFinish: true });
    expect(state.steps.map((s: { key: string }) => s.key)).toEqual(['organisation', 'plan', 'details', 'sites', 'security', 'team', 'review']);
    expect(state.steps.find((s: { key: string }) => s.key === 'organisation')).toMatchObject({ status: 'done', required: true, auto: true });
    expect(state.steps.find((s: { key: string }) => s.key === 'plan')).toMatchObject({ status: 'pending', required: false });
    expect(state.currentStep).toBe('plan');
  });

  it('saves progress on the steps the owner marks, and refuses the rest', async () => {
    const h = await asUser(ids.outsider, ctx.org);
    const done = (await api().put('/api/v1/onboarding/step').set(h).send({ step: 'details', status: 'done' }).expect(200)).body;
    expect(done.steps.find((s: { key: string }) => s.key === 'details').status).toBe('done');
    const skipped = (await api().put('/api/v1/onboarding/step').set(h).send({ step: 'security', status: 'skipped' }).expect(200)).body;
    expect(skipped.steps.find((s: { key: string }) => s.key === 'security').status).toBe('skipped');
    await api().put('/api/v1/onboarding/step').set(h).send({ step: 'plan', status: 'done' }).expect(400); // worked out, never marked
    await api().put('/api/v1/onboarding/step').set(h).send({ step: 'sites', status: 'done' }).expect(400);
    await api().put('/api/v1/onboarding/step').set(h).send({ step: 'details', status: 'finished' }).expect(400);
    await api().put('/api/v1/onboarding/step').set(h).send({ step: 'details', status: 'done', extra: 1 }).expect(400);
  });

  it('is for the people who can set the organisation up', async () => {
    await api().get('/api/v1/onboarding').set(await asUser(ids.inspectorA, ids.orgA)).expect(403);
    await api().get('/api/v1/onboarding').set(await asUser(ids.outsider, ctx.org)).expect(200);
    await api().get('/api/v1/onboarding').set(await asUser(ids.ownerB, ctx.org)).expect(404);
    await api().put('/api/v1/onboarding/step').set(await asUser(ids.ownerB, ctx.org)).send({ step: 'details', status: 'done' }).expect(404);
    await api().post('/api/v1/onboarding/complete').set(await asUser(ids.ownerB, ctx.org)).expect(404);
  });

  it('gives the go-live checklist: what is in place, what is required, who may see it', async () => {
    const h = await asUser(ids.outsider, ctx.org);
    const c = (await api().get('/api/v1/onboarding/checklist').set(h).expect(200)).body;
    const by = (k: string) => c.items.find((i: { key: string }) => i.key === k);
    expect(c.items.map((i: { key: string }) => i.key)).toEqual(['subscription', 'site', 'departments', 'invited', 'details', 'logo', 'security', 'joined', 'first_ncr']);
    expect(by('site')).toMatchObject({ required: true, done: true });
    expect(by('invited')).toMatchObject({ required: true, done: false });
    expect(by('logo')).toMatchObject({ required: false, done: false });
    expect(by('security')).toMatchObject({ done: true }); // marked skipped in the test above
    expect(c.requiredDone).toBe(false);
    await api().get('/api/v1/onboarding/checklist').set(await asUser(ids.ownerB, ctx.org)).expect(404);
  });

  it('is finished once, and the organisation then shows it complete', async () => {
    const h = await asUser(ids.outsider, ctx.org);
    const done = (await api().post('/api/v1/onboarding/complete').set(h).expect(200)).body;
    expect(done.completedAt).toEqual(expect.any(String));
    const again = await api().post('/api/v1/onboarding/complete').set(h);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('onboarding_rule');
    expect((await me(ids.outsider)).memberships.find((m: { organisation: { id: string } }) => m.organisation.id === ctx.org).onboarding).toBe('complete');
  });

  it('keeps the legal name and country with the organisation', async () => {
    const h = await asUser(ids.outsider, ctx.org);
    const res = (await api().patch('/api/v1/organisations/current').set(h).send({ legalName: 'Starter Works Limited', country: 'gb' }).expect(200)).body;
    expect(res).toMatchObject({ legalName: 'Starter Works Limited', country: 'GB' });
    expect((await api().patch('/api/v1/organisations/current').set(h).send({ legalName: null, country: null }).expect(200)).body).toMatchObject({ legalName: null, country: null });
    await api().patch('/api/v1/organisations/current').set(h).send({ country: 'Britain' }).expect(400);
  });
});

describe('the billing gate', () => {
  beforeAll(async () => {
    await setGate(true);
  });
  afterAll(async () => {
    await setGate(false);
  });

  it('locks a new organisation to billing and set-up, for its owner and its members', async () => {
    const res = await api().post('/api/v1/organisations').set(await asUser(ids.outsider)).send({ name: 'Gated Works', timeZone: 'Europe/London' }).expect(201);
    ctx.gated = res.body.id;
    const m = (await me(ids.outsider)).memberships.find((x: { organisation: { id: string } }) => x.organisation.id === ctx.gated);
    expect(m).toMatchObject({ accessState: 'needs_subscription', onboarding: 'in_progress' });
    expect([...m.permissions].sort()).toEqual(['billing_details.manage', 'invoices.read', 'organisation.manage', 'payment_methods.manage', 'subscription.manage', 'subscription.read', 'subscription.seats']);
    const h = await asUser(ids.outsider, ctx.gated);
    await api().get('/api/v1/ncrs').set(h).expect(403);
    await api().get('/api/v1/members').set(h).expect(403);
    await api().get('/api/v1/subscription').set(h).expect(200); // billing still works
    const state = (await api().get('/api/v1/onboarding').set(h).expect(200)).body;
    expect(state).toMatchObject({ billingRequired: true, accessState: 'needs_subscription', canFinish: false, currentStep: 'plan' });
    expect(state.steps.find((s: { key: string }) => s.key === 'plan')).toMatchObject({ status: 'pending', required: true });
    const refused = await api().post('/api/v1/onboarding/complete').set(h);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/plan/);
  });

  it('leaves existing organisations alone', async () => {
    await api().get('/api/v1/ncrs').set(await asUser(ids.ownerA, ids.orgA)).expect(200);
    expect((await me(ids.ownerA)).memberships.find((x: { organisation: { id: string } }) => x.organisation.id === ids.orgA)).toMatchObject({ accessState: 'open', onboarding: 'none' });
  });

  it('opens when seats are bought and the owner takes a Controller seat', async () => {
    const h = await asUser(ids.outsider, ctx.gated);
    // An organisation that must have a subscription cannot give itself seats by hand: they come from Stripe (here written as the payment provider's sync would).
    const refused = await api().put('/api/v1/subscription/seats').set(h).send({ planSlug: 'controller', quantity: 1 }).expect(409);
    expect(refused.body.error.code).toBe('subscription_rule');
    const { rows: sub } = await admin.query(`insert into public.organisation_subscriptions (organisation_id, current_period_end) values ($1, now() + interval '1 month') returning id`, [ctx.gated]);
    await admin.query(
      `insert into public.organisation_subscription_items (organisation_id, organisation_subscription_id, subscription_plan_id, subscription_price_id, quantity, unit_amount_snapshot, currency)
       select $1, $2, p.id, pr.id, 1, pr.unit_amount, 'GBP' from public.subscription_plans p
         join public.subscription_prices pr on pr.subscription_plan_id = p.id and pr.billing_interval = 'month' and pr.currency = 'GBP' and pr.active and pr.effective_to is null where p.slug = 'controller'`,
      [ctx.gated, sub[0].id],
    );
    expect((await me(ids.outsider)).memberships.find((x: { organisation: { id: string } }) => x.organisation.id === ctx.gated).accessState).toBe('lapsed'); // a subscription, but no seat for the owner yet
    const membership = (await me(ids.outsider)).memberships.find((x: { organisation: { id: string } }) => x.organisation.id === ctx.gated).membershipId;
    await api().put(`/api/v1/subscription/assignments/${membership}`).set(h).send({ planSlug: 'controller' }).expect(200);
    const m = (await me(ids.outsider)).memberships.find((x: { organisation: { id: string } }) => x.organisation.id === ctx.gated);
    expect(m.accessState).toBe('open');
    expect(m.permissions).toContain('ncr.read');
    await api().get('/api/v1/ncrs').set(h).expect(200);
    const done = (await api().post('/api/v1/onboarding/complete').set(h).expect(200)).body;
    expect(done.completedAt).toEqual(expect.any(String));
  });

  it('locks again when the subscription lapses', async () => {
    await admin.query(`update public.organisation_subscriptions set status = 'unpaid' where organisation_id = $1`, [ctx.gated]);
    const h = await asUser(ids.outsider, ctx.gated);
    expect((await me(ids.outsider)).memberships.find((x: { organisation: { id: string } }) => x.organisation.id === ctx.gated).accessState).toBe('lapsed');
    await api().get('/api/v1/ncrs').set(h).expect(403);
    await api().get('/api/v1/subscription').set(h).expect(200);
    await admin.query(`update public.organisation_subscriptions set status = 'active' where organisation_id = $1`, [ctx.gated]);
    await api().get('/api/v1/ncrs').set(h).expect(200);
  });
});
