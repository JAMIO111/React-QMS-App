/**
 * PPAP (PP2) through the API: evidence that is a link to a record Fortress already holds. Which records can be linked to which element, the list of candidates (read as the caller,
 * scoped to the submission's part, searchable), adding a link (kind, organisation, part, once), the live state of a link and the lines it adds to "still needed", and the two
 * studies judged against the agreed minimums (a process capability study; the customer's own minimum wins). The rules are in supabase/tests/ppap_evidence_links.test.sql and
 * src/ppap/ppap-links.spec.ts; this checks the routes, the words, and the permissions.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';
import { ELEMENT_LINK_KINDS } from '../src/ppap/ppap-links';

const ids = makeIds('e9e');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};
const NOREAD = 'e9e00000-0000-0000-0000-0000000000e2';
/* eslint-disable @typescript-eslint/no-explicit-any */
const element = (body: any, key: string) => body.elements.find((e: any) => e.key === key);
const OD = [0, 0.004, -0.004, 0.002, -0.002, 0.005, -0.005, 0.003, -0.003, 0.004, -0.004, 0.045, 0.06].map((d) => (25 + d).toFixed(3));

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-pl');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA);

  // A part in a family with a control plan in force, a released revision and one inspection with thirteen readings of the outer diameter.
  const fam = (await api().post('/api/v1/part-families').set(h).send({ code: 'PLF', name: 'PLF' }).expect(201)).body;
  const plan = (await api().post('/api/v1/control-plans').set(h).send({ planCode: 'CP-PL', title: 'CP-PL', partFamilyId: fam.id }).expect(201)).body;
  const planRev = plan.revisions[0].id;
  const op = (await api().post(`/api/v1/control-plan-revisions/${planRev}/operations`).set(h).send({ operationCode: 'OP-020', name: 'Turning' }).expect(201)).body.operations[0].id;
  await api().post(`/api/v1/control-plan-revisions/${planRev}/characteristics`).set(h).send({
    operationId: op, characteristicKey: 'OD', name: 'Outer diameter', nominal: 25, lowerLimit: 24.95, upperLimit: 25.05, unitCode: 'mm', criticality: 'major',
    spcEligible: true, chartType: 'imr', subgroupSize: 1, sampling: [{ triggerType: 'first_off', sampleSize: 13 }],
  }).expect(201);
  await api().patch(`/api/v1/control-plan-revisions/${planRev}`).set(h).send({ changeReason: 'First' }).expect(200);
  await api().post(`/api/v1/control-plan-revisions/${planRev}/transitions`).set(h).send({ action: 'submit' }).expect(200);
  const part = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'PL-100', name: 'Rod 100', partFamilyId: fam.id, initialRevision: { revision: 'A' } }).expect(201)).body;
  ctx.part = part.id;
  ctx.rev = part.revisions[0].id;
  await api().post(`/api/v1/part-revisions/${ctx.rev}/release`).set(h).expect(200);
  await api().post(`/api/v1/control-plan-revisions/${planRev}/transitions`).set(h).send({ action: 'approve' }).expect(200);
  ctx.planRev = planRev;
  const other = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'PL-200', name: 'Other part', initialRevision: { revision: 'A' } }).expect(201)).body;
  ctx.otherPart = other.id;
  ctx.otherRev = other.revisions[0].id;
  await api().post(`/api/v1/part-revisions/${ctx.otherRev}/release`).set(h).expect(200);
  const rec = (await api().post('/api/v1/inspections').set(h).send({ siteId: ids.siteA, partId: ctx.part, lot: 'LOT-1', triggerType: 'first_off' }).expect(201)).body;
  ctx.inspection = rec.id;
  for (const v of OD) await api().post(`/api/v1/inspections/${rec.id}/samples`).set(h).send({ readings: [{ requirementId: rec.requirements[0].id, valueNumeric: v }] }).expect(201);
  ctx.char = (await admin.query(`select c.id from public.control_plan_characteristics c where c.control_plan_revision_id = $1 and c.characteristic_key = 'OD'`, [planRev])).rows[0].id;

  ctx.customer = (await admin.query(`insert into public.customers (organisation_id, code, name) values ($1, 'PL-C1', 'Acme Motors') returning id`, [ids.orgA])).rows[0].id;
  ctx.gauge = (await admin.query(`insert into public.gauges (organisation_id, asset_number, description) values ($1, 'PL-G1', 'Micrometer 0-25') returning id`, [ids.orgA])).rows[0].id;
  ctx.gaugeB = (await admin.query(`insert into public.gauges (organisation_id, asset_number, description) values ($1, 'PL-G2', 'Bore gauge') returning id`, [ids.orgB])).rows[0].id;
  ctx.ppap = (await api().post('/api/v1/ppaps').set(h).send({ partId: ctx.part, customerId: ctx.customer, reason: 'new_part' }).expect(201)).body.id;
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

