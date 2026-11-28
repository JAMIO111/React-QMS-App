/**
 * "Raised" and "open" for a non-conformance mean the same thing everywhere (docs/audit-nc-2026-11.md API-3): not a draft, not cancelled, not deleted; raised in the
 * period of the day it was detected; open = raised and not closed. The NC dashboard, the home page, the supplier dashboard and register, the customer dashboard and the
 * quality objective measure are all asked about the same records and must agree.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { ncOpen, ncRaised } from '../src/ncr/nc-definitions';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a3');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const ctx: Record<string, string> = {};
const period = `from=${day(-60)}&to=${day(0)}`;

/** The same set of records for each party: two open (one critical), one awaiting closure, one closed, a draft, a cancelled one and a deleted open one. */
const STAGES: Array<{ stage: string; severity: string | null; deleted?: boolean }> = [
  { stage: 'open', severity: 'critical' },
  { stage: 'open', severity: 'minor' },
  { stage: 'awaiting_closure', severity: 'major' },
  { stage: 'closed', severity: 'minor' },
  { stage: 'draft', severity: 'critical' },
  { stage: 'cancelled', severity: 'major' },
  { stage: 'open', severity: 'critical', deleted: true },
];
// Raised: 4 (open, open, awaiting closure, closed). Open: 3. Critical open: 1.
const RAISED = 4;
const OPEN = 3;

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-ncdef');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const org = ids.orgA;
  const c = await admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    const one = async (text: string, params: unknown[]) => (await c.query(text, params)).rows[0].id as string;
    ctx.supplier = await one(`insert into public.suppliers (organisation_id, code, name) values ($1, 'DEF-S', 'Definitions Supply') returning id`, [org]);
    ctx.customer = await one(`insert into public.customers (organisation_id, code, name) values ($1, 'DEF-C', 'Definitions Motors') returning id`, [org]);
    let n = 0;
    for (const party of ['supplier', 'customer'] as const) {
      for (const s of STAGES) {
        n += 1;
        await c.query(
          `insert into public.nonconformances (organisation_id, reference, source, title, description, stage, severity, supplier_id, customer_id, detected_at, quantity_affected, deleted_at,
                                                category_id)
           values ($1, $2, $3, $4, 'x', $5, $6, $7, $8, $9, 10, $10, (select id from public.ncr_classifications where organisation_id = $1 and kind = 'category' limit 1))`,
          [org, `DEF-${n}`, party, `NC ${n}`, s.stage, s.severity, party === 'supplier' ? ctx.supplier : null, party === 'customer' ? ctx.customer : null, day(-5), s.deleted ? new Date().toISOString() : null],
        );
      }
    }
    await c.query('commit');
  } finally {
    c.release();
  }
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('what raised and open mean', () => {
  it('writes the rule once', () => {
    const text = (f: { queryChunks: unknown[] }) => f.queryChunks.map((x) => (typeof x === 'object' && x && 'value' in x ? (x as { value: string[] }).value.join('') : String(x))).join('');
    expect(text(ncRaised('n') as never)).toBe(`n.deleted_at is null and n.stage not in ('draft', 'cancelled')`);
    expect(text(ncOpen('nc') as never)).toBe(`nc.deleted_at is null and nc.stage not in ('draft', 'cancelled', 'closed')`);
  });

  it('is the same on the NC dashboard, the home page, the supplier dashboard and register, the customer dashboard and the quality objective', async () => {
    const h = await as(ids.ownerA);

    // NC dashboard: both parties together (the draft, the cancelled and the deleted ones are not there).
    const nc = (await api().get(`/api/v1/ncr-dashboard?${period}`).set(h).expect(200)).body;
    expect(nc.kpis).toMatchObject({ raised: RAISED * 2, open: OPEN * 2, criticalOpen: 2, closed: 0 });
    expect(nc.byStage.map((s: { key: string }) => s.key)).toEqual(['open', 'contained', 'investigating', 'dispositioned', 'awaiting_closure']);
    expect(Object.fromEntries(nc.byStage.map((s: { key: string; count: number }) => [s.key, s.count]))).toMatchObject({ open: 4, awaiting_closure: 2 });
    expect(nc.bySeverity.reduce((t: number, s: { count: number }) => t + s.count, 0)).toBe(RAISED * 2);
    expect(nc.trend.reduce((t: number, b: { total: number }) => t + b.total, 0)).toBe(RAISED * 2);

    // Home page: its NC area is the dashboard's own open count.
    const home = (await api().get('/api/v1/home-dashboard').set(h).expect(200)).body;
    expect(home.nc).toMatchObject({ open: OPEN * 2, criticalOpen: 2, awaitingClosure: 2 });

    // Supplier dashboard (the supplier's NCs only).
    const sd = (await api().get(`/api/v1/supplier-quality/dashboard?${period}`).set(h).expect(200)).body;
    expect(sd.ncs).toMatchObject({ available: true, open: OPEN, raised: RAISED });
    expect(sd.ncs.bySupplier).toEqual([expect.objectContaining({ id: ctx.supplier, count: RAISED, critical: 1 })]);

    // Supplier register and profile.
    const register = (await api().get('/api/v1/supplier-quality/suppliers?pageSize=50').set(h).expect(200)).body.data;
    expect(register.find((s: { id: string }) => s.id === ctx.supplier).openNcCount).toBe(OPEN);
    const profile = (await api().get(`/api/v1/supplier-quality/suppliers/${ctx.supplier}`).set(h).expect(200)).body;
    expect(profile.counts).toMatchObject({ openNcs: OPEN, totalNcs: RAISED });

    // Customer dashboard (the customer's NCs only).
    const cd = (await api().get(`/api/v1/customer-quality/dashboard?${period}`).set(h).expect(200)).body;
    expect(cd.totals).toMatchObject({ ncsRaised: RAISED, openNcs: OPEN });

    // Quality objective "non-conformances": the period's raised count, by detected date (every record here was detected five days ago, inside this month or the last).
    const objective = (await api().post('/api/v1/quality-objectives').set(h).send({ title: 'Fewer NCs', target: 100, measure: 'ncr_count', frequency: 'yearly', startsOn: `${day(0).slice(0, 4)}-01-01` }).expect(201)).body;
    ctx.objective = objective.id;
    const detail = (await api().get(`/api/v1/quality-objectives/${objective.id}`).set(h).expect(200)).body;
    const total = detail.periods.reduce((t: number, p: { value: number | null }) => t + (p.value ?? 0), 0);
    expect(total).toBe(RAISED * 2);
  });

  it('counts by the day it was detected, not the day it was typed in', async () => {
    const h = await as(ids.ownerA);
    // Typed in today, detected last year: outside this year's objective and outside the dashboard's period.
    await admin.query(
      `insert into public.nonconformances (organisation_id, reference, source, title, description, stage, supplier_id, detected_at, category_id)
       values ($1, 'DEF-OLD', 'supplier', 'Old news', 'x', 'open', $2, $3, (select id from public.ncr_classifications where organisation_id = $1 and kind = 'category' limit 1))`,
      [ids.orgA, ctx.supplier, `${Number(day(0).slice(0, 4)) - 1}-06-01`],
    );
    const sd = (await api().get(`/api/v1/supplier-quality/dashboard?${period}`).set(h).expect(200)).body;
    expect(sd.ncs).toMatchObject({ open: OPEN + 1, raised: RAISED });
    const detail = (await api().get(`/api/v1/quality-objectives/${ctx.objective}`).set(h).expect(200)).body;
    expect(detail.periods.reduce((t: number, p: { value: number | null }) => t + (p.value ?? 0), 0)).toBe(RAISED * 2);
  });
});
