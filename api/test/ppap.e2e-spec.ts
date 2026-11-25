/**
 * PPAP (PP1) through the API: starting a submission (its 18 elements, the level, the customer's rules, a retried request), the elements and their file evidence,
 * waivers by an approver, what is still needed, ready / reopen / withdraw, the register's filters, the requirements and their versions, edit conflicts, permissions and
 * tenancy. The rules are in supabase/tests/ppap_foundation.test.sql; this checks the routes and that errors reach the caller in words.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';
import { ELEMENT_TYPES } from '../src/ppap/ppap.schemas';

const ids = makeIds('e9f');
const QM = 'e9f00000-0000-0000-0000-0000000000e1';
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};
/* eslint-disable @typescript-eslint/no-explicit-any */
const element = (body: any, key: string) => body.elements.find((e: any) => e.key === key);

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-pp');
  await admin.query(`insert into auth.users (id, email) values ($1, 'qm-pp@example.test')`, [QM]);
  await admin.query(`update public.profiles set first_name = 'Quinn', surname = 'Manager' where id = $1`, [QM]);
  const m = await admin.query(`insert into public.organisation_users (organisation_id, user_id, status, joined_at) values ($1, $2, 'active', now()) returning id`, [ids.orgA, QM]);
  await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = 'quality_manager'`, [ids.orgA, m.rows[0].id]);
  ctx.part = (await admin.query(`insert into public.parts (organisation_id, part_number, name) values ($1, 'PP-P1', 'Bracket') returning id`, [ids.orgA])).rows[0].id;
  const rev = (await admin.query(`insert into public.part_revisions (organisation_id, part_id, revision) values ($1, $2, 'B') returning id`, [ids.orgA, ctx.part])).rows[0].id;
  await admin.query(`update public.part_revisions set status = 'released' where id = $1`, [rev]);
  ctx.rev = rev;
  ctx.customer = (await admin.query(`insert into public.customers (organisation_id, code, name) values ($1, 'PP-C1', 'Acme Motors') returning id`, [ids.orgA])).rows[0].id;
  ctx.customer2 = (await admin.query(`insert into public.customers (organisation_id, code, name) values ($1, 'PP-C2', 'Beta Aero') returning id`, [ids.orgA])).rows[0].id;
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('the 18 elements', () => {
  it('are the same in the API and the database', async () => {
    const rows = (await admin.query(`select key, label from app.ppap_element_types() order by ordinal`)).rows;
    expect(ELEMENT_TYPES.map((e) => ({ key: e.key, label: e.label }))).toEqual(rows);
  });
});

describe('starting a submission', () => {
  it('lets a preparer start one and not a reader', async () => {
    const body = { partId: ctx.part, customerId: ctx.customer, reason: 'new_part' };
    await api().post('/api/v1/ppaps').set(await as(ids.inspectorA)).send(body).expect(403);
    const h = await as(ids.ownerA);
    await api().post('/api/v1/ppaps').set(h).send({ partId: ctx.part, customerId: ctx.customer }).expect(400);
    await api().post('/api/v1/ppaps').set(h).send({ ...body, reason: 'because' }).expect(400);
    await api().post('/api/v1/ppaps').set(h).send({ ...body, colour: 'red' }).expect(400);
    await api().post('/api/v1/ppaps').set(h).send({ ...body, level: 6 }).expect(400);
    const refused = await api().post('/api/v1/ppaps').set(h).send({ ...body, partId: ids.orgB }).expect(409);
    expect(refused.body.error).toMatchObject({ code: 'ppap_rule', message: expect.stringMatching(/part of this organisation/) });
    const made = await api().post('/api/v1/ppaps').set(h).send({ ...body, notes: 'First samples', clientKey: 'pp-retry-0001' }).expect(201);
    expect(made.body).toMatchObject({
      reference: expect.stringMatching(/^PPAP-[0-9]{2}-0001$/), status: 'draft', level: 3, direction: 'submitted', reason: 'new_part', created: true, notes: 'First samples',
      part: { partNumber: 'PP-P1', name: 'Bracket' }, partRevision: { label: 'B', status: 'released' }, customer: { name: 'Acme Motors' },
      editable: true, canManage: true, canApprove: true, canMarkReady: false, canReopen: false, canWithdraw: true, progress: { required: 18, done: 0 },
    });
    expect(made.body.elements).toHaveLength(18);
    expect(made.body.elements.map((e: any) => e.key)).toEqual(ELEMENT_TYPES.map((e) => e.key));
    expect(made.body.elements.every((e: any) => e.requirement === 'required' && e.status === 'not_started' && e.evidence.length === 0)).toBe(true);
    expect(made.body.requirementSet).toMatchObject({ version: 1 });
    expect(made.body.problems).toHaveLength(17);
    ctx.ppap = made.body.id;
    const again = await api().post('/api/v1/ppaps').set(h).send({ ...body, clientKey: 'pp-retry-0001' }).expect(201);
    expect(again.body).toMatchObject({ id: ctx.ppap, created: false });
    const duplicate = await api().post('/api/v1/ppaps').set(h).send(body).expect(409);
    expect(duplicate.body.error.code).toBe('ppap_rule');
    expect((await api().get(`/api/v1/ppaps/${ctx.ppap}`).set(h).expect(200)).body.rowVersion).toMatch(/^[0-9]{10,20}$/);
  });

  it('starts from a customer\'s own rules', async () => {
    await api().put(`/api/v1/ppap-customer-rules/${ctx.customer2}`).set(await as(ids.inspectorA)).send({ defaultLevel: 2 }).expect(403);
    const qm = await as(QM);
    await api().put(`/api/v1/ppap-customer-rules/${ctx.customer2}`).set(qm).send({ defaultLevel: 9 }).expect(400);
    const rules = await api().put(`/api/v1/ppap-customer-rules/${ctx.customer2}`).set(qm).send({ defaultLevel: 2, extraElements: ['dfmea'], minCpkInitial: 2, note: 'Wants the design FMEA' }).expect(200);
    expect(rules.body.data).toEqual([expect.objectContaining({ customerId: ctx.customer2, customerName: 'Beta Aero', defaultLevel: 2, extraElements: ['dfmea'], minCpkInitial: 2, minCpkOngoing: null })]);
    expect(rules.body.canChange).toBe(true);
    expect((await api().get('/api/v1/ppap-customer-rules').set(await as(ids.inspectorA)).expect(200)).body).toMatchObject({ canChange: false });
    const made = await api().post('/api/v1/ppaps').set(await as(ids.ownerA)).send({ partId: ctx.part, customerId: ctx.customer2, reason: 'customer_request' }).expect(201);
    expect(made.body.level).toBe(2);
    expect(element(made.body, 'dfmea').requirement).toBe('required');
    expect(element(made.body, 'design_records').requirement).toBe('retain');
    expect(made.body.progress.required).toBe(6);
    ctx.ppap2 = made.body.id;
  });
});

describe('elements and evidence', () => {
  it('changes an element, adds a file, and says what is still needed', async () => {
    const h = await as(ids.ownerA);
    const detail = (await api().get(`/api/v1/ppaps/${ctx.ppap}`).set(h).expect(200)).body;
    const design = element(detail, 'design_records').id;
    ctx.design = design;
    await api().patch(`/api/v1/ppap-elements/${design}`).set(h).send({}).expect(400);
    await api().patch(`/api/v1/ppap-elements/${design}`).set(h).send({ status: 'waived' }).expect(400);
    const early = await api().patch(`/api/v1/ppap-elements/${design}`).set(h).send({ status: 'ready' }).expect(409);
    expect(early.body.error).toMatchObject({ code: 'ppap_rule', message: expect.stringMatching(/evidence/) });
    const wrongFolder = await api().post(`/api/v1/ppap-elements/${design}/files`).set(h).send({ storagePath: `${ids.orgA}/ppap/${ctx.ppap2}/a.pdf`, fileName: 'a.pdf', sizeBytes: 10 }).expect(409);
    expect(wrongFolder.body.error.code).toBe('ppap_rule');
    await api().post(`/api/v1/ppap-elements/${design}/files`).set(h).send({ storagePath: `${ids.orgA}/ppap/${ctx.ppap}/a.pdf`, fileName: 'a.pdf', sizeBytes: 99999999999 }).expect(400);
    const added = await api().post(`/api/v1/ppap-elements/${design}/files`).set(h)
      .send({ storagePath: `${ids.orgA}/ppap/${ctx.ppap}/aaaa-drawing.pdf`, fileName: 'drawing.pdf', contentType: 'application/pdf', sizeBytes: 1200, description: 'Customer drawing' }).expect(201);
    expect(added.body.status).toBe('in_preparation');
    expect(element(added.body, 'design_records')).toMatchObject({ status: 'in_progress', liveEvidence: 1 });
    expect(element(added.body, 'design_records').evidence[0]).toMatchObject({ fileName: 'drawing.pdf', kind: 'file', description: 'Customer drawing', removedAt: null });
    ctx.evidence = element(added.body, 'design_records').evidence[0].id;
    expect(added.body.problems[0]).toMatch(/^Design records: mark it ready/);
    const ready = await api().patch(`/api/v1/ppap-elements/${design}`).set(h).send({ status: 'ready', note: 'Rev B drawing' }).expect(200);
    expect(element(ready.body, 'design_records')).toMatchObject({ status: 'ready', note: 'Rev B drawing' });
    expect(ready.body.progress).toEqual({ required: 18, done: 1 });
    expect(ready.body.problems).toHaveLength(16);
  });

  it('removes evidence with a reason and keeps it', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/ppap-evidence/${ctx.evidence}/remove`).set(h).send({ reason: 'x' }).expect(400);
    const removed = await api().post(`/api/v1/ppap-evidence/${ctx.evidence}/remove`).set(h).send({ reason: 'Wrong drawing issue' }).expect(200);
    const design = element(removed.body, 'design_records');
    expect(design).toMatchObject({ status: 'in_progress', liveEvidence: 0 });
    expect(design.evidence[0]).toMatchObject({ removeReason: 'Wrong drawing issue' });
    expect(design.evidence[0].removedAt).not.toBeNull();
    const twice = await api().post(`/api/v1/ppap-evidence/${ctx.evidence}/remove`).set(h).send({ reason: 'Wrong drawing issue' }).expect(409);
    expect(twice.body.error.code).toBe('ppap_rule');
  });

  it('is waived by an approver, with a reason of substance', async () => {
    const preparer = await as(ids.ownerA);
    const qm = await as(QM);
    const eng = await as(ids.inspectorA);
    await api().post(`/api/v1/ppap-elements/${ctx.design}/waive`).set(eng).send({ reason: 'Customer holds the drawing' }).expect(403);
    await api().post(`/api/v1/ppap-elements/${ctx.design}/waive`).set(qm).send({ reason: 'short' }).expect(400);
    const waived = await api().post(`/api/v1/ppap-elements/${ctx.design}/waive`).set(qm).send({ reason: 'Customer confirmed they hold the drawing' }).expect(200);
    expect(element(waived.body, 'design_records')).toMatchObject({ status: 'waived', waiver: { reason: 'Customer confirmed they hold the drawing', by: { name: 'Quinn Manager' } } });
    expect(waived.body.progress.done).toBe(1);
    const locked = await api().patch(`/api/v1/ppap-elements/${ctx.design}`).set(preparer).send({ note: 'x' }).expect(409);
    expect(locked.body.error.code).toBe('ppap_rule');
    const off = await api().post(`/api/v1/ppap-elements/${ctx.design}/unwaive`).set(qm).expect(200);
    expect(element(off.body, 'design_records').status).toBe('not_started');
  });
});

