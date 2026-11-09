/**
 * Supplier quality SQ5 through the API: live performance (PPM, lot rejection, on-time delivery by date policy, NCs, certifications), the score and warnings with the records behind them,
 * insufficient data, model versions, frozen scorecards, the watchlist, permissions and tenant isolation.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('fe');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const owner = () => as(ids.ownerA);
const inspector = () => as(ids.inspectorA);
const other = () => as(ids.ownerB, ids.orgB);
const ctx: Record<string, string> = {};
const base = '/api/v1/supplier-quality';
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-sp');
  ctx.s1 = (await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'ACME', 'Acme Metals') returning id`, [ids.orgA])).rows[0].id;
  ctx.s2 = (await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'BOLT', 'Bolt Co') returning id`, [ids.orgA])).rows[0].id;
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  // six order lines delivered in full: requested dates and agreed dates differ so the two policies disagree; the third line is rejected
  const req = [-20, -20, -20, -30, -20, -20];
  const agr: Array<number | null> = [null, null, null, -10, null, null];
  const recv = [-22, -20, -15, -12, -20, -19];
  const lines = req.map((r, i) => ({ material: `Steel ${i + 1}`, quantity: 100, requestedOn: day(r), ...(agr[i] === null ? {} : { agreedOn: day(agr[i] as number) }) }));
  ctx.po = (await api().post('/api/v1/purchase-orders').set(await owner()).send({ supplierId: ctx.s1, poNumber: 'PO-SP-1', orderedOn: day(-40), lines }).expect(201)).body.id;
  const po = (await api().get(`/api/v1/purchase-orders/${ctx.po}`).set(await owner()).expect(200)).body;
  for (let i = 0; i < 6; i++) {
    const receipt = (await api().post('/api/v1/goods-receipts').set(await owner()).send({
      supplierId: ctx.s1, purchaseOrderId: ctx.po, receivedOn: day(recv[i]), deliveryNote: `DN-${i + 1}`, clientKey: `sp-key-000${i + 1}`, lines: [{ poLineId: po.lines[i].id, quantity: 100 }],
    }).expect(201)).body;
    if (i === 2) {
      const line = (await api().get(`/api/v1/goods-receipts/${receipt.id}`).set(await owner()).expect(200)).body.lines[0].id;
      await api().post(`/api/v1/goods-receipt-lines/${line}/disposition`).set(await owner()).send({ decision: 'rejected', reason: 'Out of tolerance' }).expect(200);
    }
  }
  await api().post(`${base}/suppliers/${ctx.s1}/certifications`).set(await owner()).send({ certType: 'iso_9001', certificateNumber: 'OLD-1', issuingBody: 'BSI', expiresOn: day(-5) }).expect(201);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('supplier performance', () => {
  it('works out the live figures, score, band and warnings with their sources', async () => {
    const p = (await api().get(`${base}/suppliers/${ctx.s1}/performance?from=${day(-60)}&to=${day(0)}`).set(await inspector()).expect(200)).body;
    expect(p.model).toMatchObject({ version: 1, config: { otdPolicy: 'agreed', minLines: 5 } });
    expect(p.metrics.deliveries).toMatchObject({ lines: 6, unitsReceived: 600 });
    expect(p.metrics.ppm).toMatchObject({ value: 166667, rejectedUnits: 100 });
    expect(p.metrics.lotRejection).toMatchObject({ rejectedLines: 1, lines: 6 });
    expect(p.metrics.otd).toMatchObject({ policy: 'agreed', matchedLines: 6, onTime: 4, late: 2 });
    expect(p.metrics.certs).toMatchObject({ current: 1, expired: 1 });
    expect(p.band).toBe('poor');
    const expired = p.warnings.find((w: { code: string }) => w.code === 'cert_expired');
    expect(expired.sources[0]).toMatchObject({ number: 'OLD-1' });
    const ppm = p.components.find((c: { key: string }) => c.key === 'ppm');
    expect(ppm).toMatchObject({ sufficient: true, score: 0 });
    // the default period is the last 90 days
    expect((await api().get(`${base}/suppliers/${ctx.s1}/performance`).set(await owner()).expect(200)).body.metrics.period.to).toBe(day(0));
  });

  it('says there is not enough data instead of scoring', async () => {
    const p = (await api().get(`${base}/suppliers/${ctx.s2}/performance`).set(await owner()).expect(200)).body;
    expect(p.band).toBe('insufficient');
    expect(p.score).toBeNull();
    const short = (await api().get(`${base}/suppliers/${ctx.s1}/performance?from=${day(-14)}&to=${day(0)}`).set(await owner()).expect(200)).body;
    expect(short.components.find((c: { key: string }) => c.key === 'otd').sufficient).toBe(false);
    await api().get(`${base}/suppliers/${ctx.s1}/performance?from=${day(0)}&to=${day(-5)}`).set(await owner()).expect(409);
    await api().get(`${base}/suppliers/${ctx.s1}/performance?from=nonsense`).set(await owner()).expect(400);
  });

  it('keeps the model in versions: the date policy changes the figures, saved scorecards keep theirs', async () => {
    await api().put(`${base}/performance/model`).set(await inspector()).send({}).expect(403);
    const model = (await api().get(`${base}/performance/model`).set(await owner()).expect(200)).body;
    await api().put(`${base}/performance/model`).set(await owner()).send({ config: model.config, reason: 'No change at all' }).expect(409);
    await api().put(`${base}/performance/model`).set(await owner()).send({ config: { ...model.config, goodFrom: 40, watchFrom: 60 }, reason: 'Bands must rise' }).expect(409);
    await api().put(`${base}/performance/model`).set(await owner()).send({ config: { ...model.config, extra: 1 }, reason: 'Unknown field' }).expect(400);
    await api().post(`${base}/suppliers/${ctx.s1}/scorecards`).set(await inspector()).send({ from: day(-60), to: day(0) }).expect(403);
    const saved = (await api().post(`${base}/suppliers/${ctx.s1}/scorecards`).set(await owner()).send({ from: day(-60), to: day(0), note: 'Quarterly review' }).expect(201)).body;
    ctx.sc1 = saved.id;
    expect(saved).toMatchObject({ modelVersion: 1, band: 'poor', note: 'Quarterly review' });
    const v2 = (await api().put(`${base}/performance/model`).set(await owner()).send({ config: { ...model.config, otdPolicy: 'original' }, reason: 'Judge us by the original date' }).expect(200)).body;
    expect(v2).toMatchObject({ version: 2, config: { otdPolicy: 'original' } });
    expect(v2.versions).toHaveLength(2);
    const live = (await api().get(`${base}/suppliers/${ctx.s1}/performance?from=${day(-60)}&to=${day(0)}`).set(await owner()).expect(200)).body;
    expect(live.metrics.otd).toMatchObject({ policy: 'original', onTime: 3 });
    expect(live.score).toBeLessThan(saved.score);
    const again = (await api().get(`${base}/scorecards/${ctx.sc1}`).set(await inspector()).expect(200)).body;
    expect(again.score).toBe(saved.score);
    expect(again.metrics.otd.policy).toBe('agreed');
    const list = (await api().get(`${base}/suppliers/${ctx.s1}/scorecards`).set(await inspector()).expect(200)).body.data;
    expect(list.map((x: { id: string }) => x.id)).toContain(ctx.sc1);
    await api().post(`${base}/suppliers/${ctx.s1}/scorecards`).set(await owner()).send({ from: day(-30), to: day(1) }).expect(409); // the future
    await api().post(`${base}/suppliers/${ctx.s1}/scorecards`).set(await owner()).send({ from: day(-30), to: day(0), extra: 1 }).expect(400);
    const sql = await admin.query(`update public.supplier_scorecards set score = 99 where id = $1`, [ctx.sc1]).then(() => 'changed', (e: Error) => e.message);
    expect(sql).toMatch(/frozen/);
  });

  it('lists the watchlist, worst first, with the records behind each warning', async () => {
    const w = (await api().get(`${base}/performance/watchlist?days=90`).set(await inspector()).expect(200)).body;
    expect(w.days).toBe(90);
    expect(w.data.map((r: { code: string }) => r.code)).toEqual(['ACME']);
    expect(w.data[0].warnings.length).toBeGreaterThan(0);
    await api().get(`${base}/performance/watchlist?days=2`).set(await owner()).expect(400);
  });

  it('recommends an inspection level with its reasons, and changes nothing', async () => {
    const before = (await admin.query(`select count(*)::int as n from public.supplier_inspection_requirements where organisation_id = $1`, [ids.orgA])).rows[0].n;
    const r = (await api().get(`${base}/suppliers/${ctx.s1}/inspection-recommendation?days=90`).set(await inspector()).expect(200)).body;
    expect(r).toMatchObject({ level: 'increased', canReduce: false, change: 'raise', current: { level: 'normal', basis: 'default', ruleId: null }, basis: { days: 90, band: 'poor', deliveredLines: 6, rejectedLines: 1 } });
    expect(r.reasons.map((x: { code: string }) => x.code)).toEqual(expect.arrayContaining(['band', 'rejections']));
    const quiet = (await api().get(`${base}/suppliers/${ctx.s2}/inspection-recommendation`).set(await owner()).expect(200)).body;
    expect(quiet).toMatchObject({ level: 'normal', change: 'none', canReduce: false });
    expect(quiet.reasons.map((x: { code: string }) => x.code)).toEqual(expect.arrayContaining(['not_approved', 'unassessed', 'insufficient']));
    await api().get(`${base}/suppliers/${ctx.s1}/inspection-recommendation?days=2`).set(await owner()).expect(400);
    await api().get(`${base}/suppliers/${ctx.s1}/inspection-recommendation`).set(await other()).expect(404);
    const after = (await admin.query(`select count(*)::int as n from public.supplier_inspection_requirements where organisation_id = $1`, [ids.orgA])).rows[0].n;
    expect(after).toBe(before);
  });

  it('reports every active supplier with the period, the definitions and when it was worked out', async () => {
    const rep = (await api().get(`${base}/reports/performance?from=${day(-60)}&to=${day(0)}`).set(await inspector()).expect(200)).body;
    expect(rep.meta).toMatchObject({ title: 'Supplier performance', from: day(-60), to: day(0), rowCount: 2 });
    expect(rep.meta.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(rep.meta.definitions.join(' ')).toMatch(/PPM = units/);
    expect(rep.meta.basis.map((b: { label: string; value: string }) => `${b.label}=${b.value}`)).toEqual(expect.arrayContaining(['Scoring model version=2', 'On-time delivery judged against=the original requested date']));
    const acme = rep.rows.find((r: { code: string }) => r.code === 'ACME');
    expect(acme).toMatchObject({ band: 'poor', ppm: 166667, lotRejectionPercent: 16.7, onTime: 3, matchedLines: 6, certsExpired: 1 });
    expect(acme.warnings).toMatch(/certification/);
    expect(rep.rows.find((r: { code: string }) => r.code === 'BOLT')).toMatchObject({ band: 'insufficient', score: null });
    expect(rep.columns.map((c: { key: string }) => c.key)).toEqual(expect.arrayContaining(['code', 'score', 'ppm', 'otdPercent']));
    expect((await api().get(`${base}/reports/performance`).set(await owner()).expect(200)).body.meta.to).toBe(day(0));
    await api().get(`${base}/reports/performance?from=${day(0)}&to=${day(-5)}`).set(await owner()).expect(400);
    await api().get(`${base}/reports/performance?from=${day(-400)}&to=${day(0)}`).set(await owner()).expect(400);
    expect((await api().get(`${base}/reports/performance`).set(await other()).expect(200)).body.rows).toEqual([]);
  });

  it('is invisible to another organisation', async () => {
    await api().get(`${base}/suppliers/${ctx.s1}/performance`).set(await other()).expect(404);
    await api().get(`${base}/scorecards/${ctx.sc1}`).set(await other()).expect(404);
    await api().post(`${base}/suppliers/${ctx.s1}/scorecards`).set(await other()).send({ from: day(-30), to: day(0) }).expect(404);
    expect((await api().get(`${base}/performance/watchlist`).set(await other()).expect(200)).body.data).toEqual([]);
  });
});
