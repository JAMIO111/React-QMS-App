/**
 * FMEA (FM5c-3) through the API: a risk raised from an FMEA cause or linked to one, the FMEAs that cover an 8D's scope (the prompt on its prevention step), and a change task that
 * changes an FMEA revision and is finished only once that revision is in force.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { categoryId, makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a7b');
const QM = 'a7b00000-0000-0000-0000-0000000000e1';
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
  await seed(admin, ids, '-frc');
  await admin.query(`insert into auth.users (id, email) values ($1, 'qm-fx@example.test')`, [QM]);
  await admin.query(`update public.profiles set first_name = 'Quinn', surname = 'Manager' where id = $1`, [QM]);
  const m = await admin.query(`insert into public.organisation_users (organisation_id, user_id, status, joined_at) values ($1, $2, 'active', now()) returning id`, [ids.orgA, QM]);
  await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = 'quality_manager'`, [ids.orgA, m.rows[0].id]);
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });

  const one = async (text: string, params: unknown[]) => (await admin.query(text, params)).rows[0].id as string;
  ctx.part = await one(`insert into public.parts (organisation_id, part_number, name) values ($1, 'FX-1', 'Bracket') returning id`, [ids.orgA]);
  ctx.machine = await one(`insert into public.machines (organisation_id, code, name) values ($1, 'CNC-1', 'Lathe') returning id`, [ids.orgA]);
  ctx.ncr = await one(
    `insert into public.nonconformances (organisation_id, reference, source, part_id, causal_process_id, title, severity, quantity_affected, description, stage, category_id)
     values ($1, 'FX-NC-1', 'internal', $2, $3, 'Oversize bores', 'major', 5, 'Bores out of size', 'open', $4) returning id`,
    [ids.orgA, ctx.part, ctx.machine, await categoryId(admin, ids.orgA)],
  );
  const h = await as(ids.ownerA);
  ctx.capa = (await api().post('/api/v1/capas').set(h).send({ fromNcrId: ctx.ncr }).expect(201)).body.id;

  const made = (await api().post('/api/v1/fmeas').set(h).send({ kind: 'process', title: 'Machining the bracket', links: [{ kind: 'part', id: ctx.part }, { kind: 'machine', id: ctx.machine }] }).expect(201)).body;
  ctx.fmea = made.id;
  ctx.rev = made.inProgress.id;
  await api().put(`/api/v1/fmea-revisions/${ctx.rev}/team`).set(h).send({ team: [{ userId: ids.ownerA, role: 'lead' }, { userId: QM, role: 'quality' }] }).expect(200);
  await api().put(`/api/v1/fmea-revisions/${ctx.rev}/approver`).set(h).send({ approverId: QM }).expect(200);
  await buildNet(h, ctx.rev);
  await api().post(`/api/v1/fmea-revisions/${ctx.rev}/submit`).set(h).expect(200);
  await api().post(`/api/v1/fmea-revisions/${ctx.rev}/approve`).set(await as(QM)).send({ effectiveFrom: today() }).expect(200);
  ctx.cause = (await admin.query(`select id from public.fmea_causes where revision_id = $1`, [ctx.rev])).rows[0].id;
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('a risk and an FMEA cause', () => {
  it('suggests a risk from a cause: its words, its scope, and where it came from', async () => {
    const h = await as(ids.ownerA);
    const d = (await api().get(`/api/v1/risk-draft?kind=fmea_cause&id=${ctx.cause}`).set(h).expect(200)).body;
    expect(d).toMatchObject({ title: 'Bore oversize', cause: 'Tool wear', effect: 'Scrap', source: { kind: 'fmea_cause', id: ctx.cause, reference: 'FMEA-001' } });
    expect(d.links.map((l: any) => l.kind).sort()).toEqual(['fmea_cause', 'machine', 'part']);
    expect(d.links.find((l: any) => l.kind === 'fmea_cause')).toMatchObject({ readable: true, reference: 'FMEA-001', name: 'Tool wear', parentId: ctx.fmea });
  });

  it('raises the risk from the cause, keeps it as its origin and finds it from the cause', async () => {
    const h = await as(ids.ownerA);
    const d = (await api().get(`/api/v1/risk-draft?kind=fmea_cause&id=${ctx.cause}`).set(h).expect(200)).body;
    const made = await api().post('/api/v1/risks').set(h)
      .send({ kind: 'risk', title: d.title, description: d.description, cause: d.cause, effect: d.effect, categoryId: d.categoryId, raisedFrom: { kind: 'fmea_cause', id: ctx.cause }, links: [{ kind: 'part', id: ctx.part }] })
      .expect(201);
    ctx.risk = made.body.id;
    expect(made.body.origin).toMatchObject({ kind: 'fmea_cause', id: ctx.cause, readable: true, reference: 'FMEA-001' });
    expect(made.body.links.find((l: any) => l.kind === 'fmea_cause')).toMatchObject({ parentId: ctx.fmea, revisionId: ctx.rev, name: 'Tool wear' });
    const linked = (await api().get(`/api/v1/risks/linked?kind=fmea_cause&id=${ctx.cause}`).set(h).expect(200)).body;
    expect(linked.data.map((r: any) => r.id)).toEqual([ctx.risk]);
    expect(linked.canRaise).toBe(true);
    // The link to its origin cannot be taken away.
    await api().put(`/api/v1/risks/${ctx.risk}/links`).set(h).send({ links: [{ kind: 'part', id: ctx.part }] }).expect(409);
  });

  it('lets any risk name a cause, and refuses another organisation\'s record', async () => {
    const h = await as(ids.ownerA);
    const category = (await api().get('/api/v1/risk-draft?kind=fmea_cause&id=' + ctx.cause).set(h)).body.categoryId;
    const r = (await api().post('/api/v1/risks').set(h).send({ kind: 'risk', title: 'Tool wear', categoryId: category }).expect(201)).body;
    const put = await api().put(`/api/v1/risks/${r.id}/links`).set(h).send({ links: [{ kind: 'fmea_cause', id: ctx.cause }] }).expect(200);
    expect(put.body.links[0]).toMatchObject({ kind: 'fmea_cause', reference: 'FMEA-001', readable: true });
    await api().get(`/api/v1/risk-draft?kind=fmea_cause&id=${ctx.cause}`).set(await as(ids.ownerB, ids.orgB)).expect(404);
  });
});

describe('the FMEAs that cover an 8D', () => {
  it('lists the FMEAs in force that cover the parts and machines of the 8D\'s non-conformances', async () => {
    const h = await as(ids.ownerA);
    const r = (await api().get(`/api/v1/fmeas/linked?kind=capa_scope&id=${ctx.capa}`).set(h).expect(200)).body;
    expect(r.canRaise).toBe(true);
    expect(r.data).toHaveLength(1);
    expect(r.data[0]).toMatchObject({ id: ctx.fmea, number: 'FMEA-001', via: ['machine', 'part'] });
  });

  it('lists none for an 8D with nothing linked', async () => {
    const h = await as(ids.ownerA);
    const bare = (await api().post('/api/v1/capas').set(h).send({ title: 'Recurring burrs' }).expect(201)).body.id;
    expect((await api().get(`/api/v1/fmeas/linked?kind=capa_scope&id=${bare}`).set(h).expect(200)).body.data).toEqual([]);
  });
});

describe('a change task that changes an FMEA revision', () => {
  it('waits for the revision to be in force before the task can be finished', async () => {
    const h = await as(ids.ownerA);
    const types = (await api().get('/api/v1/change-types').set(h).expect(200)).body.data;
    const change = (await api().post('/api/v1/changes').set(h).send({ title: 'Rework the FMEA', typeId: types[0].id, description: 'New tooling', reason: 'Wear', links: [{ kind: 'part', id: ctx.part }] }).expect(201)).body;
    const sub = await api().post(`/api/v1/changes/${change.id}/submit`).set(h).expect(200);
    for (const i of sub.body.impacts) await api().put(`/api/v1/changes/${change.id}/impacts`).set(h).send({ areaId: i.areaId, status: 'not_affected' }).expect(200);
    const fns = (await api().get('/api/v1/change-functions').set(h).expect(200)).body.data;
    await api().put(`/api/v1/changes/${change.id}/board`).set(h).send({ board: [{ functionId: fns.find((f: any) => f.key === 'quality').id, signerId: QM }] }).expect(200);
    await api().put(`/api/v1/changes/${change.id}/customer-approval`).set(h).send({ status: 'not_needed' }).expect(200);
    const sent = await api().post(`/api/v1/changes/${change.id}/send-to-board`).set(h).expect(200);
    await api().post(`/api/v1/change-signoffs/${sent.body.signoffs[0].id}/decide`).set(await as(QM)).send({ approve: true }).expect(200);

    const task = (await api().post(`/api/v1/changes/${change.id}/tasks`).set(h).send({ description: 'Revise the FMEA', ownerId: ids.ownerA }).expect(201)).body.tasks[0].id;
    const started = await api().post(`/api/v1/change-tasks/${task}/start-revision`).set(h).send({ kind: 'fmea', fmeaId: ctx.fmea }).expect(200);
    expect(started.body.started.kind).toBe('fmea_revision');
    const linkedTask = started.body.tasks.find((t: any) => t.id === task);
    expect(linkedTask.link).toMatchObject({ kind: 'fmea_revision', status: 'draft', state: 'pending', readable: true, parentId: ctx.fmea });
    expect(linkedTask.link.label).toMatch(/^FMEA-001 \(draft\)/);
    const early = await api().post(`/api/v1/change-tasks/${task}/complete`).set(h).send({}).expect(409);
    expect(early.body.error.message).toMatch(/not in force yet/);

    const draft = started.body.started.revisionId;
    await api().patch(`/api/v1/fmea-revisions/${draft}`).set(h).send({ changeSummary: 'Reworked after the change' }).expect(200);
    await api().put(`/api/v1/fmea-revisions/${draft}/approver`).set(h).send({ approverId: QM }).expect(200);
    await api().post(`/api/v1/fmea-revisions/${draft}/submit`).set(h).expect(200);
    await api().post(`/api/v1/fmea-revisions/${draft}/approve`).set(await as(QM)).send({ effectiveFrom: today() }).expect(200);
    const read = await api().get(`/api/v1/changes/${change.id}`).set(h).expect(200);
    expect(read.body.tasks.find((t: any) => t.id === task).link).toMatchObject({ status: 'effective', state: 'in_force' });
    await api().post(`/api/v1/change-tasks/${task}/complete`).set(h).send({}).expect(200);
  });

  it('refuses another organisation\'s FMEA', async () => {
    const h = await as(ids.ownerA);
    await api().post('/api/v1/change-tasks/' + ctx.fmea + '/start-revision').set(h).send({ kind: 'fmea', fmeaId: ctx.fmea }).expect(404);
  });
});
