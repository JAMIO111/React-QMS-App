/**
 * Versioned audits through the API: every change to what an audit says is a new version with a reason, the history and the comparison of versions, and the version
 * a record was done against. The rules themselves are in supabase/tests/audit_versions.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a7');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};

const question = (over: object = {}) => ({ question: 'Is the cell clean?', answerType: 'pass_fail', critical: true, ...over });
const create = (over: object = {}) => ({
  title: 'Layered process audit',
  auditType: 'layered_process',
  procedure: 'Walk the cell.',
  frequency: { kind: 'weekly', firstDueOn: '2026-11-09' },
  passMark: 90,
  questions: [question(), { question: 'Coolant concentration', answerType: 'numeric', unit: '%', lowerLimit: 6, upperLimit: 9 }],
  targets: [{ kind: 'operation', operationCode: 'OP-10' }],
  ...over,
});
const history = async (h?: Record<string, string>) => (await api().get(`/api/v1/audits/${ctx.audit}/versions`).set(h ?? (await as(ids.ownerA))).expect(200)).body.data as {
  version: number; reason: string; current: boolean; summary: string[]; recordCount: number; title: string; passMark: number; questionCount: number; createdBy: { name: string } | null;
}[];
const edit = async (body: object, h?: Record<string, string>) => api().patch(`/api/v1/audits/${ctx.audit}`).set(h ?? (await as(ids.ownerA))).send(body);

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-ver');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('the first version', () => {
  it('is made when the audit is created, with no reason asked for', async () => {
    const res = await api().post('/api/v1/audits').set(await as(ids.ownerA)).send(create()).expect(201);
    ctx.audit = res.body.id;
    expect(res.body.version).toBe(1);
    const h = await history();
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ version: 1, reason: 'First version', current: true, summary: [], recordCount: 0, title: 'Layered process audit', passMark: 90, questionCount: 2, createdBy: { name: 'Ada Owner' } });
  });
});

describe('changing an audit', () => {
  it('needs a reason when what the audit says changes, and changes nothing without one', async () => {
    const refused = await edit({ title: 'Layered process audit, CNC', passMark: 95 });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'audit_rule', message: expect.stringContaining('Give a reason for the change') });
    const after = (await api().get(`/api/v1/audits/${ctx.audit}`).set(await as(ids.ownerA)).expect(200)).body;
    expect(after).toMatchObject({ title: 'Layered process audit', passMark: 90, version: 1 });
    expect(await history()).toHaveLength(1);
    // A reason that is too short, or only spaces, is not one.
    expect((await edit({ title: 'x', changeReason: 'ok' })).status).toBe(400);
    expect((await edit({ title: 'x', changeReason: '     ' })).status).toBe(400);
    expect((await edit({ changeReason: 'Only a reason' })).status).toBe(400);
  });

  it('makes the next version with the reason, who and when', async () => {
    const res = await edit({ title: 'Layered process audit, CNC', passMark: 95, changeReason: '  Raised the pass mark after the January audit ' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: 2, title: 'Layered process audit, CNC', passMark: 95 });
    const h = await history();
    expect(h.map((v) => v.version)).toEqual([2, 1]);
    expect(h[0]).toMatchObject({ reason: 'Raised the pass mark after the January audit', current: true, summary: ['Title changed', 'Pass mark 90 → 95'], createdBy: { name: 'Ada Owner' } });
    expect(h[1]).toMatchObject({ reason: 'First version', current: false, title: 'Layered process audit', passMark: 90 });
  });

  it('records a changed checklist and what the audit is relevant to', async () => {
    const res = await edit({
      questions: [question({ critical: false }), { question: 'Coolant concentration', answerType: 'numeric', unit: '%', lowerLimit: 6, upperLimit: 9.5 }, question({ question: 'Is the floor clear?', critical: false })],
      targets: [{ kind: 'operation', operationCode: 'OP-10' }, { kind: 'operation', operationCode: 'OP-20' }],
      changeReason: 'Added the floor, loosened the coolant limit and covered OP-20',
    });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(3);
    const h = await history();
    expect(h[0].summary).toEqual(['1 question added', '2 questions changed', 'Now relevant to OP-20']);
  });

  it('does not make a version for a change to the schedule or the expected auditor, and ignores a reason nobody needed', async () => {
    const res = await edit({ frequency: { kind: 'monthly', firstDueOn: '2026-12-01' }, graceDays: 3, auditor: { kind: 'person', userId: ids.inspectorA }, changeReason: 'Not needed for this' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: 3, graceDays: 3, frequency: { kind: 'monthly' }, auditor: { kind: 'person' } });
    expect(await history()).toHaveLength(3);
  });

  it('does not make a version when the content is the same as it was', async () => {
    const res = await edit({ title: 'Layered process audit, CNC', purpose: null, changeReason: 'Saved again, nothing different' });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(3);
    expect(await history()).toHaveLength(3);
  });

  it('is for people who manage audits, in their own organisation', async () => {
    expect((await edit({ title: 'Hijacked', changeReason: 'Hijacked' }, await as(ids.inspectorA))).status).toBe(403);
    expect((await edit({ title: 'Hijacked', changeReason: 'Hijacked' }, await as(ids.ownerB, ids.orgB))).status).toBe(404);
    expect((await history()).map((v) => v.version)).toEqual([3, 2, 1]);
  });
});

describe('the history', () => {
  it('shows one version whole, and what it changed from the one before', async () => {
    const h = await as(ids.ownerA);
    const v1 = (await api().get(`/api/v1/audits/${ctx.audit}/versions/1`).set(h).expect(200)).body;
    expect(v1).toMatchObject({ version: 1, changes: null, title: 'Layered process audit', auditType: 'layered_process', procedure: 'Walk the cell.', current: false });
    expect(v1.questions.map((q: { question: string }) => q.question)).toEqual(['Is the cell clean?', 'Coolant concentration']);
    expect(v1.targets).toEqual([{ kind: 'operation', label: 'OP-10' }]);
    const v3 = (await api().get(`/api/v1/audits/${ctx.audit}/versions/3`).set(h).expect(200)).body;
    expect(v3).toMatchObject({ version: 3, current: true, reason: 'Added the floor, loosened the coolant limit and covered OP-20' });
    expect(v3.changes.header).toEqual([]);
    expect(v3.changes.questions.added.map((q: { question: string }) => q.question)).toEqual(['Is the floor clear?']);
    expect(v3.changes.questions.changed.map((c: { after: { question: string }; fields: string[] }) => [c.after.question, c.fields])).toEqual([['Is the cell clean?', ['critical']], ['Coolant concentration', ['upperLimit']]]);
    expect(v3.changes.targets).toEqual({ added: [{ kind: 'operation', label: 'OP-20' }], removed: [] });
    const v2 = (await api().get(`/api/v1/audits/${ctx.audit}/versions/2`).set(h).expect(200)).body;
    expect(v2.changes.header).toEqual([{ field: 'title', before: 'Layered process audit', after: 'Layered process audit, CNC' }, { field: 'passMark', before: 90, after: 95 }]);
  });

  it('answers 404 for a version that does not exist and 400 for a number that is not one', async () => {
    const h = await as(ids.ownerA);
    expect((await api().get(`/api/v1/audits/${ctx.audit}/versions/9`).set(h)).status).toBe(404);
    expect((await api().get(`/api/v1/audits/${ctx.audit}/versions/0`).set(h)).status).toBe(400);
    expect((await api().get(`/api/v1/audits/${ctx.audit}/versions/abc`).set(h)).status).toBe(400);
    expect((await api().get(`/api/v1/audits/${ids.orgB}/versions`).set(h)).status).toBe(404);
  });

  it('can be read by anyone who may read audits, and by nobody outside the organisation', async () => {
    expect((await history(await as(ids.inspectorA))).length).toBe(3);
    expect((await api().get(`/api/v1/audits/${ctx.audit}/versions`).set(await as(ids.ownerB, ids.orgB))).status).toBe(404);
    expect((await api().get(`/api/v1/audits/${ctx.audit}/versions`).set(await as(ids.outsider))).status).toBe(404);
  });
});

describe('records', () => {
  it('are done against the current version, and keep it when the audit changes', async () => {
    const starter = await as(ids.inspectorA);
    const rec = (await api().post('/api/v1/audit-records').set(starter).send({ auditId: ctx.audit }).expect(201)).body;
    ctx.record = rec.id;
    expect(rec).toMatchObject({ version: 3, currentVersion: 3 });
    expect((await history()).find((v) => v.version === 3)!.recordCount).toBe(1);
    expect((await edit({ procedure: 'Walk the cell, then the aisle.', changeReason: 'Added the aisle to the walk' })).body.version).toBe(4);
    const again = (await api().get(`/api/v1/audit-records/${ctx.record}`).set(starter).expect(200)).body;
    expect(again).toMatchObject({ version: 3, currentVersion: 4, procedure: 'Walk the cell.' });
    const next = (await api().post('/api/v1/audit-records').set(starter).send({ auditId: ctx.audit }).expect(201)).body;
    ctx.record2 = next.id;
    expect(next).toMatchObject({ version: 4, currentVersion: 4 });
    const v3 = (await api().get(`/api/v1/audits/${ctx.audit}/versions/3`).set(await as(ids.ownerA)).expect(200)).body;
    expect(v3).toMatchObject({ recordCount: 1, current: false });
    expect(v3.records).toMatchObject([{ id: ctx.record, status: 'in_progress', result: null }]);
  });

  it('can be listed by the version they were done against', async () => {
    const h = await as(ids.ownerA);
    const v3 = (await api().get('/api/v1/audit-records?version=3').set(h).expect(200)).body;
    expect(v3.data.map((r: { id: string }) => r.id)).toEqual([ctx.record]);
    expect(v3.data[0]).toMatchObject({ version: 3, currentVersion: 4 });
    const v4 = (await api().get('/api/v1/audit-records?version=4').set(h).expect(200)).body;
    expect(v4.data.map((r: { id: string }) => r.id)).toEqual([ctx.record2]);
    expect((await api().get('/api/v1/audit-records?version=0').set(h)).status).toBe(400);
  });

  it('show the version of the audit in the register', async () => {
    const list = (await api().get('/api/v1/audits').set(await as(ids.ownerA)).expect(200)).body.data as { id: string; version: number | null }[];
    expect(list.find((a) => a.id === ctx.audit)!.version).toBe(4);
  });
});

describe('an audit made without versions', () => {
  it('has no history until it is started, then has version 1', async () => {
    const h = await as(ids.ownerA);
    const made = (await admin.query(
      `insert into public.audit_definitions (organisation_id, title, audit_type, frequency_kind) values ($1, 'Made by SQL', 'other', 'on_demand') returning id`, [ids.orgA])).rows[0].id as string;
    await admin.query(`insert into public.audit_questions (organisation_id, audit_definition_id, sequence, question, answer_type) values ($1, $2, 1, 'Is it there?', 'pass_fail')`, [ids.orgA, made]);
    const before = (await api().get(`/api/v1/audits/${made}`).set(h).expect(200)).body;
    expect(before.version).toBeNull();
    expect((await api().get(`/api/v1/audits/${made}/versions`).set(h).expect(200)).body.data).toEqual([]);
    const rec = (await api().post('/api/v1/audit-records').set(await as(ids.inspectorA)).send({ auditId: made }).expect(201)).body;
    expect(rec).toMatchObject({ version: 1, currentVersion: 1 });
    expect((await api().get(`/api/v1/audits/${made}/versions`).set(h).expect(200)).body.data).toMatchObject([{ version: 1, reason: 'First version', recordCount: 1 }]);
    // Its first change through the app now needs a reason, like any other.
    const refused = await api().patch(`/api/v1/audits/${made}`).set(h).send({ title: 'Renamed' });
    expect(refused.status).toBe(409);
    expect((await api().patch(`/api/v1/audits/${made}`).set(h).send({ title: 'Renamed', changeReason: 'A better name' }).expect(200)).body.version).toBe(2);
  });
});
