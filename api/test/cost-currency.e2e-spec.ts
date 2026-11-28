/**
 * Costs in more than one currency through the API (docs/cost-currency-plan.md CU-B): published rates looked up and filled in, lines waiting for a rate,
 * stated rates, credits, the dashboard in the site's or the organisation's currency, the register, the preview, the restate and the worker step. The
 * arithmetic and rules are covered by supabase/tests/cost_currency.test.sql; the source of rates is a fake here (no test reaches the network).
 */
import { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { configureApp } from '../src/app.factory';
import { AppModule } from '../src/app.module';
import { ExchangeRateGateway, RateAnswer } from '../src/currency/exchange-rate.gateway';
import { ExchangeRateService } from '../src/currency/exchange-rate.service';
import { WorkerService } from '../src/worker/worker.service';
import { categoryId, makeIds, requireDb, seed, testEnv, token } from './helpers';

class FakeRates extends ExchangeRateGateway {
  down = false;
  calls: string[] = [];
  table: Record<string, number> = {};
  /** The day the source says the rate is for, when it differs from the day asked (a weekend). */
  rateDateFor: Record<string, string> = {};
  async fetch(on: string, base: string, quotes: string[]): Promise<RateAnswer> {
    this.calls.push(`${on} ${base}>${quotes.join(',')}`);
    if (this.down) throw new Error('The source is down');
    return { rateDate: this.rateDateFor[on] ?? on, rates: Object.fromEntries(quotes.map((q) => [q, this.table[`${base}>${q}`] ?? null])) };
  }
}

const ids = makeIds('e9');
const SITE_USER = '90000000-0000-0000-0000-00000000bb77';
const DAY = '2026-10-01';
let app: INestApplication;
let admin: Pool;
let plantB: string;
let ncrA: string;
let ncrB: string;
const fake = new FakeRates();
const api = () => request(app.getHttpServer());
const as = async (user: string, org: string = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const costs = async (ncr: string, h?: Record<string, string>) => (await api().get(`/api/v1/ncrs/${ncr}/costs`).set(h ?? (await as(ids.ownerA))).expect(200)).body;
const addCost = async (ncr: string, body: Record<string, unknown>, expected = 201) =>
  api().post(`/api/v1/ncrs/${ncr}/costs`).set(await as(ids.ownerA)).send({ costType: 'scrap', unitCost: 100, incurredOn: DAY, ...body }).expect(expected);
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** Runs `work` with the source of rates unreachable, and always switches it back on. */
const whileDown = async <T>(work: () => Promise<T>): Promise<T> => {
  fake.down = true;
  try {
    return await work();
  } finally {
    fake.down = false;
  }
};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-fx');
  // The rate cache is global, not per organisation: another suite that ran first may have stored the pairs below, and then the source would never be asked.
  await admin.query('delete from public.exchange_rates');
  const env = testEnv({ RATE_LIMIT_PER_MINUTE: '10000' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).overrideProvider(ExchangeRateGateway).useValue(fake).compile();
  app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, rawBody: true }), env);
  await app.init();
  const one = async (q: string, params: unknown[]) => (await admin.query(q, params)).rows[0];
  await admin.query(`update public.organisation_settings set base_currency = 'GBP', vat_rate = 0.2 where organisation_id = $1`, [ids.orgA]);
  plantB = (await one(`insert into public.sites (organisation_id, code, name, currency) values ($1, 'PB', 'Plant B', 'EUR') returning id`, [ids.orgA])).id;
  await admin.query(`insert into auth.users (id, email) values ($1, 'site.user@fx.test')`, [SITE_USER]);
  const m = await one(`insert into public.organisation_users (organisation_id, user_id, status) values ($1, $2, 'active') returning id`, [ids.orgA, SITE_USER]);
  await admin.query(
    `insert into public.user_role_assignments (organisation_id, membership_id, role_id, site_id) select $1, $2, id, $3 from public.roles where organisation_id = $1 and key = 'quality_engineer'`,
    [ids.orgA, m.id, plantB],
  );
  const h = await as(ids.ownerA);
  ncrA = (await api().post('/api/v1/ncrs').set(h).send({ source: 'internal', title: 'At plant A', siteId: ids.siteA }).expect(201)).body.id;
  ncrB = (await api().post('/api/v1/ncrs').set(h).send({ source: 'internal', title: 'At plant B', siteId: plantB }).expect(201)).body.id;
  Object.assign(fake.table, { 'EUR>GBP': 0.85, 'USD>GBP': 0.79, 'GBP>EUR': 1.17, 'USD>EUR': 0.92 });
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('published rates', () => {
  let eurLine: string;

  it('looks the rate up when a line is saved and answers with it; a rate is no longer accepted from the client', async () => {
    const res = await addCost(ncrA, { currency: 'EUR', description: 'Freight' });
    expect(res.body).toMatchObject({ currency: 'EUR', baseCurrency: 'GBP', orgCurrency: 'GBP', rateStatus: 'estimated', rateSource: 'frankfurter', exchangeRate: 0.85, rateDate: DAY, estimatedRate: 0.85, netBase: 85, netOrg: 85, costSign: 1 });
    eurLine = res.body.id;
    await addCost(ncrA, { currency: 'EUR', exchangeRate: 99 }, 400);
    await api().patch(`/api/v1/ncr-costs/${eurLine}`).set(await as(ids.ownerA)).send({ exchangeRate: 5 }).expect(400);
    expect(fake.calls).toEqual([`${DAY} EUR>GBP`]);
  });

  it('uses the cache for the same day and pair: the source is not asked again', async () => {
    const res = await addCost(ncrA, { currency: 'EUR', unitCost: 40 });
    expect(res.body).toMatchObject({ rateStatus: 'estimated', netBase: 34 });
    expect(fake.calls).toHaveLength(1);
  });

  it('a weekend day carries the business day the rate was published for', async () => {
    fake.rateDateFor['2026-09-27'] = '2026-09-25';
    const res = await addCost(ncrA, { currency: 'EUR', incurredOn: '2026-09-27' });
    expect(res.body).toMatchObject({ rateStatus: 'estimated', rateDate: '2026-09-25', incurredOn: '2026-09-27' });
  });

  it('same-currency lines need no rate', async () => {
    const res = await addCost(ncrA, { currency: 'gbp', unitCost: 10 });
    expect(res.body).toMatchObject({ rateStatus: 'base', rateSource: 'none', exchangeRate: 1, netBase: 10 });
  });

  it('totals are net of credits, in the site currency and the organisation currency, with what was actually spent in each currency', async () => {
    await addCost(ncrA, { currency: 'GBP', costType: 'supplier_recovery', unitCost: 30 });
    const t = (await costs(ncrA)).totals;
    // 85 + 34 + (EUR 100 at 0.85, the weekend one) 85 + 10 − 30
    expect(t).toMatchObject({ baseCurrency: 'GBP', orgCurrency: 'GBP', net: 184, netOrg: 184, count: 5, rates: { base: 2, estimated: 3, actual: 0, needed: 0 } });
    expect(t.byCurrency).toEqual(expect.arrayContaining([{ currency: 'EUR', net: 240, gross: 240, lines: 3 }, { currency: 'GBP', net: -20, gross: -20, lines: 2 }]));
  });

  it('a site in another currency states its lines in that currency, with the organisation figure beside it', async () => {
    const res = await addCost(ncrB, { currency: 'GBP', unitCost: 100 });
    expect(res.body).toMatchObject({ baseCurrency: 'EUR', orgCurrency: 'GBP', rateStatus: 'estimated', exchangeRate: 1.17, netBase: 117, netOrg: 100, orgRate: 1 });
    expect((await costs(ncrB)).totals).toMatchObject({ baseCurrency: 'EUR', orgCurrency: 'GBP', net: 117, netOrg: 100 });
  });

  describe('stating the rate actually got', () => {
    it('by rate: the line becomes actual and keeps the published rate beside it', async () => {
      const res = await api().post(`/api/v1/ncr-costs/${eurLine}/rate`).set(await as(ids.ownerA)).send({ kind: 'rate', value: 0.9, note: 'Bank rate' }).expect(200);
      expect(res.body).toMatchObject({ rateStatus: 'actual', rateSource: 'manual', exchangeRate: 0.9, estimatedRate: 0.85, overrideKind: 'rate', overrideNote: 'Bank rate', netBase: 90, overriddenBy: { id: ids.ownerA } });
      expect((await costs(ncrA)).totals.rates).toMatchObject({ actual: 1, estimated: 2 });
    });

    it('by converted amount: the rate is worked out', async () => {
      const line = (await addCost(ncrA, { currency: 'EUR', unitCost: 50 })).body.id;
      const res = await api().post(`/api/v1/ncr-costs/${line}/rate`).set(await as(ids.ownerA)).send({ kind: 'amount', value: 40 }).expect(200);
      expect(res.body).toMatchObject({ rateStatus: 'actual', overrideKind: 'amount', netBase: 40, exchangeRate: 0.8 });
    });

    it('is refused for nonsense, a line already in the site currency, strangers and people with no rights at that site', async () => {
      const h = await as(ids.ownerA);
      await api().post(`/api/v1/ncr-costs/${eurLine}/rate`).set(h).send({ kind: 'rate', value: 0 }).expect(400);
      await api().post(`/api/v1/ncr-costs/${eurLine}/rate`).set(h).send({ kind: 'percent', value: 1 }).expect(400);
      await api().post(`/api/v1/ncr-costs/${eurLine}/rate`).set(h).send({ kind: 'rate', value: 1, extra: true }).expect(400);
      const gbp = (await costs(ncrA)).data.find((c: { currency: string; costType: string }) => c.currency === 'GBP' && c.costType === 'scrap');
      await api().post(`/api/v1/ncr-costs/${gbp.id}/rate`).set(h).send({ kind: 'rate', value: 1 }).expect(409);
      await api().post(`/api/v1/ncr-costs/${eurLine}/rate`).set(await as(ids.outsider)).send({ kind: 'rate', value: 1 }).expect((r) => expect([403, 404]).toContain(r.status));
      await api().post(`/api/v1/ncr-costs/${eurLine}/rate`).set(await as(SITE_USER)).send({ kind: 'rate', value: 1 }).expect((r) => expect([403, 404]).toContain(r.status));
      await api().post(`/api/v1/ncr-costs/${ids.ncrA}/rate`).set(h).send({ kind: 'rate', value: 1 }).expect(404);
    });

    it('using the automatic rate again drops it; changing the currency drops it too', async () => {
      const h = await as(ids.ownerA);
      const back = await api().post(`/api/v1/ncr-costs/${eurLine}/reset-rate`).set(h).expect(200);
      expect(back.body).toMatchObject({ rateStatus: 'estimated', exchangeRate: 0.85, overrideKind: null, overrideNote: null, netBase: 85 });
      await api().post(`/api/v1/ncr-costs/${eurLine}/rate`).set(h).send({ kind: 'rate', value: 0.9 }).expect(200);
      const changed = await api().patch(`/api/v1/ncr-costs/${eurLine}`).set(h).send({ currency: 'USD' }).expect(200);
      expect(changed.body).toMatchObject({ currency: 'USD', rateStatus: 'estimated', exchangeRate: 0.79, overrideKind: null });
      await api().patch(`/api/v1/ncr-costs/${eurLine}`).set(h).send({ currency: 'EUR' }).expect(200);
    });

    it('editing only the amount keeps the stated rate', async () => {
      const h = await as(ids.ownerA);
      await api().post(`/api/v1/ncr-costs/${eurLine}/rate`).set(h).send({ kind: 'rate', value: 0.9 }).expect(200);
      const res = await api().patch(`/api/v1/ncr-costs/${eurLine}`).set(h).send({ unitCost: 200 }).expect(200);
      expect(res.body).toMatchObject({ rateStatus: 'actual', exchangeRate: 0.9, netAmount: 200, netBase: 180 });
    });
  });
});