const detail = async (user = ids.ownerA) => (await api().get(`/api/v1/ppaps/${ctx.ppap}`).set(await as(user)).expect(200)).body;
const elementId = async (key: string) => element(await detail(), key).id as string;

describe('which records can be linked to which element', () => {
  it('is the same in the API and the database', async () => {
    const rows = (await admin.query(`select t.key, app.ppap_link_kinds(t.key) as kinds from app.ppap_element_types() t`)).rows;
    expect(Object.fromEntries(rows.map((r) => [r.key, r.kinds]))).toEqual(Object.fromEntries(Object.entries(ELEMENT_LINK_KINDS).map(([k, v]) => [k, [...v]])));
  });
});

describe('candidates', () => {
  it('lists the records of one kind that fit, each with its own state', async () => {
    const h = await as(ids.ownerA);
    const design = await elementId('design_records');
    const list = (await api().get(`/api/v1/ppap-candidates?elementId=${design}&kind=part_revision`).set(h).expect(200)).body;
    expect(list.kind).toBe('part_revision');
    expect(list.data).toEqual([{ id: ctx.rev, label: 'PL-100 rev A', status: 'released', ok: true, problem: null, linked: false }]);
    const gauges = (await api().get(`/api/v1/ppap-candidates?elementId=${await elementId('checking_aids')}&kind=gauge&q=micro`).set(h).expect(200)).body;
    expect(gauges.data).toMatchObject([{ id: ctx.gauge, label: 'PL-G1 — Micrometer 0-25', ok: true }]);
    const chars = (await api().get(`/api/v1/ppap-candidates?elementId=${await elementId('initial_process_studies')}&kind=plan_characteristic`).set(h).expect(200)).body;
    expect(chars.data).toMatchObject([{ id: ctx.char, ok: true, status: 'effective' }]);
    const plans = (await api().get(`/api/v1/ppap-candidates?elementId=${await elementId('control_plan')}&kind=control_plan_revision`).set(h).expect(200)).body;
    expect(plans.data).toMatchObject([{ id: ctx.planRev, label: 'CP-PL rev A', status: 'effective', ok: true }]);
    const inspections = (await api().get(`/api/v1/ppap-candidates?elementId=${await elementId('dimensional_results')}&kind=inspection`).set(h).expect(200)).body;
    expect(inspections.data).toMatchObject([{ id: ctx.inspection, ok: false, problem: 'is not finished' }]);
  });

  it('never offers another organisation\'s record, and treats a search as plain text', async () => {
    const h = await as(ids.ownerA);
    const e = await elementId('checking_aids');
    expect((await api().get(`/api/v1/ppap-candidates?elementId=${e}&kind=gauge&q=bore`).set(h).expect(200)).body.data).toEqual([]);
    expect((await api().get(`/api/v1/ppap-candidates?elementId=${e}&kind=gauge&q=%25`).set(h).expect(200)).body.data).toEqual([]);
  });

  it('asks for a kind that is evidence for the element, and for a preparer', async () => {
    const h = await as(ids.ownerA);
    const design = await elementId('design_records');
    await api().get(`/api/v1/ppap-candidates?elementId=${design}`).set(h).expect(400);
    await api().get(`/api/v1/ppap-candidates?elementId=${design}&kind=something`).set(h).expect(400);
    const wrong = await api().get(`/api/v1/ppap-candidates?elementId=${design}&kind=gauge`).set(h).expect(409);
    expect(wrong.body.error.code).toBe('ppap_rule');
    await api().get(`/api/v1/ppap-candidates?elementId=${design}&kind=part_revision`).set(await as(ids.inspectorA)).expect(403);
    await api().get(`/api/v1/ppap-candidates?elementId=${design}&kind=part_revision`).set(await as(ids.ownerB, ids.orgB)).expect(404);
  });
});

