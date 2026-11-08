/**
 * Affected lots of a non-conformance through the API (TR4): naming lots and serials with quantities, per-lot dispositions and containment, the lot gate, removal and restore,
 * and the unchanged behaviour of an NC that names no lot. The rules themselves are tested in supabase/tests/ncr_affected_lots.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { categoryId, makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('d4');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};

const newNcr = async (title: string, partId: string | null = ctx.rod) => {
  const h = await as(ids.ownerA);
  return (await api().post('/api/v1/ncrs').set(h).send({ source: 'internal', title, severity: 'minor', quantityAffected: 10, description: title, siteId: ids.siteA, open: true, categoryId: await categoryId(admin, ids.orgA), ...(partId ? { partId } : {}) }).expect(201)).body.id as string;
};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-aff');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA);
  ctx.rod = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'ROD-1', name: 'Rod' }).expect(201)).body.id;
  ctx.other = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'PIN-1', name: 'Pin' }).expect(201)).body.id;
  ctx.lot1 = (await api().post('/api/v1/lots').set(h).send({ lotNumber: 'LOT-1', partId: ctx.rod, origin: 'produced' }).expect(201)).body.id;
  ctx.lot2 = (await api().post('/api/v1/lots').set(h).send({ lotNumber: 'LOT-2', partId: ctx.rod, origin: 'produced' }).expect(201)).body.id;
  ctx.lotPin = (await api().post('/api/v1/lots').set(h).send({ lotNumber: 'LOT-PIN', partId: ctx.other, origin: 'produced' }).expect(201)).body.id;
  ctx.s1 = (await api().post('/api/v1/serial-numbers').set(h).send({ partId: ctx.rod, lotId: ctx.lot1, serialNumber: 'SN-1' }).expect(201)).body.data[0].id;
  ctx.sOther = (await api().post('/api/v1/serial-numbers').set(h).send({ partId: ctx.rod, lotId: ctx.lot2, serialNumber: 'SN-9' }).expect(201)).body.data[0].id;
  ctx.nc = await newNcr('Bore oversize');
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('affected lots', () => {
  it('are added by people who can edit the NC, with validation and the database rules', async () => {
    const h = await as(ids.ownerA);
    const url = `/api/v1/ncrs/${ctx.nc}/affected-lots`;
    await api().post(url).set(await as(ids.dual)).send({ lotId: ctx.lot1, quantity: 4 }).expect(403);
    await api().post(url).set(h).send({ lotId: ctx.lot1, quantity: 0 }).expect(400);
    await api().post(url).set(h).send({ lotId: ctx.lot1, quantity: 4, extra: 1 }).expect(400);
    await api().post(`/api/v1/ncrs/${ids.orgB}/affected-lots`).set(h).send({ lotId: ctx.lot1, quantity: 4 }).expect(404);
    const wrongPart = await api().post(url).set(h).send({ lotId: ctx.lotPin, quantity: 4 }).expect(409);
    expect(wrongPart.body.error).toMatchObject({ code: 'ncr_rule' });
    expect(wrongPart.body.error.message).toContain('another part');
    const wrongSerial = await api().post(url).set(h).send({ lotId: ctx.lot1, quantity: 4, serialIds: [ctx.sOther] }).expect(409);
    expect(wrongSerial.body.error.message).toContain('Serial numbers must be serial numbers of lot LOT-1');
    const a = (await api().post(url).set(h).send({ lotId: ctx.lot1, quantity: 6, serialIds: [ctx.s1], note: ' First ' }).expect(201)).body;
    ctx.a1 = a.id;
    expect(a).toMatchObject({ lot: { id: ctx.lot1, lotNumber: 'LOT-1' }, quantity: 6, serials: [{ id: ctx.s1, serialNumber: 'SN-1' }], note: 'First', approvedQuantity: 0, proposedQuantity: 0, removedAt: null, createdBy: { name: 'Ada Owner' } });
    const tooMany = await api().post(url).set(h).send({ lotId: ctx.lot2, quantity: 5 }).expect(409);
    expect(tooMany.body.error.message).toContain('would total 11 but only 10 are affected');
    ctx.a2 = (await api().post(url).set(h).send({ lotId: ctx.lot2, quantity: 4 }).expect(201)).body.id;
  });

  it('are listed with what is placed in lots, what is left, and the lot gate problems', async () => {
    const h = await as(ids.ownerA);
    const list = (await api().get(`/api/v1/ncrs/${ctx.nc}/affected-lots`).set(h).expect(200)).body;
    expect(list).toMatchObject({ affected: 10, assigned: 10, remaining: 0, suggestedLot: null, problems: ['lot LOT-1: approved dispositions cover 0 of the 6 affected', 'lot LOT-2: approved dispositions cover 0 of the 4 affected'] });
    expect(list.data.map((a: { lot: { lotNumber: string } }) => a.lot.lotNumber)).toEqual(['LOT-1', 'LOT-2']);
    await api().get(`/api/v1/ncrs/${ctx.nc}/affected-lots`).set(await as(ids.ownerB, ids.orgB)).expect(404);
  });

  it('are updated, and the quantity cannot rise above what the NC affects', async () => {
    const h = await as(ids.ownerA);
    const up = (await api().patch(`/api/v1/ncr-affected-lots/${ctx.a2}`).set(h).send({ quantity: 3, note: null }).expect(200)).body;
    expect(up).toMatchObject({ quantity: 3, note: null });
    const refused = await api().patch(`/api/v1/ncr-affected-lots/${ctx.a2}`).set(h).send({ quantity: 5 }).expect(409);
    expect(refused.body.error.code).toBe('ncr_rule');
    await api().patch(`/api/v1/ncr-affected-lots/${ctx.a2}`).set(h).send({}).expect(400);
    await api().patch(`/api/v1/ncr-affected-lots/${ctx.a2}`).set(h).send({ lotId: ctx.lot1 }).expect(400);
    await api().patch(`/api/v1/ncr-affected-lots/${ctx.a2}`).set(h).send({ quantity: 4 }).expect(200);
  });
});

describe('dispositions and containment naming a lot', () => {
  it('carry the lot, and are held to that lot\'s quantity', async () => {
    const h = await as(ids.ownerA);
    const d = (await api().post(`/api/v1/ncrs/${ctx.nc}/dispositions`).set(h).send({ decision: 'scrap', quantity: 4, instructions: 'Scrap four', lotId: ctx.lot1 }).expect(201)).body;
    ctx.d1 = d.id;
    expect(d.lot).toEqual({ id: ctx.lot1, lotNumber: 'LOT-1' });
    const over = await api().post(`/api/v1/ncrs/${ctx.nc}/dispositions`).set(h).send({ decision: 'rework', quantity: 3, instructions: 'x', lotId: ctx.lot1 }).expect(409);
    expect(over.body.error.message).toContain('Dispositions for this lot would total 7 but only 6 of it are affected');
    const other = await api().post(`/api/v1/ncrs/${ctx.nc}/dispositions`).set(h).send({ decision: 'scrap', quantity: 1, instructions: 'x', lotId: ctx.lotPin }).expect(409);
    expect(other.body.error.message).toContain('Add the lot to the affected lots');
    const plain = (await api().post(`/api/v1/ncrs/${ctx.nc}/dispositions`).set(h).send({ decision: 'rework', quantity: 2, instructions: 'Rework the rest' }).expect(201)).body;
    expect(plain.lot).toBeNull();
    const moved = (await api().patch(`/api/v1/ncr-dispositions/${plain.id}`).set(h).send({ lotId: ctx.lot1 }).expect(200)).body;
    expect(moved.lot).toEqual({ id: ctx.lot1, lotNumber: 'LOT-1' });
    const list = (await api().get(`/api/v1/ncrs/${ctx.nc}/affected-lots`).set(h).expect(200)).body;
    expect(list.data[0]).toMatchObject({ proposedQuantity: 6, approvedQuantity: 0 });
    ctx.d2 = plain.id;
    const c = (await api().post(`/api/v1/ncrs/${ctx.nc}/containment-actions`).set(h).send({ kind: 'quarantine', description: 'Hold LOT-2', lotId: ctx.lot2 }).expect(201)).body;
    ctx.c1 = c.id;
    expect(c.lot).toEqual({ id: ctx.lot2, lotNumber: 'LOT-2' });
    await api().post(`/api/v1/ncrs/${ctx.nc}/containment-actions`).set(h).send({ kind: 'sort', description: 'x', lotId: ctx.lotPin }).expect(409);
  });

  it('keep a lot from being removed while they name it, and the gate wants every lot covered', async () => {
    const h = await as(ids.ownerA);
    const blocked = await api().post(`/api/v1/ncr-affected-lots/${ctx.a2}/remove`).set(h).send({ reason: 'Raised in error' }).expect(409);
    expect(blocked.body.error.message).toContain('cannot be removed while 1 disposition(s) or containment action(s) name it');
    await api().post(`/api/v1/ncr-containment-actions/${ctx.c1}/complete`).set(h).send({ note: 'Held' }).expect(200);
    await api().put(`/api/v1/ncrs/${ctx.nc}/containment-reason`).set(h).send({ reason: 'Held in the cage' }).expect(200);
    for (const id of [ctx.d1, ctx.d2]) await api().post(`/api/v1/ncr-dispositions/${id}/approve`).set(h).send({}).expect(200);
    const dd = (await api().post(`/api/v1/ncrs/${ctx.nc}/dispositions`).set(h).send({ decision: 'scrap', quantity: 4, instructions: 'Scrap four, lot not named' }).expect(201)).body;
    await api().post(`/api/v1/ncr-dispositions/${dd.id}/approve`).set(h).send({}).expect(200);
    const gates = (await api().get(`/api/v1/ncrs/${ctx.nc}/gates`).set(h).expect(200)).body;
    expect(gates.dispositioned).toEqual(['lot LOT-2: approved dispositions cover 0 of the 4 affected']);
    expect((await api().get(`/api/v1/ncrs/${ctx.nc}/affected-lots`).set(h).expect(200)).body.problems).toEqual(gates.dispositioned);
    const refused = await api().post(`/api/v1/ncrs/${ctx.nc}/transitions`).set(h).send({ to: 'dispositioned' }).expect(409);
    expect(refused.body.error.message).toContain('lot LOT-2');
    await api().post(`/api/v1/ncr-dispositions/${dd.id}/cancel`).set(h).send({ reason: 'Name the lot' }).expect(200);
    const lot2 = (await api().post(`/api/v1/ncrs/${ctx.nc}/dispositions`).set(h).send({ decision: 'scrap', quantity: 4, instructions: 'Scrap four from LOT-2', lotId: ctx.lot2 }).expect(201)).body;
    await api().post(`/api/v1/ncr-dispositions/${lot2.id}/approve`).set(h).send({}).expect(200);
    await api().post(`/api/v1/ncrs/${ctx.nc}/transitions`).set(h).send({ to: 'dispositioned' }).expect(200);
  });
});

describe('removing and restoring', () => {
  it('needs a reason, keeps the row, and restores unless the lot is live again', async () => {
    const h = await as(ids.ownerA);
    const nc = await newNcr('Remove and restore');
    const a = (await api().post(`/api/v1/ncrs/${nc}/affected-lots`).set(h).send({ lotId: ctx.lot1, quantity: 3 }).expect(201)).body;
    await api().post(`/api/v1/ncr-affected-lots/${a.id}/remove`).set(h).send({}).expect(400);
    await api().post(`/api/v1/ncr-affected-lots/${a.id}/remove`).set(await as(ids.dual)).send({ reason: 'x' }).expect(403);
    const removed = (await api().post(`/api/v1/ncr-affected-lots/${a.id}/remove`).set(h).send({ reason: 'Entered by mistake' }).expect(200)).body;
    expect(removed).toMatchObject({ removedReason: 'Entered by mistake', removedBy: { name: 'Ada Owner' }, removedAt: expect.any(String) });
    const list = (await api().get(`/api/v1/ncrs/${nc}/affected-lots`).set(h).expect(200)).body;
    expect(list).toMatchObject({ assigned: 0, remaining: 10 });
    expect(list.data).toHaveLength(1);
    await api().patch(`/api/v1/ncr-affected-lots/${a.id}`).set(h).send({ quantity: 5 }).expect(409);
    const again = (await api().post(`/api/v1/ncrs/${nc}/affected-lots`).set(h).send({ lotId: ctx.lot1, quantity: 2 }).expect(201)).body;
    await api().post(`/api/v1/ncr-affected-lots/${a.id}/restore`).set(h).expect(409);
    await api().post(`/api/v1/ncr-affected-lots/${again.id}/remove`).set(h).send({ reason: 'Replace it' }).expect(200);
    const restored = (await api().post(`/api/v1/ncr-affected-lots/${a.id}/restore`).set(h).expect(200)).body;
    expect(restored).toMatchObject({ removedAt: null, removedReason: null, quantity: 3 });
  });

  it('offers the NC\'s own lot as a suggestion, never adding it silently, and leaves an NC with no lots as it was', async () => {
    const h = await as(ids.ownerA);
    const nc = await newNcr('Lot on the NC itself');
    await admin.query(`update public.nonconformances set lot_id = $1 where id = $2`, [ctx.lot1, nc]);
    const list = (await api().get(`/api/v1/ncrs/${nc}/affected-lots`).set(h).expect(200)).body;
    expect(list).toMatchObject({ data: [], assigned: 0, suggestedLot: { id: ctx.lot1, lotNumber: 'LOT-1' } });
    await api().post(`/api/v1/ncrs/${nc}/affected-lots`).set(h).send({ lotId: ctx.lot1, quantity: 10 }).expect(201);
    expect((await api().get(`/api/v1/ncrs/${nc}/affected-lots`).set(h).expect(200)).body.suggestedLot).toBeNull();

    const plain = await newNcr('No lots anywhere', null);
    await api().put(`/api/v1/ncrs/${plain}/containment-reason`).set(h).send({ reason: 'Nothing shipped' }).expect(200);
    const d = (await api().post(`/api/v1/ncrs/${plain}/dispositions`).set(h).send({ decision: 'scrap', quantity: 10, instructions: 'Scrap all ten on the order' }).expect(201)).body;
    await api().post(`/api/v1/ncr-dispositions/${d.id}/approve`).set(h).send({}).expect(200);
    await api().post(`/api/v1/ncrs/${plain}/transitions`).set(h).send({ to: 'dispositioned' }).expect(200);
    const noLots = (await api().get(`/api/v1/ncrs/${plain}/affected-lots`).set(h).expect(200)).body;
    expect(noLots).toMatchObject({ data: [], problems: [], suggestedLot: null });
  });
});