describe('the level, ready, reopen and withdraw', () => {
  it('re-levels, marks ready only when nothing is needed, reopens and withdraws', async () => {
    const h = await as(ids.ownerA);
    await api().put(`/api/v1/ppaps/${ctx.ppap2}/level`).set(h).send({ level: 0 }).expect(400);
    const one = await api().put(`/api/v1/ppaps/${ctx.ppap2}/level`).set(h).send({ level: 1 }).expect(200);
    expect(one.body.level).toBe(1);
    expect(one.body.progress.required).toBe(2);
    expect(one.body.problems).toEqual(['Design FMEA: add evidence, or ask an approver to waive it']);
    const early = await api().post(`/api/v1/ppaps/${ctx.ppap2}/ready`).set(h).expect(409);
    expect(early.body.error).toMatchObject({ code: 'ppap_rule', message: expect.stringMatching(/Not ready yet: Design FMEA/) });
    const qm = await as(QM);
    const dfmea = element(one.body, 'dfmea').id;
    await api().post(`/api/v1/ppap-elements/${dfmea}/waive`).set(qm).send({ reason: 'No design responsibility for this part' }).expect(200);
    const ready = await api().post(`/api/v1/ppaps/${ctx.ppap2}/ready`).set(h).expect(200);
    expect(ready.body).toMatchObject({ status: 'ready', editable: false, canReopen: true, canWithdraw: true, canMarkReady: false });
    expect(ready.body.readyAt).not.toBeNull();
    const frozen = await api().patch(`/api/v1/ppaps/${ctx.ppap2}`).set(h).send({ notes: 'late change' }).expect(409);
    expect(frozen.body.error.code).toBe('ppap_rule');
    const reopened = await api().post(`/api/v1/ppaps/${ctx.ppap2}/reopen`).set(h).expect(200);
    expect(reopened.body).toMatchObject({ status: 'in_preparation', readyAt: null, editable: true });
    const changed = await api().patch(`/api/v1/ppaps/${ctx.ppap2}`).set(h).send({ notes: 'Reworded', reason: 'tooling' }).expect(200);
    expect(changed.body).toMatchObject({ notes: 'Reworded', reason: 'tooling' });
    await api().post(`/api/v1/ppaps/${ctx.ppap2}/withdraw`).set(h).send({ reason: 'x' }).expect(400);
    const withdrawn = await api().post(`/api/v1/ppaps/${ctx.ppap2}/withdraw`).set(h).send({ reason: 'Customer cancelled the programme' }).expect(200);
    expect(withdrawn.body).toMatchObject({ status: 'withdrawn', withdrawReason: 'Customer cancelled the programme', canWithdraw: false });
    await api().post(`/api/v1/ppaps/${ctx.ppap2}/reopen`).set(h).expect(409);
  });

  it('refuses a change based on an old version, and accepts one based on the current one', async () => {
    const h = await as(ids.ownerA);
    const before = (await api().get(`/api/v1/ppaps/${ctx.ppap}`).set(h).expect(200)).body.rowVersion;
    await api().patch(`/api/v1/ppaps/${ctx.ppap}`).set(h).send({ notes: 'Second note' }).expect(200);
    const clash = await api().patch(`/api/v1/ppaps/${ctx.ppap}`).set(h).send({ notes: 'Third note', rowVersion: before }).expect(409);
    expect(clash.body.error.code).toBe('edit_conflict');
    const current = (await api().get(`/api/v1/ppaps/${ctx.ppap}`).set(h).expect(200)).body.rowVersion;
    await api().patch(`/api/v1/ppaps/${ctx.ppap}`).set(h).send({ notes: 'Third note', rowVersion: current }).expect(200);
  });
});