describe('lines waiting for a rate', () => {
  it('save as needed when the source is down, add nothing to totals, and are filled when it is back', async () => {
    const before = (await costs(ncrA)).totals;
    const line = (await whileDown(() => addCost(ncrA, { currency: 'USD', unitCost: 100, incurredOn: addDays(DAY, 5) }))).body;
    expect(line).toMatchObject({ rateStatus: 'needed', exchangeRate: null, netBase: null, netOrg: null });
    const during = (await costs(ncrA)).totals;
    expect(during).toMatchObject({ net: before.net, netOrg: before.netOrg, count: before.count + 1, rates: { needed: 1 } });
    expect(during.byCurrency.find((c: { currency: string }) => c.currency === 'USD')).toMatchObject({ net: 100, lines: 1 });
    const result = await app.get(ExchangeRateService).settle(null);
    expect(result.filled).toBeGreaterThanOrEqual(1);
    const after = (await costs(ncrA)).data.find((c: { id: string }) => c.id === line.id);
    expect(after).toMatchObject({ rateStatus: 'estimated', exchangeRate: 0.79, netBase: 79 });
  });

  it('a currency the source does not publish stays needed and is not asked for again', async () => {
    const line = (await addCost(ncrA, { currency: 'AED', unitCost: 100 })).body;
    expect(line.rateStatus).toBe('needed');
    const asked = fake.calls.filter((c) => c.includes('AED')).length;
    expect(asked).toBeGreaterThan(0);
    await app.get(ExchangeRateService).settle(null);
    await app.get(ExchangeRateService).settle(ids.orgA);
    expect(fake.calls.filter((c) => c.includes('AED')).length).toBe(asked);
    expect((await costs(ncrA)).data.find((c: { id: string }) => c.id === line.id).rateStatus).toBe('needed');
    // A person can still state the rate.
    const stated = await api().post(`/api/v1/ncr-costs/${line.id}/rate`).set(await as(ids.ownerA)).send({ kind: 'rate', value: 0.21 }).expect(200);
    expect(stated.body).toMatchObject({ rateStatus: 'actual', netBase: 21 });
  });

  it('the worker tick has a step for them and it never fails the tick', async () => {
    await whileDown(() => addCost(ncrA, { currency: 'USD', unitCost: 1, incurredOn: addDays(DAY, 3) }));
    const tick = await whileDown(() => app.get(WorkerService).tick({ source: 'test', budgetMs: 20_000 }));
    expect(tick.steps.find((s) => s.name === 'exchange-rates')).toMatchObject({ ok: true });
    const again = await app.get(WorkerService).tick({ source: 'test', budgetMs: 20_000 });
    expect(again.steps.find((s) => s.name === 'exchange-rates')).toMatchObject({ ok: true });
    expect((await costs(ncrA)).totals.rates.needed).toBe(0);
  });
});

