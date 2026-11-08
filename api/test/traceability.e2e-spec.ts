/**
 * Traceability through the API (TR5): an order, a lot or a serial number and everything recorded against it (inspections, non-conformances through a link or an affected lot, 8Ds,
 * machines and gauges), an order with no lots or serial numbers, search by number, and what a person who may not read inspections or NCs is told.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('f5');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};
const trace = async (type: string, id: string, h?: Record<string, string>) => (await api().get(`/api/v1/traceability?type=${type}&id=${id}`).set(h ?? (await as(ids.ownerA))).expect(200)).body;

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
const newNcr = async (h: Record<string, string>, title: string, extra: object) =>
  (await api().post('/api/v1/ncrs').set(h).send({ source: 'internal', title, severity: 'minor', quantityAffected: 10, description: title, siteId: ids.siteA, open: true, partId: ctx.rod, ...extra }).expect(201)).body.id as string;

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-trace');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA);
  ctx.machine = (await api().post('/api/v1/machines').set(h).send({ code: 'CNC-1', name: 'Lathe' }).expect(201)).body.id;
  ctx.rod = await makePart(h, 'ROD', 'ROD-1', 'CP-ROD');

  // WO-T1: lots and serial numbers. WO-T2: a work order and nothing else.
  ctx.wo1 = (await api().post('/api/v1/production-orders').set(h).send({ orderNumber: 'WO-T1', partId: ctx.rod, quantityPlanned: 20, siteId: ids.siteA }).expect(201)).body.id;
  await api().post(`/api/v1/production-orders/${ctx.wo1}/operations`).set(h).send({ operationCode: 'OP-10', description: 'Turning', machineId: ctx.machine }).expect(201);
  ctx.lot = (await api().post('/api/v1/lots').set(h).send({ lotNumber: 'LOT-T1', partId: ctx.rod, origin: 'produced', productionOrderId: ctx.wo1, quantity: 20 }).expect(201)).body.id;
  const sns = (await api().post('/api/v1/serial-numbers').set(h).send({ partId: ctx.rod, lotId: ctx.lot, serials: ['SN-T1', 'SN-T2'] }).expect(201)).body.data;
  ctx.s1 = sns.find((s: { serialNumber: string }) => s.serialNumber === 'SN-T1').id;
  ctx.s2 = sns.find((s: { serialNumber: string }) => s.serialNumber === 'SN-T2').id;
  ctx.job1 = (await api().post('/api/v1/jobs').set(h).send({ machineId: ctx.machine, partId: ctx.rod }).expect(201)).body.id;
  await api().put(`/api/v1/jobs/${ctx.job1}/production-links`).set(h).send({ serialId: ctx.s1 }).expect(200);
  ctx.ncLot = await newNcr(h, 'Bore oversize on lot', { lotId: ctx.lot });
  ctx.ncAffected = await newNcr(h, 'Found later in part of the lot', {});
  await api().post(`/api/v1/ncrs/${ctx.ncAffected}/affected-lots`).set(h).send({ lotId: ctx.lot, quantity: 4, serialIds: [ctx.s2] }).expect(201);
  ctx.capa = (await api().post('/api/v1/capas').set(h).send({ fromNcrId: ctx.ncLot }).expect(201)).body.id;

  ctx.wo2 = (await api().post('/api/v1/production-orders').set(h).send({ orderNumber: 'WO-T2', partId: ctx.rod, quantityPlanned: 24, siteId: ids.siteA }).expect(201)).body.id;
  ctx.job2 = (await api().post('/api/v1/jobs').set(h).send({ machineId: ctx.machine, partId: ctx.rod }).expect(201)).body.id;
  await api().put(`/api/v1/jobs/${ctx.job2}/production-links`).set(h).send({ productionOrderId: ctx.wo2 }).expect(200);
  ctx.ncOrder = await newNcr(h, 'Scrap on the work order', { productionOrderId: ctx.wo2 });
  // A failed reading on the work-order-only job (one reading, then a correction would replace it), a deleted NC, a cancelled NC and an 8D link that has ended: none may be counted.
  const rec = (await api().get(`/api/v1/inspections/${ctx.job2}`).set(h).expect(200)).body;
  await api().post(`/api/v1/inspections/${ctx.job2}/samples`).set(h).send({ readings: [{ requirementId: rec.requirements[0].id, valuePass: false }] }).expect(201);
  ctx.ncDeleted = await newNcr(h, 'Deleted NC', { productionOrderId: ctx.wo2 });
  ctx.ncCancelled = await newNcr(h, 'Cancelled NC', { productionOrderId: ctx.wo2 });
  await admin.query(`update public.nonconformances set deleted_at = now() where id = $1`, [ctx.ncDeleted]);
  await admin.query(`update public.nonconformances set stage = 'cancelled' where id = $1`, [ctx.ncCancelled]);
  ctx.capaEnded = (await api().post('/api/v1/capas').set(h).send({ fromNcrId: ctx.ncOrder }).expect(201)).body.id;
  await admin.query(`update public.capa_ncr_links set ended_at = now(), end_reason = 'Linked in error' where capa_id = $1`, [ctx.capaEnded]);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('an order with lots and serial numbers', () => {
  it('shows the order, its operations and machines, the lots, serial numbers, inspections and NCs, and the 8D on an NC', async () => {
    const t = await trace('order', ctx.wo1);
    expect(t.subject).toMatchObject({ type: 'order', number: 'WO-T1', status: 'planned', quantity: 20, part: { partNumber: 'ROD-1' }, site: { id: ids.siteA } });
    expect(t.order).toMatchObject({ orderNumber: 'WO-T1', operations: [{ code: 'OP-10', machine: { code: 'CNC-1' } }] });
    expect(t.lots).toMatchObject({ total: 1, data: [{ lotNumber: 'LOT-T1', origin: 'produced' }] });
    expect(t.serials.data.map((s: { serialNumber: string }) => s.serialNumber)).toEqual(['SN-T1', 'SN-T2']);
    expect(t.inspections).toMatchObject({ available: true, total: 1, inProgress: 1, data: [{ id: ctx.job1, serial: 'SN-T1', lot: 'LOT-T1' }] });
    expect(t.ncrs.total).toBe(2);
    const byTitle = Object.fromEntries(t.ncrs.data.map((n: { title: string }) => [n.title, n]));
    expect(byTitle['Bore oversize on lot']).toMatchObject({ matchedVia: 'linked', capas: [{ id: ctx.capa }] });
    expect(byTitle['Found later in part of the lot']).toMatchObject({ matchedVia: 'affected_lot', capas: [] });
    expect(t.equipment.machines).toEqual([expect.objectContaining({ code: 'CNC-1', inspections: 1, operations: 1 })]);
  });

  it('does not show records of another order', async () => {
    const t = await trace('order', ctx.wo2);
    expect(t.inspections).toMatchObject({ total: 1, failed: 0, data: [{ id: ctx.job2, failures: 1 }] });
    expect(t.ncrs.data.map((n: { id: string }) => n.id)).toEqual([ctx.ncOrder]);
    expect(t.ncrs.data[0].capas).toEqual([]);
    expect(t.lots).toEqual({ total: 0, data: [] });
    expect(t.serials).toEqual({ total: 0, data: [] });
  });
});

describe('a lot and a serial number', () => {
  it('a lot shows its order above it and what was recorded against the lot, including through an affected lot', async () => {
    const t = await trace('lot', ctx.lot);
    expect(t.subject).toMatchObject({ type: 'lot', number: 'LOT-T1', quantity: 20 });
    expect(t.order.orderNumber).toBe('WO-T1');
    expect(t.inspections.total).toBe(1);
    expect(t.ncrs.data.map((n: { matchedVia: string }) => n.matchedVia).sort()).toEqual(['affected_lot', 'linked']);
    expect(t.serials.total).toBe(2);
  });

  it('a serial number matches its own records, and an NC through the serial numbers named on an affected lot', async () => {
    const one = await trace('serial', ctx.s1);
    expect(one.subject).toMatchObject({ type: 'serial', number: 'SN-T1' });
    expect(one.order.orderNumber).toBe('WO-T1');
    expect(one.lots.data.map((l: { lotNumber: string }) => l.lotNumber)).toEqual(['LOT-T1']);
    expect(one.inspections.data.map((i: { id: string }) => i.id)).toEqual([ctx.job1]);
    expect(one.ncrs.total).toBe(0);
    const two = await trace('serial', ctx.s2);
    expect(two.inspections.total).toBe(0);
    expect(two.ncrs.data).toMatchObject([{ id: ctx.ncAffected, matchedVia: 'affected_lot' }]);
  });
});

describe('the NC register', () => {
  it('filters by order and by lot with the same rule as the report: linked, or naming one of its lots', async () => {
    const h = await as(ids.ownerA);
    const titles = async (query: string) => ((await api().get(`/api/v1/ncrs?${query}`).set(h).expect(200)).body.data as { title: string }[]).map((n) => n.title).sort();
    expect(await titles(`productionOrderId=${ctx.wo1}`)).toEqual(['Bore oversize on lot', 'Found later in part of the lot']);
    expect(await titles(`lotId=${ctx.lot}`)).toEqual(['Bore oversize on lot', 'Found later in part of the lot']);
    // The register lists cancelled NCs too (the report does not); deleted ones are hidden by default.
    expect(await titles(`productionOrderId=${ctx.wo2}`)).toEqual(['Cancelled NC', 'Scrap on the work order']);
    await api().get('/api/v1/ncrs?productionOrderId=nope').set(h).expect(400);
    await api().get('/api/v1/ncrs?lotId=nope').set(h).expect(400);
    // A removed affected lot no longer matches.
    await admin.query(`update public.ncr_affected_lots set removed_at = now(), removed_reason = 'Test' where nonconformance_id = $1`, [ctx.ncAffected]);
    try {
      expect(await titles(`lotId=${ctx.lot}`)).toEqual(['Bore oversize on lot']);
      expect(await titles(`productionOrderId=${ctx.wo1}`)).toEqual(['Bore oversize on lot']);
    } finally {
      await admin.query(`update public.ncr_affected_lots set removed_at = null, removed_reason = null where nonconformance_id = $1`, [ctx.ncAffected]);
    }
  });
});

describe('what people may see', () => {
  it('says a section is unavailable, rather than empty, when the caller may not read it', async () => {
    const role = (await admin.query(`select id from public.roles where organisation_id = $1 and key = 'inspector'`, [ids.orgA])).rows[0].id;
    const removed = (await admin.query(`delete from public.role_permissions where role_id = $1 and permission_code in ('ncr.read', 'inspection.read') returning permission_code`, [role])).rows;
    try {
      const t = await trace('order', ctx.wo1, await as(ids.inspectorA));
      expect(t.ncrs).toEqual({ available: false, total: 0, data: [] });
      expect(t.inspections).toMatchObject({ available: false, total: 0, data: [] });
      expect(t.equipment.machines).toEqual([expect.objectContaining({ code: 'CNC-1', inspections: 0, operations: 1 })]);
      expect(t.equipment.gauges).toEqual([]);
      expect(t.lots.total).toBe(1);
    } finally {
      for (const r of removed) await admin.query(`insert into public.role_permissions (role_id, permission_code) values ($1, $2)`, [role, r.permission_code]);
    }
  });

  it('is closed to people outside the organisation and to other organisations', async () => {
    await api().get(`/api/v1/traceability?type=order&id=${ctx.wo1}`).set(await as(ids.outsider)).expect(404);
    await api().get(`/api/v1/traceability?type=order&id=${ctx.wo1}`).set(await as(ids.ownerB, ids.orgB)).expect(404);
  });

  it('refuses a bad type, a missing id and anything extra', async () => {
    const h = await as(ids.ownerA);
    await api().get(`/api/v1/traceability?type=gauge&id=${ctx.wo1}`).set(h).expect(400);
    await api().get('/api/v1/traceability?type=order').set(h).expect(400);
    await api().get(`/api/v1/traceability?type=order&id=${ctx.wo1}&x=1`).set(h).expect(400);
    await api().get('/api/v1/traceability?type=order&id=00000000-0000-4000-8000-000000000009').set(h).expect(404);
  });
});

describe('search', () => {
  it('finds orders, lots and serial numbers by part of the number, the exact match first', async () => {
    const h = await as(ids.ownerA);
    const all = (await api().get('/api/v1/traceability/search?q=T1').set(h).expect(200)).body.data;
    expect(all.map((r: { type: string; number: string }) => `${r.type}:${r.number}`).sort()).toEqual(['lot:LOT-T1', 'order:WO-T1', 'serial:SN-T1']);
    // 'AWO-T2' also contains the text and sorts first, yet the exact match comes first.
    await api().post('/api/v1/production-orders').set(h).send({ orderNumber: 'AWO-T2', partId: ctx.rod, quantityPlanned: 1, siteId: ids.siteA }).expect(201);
    const exact = (await api().get('/api/v1/traceability/search?q=wo-t2').set(h).expect(200)).body.data;
    expect(exact).toMatchObject([{ type: 'order', number: 'WO-T2', part: { partNumber: 'ROD-1' } }, { type: 'order', number: 'AWO-T2' }]);
    expect((await api().get('/api/v1/traceability/search?q=100%25').set(h).expect(200)).body.data).toEqual([]);
    await api().get('/api/v1/traceability/search').set(h).expect(400);
    await api().get('/api/v1/traceability/search?q=T1').set(await as(ids.ownerB, ids.orgB)).expect(200).expect((r) => expect(r.body.data).toEqual([]));
  });
});
