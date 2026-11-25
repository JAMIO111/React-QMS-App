/**
 * FMEA (FM5c-2) through the API: an FMEA, or a new revision, raised from a non-conformance (or an 8D, finding, SCAR, change). The suggestion saves nothing; the reason is kept and never
 * changes; a record the caller may not read is not found; the record's page can list what was raised from it.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { categoryId, makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a6f');
const QM = 'a6f00000-0000-0000-0000-0000000000e1';
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const today = () => new Date().toISOString().slice(0, 10);
const ctx: Record<string, string> = {};

/* eslint-disable @typescript-eslint/no-explicit-any */
async function buildNet(h: Record<string, string>, revision: string) {
  const item = (await api().post(`/api/v1/fmea-revisions/${revision}/items`).set(h).send({ kind: 'item', name: 'Turning' }).expect(201)).body.net.items[0].id;
  const fn = (await api().post(`/api/v1/fmea-items/${item}/functions`).set(h).send({ text: 'Turn the bore to size' }).expect(201)).body.net.items[0].functions[0].id;
  const mode = (await api().post(`/api/v1/fmea-functions/${fn}/failure-modes`).set(h).send({ text: 'Bore oversize' }).expect(201)).body.net.items[0].functions[0].failureModes[0].id;
  await api().post(`/api/v1/fmea-failure-modes/${mode}/effects`).set(h).send({ level: 'own_plant', text: 'Scrap', severity: 5 }).expect(201);
  await api().post(`/api/v1/fmea-failure-modes/${mode}/causes`).set(h).send({ text: 'Tool wear', preventionControls: 'Tool life counter', occurrence: 3, detection: 3 }).expect(201);
}

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-fr');
  await admin.query(`insert into auth.users (id, email) values ($1, 'qm-fr@example.test')`, [QM]);
  await admin.query(`update public.profiles set first_name = 'Quinn', surname = 'Manager' where id = $1`, [QM]);
  const m = await admin.query(`insert into public.organisation_users (organisation_id, user_id, status, joined_at) values ($1, $2, 'active', now()) returning id`, [ids.orgA, QM]);
  await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = 'quality_manager'`, [ids.orgA, m.rows[0].id]);
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });

  const one = async (text: string, params: unknown[]) => (await admin.query(text, params)).rows[0].id as string;
  ctx.part = await one(`insert into public.parts (organisation_id, part_number, name) values ($1, 'FR-1', 'Bracket') returning id`, [ids.orgA]);
  ctx.machine = await one(`insert into public.machines (organisation_id, code, name) values ($1, 'CNC-1', 'Lathe') returning id`, [ids.orgA]);
  ctx.supplier = await one(`insert into public.suppliers (organisation_id, code, name) values ($1, 'CAST', 'Castings Ltd') returning id`, [ids.orgA]);
  const cat = await categoryId(admin, ids.orgA);
  ctx.ncr = await one(
    `insert into public.nonconformances (organisation_id, reference, source, supplier_id, part_id, causal_process_id, title, severity, quantity_affected, description, stage, category_id, requirement, actual_result)
     values ($1, 'FR-NC-1', 'supplier', $2, $3, $4, 'Porosity in castings', 'major', 20, 'Porosity found at machining', 'open', $5, 'No porosity over 0.5 mm', '1.2 mm voids') returning id`,
    [ids.orgA, ctx.supplier, ctx.part, ctx.machine, cat],
  );
  ctx.ncrB = await one(
    `insert into public.nonconformances (organisation_id, reference, source, title, severity, quantity_affected, description, stage, category_id)
     values ($1, 'FR-NC-2', 'internal', 'Theirs', 'minor', 1, 'x', 'open', $2) returning id`,
    [ids.orgB, await categoryId(admin, ids.orgB)],
  );
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('what a record suggests', () => {
  it('suggests a title, a scope and the part, machine and supplier, and saves nothing', async () => {
    const h = await as(ids.ownerA);
    const r = await api().get(`/api/v1/fmea-draft?kind=ncr&id=${ctx.ncr}`).set(h).expect(200);
    expect(r.body).toMatchObject({ kind: 'process', title: 'Porosity in castings', source: { kind: 'ncr', id: ctx.ncr, title: 'Porosity in castings' } });
    expect(r.body.scopeText).toMatch(/^Raised from non-conformance .*: Porosity in castings$/);
    expect(r.body.links.map((l: any) => l.kind).sort()).toEqual(['machine', 'part', 'supplier']);
    expect(r.body.links.find((l: any) => l.kind === 'part')).toMatchObject({ id: ctx.part, label: 'FR-1 Bracket' });
    expect((await api().get('/api/v1/fmeas').set(h).expect(200)).body.total).toBe(0);
  });

  it('refuses a kind that cannot start an FMEA, another organisation\'s record and someone who may not raise one', async () => {
    const h = await as(ids.ownerA);
    await api().get(`/api/v1/fmea-draft?kind=risk&id=${ctx.ncr}`).set(h).expect(400);
    await api().get(`/api/v1/fmea-draft?kind=ncr&id=${ctx.ncrB}`).set(h).expect(404);
    await api().get(`/api/v1/fmea-draft?kind=ncr&id=${ctx.ncr}`).set(await as(ids.inspectorA)).expect(403);
  });
});

describe('raising an FMEA from the record', () => {
  let fmea: string;
  let rev: string;

  it('keeps where it came from, on the FMEA and on its page', async () => {
    const h = await as(ids.ownerA);
    const made = (await api().post('/api/v1/fmeas').set(h).send({ kind: 'process', title: 'Porosity in castings', links: [{ kind: 'part', id: ctx.part }], raisedFrom: { kind: 'ncr', id: ctx.ncr } }).expect(201)).body;
    fmea = made.id;
    rev = made.inProgress.id;
    expect(made.origin).toMatchObject({ kind: 'ncr', id: ctx.ncr, title: 'Porosity in castings', readable: true });
    expect((await api().get(`/api/v1/fmeas/${fmea}`).set(h).expect(200)).body.origin.id).toBe(ctx.ncr);
    expect((await api().get(`/api/v1/fmea-revisions/${rev}`).set(h).expect(200)).body.origin).toBeNull();
  });

  it('refuses another organisation\'s record and leaves no half-made FMEA behind', async () => {
    const h = await as(ids.ownerA);
    await api().post('/api/v1/fmeas').set(h).send({ kind: 'process', title: 'Not allowed', raisedFrom: { kind: 'ncr', id: ctx.ncrB } }).expect(404);
    const list = (await api().get('/api/v1/fmeas?status=all').set(h).expect(200)).body;
    expect(list.data.map((f: any) => f.title)).not.toContain('Not allowed');
  });

  it('lists what was raised from the record, for the record\'s page', async () => {
    const h = await as(ids.ownerA);
    const r = (await api().get(`/api/v1/fmeas/linked?kind=ncr&id=${ctx.ncr}`).set(h).expect(200)).body;
    expect(r.canRaise).toBe(true);
    expect(r.data).toHaveLength(1);
    expect(r.data[0]).toMatchObject({ id: fmea, via: ['origin'], status: 'draft' });
    expect((await api().get(`/api/v1/fmeas/linked?kind=ncr&id=${ctx.ncrB}`).set(h).expect(200)).body.data).toEqual([]);
  });

  it('records why a new revision was started, once', async () => {
    const h = await as(ids.ownerA);
    await api().put(`/api/v1/fmea-revisions/${rev}/team`).set(h).send({ team: [{ userId: ids.ownerA, role: 'lead' }, { userId: QM, role: 'quality' }] }).expect(200);
    await api().put(`/api/v1/fmea-revisions/${rev}/approver`).set(h).send({ approverId: QM }).expect(200);
    await buildNet(h, rev);
    await api().post(`/api/v1/fmea-revisions/${rev}/submit`).set(h).expect(200);
    await api().post(`/api/v1/fmea-revisions/${rev}/approve`).set(await as(QM)).send({ effectiveFrom: today() }).expect(200);
    const started = (await api().post(`/api/v1/fmeas/${fmea}/revisions`).set(h).send({ raisedFrom: { kind: 'ncr', id: ctx.ncr } }).expect(201)).body;
    const draft = started.inProgress.id as string;
    expect((await api().get(`/api/v1/fmea-revisions/${draft}`).set(h).expect(200)).body.origin).toMatchObject({ kind: 'ncr', id: ctx.ncr, readable: true });
    // The FMEA's own origin has not moved.
    expect(started.origin.id).toBe(ctx.ncr);
  });

  it('refuses to give the same FMEA a second reason by SQL as well', async () => {
    await expect(admin.query(`update public.fmeas set origin_id = $2 where id = $1`, [fmea, ctx.ncrB])).rejects.toThrow(/never changes/);
  });
});