describe('adding a link', () => {
  it('records the link and shows what the record is now', async () => {
    const h = await as(ids.ownerA);
    const design = await elementId('design_records');
    const made = await api().post(`/api/v1/ppap-elements/${design}/links`).set(h).send({ kind: 'part_revision', targetId: ctx.rev, description: 'The released drawing' }).expect(201);
    const e = element(made.body, 'design_records');
    expect(e.status).toBe('in_progress');
    expect(e.evidence).toHaveLength(1);
    expect(e.evidence[0]).toMatchObject({
      kind: 'link', fileName: null, storagePath: null, sizeBytes: null, description: 'The released drawing',
      link: { targetKind: 'part_revision', targetId: ctx.rev, frozenAt: null, state: { available: true, label: 'PL-100 rev A', status: 'released', ok: true, frozen: false }, study: null },
    });
    expect(e.liveEvidence).toBe(1);
    const check = await api().post(`/api/v1/ppap-elements/${await elementId('checking_aids')}/links`).set(h).send({ kind: 'gauge', targetId: ctx.gauge }).expect(201);
    expect(element(check.body, 'checking_aids').evidence[0].link.state).toMatchObject({ label: 'PL-G1 — Micrometer 0-25', ok: true });
    expect((await api().get(`/api/v1/ppap-candidates?elementId=${design}&kind=part_revision`).set(h).expect(200)).body.data[0].linked).toBe(true);
  });

  it('refuses what does not fit, in words', async () => {
    const h = await as(ids.ownerA);
    const design = await elementId('design_records');
    const post = (body: unknown, e = design) => api().post(`/api/v1/ppap-elements/${e}/links`).set(h).send(body as object);
    await post({ kind: 'part_revision' }).expect(400);
    await post({ kind: 'nothing', targetId: ctx.rev }).expect(400);
    await post({ kind: 'part_revision', targetId: ctx.rev, colour: 'red' }).expect(400);
    expect((await post({ kind: 'part_revision', targetId: ctx.rev }).expect(409)).body.error.message).toMatch(/already linked/);
    expect((await post({ kind: 'part_revision', targetId: ctx.otherRev }).expect(409)).body.error.message).toMatch(/another part/);
    expect((await post({ kind: 'gauge', targetId: ctx.gauge }).expect(409)).body.error.message).toMatch(/not evidence for/);
    expect((await post({ kind: 'gauge', targetId: ctx.gaugeB }, await elementId('checking_aids')).expect(409)).body.error.message).toMatch(/not found in this organisation/);
    await api().post(`/api/v1/ppap-elements/${design}/links`).set(await as(ids.inspectorA)).send({ kind: 'part_revision', targetId: ctx.rev }).expect(403);
    await api().post(`/api/v1/ppap-elements/${design}/links`).set(await as(ids.ownerB, ids.orgB)).send({ kind: 'part_revision', targetId: ctx.rev }).expect(404);
  });

  it('removes a link with a reason and keeps it', async () => {
    const h = await as(ids.ownerA);
    const e = await elementId('master_sample');
    const doc = (await admin.query(`select id from public.document_types where organisation_id = $1 order by created_at limit 1`, [ids.orgA])).rows[0].id;
    const created = (await api().post('/api/v1/documents').set(h).send({ typeId: doc, title: 'Master sample note', contentKind: 'text' }).expect(201)).body;
    const revisionId = (await admin.query(`select id from public.document_revisions where document_id = $1`, [created.id])).rows[0].id;
    const made = await api().post(`/api/v1/ppap-elements/${e}/links`).set(h).send({ kind: 'document_revision', targetId: revisionId }).expect(201);
    const link = element(made.body, 'master_sample').evidence[0];
    expect(link.link.state).toMatchObject({ ok: false, problem: expect.stringMatching(/not in force/) });
    const gone = await api().post(`/api/v1/ppap-evidence/${link.id}/remove`).set(h).send({ reason: 'Wrong document' }).expect(200);
    expect(element(gone.body, 'master_sample').evidence[0]).toMatchObject({ removedAt: expect.any(String), removeReason: 'Wrong document' });
    expect(element(gone.body, 'master_sample').liveEvidence).toBe(0);
  });
});

