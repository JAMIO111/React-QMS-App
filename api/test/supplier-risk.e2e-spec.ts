/**
 * Supplier quality SQ2b through the API: the versioned risk model, previews and assessments scored by the database, escalation, supersession, review dates,
 * the only writer of a supplier's risk rating, permissions and isolation.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('f8');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const owner = () => as(ids.ownerA);
const reader = () => as(ids.inspectorA);
const other = () => as(ids.ownerB, ids.orgB);
const ctx: Record<string, string> = {};
const base = '/api/v1/supplier-quality';
const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-sqr');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await owner();
  ctx.s1 = (await api().post(`${base}/suppliers`).set(h).send({ code: 'ACME', name: 'Acme Metals' }).expect(201)).body.id;
  ctx.s2 = (await api().post(`${base}/suppliers`).set(h).send({ code: 'BOLT', name: 'Bolt Co' }).expect(201)).body.id;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

const KEYS = ['product_criticality', 'quality_system', 'special_processes', 'supply_dependence', 'regulatory_customer', 'financial_stability'];
const scores = (all: number, over: Record<string, number> = {}) => KEYS.map((key) => ({ key, score: over[key] ?? all, note: key === 'quality_system' ? 'ISO certified' : null }));

describe('the risk model', () => {
  it('every organisation starts with the default model at version 1', async () => {
    const m = (await api().get(`${base}/risk-model`).set(await owner()).expect(200)).body;
    expect(m).toMatchObject({ version: 1, reviewIntervalMonths: 12, reason: 'Default model', thresholds: { mediumFrom: 1.75, highFrom: 2.5, criticalFrom: 3.25 } });
    expect(m.factors.map((f: { key: string }) => f.key)).toEqual(KEYS);
    expect(m.factors.find((f: { key: string }) => f.key === 'product_criticality')).toMatchObject({ weight: 5, escalates: true });
    expect(m.versions).toHaveLength(1);
    ctx.model1 = m.id;
    await api().get(`${base}/risk-model`).set(await reader()).expect(200);
  });
});

describe('assessing a supplier', () => {
  it('previews what the scores would give without saving anything', async () => {
    const h = await owner();
    const p = (await api().post(`${base}/suppliers/${ctx.s1}/risk-assessments/preview`).set(h).send({ scores: scores(1, { product_criticality: 4 }) }).expect(200)).body;
    expect(p).toMatchObject({ modelVersion: 1, index: 1.75, band: 'medium', rating: 'high', escalatedBy: ['Criticality of what they supply'] });
    expect(p.factors).toHaveLength(6);
    expect((await api().get(`${base}/suppliers/${ctx.s1}/risk-assessments`).set(h).expect(200)).body.data).toEqual([]);
    expect((await api().get(`${base}/suppliers/${ctx.s1}`).set(h).expect(200)).body.riskRating).toBeNull();
  });

  it('refuses incomplete, unknown, repeated or out-of-range scores and a missing rationale', async () => {
    const h = await owner();
    const url = `${base}/suppliers/${ctx.s1}/risk-assessments`;
    await api().post(url).set(h).send({ scores: scores(2).slice(1), rationale: 'Missing one' }).expect(409);
    await api().post(url).set(h).send({ scores: [...scores(2), { key: 'nonsense', score: 2 }], rationale: 'Unknown factor' }).expect(409);
    await api().post(url).set(h).send({ scores: [...scores(2), scores(2)[0]], rationale: 'Scored twice' }).expect(409);
    await api().post(url).set(h).send({ scores: scores(5), rationale: 'Too high' }).expect(400);
    await api().post(url).set(h).send({ scores: scores(2), rationale: '' }).expect(400);
    await api().post(url).set(h).send({ scores: scores(2), rationale: 'Review in the past', reviewOn: day(-1) }).expect(409);
    await api().post(url).set(h).send({ scores: scores(2), rationale: 'Extra field', rating: 'low' }).expect(400);
    expect((await api().get(`${url}`).set(h).expect(200)).body.data).toEqual([]);
  });

  it('records an assessment, sets the supplier\'s rating and review date, and freezes the scores', async () => {
    const h = await owner();
    const a = (await api().post(`${base}/suppliers/${ctx.s1}/risk-assessments`).set(h).send({ scores: scores(2), rationale: 'Established supplier, certified' }).expect(201)).body;
    ctx.a1 = a.id;
    expect(a).toMatchObject({ status: 'current', index: 2, band: 'medium', rating: 'medium', modelVersion: 1, previousRating: null, rationale: 'Established supplier, certified', reviewOverdue: false, assessedBy: { id: ids.ownerA } });
    expect(a.factors.find((f: { key: string }) => f.key === 'quality_system')).toMatchObject({ score: 2, note: 'ISO certified', weight: 4 });
    const twelveMonths = new Date();
    twelveMonths.setUTCMonth(twelveMonths.getUTCMonth() + 12);
    expect(Math.abs(new Date(a.reviewOn).getTime() - twelveMonths.getTime())).toBeLessThan(3 * 86400000);
    expect((await api().get(`${base}/suppliers/${ctx.s1}`).set(h).expect(200)).body.riskRating).toBe('medium');
    expect((await api().get(`${base}/suppliers?risk=medium`).set(h).expect(200)).body.data.map((s: { id: string }) => s.id)).toContain(ctx.s1);
  });

  it('a new assessment supersedes the old and keeps the rating it replaced; escalation raises it', async () => {
    const h = await owner();
    const a = (await api().post(`${base}/suppliers/${ctx.s1}/risk-assessments`).set(h).send({ scores: scores(1, { regulatory_customer: 4 }), rationale: 'New customer requirement', reviewOn: day(90) }).expect(201)).body;
    ctx.a2 = a.id;
    expect(a).toMatchObject({ rating: 'high', band: 'low', previousRating: 'medium', reviewOn: day(90), escalatedBy: ['Regulatory and customer requirements'] });
    const list = (await api().get(`${base}/suppliers/${ctx.s1}/risk-assessments`).set(h).expect(200)).body.data;
    expect(list.map((x: { id: string; status: string }) => [x.id, x.status])).toEqual([[ctx.a2, 'current'], [ctx.a1, 'superseded']]);
    expect((await api().get(`${base}/suppliers/${ctx.s1}`).set(h).expect(200)).body.riskRating).toBe('high');
  });

  it('shows a current assessment as overdue once its review date has passed', async () => {
    const h = await owner();
    await admin.query(`update public.supplier_risk_assessments set review_on = current_date - 3 where id = $1`, [ctx.a2]);
    const list = (await api().get(`${base}/suppliers/${ctx.s1}/risk-assessments`).set(h).expect(200)).body.data;
    expect(list[0]).toMatchObject({ id: ctx.a2, reviewOverdue: true });
    expect(list[1].reviewOverdue).toBe(false); // a superseded one is never overdue
  });

  it('cannot set the rating any other way', async () => {
    const h = await owner();
    await api().patch(`${base}/suppliers/${ctx.s1}`).set(h).send({ riskRating: 'low' }).expect(400);
    await api().post(`${base}/suppliers`).set(h).send({ code: 'SNEAK', name: 'Sneaky', riskRating: 'low' }).expect(400);
  });
});

describe('changing the model', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    factors: [
      { key: 'product_criticality', label: 'Criticality of what they supply', description: '', weight: 5, escalates: true },
      { key: 'quality_system', label: 'Quality system maturity', description: '', weight: 4, escalates: false },
      { key: 'delivery', label: 'Delivery performance', description: 'Late or short deliveries', weight: 3, escalates: false },
    ],
    thresholds: { mediumFrom: 1.5, highFrom: 2.4, criticalFrom: 3.2 },
    reviewIntervalMonths: 6,
    reason: 'Simplified after the first year',
    ...over,
  });

  it('needs configure rights, a valid model and a reason', async () => {
    await api().put(`${base}/risk-model`).set(await reader()).send(body()).expect(403);
    const h = await owner();
    await api().put(`${base}/risk-model`).set(h).send(body({ reason: '' })).expect(400);
    await api().put(`${base}/risk-model`).set(h).send(body({ thresholds: { mediumFrom: 3, highFrom: 2, criticalFrom: 4 } })).expect(409);
    await api().put(`${base}/risk-model`).set(h).send(body({ factors: [] })).expect(400);
    await api().put(`${base}/risk-model`).set(h).send(body({ factors: [{ key: 'Bad Key', label: 'x', weight: 1, escalates: false }] })).expect(400);
    await api().put(`${base}/risk-model`).set(h).send(body({ factors: [{ key: 'aa', label: 'x', weight: 11, escalates: false }] })).expect(400);
    expect((await api().get(`${base}/risk-model`).set(h).expect(200)).body.version).toBe(1);
  });

  it('saves a new version; old assessments keep theirs and new ones use it', async () => {
    const h = await owner();
    const m = (await api().put(`${base}/risk-model`).set(h).send(body()).expect(200)).body;
    expect(m).toMatchObject({ version: 2, reviewIntervalMonths: 6, reason: 'Simplified after the first year' });
    expect(m.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect((await api().put(`${base}/risk-model`).set(h).send(body()).expect(409)).body.error.code).toBe('supplier_rule'); // unchanged
    // scores for the old six factors are refused now
    await api().post(`${base}/suppliers/${ctx.s2}/risk-assessments`).set(h).send({ scores: scores(2), rationale: 'Old factors' }).expect(409);
    const a = (await api().post(`${base}/suppliers/${ctx.s2}/risk-assessments`).set(h).send({
      scores: [{ key: 'product_criticality', score: 2 }, { key: 'quality_system', score: 2 }, { key: 'delivery', score: 3, note: 'Two late deliveries' }], rationale: 'First assessment of Bolt',
    }).expect(201)).body;
    expect(a).toMatchObject({ modelVersion: 2, index: 2.25, rating: 'medium' });
    const old = (await api().get(`${base}/suppliers/${ctx.s1}/risk-assessments`).set(h).expect(200)).body.data[1];
    expect(old.modelVersion).toBe(1);
    expect(old.factors).toHaveLength(6);
  });
});

describe('permissions and isolation', () => {
  it('a reader sees assessments but cannot assess or preview', async () => {
    const r = await reader();
    expect((await api().get(`${base}/suppliers/${ctx.s1}/risk-assessments`).set(r).expect(200)).body.data.length).toBeGreaterThan(0);
    await api().post(`${base}/suppliers/${ctx.s1}/risk-assessments`).set(r).send({ scores: scores(1), rationale: 'Reader says' }).expect(403);
    await api().post(`${base}/suppliers/${ctx.s1}/risk-assessments/preview`).set(r).send({ scores: scores(1) }).expect(403);
  });

  it('another organisation sees and changes nothing, and has its own model', async () => {
    const o = await other();
    await api().get(`${base}/suppliers/${ctx.s1}/risk-assessments`).set(o).expect(404);
    await api().post(`${base}/suppliers/${ctx.s1}/risk-assessments`).set(o).send({ scores: scores(1), rationale: 'Hijacked' }).expect(404);
    await api().post(`${base}/suppliers/${ctx.s1}/risk-assessments/preview`).set(o).send({ scores: scores(1) }).expect(404);
    const m = (await api().get(`${base}/risk-model`).set(o).expect(200)).body;
    expect(m).toMatchObject({ version: 1, reason: 'Default model' });
    expect(m.id).not.toBe(ctx.model1);
  });
});
