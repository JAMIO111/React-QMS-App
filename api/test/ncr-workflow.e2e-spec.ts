/**
 * NC containment and disposition through the API: containment actions (done needs a note, cancel a reason), the "not needed" reason, dispositions (proposed, approved by
 * an approver, frozen, never above the quantity affected), the cumulative stage gates and what the gates endpoint says. The rules themselves are tested in
 * supabase/tests/ncr_containment_disposition.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('c9');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};

const newNcr = async (title: string) => {
  const h = await as(ids.ownerA);
  const id = (await api().post('/api/v1/ncrs').set(h).send({ source: 'internal', title, severity: 'minor', quantityAffected: 10, description: title, siteId: ids.siteA, open: true }).expect(201)).body.id;
  return id as string;
};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-ncw');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA);
  ctx.emp = (await api().post('/api/v1/employees').set(h).send({ firstName: 'Ada', surname: 'Lovelace' }).expect(201)).body.id;
  ctx.nc = await newNcr('Bore oversize');
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('containment actions', () => {
  it('are added by people who can edit the NC, with validation', async () => {
    const h = await as(ids.ownerA);
    const url = `/api/v1/ncrs/${ctx.nc}/containment-actions`;
    await api().post(url).set(await as(ids.dual)).send({ kind: 'quarantine', description: 'Quarantine lot 77' }).expect(403);
    await api().post(url).set(h).send({ kind: 'bogus', description: 'x' }).expect(400);
    await api().post(url).set(h).send({ kind: 'sort', description: '   ' }).expect(400);
    await api().post(url).set(h).send({ kind: 'sort', description: 'x', status: 'done' }).expect(400);
    await api().post(`/api/v1/ncrs/${ids.orgB}/containment-actions`).set(h).send({ kind: 'sort', description: 'x' }).expect(404);
    const a = (await api().post(url).set(h).send({ kind: 'quarantine', description: ' Quarantine lot 77 in the cage ', ownerEmployeeId: ctx.emp, dueDate: '2026-12-01', quantityContained: 120 }).expect(201)).body;
    ctx.a1 = a.id;
    expect(a).toMatchObject({ kind: 'quarantine', description: 'Quarantine lot 77 in the cage', status: 'open', owner: { id: ctx.emp, name: 'Ada Lovelace' }, dueDate: '2026-12-01', quantityContained: 120, doneAt: null, createdBy: { name: 'Ada Owner' } });
  });

  it('say what is still needed, and block the stage until resolved', async () => {
    const h = await as(ids.ownerA);
    const c = (await api().get(`/api/v1/ncrs/${ctx.nc}/containment`).set(h).expect(200)).body;
    expect(c).toMatchObject({ resolved: false, notNeededReason: null, problems: ['1 containment action is still open'] });
    const refused = await api().post(`/api/v1/ncrs/${ctx.nc}/transitions`).set(h).send({ to: 'contained' }).expect(409);
    expect(refused.body.error).toMatchObject({ code: 'ncr_rule', message: 'Before this can move to contained: 1 containment action is still open' });
  });

  it('are done with a note, which is kept with who and when, and are then frozen until reopened', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/ncr-containment-actions/${ctx.a1}/complete`).set(h).send({}).expect(400);
    await api().post(`/api/v1/ncr-containment-actions/${ctx.a1}/complete`).set(h).send({ note: '  ' }).expect(400);
    await api().post(`/api/v1/ncr-containment-actions/${ctx.a1}/complete`).set(await as(ids.dual)).send({ note: 'x' }).expect(403);
    const done = (await api().post(`/api/v1/ncr-containment-actions/${ctx.a1}/complete`).set(h).send({ note: '120 quarantined, none shipped', quantityContained: 118 }).expect(200)).body;
    expect(done).toMatchObject({ status: 'done', doneNote: '120 quarantined, none shipped', quantityContained: 118, doneBy: { name: 'Ada Owner' }, doneAt: expect.any(String) });
    const frozen = await api().patch(`/api/v1/ncr-containment-actions/${ctx.a1}`).set(h).send({ description: 'Changed' }).expect(409);
    expect(frozen.body.error.code).toBe('ncr_rule');
    const reopened = (await api().post(`/api/v1/ncr-containment-actions/${ctx.a1}/reopen`).set(h).expect(200)).body;
    expect(reopened).toMatchObject({ status: 'open', doneAt: null, doneBy: null });
    await api().patch(`/api/v1/ncr-containment-actions/${ctx.a1}`).set(h).send({ description: 'Quarantine lot 77 and 78' }).expect(200);
    await api().post(`/api/v1/ncr-containment-actions/${ctx.a1}/complete`).set(h).send({ note: 'Done again' }).expect(200);
  });

  it('are cancelled with a reason and never deleted', async () => {
    const h = await as(ids.ownerA);
    const a = (await api().post(`/api/v1/ncrs/${ctx.nc}/containment-actions`).set(h).send({ kind: 'notify_customer', description: 'Tell the customer' }).expect(201)).body;
    await api().post(`/api/v1/ncr-containment-actions/${a.id}/cancel`).set(h).send({}).expect(400);
    const c = (await api().post(`/api/v1/ncr-containment-actions/${a.id}/cancel`).set(h).send({ reason: 'Not shipped, nothing to tell' }).expect(200)).body;
    expect(c).toMatchObject({ status: 'cancelled', cancelReason: 'Not shipped, nothing to tell' });
    await api().delete(`/api/v1/ncr-containment-actions/${a.id}`).set(h).expect(404);
    const list = (await api().get(`/api/v1/ncrs/${ctx.nc}/containment`).set(h).expect(200)).body;
    expect(list.actions.map((x: { status: string }) => x.status)).toEqual(['done', 'cancelled']);
    expect(list).toMatchObject({ resolved: true, problems: [] });
  });

  it('can be replaced by a reason that none is needed', async () => {
    const h = await as(ids.ownerA);
    const nc = await newNcr('Found at first-off');
    expect((await api().get(`/api/v1/ncrs/${nc}/containment`).set(h).expect(200)).body).toMatchObject({ resolved: false, problems: ['record a containment action, or say why none is needed'] });
    await api().put(`/api/v1/ncrs/${nc}/containment-reason`).set(h).send({ reason: '   ' }).expect(400);
    await api().put(`/api/v1/ncrs/${nc}/containment-reason`).set(await as(ids.dual)).send({ reason: 'x' }).expect(403);
    const set = (await api().put(`/api/v1/ncrs/${nc}/containment-reason`).set(h).send({ reason: 'Nothing had left the cell' }).expect(200)).body;
    expect(set).toMatchObject({ resolved: true, notNeededReason: 'Nothing had left the cell' });
    await api().post(`/api/v1/ncrs/${nc}/transitions`).set(h).send({ to: 'contained' }).expect(200);
    expect((await api().put(`/api/v1/ncrs/${nc}/containment-reason`).set(h).send({ reason: null }).expect(200)).body).toMatchObject({ resolved: false, notNeededReason: null });
  });
});

describe('dispositions', () => {
  it('are proposed within the quantity affected, and refused beyond it', async () => {
    const h = await as(ids.ownerA);
    const url = `/api/v1/ncrs/${ctx.nc}/dispositions`;
    await api().post(url).set(await as(ids.dual)).send({ decision: 'scrap', quantity: 1, instructions: 'x' }).expect(403);
    await api().post(url).set(h).send({ decision: 'bogus', quantity: 1, instructions: 'x' }).expect(400);
    await api().post(url).set(h).send({ decision: 'scrap', quantity: 0, instructions: 'x' }).expect(400);
    await api().post(url).set(h).send({ decision: 'scrap', quantity: 1, instructions: '' }).expect(400);
    const d1 = (await api().post(url).set(h).send({ decision: 'scrap', quantity: 6, instructions: ' Scrap 6 ' }).expect(201)).body;
    ctx.d1 = d1.id;
    expect(d1).toMatchObject({ decision: 'scrap', quantity: 6, instructions: 'Scrap 6', status: 'proposed', approvedAt: null, reference: null });
    const over = await api().post(url).set(h).send({ decision: 'rework', quantity: 5, instructions: 'Rework' }).expect(409);
    expect(over.body.error.message).toBe('Dispositions would total 11 but only 10 are affected (6 already covered)');
    ctx.d2 = (await api().post(url).set(h).send({ decision: 'concession', quantity: 4, instructions: 'Use as is under concession' }).expect(201)).body.id;
  });

  it('are summarised for the card: what is covered, what is left and whether the caller can approve', async () => {
    const owner = (await api().get(`/api/v1/ncrs/${ctx.nc}/dispositions`).set(await as(ids.ownerA)).expect(200)).body;
    expect(owner).toMatchObject({ affected: 10, approvedQuantity: 0, proposedQuantity: 10, remaining: 0, canApprove: true, settled: false });
    expect(owner.problems).toEqual(['2 proposed dispositions are still to approve or cancel', 'approved dispositions cover 0 of the 10 affected']);
    expect((await api().get(`/api/v1/ncrs/${ctx.nc}/dispositions`).set(await as(ids.dual)).expect(200)).body.canApprove).toBe(false);
    // The disposition card lists only disposition problems: containment is shown on its own card.
    const fresh = await newNcr('No containment yet');
    expect((await api().get(`/api/v1/ncrs/${fresh}/dispositions`).set(await as(ids.ownerA)).expect(200)).body.problems).toEqual(['approved dispositions cover 0 of the 10 affected']);
  });

  it('block Dispositioned until approved, whatever stage the NC is skipping from', async () => {
    const h = await as(ids.ownerA);
    for (const to of ['dispositioned', 'awaiting_closure', 'closed']) {
      const r = await api().post(`/api/v1/ncrs/${ctx.nc}/transitions`).set(h).send({ to }).expect(409);
      expect(r.body.error.message).toMatch(/^Before this can move to .*: 2 proposed dispositions are still to approve or cancel; approved dispositions cover 0 of the 10 affected$/);
    }
  });

  it('are approved only by an approver, and are then frozen', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/ncr-dispositions/${ctx.d1}/approve`).set(await as(ids.dual)).send({}).expect(403);
    const approved = (await api().post(`/api/v1/ncr-dispositions/${ctx.d1}/approve`).set(h).send({ note: '  Agreed  ' }).expect(200)).body;
    expect(approved).toMatchObject({ status: 'approved', approvedBy: { name: 'Ada Owner' }, approvalNote: 'Agreed', approvedAt: expect.any(String) });
    expect((await api().post(`/api/v1/ncr-dispositions/${ctx.d1}/approve`).set(h).send({}).expect(409)).body.error.code).toBe('ncr_rule');
    expect((await api().patch(`/api/v1/ncr-dispositions/${ctx.d1}`).set(h).send({ quantity: 5 }).expect(409)).body.error.message).toBe('This disposition is approved; only a proposed one can be changed');
  });

  it('need a reference for a concession before it can be approved', async () => {
    const h = await as(ids.ownerA);
    const refused = await api().post(`/api/v1/ncr-dispositions/${ctx.d2}/approve`).set(h).send({}).expect(409);
    expect(refused.body.error.message).toMatch(/^A concession needs a reference/);
    await api().patch(`/api/v1/ncr-dispositions/${ctx.d2}`).set(h).send({ reference: ' CUST-CONC-0042 ' }).expect(200);
    const ok = (await api().post(`/api/v1/ncr-dispositions/${ctx.d2}/approve`).set(h).send({}).expect(200)).body;
    expect(ok).toMatchObject({ status: 'approved', reference: 'CUST-CONC-0042' });
  });

  it('let the NC skip ahead once containment and dispositions are settled', async () => {
    const h = await as(ids.ownerA);
    expect((await api().get(`/api/v1/ncrs/${ctx.nc}/gates`).set(h).expect(200)).body).toEqual({ contained: [], investigating: [], dispositioned: [], awaitingClosure: [], closed: [] });
    const moved = (await api().post(`/api/v1/ncrs/${ctx.nc}/transitions`).set(h).send({ to: 'awaiting_closure' }).expect(200)).body;
    expect(moved.stage).toBe('awaiting_closure');
  });

  it('are cancelled with a reason, which frees the quantity and reopens the gate', async () => {
    const h = await as(ids.ownerA);
    const nc = await newNcr('Cancel test');
    await api().put(`/api/v1/ncrs/${nc}/containment-reason`).set(h).send({ reason: 'None needed' }).expect(200);
    const d = (await api().post(`/api/v1/ncrs/${nc}/dispositions`).set(h).send({ decision: 'scrap', quantity: 10, instructions: 'Scrap all' }).expect(201)).body;
    await api().post(`/api/v1/ncr-dispositions/${d.id}/approve`).set(h).send({}).expect(200);
    expect((await api().get(`/api/v1/ncrs/${nc}/gates`).set(h).expect(200)).body.closed).toEqual([]);
    await api().post(`/api/v1/ncr-dispositions/${d.id}/cancel`).set(h).send({}).expect(400);
    await api().post(`/api/v1/ncr-dispositions/${d.id}/cancel`).set(await as(ids.dual)).send({ reason: 'x' }).expect(403);
    const c = (await api().post(`/api/v1/ncr-dispositions/${d.id}/cancel`).set(h).send({ reason: 'Customer wants rework instead' }).expect(200)).body;
    expect(c).toMatchObject({ status: 'cancelled', cancelReason: 'Customer wants rework instead', cancelledBy: { name: 'Ada Owner' } });
    expect((await api().get(`/api/v1/ncrs/${nc}/dispositions`).set(h).expect(200)).body).toMatchObject({ approvedQuantity: 0, remaining: 10, settled: false });
    expect((await api().get(`/api/v1/ncrs/${nc}/gates`).set(h).expect(200)).body.closed).toEqual(['approved dispositions cover 0 of the 10 affected']);
  });

  it('cannot be lowered under by changing the quantity affected', async () => {
    const h = await as(ids.ownerA);
    const nc = await newNcr('Quantity test');
    await api().post(`/api/v1/ncrs/${nc}/dispositions`).set(h).send({ decision: 'scrap', quantity: 8, instructions: 'Scrap 8' }).expect(201);
    const r = await api().patch(`/api/v1/ncrs/${nc}`).set(h).send({ quantityAffected: 5 }).expect(409);
    expect(r.body.error.message).toMatch(/^Dispositions already cover 8 items/);
    await api().patch(`/api/v1/ncrs/${nc}`).set(h).send({ quantityAffected: 8 }).expect(200);
  });

  it('are locked once the NC is closed', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/ncrs/${ctx.nc}/transitions`).set(h).send({ to: 'closed' }).expect(200);
    const r = await api().post(`/api/v1/ncrs/${ctx.nc}/containment-actions`).set(h).send({ kind: 'sort', description: 'late' }).expect(409);
    expect(r.body.error.message).toBe('This non-conformance is closed; reopen it to make changes');
    await api().post(`/api/v1/ncrs/${ctx.nc}/dispositions`).set(h).send({ decision: 'scrap', quantity: 1, instructions: 'late' }).expect(409);
  });
});