describe('the register', () => {
  it('filters, searches, sorts and pages', async () => {
    const h = await as(ids.ownerA);
    const live = (await api().get('/api/v1/ppaps').set(h).expect(200)).body;
    expect(live).toMatchObject({ page: 1, pageSize: 50, total: 1 });
    expect(live.data[0]).toMatchObject({ id: ctx.ppap, reference: expect.stringMatching(/^PPAP-/), status: 'in_preparation', progress: { required: 18 } });
    const all = (await api().get('/api/v1/ppaps?status=all').set(h).expect(200)).body;
    expect(all.total).toBe(2);
    expect((await api().get('/api/v1/ppaps?status=withdrawn').set(h).expect(200)).body.data.map((r: any) => r.id)).toEqual([ctx.ppap2]);
    expect((await api().get('/api/v1/ppaps?status=all&level=1').set(h).expect(200)).body.data.map((r: any) => r.id)).toEqual([ctx.ppap2]);
    expect((await api().get('/api/v1/ppaps?status=all&q=beta').set(h).expect(200)).body.total).toBe(1);
    expect((await api().get('/api/v1/ppaps?status=all&q=bracket').set(h).expect(200)).body.total).toBe(2);
    expect((await api().get(`/api/v1/ppaps?status=all&customerId=${ctx.customer}`).set(h).expect(200)).body.total).toBe(1);
    expect((await api().get('/api/v1/ppaps?status=all&owner=me').set(h).expect(200)).body.total).toBe(2);
    expect((await api().get('/api/v1/ppaps?status=all&sort=customer&order=asc').set(h).expect(200)).body.data[0].customer.name).toBe('Acme Motors');
    expect((await api().get('/api/v1/ppaps?status=all&pageSize=1&page=2').set(h).expect(200)).body.data).toHaveLength(1);
    await api().get('/api/v1/ppaps?status=nonsense').set(h).expect(400);
    await api().get('/api/v1/ppaps?sort=colour').set(h).expect(400);
  });

  it('shows a reader only what has been sent', async () => {
    const eng = await as(ids.inspectorA);
    expect((await api().get('/api/v1/ppaps?status=all').set(eng).expect(200)).body.total).toBe(0);
    await api().get(`/api/v1/ppaps/${ctx.ppap}`).set(eng).expect(404);
    await admin.query(`alter table public.ppap_submissions disable trigger ppap_submissions_rules`);
    await admin.query(`update public.ppap_submissions set status = 'submitted', submitted_at = now() where id = $1`, [ctx.ppap]);
    await admin.query(`alter table public.ppap_submissions enable trigger ppap_submissions_rules`);
    const seen = await api().get(`/api/v1/ppaps/${ctx.ppap}`).set(eng).expect(200);
    expect(seen.body).toMatchObject({ status: 'submitted', canManage: false, canApprove: false, editable: false });
    await api().patch(`/api/v1/ppap-elements/${ctx.design}`).set(eng).send({ note: 'x' }).expect(403);
    await admin.query(`alter table public.ppap_submissions disable trigger ppap_submissions_rules`);
    await admin.query(`update public.ppap_submissions set status = 'in_preparation', submitted_at = null where id = $1`, [ctx.ppap]);
    await admin.query(`alter table public.ppap_submissions enable trigger ppap_submissions_rules`);
  });
});

