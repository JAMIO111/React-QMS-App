/**
 * Customer quality dashboard through the API: shipped units, on-time and in-full against the order lines, customer NCs, PPM by period and by lot, returns
 * and coverage, added up from the database's own per-customer function; attention reasons, late order lines, the trend, and a person who may not read
 * both shipping and non-conformances (or another organisation) getting no figures.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { attentionReasons } from '../src/customer-quality/customer-dashboard';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('7f');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const owner = () => as(ids.ownerA);
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const URL = (extra = '') => `/api/v1/customer-quality/dashboard?from=${day(-60)}&to=${day(0)}${extra}`;
const ctx: Record<string, string> = {};

describe('attentionReasons', () => {
  it('names the worst first and says nothing for a quiet customer', () => {
    expect(attentionReasons({ critical: 0, onTimePercent: 100, matchedLines: 4, ppm: null, ncUnits: 0, openLateLines: 0 })).toEqual([]);
    const reasons = attentionReasons({ critical: 2, onTimePercent: 50, matchedLines: 2, ppm: 83333, ncUnits: 25, openLateLines: 1 });
    expect(reasons[0]).toBe('2 critical complaints in the period');
    expect(reasons).toContain('On time 50% (aim 90%)');
    expect(reasons.some((r) => r.includes('83,333 PPM'))).toBe(true);
  });
});

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-cqd');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const org = ids.orgA;
  const c = await admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    const one = async (text: string, params: unknown[]) => (await c.query(text, params)).rows[0].id as string;
    ctx.acme = await one(`insert into public.customers (organisation_id, code, name) values ($1, 'ACME', 'Acme Motors') returning id`, [org]);
    await one(`insert into public.customers (organisation_id, code, name) values ($1, 'QUIET', 'Quiet Ltd') returning id`, [org]);
    ctx.part = await one(`insert into public.parts (organisation_id, part_number, name) values ($1, 'P-1', 'Bracket') returning id`, [org]);
    ctx.lot = await one(`insert into public.lots (organisation_id, lot_number, part_id, origin, quantity) values ($1, 'LOT-A', $2, 'produced', 500) returning id`, [org, ctx.part]);
    const so = await one(`insert into public.customer_orders (organisation_id, order_number, customer_id) values ($1, 'SO-1', $2) returning id`, [org, ctx.acme]);
    const line = async (n: number, qty: number, requested: number) =>
      one(`insert into public.customer_order_lines (organisation_id, customer_order_id, line_number, part_id, quantity_ordered, requested_on) values ($1, $2, $3, $4, $5, $6) returning id`, [org, so, n, ctx.part, qty, day(requested)]);
    const l1 = await line(1, 100, -40);
    const l2 = await line(2, 200, -30);
    await line(3, 50, -10);
    const ship = async (ref: string, shippedOn: number, orderLine: string | null, qty: number, lot: string | null) => {
      const sh = await one(`insert into public.shipments (organisation_id, reference, customer_id, shipped_on) values ($1, $2, $3, $4) returning id`, [org, ref, ctx.acme, day(shippedOn)]);
      await c.query(`insert into public.shipment_lines (organisation_id, shipment_id, line_number, order_line_id, part_id, quantity_shipped, lot_id) values ($1, $2, 1, $3, $4, $5, $6)`, [org, sh, orderLine, ctx.part, qty, lot]);
    };
    await ship('SH-D-1', -40, l1, 100, ctx.lot);
    await ship('SH-D-2', -25, l2, 150, null);
    await ship('SH-D-3', -20, null, 50, null);
    const nc = async (ref: string, severity: string, qty: number, stage: string, detected: number) =>
      one(`insert into public.nonconformances (organisation_id, reference, source, customer_id, title, severity, quantity_affected, description, stage, category_id, detected_at)
           values ($1, $2, 'customer', $3, $4, $5, $6, 'x', $7, (select id from public.ncr_classifications where organisation_id = $1 and kind = 'category' limit 1), $8) returning id`,
        [org, ref, ctx.acme, `NC ${ref}`, severity, qty, stage, day(detected)]);
    ctx.n1 = await nc('CQD-1', 'major', 20, 'open', -35);
    await nc('CQD-2', 'critical', 5, 'closed', -15);
    await nc('CQD-3', 'minor', 100, 'draft', -10);
    await c.query(`insert into public.ncr_affected_lots (organisation_id, nonconformance_id, lot_id, quantity) values ($1, $2, $3, 12)`, [org, ctx.n1, ctx.lot]);
    await c.query('commit');
  } finally {
    c.release();
  }
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('customer quality dashboard', () => {
  it('adds up what the database worked out', async () => {
    const res = (await api().get(URL()).set(await owner()).expect(200)).body;
    expect(res.available).toBe(true);
    expect(res.totals).toMatchObject({
      customers: 1, shipments: 3, shippedUnits: 300, matchedLines: 2, onTimeLines: 1, onTimePercent: 50, inFullLines: 1, inFullJudged: 3, inFullPercent: 33.3,
      ncsRaised: 2, ncUnits: 25, ppm: 83333, ppmLot: 120000, returnedUnits: 0, shippedWithoutOrder: 1, shippedWithoutLot: 2, openLateLines: 2,
    });
    expect(res.totals.tracedPercent).toBeCloseTo(33.3, 1);
    expect(res.bySeverity).toEqual([{ key: 'critical', count: 1 }, { key: 'major', count: 1 }, { key: 'minor', count: 0 }, { key: 'unrated', count: 0 }]);
    const acme = res.customers.find((x: { code: string }) => x.code === 'ACME');
    expect(acme).toMatchObject({ shippedUnits: 300, ncs: 2, critical: 1, ppm: 83333, openNcs: 1, openLateLines: 2 });
    expect(res.customers.find((x: { code: string }) => x.code === 'QUIET')).toBeUndefined();
    expect(res.attention[0]).toMatchObject({ code: 'ACME' });
    expect(res.attention[0].reasons[0]).toMatch(/critical complaint/);
    expect(res.lateOrderLines[0]).toMatchObject({ orderNumber: 'SO-1', lineNumber: 2, outstanding: 50, daysLate: 30 });
  });

  it('measures against the agreed date, and grace days, when asked', async () => {
    const strict = (await api().get(URL('&policy=requested&grace=0')).set(await owner()).expect(200)).body;
    const loose = (await api().get(URL('&policy=requested&grace=30')).set(await owner()).expect(200)).body;
    expect(loose.totals.onTimePercent).toBeGreaterThan(strict.totals.onTimePercent);
    expect(loose.period).toMatchObject({ policy: 'requested', graceDaysAfter: 30 });
    await api().get(URL('&policy=whenever')).set(await owner()).expect(400);
    await api().get(`/api/v1/customer-quality/dashboard?from=${day(0)}&to=${day(-1)}`).set(await owner()).expect(400);
  });

  it('has a trend and says nothing to another organisation', async () => {
    const res = (await api().get(URL()).set(await owner()).expect(200)).body;
    expect(res.trend.length).toBeGreaterThan(0);
    expect(res.trend.reduce((t: number, r: { shippedUnits: number }) => t + r.shippedUnits, 0)).toBe(300);
    const other = (await api().get(URL()).set(await as(ids.ownerB, ids.orgB)).expect(200)).body;
    expect(other.totals.shippedUnits).toBe(0);
    expect(other.customers).toEqual([]);
  });
});