describe('still needed', () => {
  it('names a linked record that is not in good standing', async () => {
    const h = await as(ids.ownerA);
    await admin.query(`update public.gauges set status = 'quarantined', status_reason = 'Dropped' where id = $1`, [ctx.gauge]);
    const d = await detail();
    expect(d.problems).toContain('Checking aids: PL-G1 — Micrometer 0-25 is quarantined');
    expect(element(d, 'checking_aids').evidence[0].link.state).toMatchObject({ ok: false, problem: 'is quarantined', status: 'quarantined' });
    await api().patch(`/api/v1/ppap-elements/${await elementId('checking_aids')}`).set(h).send({ status: 'ready' }).expect(200);
    const ready = await api().post(`/api/v1/ppaps/${ctx.ppap}/ready`).set(h).expect(409);
    expect(ready.body.error.code).toBe('ppap_rule');
    await admin.query(`update public.gauges set status = 'active', status_reason = null where id = $1`, [ctx.gauge]);
    expect((await detail()).problems).not.toContain('Checking aids: PL-G1 — Micrometer 0-25 is quarantined');
  });

  it('does not show a link the caller cannot read, as a pass', async () => {
    // A quality engineer prepares PPAPs; take away the right to read gauges and control plans, and those links show "not available" to them.
    await admin.query(`insert into auth.users (id, email) values ($1, 'noread@example.test') on conflict do nothing`, [NOREAD]);
    const m = await admin.query(`insert into public.organisation_users (organisation_id, user_id, status, joined_at) values ($1, $2, 'active', now()) returning id`, [ids.orgA, NOREAD]);
    await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = 'quality_engineer'`, [ids.orgA, m.rows[0].id]);
    await admin.query(`delete from public.role_permissions where permission_code in ('calibration.read', 'process_control.read') and role_id = (select id from public.roles where organisation_id = $1 and key = 'quality_engineer')`, [ids.orgA]);
    const d = await detail(NOREAD);
    const link = element(d, 'checking_aids').evidence[0].link;
    expect(link.state).toMatchObject({ available: false });
    expect(link.state.ok).toBeUndefined();
  });
});

describe('studies judged against the agreed minimums', () => {
  it('fails a process capability study that has too few readings, with the words', async () => {
    const h = await as(ids.ownerA);
    const e = await elementId('initial_process_studies');
    const made = await api().post(`/api/v1/ppap-elements/${e}/links`).set(h).send({ kind: 'plan_characteristic', targetId: ctx.char }).expect(201);
    const link = element(made.body, 'initial_process_studies').evidence[0].link;
    expect(link.state).toMatchObject({ available: true, ok: true });
    expect(link.study).toMatchObject({ ok: false, problem: 'has 13 readings, and the agreed minimum is 100' });
    expect(made.body.studyProblems).toEqual([expect.stringMatching(/^Initial process studies: OD — Outer diameter \(CP-PL rev A\) has 13 readings/)]);
    expect(made.body.problems).toEqual(expect.arrayContaining(made.body.studyProblems));
    expect(made.body.canMarkReady).toBe(false);
  });

  it('uses the customer\'s own minimums when they set them', async () => {
    const h = await as(ids.ownerA);
    await api().put(`/api/v1/ppap-customer-rules/${ctx.customer}`).set(h).send({ minReadings: 5, minCpkInitial: 5 }).expect(200);
    const strict = element(await detail(), 'initial_process_studies').evidence[0].link.study;
    expect(strict).toMatchObject({ ok: false });
    expect(strict.problem).toMatch(/^Ppk [0-9.]+ is below the agreed 5.00$/);
    await api().put(`/api/v1/ppap-customer-rules/${ctx.customer}`).set(h).send({ minReadings: 5, minCpkInitial: 0.1 }).expect(200);
    const fine = element(await detail(), 'initial_process_studies').evidence[0].link.study;
    expect(fine).toMatchObject({ ok: true, problem: null, text: expect.stringMatching(/^Ppk [0-9.]+ \(Cpk [0-9.]+\) over 13 readings; the agreed minimum is 0.10$/) });
    expect((await detail()).studyProblems).toEqual([]);
  });

  it('does not judge a study the caller may not see capability for', async () => {
    const d = await detail(NOREAD);
    expect(element(d, 'initial_process_studies').evidence[0].link.state).toMatchObject({ available: false });
    expect(element(d, 'initial_process_studies').evidence[0].link.study).toBeNull();
  });
});
