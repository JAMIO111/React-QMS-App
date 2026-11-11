/**
 * Supplier quality dashboard through the API: the supplier base as of today (approval, risk, expiring records, corrective action requests),
 * the period's non-conformances and deliveries, and performance added up from the database's own scoring. Permissions and tenant isolation.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('d9');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const owner = () => as(ids.ownerA);
const ctx: Record<string, string> = {};
const base = '/api/v1/supplier-quality';
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const URL = `${base}/dashboard?from=${day(-60)}&to=${day(0)}`;

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-sqd');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await owner();
  for (const [key, code, name] of [['s1', 'ACME', 'Acme Metals'], ['s2', 'BOLT', 'Bolt Co'], ['s3', 'GONE', 'Gone Ltd']]) {
    ctx[key] = (await api().post(`${base}/suppliers`).set(h).send({ code, name }).expect(201)).body.id;
  }
  await admin.query(`update public.suppliers set active = false where id = $1`, [ctx.s3]);
  await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'ELSE', 'Elsewhere Ltd')`, [ids.orgB]);

  // Six lines delivered against an order, the third rejected; two late against the agreed date.
  const req = [-20, -20, -20, -30, -20, -20];
  const recv = [-22, -20, -15, -12, -20, -19];
  const lines = req.map((r, i) => ({ material: `Steel ${i + 1}`, quantity: 100, requestedOn: day(r) }));
  // A seventh line, due last week, not delivered: late now.
  lines.push({ material: 'Steel 7', quantity: 50, requestedOn: day(-7) });
  ctx.po = (await api().post('/api/v1/purchase-orders').set(h).send({ supplierId: ctx.s1, poNumber: 'PO-SQD-1', orderedOn: day(-40), lines }).expect(201)).body.id;
  const po = (await api().get(`/api/v1/purchase-orders/${ctx.po}`).set(h).expect(200)).body;
  for (let i = 0; i < 6; i++) {
    const receipt = (await api().post('/api/v1/goods-receipts').set(h).send({
      supplierId: ctx.s1, purchaseOrderId: ctx.po, receivedOn: day(recv[i]), deliveryNote: `DN-${i + 1}`, clientKey: `sqd-key-000${i + 1}`, lines: [{ poLineId: po.lines[i].id, quantity: 100 }],
    }).expect(201)).body;
    if (i === 2) {
      const line = (await api().get(`/api/v1/goods-receipts/${receipt.id}`).set(h).expect(200)).body.lines[0].id;
      await api().post(`/api/v1/goods-receipt-lines/${line}/disposition`).set(h).send({ decision: 'rejected', reason: 'Out of tolerance' }).expect(200);
    }
  }
  await api().post(`${base}/suppliers/${ctx.s1}/certifications`).set(h).send({ certType: 'iso_9001', certificateNumber: 'OLD-1', issuingBody: 'BSI', expiresOn: day(-5) }).expect(201);
  await api().post(`${base}/suppliers/${ctx.s2}/certifications`).set(h).send({ certType: 'iso_14001', certificateNumber: 'SOON-1', issuingBody: 'BSI', expiresOn: day(20) }).expect(201);
  await api().post(`${base}/suppliers/${ctx.s2}/certifications`).set(h).send({ certType: 'iso_9001', certificateNumber: 'FINE-1', issuingBody: 'BSI', expiresOn: day(400) }).expect(201);

  // Non-conformances naming suppliers: two for Acme in the period (one critical), one old, one cancelled; one with no supplier.
  const nc = async (ref: string, supplier: string | null, detected: number, severity: string | null) =>
    (await admin.query(
      `insert into public.nonconformances (organisation_id, reference, source, title, supplier_id, detected_at, severity) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [ids.orgA, ref, supplier ? 'supplier' : 'internal', `NC ${ref}`, supplier, day(detected), severity],
    )).rows[0].id as string;
  ctx.nc1 = await nc('SQD-1', ctx.s1, -10, 'critical');
  await nc('SQD-2', ctx.s1, -12, 'minor');
  await nc('SQD-3', ctx.s2, -200, null);
  await nc('SQD-5', null, -10, 'major');
  const cancelled = await nc('SQD-4', ctx.s1, -10, 'major');
  await admin.query(`update public.nonconformances set stage = 'cancelled', stage_reason = 'Raised in error' where id = $1`, [cancelled]);

  // One corrective action request issued and now past its due date; one still a draft.
  ctx.scar = (await api().post(`${base}/scars`).set(h).send({ supplierId: ctx.s1, title: 'Bent brackets', problemDescription: 'Brackets arrive bent', severity: 'major', responseDueOn: day(14), ncrIds: [ctx.nc1] }).expect(201)).body.id;
  await api().post(`${base}/scars/${ctx.scar}/issue`).set(h).send({}).expect(200);
  await admin.query(`update public.supplier_scars set response_due_on = $2 where id = $1`, [ctx.scar, day(-3)]);
  await api().post(`${base}/scars`).set(h).send({ supplierId: ctx.s1, title: 'Second request', problemDescription: 'Still bent', severity: 'minor', responseDueOn: day(14), ncrIds: [ctx.nc1] }).expect(201);

  // An approval proposal waiting, and a risk rating.
  await api().post(`${base}/suppliers/${ctx.s2}/approval-decisions`).set(h).send({ target: 'approved', rationale: 'Sole source for a legacy part', exceptionReason: 'Sole source, corrective action in progress' }).expect(201);
  const model = (await api().get(`${base}/risk-model`).set(h).expect(200)).body;
  await api().post(`${base}/suppliers/${ctx.s1}/risk-assessments`).set(h).send({ scores: model.factors.map((f: { key: string }) => ({ key: f.key, score: 4, note: null })), rationale: 'Repeated rejections' }).expect(201);
  await admin.query(`alter table public.supplier_risk_assessments disable trigger user`);
  await admin.query(`update public.supplier_risk_assessments set review_on = $2 where supplier_id = $1`, [ctx.s1, day(-2)]);
  await admin.query(`alter table public.supplier_risk_assessments enable trigger user`);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('supplier quality dashboard', () => {
  it('counts the supplier base as of today', async () => {
    const d = (await api().get(URL).set(await owner()).expect(200)).body;
    expect(d.period).toMatchObject({ from: day(-60), to: day(0), bucket: 'week' });
    expect(d.kpis).toMatchObject({
      suppliers: 2, approved: 0, pendingApproval: 2, approvalsWaiting: 1, highRisk: 1, riskNotAssessed: 1, riskReviewsOverdue: 1, expired: 1, expiring: 1, openScars: 2, overdueScars: 1,
    });
    expect(d.byStatus.find((s: { key: string }) => s.key === 'pending_approval').count).toBe(2);
    expect(d.byRisk.filter((r: { count: number }) => r.count > 0).map((r: { key: string }) => r.key).sort()).toEqual(['critical', 'none']);
    expect(d.scarsByStatus.filter((s: { count: number }) => s.count > 0)).toEqual([{ key: 'draft', count: 1 }, { key: 'issued', count: 1 }]);
    expect(d.overdueScarList).toEqual([expect.objectContaining({ id: ctx.scar, title: 'Bent brackets', daysOverdue: 3, supplier: { id: ctx.s1, code: 'ACME', name: 'Acme Metals' } })]);
    expect(d.approvalList).toEqual([expect.objectContaining({ target: 'approved', supplier: expect.objectContaining({ code: 'BOLT' }) })]);
    expect(d.expiryList.map((e: { title: string; days: number }) => [e.title, e.days])).toEqual([['OLD-1', -5], ['SOON-1', 20]]);
    expect(d.riskReviewList).toEqual([expect.objectContaining({ rating: 'critical', daysOverdue: 2, supplier: expect.objectContaining({ code: 'ACME' }) })]);
  });

  it('counts the period\'s supplier non-conformances and deliveries', async () => {
    const d = (await api().get(URL).set(await owner()).expect(200)).body;
    // Open: three live supplier NCs (the cancelled one and the one naming no supplier are left out); raised in the period: two.
    expect(d.ncs).toMatchObject({ available: true, open: 3, raised: 2 });
    expect(d.ncs.trend.reduce((t: number, b: { critical: number; minor: number }) => t + b.critical + b.minor, 0)).toBe(2);
    expect(d.ncs.bySupplier).toEqual([{ id: ctx.s1, code: 'ACME', name: 'Acme Metals', count: 2, critical: 1 }]);
    expect(d.receiving).toMatchObject({ available: true, lines: 6, rejectedLines: 1, lotRejectionPercent: 16.7, lateOrderLines: 1, certificatesToReview: 0 });
    const t = d.receiving.trend.reduce((a: { accepted: number; rejected: number; undecided: number }, b: { accepted: number; rejected: number; undecided: number }) => ({
      accepted: a.accepted + b.accepted, rejected: a.rejected + b.rejected, undecided: a.undecided + b.undecided,
    }), { accepted: 0, rejected: 0, undecided: 0 });
    expect(t.rejected).toBe(1);
    expect(t.accepted + t.undecided).toBe(5);
  });

  it('adds up performance exactly as each supplier\'s own Performance tab works it out', async () => {
    const d = (await api().get(URL).set(await owner()).expect(200)).body;
    const own = (await api().get(`${base}/suppliers/${ctx.s1}/performance?from=${day(-60)}&to=${day(0)}`).set(await owner()).expect(200)).body;
    expect(d.performance).toMatchObject({
      available: true, scored: 2, truncated: false, matchedLines: own.metrics.otd.matchedLines, onTimeLines: own.metrics.otd.onTime, ppm: own.metrics.ppm.value, rejectedUnits: 100, receivedUnits: 600,
    });
    expect(d.performance.otdPercent).toBe(Math.round((own.metrics.otd.onTime / own.metrics.otd.matchedLines) * 1000) / 10);
    expect(d.performance.bands).toEqual(expect.arrayContaining([{ key: own.band, count: 1 }, { key: 'insufficient', count: 1 }]));
    expect(d.performance.attention[0]).toMatchObject({ code: 'ACME', band: own.band, score: own.score });
    expect(d.performance.attention[0].warnings).toBeGreaterThan(0);
    expect(typeof d.performance.attention[0].reason).toBe('string');
  });

  it('uses months for a long period and leaves out what happened before it', async () => {
    const d = (await api().get(`${base}/dashboard?from=${day(-400)}&to=${day(-100)}`).set(await owner()).expect(200)).body;
    expect(d.period.bucket).toBe('month');
    expect(d.ncs).toMatchObject({ open: 3, raised: 1 });
    expect(d.receiving).toMatchObject({ lines: 0, rejectedLines: 0, lotRejectionPercent: null });
    expect(d.performance).toMatchObject({ otdPercent: null, ppm: null });
  });

  it('needs supplier_quality.read, a valid period, and never shows another organisation', async () => {
    await api().get(URL).set(await as(ids.outsider)).expect(404); // not a member: the organisation does not exist for them
    await api().get(URL).set(await as(ids.inspectorA)).expect(200);
    const h = await owner();
    await api().get(`${base}/dashboard`).set(h).expect(400);
    await api().get(`${base}/dashboard?from=${day(0)}&to=${day(-5)}`).set(h).expect(400);
    await api().get(`${base}/dashboard?from=2020-01-01&to=${day(0)}`).set(h).expect(400);
    const b = (await api().get(URL).set(await as(ids.ownerB, ids.orgB)).expect(200)).body;
    expect(b.kpis).toMatchObject({ suppliers: 1, openScars: 0, expired: 0, approvalsWaiting: 0 });
    expect(b.ncs).toMatchObject({ open: 0, raised: 0 });
    expect(b.receiving.lines).toBe(0);
    expect(b.performance.attention).toEqual([]);
  });
});
