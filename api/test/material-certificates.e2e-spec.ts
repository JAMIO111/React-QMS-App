/**
 * Supplier quality SQ4c through the API: material certificates recorded against a supplier and traced to a receipt line, lot and heat number; who may record and who reviews;
 * agreement and duplicate rules; frozen once reviewed; withdrawal; the register and the receipt line's summary; tenant isolation.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('fd');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const owner = () => as(ids.ownerA);
const inspector = () => as(ids.inspectorA);
const other = () => as(ids.ownerB, ids.orgB);
const viewerId = ids.ownerA.replace(/a1$/, 'a6');
const ctx: Record<string, string> = {};
const base = '/api/v1/material-certificates';

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-mc');
  await admin.query(`insert into auth.users (id, email) values ($1, 'viewer@example.test') on conflict do nothing`, [viewerId]);
  const mem = await admin.query(`insert into public.organisation_users (organisation_id, user_id, status) values ($1, $2, 'active') returning id`, [ids.orgA, viewerId]);
  await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = 'viewer'`, [ids.orgA, mem.rows[0].id]);
  ctx.s1 = (await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'ACME', 'Acme Metals') returning id`, [ids.orgA])).rows[0].id;
  ctx.s2 = (await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'BOLT', 'Bolt Co') returning id`, [ids.orgA])).rows[0].id;
  ctx.part = (await admin.query(`insert into public.parts (organisation_id, part_number, name) values ($1, 'BAR-1', 'Steel bar') returning id`, [ids.orgA])).rows[0].id;
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  ctx.receipt = (await api().post('/api/v1/goods-receipts').set(await owner()).send({
    supplierId: ctx.s1, receivedOn: new Date().toISOString().slice(0, 10), deliveryNote: 'DN-1', clientKey: 'mc-key-0001',
    lines: [{ partId: ctx.part, quantity: 20, lotNumber: 'LOT-MC' }, { material: 'Loose coil', quantity: 3 }],
  }).expect(201)).body.id;
  const lines = (await api().get(`/api/v1/goods-receipts/${ctx.receipt}`).set(await owner()).expect(200)).body.lines;
  ctx.line1 = lines[0].id;
  ctx.line2 = lines[1].id;
  ctx.lot = lines[0].lot.id;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('material certificates', () => {
  it('are recorded by receiving staff, traced to the line, lot and part', async () => {
    const body = { supplierId: ctx.s1, certificateNumber: 'MTR-1', kind: 'mill_test_report', heatNumber: 'H-1', receiptLineId: ctx.line1 };
    await api().post(base).set(await as(viewerId)).send(body).expect(403);
    await api().post(base).set(await inspector()).send({ ...body, price: 1 }).expect(400);
    await api().post(base).set(await inspector()).send({ ...body, kind: 'bogus' }).expect(400);
    await api().post(base).set(await inspector()).send({ supplierId: ctx.s1, certificateNumber: 'X', kind: 'other', material: 'm' }).expect(409); // not traceable
    await api().post(base).set(await inspector()).send({ ...body, supplierId: ctx.s2 }).expect(409); // line of another supplier
    const made = (await api().post(base).set(await inspector()).send(body).expect(201)).body;
    ctx.c1 = made.id;
    expect(made).toMatchObject({ status: 'received', certificateNumber: 'MTR-1', heatNumber: 'H-1', part: { partNumber: 'BAR-1' }, lot: { id: ctx.lot, lotNumber: 'LOT-MC' }, receiptLine: { id: ctx.line1, lineNumber: 1 } });
    await api().post(base).set(await inspector()).send({ ...body, certificateNumber: 'mtr-1', heatNumber: 'h-1' }).expect(409); // duplicate
    const coil = (await api().post(base).set(await inspector()).send({ supplierId: ctx.s1, certificateNumber: 'COC-1', kind: 'certificate_of_conformance', receiptLineId: ctx.line2 }).expect(201)).body;
    ctx.c2 = coil.id;
    expect(coil).toMatchObject({ part: null, material: 'Loose coil' });
  });

  it('are edited until reviewed, and reviewed only by supplier quality managers', async () => {
    expect((await api().patch(`${base}/${ctx.c1}`).set(await inspector()).send({ specification: 'EN 10025' }).expect(200)).body.specification).toBe('EN 10025');
    await api().patch(`${base}/${ctx.c1}`).set(await inspector()).send({}).expect(400);
    await api().post(`${base}/${ctx.c1}/review`).set(await inspector()).send({ accept: true }).expect(403);
    await api().post(`${base}/${ctx.c2}/review`).set(await owner()).send({ accept: false }).expect(409); // a rejection needs a note
    const accepted = (await api().post(`${base}/${ctx.c1}/review`).set(await owner()).send({ accept: true, note: 'Matches the order' }).expect(200)).body;
    expect(accepted).toMatchObject({ status: 'accepted', reviewNote: 'Matches the order' });
    await api().post(`${base}/${ctx.c1}/review`).set(await owner()).send({ accept: true }).expect(409);
    await api().patch(`${base}/${ctx.c1}`).set(await inspector()).send({ notes: 'late' }).expect(409); // frozen
    expect((await api().post(`${base}/${ctx.c2}/review`).set(await owner()).send({ accept: false, note: 'Wrong grade' }).expect(200)).body.status).toBe('rejected');
  });

  it('show on the receipt line, in the register, and can be withdrawn with a reason', async () => {
    const lines = (await api().get(`/api/v1/goods-receipts/${ctx.receipt}`).set(await inspector()).expect(200)).body.lines;
    expect(lines[0].certificates).toEqual({ received: 0, accepted: 1, rejected: 0 });
    expect(lines[1].certificates).toEqual({ received: 0, accepted: 0, rejected: 1 });
    const live = (await api().get(`${base}?lotId=${ctx.lot}`).set(await inspector()).expect(200)).body;
    expect(live.data.map((c: { id: string }) => c.id)).toEqual([ctx.c1]);
    expect((await api().get(`${base}?status=all&q=coc`).set(await inspector()).expect(200)).body.total).toBe(1);
    await api().get(`${base}?status=bogus`).set(await inspector()).expect(400);
    await api().post(`${base}/${ctx.c2}/withdraw`).set(await inspector()).send({ reason: 'x' }).expect(400);
    const w = (await api().post(`${base}/${ctx.c2}/withdraw`).set(await inspector()).send({ reason: 'Wrong document attached' }).expect(200)).body;
    expect(w).toMatchObject({ status: 'withdrawn', withdrawalReason: 'Wrong document attached' });
    await api().post(`${base}/${ctx.c2}/withdraw`).set(await inspector()).send({ reason: 'again please' }).expect(409);
    const after = (await api().get(`/api/v1/goods-receipts/${ctx.receipt}`).set(await inspector()).expect(200)).body.lines;
    expect(after[1].certificates).toEqual({ received: 0, accepted: 0, rejected: 0 });
  });

  it('are invisible to another organisation', async () => {
    await api().get(`${base}/${ctx.c1}`).set(await other()).expect(404);
    expect((await api().get(`${base}?status=all`).set(await other()).expect(200)).body.total).toBe(0);
    await api().post(`${base}/${ctx.c1}/review`).set(await other()).send({ accept: true }).expect(404);
  });
});
