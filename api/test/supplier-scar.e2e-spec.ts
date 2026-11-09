/**
 * Supplier quality SQ3 through the API: SCARs raised against one supplier and linked to that supplier's own non-conformances, taken through response, review, implementation and
 * effectiveness verification as separate records (a response never closes one), with idempotent creation, due-date extensions, overdue worked out on read and tenant isolation.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('fa');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const owner = () => as(ids.ownerA);
const reader = () => as(ids.inspectorA);
const other = () => as(ids.ownerB, ids.orgB);
const qmId = ids.ownerA.replace(/a1$/, 'a4');
const engId = ids.ownerA.replace(/a1$/, 'a5');
const manager = () => as(qmId);
const engineer = () => as(engId);
const ctx: Record<string, string> = {};
const base = '/api/v1/supplier-quality';
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-sqs');
  for (const [user, role] of [[qmId, 'quality_manager'], [engId, 'quality_engineer']] as const) {
    await admin.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [user, `${role}@example.test`]);
    const mem = await admin.query(`insert into public.organisation_users (organisation_id, user_id, status) values ($1, $2, 'active') returning id`, [ids.orgA, user]);
    await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = $3`, [ids.orgA, mem.rows[0].id, role]);
  }
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await owner();
  for (const [key, code, name] of [['s1', 'ACME', 'Acme Metals'], ['s2', 'BOLT', 'Bolt Co']]) {
    ctx[key] = (await api().post(`${base}/suppliers`).set(h).send({ code, name }).expect(201)).body.id;
  }
  ctx.contact = (await api().post(`${base}/suppliers/${ctx.s1}/contacts`).set(h).send({ name: 'Quality contact', role: 'quality' }).expect(201)).body.contacts?.[0]?.id ?? '';
  const nc = async (ref: string, supplier: string, org = ids.orgA) =>
    (await admin.query(`insert into public.nonconformances (organisation_id, reference, source, title, supplier_id) values ($1, $2, 'supplier', $3, $4) returning id`, [org, ref, `NC ${ref}`, supplier])).rows[0].id as string;
  ctx.nc1 = await nc('SC-1', ctx.s1);
  ctx.nc2 = await nc('SC-2', ctx.s1);
  ctx.ncOther = await nc('SC-3', ctx.s2);
  ctx.ncCancelled = await nc('SC-4', ctx.s1);
  await admin.query(`update public.nonconformances set stage = 'cancelled', stage_reason = 'Raised in error' where id = $1`, [ctx.ncCancelled]);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

const NEW = (over: Record<string, unknown> = {}) => ({ supplierId: ctx.s1, title: 'Bent brackets', problemDescription: 'Brackets arrive bent', severity: 'major', responseDueOn: day(14), ncrIds: [ctx.nc1], ...over });
const RESPONSE = (over: Record<string, unknown> = {}) => ({ rootCause: 'Jig worn', containment: 'Stock quarantined', correctiveAction: 'Replace the jig', preventiveAction: 'Monthly jig check', respondedOn: day(0), respondedByName: 'Their quality manager', ...over });

describe('raising a SCAR', () => {
  it('needs manage, a known supplier and that supplier\'s own live non-conformances', async () => {
    await api().post(`${base}/scars`).set(await reader()).send(NEW()).expect(403);
    await api().post(`${base}/scars`).set(await engineer()).send({ ...NEW(), status: 'closed' }).expect(400); // unknown field
    await api().post(`${base}/scars`).set(await engineer()).send(NEW({ title: 'ab' })).expect(400);
    await api().post(`${base}/scars`).set(await engineer()).send(NEW({ severity: 'huge' })).expect(400);
    expect((await api().post(`${base}/scars`).set(await engineer()).send(NEW({ responseDueOn: day(-2) }))).status).toBe(409);
    expect((await api().post(`${base}/scars`).set(await engineer()).send(NEW({ ncrIds: [ctx.ncOther] }))).status).toBe(409); // another supplier's NC
    expect((await api().post(`${base}/scars`).set(await engineer()).send(NEW({ ncrIds: [ctx.ncCancelled] }))).status).toBe(409);
    await api().post(`${base}/scars`).set(await engineer()).send(NEW({ supplierId: '00000000-0000-0000-0000-000000000001' })).expect(404);
    const list = (await api().get(`${base}/scars?status=all`).set(await owner()).expect(200)).body;
    expect(list.total).toBe(0); // the failed attempts left nothing behind
  });

  it('is idempotent: a retry with the same client key returns the same SCAR', async () => {
    const h = await engineer();
    const first = (await api().post(`${base}/scars`).set(h).send(NEW({ clientKey: 'key-0001-abcdef' })).expect(201)).body;
    ctx.scar = first.id;
    expect(first).toMatchObject({ status: 'draft', severity: 'major', title: 'Bent brackets', supplier: { code: 'ACME' }, ncrCount: 1, overdue: false });
    expect(first.reference).toMatch(/^SCAR-\d{2}-\d{4}$/);
    expect(first.ncrs).toHaveLength(1);
    expect(first.history.map((x: { toStatus: string }) => x.toStatus)).toEqual(['draft']);
    const again = (await api().post(`${base}/scars`).set(h).send(NEW({ clientKey: 'key-0001-abcdef' })).expect(201)).body;
    expect(again.id).toBe(first.id);
    expect((await api().get(`${base}/scars?status=all`).set(await owner()).expect(200)).body.total).toBe(1);
    expect((await api().post(`${base}/scars`).set(h).send(NEW({ supplierId: ctx.s2, ncrIds: [ctx.ncOther], clientKey: 'key-0001-abcdef' }))).status).toBe(409);
  });

  it('a draft can be edited and given more non-conformances', async () => {
    const h = await engineer();
    expect((await api().patch(`${base}/scars/${ctx.scar}`).set(h).send({ title: 'Bent brackets on pallet 4', severity: 'critical' }).expect(200)).body).toMatchObject({ title: 'Bent brackets on pallet 4', severity: 'critical' });
    await api().patch(`${base}/scars/${ctx.scar}`).set(h).send({}).expect(400);
    await api().patch(`${base}/scars/${ctx.scar}`).set(h).send({ status: 'closed' }).expect(400);
    const linked = (await api().post(`${base}/scars/${ctx.scar}/ncrs`).set(h).send({ ncrId: ctx.nc2 }).expect(200)).body;
    expect(linked.ncrs.filter((n: { endedAt: string | null }) => !n.endedAt)).toHaveLength(2);
    const link2 = linked.ncrs.find((n: { ncr: { id: string } }) => n.ncr.id === ctx.nc2).linkId;
    expect((await api().post(`${base}/scar-ncrs/${link2}/unlink`).set(h).send({ reason: 'x' })).status).toBe(400);
    const unlinked = (await api().post(`${base}/scar-ncrs/${link2}/unlink`).set(h).send({ reason: 'Raised against the wrong supplier' }).expect(200)).body;
    expect(unlinked.ncrs.find((n: { linkId: string }) => n.linkId === link2)).toMatchObject({ endReason: 'Raised against the wrong supplier' });
    expect(unlinked.ncrCount).toBe(1);
  });
});

describe('the stages', () => {
  it('cannot be skipped, and a response never closes a SCAR', async () => {
    const h = await engineer();
    expect((await api().post(`${base}/scars/${ctx.scar}/responses`).set(h).send(RESPONSE())).status).toBe(409); // a draft
    await api().post(`${base}/scars/${ctx.scar}/issue`).set(await reader()).send({}).expect(403);
    const issued = (await api().post(`${base}/scars/${ctx.scar}/issue`).set(h).send({}).expect(200)).body;
    expect(issued).toMatchObject({ status: 'issued', issuedBy: { id: engId } });
    expect((await api().post(`${base}/scars/${ctx.scar}/issue`).set(h).send({})).status).toBe(409);
    expect((await api().patch(`${base}/scars/${ctx.scar}`).set(h).send({ title: 'Changed after issue' })).status).toBe(409);
    expect((await api().post(`${base}/scars/${ctx.scar}/start-review`).set(h).send({})).status).toBe(409);
    expect((await api().post(`${base}/scars/${ctx.scar}/implementations`).set(h).send({ description: 'Fixed', implementedOn: day(0) })).status).toBe(409);
    const ack = (await api().post(`${base}/scars/${ctx.scar}/acknowledge`).set(h).send({ note: 'Confirmed by phone' }).expect(200)).body;
    expect(ack).toMatchObject({ status: 'acknowledged', acknowledgedNote: 'Confirmed by phone' });
    await api().post(`${base}/scars/${ctx.scar}/responses`).set(h).send(RESPONSE({ rootCause: '' })).expect(400);
    await api().post(`${base}/scars/${ctx.scar}/responses`).set(h).send(RESPONSE({ respondedOn: 'tomorrow' })).expect(400);
    expect((await api().post(`${base}/scars/${ctx.scar}/responses`).set(h).send(RESPONSE({ respondedOn: day(2) }))).status).toBe(409); // in the future
    const responded = (await api().post(`${base}/scars/${ctx.scar}/responses`).set(h).send(RESPONSE()).expect(200)).body;
    expect(responded.status).toBe('response_received');
    expect(responded.responses).toHaveLength(1);
    expect(responded.responses[0]).toMatchObject({ seq: 1, rootCause: 'Jig worn', review: null, receivedBy: { id: engId } });
    expect(responded.closedAt).toBeNull();
  });

  it('are reviewed: a revision request brings a second response and keeps the first', async () => {
    const h = await engineer();
    expect((await api().post(`${base}/scars/${ctx.scar}/review`).set(h).send({ decision: 'accepted', note: 'Fine' })).status).toBe(409); // review not started
    expect((await api().post(`${base}/scars/${ctx.scar}/start-review`).set(h).send({}).expect(200)).body.status).toBe('under_review');
    await api().post(`${base}/scars/${ctx.scar}/review`).set(h).send({ decision: 'maybe', note: 'Unsure' }).expect(400);
    await api().post(`${base}/scars/${ctx.scar}/review`).set(h).send({ decision: 'accepted', note: '' }).expect(400);
    const rev = (await api().post(`${base}/scars/${ctx.scar}/review`).set(h).send({ decision: 'revision_requested', note: 'Preventive action is vague' }).expect(200)).body;
    expect(rev.status).toBe('revision_requested');
    expect(rev.responses[0].review).toMatchObject({ decision: 'revision_requested', note: 'Preventive action is vague' });
    const second = (await api().post(`${base}/scars/${ctx.scar}/responses`).set(h).send(RESPONSE({ rootCause: 'Jig worn and not on the PM plan', preventiveAction: 'Weekly check recorded' })).expect(200)).body;
    expect(second.responses.map((r: { seq: number }) => r.seq)).toEqual([1, 2]);
    expect(second.responses[0].rootCause).toBe('Jig worn');
    await api().post(`${base}/scars/${ctx.scar}/start-review`).set(h).send({}).expect(200);
    const accepted = (await api().post(`${base}/scars/${ctx.scar}/review`).set(h).send({ decision: 'accepted', note: 'Accepted' }).expect(200)).body;
    expect(accepted.status).toBe('accepted');
    expect(accepted.responses[1].review).toMatchObject({ decision: 'accepted' });
  });

  it('are implemented and then verified; only an approver can verify, and a failed check sends it back', async () => {
    const h = await engineer();
    expect((await api().post(`${base}/scars/${ctx.scar}/implementations`).set(h).send({ description: 'Fixed', implementedOn: day(3) })).status).toBe(409); // future
    const impl = (await api().post(`${base}/scars/${ctx.scar}/implementations`).set(h).send({ description: 'New jig fitted', implementedOn: day(0), evidenceNote: 'Photo emailed' }).expect(200)).body;
    expect(impl.status).toBe('verifying');
    expect(impl.implementations).toHaveLength(1);
    await api().post(`${base}/scars/${ctx.scar}/verifications`).set(h).send({ result: 'effective', method: 'Next three deliveries', note: 'All good' }).expect(403);
    await api().post(`${base}/scars/${ctx.scar}/verifications`).set(await manager()).send({ result: 'effective', method: 'ab', note: 'All good' }).expect(400);
    const failed = (await api().post(`${base}/scars/${ctx.scar}/verifications`).set(await manager()).send({ result: 'not_effective', method: 'Next delivery checked', note: 'Two brackets still bent' }).expect(200)).body;
    expect(failed.status).toBe('revision_requested');
    expect(failed.verifications).toHaveLength(1);
    await api().post(`${base}/scars/${ctx.scar}/responses`).set(h).send(RESPONSE({ rootCause: 'Wrong material grade', correctiveAction: 'Change the material' })).expect(200);
    await api().post(`${base}/scars/${ctx.scar}/start-review`).set(h).send({}).expect(200);
    await api().post(`${base}/scars/${ctx.scar}/review`).set(h).send({ decision: 'accepted', note: 'Accepted' }).expect(200);
    await api().post(`${base}/scars/${ctx.scar}/implementations`).set(h).send({ description: 'Material changed', implementedOn: day(0) }).expect(200);
    const closed = (await api().post(`${base}/scars/${ctx.scar}/verifications`).set(await manager()).send({ result: 'effective', method: 'Next three deliveries', note: 'All within tolerance' }).expect(200)).body;
    expect(closed).toMatchObject({ status: 'closed', closedBy: { id: qmId } });
    expect(closed.closedAt).not.toBeNull();
    expect(closed.history.map((x: { toStatus: string }) => x.toStatus)).toEqual([
      'draft', 'issued', 'acknowledged', 'response_received', 'under_review', 'revision_requested', 'response_received', 'under_review', 'accepted', 'verifying',
      'revision_requested', 'response_received', 'under_review', 'accepted', 'verifying', 'closed',
    ]);
    expect((await api().post(`${base}/scars/${ctx.scar}/cancel`).set(h).send({ reason: 'Too late to cancel' })).status).toBe(409);
    expect((await api().post(`${base}/scars/${ctx.scar}/ncrs`).set(h).send({ ncrId: ctx.nc2 })).status).toBe(409);
  });
});

describe('due dates, overdue and cancelling', () => {
  it('an extension is requested, then approved or rejected by a different approver; the due date moves only on approval', async () => {
    const h = await engineer();
    const draft = (await api().post(`${base}/scars`).set(h).send(NEW({ title: 'Wrong finish', ncrIds: [ctx.nc2] })).expect(201)).body;
    ctx.scar2 = draft.id;
    const ask = (body: Record<string, unknown>, who = h) => api().post(`${base}/scars/${ctx.scar2}/extensions`).set(who).send(body);
    expect((await ask({ newDueOn: day(21), reason: 'More time' })).status).toBe(409); // a draft
    await api().post(`${base}/scars/${ctx.scar2}/issue`).set(h).send({}).expect(200);
    expect((await ask({ newDueOn: day(7), reason: 'Earlier' })).status).toBe(409);
    await ask({ newDueOn: day(21), reason: '' }).expect(400);
    await ask({ newDueOn: day(21), reason: 'Supplier on holiday' }).set(await reader()).expect(403);
    const requested = (await ask({ newDueOn: day(21), reason: 'Supplier on holiday' }).expect(200)).body;
    expect(requested).toMatchObject({ responseDueOn: day(14), originalResponseDueOn: day(14) }); // not moved yet
    expect(requested.extensions).toEqual([expect.objectContaining({ previousDueOn: day(14), newDueOn: day(21), status: 'pending', canDecide: false, extendedBy: { id: engId, name: expect.any(String) } })]);
    ctx.ext1 = requested.extensions[0].id;
    expect((await ask({ newDueOn: day(28), reason: 'Another' })).status).toBe(409); // one waiting at a time
    // the engineer cannot decide at all, and the approver sees they can
    await api().post(`${base}/scar-extensions/${ctx.ext1}/decide`).set(h).send({ approve: true, note: 'Fine by me' }).expect(403);
    expect((await api().get(`${base}/scars/${ctx.scar2}`).set(await manager()).expect(200)).body.extensions[0].canDecide).toBe(true);
    await api().post(`${base}/scar-extensions/${ctx.ext1}/decide`).set(await manager()).send({ approve: true, note: 'x' }).expect(400);
    const approved = (await api().post(`${base}/scar-extensions/${ctx.ext1}/decide`).set(await manager()).send({ approve: true, note: 'Justified: holiday shutdown' }).expect(200)).body;
    expect(approved).toMatchObject({ responseDueOn: day(21), originalResponseDueOn: day(14) });
    expect(approved.extensions[0]).toMatchObject({ status: 'approved', decidedBy: { id: qmId }, decisionNote: 'Justified: holiday shutdown', canDecide: false });
    expect((await api().post(`${base}/scar-extensions/${ctx.ext1}/decide`).set(await manager()).send({ approve: false, note: 'Changed my mind' })).status).toBe(409); // final
    // a rejection leaves the date alone; nobody decides their own request; the person who asked can withdraw
    const second = (await ask({ newDueOn: day(35), reason: 'Still not ready' }).expect(200)).body.extensions.find((e: { status: string }) => e.status === 'pending');
    const rejected = (await api().post(`${base}/scar-extensions/${second.id}/decide`).set(await manager()).send({ approve: false, note: 'No: chase the supplier' }).expect(200)).body;
    expect(rejected.responseDueOn).toBe(day(21));
    expect(rejected.extensions.find((e: { id: string }) => e.id === second.id)).toMatchObject({ status: 'rejected' });
    const own = (await ask({ newDueOn: day(40), reason: 'Approver asks too' }, await manager()).expect(200)).body.extensions.find((e: { status: string }) => e.status === 'pending');
    expect(own.canDecide).toBe(false);
    expect((await api().post(`${base}/scar-extensions/${own.id}/decide`).set(await manager()).send({ approve: true, note: 'Approving my own request' })).status).toBe(409);
    await api().post(`${base}/scar-extensions/${own.id}/withdraw`).set(await manager()).send({ reason: 'x' }).expect(400);
    const w = (await api().post(`${base}/scar-extensions/${own.id}/withdraw`).set(await manager()).send({ reason: 'Asked in error' }).expect(200)).body;
    expect(w.extensions.find((e: { id: string }) => e.id === own.id)).toMatchObject({ status: 'withdrawn', decisionNote: 'Asked in error' });
    await api().post(`${base}/scar-extensions/00000000-0000-0000-0000-000000000001/decide`).set(await manager()).send({ approve: true, note: 'Nothing here' }).expect(404);
  });

  it('works out overdue on read, only while a response is awaited', async () => {
    // an issued SCAR whose due date has passed (set directly: the API refuses a past date)
    await admin.query(`update public.supplier_scars set response_due_on = current_date - 3 where id = $1`, [ctx.scar2]);
    const row = (await api().get(`${base}/scars?overdue=true`).set(await owner()).expect(200)).body.data[0];
    expect(row).toMatchObject({ id: ctx.scar2, overdue: true, daysOverdue: 3 });
    expect((await api().get(`${base}/scars/${ctx.scar2}`).set(await owner()).expect(200)).body).toMatchObject({ overdue: true, daysOverdue: 3 });
    await api().post(`${base}/scars/${ctx.scar2}/responses`).set(await engineer()).send(RESPONSE()).expect(200);
    expect((await api().get(`${base}/scars/${ctx.scar2}`).set(await owner()).expect(200)).body.overdue).toBe(false); // awaiting review now
  });

  it('is cancelled with a reason and kept', async () => {
    const h = await engineer();
    expect((await api().post(`${base}/scars/${ctx.scar2}/cancel`).set(h).send({ reason: 'x' })).status).toBe(400);
    const c = (await api().post(`${base}/scars/${ctx.scar2}/cancel`).set(h).send({ reason: 'Raised against the wrong supplier' }).expect(200)).body;
    expect(c).toMatchObject({ status: 'cancelled', cancelReason: 'Raised against the wrong supplier', cancelledBy: { id: engId } });
    expect((await api().post(`${base}/scars/${ctx.scar2}/issue`).set(h).send({})).status).toBe(409);
  });
});

describe('the register', () => {
  it('filters, searches and sorts; defaults to the SCARs still running', async () => {
    const h = await owner();
    const running = (await api().get(`${base}/scars`).set(h).expect(200)).body;
    expect(running.total).toBe(0); // one closed, one cancelled
    const all = (await api().get(`${base}/scars?status=all&sort=reference&order=asc`).set(h).expect(200)).body;
    expect(all.total).toBe(2);
    expect(all.data[0].reference < all.data[1].reference).toBe(true);
    expect((await api().get(`${base}/scars?status=closed`).set(h).expect(200)).body.data.map((r: { id: string }) => r.id)).toEqual([ctx.scar]);
    expect((await api().get(`${base}/scars?status=all&q=pallet`).set(h).expect(200)).body.total).toBe(1);
    expect((await api().get(`${base}/scars?status=all&q=SC-2`).set(h).expect(200)).body.data.map((r: { id: string }) => r.id)).toEqual([ctx.scar2]); // by linked NC reference
    expect((await api().get(`${base}/scars?status=all&supplierId=${ctx.s2}`).set(h).expect(200)).body.total).toBe(0);
    expect((await api().get(`${base}/scars?status=all&ncrId=${ctx.nc1}`).set(h).expect(200)).body.data.map((r: { id: string }) => r.id)).toEqual([ctx.scar]);
    expect((await api().get(`${base}/scars?status=all&severity=critical`).set(h).expect(200)).body.total).toBe(1);
    await api().get(`${base}/scars?status=bogus`).set(h).expect(400);
    await api().get(`${base}/scars?sort=nonsense`).set(h).expect(400);
    await api().get(`${base}/scars`).set(await reader()).expect(200);
  });
});

describe('another organisation', () => {
  it('sees nothing and can change nothing', async () => {
    const h = await other();
    expect((await api().get(`${base}/scars?status=all`).set(h).expect(200)).body.total).toBe(0);
    await api().get(`${base}/scars/${ctx.scar}`).set(h).expect(404);
    await api().post(`${base}/scars/${ctx.scar2}/cancel`).set(h).send({ reason: 'Foreign cancel' }).expect(404);
    await api().post(`${base}/scars`).set(h).send(NEW()).expect(404);
    await api().post(`${base}/scar-ncrs/${ctx.scar}/unlink`).set(h).send({ reason: 'Foreign unlink' }).expect(404);
  });
});

describe('the fields the spec asks for', () => {
  it('a SCAR keeps the requirement, evidence, containment, owner and affected items', async () => {
    const h = await engineer();
    const part = (await admin.query(`insert into public.parts (organisation_id, part_number, name) values ($1, 'BRK-1', 'Bracket') returning id`, [ids.orgA])).rows[0].id as string;
    const part2 = (await admin.query(`insert into public.parts (organisation_id, part_number, name) values ($1, 'BRK-2', 'Other') returning id`, [ids.orgA])).rows[0].id as string;
    const lot = (await admin.query(`insert into public.lots (organisation_id, lot_number, part_id, origin, supplier_id, quantity) values ($1, 'LOT-A', $2, 'received', $3, 500) returning id`, [ids.orgA, part, ctx.s1])).rows[0].id as string;
    const people = (await api().get(`${base}/scar-people`).set(h).expect(200)).body.data;
    expect(people.map((p: { userId: string }) => p.userId)).toEqual(expect.arrayContaining([qmId, engId]));
    await api().post(`${base}/scars`).set(h).send(NEW({ ownerId: ids.outsider })).expect(409); // not a member
    await api().post(`${base}/scars`).set(h).send(NEW({ items: [{}] })).expect(400); // an item names something
    await api().post(`${base}/scars`).set(h).send(NEW({ items: [{ lotId: lot, partId: part2 }] })).expect(409); // lot and part must agree
    const created = (await api().post(`${base}/scars`).set(h).send(NEW({
      title: 'Cracked castings', ncrIds: [ctx.nc1], ownerId: qmId,
      requirementBreached: 'Drawing note 4: no cracks', objectiveEvidence: 'Photos 1 to 3', containmentRequirements: 'Quarantine stock and check shipments',
      items: [{ lotId: lot, quantity: 120, receiptReference: 'DN-4412' }, { material: 'Steel bar 20mm', quantity: 15.5 }],
    })).expect(201)).body;
    ctx.scar3 = created.id;
    expect(created).toMatchObject({ requirementBreached: 'Drawing note 4: no cracks', objectiveEvidence: 'Photos 1 to 3', containmentRequirements: 'Quarantine stock and check shipments', owner: { id: qmId } });
    expect(created.items).toHaveLength(2);
    expect(created.items[0]).toMatchObject({ part: { id: part, partNumber: 'BRK-1' }, lot: { id: lot, lotNumber: 'LOT-A' }, quantity: 120, receiptReference: 'DN-4412', endedAt: null });
    expect(created.items[1]).toMatchObject({ part: null, lot: null, material: 'Steel bar 20mm', quantity: 15.5 });
    expect((await api().get(`${base}/scars?status=all&q=Cracked`).set(await owner()).expect(200)).body.data[0].owner).toMatchObject({ id: qmId });
    // items can be added and removed (with a reason) while the SCAR runs
    const added = (await api().post(`${base}/scars/${ctx.scar3}/items`).set(h).send({ partId: part2, notes: 'Same pallet' }).expect(200)).body;
    const extra = added.items.find((i: { part: { id: string } | null }) => i.part?.id === part2);
    await api().post(`${base}/scars/${ctx.scar3}/items`).set(h).send({}).expect(400);
    await api().post(`${base}/scars/${ctx.scar3}/items`).set(await reader()).send({ material: 'x' }).expect(403);
    await api().post(`${base}/scar-items/${extra.id}/remove`).set(h).send({ reason: 'x' }).expect(400);
    const removed = (await api().post(`${base}/scar-items/${extra.id}/remove`).set(h).send({ reason: 'Added in error' }).expect(200)).body;
    expect(removed.items.find((i: { id: string }) => i.id === extra.id)).toMatchObject({ endReason: 'Added in error' });
    // a draft edits the text fields; once issued only the owner (and contact) can change
    await api().patch(`${base}/scars/${ctx.scar3}`).set(h).send({ requirementBreached: 'Drawing note 5' }).expect(200);
    await api().post(`${base}/scars/${ctx.scar3}/issue`).set(h).send({}).expect(200);
    expect((await api().patch(`${base}/scars/${ctx.scar3}`).set(h).send({ objectiveEvidence: 'Changed after issue' })).status).toBe(409);
    expect((await api().patch(`${base}/scars/${ctx.scar3}`).set(h).send({ ownerId: engId }).expect(200)).body.owner).toMatchObject({ id: engId });
    expect((await api().patch(`${base}/scars/${ctx.scar3}`).set(h).send({ ownerId: ids.outsider })).status).toBe(409);
  });

  it('a response keeps the extent of condition, escape point, responsible person and method', async () => {
    const h = await engineer();
    await api().post(`${base}/scars/${ctx.scar3}/responses`).set(h).send(RESPONSE({ rootCauseMethod: 'guessing' })).expect(400);
    const r = (await api().post(`${base}/scars/${ctx.scar3}/responses`).set(h).send(RESPONSE({
      extentOfCondition: 'Lots 1180 to 1184 may be affected', escapePoint: 'Final inspection had no dye-penetrant check', responsibleName: 'Their welding engineer', rootCauseMethod: 'five_whys',
    })).expect(200)).body;
    expect(r.responses[0]).toMatchObject({ extentOfCondition: 'Lots 1180 to 1184 may be affected', escapePoint: 'Final inspection had no dye-penetrant check', responsibleName: 'Their welding engineer', rootCauseMethod: 'five_whys' });
    const plain = (await api().post(`${base}/scars`).set(h).send(NEW({ title: 'Plain', ncrIds: [ctx.nc2] })).expect(201)).body;
    expect(plain).toMatchObject({ requirementBreached: null, items: [], owner: { id: engId } }); // the owner defaults to whoever raised it
  });

  it('another organisation cannot reach items or extensions', async () => {
    const h = await other();
    await api().post(`${base}/scars/${ctx.scar3}/items`).set(h).send({ material: 'x' }).expect(404);
    await api().post(`${base}/scar-items/${ctx.scar3}/remove`).set(h).send({ reason: 'Foreign' }).expect(404);
    await api().post(`${base}/scar-extensions/${ctx.ext1}/withdraw`).set(h).send({ reason: 'Foreign' }).expect(404);
  });
});