describe('the preview for the cost form', () => {
  it('says what an automatic conversion would use, and why when there is none', async () => {
    const h = await as(ids.ownerA);
    const get = async (q: string) => (await api().get(`/api/v1/exchange-rates/preview?${q}`).set(h).expect(200)).body;
    expect(await get(`from=EUR&to=GBP&date=${DAY}`)).toMatchObject({ rate: 0.85, rateDate: DAY, state: 'published' });
    expect(await get('from=gbp&to=GBP')).toMatchObject({ rate: 1, state: 'published' });
    expect(await get(`from=AED&to=GBP&date=${DAY}`)).toMatchObject({ rate: null, state: 'not_published' });
    expect(await whileDown(() => get(`from=CHF&to=GBP&date=${DAY}`))).toMatchObject({ rate: null, state: 'unavailable' });
    expect(await get(`from=EUR&to=GBP&date=${addDays(today(), 30)}`)).toMatchObject({ requestedOn: today() });
    await api().get('/api/v1/exchange-rates/preview?from=EURO&to=GBP').set(h).expect(400);
    await api().get('/api/v1/exchange-rates/preview?from=EUR').set(h).expect(400);
    await api().get('/api/v1/exchange-rates/preview?from=EUR&to=GBP').expect(401);
    // Not for anyone who cannot enter costs, and not for days long ago (they would fill the shared rate cache).
    await api().get(`/api/v1/exchange-rates/preview?from=EUR&to=GBP&date=${DAY}`).set(await as(ids.dual)).expect(403);
    await api().get('/api/v1/exchange-rates/preview?from=EUR&to=GBP&date=1999-01-04').set(h).expect(400);
  });
});

