/**
 * PC10 through the API: one characteristic compared between machines (for a part and for a whole family) and between the
 * parts of a family — measured, pass/fail and defect-count — with what is left out and tenant isolation.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a4');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};
const N = 12;
const base = (i: number) => (i % 5 - 2) * 0.004;

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-analysis');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA);
  const fam = (await api().post('/api/v1/part-families').set(h).send({ code: 'HCR', name: 'Rods' }).expect(201)).body;
  ctx.fam = fam.id;
  for (const [key, pn] of [['p1', 'HCR-100'], ['p2', 'HCR-200']]) {
    const part = (await api().post('/api/v1/parts').set(h).send({ partNumber: pn, name: pn, partFamilyId: fam.id, initialRevision: { revision: 'A' } }).expect(201)).body;
    ctx[key] = part.id;
    await api().post(`/api/v1/part-revisions/${part.revisions[0].id}/release`).set(h).expect(200);
  }
  ctx.m1 = (await api().post('/api/v1/machines').set(h).send({ code: 'L1', name: 'Lathe 1', siteId: ids.siteA }).expect(201)).body.id;
  ctx.m2 = (await api().post('/api/v1/machines').set(h).send({ code: 'L2', name: 'Lathe 2', siteId: ids.siteA }).expect(201)).body.id;
  const plan = (await api().post('/api/v1/control-plans').set(h).send({ planCode: 'CP-1', title: 'Rods', partFamilyId: fam.id }).expect(201)).body;
  const planRev = plan.revisions[0].id;
  const rev = (await api().post(`/api/v1/control-plan-revisions/${planRev}/operations`).set(h).send({ operationCode: 'OP-020', name: 'Turning' }).expect(201)).body;
  const add = (body: object) => api().post(`/api/v1/control-plan-revisions/${planRev}/characteristics`).set(h).send({ operationId: rev.operations[0].id, ...body }).expect(201);
  const first = { triggerType: 'first_off', sampleSize: N };
  await add({ characteristicKey: 'OD', name: 'Outer diameter', nominal: 25, lowerLimit: 24.95, upperLimit: 25.05, unitCode: 'mm', criticality: 'major', sampling: [first] });
  await add({ characteristicKey: 'VISUAL', name: 'No chatter', dataType: 'attribute', criticality: 'minor', sampling: [first] });
  await add({ characteristicKey: 'SCRATCH', name: 'Scratches', dataType: 'count', criticality: 'minor', sampling: [first] });
  await api().patch(`/api/v1/control-plan-revisions/${planRev}`).set(h).send({ changeReason: 'First' }).expect(200);
  await api().post(`/api/v1/control-plan-revisions/${planRev}/transitions`).set(h).send({ action: 'submit' }).expect(200);
  await api().post(`/api/v1/control-plan-revisions/${planRev}/transitions`).set(h).send({ action: 'approve' }).expect(200);

  // Four inspections: part 1 on L1 and L2, part 2 on L1 and L2. L2 runs 0.03 high, fails 5× as many checks, scratches more.
  const run = async (part: string, machine: string, shift: number, fails: number, scratches: number) => {
    const rec = (await api().post('/api/v1/inspections').set(h).send({ siteId: ids.siteA, partId: part, machineId: machine, triggerType: 'first_off' }).expect(201)).body;
    const q = (k: string) => rec.requirements.find((r: { characteristicKey: string }) => r.characteristicKey === k).id;
    for (let i = 0; i < N; i++) {
      await api().post(`/api/v1/inspections/${rec.id}/samples`).set(h).send({
        readings: [
          { requirementId: q('OD'), valueNumeric: (25 + base(i) + shift).toFixed(4) },
          { requirementId: q('VISUAL'), valuePass: i >= fails },
          { requirementId: q('SCRATCH'), valueCount: i < scratches ? 3 : 0 },
        ],
      }).expect(201);
    }
    return rec.id as string;
  };
  await run(ctx.p1, ctx.m1, 0, 1, 1);
  await run(ctx.p1, ctx.m2, 0.03, 6, 6);
  await run(ctx.p2, ctx.m1, 0, 1, 1);
  ctx.abandoned = await run(ctx.p2, ctx.m2, 0.03, 6, 6);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

const get = async (query: string, user = ids.ownerA, org = ids.orgA) => api().get(`/api/v1/spc/analysis?${query}`).set(await as(user, org));

describe('machines', () => {
  it('compares machines for one part: position in the tolerance, Pp/Ppk and which one is different', async () => {
    const res = (await get(`groupBy=machine&partId=${ctx.p1}&characteristicKey=OD`).then((r) => (expect(r.status).toBe(200), r))).body;
    expect(res.scope).toMatchObject({ kind: 'part' });
    expect(res.characteristic).toMatchObject({ key: 'OD', kind: 'variable', unitCode: 'mm' });
    expect(res.groups.map((g: { label: string }) => g.label)).toEqual(['L1 · Lathe 1', 'L2 · Lathe 2']);
    const [l1, l2] = res.groups;
    expect(l1).toMatchObject({ n: 12, spec: { nominal: 25, lower: 24.95, upper: 25.05 }, outOfSpec: 0 });
    expect(l1.offsetPct).toBeCloseTo(-2, 4); // the twelve base readings average −0.001
    expect(l2.offsetPct).toBeCloseTo(58, 4); // plus 0.03 of a 0.05 half tolerance
    expect(l2.ppk).toBeLessThan(l1.ppk);
    expect(l1.pp).toBeCloseTo(l2.pp, 6); // same spread
    expect(l1.verdict).toBe('lower');
    expect(l2.verdict).toBe('higher');
    expect(res.toleranceScale).toBe(false);
    expect(res.warnings.join(' ')).toMatch(/fewer than 30 readings/);
  });

  it('a family compares machines across all its parts, counting an abandoned inspection as left out once it is abandoned', async () => {
    const before = (await get(`groupBy=machine&partFamilyId=${ctx.fam}&characteristicKey=OD`)).body;
    expect(before.groups.map((g: { n: number }) => g.n)).toEqual([24, 24]);
    await api().post(`/api/v1/inspections/${ctx.abandoned}/abandon`).set(await as(ids.ownerA)).send({ reason: 'Wrong part' }).expect(200);
    const after = (await get(`groupBy=machine&partFamilyId=${ctx.fam}&characteristicKey=OD`)).body;
    expect(after.groups.map((g: { n: number }) => g.n)).toEqual([24, 12]);
    expect(after.excluded).toEqual([expect.objectContaining({ reason: 'abandoned', count: 12 })]);
  });
});

describe('parts of a family', () => {
  it('compares the parts with each other', async () => {
    const res = (await get(`groupBy=part&partFamilyId=${ctx.fam}&characteristicKey=OD`)).body;
    expect(res.scope).toMatchObject({ kind: 'family' });
    expect(res.groups.map((g: { label: string }) => g.label)).toEqual(['HCR-100 · HCR-100', 'HCR-200 · HCR-200']);
    expect(res.groups.every((g: { partId: string | null }) => g.partId)).toBe(true);
  });
  it('refuses comparing parts without a family, and a request without a scope', async () => {
    expect((await get(`groupBy=part&partId=${ctx.p1}&characteristicKey=OD`)).status).toBe(400);
    expect((await get('groupBy=machine&characteristicKey=OD')).status).toBe(400);
    expect((await get(`groupBy=machine&partId=${ctx.p1}&partFamilyId=${ctx.fam}&characteristicKey=OD`)).status).toBe(400);
  });
});

describe('pass/fail and count characteristics', () => {
  it('pass/fail: failure rate per machine and the one that stands out', async () => {
    const res = (await get(`groupBy=machine&partId=${ctx.p1}&characteristicKey=VISUAL`)).body;
    expect(res.characteristic.kind).toBe('attribute');
    const [l1, l2] = res.groups;
    expect(l1).toMatchObject({ n: 12, failed: 1 });
    expect(l2).toMatchObject({ n: 12, failed: 6 });
    expect(l2.rate).toBeCloseTo(0.5, 6);
    expect(l2.mean).toBeNull();
    expect(res.overall).toMatchObject({ n: 24, rate: 7 / 24 });
  });
  it('count: defects per unit per machine', async () => {
    const res = (await get(`groupBy=machine&partId=${ctx.p1}&characteristicKey=SCRATCH`)).body;
    expect(res.characteristic.kind).toBe('count');
    expect(res.groups.map((g: { defects: number; perUnit: number }) => [g.defects, g.perUnit])).toEqual([[3, 0.25], [18, 1.5]]);
  });
});

describe('access', () => {
  it('404s for another organisation’s part or family, and needs a characteristic with readings', async () => {
    expect((await get(`groupBy=machine&partId=${ctx.p1}&characteristicKey=OD`, ids.ownerB, ids.orgB)).status).toBe(404);
    expect((await get(`groupBy=machine&partFamilyId=${ctx.fam}&characteristicKey=OD`, ids.ownerB, ids.orgB)).status).toBe(404);
    expect((await get(`groupBy=machine&partId=${ctx.p1}&characteristicKey=NOPE`)).status).toBe(404);
  });
  it('lists characteristics of a whole family, including those not marked for SPC', async () => {
    const h = await as(ids.ownerA);
    const list = (await api().get(`/api/v1/spc/characteristics?partFamilyId=${ctx.fam}&all=true`).set(h).expect(200)).body;
    expect(list.map((c: { key: string; readings: number }) => [c.key, c.readings])).toEqual([['OD', 48], ['SCRATCH', 48], ['VISUAL', 48]]);
    expect((await api().get(`/api/v1/spc/characteristics?partFamilyId=${ctx.fam}`).set(h).expect(200)).body).toEqual([]);
    expect((await api().get('/api/v1/spc/characteristics').set(h)).status).toBe(400);
  });
});
