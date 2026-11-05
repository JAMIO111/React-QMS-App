/**
 * PC3b through the API: parts with several customers (customer part numbers, one primary, search),
 * bulk family membership, and plan scopes for a single part — standalone plans and part plans that
 * override the family plan in the resolver.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('c');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-scope');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

/** A part with a released revision A. */
const part = async (h: Record<string, string>, partNumber: string, extra: object = {}) => {
  const p = (await api().post('/api/v1/parts').set(h).send({ partNumber, name: partNumber, initialRevision: { revision: 'A' }, ...extra }).expect(201)).body;
  await api().post(`/api/v1/part-revisions/${p.revisions[0].id}/release`).set(h).expect(200);
  return p.id as string;
};

/** A plan with one fixed check, scoped as given, made effective. */
const livePlan = async (h: Record<string, string>, planCode: string, scope: object) => {
  const plan = (await api().post('/api/v1/control-plans').set(h).send({ planCode, title: planCode }).expect(201)).body;
  await api().post(`/api/v1/control-plans/${plan.id}/applicability`).set(h).send(scope).expect(201);
  const revId = plan.revisions[0].id;
  const rev = (await api().post(`/api/v1/control-plan-revisions/${revId}/operations`).set(h).send({ operationCode: 'OP-010', name: 'Op' }).expect(201)).body;
  await api().post(`/api/v1/control-plan-revisions/${revId}/characteristics`).set(h)
    .send({ operationId: rev.operations[0].id, characteristicKey: 'OD', name: 'OD', upperLimit: 1, unitCode: 'mm' }).expect(201);
  await api().patch(`/api/v1/control-plan-revisions/${revId}`).set(h).send({ changeReason: 'First' }).expect(200);
  await api().post(`/api/v1/control-plan-revisions/${revId}/transitions`).set(h).send({ action: 'submit' }).expect(200);
  await api().post(`/api/v1/control-plan-revisions/${revId}/transitions`).set(h).send({ action: 'approve' }).expect(200);
  return plan.id as string;
};

describe('part customers', () => {
  it('links several customers with their own part numbers and one primary', async () => {
    const h = await as(ids.ownerA);
    for (const code of ['ACME', 'BETA']) ctx[code] = (await api().post('/api/v1/customers').set(h).send({ code, name: code }).expect(201)).body.id;
    ctx.rod = await part(h, 'HCR-100', { customerId: ctx.ACME });
    let detail = (await api().post(`/api/v1/parts/${ctx.rod}/customers`).set(h).send({ customerId: ctx.BETA, customerPartNumber: 'B-55012' }).expect(201)).body;
    expect(detail.customer).toMatchObject({ code: 'ACME' });
    expect(detail.customers.map((c: { customer: { code: string }; isPrimary: boolean; customerPartNumber: string | null }) => [c.customer.code, c.isPrimary, c.customerPartNumber])).toEqual([
      ['ACME', true, null],
      ['BETA', false, 'B-55012'],
    ]);
    const dup = await api().post(`/api/v1/parts/${ctx.rod}/customers`).set(h).send({ customerId: ctx.BETA }).expect(409);
    expect(dup.body.error.message).toBe('This customer is already linked to the part');

    const beta = detail.customers[1].id;
    detail = (await api().patch(`/api/v1/part-customers/${beta}`).set(h).send({ isPrimary: true }).expect(200)).body;
    expect(detail.customer.code).toBe('BETA');
    // Found by either customer and by the customer's part number.
    for (const filter of [`customerId=${ctx.ACME}`, `customerId=${ctx.BETA}`, 'q=B-550']) {
      const found = (await api().get(`/api/v1/parts?${filter}`).set(h).expect(200)).body.data;
      expect(found.map((p: { id: string }) => p.id)).toEqual([ctx.rod]);
    }
    detail = (await api().delete(`/api/v1/part-customers/${beta}`).set(h).expect(200)).body;
    expect(detail.customers.map((c: { customer: { code: string }; isPrimary: boolean }) => [c.customer.code, c.isPrimary])).toEqual([['ACME', true]]);
    await api().post(`/api/v1/parts/${ctx.rod}/customers`).set(await as(ids.inspectorA)).send({ customerId: ctx.BETA }).expect(403);
  });
});

describe('families, standalone and overriding plans', () => {
  it('adds and removes parts in bulk', async () => {
    const h = await as(ids.ownerA);
    ctx.family = (await api().post('/api/v1/part-families').set(h).send({ code: 'HCR', name: 'Rods' }).expect(201)).body.id;
    ctx.rod200 = await part(h, 'HCR-200');
    ctx.lone = await part(h, 'SPECIAL-1');
    let fam = (await api().post(`/api/v1/part-families/${ctx.family}/parts`).set(h).send({ add: [ctx.rod, ctx.rod200, ctx.lone] }).expect(200)).body;
    expect(fam.parts.map((p: { partNumber: string }) => p.partNumber)).toEqual(['HCR-100', 'HCR-200', 'SPECIAL-1']);
    fam = (await api().post(`/api/v1/part-families/${ctx.family}/parts`).set(h).send({ remove: [ctx.lone] }).expect(200)).body;
    expect(fam.partCount).toBe(2);
    await api().post(`/api/v1/part-families/${ctx.family}/parts`).set(h).send({ add: [ids.orgB] }).expect(400);
    await api().post(`/api/v1/part-families/${ctx.family}/parts`).set(h).send({}).expect(400);
  });

  it('resolves a standalone plan, and a part plan over the family plan', async () => {
    const h = await as(ids.ownerA);
    await api().post('/api/v1/control-plans').set(h).send({ planCode: 'CP-EMPTY', title: 'x' }).expect(201)
      .then((r) => api().post(`/api/v1/control-plans/${r.body.id}/applicability`).set(h).send({ siteId: ids.siteA }).expect(400));

    const special = await livePlan(h, 'CP-SPECIAL', { partId: ctx.lone });
    const plan = (await api().get(`/api/v1/control-plans/${special}`).set(h).expect(200)).body;
    expect(plan).toMatchObject({ families: [], parts: ['SPECIAL-1'], scopeParts: [{ partNumber: 'SPECIAL-1' }] });
    expect(plan.applicability[0]).toMatchObject({ partFamily: null, part: { partNumber: 'SPECIAL-1' } });
    let r = (await api().get(`/api/v1/control-plan-resolution?partId=${ctx.lone}`).set(h).expect(200)).body;
    expect(r).toMatchObject({ status: 'ok', plan: { planCode: 'CP-SPECIAL' }, scopeLevel: 'part', overriddenPlans: [] });

    await livePlan(h, 'CP-HCR', { partFamilyId: ctx.family });
    await livePlan(h, 'CP-HCR-100', { partId: ctx.rod });
    r = (await api().get(`/api/v1/control-plan-resolution?partId=${ctx.rod}`).set(h).expect(200)).body;
    expect(r).toMatchObject({ status: 'ok', plan: { planCode: 'CP-HCR-100' }, scopeLevel: 'part', overriddenPlans: [{ planCode: 'CP-HCR' }] });
    r = (await api().get(`/api/v1/control-plan-resolution?partId=${ctx.rod200}`).set(h).expect(200)).body;
    expect(r).toMatchObject({ status: 'ok', plan: { planCode: 'CP-HCR' }, scopeLevel: 'family', overriddenPlans: [] });
  });
});