describe('dashboard and register', () => {
  // A draft is not raised, so its costs are not on the dashboard: both are opened first (docs/audit-nc-2026-11.md API-3).
  beforeAll(async () => {
    const h = await as(ids.ownerA);
    const cat = await categoryId(admin, ids.orgA);
    for (const id of [ncrA, ncrB]) {
      await api().patch(`/api/v1/ncrs/${id}`).set(h).send({ severity: 'minor', quantityAffected: 1, description: 'x', categoryId: cat }).expect(200);
      await api().post(`/api/v1/ncrs/${id}/transitions`).set(h).send({ to: 'open' }).expect(200);
    }
  });

  const period = () => `from=${addDays(today(), -30)}&to=${addDays(today(), 30)}`;
  const net = async (where: string) => Number((await admin.query(`select coalesce(sum(k.${where} * k.cost_sign), 0) as t from public.ncr_costs k where k.organisation_id = $1 and k.deleted_at is null`, [ids.orgA])).rows[0].t);

  it('shows all sites in the organisation currency, net of credits, and says how many lines add nothing yet', async () => {
    await whileDown(() => addCost(ncrA, { currency: 'CHF', unitCost: 5 })); // waits for a rate; nothing settles it before the checks below
    const res = (await api().get(`/api/v1/ncr-dashboard?${period()}`).set(await as(ids.ownerA)).expect(200)).body;
    expect(res).toMatchObject({ currency: 'GBP', baseCurrency: 'GBP', site: null });
    expect(res.sites.map((s: { code: string }) => s.code).sort()).toHaveLength(2);
    expect(res.kpis.cost).toBeCloseTo(await net('net_org'), 2);
    expect(res.kpis.unconverted).toBe(1);
  });

  it('shows one site in its own currency', async () => {
    const res = (await api().get(`/api/v1/ncr-dashboard?${period()}&siteId=${plantB}`).set(await as(ids.ownerA)).expect(200)).body;
    expect(res).toMatchObject({ currency: 'EUR', site: { id: plantB, currency: 'EUR' } });
    expect(res.kpis.cost).toBe(117);
    expect(res.kpis.raised).toBe(1);
    await api().get(`/api/v1/ncr-dashboard?${period()}&siteId=${ids.siteB}`).set(await as(ids.ownerA)).expect(404);
  });

  it('a person who may read one site only is shown that site without asking', async () => {
    const res = (await api().get(`/api/v1/ncr-dashboard?${period()}`).set(await as(SITE_USER)).expect(200)).body;
    expect(res).toMatchObject({ currency: 'EUR', site: { id: plantB } });
    expect(res.sites).toHaveLength(1);
  });

  it("the register shows each NC's total in its own site's currency and sorts by the organisation-currency value", async () => {
    const res = (await api().get('/api/v1/ncrs?source=internal&sort=totalCost&order=desc').set(await as(ids.ownerA)).expect(200)).body.data;
    const a = res.find((n: { id: string }) => n.id === ncrA);
    const b = res.find((n: { id: string }) => n.id === ncrB);
    expect(b).toMatchObject({ totalCost: 117, costCurrency: 'EUR' });
    expect(a).toMatchObject({ costCurrency: 'GBP' });
    expect(res.findIndex((n: { id: string }) => n.id === ncrA)).toBeLessThan(res.findIndex((n: { id: string }) => n.id === ncrB));
  });
});

