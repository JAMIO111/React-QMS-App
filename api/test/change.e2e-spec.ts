/**
 * Change management (CH1) through the API: the seeded lists, raising a change, editing a draft, scope links, origin, files, cancelling, the register's
 * filters, permissions and tenancy. The rules are in supabase/tests/change_management_core.test.sql; this checks the routes and that errors reach the caller in words.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { categoryId, makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a1d');
const QM = 'a1d00000-0000-0000-0000-0000000000e1';
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-ch');
  await admin.query(`insert into auth.users (id, email) values ($1, 'qm@example.test')`, [QM]);
  await admin.query(`update public.profiles set first_name = 'Quinn', surname = 'Manager' where id = $1`, [QM]);
  const m = await admin.query(`insert into public.organisation_users (organisation_id, user_id, status, joined_at) values ($1, $2, 'active', now()) returning id`, [ids.orgA, QM]);
  await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = 'quality_manager'`, [ids.orgA, m.rows[0].id]);
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});
afterAll(async () => {
  // The "waiting for you" notices are emailed by default; leave no queued email for the suites that drain the shared queue.
  await admin?.query(`delete from public.email_outbox where organisation_id = $1`, [ids.orgA]);
  await app?.close();
  await admin?.end();
});

describe('the lists', () => {
  it('gives the seeded types, functions and areas to anyone who may read changes', async () => {
    const h = await as(ids.inspectorA);
    const types = (await api().get('/api/v1/change-types').set(h).expect(200)).body.data;
    expect(types).toHaveLength(7);
    expect(types.find((t: { key: string }) => t.key === 'process')).toMatchObject({ needsCustomerApproval: true, active: true, changes: 0 });
    ctx.process = types.find((t: { key: string }) => t.key === 'process').id;
    ctx.tooling = types.find((t: { key: string }) => t.key === 'tooling').id;
    expect((await api().get('/api/v1/change-functions').set(h).expect(200)).body.data).toHaveLength(5);
    const areas = (await api().get('/api/v1/change-areas').set(h).expect(200)).body.data;
    expect(areas).toHaveLength(12);
    ctx.area = areas[0].id;
  });

  it('lets a manager add, rename and switch off a type, and switch an area off', async () => {
    const h = await as(ids.ownerA);
    await api().post('/api/v1/change-types').set(await as(ids.inspectorA)).send({ label: 'Packaging' }).expect(403);
    const made = await api().post('/api/v1/change-types').set(h).send({ label: 'Packaging', needsCustomerApproval: true }).expect(201);
    expect(made.body).toMatchObject({ key: 'packaging', label: 'Packaging', active: true, needsCustomerApproval: true, changes: 0 });
    await api().post('/api/v1/change-types').set(h).send({ label: 'packaging' }).expect(409);
    const off = await api().patch(`/api/v1/change-types/${made.body.id}`).set(h).send({ label: 'Packing', active: false, needsCustomerApproval: false }).expect(200);
    expect(off.body).toMatchObject({ key: 'packaging', label: 'Packing', active: false, needsCustomerApproval: false });
    expect((await api().get('/api/v1/change-types').set(h).expect(200)).body.data).toHaveLength(7);
    expect((await api().get('/api/v1/change-types?all=true').set(h).expect(200)).body.data).toHaveLength(8);
    ctx.off = made.body.id;
    const fn = await api().post('/api/v1/change-functions').set(h).send({ label: 'Maintenance' }).expect(201);
    expect(fn.body).toMatchObject({ key: 'maintenance', active: true });
    await api().patch(`/api/v1/change-functions/${fn.body.id}`).set(h).send({ active: false }).expect(200);
    const area = await api().patch(`/api/v1/change-areas/${ctx.area}`).set(h).send({ active: false }).expect(200);
    expect(area.body.active).toBe(false);
    await api().patch(`/api/v1/change-areas/${ctx.area}`).set(h).send({ label: 'Renamed' }).expect(400);
    await api().patch(`/api/v1/change-areas/${ctx.area}`).set(h).send({ active: true }).expect(200);
  });
});

describe('changes', () => {
  it('raises a change as a draft with its scope and a reference', async () => {
    const h = await as(ids.ownerA);
    const part = (await admin.query(`insert into public.parts (organisation_id, part_number, name) values ($1, 'CH-P1', 'Bracket') returning id`, [ids.orgA])).rows[0].id;
    ctx.part = part;
    await api().post('/api/v1/changes').set(await as(ids.inspectorA)).send({ title: 'x', typeId: ctx.process }).expect(403);
    await api().post('/api/v1/changes').set(h).send({ typeId: ctx.process }).expect(400);
    const off = await api().post('/api/v1/changes').set(h).send({ title: 'x', typeId: ctx.off }).expect(409);
    expect(off.body.error.code).toBe('change_rule');
    const made = await api()
      .post('/api/v1/changes')
      .set(h)
      .send({ title: 'Move bracket to CNC 7', description: 'Run it on machine 7', reason: 'Capacity', typeId: ctx.process, links: [{ kind: 'part', id: part }, { kind: 'operation_code', code: 'OP10' }] })
      .expect(201);
    expect(made.body).toMatchObject({
      stage: 'draft', title: 'Move bracket to CNC 7', urgency: 'normal', canManage: true, canEdit: true, canCancel: true, origin: null, type: { label: 'Process', needsCustomerApproval: true },
    });
    expect(made.body.reference).toMatch(/^ECR-\d{2}-0001$/);
    expect(made.body.links).toEqual([
      { kind: 'part', id: part, code: null, reference: 'CH-P1', name: 'Bracket', readable: true },
      { kind: 'operation_code', id: null, code: 'OP10', reference: 'OP10', name: null, readable: true },
    ]);
    ctx.change = made.body.id;
    ctx.version = made.body.rowVersion;
    const second = await api().post('/api/v1/changes').set(h).send({ title: 'Second', typeId: ctx.tooling }).expect(201);
    expect(second.body.reference).toMatch(/0002$/);
    ctx.second = second.body.id;
  });

  it('edits the wording of a draft, and replaces its scope as a whole', async () => {
    const h = await as(ids.ownerA);
    const edited = await api().patch(`/api/v1/changes/${ctx.change}`).set(h).send({ title: 'Move bracket to CNC 7 (rev B)', reason: null, urgency: 'expedited' }).expect(200);
    expect(edited.body).toMatchObject({ title: 'Move bracket to CNC 7 (rev B)', reason: null, urgency: 'expedited' });
    await api().patch(`/api/v1/changes/${ctx.change}`).set(h).send({}).expect(400);
    await api().patch(`/api/v1/changes/${ctx.change}`).set(h).send({ typeId: ctx.off }).expect(409);
    const links = await api().put(`/api/v1/changes/${ctx.change}/links`).set(h).send({ links: [{ kind: 'part', id: ctx.part }] }).expect(200);
    expect(links.body.links).toHaveLength(1);
    await api().put(`/api/v1/changes/${ctx.change}/links`).set(h).send({ links: [{ kind: 'part', id: '00000000-0000-0000-0000-0000000000aa' }] }).expect(409);
    await api().put(`/api/v1/changes/${ctx.change}/links`).set(await as(ids.inspectorA)).send({ links: [] }).expect(403);
  });

  it('shows what it was raised from, and refuses a record that is not there', async () => {
    const h = await as(ids.ownerA);
    const ncr = (await admin.query(
      `insert into public.nonconformances (organisation_id, reference, source, title, category_id) values ($1, 'CH-NCR-1', 'internal', 'Origin NC', $2) returning id`,
      [ids.orgA, await categoryId(admin, ids.orgA)],
    )).rows[0].id;
    const made = await api().post('/api/v1/changes').set(h).send({ title: 'From an NC', typeId: ctx.process, origin: { kind: 'ncr', id: ncr } }).expect(201);
    expect(made.body.origin).toMatchObject({ kind: 'ncr', id: ncr, reference: 'CH-NCR-1', name: 'Origin NC', readable: true });
    ctx.fromNcr = made.body.id;
    await api().post('/api/v1/changes').set(h).send({ title: 'x', typeId: ctx.process, origin: { kind: 'ncr', id: '00000000-0000-0000-0000-0000000000bb' } }).expect(404);
    await api().post('/api/v1/changes').set(h).send({ title: 'x', typeId: ctx.process, origin: { kind: 'part', id: ncr } }).expect(400);
  });

  it('lists with filters and pages, and finds by part number', async () => {
    const h = await as(ids.inspectorA);
    const all = await api().get('/api/v1/changes').set(h).expect(200);
    expect(all.body).toMatchObject({ page: 1, pageSize: 50, total: 3 });
    expect(all.body.data[0].reference > all.body.data[2].reference).toBe(true);
    expect((await api().get('/api/v1/changes?q=CH-P1').set(h).expect(200)).body.total).toBe(1);
    expect((await api().get('/api/v1/changes?q=Second').set(h).expect(200)).body.total).toBe(1);
    expect((await api().get(`/api/v1/changes?partId=${ctx.part}`).set(h).expect(200)).body.total).toBe(1);
    expect((await api().get(`/api/v1/changes?typeId=${ctx.tooling}`).set(h).expect(200)).body.total).toBe(1);
    expect((await api().get('/api/v1/changes?originKind=ncr').set(h).expect(200)).body.total).toBe(1);
    expect((await api().get('/api/v1/changes?urgency=expedited').set(h).expect(200)).body.total).toBe(1);
    expect((await api().get('/api/v1/changes?owner=me').set(h).expect(200)).body.total).toBe(0);
    expect((await api().get('/api/v1/changes?owner=me').set(await as(ids.ownerA)).expect(200)).body.total).toBe(3);
    expect((await api().get('/api/v1/changes?pageSize=2&page=2&sort=reference&order=asc').set(h).expect(200)).body.data).toHaveLength(1);
    await api().get('/api/v1/changes?stage=banana').set(h).expect(400);
    const detail = await api().get(`/api/v1/changes/${ctx.change}`).set(h).expect(200);
    expect(detail.body).toMatchObject({ canManage: false, canEdit: false, canCancel: false, canAddFiles: false });
  });

  it('keeps files in the change’s own folder, removes with a reason, brings back', async () => {
    const h = await as(ids.ownerA);
    const folder = `${ids.orgA}/change/${ctx.change}/`;
    await api().post(`/api/v1/changes/${ctx.change}/attachments`).set(h).send({ storagePath: `${folder}a.pdf`, fileName: 'a.pdf', sizeBytes: 1 }).expect(400);
    await admin.query(`insert into storage.objects (bucket_id, name) values ('change-files', $1)`, [`${folder}a.pdf`]);
    await api().post(`/api/v1/changes/${ctx.change}/attachments`).set(h).send({ storagePath: `${ids.orgA}/change/${ctx.second}/a.pdf`, fileName: 'a.pdf', sizeBytes: 1 }).expect(400);
    const att = await api().post(`/api/v1/changes/${ctx.change}/attachments`).set(h).send({ storagePath: `${folder}a.pdf`, fileName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 1, description: 'Drawing' }).expect(201);
    expect(att.body).toMatchObject({ fileName: 'a.pdf', description: 'Drawing', deletedAt: null });
    expect((await api().get(`/api/v1/changes/${ctx.change}/attachments`).set(await as(ids.inspectorA)).expect(200)).body.data).toHaveLength(1);
    await api().post(`/api/v1/change-attachments/${att.body.id}/delete`).set(h).send({ reason: 'x' }).expect(400);
    const gone = await api().post(`/api/v1/change-attachments/${att.body.id}/delete`).set(h).send({ reason: 'Wrong drawing' }).expect(200);
    expect(gone.body).toMatchObject({ deleteReason: 'Wrong drawing' });
    expect((await api().get(`/api/v1/changes/${ctx.change}/attachments`).set(h).expect(200)).body.data).toHaveLength(0);
    expect((await api().get(`/api/v1/changes/${ctx.change}/attachments?deleted=include`).set(h).expect(200)).body.data).toHaveLength(1);
    const back = await api().post(`/api/v1/change-attachments/${att.body.id}/restore`).set(h).expect(200);
    expect(back.body.deletedAt).toBeNull();
  });

  it('cancels with a reason, and a cancelled change is final', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/changes/${ctx.second}/cancel`).set(h).send({ reason: 'x' }).expect(400);
    await api().post(`/api/v1/changes/${ctx.second}/cancel`).set(await as(ids.inspectorA)).send({ reason: 'Not mine to cancel' }).expect(403);
    const done = await api().post(`/api/v1/changes/${ctx.second}/cancel`).set(h).send({ reason: 'Raised twice by mistake' }).expect(200);
    expect(done.body).toMatchObject({ stage: 'cancelled', cancelReason: 'Raised twice by mistake', canEdit: false, canCancel: false });
    const again = await api().post(`/api/v1/changes/${ctx.second}/cancel`).set(h).send({ reason: 'Again please' }).expect(409);
    expect(again.body.error.code).toBe('change_rule');
    await api().patch(`/api/v1/changes/${ctx.second}`).set(h).send({ title: 'Revived' }).expect(409);
    expect((await api().get('/api/v1/changes').set(h).expect(200)).body.total).toBe(2);
    expect((await api().get('/api/v1/changes?stage=cancelled').set(h).expect(200)).body.total).toBe(1);
    expect((await api().get('/api/v1/changes?stage=all').set(h).expect(200)).body.total).toBe(3);
  });

  it('refuses a second save made on an old version of the record', async () => {
    const h = await as(ids.ownerA);
    const current = (await api().get(`/api/v1/changes/${ctx.change}`).set(h).expect(200)).body;
    await api().patch(`/api/v1/changes/${ctx.change}`).set(h).send({ title: 'First save', rowVersion: current.rowVersion }).expect(200);
    const clash = await api().patch(`/api/v1/changes/${ctx.change}`).set(h).send({ title: 'Stale save', rowVersion: current.rowVersion }).expect(409);
    expect(clash.body.error.code).toBe('edit_conflict');
  });
});

describe('assessment, the board and approval', () => {
  it('lists who can be named for the board, and whether they can sign', async () => {
    const res = await api().get('/api/v1/change-signers').set(await as(ids.inspectorA)).expect(200);
    const byId = Object.fromEntries(res.body.data.map((p: { id: string; canApprove: boolean }) => [p.id, p.canApprove]));
    expect(byId[QM]).toBe(true);
    expect(byId[ids.ownerA]).toBe(true);
    expect(byId[ids.inspectorA]).toBe(false);
  });

  it('refuses to submit an incomplete draft and says what is missing', async () => {
    const h = await as(ids.ownerA);
    const made = await api().post('/api/v1/changes').set(h).send({ title: 'Board flow', typeId: ctx.tooling }).expect(201);
    ctx.flow = made.body.id;
    expect(made.body.problems).toEqual(['Say what is changing', 'Say why', 'Say what it covers (parts, machines, suppliers…)']);
    const early = await api().post(`/api/v1/changes/${ctx.flow}/submit`).set(h).expect(409);
    expect(early.body.error).toMatchObject({ code: 'change_rule' });
    expect(early.body.error.message).toMatch(/Not ready to assess/);
    await api().patch(`/api/v1/changes/${ctx.flow}`).set(h).send({ description: 'New fixture', reason: 'Wear' }).expect(200);
    await api().put(`/api/v1/changes/${ctx.flow}/links`).set(h).send({ links: [{ kind: 'part', id: ctx.part }] }).expect(200);
    await api().post(`/api/v1/changes/${ctx.flow}/submit`).set(await as(ids.inspectorA)).expect(403);
  });

  it('submits into assessment with a row per area, and answers them', async () => {
    const h = await as(ids.ownerA);
    const sub = await api().post(`/api/v1/changes/${ctx.flow}/submit`).set(h).expect(200);
    expect(sub.body).toMatchObject({ stage: 'assessment', canAssess: true, canSendToBoard: true, canSubmit: false });
    expect(sub.body.impacts).toHaveLength(12);
    expect(sub.body.impacts.every((i: { status: string }) => i.status === 'not_assessed')).toBe(true);
    expect(sub.body.problems[0]).toBe('12 impact areas still to assess');
    const first = sub.body.impacts[0].areaId;
    const bad = await api().put(`/api/v1/changes/${ctx.flow}/impacts`).set(h).send({ areaId: first, status: 'affected' }).expect(409);
    expect(bad.body.error.message).toMatch(/Say how the area is affected/);
    const ok = await api().put(`/api/v1/changes/${ctx.flow}/impacts`).set(h).send({ areaId: first, status: 'affected', note: 'Drawing gets a note' }).expect(200);
    expect(ok.body.impacts[0]).toMatchObject({ status: 'affected', note: 'Drawing gets a note', assessedBy: 'Ada Owner' });
    for (const i of sub.body.impacts.slice(1)) await api().put(`/api/v1/changes/${ctx.flow}/impacts`).set(h).send({ areaId: i.areaId, status: 'not_affected' }).expect(200);
    await api().put(`/api/v1/changes/${ctx.flow}/impacts`).set(await as(ids.inspectorA)).send({ areaId: first, status: 'not_affected' }).expect(403);
  });

  it('chooses the board, with only people who can sign', async () => {
    const h = await as(ids.ownerA);
    const fns = (await api().get('/api/v1/change-functions').set(h).expect(200)).body.data;
    ctx.fnQuality = fns.find((f: { key: string }) => f.key === 'quality').id;
    const refused = await api().put(`/api/v1/changes/${ctx.flow}/board`).set(h).send({ board: [{ functionId: ctx.fnQuality, signerId: ids.inspectorA }] }).expect(409);
    expect(refused.body.error.message).toMatch(/cannot sign off changes/);
    const early = await api().post(`/api/v1/changes/${ctx.flow}/send-to-board`).set(h).expect(409);
    expect(early.body.error.message).toMatch(/Choose at least one function/);
    const raiser = await api().put(`/api/v1/changes/${ctx.flow}/board`).set(h).send({ board: [{ functionId: ctx.fnQuality, signerId: ids.ownerA }] }).expect(200);
    expect(raiser.body.problems.join(' | ')).toMatch(/Ada Owner raised this change/);
    const board = await api().put(`/api/v1/changes/${ctx.flow}/board`).set(h).send({ board: [{ functionId: ctx.fnQuality, signerId: QM }] }).expect(200);
    expect(board.body.board).toEqual([expect.objectContaining({ function: expect.objectContaining({ label: 'Quality' }), signer: { id: QM, name: 'Quinn Manager' } })]);
    expect(board.body.problems).toEqual([]);
  });

  it('sends it to the board; the signer is the only one who can decide, and a rejection sends it back', async () => {
    const h = await as(ids.ownerA);
    const sent = await api().post(`/api/v1/changes/${ctx.flow}/send-to-board`).set(h).expect(200);
    expect(sent.body).toMatchObject({ stage: 'approval', reviewRound: 1, canRecall: true, canEdit: false });
    expect(sent.body.signoffs).toHaveLength(1);
    expect(sent.body.signoffs[0]).toMatchObject({ status: 'pending', round: 1, canDecide: false });
    ctx.signoff = sent.body.signoffs[0].id;
    const waiting = await api().get('/api/v1/changes?signer=me').set(await as(QM)).expect(200);
    expect(waiting.body.total).toBe(1);
    expect(waiting.body.data[0]).toMatchObject({ id: ctx.flow, waitingForMe: true });
    expect((await api().get('/api/v1/changes?signer=me').set(h).expect(200)).body.total).toBe(0);
    const theirs = await api().get(`/api/v1/changes/${ctx.flow}`).set(await as(QM)).expect(200);
    expect(theirs.body.signoffs[0].canDecide).toBe(true);
    await api().post(`/api/v1/change-signoffs/${ctx.signoff}/decide`).set(h).send({ approve: true }).expect(403);
    await api().post(`/api/v1/change-signoffs/${ctx.signoff}/decide`).set(await as(ids.inspectorA)).send({ approve: true }).expect(403);
    const noComment = await api().post(`/api/v1/change-signoffs/${ctx.signoff}/decide`).set(await as(QM)).send({ approve: false }).expect(409);
    expect(noComment.body.error.message).toMatch(/Say why you are sending it back/);
    const rejected = await api().post(`/api/v1/change-signoffs/${ctx.signoff}/decide`).set(await as(QM)).send({ approve: false, comment: 'Needs a control plan change' }).expect(200);
    expect(rejected.body).toMatchObject({ stage: 'assessment', returnReason: 'Quality: Needs a control plan change', canSendToBoard: true });
    expect(rejected.body.signoffs[0]).toMatchObject({ status: 'rejected', comment: 'Needs a control plan change' });
    await api().post(`/api/v1/change-signoffs/${ctx.signoff}/decide`).set(await as(QM)).send({ approve: true }).expect(409);
  });

  it('asks again in a new round, and the last approval approves the change', async () => {
    const h = await as(ids.ownerA);
    const again = await api().post(`/api/v1/changes/${ctx.flow}/send-to-board`).set(h).expect(200);
    expect(again.body).toMatchObject({ stage: 'approval', reviewRound: 2, returnReason: null });
    expect(again.body.signoffs.map((x: { round: number; status: string }) => [x.round, x.status])).toEqual([[2, 'pending'], [1, 'rejected']]);
    const second = again.body.signoffs.find((x: { round: number }) => x.round === 2).id;
    const done = await api().post(`/api/v1/change-signoffs/${second}/decide`).set(await as(QM)).send({ approve: true, comment: 'Agreed' }).expect(200);
    expect(done.body).toMatchObject({ stage: 'approved', approvedBy: 'Quinn Manager', canRecall: false, canEdit: false, canAssess: false });
    expect(done.body.approvedAt).toBeTruthy();
    await api().patch(`/api/v1/changes/${ctx.flow}`).set(h).send({ title: 'Too late' }).expect(409);
  });

  it('records the cut-in point (a manager or a signer) and the customer approval', async () => {
    const h = await as(ids.ownerA);
    const bad = await api().put(`/api/v1/changes/${ctx.flow}/cut-in`).set(h).send({ kind: 'date' }).expect(409);
    expect(bad.body.error.message).toMatch(/Choose the date/);
    const ok = await api().put(`/api/v1/changes/${ctx.flow}/cut-in`).set(h).send({ kind: 'date', date: '2026-12-01', stockAction: 'use_up', stockNote: 'Finish the batch' }).expect(200);
    expect(ok.body.cutIn).toMatchObject({ kind: 'date', date: '2026-12-01', stockAction: 'use_up', stockNote: 'Finish the batch' });
    const bySigner = await api().put(`/api/v1/changes/${ctx.flow}/cut-in`).set(await as(QM)).send({ kind: 'none' }).expect(200);
    expect(bySigner.body.cutIn).toMatchObject({ kind: 'none', date: null });
    await api().put(`/api/v1/changes/${ctx.flow}/cut-in`).set(await as(ids.inspectorA)).send({ kind: 'none' }).expect(403);
    const waiver = await api().put(`/api/v1/changes/${ctx.flow}/customer-approval`).set(h).send({ status: 'waived', waivedReason: 'short' }).expect(409);
    expect(waiver.body.error.message).toMatch(/at least 10 characters/);
    const approved = await api().put(`/api/v1/changes/${ctx.flow}/customer-approval`).set(h).send({ status: 'approved', reference: 'ACME-77' }).expect(200);
    expect(approved.body.customerApproval).toMatchObject({ status: 'approved', reference: 'ACME-77' });
    expect(approved.body.customerApproval.on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await api().put(`/api/v1/changes/${ctx.flow}/customer-approval`).set(await as(ids.inspectorA)).send({ status: 'approved' }).expect(403);
  });

  it('can recall a change from the board, and cancel one that is there', async () => {
    const h = await as(ids.ownerA);
    const made = await api().post('/api/v1/changes').set(h).send({ title: 'Recall me', typeId: ctx.tooling, description: 'x', reason: 'y', links: [{ kind: 'part', id: ctx.part }] }).expect(201);
    await api().post(`/api/v1/changes/${made.body.id}/submit`).set(h).expect(200);
    const detail = (await api().get(`/api/v1/changes/${made.body.id}`).set(h).expect(200)).body;
    for (const i of detail.impacts) await api().put(`/api/v1/changes/${made.body.id}/impacts`).set(h).send({ areaId: i.areaId, status: 'not_affected' }).expect(200);
    await api().put(`/api/v1/changes/${made.body.id}/board`).set(h).send({ board: [{ functionId: ctx.fnQuality, signerId: QM }] }).expect(200);
    await api().post(`/api/v1/changes/${made.body.id}/send-to-board`).set(h).expect(200);
    await api().post(`/api/v1/changes/${made.body.id}/recall`).set(h).send({ reason: 'x' }).expect(400);
    const back = await api().post(`/api/v1/changes/${made.body.id}/recall`).set(h).send({ reason: 'The signer has left' }).expect(200);
    expect(back.body).toMatchObject({ stage: 'assessment', returnReason: 'The signer has left' });
    expect(back.body.signoffs[0].status).toBe('superseded');
    await api().post(`/api/v1/changes/${made.body.id}/send-to-board`).set(h).expect(200);
    const cancelled = await api().post(`/api/v1/changes/${made.body.id}/cancel`).set(h).send({ reason: 'Not going ahead' }).expect(200);
    expect(cancelled.body.stage).toBe('cancelled');
  });

  it('keeps the raiser from signing unless the organisation allows it', async () => {
    const h = await as(ids.ownerA);
    const get = async () => (await api().get('/api/v1/organisations/current').set(h).expect(200)).body.settings.changeAllowSelfApproval;
    expect(await get()).toBe(false);
    await api().patch('/api/v1/organisations/current').set(await as(ids.inspectorA)).send({ settings: { changeAllowSelfApproval: true } }).expect(403);
    await api().patch('/api/v1/organisations/current').set(h).send({ settings: { changeAllowSelfApproval: true } }).expect(200);
    expect(await get()).toBe(true);
    const made = await api().post('/api/v1/changes').set(h).send({ title: 'Mine to sign', typeId: ctx.tooling, description: 'x', reason: 'y', links: [{ kind: 'part', id: ctx.part }] }).expect(201);
    await api().post(`/api/v1/changes/${made.body.id}/submit`).set(h).expect(200);
    const detail = (await api().get(`/api/v1/changes/${made.body.id}`).set(h).expect(200)).body;
    for (const i of detail.impacts) await api().put(`/api/v1/changes/${made.body.id}/impacts`).set(h).send({ areaId: i.areaId, status: 'not_affected' }).expect(200);
    await api().put(`/api/v1/changes/${made.body.id}/board`).set(h).send({ board: [{ functionId: ctx.fnQuality, signerId: ids.ownerA }] }).expect(200);
    const sent = await api().post(`/api/v1/changes/${made.body.id}/send-to-board`).set(h).expect(200);
    expect(sent.body.signoffs[0].canDecide).toBe(true);
    const done = await api().post(`/api/v1/change-signoffs/${sent.body.signoffs[0].id}/decide`).set(h).send({ approve: true }).expect(200);
    expect(done.body.stage).toBe('approved');
    await api().patch('/api/v1/organisations/current').set(h).send({ settings: { changeAllowSelfApproval: false } }).expect(200);
  });
});

describe('tasks, the effectiveness check and closing', () => {
  it('adds tasks to an approved change, and the stage follows them', async () => {
    const h = await as(ids.ownerA);
    const body = { description: 'Tell the line leaders', ownerId: ids.inspectorA, dueOn: '2099-01-01' };
    await api().post(`/api/v1/changes/${ctx.flow}/tasks`).set(await as(ids.inspectorA)).send(body).expect(403);
    await api().post(`/api/v1/changes/${ctx.flow}/tasks`).set(h).send({ ...body, description: 'ab' }).expect(400);
    await api().post(`/api/v1/changes/${ctx.flow}/tasks`).set(h).send({ ...body, ownerId: ids.ownerB }).expect(409);
    await api().post(`/api/v1/changes/${ctx.change}/tasks`).set(h).send(body).expect(409);
    const added = await api().post(`/api/v1/changes/${ctx.flow}/tasks`).set(h).send(body).expect(201);
    expect(added.body.stage).toBe('implementing');
    expect(added.body).toMatchObject({ canAddTask: true, canReview: false });
    expect(added.body.tasks).toHaveLength(1);
    expect(added.body.tasks[0]).toMatchObject({ description: 'Tell the line leaders', status: 'open', dueOn: '2099-01-01', overdue: false, link: null, canComplete: true, canEdit: true, isMine: false });
    ctx.taskOne = added.body.tasks[0].id;
  });

  it('shows the person a task was given to their own work, and lets them finish it', async () => {
    const mine = await api().get('/api/v1/changes/mine').set(await as(ids.inspectorA)).expect(200);
    expect(mine.body.tasks.map((t: { id: string }) => t.id)).toContain(ctx.taskOne);
    expect(mine.body.counts).toMatchObject({ tasks: 1, signoffs: 0, total: 1 });
    expect((await api().get('/api/v1/changes/mine/count').set(await as(ids.inspectorA)).expect(200)).body).toMatchObject({ total: 1, overdue: 0 });
    expect((await api().get('/api/v1/changes/mine').set(await as(ids.ownerA)).expect(200)).body.counts.tasks).toBe(0);
    const theirs = await api().get(`/api/v1/changes/${ctx.flow}`).set(await as(ids.inspectorA)).expect(200);
    expect(theirs.body.tasks[0]).toMatchObject({ isMine: true, canComplete: true, canEdit: false, canCancel: false });
    await api().patch(`/api/v1/change-tasks/${ctx.taskOne}`).set(await as(ids.inspectorA)).send({ description: 'Changed by them' }).expect(403);
    await api().post(`/api/v1/change-tasks/${ctx.taskOne}/cancel`).set(await as(ids.inspectorA)).send({ reason: 'Not mine to cancel' }).expect(403);
  });

  it('starts a revision for a task and waits for it to be in force before the task can be finished', async () => {
    const h = await as(ids.ownerA);
    const second = await api().post(`/api/v1/changes/${ctx.flow}/tasks`).set(h).send({ description: 'Release the new drawing revision', ownerId: ids.ownerA }).expect(201);
    ctx.taskTwo = second.body.tasks.find((t: { description: string }) => t.description.startsWith('Release')).id;
    const started = await api().post(`/api/v1/change-tasks/${ctx.taskTwo}/start-revision`).set(h).send({ kind: 'part', partId: ctx.part, revision: 'Q', changeSummary: 'From the change' }).expect(200);
    expect(started.body.started.kind).toBe('part_revision');
    const task = started.body.tasks.find((t: { id: string }) => t.id === ctx.taskTwo);
    expect(task.link).toMatchObject({ kind: 'part_revision', status: 'draft', state: 'pending', readable: true });
    expect(task.link.label).toMatch(/rev Q$/);
    const unfinished = await api().post(`/api/v1/change-tasks/${ctx.taskTwo}/complete`).set(h).send({}).expect(409);
    expect(unfinished.body.error.message).toMatch(/not in force yet/);
    await api().post(`/api/v1/part-revisions/${started.body.started.revisionId}/release`).set(h).expect(200);
    const read = await api().get(`/api/v1/changes/${ctx.flow}`).set(h).expect(200);
    expect(read.body.tasks.find((t: { id: string }) => t.id === ctx.taskTwo).link).toMatchObject({ status: 'released', state: 'in_force' });
    await api().post(`/api/v1/change-tasks/${ctx.taskTwo}/start-revision`).set(h).send({ kind: 'document', documentId: ctx.change }).expect(404);
  });

  it('works out verifying when every task is done, and checks effectiveness before closing', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/changes/${ctx.flow}/reviews`).set(h).send({ effective: true, note: 'Too early to say' }).expect(409);
    await api().post(`/api/v1/change-tasks/${ctx.taskOne}/complete`).set(await as(ids.inspectorA)).send({ note: 'Told them all' }).expect(200);
    const done = await api().post(`/api/v1/change-tasks/${ctx.taskTwo}/complete`).set(h).send({ note: 'Rev Q is out' }).expect(200);
    expect(done.body).toMatchObject({ stage: 'verifying', canReview: true, problems: [] });
    const reopened = await api().post(`/api/v1/change-tasks/${ctx.taskOne}/reopen`).set(h).send({ reason: 'One leader missed' }).expect(200);
    expect(reopened.body.stage).toBe('implementing');
    await api().post(`/api/v1/change-tasks/${ctx.taskOne}/complete`).set(await as(ids.inspectorA)).send({}).expect(200);
    await api().post(`/api/v1/changes/${ctx.flow}/reviews`).set(await as(ids.inspectorA)).send({ effective: true, note: 'Looks fine' }).expect(403);
    await api().post(`/api/v1/changes/${ctx.flow}/reviews`).set(h).send({ effective: true, note: 'x' }).expect(400);
    const bad = await api().post(`/api/v1/changes/${ctx.flow}/reviews`).set(h).send({ effective: false, note: 'Scrap rate is still high' }).expect(200);
    expect(bad.body.stage).toBe('implementing');
    expect(bad.body.reviews[0]).toMatchObject({ result: 'not_effective', note: 'Scrap rate is still high' });
    const third = await api().post(`/api/v1/changes/${ctx.flow}/tasks`).set(h).send({ description: 'Add a check to the control plan', ownerId: ids.ownerA }).expect(201);
    const t3 = third.body.tasks.find((t: { description: string }) => t.description.startsWith('Add a check')).id;
    const back = await api().post(`/api/v1/change-tasks/${t3}/complete`).set(h).send({}).expect(200);
    expect(back.body.stage).toBe('verifying');
    const closed = await api().post(`/api/v1/changes/${ctx.flow}/reviews`).set(h).send({ effective: true, note: 'Scrap rate back to normal' }).expect(200);
    expect(closed.body).toMatchObject({ stage: 'closed', closedBy: expect.any(String), canAddTask: false, canReview: false, canCancel: false });
    expect(closed.body.closedAt).toBeTruthy();
    expect(closed.body.reviews.map((r: { result: string }) => r.result)).toEqual(['effective', 'not_effective']);
    await api().post(`/api/v1/changes/${ctx.flow}/tasks`).set(h).send({ description: 'Too late now', ownerId: ids.ownerA }).expect(409);
    await api().post(`/api/v1/change-tasks/${ctx.taskOne}/reopen`).set(h).send({ reason: 'After the close' }).expect(409);
  });

  it('cancels a task with a reason and takes a cancelled change’s tasks with it', async () => {
    const h = await as(ids.ownerA);
    const made = await api().post('/api/v1/changes').set(h).send({ title: 'Cancel with tasks', typeId: ctx.tooling, description: 'x', reason: 'y', links: [{ kind: 'part', id: ctx.part }] }).expect(201);
    const id = made.body.id;
    await api().post(`/api/v1/changes/${id}/submit`).set(h).expect(200);
    const detail = (await api().get(`/api/v1/changes/${id}`).set(h).expect(200)).body;
    for (const i of detail.impacts) await api().put(`/api/v1/changes/${id}/impacts`).set(h).send({ areaId: i.areaId, status: 'not_affected' }).expect(200);
    await api().put(`/api/v1/changes/${id}/board`).set(h).send({ board: [{ functionId: ctx.fnQuality, signerId: QM }] }).expect(200);
    const sent = await api().post(`/api/v1/changes/${id}/send-to-board`).set(h).expect(200);
    await api().post(`/api/v1/change-signoffs/${sent.body.signoffs[0].id}/decide`).set(await as(QM)).send({ approve: true }).expect(200);
    const one = await api().post(`/api/v1/changes/${id}/tasks`).set(h).send({ description: 'A task to cancel', ownerId: ids.ownerA }).expect(201);
    const tid = one.body.tasks[0].id;
    await api().post(`/api/v1/change-tasks/${tid}/cancel`).set(h).send({ reason: 'x' }).expect(400);
    const none = await api().post(`/api/v1/change-tasks/${tid}/cancel`).set(h).send({ reason: 'No longer needed' }).expect(200);
    expect(none.body).toMatchObject({ stage: 'approved' });
    expect(none.body.tasks[0]).toMatchObject({ status: 'cancelled', cancelReason: 'No longer needed', canComplete: false, canReopen: false });
    await api().post(`/api/v1/change-tasks/${tid}/reopen`).set(h).send({ reason: 'Bring it back' }).expect(409);
    await api().post(`/api/v1/changes/${id}/tasks`).set(h).send({ description: 'Second task', ownerId: ids.ownerA }).expect(201);
    const cancelled = await api().post(`/api/v1/changes/${id}/cancel`).set(h).send({ reason: 'Overtaken by another change' }).expect(200);
    expect(cancelled.body.stage).toBe('cancelled');
    expect(cancelled.body.tasks.map((t: { status: string }) => t.status)).toEqual(['cancelled', 'cancelled']);
  });
});

describe('raising a change from a record, and finding the changes on a record', () => {
  it('suggests a draft from an NC, labelled under the caller’s own rights, and saves nothing', async () => {
    const h = await as(ids.ownerA);
    const supplier = (await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'CH-S1', 'Castings Ltd') returning id`, [ids.orgA])).rows[0].id;
    const ncr = (await admin.query(
      `insert into public.nonconformances (organisation_id, reference, source, title, description, category_id, part_id, supplier_id)
       values ($1, 'CH-NCR-2', 'supplier', 'Cracked castings', 'Cracks at the gate', $2, $3, $4) returning id`,
      [ids.orgA, await categoryId(admin, ids.orgA), ctx.part, supplier],
    )).rows[0].id;
    ctx.draftNcr = ncr;
    const before = (await api().get('/api/v1/changes').set(h).expect(200)).body.total;
    const d = (await api().get(`/api/v1/change-draft?kind=ncr&id=${ncr}`).set(h).expect(200)).body;
    expect(d.source).toMatchObject({ kind: 'ncr', id: ncr, reference: 'CH-NCR-2' });
    expect(d.title).toContain('Cracked castings');
    expect(d.urgency).toBe('normal');
    expect(d.links.map((l: { kind: string }) => l.kind).sort()).toEqual(['part', 'supplier']);
    expect(d.links.find((l: { kind: string }) => l.kind === 'part')).toMatchObject({ id: ctx.part, reference: 'CH-P1', readable: true });
    expect((await api().get('/api/v1/changes').set(h).expect(200)).body.total).toBe(before);
  });

  it('refuses people who cannot raise a change or cannot read the record, and unknown kinds', async () => {
    const h = await as(ids.ownerA);
    await api().get(`/api/v1/change-draft?kind=ncr&id=${ctx.draftNcr}`).set(await as(ids.inspectorA)).expect(403);
    await api().get('/api/v1/change-draft?kind=ncr&id=00000000-0000-0000-0000-0000000000cc').set(h).expect(404);
    await api().get(`/api/v1/change-draft?kind=part&id=${ctx.part}`).set(h).expect(400);
    await api().get('/api/v1/change-draft?kind=ncr').set(h).expect(400);
  });

  it('raises a change from the draft and shows it on the record it came from', async () => {
    const h = await as(ids.ownerA);
    const d = (await api().get(`/api/v1/change-draft?kind=ncr&id=${ctx.draftNcr}`).set(h).expect(200)).body;
    const made = await api()
      .post('/api/v1/changes')
      .set(h)
      .send({ title: d.title, description: d.description, reason: d.reason, typeId: d.typeId ?? ctx.process, origin: { kind: 'ncr', id: ctx.draftNcr }, links: d.links.map((l: { kind: string; id: string | null; code: string | null }) => (l.id ? { kind: l.kind, id: l.id } : { kind: l.kind, code: l.code })) })
      .expect(201);
    ctx.fromDraft = made.body.id;
    const linked = (await api().get(`/api/v1/changes/linked?kind=ncr&id=${ctx.draftNcr}`).set(h).expect(200)).body;
    expect(linked.canRaise).toBe(true);
    expect(linked.data.map((c: { id: string }) => c.id)).toContain(made.body.id);
    expect(linked.data.find((c: { id: string }) => c.id === made.body.id).via.origin).toBe(true);
    const viewer = (await api().get(`/api/v1/changes/linked?kind=ncr&id=${ctx.draftNcr}`).set(await as(ids.inspectorA)).expect(200)).body;
    expect(viewer.canRaise).toBe(false);
  });

  it('finds changes on a part through their scope, and answers an empty list for a record nothing touches', async () => {
    const h = await as(ids.ownerA);
    const onPart = (await api().get(`/api/v1/changes/linked?kind=part&id=${ctx.part}`).set(h).expect(200)).body;
    expect(onPart.data.length).toBeGreaterThan(0);
    expect(onPart.data.find((c: { id: string }) => c.id === ctx.change).via.scope).toBe(true);
    expect(onPart.canRaise).toBe(false);
    const other = (await admin.query(`insert into public.parts (organisation_id, part_number, name) values ($1, 'CH-P2', 'Untouched') returning id`, [ids.orgA])).rows[0].id;
    expect((await api().get(`/api/v1/changes/linked?kind=part&id=${other}`).set(h).expect(200)).body.data).toEqual([]);
    await api().get('/api/v1/changes/linked?kind=bogus&id=00000000-0000-0000-0000-0000000000cc').set(h).expect(400);
  });

  it('does not show another organisation the change, the draft or the link', async () => {
    const b = await as(ids.ownerB, ids.orgB);
    await api().get(`/api/v1/change-draft?kind=ncr&id=${ctx.draftNcr}`).set(b).expect(404);
    expect((await api().get(`/api/v1/changes/linked?kind=ncr&id=${ctx.draftNcr}`).set(b).expect(200)).body.data).toEqual([]);
  });
});

describe('the dashboard and the home page', () => {
  const todayIso = () => new Date().toISOString().slice(0, 10);
  const range = () => {
    const from = new Date();
    from.setUTCDate(from.getUTCDate() - 89);
    return `from=${from.toISOString().slice(0, 10)}&to=${todayIso()}`;
  };
  const get = async (path: string, user = ids.ownerA) => (await api().get(`/api/v1${path}`).set(await as(user)).expect(200)).body;
  const ready = async (title: string) => {
    const h = await as(ids.ownerA);
    const c = (await api().post('/api/v1/changes').set(h).send({ title, typeId: ctx.tooling, description: 'x', reason: 'y', links: [{ kind: 'part', id: ctx.part }] }).expect(201)).body;
    const sub = (await api().post(`/api/v1/changes/${c.id}/submit`).set(h).expect(200)).body;
    for (const i of sub.impacts) await api().put(`/api/v1/changes/${c.id}/impacts`).set(h).send({ areaId: i.areaId, status: 'not_affected' }).expect(200);
    await api().put(`/api/v1/changes/${c.id}/board`).set(h).send({ board: [{ functionId: ctx.fnQuality, signerId: QM }] }).expect(200);
    return c.id as string;
  };

  it('counts what is open, waiting and late, and the home page says the same', async () => {
    const h = await as(ids.ownerA);
    const before = await get(`/changes-dashboard?${range()}`);
    // one at the board, waiting for its signer
    const atBoard = await ready('Dashboard: at the board');
    await api().post(`/api/v1/changes/${atBoard}/send-to-board`).set(h).expect(200);
    // one approved, being carried out: an overdue task, a cut-in date already gone, the customer still to answer
    const running = await ready('Dashboard: running');
    const sent = (await api().post(`/api/v1/changes/${running}/send-to-board`).set(h).expect(200)).body;
    await api().post(`/api/v1/change-signoffs/${sent.signoffs[0].id}/decide`).set(await as(QM)).send({ approve: true }).expect(200);
    await api().post(`/api/v1/changes/${running}/tasks`).set(h).send({ description: 'Late task', ownerId: ids.ownerA, dueOn: '2020-01-01' }).expect(201);
    await api().put(`/api/v1/changes/${running}/cut-in`).set(h).send({ kind: 'date', date: '2020-02-01' }).expect(200);
    await api().put(`/api/v1/changes/${running}/customer-approval`).set(h).send({ status: 'requested' }).expect(200);

    const after = await get(`/changes-dashboard?${range()}`);
    const k = (key: string) => after.kpis[key] - before.kpis[key];
    expect(k('open')).toBe(2);
    expect(k('atBoard')).toBe(1);
    expect(k('signoffsWaiting')).toBe(1);
    expect(k('tasksOverdue')).toBe(1);
    expect(k('pastCutIn')).toBe(1);
    expect(k('customerWaiting')).toBe(1);
    expect(k('submitted')).toBe(2);
    expect(k('approved')).toBe(1);
    expect(after.waitingSignoffs.map((w: { changeId: string }) => w.changeId)).toContain(atBoard);
    expect(after.waitingSignoffs.find((w: { changeId: string }) => w.changeId === atBoard)).toMatchObject({ signer: 'Quinn Manager', function: 'Quality', days: 0 });
    expect(after.overdueTasks.find((t: { changeId: string }) => t.changeId === running)).toMatchObject({ description: 'Late task', owner: 'Ada Owner', dueOn: '2020-01-01' });
    expect(after.overdueTasks[0].daysLate).toBeGreaterThan(1000);
    expect(after.pastCutInList.find((p: { changeId: string }) => p.changeId === running)).toMatchObject({ cutInOn: '2020-02-01', stage: 'implementing' });
    expect(after.byStage.find((s: { stage: string }) => s.stage === 'approval').count).toBeGreaterThanOrEqual(1);
    expect(after.byStage.map((s: { stage: string }) => s.stage)).toEqual(['assessment', 'approval', 'approved', 'implementing', 'verifying']);
    expect(after.byType.length).toBeGreaterThan(0);
    expect(after.trend.reduce((sum: number, b: { submitted: number }) => sum + b.submitted, 0)).toBe(after.kpis.submitted);

    const home = (await get('/home-dashboard')).change;
    expect(home).toEqual({
      open: after.kpis.open, signoffsWaiting: after.kpis.signoffsWaiting, tasksOverdue: after.kpis.tasksOverdue, pastCutIn: after.kpis.pastCutIn, customerWaiting: after.kpis.customerWaiting,
    });
  });

  it('is for people who may read changes, and shows another organisation nothing of it', async () => {
    await api().get(`/api/v1/changes-dashboard?${range()}`).set(await as(ids.ownerB, ids.orgA)).expect(404);
    const b = await api().get(`/api/v1/changes-dashboard?${range()}`).set(await as(ids.ownerB, ids.orgB)).expect(200);
    expect(b.body.kpis.open).toBe(0);
    expect(b.body.waitingSignoffs).toEqual([]);
    await api().get('/api/v1/changes-dashboard').set(await as(ids.ownerA)).expect(400);
    await api().get(`/api/v1/changes-dashboard?from=${todayIso()}&to=2000-01-01`).set(await as(ids.ownerA)).expect(400);
  });
});

describe('tenancy', () => {
  it('does not show another organisation’s changes or lists, and refuses its ids', async () => {
    const b = await as(ids.ownerB, ids.orgB);
    expect((await api().get('/api/v1/changes').set(b).expect(200)).body.total).toBe(0);
    await api().get(`/api/v1/changes/${ctx.change}`).set(b).expect(404);
    await api().patch(`/api/v1/changes/${ctx.change}`).set(b).send({ title: 'Stolen' }).expect(404);
    await api().post(`/api/v1/changes/${ctx.change}/cancel`).set(b).send({ reason: 'Not yours at all' }).expect(404);
    await api().post(`/api/v1/changes/${ctx.flow}/submit`).set(b).expect(404);
    await api().put(`/api/v1/changes/${ctx.flow}/cut-in`).set(b).send({ kind: 'none' }).expect(404);
    await api().post(`/api/v1/change-signoffs/${ctx.signoff}/decide`).set(b).send({ approve: true }).expect(404);
    await api().post(`/api/v1/changes/${ctx.flow}/tasks`).set(b).send({ description: 'Not yours', ownerId: ids.ownerB }).expect(404);
    await api().post(`/api/v1/changes/${ctx.flow}/reviews`).set(b).send({ effective: true, note: 'Not yours' }).expect(404);
    await api().patch(`/api/v1/change-tasks/${ctx.taskOne}`).set(b).send({ description: 'Stolen task' }).expect(404);
    await api().post(`/api/v1/change-tasks/${ctx.taskOne}/complete`).set(b).send({}).expect(404);
    await api().post(`/api/v1/change-tasks/${ctx.taskOne}/start-revision`).set(b).send({ kind: 'document', documentId: ctx.change }).expect(404);
    expect((await api().get('/api/v1/changes/mine').set(b).expect(200)).body.counts.total).toBe(0);
    await api().patch(`/api/v1/change-types/${ctx.process}`).set(b).send({ label: 'Stolen' }).expect(404);
    const bTypes = (await api().get('/api/v1/change-types').set(b).expect(200)).body.data;
    expect(bTypes.map((t: { id: string }) => t.id)).not.toContain(ctx.process);
    const bType = bTypes.find((t: { key: string }) => t.key === 'process').id;
    await api().post('/api/v1/changes').set(b).send({ title: 'Cross', typeId: ctx.process }).expect(409);
    const own = await api().post('/api/v1/changes').set(b).send({ title: 'Mine', typeId: bType }).expect(201);
    expect(own.body.reference).toMatch(/0001$/);
  });
});