describe('the requirements', () => {
  it('shows the current set and saves a new version for an approver', async () => {
    const eng = await as(ids.inspectorA);
    const current = (await api().get('/api/v1/ppap-requirements').set(eng).expect(200)).body;
    expect(current).toMatchObject({ canChange: false, current: { version: 1 }, versions: [{ version: 1, current: true }] });
    expect(Object.keys(current.current.config.rows)).toHaveLength(18);
    expect(current.current.config).toMatchObject({ minCpkInitial: 1.67, minCpkOngoing: 1.33, minReadings: 100, maxGrrPercent: 30, defaultLevel: 3 });
    const config = JSON.parse(JSON.stringify(current.current.config));
    await api().put('/api/v1/ppap-requirements').set(eng).send({ config, reason: 'Trying' }).expect(403);
    const qm = await as(QM);
    const same = await api().put('/api/v1/ppap-requirements').set(qm).send({ config, reason: 'No change at all' }).expect(409);
    expect(same.body.error.code).toBe('ppap_rule');
    await api().put('/api/v1/ppap-requirements').set(qm).send({ config: { ...config, defaultLevel: 9 }, reason: 'Bad level' }).expect(400);
    const incomplete = JSON.parse(JSON.stringify(config));
    delete incomplete.rows.dfmea;
    const missing = await api().put('/api/v1/ppap-requirements').set(qm).send({ config: incomplete, reason: 'Missing a row' }).expect(409);
    expect(missing.body.error.message).toMatch(/Design FMEA/);
    config.defaultLevel = 4;
    config.rows.master_sample['3'] = 'retain';
    const saved = await api().put('/api/v1/ppap-requirements').set(qm).send({ config, reason: 'Customers want the master sample kept, not sent' }).expect(200);
    expect(saved.body).toMatchObject({ current: { version: 2, reason: 'Customers want the master sample kept, not sent' }, canChange: true });
    expect(saved.body.versions.map((v: any) => [v.version, v.current])).toEqual([[2, true], [1, false]]);
    expect(saved.body.versions[0].by).toMatchObject({ name: 'Quinn Manager' });
    const part2 = (await admin.query(`insert into public.parts (organisation_id, part_number, name) values ($1, 'PP-P2', 'Housing') returning id`, [ids.orgA])).rows[0].id;
    const rev2 = (await admin.query(`insert into public.part_revisions (organisation_id, part_id, revision) values ($1, $2, 'A') returning id`, [ids.orgA, part2])).rows[0].id;
    await admin.query(`update public.part_revisions set status = 'released' where id = $1`, [rev2]);
    const made = await api().post('/api/v1/ppaps').set(await as(ids.ownerA)).send({ partId: part2, customerId: ctx.customer, reason: 'new_part' }).expect(201);
    expect(made.body).toMatchObject({ level: 4, requirementSet: { version: 2 } });
    expect(element(made.body, 'customer_specific_requirements').requirement).toBe('required');
    expect(element(made.body, 'master_sample').requirement).toBe('not_required');
    const older = (await api().get(`/api/v1/ppaps/${ctx.ppap}`).set(await as(ids.ownerA)).expect(200)).body;
    expect(older.requirementSet.version).toBe(1);
  });
});

describe('tenancy', () => {
  it('keeps organisations apart', async () => {
    const b = await as(ids.ownerB, ids.orgB);
    expect((await api().get('/api/v1/ppaps?status=all').set(b).expect(200)).body.total).toBe(0);
    await api().get(`/api/v1/ppaps/${ctx.ppap}`).set(b).expect(404);
    await api().get(`/api/v1/ppaps/${ctx.ppap}`).set(await as(ids.ownerB, ids.orgA)).expect(404);
    await api().patch(`/api/v1/ppap-elements/${ctx.design}`).set(b).send({ note: 'Hijacked' }).expect(404);
    await api().post(`/api/v1/ppap-evidence/${ctx.evidence}/remove`).set(b).send({ reason: 'Hijacked' }).expect(404);
    expect((await api().get('/api/v1/ppap-requirements').set(b).expect(200)).body.current.version).toBe(1);
    await api().get('/api/v1/ppaps').set({ 'X-Organisation-Id': ids.orgA }).expect(401);
  });
});
