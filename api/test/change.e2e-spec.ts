/**
 * Change management (CH1) through the API: the seeded lists, raising a change, editing a draft, scope links, origin, files, cancelling, the register's
 * filters, permissions and tenancy. The rules are in supabase/tests/change_management_core.test.sql; this checks the routes and that errors reach the caller in words.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { categoryId, makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a1d');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-ch');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});
afterAll(async () => {
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

describe('tenancy', () => {
  it('does not show another organisation’s changes or lists, and refuses its ids', async () => {
    const b = await as(ids.ownerB, ids.orgB);
    expect((await api().get('/api/v1/changes').set(b).expect(200)).body.total).toBe(0);
    await api().get(`/api/v1/changes/${ctx.change}`).set(b).expect(404);
    await api().patch(`/api/v1/changes/${ctx.change}`).set(b).send({ title: 'Stolen' }).expect(404);
    await api().post(`/api/v1/changes/${ctx.change}/cancel`).set(b).send({ reason: 'Not yours at all' }).expect(404);
    await api().patch(`/api/v1/change-types/${ctx.process}`).set(b).send({ label: 'Stolen' }).expect(404);
    const bTypes = (await api().get('/api/v1/change-types').set(b).expect(200)).body.data;
    expect(bTypes.map((t: { id: string }) => t.id)).not.toContain(ctx.process);
    const bType = bTypes.find((t: { key: string }) => t.key === 'process').id;
    await api().post('/api/v1/changes').set(b).send({ title: 'Cross', typeId: ctx.process }).expect(409);
    const own = await api().post('/api/v1/changes').set(b).send({ title: 'Mine', typeId: bType }).expect(201);
    expect(own.body.reference).toMatch(/0001$/);
  });
});
