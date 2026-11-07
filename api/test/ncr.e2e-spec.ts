/**
 * Phase 2.4: non-conformances for internal, customer and supplier sources through the API —
 * create, edit, stages, soft delete and restore, history, classifications, site scoping.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds(7);
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org: string = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const SITE_USER = '70000000-0000-0000-0000-00000000aa77';
const ENGINEER = '70000000-0000-0000-0000-00000000aa78';
let plantB: string;
let customerId: string;
let supplierId: string;
let partId: string;
let revisionId: string;
let failureMode: string;

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-ncr');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const one = async (q: string, params: unknown[]) => (await admin.query(q, params)).rows[0];
  plantB = (await one(`insert into public.sites (organisation_id, code, name) values ($1, 'PB', 'Plant B') returning id`, [ids.orgA])).id;
  await admin.query(`insert into auth.users (id, email) values ($1, 'site.user@example.test'), ($2, 'engineer@example.test')`, [SITE_USER, ENGINEER]);
  for (const [user, role, site] of [[SITE_USER, 'quality_engineer', plantB], [ENGINEER, 'quality_engineer', null]] as const) {
    const m = await one(`insert into public.organisation_users (organisation_id, user_id, status) values ($1, $2, 'active') returning id`, [ids.orgA, user]);
    await admin.query(
      `insert into public.user_role_assignments (organisation_id, membership_id, role_id, site_id) select $1, $2, id, $4 from public.roles where organisation_id = $1 and key = $3`,
      [ids.orgA, m.id, role, site],
    );
  }
  customerId = (await one(`insert into public.customers (organisation_id, code, name) values ($1, 'ACME', 'Acme Fabrication') returning id`, [ids.orgA])).id;
  supplierId = (await one(`insert into public.suppliers (organisation_id, code, name) values ($1, 'STEEL', 'Steel Supplies') returning id`, [ids.orgA])).id;
  partId = (await one(`insert into public.parts (organisation_id, part_number, name) values ($1, 'BRK-100', 'Bracket') returning id`, [ids.orgA])).id;
  revisionId = (await one(`insert into public.part_revisions (organisation_id, part_id, revision) values ($1, $2, 'A') returning id`, [ids.orgA, partId])).id;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('classifications', () => {

  it('are managed with lookups.manage and readable by members', async () => {
    const h = await as(ids.ownerA);
    failureMode = (await api().post('/api/v1/ncr-classifications').set(h).send({ kind: 'failure_mode', code: 'dim', name: 'Dimensional' }).expect(201)).body.id;
    const sub = await api().post('/api/v1/ncr-classifications').set(h).send({ kind: 'sub_failure_mode', parentId: failureMode, name: 'Oversize' }).expect(201);
    expect(sub.body).toMatchObject({ kind: 'sub_failure_mode', parentId: failureMode, name: 'Oversize' });
    await api().post('/api/v1/ncr-classifications').set(h).send({ kind: 'process', code: 'CNC', name: 'Machining' }).expect(201);

    const dup = await api().post('/api/v1/ncr-classifications').set(h).send({ kind: 'failure_mode', name: 'dimensional' }).expect(409);
    expect(dup.body.error.message).toBe('An entry with this name already exists');
    const orphan = await api().post('/api/v1/ncr-classifications').set(h).send({ kind: 'sub_failure_mode', name: 'Orphan' }).expect(400);
    expect(orphan.body.error.code).toBe('invalid_value');

    const listed = await api().get('/api/v1/ncr-classifications?kind=failure_mode').set(await as(ids.inspectorA)).expect(200);
    expect(listed.body.data.map((c: { name: string }) => c.name)).toEqual(['Dimensional']);
    await api().post('/api/v1/ncr-classifications').set(await as(ids.inspectorA)).send({ kind: 'process', name: 'Nope' }).expect(403);
  });
});

describe('non-conformances', () => {
  let internal: string;
  let customer: string;
  let supplier: string;

  it('creates an internal draft with a generated reference', async () => {
    const res = await api()
      .post('/api/v1/ncrs')
      .set(await as(ids.ownerA))
      .send({ source: 'internal', title: 'Bore oversize', partId, partRevisionId: revisionId, workOrder: 'WO-1', siteId: ids.siteA })
      .expect(201);
    internal = res.body.id;
    expect(res.body).toMatchObject({
      reference: expect.stringMatching(/^NCM-\d{2}-\d{3}$/),
      source: 'internal',
      stage: 'draft',
      part: { partNumber: 'BRK-100', revision: 'A' },
      workOrder: 'WO-1',
      detectedBy: { id: ids.ownerA, name: 'Ada Owner' },
      createdBy: { id: ids.ownerA, name: 'Ada Owner' },
    });
  });

  it('explains what is missing before a draft can be opened, then opens it', async () => {
    const h = await as(ids.ownerA);
    const missing = await api().post(`/api/v1/ncrs/${internal}/transitions`).set(h).send({ to: 'open' }).expect(409);
    expect(missing.body.error).toMatchObject({ code: 'ncr_rule', message: 'To open this non-conformance, fill in: severity, quantity affected' });
    const edited = await api().patch(`/api/v1/ncrs/${internal}`).set(h).send({ severity: 'major', quantityAffected: 4, description: '0.05 over' }).expect(200);
    expect(edited.body).toMatchObject({ severity: 'major', quantityAffected: 4, description: '0.05 over' });
    const opened = await api().post(`/api/v1/ncrs/${internal}/transitions`).set(h).send({ to: 'open' }).expect(200);
    expect(opened.body.stage).toBe('open');
  });

  it('creates customer and supplier NCs, requiring the party to open', async () => {
    const h = await as(ids.ownerA);
    const noCustomer = await api().post('/api/v1/ncrs').set(h).send({ source: 'customer', title: 'Complaint', severity: 'minor', quantityAffected: 2, description: 'Scratched', open: true }).expect(409);
    expect(noCustomer.body.error.message).toBe('To open this non-conformance, fill in: customer');
    customer = (
      await api().post('/api/v1/ncrs').set(h)
        .send({ source: 'customer', title: 'Complaint', severity: 'minor', quantityAffected: 2, description: 'Scratched', customerId, customerReference: 'CLM-9', open: true })
        .expect(201)
    ).body.id;
    supplier = (
      await api().post('/api/v1/ncrs').set(h)
        .send({ source: 'supplier', title: 'Wrong grade', severity: 'critical', quantityAffected: 100, partId, supplierId, purchaseOrder: 'PO-7', open: true })
        .expect(201)
    ).body.id;
    const got = await api().get(`/api/v1/ncrs/${supplier}`).set(h).expect(200);
    expect(got.body).toMatchObject({ source: 'supplier', stage: 'open', supplier: { name: 'Steel Supplies' }, purchaseOrder: 'PO-7' });
  });

  it('lists each register separately, with search, sort and paging', async () => {
    const h = await as(ids.ownerA);
    const byType = async (source: string) => (await api().get(`/api/v1/ncrs?source=${source}`).set(h).expect(200)).body;
    expect((await byType('internal')).data.map((n: { id: string }) => n.id)).toContain(internal);
    expect((await byType('customer')).data.map((n: { id: string }) => n.id)).toEqual([customer]);
    expect((await byType('supplier')).data.map((n: { id: string }) => n.id)).toEqual([supplier]);

    const found = await api().get('/api/v1/ncrs?q=clm-9').set(h).expect(200);
    expect(found.body.data.map((n: { id: string }) => n.id)).toEqual([customer]);
    const page = await api().get('/api/v1/ncrs?sort=title&order=asc&pageSize=2&page=1').set(h).expect(200);
    expect(page.body).toMatchObject({ page: 1, pageSize: 2, total: 3 });
    expect(page.body.data.map((n: { title: string }) => n.title)).toEqual(['Bore oversize', 'Complaint']);
    await api().get('/api/v1/ncrs?sort=nonsense').set(h).expect(400);
  });

  it('moves through stages, cancels and reopens with reasons, and locks closed records', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/ncrs/${internal}/transitions`).set(h).send({ to: 'investigating' }).expect(200);
    const back = await api().post(`/api/v1/ncrs/${internal}/transitions`).set(h).send({ to: 'open' }).expect(409);
    expect(back.body.error.message).toBe('A investigating non-conformance cannot move to open');
    const closed = await api().post(`/api/v1/ncrs/${internal}/transitions`).set(h).send({ to: 'closed' }).expect(200);
    expect(closed.body).toMatchObject({ stage: 'closed', closedBy: { name: 'Ada Owner' } });
    const locked = await api().patch(`/api/v1/ncrs/${internal}`).set(h).send({ title: 'Edit after close' }).expect(409);
    expect(locked.body.error.message).toBe('This non-conformance is closed; reopen it to make changes');
    await api().post(`/api/v1/ncrs/${internal}/transitions`).set(h).send({ to: 'open' }).expect(409);
    const reopened = await api().post(`/api/v1/ncrs/${internal}/transitions`).set(h).send({ to: 'open', reason: 'Customer found more' }).expect(200);
    expect(reopened.body).toMatchObject({ stage: 'open', stageReason: 'Customer found more', closedAt: null });
    await api().post(`/api/v1/ncrs/${customer}/transitions`).set(h).send({ to: 'cancelled' }).expect(409);
    await api().post(`/api/v1/ncrs/${customer}/transitions`).set(h).send({ to: 'cancelled', reason: 'Duplicate' }).expect(200);
    await api().post(`/api/v1/ncrs/${customer}/transitions`).set(h).send({ to: 'cancelled', reason: 'Again' }).expect(409);
  });

  it('soft-deletes and restores with ncr.delete, keeping the record', async () => {
    await api().post(`/api/v1/ncrs/${supplier}/delete`).set(await as(ENGINEER)).send({ reason: 'Raised in error' }).expect(403);
    await api().post(`/api/v1/ncrs/${supplier}/delete`).set(await as(ids.ownerA)).send({}).expect(400);
    const deleted = await api().post(`/api/v1/ncrs/${supplier}/delete`).set(await as(ids.ownerA)).send({ reason: 'Raised in error' }).expect(200);
    expect(deleted.body).toMatchObject({ deletedAt: expect.any(String), deleteReason: 'Raised in error', deletedBy: { name: 'Ada Owner' } });

    const h = await as(ids.ownerA);
    expect((await api().get('/api/v1/ncrs?source=supplier').set(h).expect(200)).body.data).toEqual([]);
    expect((await api().get('/api/v1/ncrs?source=supplier&deleted=only').set(h).expect(200)).body.data.map((n: { id: string }) => n.id)).toEqual([supplier]);
    const locked = await api().patch(`/api/v1/ncrs/${supplier}`).set(h).send({ title: 'Edit while deleted' }).expect(409);
    expect(locked.body.error.message).toBe('This non-conformance is deleted; restore it first');

    const restored = await api().post(`/api/v1/ncrs/${supplier}/restore`).set(h).expect(200);
    expect(restored.body).toMatchObject({ deletedAt: null, deleteReason: null });
    const { rows } = await admin.query('select count(*)::int as n from public.nonconformances where id = $1', [supplier]);
    expect(rows[0].n).toBe(1);
  });

  it('shows the history to anyone who can read the record', async () => {
    await api().patch(`/api/v1/ncrs/${internal}`).set(await as(ids.ownerA)).send({ failureModeId: failureMode }).expect(200);
    const res = await api().get(`/api/v1/ncrs/${internal}/history`).set(await as(ENGINEER)).expect(200);
    const fmChange = res.body.data.find((e: { changedFields: string[] }) => e.changedFields.includes('failure_mode_id'));
    expect(fmChange.current.failure_mode_id).toBe(failureMode);
    expect(fmChange.names).toEqual({ [failureMode]: 'Dimensional' });
    expect(res.body.data[0].names[partId]).toMatch(/·/);
    expect(res.body.data[0].names[ids.siteA]).toBeTruthy();
    expect(res.body.data[0]).toMatchObject({ action: 'insert', actor: { id: ids.ownerA, name: 'Ada Owner' }, source: 'api' });
    expect(res.body.data.some((e: { changedFields: string[] }) => e.changedFields.includes('stage'))).toBe(true);
  });

  it('lets an engineer edit but not an inspector', async () => {
    await api().patch(`/api/v1/ncrs/${internal}`).set(await as(ENGINEER)).send({ lotNumber: 'L-42' }).expect(200);
    await api().patch(`/api/v1/ncrs/${internal}`).set(await as(ids.inspectorA)).send({ lotNumber: 'L-43' }).expect(403);
    await api().get(`/api/v1/ncrs/${internal}`).set(await as(ids.inspectorA)).expect(200);
  });

  it('admits site-scoped users to their own site only', async () => {
    const h = await as(SITE_USER);
    const atB = await api().post('/api/v1/ncrs').set(h).send({ source: 'internal', title: 'At plant B', siteId: plantB }).expect(201);
    await api().post('/api/v1/ncrs').set(h).send({ source: 'internal', title: 'At plant A', siteId: ids.siteA }).expect(403);
    const listed = await api().get('/api/v1/ncrs').set(h).expect(200);
    expect(listed.body.data.map((n: { id: string }) => n.id)).toEqual([atB.body.id]);
    await api().get(`/api/v1/ncrs/${internal}`).set(h).expect(404);
  });

  it('lists personnel for the responsible-operator picker', async () => {
    await admin.query(`insert into public."Employees" (organisation_id, first_name, surname) values ($1, 'Sam', 'Operator')`, [ids.orgA]);
    const res = await api().get('/api/v1/employees/lookup').set(await as(ids.inspectorA)).expect(200);
    expect(res.body.data.map((e: { name: string }) => e.name)).toContain('Sam Operator');
  });
});
