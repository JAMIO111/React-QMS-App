/**
 * Production links through the API (TR3b): the organisation settings for lots and serials, orders made from a job's picker (and who may), jobs and non-conformances linked to
 * an order, lot and serial (the typed text filled from them), an order required to complete a job, and the backfill of typed work orders, lots and serial numbers.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('f4');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};

const setSettings = async (body: object) => (await api().patch('/api/v1/organisations/current').set(await as(ids.ownerA)).send({ settings: body }).expect(200)).body;

const makePart = async (h: Record<string, string>, family: string, partNumber: string, planCode: string) => {
  const fam = (await api().post('/api/v1/part-families').set(h).send({ code: family, name: family }).expect(201)).body;
  const part = (await api().post('/api/v1/parts').set(h).send({ partNumber, name: partNumber, partFamilyId: fam.id, initialRevision: { revision: 'A' } }).expect(201)).body;
  const plan = (await api().post('/api/v1/control-plans').set(h).send({ planCode, title: planCode, partFamilyId: fam.id }).expect(201)).body;
  const rev = plan.revisions[0].id;
  const op = (await api().post(`/api/v1/control-plan-revisions/${rev}/operations`).set(h).send({ operationCode: 'OP-10', name: 'Turning' }).expect(201)).body.operations[0].id;
  await api().post(`/api/v1/control-plan-revisions/${rev}/characteristics`).set(h).send({ operationId: op, characteristicKey: 'VIS', name: 'Visual', dataType: 'attribute', sampling: [{ triggerType: 'first_off', sampleSize: 1 }] }).expect(201);
  await api().patch(`/api/v1/control-plan-revisions/${rev}`).set(h).send({ changeReason: 'First' }).expect(200);
  await api().post(`/api/v1/part-revisions/${part.revisions[0].id}/release`).set(h).expect(200);
  await api().post(`/api/v1/control-plan-revisions/${rev}/transitions`).set(h).send({ action: 'submit' }).expect(200);
  await api().post(`/api/v1/control-plan-revisions/${rev}/transitions`).set(h).send({ action: 'approve' }).expect(200);
  return part.id as string;
};
const startJob = async (h: Record<string, string>, partId: string, extra: object = {}) =>
  (await api().post('/api/v1/jobs').set(h).send({ machineId: ctx.machine, partId, ...extra }).expect(201)).body;

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-links');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA);
  ctx.machine = (await api().post('/api/v1/machines').set(h).send({ code: 'CNC-1', name: 'Lathe' }).expect(201)).body.id;
  ctx.rod = await makePart(h, 'ROD', 'ROD-1', 'CP-ROD');
  ctx.pin = await makePart(h, 'PIN', 'PIN-1', 'CP-PIN');
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('organisation settings', () => {
  it('start as before (lots and serials on, nothing else) and an owner can change them', async () => {
    const org = (await api().get('/api/v1/organisations/current').set(await as(ids.ownerA)).expect(200)).body;
    expect(org.settings).toMatchObject({ useLotsAndSerials: true, allowInlineOrders: false, requireProductionOrder: false });
    expect((await setSettings({ useLotsAndSerials: false })).settings.useLotsAndSerials).toBe(false);
    expect((await setSettings({ useLotsAndSerials: true })).settings.useLotsAndSerials).toBe(true);
  });

  it('cannot be changed by an inspector, and refuse anything that is not a setting', async () => {
    await api().patch('/api/v1/organisations/current').set(await as(ids.inspectorA)).send({ settings: { allowInlineOrders: true } }).expect(403);
    await api().patch('/api/v1/organisations/current').set(await as(ids.ownerA)).send({ settings: { allowInlineOrders: 'yes' } }).expect(400);
  });
});

describe('orders made from the job’s order picker', () => {
  const body = (n: string) => ({ orderNumber: n, partId: ctx.rod, quantityPlanned: 24 });

  it('an owner (production.manage) can; an inspector cannot while the setting is off', async () => {
    const made = await api().post('/api/v1/production-orders/inline').set(await as(ids.ownerA)).send(body('WO-154789')).expect(201);
    expect(made.body).toMatchObject({ orderNumber: 'WO-154789', status: 'planned', quantityPlanned: 24, part: { partNumber: 'ROD-1' }, site: { id: ids.siteA } });
    ctx.wo = made.body.id;
    const no = await api().post('/api/v1/production-orders/inline').set(await as(ids.inspectorA)).send(body('WO-OP-1')).expect(403);
    expect(no.body.error.code).toBe('forbidden');
  });

  it('with allowInlineOrders on, an inspector can make an order (never a lot or serial)', async () => {
    await setSettings({ allowInlineOrders: true });
    const inspector = await as(ids.inspectorA);
    const made = await api().post('/api/v1/production-orders/inline').set(inspector).send(body('WO-OP-1')).expect(201);
    expect(made.body.orderNumber).toBe('WO-OP-1');
    await api().post('/api/v1/lots').set(inspector).send({ lotNumber: 'LOT-X', partId: ctx.rod, origin: 'produced' }).expect(403);
    await api().post('/api/v1/serial-numbers').set(inspector).send({ partId: ctx.rod, serialNumber: 'SN-X' }).expect(403);
    await api().post('/api/v1/production-orders/inline').set(inspector).send(body('wo-op-1')).expect(409); // a number already used
    await setSettings({ allowInlineOrders: false });
    await api().post('/api/v1/production-orders/inline').set(inspector).send(body('WO-OP-2')).expect(403);
  });

  it('validates the body and refuses another organisation’s part', async () => {
    const h = await as(ids.ownerA);
    await api().post('/api/v1/production-orders/inline').set(h).send({ orderNumber: '', partId: ctx.rod, quantityPlanned: 1 }).expect(400);
    await api().post('/api/v1/production-orders/inline').set(h).send({ orderNumber: 'WO-Z', partId: ctx.rod, quantityPlanned: 0 }).expect(400);
    await api().post('/api/v1/production-orders/inline').set(await as(ids.ownerB, ids.orgB)).send({ orderNumber: 'WO-Z', partId: ctx.rod, quantityPlanned: 1 }).expect(404);
  });
});

describe('a job linked to its order (no lots or serial numbers needed)', () => {
  it('starts on an order, shows the link and the work order text it filled in, and is found by order', async () => {
    const h = await as(ids.ownerA);
    const job = await startJob(h, ctx.rod, { productionOrderId: ctx.wo });
    ctx.job = job.id;
    expect(job.links).toMatchObject({ productionOrder: { id: ctx.wo, orderNumber: 'WO-154789', status: 'planned' }, lot: null, serial: null });
    expect(job.workOrder).toBe('WO-154789');
    const listed = (await api().get(`/api/v1/inspections?productionOrderId=${ctx.wo}`).set(h).expect(200)).body;
    expect(listed.data.map((i: { id: string }) => i.id)).toEqual([job.id]);
    expect((await api().get(`/api/v1/inspections?productionOrderId=${ctx.pin}`).set(h).expect(200)).body.total).toBe(0);
  });

  it('is linked and unlinked afterwards (null clears) without touching the typed text', async () => {
    const h = await as(ids.ownerA);
    const cleared = (await api().put(`/api/v1/jobs/${ctx.job}/production-links`).set(h).send({ productionOrderId: null }).expect(200)).body;
    expect(cleared.links.productionOrder).toBeNull();
    expect(cleared.workOrder).toBe('WO-154789');
    const again = (await api().put(`/api/v1/jobs/${ctx.job}/production-links`).set(h).send({ productionOrderId: ctx.wo }).expect(200)).body;
    expect(again.links.productionOrder.orderNumber).toBe('WO-154789');
    await api().put(`/api/v1/jobs/${ctx.job}/production-links`).set(h).send({}).expect(400);
    await api().put(`/api/v1/jobs/${ctx.job}/production-links`).set(h).send({ hacked: 1 }).expect(400);
  });

  it('an operator can link it too, and an order for another part is refused in words', async () => {
    const inspector = await as(ids.inspectorA);
    const other = (await api().post('/api/v1/production-orders').set(await as(ids.ownerA)).send({ orderNumber: 'WO-PIN-1', partId: ctx.pin, quantityPlanned: 5, siteId: ids.siteA }).expect(201)).body.id;
    ctx.woPin = other;
    const refused = await api().put(`/api/v1/jobs/${ctx.job}/production-links`).set(inspector).send({ productionOrderId: other }).expect(409);
    expect(refused.body.error).toMatchObject({ code: 'production_rule', message: expect.stringContaining('another part') });
  });

  it('a serial number brings its lot and order; a lot brings its order', async () => {
    const owner = await as(ids.ownerA);
    const lot = (await api().post('/api/v1/lots').set(owner).send({ lotNumber: 'LOT-1', partId: ctx.rod, origin: 'produced', productionOrderId: ctx.wo }).expect(201)).body;
    const sn = (await api().post('/api/v1/serial-numbers').set(owner).send({ partId: ctx.rod, lotId: lot.id, serialNumber: 'SN-1' }).expect(201)).body.data[0];
    const job = await startJob(owner, ctx.rod);
    expect(job.links).toEqual({ productionOrder: null, lot: null, serial: null });
    const linked = (await api().put(`/api/v1/jobs/${job.id}/production-links`).set(owner).send({ serialId: sn.id }).expect(200)).body;
    expect(linked.links).toMatchObject({ productionOrder: { orderNumber: 'WO-154789' }, lot: { lotNumber: 'LOT-1' }, serial: { serialNumber: 'SN-1' } });
    expect([linked.workOrder, linked.lot, linked.serial]).toEqual(['WO-154789', 'LOT-1', 'SN-1']);
    ctx.lot = lot.id;
    ctx.sn = sn.id;
    await api().post(`/api/v1/inspections/${job.id}/abandon`).set(owner).send({ reason: 'Test' }).expect(200);
  });

  it('shows a lot on hold in the link, as information', async () => {
    const owner = await as(ids.ownerA);
    await api().patch(`/api/v1/lots/${ctx.lot}`).set(owner).send({ status: 'on_hold', statusReason: 'Suspect material' }).expect(200);
    const job = (await api().get(`/api/v1/inspections/${ctx.job}`).set(owner).expect(200)).body;
    const linked = (await api().put(`/api/v1/jobs/${ctx.job}/production-links`).set(owner).send({ lotId: ctx.lot }).expect(200)).body;
    expect(linked.links.lot).toMatchObject({ lotNumber: 'LOT-1', status: 'on_hold', statusReason: 'Suspect material' });
    expect(job.status).toBe('in_progress');
  });
});

describe('a non-conformance linked to its order', () => {
  it('is created on an order (the part comes with it), then moved to a lot', async () => {
    const h = await as(ids.ownerA);
    const nc = (await api().post('/api/v1/ncrs').set(h).send({ source: 'internal', title: 'Burr on WO-154789', productionOrderId: ctx.wo }).expect(201)).body;
    ctx.ncr = nc.id;
    expect(nc.links.productionOrder).toMatchObject({ orderNumber: 'WO-154789' });
    expect(nc.workOrder).toBe('WO-154789');
    expect(nc.part).toMatchObject({ partNumber: 'ROD-1' });
    const moved = (await api().patch(`/api/v1/ncrs/${nc.id}`).set(h).send({ lotId: ctx.lot }).expect(200)).body;
    expect(moved.links.lot).toMatchObject({ lotNumber: 'LOT-1' });
    expect(moved.lotNumber).toBe('LOT-1');
    const wrong = await api().patch(`/api/v1/ncrs/${nc.id}`).set(h).send({ productionOrderId: ctx.woPin }).expect(409);
    expect(wrong.body.error.code).toBe('production_rule');
  });
});

describe('an order required to complete a job', () => {
  it('stops a job without an order from completing, in words', async () => {
    await setSettings({ requireProductionOrder: true });
    const h = await as(ids.ownerA);
    const job = await startJob(h, ctx.pin);
    await api().post(`/api/v1/inspections/${job.id}/samples`).set(h).send({ readings: [{ requirementId: job.requirements[0].id, valuePass: true }] }).expect(201);
    const refused = await api().post(`/api/v1/inspections/${job.id}/complete`).set(h).expect(409);
    expect(refused.body.error).toMatchObject({ code: 'inspection_rule', message: expect.stringContaining('production order') });
    await api().put(`/api/v1/jobs/${job.id}/production-links`).set(h).send({ productionOrderId: ctx.woPin }).expect(200);
    const done = (await api().post(`/api/v1/inspections/${job.id}/complete`).set(h).expect(200)).body;
    expect(done).toMatchObject({ status: 'completed', result: 'pass', links: { productionOrder: { orderNumber: 'WO-PIN-1' } } });
    await setSettings({ requireProductionOrder: false });
  });
});

describe('the backfill of typed work orders, lots and serial numbers', () => {
  it('is for people who manage the organisation, and reports a dry run by default', async () => {
    await api().post('/api/v1/production/backfill').set(await as(ids.inspectorA)).send({}).expect(403);
    const owner = await as(ids.ownerA);
    // Typed records: a job and an NC on the same work order, an NC on a lot nobody has made, an NC with no part.
    const typed = await startJob(owner, ctx.pin);
    await api().patch(`/api/v1/jobs/${typed.id}`).set(owner).send({ workOrder: 'wo-typed-1', lot: 'TL-1', serial: 'TS-1' }).expect(200);
    await api().post(`/api/v1/inspections/${typed.id}/abandon`).set(owner).send({ reason: 'History' }).expect(200);
    ctx.typedJob = typed.id;
    ctx.typedNcr = (await api().post('/api/v1/ncrs').set(owner).send({ source: 'internal', title: 'Typed NC', partId: ctx.pin, workOrder: 'WO-TYPED-1', lotNumber: 'tl-1' }).expect(201)).body.id;
    ctx.partlessNcr = (await api().post('/api/v1/ncrs').set(owner).send({ source: 'internal', title: 'No part', workOrder: 'WO-NOPART' }).expect(201)).body.id;
    const dry = (await api().post('/api/v1/production/backfill').set(owner).send({}).expect(200)).body;
    expect(dry).toMatchObject({ dryRun: true, orders: { new: 1, matched: 0, skipped: [] }, lots: { new: 1 }, serialNumbers: { new: 1 }, recordsToLink: 2, noPart: 1, inspectionsLinked: 0, ncrsLinked: 0 });
    expect((await api().get(`/api/v1/inspections/${ctx.typedJob}`).set(owner).expect(200)).body.links.productionOrder).toBeNull();
    await api().post('/api/v1/production/backfill').set(owner).send({ dryRun: 'no' }).expect(400);
    await api().post('/api/v1/production/backfill').set(owner).send({ extra: true }).expect(400);
  });

  it('links the records and leaves the typed text as it was; a second run has nothing left', async () => {
    const owner = await as(ids.ownerA);
    const done = (await api().post('/api/v1/production/backfill').set(owner).send({ dryRun: false }).expect(200)).body;
    expect(done).toMatchObject({ dryRun: false, inspectionsLinked: 1, ncrsLinked: 1, conflicts: 0 });
    const job = (await api().get(`/api/v1/inspections/${ctx.typedJob}`).set(owner).expect(200)).body;
    expect(job.links).toMatchObject({ productionOrder: { orderNumber: expect.stringMatching(/^wo-typed-1$/i) }, lot: { lotNumber: 'TL-1' }, serial: { serialNumber: 'TS-1' } });
    expect(job.workOrder).toBe('wo-typed-1');
    const nc = (await api().get(`/api/v1/ncrs/${ctx.typedNcr}`).set(owner).expect(200)).body;
    expect(nc.links).toMatchObject({ productionOrder: { orderNumber: expect.stringMatching(/^wo-typed-1$/i) }, lot: { lotNumber: 'TL-1' } });
    expect([nc.workOrder, nc.lotNumber]).toEqual(['WO-TYPED-1', 'tl-1']);
    expect((await api().get(`/api/v1/ncrs/${ctx.partlessNcr}`).set(owner).expect(200)).body.links.productionOrder).toBeNull();
    const order = (await api().get(`/api/v1/production-orders?q=wo-typed-1`).set(owner).expect(200)).body.data[0];
    expect(order).toMatchObject({ status: 'released', lotCount: 1, serialCount: 1 });
    const again = (await api().post('/api/v1/production/backfill').set(owner).send({ dryRun: false }).expect(200)).body;
    expect(again).toMatchObject({ recordsToLink: 0, inspectionsLinked: 0, ncrsLinked: 0, orders: { new: 0 }, lots: { new: 0 }, serialNumbers: { new: 0 } });
  });

  it('works on the caller’s organisation only', async () => {
    const other = (await api().post('/api/v1/production/backfill').set(await as(ids.ownerB, ids.orgB)).send({}).expect(200)).body;
    expect(other).toMatchObject({ recordsToLink: 0, orders: { new: 0 } });
    expect(JSON.stringify(other)).not.toMatch(/wo-typed/i);
  });
});
