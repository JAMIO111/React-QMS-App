/**
 * Supplier quality SQ5 through the API: live performance (PPM, lot rejection, on-time delivery by date policy, NCs, certifications), the score and warnings with the records behind them,
 * insufficient data, model versions, frozen scorecards, the watchlist, permissions and tenant isolation.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';
import { SupplierPerformanceService } from '../src/supplier-quality/supplier-performance.service';

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
    expect(rep.meta.definitions.join(' ')).toMatch(/PPM \(rejected\) = units rejected/);
    expect(rep.meta.definitions.join(' ')).toMatch(/PPM \(non-conformances\)/);
    expect(rep.meta.basis.map((b: { label: string; value: string }) => `${b.label}=${b.value}`)).toEqual(expect.arrayContaining(['Scoring model version=2', 'On-time delivery judged against=the original requested date']));
    const acme = rep.rows.find((r: { code: string }) => r.code === 'ACME');
    expect(acme).toMatchObject({ band: 'poor', ppm: 166667, ppmNc: 0, ncUnits: 0, lotRejectionPercent: 16.7, onTime: 3, matchedLines: 6, certsExpired: 1 });
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

describe('supplier performance settings', () => {
  it('lets a supplier override the date policy, grace days and in-full tolerances, and clears them again', async () => {
    const start = (await api().get(`${base}/suppliers/${ctx.s1}/performance/settings`).set(await inspector()).expect(200)).body;
    expect(start.overrides).toEqual({ otdPolicy: null, graceDaysBefore: null, graceDaysAfter: null, inFullUnderPct: null, inFullOverPct: null });
    await api().put(`${base}/suppliers/${ctx.s1}/performance/settings`).set(await inspector()).send({ graceDaysAfter: 2 }).expect(403);
    await api().put(`${base}/suppliers/${ctx.s1}/performance/settings`).set(await owner()).send({ nonsense: 1 }).expect(400);
    await api().put(`${base}/suppliers/${ctx.s1}/performance/settings`).set(await owner()).send({ graceDaysAfter: 61 }).expect(400);
    await api().put(`${base}/suppliers/${ctx.s1}/performance/settings`).set(await other()).send({ graceDaysAfter: 2 }).expect(404);
    const saved = (await api().put(`${base}/suppliers/${ctx.s1}/performance/settings`).set(await owner()).send({ graceDaysBefore: 0, graceDaysAfter: 5, inFullUnderPct: 10, inFullOverPct: 25 }).expect(200)).body;
    expect(saved.overrides).toMatchObject({ graceDaysBefore: 0, graceDaysAfter: 5, inFullUnderPct: 10, inFullOverPct: 25, otdPolicy: null });
    expect(saved.effective).toMatchObject({ graceDaysAfter: 5, inFullUnderPct: 10, inFullOverPct: 25 });
    const live = (await api().get(`${base}/suppliers/${ctx.s1}/performance?from=${day(-60)}&to=${day(0)}`).set(await owner()).expect(200)).body;
    expect(live.overrides).toMatchObject({ graceDaysAfter: 5, inFullOverPct: 25 });
    expect(live.model.config).toMatchObject({ graceDaysBefore: 0, graceDaysAfter: 5 });
    expect(live.metrics.otd).toMatchObject({ graceBefore: 0, graceAfter: 5 });
    expect(live.metrics.inFull).toMatchObject({ underPct: 10, overPct: 25 });
    const cleared = (await api().put(`${base}/suppliers/${ctx.s1}/performance/settings`).set(await owner()).send({ graceDaysBefore: null, graceDaysAfter: null, inFullUnderPct: null, inFullOverPct: null }).expect(200)).body;
    expect(cleared.overrides).toEqual({ otdPolicy: null, graceDaysBefore: null, graceDaysAfter: null, inFullUnderPct: null, inFullOverPct: null });
    await api().get(`${base}/suppliers/${ctx.s1}/performance/settings`).set(await other()).expect(404);
  });

  it('keeps the PPM basis, grace days and the in-full weight in the model, with both PPM measures always shown', async () => {
    const model = (await api().get(`${base}/performance/model`).set(await owner()).expect(200)).body;
    expect(model.config).toMatchObject({ ppmBasis: 'rejected', graceDaysAfter: 0, weights: { inFull: 0 } });
    await api().put(`${base}/performance/model`).set(await owner()).send({ config: { ...model.config, ppmBasis: 'vibes' }, reason: 'Unknown basis' }).expect(400);
    const v = (await api().put(`${base}/performance/model`).set(await owner()).send({ config: { ...model.config, ppmBasis: 'ncs', graceDaysBefore: 3, weights: { ...model.config.weights, inFull: 20 } }, reason: 'Score NC PPM and in full' }).expect(200)).body;
    expect(v.config).toMatchObject({ ppmBasis: 'ncs', graceDaysBefore: 3, weights: { inFull: 20 } });
    const live = (await api().get(`${base}/suppliers/${ctx.s1}/performance?from=${day(-60)}&to=${day(0)}`).set(await owner()).expect(200)).body;
    expect(live.metrics.ppm).toMatchObject({ basis: 'rejected', rejectedUnits: 100 });
    expect(live.metrics.ppmNc).toMatchObject({ basis: 'ncs', affectedUnits: 0 });
    expect(live.components.find((c: { key: string }) => c.key === 'in_full')).toMatchObject({ weight: 20, sufficient: true });
    expect(live.components.find((c: { key: string }) => c.key === 'ppm').detail).toMatch(/non-conformances/);
    // back to the defaults, so the other tests' figures stand
    await api().put(`${base}/performance/model`).set(await owner()).send({ config: model.config, reason: 'Back to the defaults' }).expect(200);
  });

  it('counts only the rejected quantity of a part-rejected line, and refuses a quantity that makes no sense', async () => {
    const receipt = (await api().post('/api/v1/goods-receipts').set(await owner()).send({ supplierId: ctx.s2, receivedOn: day(-3), deliveryNote: 'DN-Q', clientKey: 'sp-qty-0001', lines: [{ material: 'Strip', quantity: 50 }] }).expect(201)).body;
    const line = (await api().get(`/api/v1/goods-receipts/${receipt.id}`).set(await owner()).expect(200)).body.lines[0].id;
    await api().post(`/api/v1/goods-receipt-lines/${line}/disposition`).set(await owner()).send({ decision: 'accepted', quantity: 5 }).expect(409);
    await api().post(`/api/v1/goods-receipt-lines/${line}/disposition`).set(await owner()).send({ decision: 'rejected', reason: 'Bad', quantity: 51 }).expect(409);
    await api().post(`/api/v1/goods-receipt-lines/${line}/disposition`).set(await owner()).send({ decision: 'rejected', reason: 'Bad', quantity: 0 }).expect(400);
    const res = (await api().post(`/api/v1/goods-receipt-lines/${line}/disposition`).set(await owner()).send({ decision: 'rejected', reason: 'Ten of the fifty were bent', quantity: 10 }).expect(200)).body;
    expect(res.lines[0].disposition).toMatchObject({ decision: 'rejected', quantityRejected: 10 });
    const p = (await api().get(`${base}/suppliers/${ctx.s2}/performance?from=${day(-60)}&to=${day(0)}`).set(await owner()).expect(200)).body;
    expect(p.metrics.ppm).toMatchObject({ rejectedUnits: 10, receivedUnits: 50, value: 200000 });
  });
});

let seq = 0;
describe('linking a non-conformance to a received line', () => {
  const lookup = async (q = '') => (await api().get(`/api/v1/goods-receipt-lines/lookup?supplierId=${ctx.s1}${q}`).set(await owner()).expect(200)).body.data;
  const ncr = async (qty: number | null, supplier = ctx.s1) =>
    (await admin.query(`insert into public.nonconformances (organisation_id, reference, source, title, description, severity, quantity_affected, supplier_id) values ($1, $4, 'supplier', 'Bent', 'x', 'minor', $2, $3) returning id`, [ids.orgA, qty, supplier, `LK-${Date.now()}-${(seq += 1)}`])).rows[0].id as string;

  it('looks up the supplier\'s received lines, newest first, and searches them', async () => {
    const all = await lookup();
    expect(all.length).toBeGreaterThanOrEqual(6);
    expect(all[0]).toMatchObject({ reference: expect.stringMatching(/^GR-/), quantityReceived: 100 });
    const one = await lookup('&q=DN-3');
    expect(one).toHaveLength(1);
    expect(one[0].deliveryNote).toBe('DN-3');
    await api().get(`/api/v1/goods-receipt-lines/lookup`).set(await owner()).expect(400); // a supplier is needed
    expect((await api().get(`/api/v1/goods-receipt-lines/lookup?supplierId=${ctx.s1}`).set(await other()).expect(200)).body.data).toEqual([]);
  });

  it('links, refuses a second line, ends the link with a reason, and counts the pieces in the NC-based PPM only while linked', async () => {
    const line = (await lookup('&q=DN-1'))[0].id as string;
    const other2 = (await lookup('&q=DN-2'))[0].id as string;
    const n = await ncr(30);
    const day0 = day(0);
    const before = (await api().get(`${base}/suppliers/${ctx.s1}/performance?from=${day(-60)}&to=${day0}`).set(await owner()).expect(200)).body.metrics.ppmNc;
    await api().post(`/api/v1/ncrs/${n}/receipt-link`).set(await inspector()).send({ receiptLineId: line }).expect(403);
    await api().post(`/api/v1/ncrs/${n}/receipt-link`).set(await owner()).send({ receiptLineId: line, extra: 1 }).expect(400);
    await api().post(`/api/v1/ncrs/${n}/receipt-link`).set(await other()).send({ receiptLineId: line }).expect(404);
    const linked = (await api().post(`/api/v1/ncrs/${n}/receipt-link`).set(await owner()).send({ receiptLineId: line }).expect(200)).body;
    expect(linked).toMatchObject({ available: true, items: [{ lineNumber: 1, quantityReceived: 100 }] });
    await api().post(`/api/v1/ncrs/${n}/receipt-link`).set(await owner()).send({ receiptLineId: other2 }).expect(409);
    const after = (await api().get(`${base}/suppliers/${ctx.s1}/performance?from=${day(-60)}&to=${day0}`).set(await owner()).expect(200)).body.metrics.ppmNc;
    expect(after.linkedUnits - before.linkedUnits).toBe(30);
    expect(after.unlinkedUnits).toBe(before.unlinkedUnits - 30); // it left the unlinked pile
    const linkId = linked.items[0].linkId as string;
    await api().post(`/api/v1/receipt-line-ncrs/${linkId}/unlink`).set(await owner()).send({ reason: 'x' }).expect(400);
    await api().post(`/api/v1/receipt-line-ncrs/${linkId}/unlink`).set(await inspector()).send({ reason: 'Linked in error' }).expect(403);
    const ended = (await api().post(`/api/v1/receipt-line-ncrs/${linkId}/unlink`).set(await owner()).send({ reason: 'Linked in error' }).expect(200)).body;
    expect(ended.items).toEqual([]);
    await api().post(`/api/v1/receipt-line-ncrs/${linkId}/unlink`).set(await owner()).send({ reason: 'Again' }).expect(409);
    const back = (await api().get(`${base}/suppliers/${ctx.s1}/performance?from=${day(-60)}&to=${day0}`).set(await owner()).expect(200)).body.metrics.ppmNc;
    expect(back.linkedUnits).toBe(before.linkedUnits);
  });

  it('refuses a receipt from another supplier, and counts unlinked pieces only when the model says so', async () => {
    const n = await ncr(40);
    const foreign = (await api().post('/api/v1/goods-receipts').set(await owner()).send({ supplierId: ctx.s2, receivedOn: day(-2), clientKey: 'lk-key-0001', lines: [{ material: 'Wire', quantity: 10 }] }).expect(201)).body;
    const line = (await api().get(`/api/v1/goods-receipts/${foreign.id}`).set(await owner()).expect(200)).body.lines[0].id as string;
    await api().post(`/api/v1/ncrs/${n}/receipt-link`).set(await owner()).send({ receiptLineId: line }).expect(409);
    const model = (await api().get(`${base}/performance/model`).set(await owner()).expect(200)).body;
    expect(model.config.ppmNcIncludeUnlinked).toBe(false);
    const off = (await api().get(`${base}/suppliers/${ctx.s1}/performance?from=${day(-60)}&to=${day(0)}`).set(await owner()).expect(200)).body.metrics.ppmNc;
    expect(off).toMatchObject({ includeUnlinked: false });
    expect(off.unlinkedUnits).toBeGreaterThanOrEqual(40);
    expect(off.affectedUnits).toBe(off.linkedUnits);
    await api().put(`${base}/performance/model`).set(await owner()).send({ config: { ...model.config, ppmNcIncludeUnlinked: true }, reason: 'Count NCs with no receipt as well' }).expect(200);
    const on = (await api().get(`${base}/suppliers/${ctx.s1}/performance?from=${day(-60)}&to=${day(0)}`).set(await owner()).expect(200)).body.metrics.ppmNc;
    expect(on).toMatchObject({ includeUnlinked: true });
    expect(on.affectedUnits).toBe(on.linkedUnits + on.unlinkedUnits);
    await api().put(`${base}/performance/model`).set(await owner()).send({ config: { ...model.config, ppmNcIncludeUnlinked: 'yes' }, reason: 'Not a boolean' }).expect(400);
    await api().put(`${base}/performance/model`).set(await owner()).send({ config: model.config, reason: 'Linked only again' }).expect(200);
  });
});


describe('scheduled scorecards', () => {
  const lastMonth = () => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
  };
  const run = () => app.get(SupplierPerformanceService).runSchedule('e2e-scorecards');

  it('starts with everything off, and only a configurer may change it', async () => {
    const s = (await api().get(`${base}/performance/schedule`).set(await inspector()).expect(200)).body;
    expect(s).toMatchObject({ monthly: false, quarterly: false, annual: false, scope: 'all', classifications: [], canChange: false, next: { monthly: null, quarterly: null, annual: null } });
    await api().put(`${base}/performance/schedule`).set(await inspector()).send({ monthly: true }).expect(403);
    await api().put(`${base}/performance/schedule`).set(await owner()).send({ monthly: 'yes' }).expect(400);
    await api().put(`${base}/performance/schedule`).set(await owner()).send({ scope: 'classifications', classificationIds: [] }).expect(409);
  });

  it('switches monthly, quarterly and annual on separately and saves each period once, by the schedule', async () => {
    const s = (await api().put(`${base}/performance/schedule`).set(await owner()).send({ monthly: true, annual: true }).expect(200)).body;
    expect(s).toMatchObject({ monthly: true, quarterly: false, annual: true, canChange: true, problem: null });
    expect(s.next.monthly.from).toBe(lastMonth());
    expect(s.setBy.id).toBe(ids.ownerA);
    const first = await run();
    expect(first.saved).toBeGreaterThanOrEqual(4); // last month and last year, for both suppliers (other suites' suppliers too)
    expect((await run()).saved).toBe(0);
    const cards = (await api().get(`${base}/suppliers/${ctx.s1}/scorecards`).set(await inspector()).expect(200)).body.data;
    const monthly = cards.find((c: { periodKind: string | null }) => c.periodKind === 'monthly');
    expect(monthly).toMatchObject({ periodFrom: lastMonth(), createdBy: null });
    expect(cards.filter((c: { periodKind: string | null }) => c.periodKind === 'annual')).toHaveLength(1);
    expect((await api().get(`${base}/scorecards/${monthly.id}`).set(await inspector()).expect(200)).body.periodKind).toBe('monthly');
    const after = (await api().get(`${base}/performance/schedule`).set(await inspector()).expect(200)).body;
    expect(after.next.monthly.from > lastMonth()).toBe(true);
    expect(after.lastSavedAt).not.toBeNull();

    const q = (await api().put(`${base}/performance/schedule`).set(await owner()).send({ quarterly: true, monthly: false }).expect(200)).body;
    expect(q).toMatchObject({ monthly: false, quarterly: true, annual: true });
    await run();
    const quarterly = (await api().get(`${base}/suppliers/${ctx.s2}/scorecards`).set(await inspector()).expect(200)).body.data.filter((c: { periodKind: string | null }) => c.periodKind === 'quarterly');
    expect(quarterly).toHaveLength(1);
  });

  it('covers only the chosen classifications when asked', async () => {
    const cls = (await admin.query(`select id from public.supplier_classifications where organisation_id = $1 order by sequence limit 1`, [ids.orgA])).rows[0].id;
    const s = (await api().put(`${base}/performance/schedule`).set(await owner()).send({ scope: 'classifications', classificationIds: [cls] }).expect(200)).body;
    expect(s.scope).toBe('classifications');
    expect(s.classifications).toEqual([expect.objectContaining({ id: cls, active: true })]);
    const otherCls = (await admin.query(`select id from public.supplier_classifications where organisation_id = $1 limit 1`, [ids.orgB])).rows[0].id;
    await api().put(`${base}/performance/schedule`).set(await owner()).send({ classificationIds: [otherCls] }).expect(409);
  });

  it('is invisible to another organisation', async () => {
    const s = (await api().get(`${base}/performance/schedule`).set(await other()).expect(200)).body;
    expect(s).toMatchObject({ monthly: false, quarterly: false, annual: false, setBy: null });
  });
});