describe('restating lines stated in another currency', () => {
  let legacy: string;
  beforeAll(async () => {
    // As before this change: a line at Plant B stated in sterling with a typed rate.
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query(`set local session_replication_role = replica`);
      legacy = (await client.query(
        `insert into public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount, unit_cost, net_amount, gross_amount, incurred_on, base_currency, org_currency,
                                      exchange_rate, net_base, gross_base, org_rate, net_org, gross_org, rate_status, rate_source)
         values ($1, $2, 'rework', 'USD', 100, 100, 100, 100, $3, 'GBP', 'GBP', 0.8, 80, 80, 0.8, 80, 80, 'actual', 'manual') returning id`,
        [ids.orgA, ncrB, DAY],
      )).rows[0].id;
      await client.query('commit');
    } finally {
      client.release();
    }
  });

  it('the report names the site and what its lines are stated in, and changes nothing', async () => {
    const res = (await api().get('/api/v1/cost-currency/restate-report').set(await as(ids.ownerA)).expect(200)).body;
    expect(res.sites).toEqual([expect.objectContaining({ siteId: plantB, siteCurrency: 'EUR', lines: 1, statedIn: ['GBP'] })]);
    const dry = (await api().post('/api/v1/cost-currency/restate').set(await as(ids.ownerA)).send({ siteId: plantB }).expect(200)).body;
    expect(dry).toMatchObject({ confirmed: false, restated: 0 });
    expect((await costs(ncrB)).data.find((c: { id: string }) => c.id === legacy)).toMatchObject({ baseCurrency: 'GBP', rateStatus: 'actual' });
  });

  it('is for organisation managers', async () => {
    await api().get('/api/v1/cost-currency/restate-report').set(await as(SITE_USER)).expect(403);
    await api().post('/api/v1/cost-currency/restate').set(await as(SITE_USER)).send({ siteId: plantB, confirm: true }).expect(403);
  });

  it('when confirmed it restates the site, fetching what it needs; the organisation figures stay as they were', async () => {
    const done = (await api().post('/api/v1/cost-currency/restate').set(await as(ids.ownerA)).send({ siteId: plantB, confirm: true }).expect(200)).body;
    expect(done).toMatchObject({ confirmed: true, restated: 1 });
    const line = (await costs(ncrB)).data.find((c: { id: string }) => c.id === legacy);
    expect(line).toMatchObject({ baseCurrency: 'EUR', rateStatus: 'estimated', exchangeRate: 0.92, netBase: 92, orgRate: 0.8, netOrg: 80 });
    const again = (await api().post('/api/v1/cost-currency/restate').set(await as(ids.ownerA)).send({ siteId: plantB, confirm: true }).expect(200)).body;
    expect(again.restated).toBe(0);
  });
});
