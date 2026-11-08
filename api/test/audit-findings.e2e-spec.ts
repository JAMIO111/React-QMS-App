/**
 * Audit findings through the API (Phase A): the organisation's classifications, creating a finding from an answer or on its own, the register, editing / withdrawing / closing /
 * reopening, promotion to a draft internal non-conformance (once; asking again returns the same one), evidence files, and the audit behind a non-conformance.
 * The rules themselves are in supabase/tests/audit_findings.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('b4');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};
const cls: Record<string, string> = {};
const day = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const create = async (body: object, h?: Record<string, string>, record = ctx.record) => api().post(`/api/v1/audit-records/${record}/findings`).set(h ?? (await as(ids.inspectorA))).send(body);
const upload = (path: string) => admin.query(`insert into storage.objects (bucket_id, name) values ('audit-files', $1)`, [path]);

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-fnd');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA);
  ctx.machine = (await api().post('/api/v1/machines').set(h).send({ code: 'CNC-1', name: 'Lathe', siteId: ids.siteA }).expect(201)).body.id;
  ctx.employee = (await admin.query(`insert into public."Employees" (organisation_id, first_name, surname) values ($1, 'Grace', 'Hopper') returning id`, [ids.orgA])).rows[0].id;
  ctx.employeeB = (await admin.query(`insert into public."Employees" (organisation_id, first_name, surname) values ($1, 'Other', 'Person') returning id`, [ids.orgB])).rows[0].id;
  ctx.audit = (
    await api()
      .post('/api/v1/audits')
      .set(h)
      .send({
        title: 'Cell audit',
        auditType: 'layered_process',
        frequency: { kind: 'on_demand' },
        passMark: 50,
        questions: [
          { question: 'Guard fitted?', answerType: 'pass_fail', critical: true },
          { question: 'Floor clear?', answerType: 'pass_fail' },
          { question: 'Notes tidy?', answerType: 'pass_fail' },
        ],
        targets: [{ kind: 'machine', machineId: ctx.machine }],
      })
      .expect(201)
  ).body.id;
  const inspector = await as(ids.inspectorA);
  ctx.record = (await api().post('/api/v1/audit-records').set(inspector).send({ auditId: ctx.audit, targets: [{ kind: 'machine', machineId: ctx.machine }] }).expect(201)).body.id;
  let rec = (await api().get(`/api/v1/audit-records/${ctx.record}`).set(inspector).expect(200)).body;
  const q = (n: number) => rec.questions.find((x: { sequence: number }) => x.sequence === n).id;
  await api().put(`/api/v1/audit-records/${ctx.record}/responses`).set(inspector).send({ questionId: q(1), answer: 'fail', note: 'Guard missing' }).expect(200);
  await api().put(`/api/v1/audit-records/${ctx.record}/responses`).set(inspector).send({ questionId: q(2), answer: 'fail', note: 'Swarf on the floor' }).expect(200);
  await api().put(`/api/v1/audit-records/${ctx.record}/responses`).set(inspector).send({ questionId: q(3), answer: 'pass' }).expect(200);
  rec = (await api().get(`/api/v1/audit-records/${ctx.record}`).set(inspector).expect(200)).body;
  const resp = (n: number) => rec.questions.find((x: { sequence: number }) => x.sequence === n).response.id;
  ctx.resp1 = resp(1);
  ctx.resp2 = resp(2);
  ctx.resp3 = resp(3);
  for (const c of (await api().get('/api/v1/audit-finding-classifications').set(inspector).expect(200)).body.data) cls[c.key] = c.id;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('classifications', () => {
  it('start with the four standard ones, readable by anyone who may read audits', async () => {
    const res = await api().get('/api/v1/audit-finding-classifications').set(await as(ids.dual)).expect(200);
    expect(res.body.data.map((c: { key: string; kind: string; defaultSeverity: string | null }) => `${c.key}:${c.kind}:${c.defaultSeverity ?? '-'}`)).toEqual([
      'major_nc:nonconformity:major',
      'minor_nc:nonconformity:minor',
      'observation:observation:-',
      'ofi:opportunity:-',
    ]);
    expect(res.body.data[0]).toMatchObject({ label: 'Major non-conformity', sequence: 1, active: true, findingCount: 0 });
    expect((await api().get('/api/v1/audit-finding-classifications').set(await as(ids.ownerB, ids.orgB)).expect(200)).body.data).toHaveLength(4);
  });

  it('are added, renamed, reordered and switched off by someone who manages audits; the key and kind never change', async () => {
    const owner = await as(ids.ownerA);
    const body = { key: 'critical_nc', label: 'Critical non-conformity', kind: 'nonconformity', defaultSeverity: 'critical' };
    expect((await api().post('/api/v1/audit-finding-classifications').set(await as(ids.inspectorA)).send(body)).status).toBe(403);
    expect((await api().post('/api/v1/audit-finding-classifications').set(owner).send({ ...body, key: 'Bad Key' })).status).toBe(400);
    const bad = await api().post('/api/v1/audit-finding-classifications').set(owner).send({ ...body, key: 'obs_two', kind: 'observation' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_severity');
    const made = await api().post('/api/v1/audit-finding-classifications').set(owner).send(body);
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ key: 'critical_nc', kind: 'nonconformity', defaultSeverity: 'critical', sequence: 5, active: true });
    expect((await api().post('/api/v1/audit-finding-classifications').set(owner).send(body)).status).toBe(409);
    const patch = (b: object, h = owner) => api().patch(`/api/v1/audit-finding-classifications/${made.body.id}`).set(h).send(b);
    expect((await patch({ kind: 'observation' })).status).toBe(400);
    expect((await patch({ key: 'renamed' })).status).toBe(400);
    expect((await patch({ label: 'x' }, await as(ids.inspectorA))).status).toBe(403);
    expect((await patch({ label: 'Critical NC', sequence: 0 })).body).toMatchObject({ label: 'Critical NC', sequence: 0 });
    expect((await patch({ active: false })).body.active).toBe(false);
    const obs = await api().patch(`/api/v1/audit-finding-classifications/${cls.observation}`).set(owner).send({ defaultSeverity: 'minor' });
    expect(obs.status).toBe(400);
    expect(obs.body.error.code).toBe('invalid_severity');
    // Switched-off ones are left out of the list unless asked for, and cannot be used.
    expect((await api().get('/api/v1/audit-finding-classifications').set(owner).expect(200)).body.data.map((c: { key: string }) => c.key)).not.toContain('critical_nc');
    expect((await api().get('/api/v1/audit-finding-classifications?all=true').set(owner).expect(200)).body.data.map((c: { key: string }) => c.key)).toContain('critical_nc');
    const off = await create({ responseId: ctx.resp3, classificationId: made.body.id, title: 'x', description: 'y' });
    expect(off.status).toBe(409);
    expect(off.body.error.message).toContain('switched off');
  });
});

describe('creating findings', () => {
  it('turns an answer into a finding, with an owner and a due date', async () => {
    const body = { responseId: ctx.resp1, classificationId: cls.major_nc, title: 'Guard missing', description: 'The guard was not fitted on the lathe', requirement: 'Guards are fitted at all times', ownerId: ctx.employee, dueOn: day(14) };
    expect((await create(body, await as(ids.dual))).status).toBe(403);
    expect((await create(body, await as(ids.ownerB, ids.orgB))).status).toBe(404);
    expect((await create({ ...body, title: ' ' })).status).toBe(400);
    expect((await create({ ...body, extra: 1 })).status).toBe(400);
    expect((await create({ ...body, ownerId: ctx.employeeB })).status).toBe(409);
    expect((await create({ ...body, classificationId: ids.ownerA })).status).toBe(409);
    const res = await create(body);
    expect(res.status).toBe(201);
    ctx.f1 = res.body.id;
    expect(res.body).toMatchObject({
      reference: expect.stringMatching(/^AF-\d\d-0001$/),
      status: 'open',
      title: 'Guard missing',
      requirement: 'Guards are fitted at all times',
      classification: { key: 'major_nc', kind: 'nonconformity' },
      owner: { id: ctx.employee, name: 'Grace Hopper' },
      dueOn: day(14),
      overdue: false,
      ncr: null,
      fileCount: 0,
      record: { id: ctx.record, status: 'in_progress', audit: { title: 'Cell audit' } },
      answer: { id: ctx.resp1, sequence: 1, question: 'Guard fitted?' },
      createdBy: { name: expect.any(String) },
    });
    const again = await create(body);
    expect(again.status).toBe(409);
    expect(again.body.error.message).toContain('already has a finding');
  });

  it('can also be standalone, and shows on the record', async () => {
    const res = await create({ classificationId: cls.ofi, title: 'Better lighting', description: 'Lighting at the bench could be improved' });
    expect(res.status).toBe(201);
    ctx.f3 = res.body.id;
    expect(res.body.answer).toBeNull();
    const list = (await api().get(`/api/v1/audit-records/${ctx.record}/findings`).set(await as(ids.dual)).expect(200)).body.data;
    expect(list.map((f: { id: string }) => f.id)).toEqual([ctx.f1, ctx.f3]);
    expect((await api().get(`/api/v1/audit-records/${ids.ownerA}/findings`).set(await as(ids.dual))).status).toBe(404);
    expect((await api().get(`/api/v1/audit-records/${ctx.record}/findings`).set(await as(ids.ownerB, ids.orgB))).status).toBe(404);
  });
});

describe('the register', () => {
  const list = async (query = '', h?: Record<string, string>) => (await api().get(`/api/v1/audit-findings${query}`).set(h ?? (await as(ids.dual))).expect(200)).body;

  it('lists findings with filters, sorting and paging', async () => {
    ctx.f2 = (await create({ responseId: ctx.resp2, classificationId: cls.minor_nc, title: 'Swarf on the floor', description: 'Swarf around the lathe', dueOn: day(-3) })).body.id;
    // A second record with a finding that was withdrawn and one that was closed long past its due date.
    const inspector = await as(ids.inspectorA);
    ctx.record2 = (await api().post('/api/v1/audit-records').set(inspector).send({ auditId: ctx.audit }).expect(201)).body.id;
    ctx.fOther = (await create({ classificationId: cls.minor_nc, title: 'Other record finding', description: 'Found on another record' }, undefined, ctx.record2)).body.id;
    await api().post(`/api/v1/audit-findings/${ctx.fOther}/withdraw`).set(inspector).send({ reason: 'Raised in error' }).expect(200);
    ctx.fC = (await create({ classificationId: cls.observation, title: 'Closed old', description: 'Nothing else to say', dueOn: day(-5) }, undefined, ctx.record2)).body.id;
    await api().post(`/api/v1/audit-findings/${ctx.fC}/close`).set(await as(ids.ownerA)).send({ note: 'Sorted out' }).expect(200);
    const ids_ = (r: { data: { id: string }[] }) => r.data.map((f) => f.id).sort();
    const all = await list();
    expect(all).toMatchObject({ total: 5, page: 1, pageSize: 25 });
    expect(all.data.map((f: { reference: string }) => f.reference)).toEqual(expect.arrayContaining(['AF-' + day(0).slice(2, 4) + '-0003']));
    expect((await list('?kind=nonconformity')).total).toBe(3);
    expect(ids_(await list('?kind=opportunity,observation'))).toEqual([ctx.f3, ctx.fC].sort());
    expect(ids_(await list(`?classificationId=${cls.minor_nc}`))).toEqual([ctx.f2, ctx.fOther].sort());
    expect(ids_(await list(`?recordId=${ctx.record}`))).toEqual([ctx.f1, ctx.f2, ctx.f3].sort());
    expect(ids_(await list(`?recordId=${ctx.record2}`))).toEqual([ctx.fOther, ctx.fC].sort());
    expect((await list(`?auditId=${ctx.audit}`)).total).toBe(5);
    expect((await list(`?auditId=${ctx.record}`)).total).toBe(0);
    expect(ids_(await list('?status=withdrawn'))).toEqual([ctx.fOther]);
    expect(ids_(await list('?status=closed'))).toEqual([ctx.fC]);
    expect((await list('?status=open')).total).toBe(3);
    expect((await list('?status=open,closed')).total).toBe(4);
    expect((await list(`?ownerId=${ctx.employee}`)).data.map((f: { id: string }) => f.id)).toEqual([ctx.f1]);
    expect((await list('?q=swarf')).data.map((f: { id: string }) => f.id)).toEqual([ctx.f2]);
    // Only the title says "closed old": the search looks at titles as well as descriptions.
    expect((await list('?q=closed old')).data.map((f: { id: string }) => f.id)).toEqual([ctx.fC]);
    expect((await list('?q=zzz')).total).toBe(0);
    // Overdue means open and past due: the closed finding with an old due date is not overdue.
    const overdue = await list('?overdue=true');
    expect(overdue.data.map((f: { id: string }) => f.id)).toEqual([ctx.f2]);
    expect(overdue.data[0].overdue).toBe(true);
    expect((await list(`?from=${day(0)}&to=${day(0)}`)).total).toBe(5);
    expect((await list(`?from=${day(1)}`)).total).toBe(0);
    const sorted = await list('?sort=dueOn&order=asc&pageSize=2');
    expect(sorted.data.map((f: { id: string }) => f.id)).toEqual([ctx.fC, ctx.f2]);
    expect(sorted).toMatchObject({ page: 1, pageSize: 2, total: 5 });
    expect((await list('?sort=reference&order=asc')).data.map((f: { reference: string }) => f.reference)).toEqual([...(await list('?sort=reference&order=asc')).data.map((f: { reference: string }) => f.reference)].sort());
    expect((await api().get('/api/v1/audit-findings?sort=nonsense').set(await as(ids.dual))).status).toBe(400);
    expect((await api().get('/api/v1/audit-findings?status=bogus').set(await as(ids.dual))).status).toBe(400);
    expect((await list('', await as(ids.ownerB, ids.orgB))).total).toBe(0);
  });

  it('shows one finding, and nothing of another organisation', async () => {
    expect((await api().get(`/api/v1/audit-findings/${ctx.f1}`).set(await as(ids.dual)).expect(200)).body.reference).toMatch(/^AF-/);
    expect((await api().get(`/api/v1/audit-findings/${ctx.f1}`).set(await as(ids.ownerB, ids.orgB))).status).toBe(404);
    expect((await api().get(`/api/v1/audit-findings/${ids.ownerA}`).set(await as(ids.dual))).status).toBe(404);
  });
});

describe('editing, withdrawing, closing and reopening', () => {
  const act = async (id: string, action: string, body: object | undefined, h?: Record<string, string>) =>
    api().post(`/api/v1/audit-findings/${id}/${action}`).set(h ?? (await as(ids.inspectorA))).send(body);

  it('edits an open finding; a null clears owner, due date and requirement', async () => {
    const patch = async (b: object, h?: Record<string, string>) => api().patch(`/api/v1/audit-findings/${ctx.f2}`).set(h ?? (await as(ids.inspectorA))).send(b);
    expect((await patch({ title: 'x' }, await as(ids.dual))).status).toBe(403);
    expect((await patch({})).status).toBe(400);
    expect((await patch({ title: ' ' })).status).toBe(400);
    expect((await patch({ unknown: 1 })).status).toBe(400);
    const res = await patch({ title: 'Swarf under the lathe', ownerId: ctx.employee, requirement: '5S standard' });
    expect(res.body).toMatchObject({ title: 'Swarf under the lathe', owner: { name: 'Grace Hopper' }, requirement: '5S standard', dueOn: day(-3) });
    const cleared = await patch({ ownerId: null, dueOn: null, requirement: null });
    expect(cleared.body).toMatchObject({ owner: null, dueOn: null, requirement: null, overdue: false, title: 'Swarf under the lathe' });
    expect((await patch({ classificationId: cls.major_nc })).body.classification.key).toBe('major_nc');
    expect((await patch({ ownerId: ctx.employeeB })).status).toBe(409);
  });

  it('withdraws a finding raised in error, with a reason', async () => {
    expect((await act(ctx.f3, 'withdraw', { reason: 'x' })).status).toBe(400);
    expect((await act(ctx.f3, 'withdraw', { reason: 'Raised on the wrong record' }, await as(ids.dual))).status).toBe(403);
    const res = await act(ctx.f3, 'withdraw', { reason: 'Raised on the wrong record' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'withdrawn', withdrawReason: 'Raised on the wrong record' });
    expect((await api().patch(`/api/v1/audit-findings/${ctx.f3}`).set(await as(ids.inspectorA)).send({ title: 'Edit' })).status).toBe(409);
    expect((await api().get('/api/v1/audit-finding-classifications').set(await as(ids.ownerA)).expect(200)).body.data.find((c: { key: string }) => c.key === 'ofi').findingCount).toBe(0);
    // A withdrawn finding no longer sits on its answer, which can have another.
    const tidy = (await create({ responseId: ctx.resp3, classificationId: cls.observation, title: 'Tidy', description: 'Notes untidy' })).body.id;
    const onAnswer = async () => (await api().get(`/api/v1/audit-records/${ctx.record}`).set(await as(ids.inspectorA)).expect(200)).body.questions.find((q: { sequence: number }) => q.sequence === 3).response.finding;
    expect(await onAnswer()).toMatchObject({ id: tidy, status: 'open' });
    await act(tidy, 'withdraw', { reason: 'Raised in error' });
    expect(await onAnswer()).toBeNull();
  });

  it('closes with a note (audits.manage) and reopens with a reason', async () => {
    expect((await act(ctx.f2, 'close', { note: 'Cleaned and 5S board updated' })).status).toBe(403);
    expect((await act(ctx.f2, 'close', { note: ' ' }, await as(ids.ownerA))).status).toBe(400);
    const res = await act(ctx.f2, 'close', { note: 'Cleaned and 5S board updated' }, await as(ids.ownerA));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'closed', closedNote: 'Cleaned and 5S board updated', closedBy: { name: 'Ada Owner' }, closedAt: expect.any(String) });
    expect((await api().patch(`/api/v1/audit-findings/${ctx.f2}`).set(await as(ids.inspectorA)).send({ title: 'Edit' })).status).toBe(409);
    expect((await act(ctx.f2, 'reopen', { reason: 'Back again' })).status).toBe(403);
    expect((await act(ctx.f2, 'reopen', { reason: '' }, await as(ids.ownerA))).status).toBe(400);
    const back = await act(ctx.f2, 'reopen', { reason: 'Back again' }, await as(ids.ownerA));
    expect(back.body).toMatchObject({ status: 'open', reopenReason: 'Back again', closedNote: null });
    expect((await act(ctx.f2, 'reopen', { reason: 'Twice' }, await as(ids.ownerA))).status).toBe(409);
  });
});

describe('raising a non-conformance', () => {
  const raise = async (id: string, body: object | undefined, h?: Record<string, string>) => api().post(`/api/v1/audit-findings/${id}/create-ncr`).set(h ?? (await as(ids.inspectorA))).send(body);

  it('is refused to a reader, and for a finding that is not a non-conformity', async () => {
    expect((await raise(ctx.f1, {}, await as(ids.dual))).status).toBe(403);
    expect((await raise(ctx.f1, { severity: 'huge' })).status).toBe(400);
    expect((await raise(ctx.f1, { extra: 1 })).status).toBe(400);
    const obs = (await create({ classificationId: cls.observation, title: 'Noted', description: 'Only an observation' })).body.id;
    const res = await raise(obs, {});
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('non-conformity');
    ctx.obs = obs;
  });

  it('makes a draft internal NC, once: asking again returns the same one', async () => {
    const res = await raise(ctx.f1, {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: true, nonconformanceId: expect.any(String), finding: { id: ctx.f1, ncr: { id: res.body.nonconformanceId, stage: 'draft' } } });
    ctx.ncr = res.body.nonconformanceId;
    const ncr = (await api().get(`/api/v1/ncrs/${ctx.ncr}`).set(await as(ids.ownerA)).expect(200)).body;
    expect(ncr).toMatchObject({ stage: 'draft', source: 'internal_audit', title: 'Guard missing', severity: 'major', requirement: 'Guards are fitted at all times', actualResult: 'The guard was not fitted on the lathe' });
    expect(ncr.description).toContain('Raised from audit AR-');
    const again = await raise(ctx.f1, { title: 'A different title' });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false, nonconformanceId: ctx.ncr });
    const count = await admin.query(`select count(*)::int as n from public.nonconformances where organisation_id = $1 and title in ('Guard missing', 'A different title')`, [ids.orgA]);
    expect(count.rows[0].n).toBe(1);
    // A finding with a live NC can be neither withdrawn nor closed while that is open.
    expect((await api().post(`/api/v1/audit-findings/${ctx.f1}/withdraw`).set(await as(ids.inspectorA)).send({ reason: 'Raised in error' })).status).toBe(409);
    const closing = await api().post(`/api/v1/audit-findings/${ctx.f1}/close`).set(await as(ids.ownerA)).send({ note: 'Done' });
    expect(closing.status).toBe(409);
    expect(closing.body.error.message).toContain('Close the non-conformance');
  });

  it('can be given its own words and severity, and a deleted draft frees the finding', async () => {
    await admin.query(`update public.nonconformances set deleted_at = now(), delete_reason = 'Raised in error' where id = $1`, [ctx.ncr]);
    expect((await api().get(`/api/v1/audit-findings/${ctx.f1}`).set(await as(ids.inspectorA)).expect(200)).body.ncr).toBeNull();
    const res = await raise(ctx.f1, { title: 'Machine guard not fitted', description: 'Found in the cell audit', severity: 'critical' });
    expect(res.body.created).toBe(true);
    expect(res.body.nonconformanceId).not.toBe(ctx.ncr);
    const ncr = (await api().get(`/api/v1/ncrs/${res.body.nonconformanceId}`).set(await as(ids.ownerA)).expect(200)).body;
    expect(ncr).toMatchObject({ title: 'Machine guard not fitted', description: 'Found in the cell audit', severity: 'critical' });
    ctx.ncr2 = res.body.nonconformanceId;
  });

  it('does not show a cancelled non-conformance as the finding\'s, and frees the finding for another', async () => {
    const first = await raise(ctx.f2, {});
    expect(first.body.created).toBe(true);
    expect(first.body.finding.ncr).toMatchObject({ id: first.body.nonconformanceId });
    await admin.query(`update public.nonconformances set quantity_affected = 3, stage = 'open' where id = $1`, [first.body.nonconformanceId]);
    await admin.query(`update public.nonconformances set stage = 'cancelled', stage_reason = 'Duplicate' where id = $1`, [first.body.nonconformanceId]);
    expect((await api().get(`/api/v1/audit-findings/${ctx.f2}`).set(await as(ids.inspectorA)).expect(200)).body.ncr).toBeNull();
    expect((await api().get('/api/v1/audit-finding-classifications').set(await as(ids.ownerA)).expect(200)).body.data.find((c: { key: string }) => c.key === 'major_nc').findingCount).toBeGreaterThan(0);
  });

  it('shows the answer a finding came from, and a finding on the answer, on the record', async () => {
    const rec = (await api().get(`/api/v1/audit-records/${ctx.record}`).set(await as(ids.inspectorA)).expect(200)).body;
    const first = rec.questions.find((q: { sequence: number }) => q.sequence === 1).response;
    expect(first.finding).toMatchObject({ id: ctx.f1, status: 'open', kind: 'nonconformity', classification: 'Major non-conformity' });
    expect(first.ncrs).toEqual([{ id: ctx.ncr2, reference: expect.any(String), stage: 'draft' }]);
    expect(rec.questions.find((q: { sequence: number }) => q.sequence === 3).response.finding).toBeNull();
  });
});

describe('evidence files', () => {
  const folder = () => `${ids.orgA}/audit/${ctx.record}/findings/${ctx.f1}/`;
  const post = async (body: object, finding = ctx.f1, h?: Record<string, string>) => api().post(`/api/v1/audit-findings/${finding}/attachments`).set(h ?? (await as(ids.inspectorA))).send(body);

  it('are recorded once uploaded to the finding\'s own folder', async () => {
    const path = `${folder()}photo.jpg`;
    const body = { storagePath: path, fileName: 'photo.jpg', contentType: 'image/jpeg', sizeBytes: 1000 };
    expect((await post(body, ctx.f1, await as(ids.dual))).status).toBe(403);
    const notYet = await post(body);
    expect(notYet.status).toBe(400);
    expect(notYet.body.error.code).toBe('file_not_uploaded');
    // Objects that exist in storage but are not in this finding's own folder are refused by the API, not left to the database.
    const elsewhere = `${ids.orgA}/audit/${ctx.record}/photo.jpg`;
    const dots = `${folder()}../x.jpg`;
    await upload(elsewhere);
    await upload(dots);
    for (const storagePath of [elsewhere, dots, folder()]) {
      const refused = await post({ ...body, storagePath });
      expect([refused.status, refused.body.error.code]).toEqual([400, 'invalid_path']);
    }
    await upload(path);
    const added = await post(body);
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ findingId: ctx.f1, fileName: 'photo.jpg', sizeBytes: 1000, storagePath: path, deletedAt: null, createdBy: { name: expect.any(String) } });
    ctx.file = added.body.id;
    const list = (await api().get(`/api/v1/audit-findings/${ctx.f1}/attachments`).set(await as(ids.dual)).expect(200)).body.data;
    expect(list.map((f: { id: string }) => f.id)).toEqual([ctx.file]);
    expect((await api().get(`/api/v1/audit-findings/${ctx.f1}`).set(await as(ids.dual)).expect(200)).body.fileCount).toBe(1);
    expect((await api().get(`/api/v1/audit-findings/${ctx.f1}/attachments`).set(await as(ids.ownerB, ids.orgB))).status).toBe(404);
  });

  it('are removed with a reason and put back, never deleted', async () => {
    const del = (body: object, h: Record<string, string>) => api().post(`/api/v1/audit-finding-attachments/${ctx.file}/delete`).set(h).send(body);
    expect((await del({ reason: 'x' }, await as(ids.inspectorA))).status).toBe(400);
    expect((await del({ reason: 'Wrong photo' }, await as(ids.dual))).status).toBe(403);
    expect((await del({ reason: 'Wrong photo' }, await as(ids.inspectorA))).body).toMatchObject({ deleteReason: 'Wrong photo', deletedAt: expect.any(String) });
    expect((await api().get(`/api/v1/audit-findings/${ctx.f1}/attachments`).set(await as(ids.inspectorA)).expect(200)).body.data).toHaveLength(0);
    expect((await api().get(`/api/v1/audit-findings/${ctx.f1}/attachments?deleted=include`).set(await as(ids.inspectorA)).expect(200)).body.data).toHaveLength(1);
    expect((await api().get(`/api/v1/audit-findings/${ctx.f1}/attachments?deleted=only`).set(await as(ids.inspectorA)).expect(200)).body.data).toHaveLength(1);
    expect((await del({ reason: 'again again' }, await as(ids.inspectorA))).status).toBe(409);
    expect((await api().post(`/api/v1/audit-finding-attachments/${ctx.file}/restore`).set(await as(ids.ownerB, ids.orgB))).status).toBe(404);
    expect((await api().post(`/api/v1/audit-finding-attachments/${ctx.file}/restore`).set(await as(ids.inspectorA))).body.deletedAt).toBeNull();
    expect((await api().post(`/api/v1/audit-finding-attachments/${ctx.file}/restore`).set(await as(ids.inspectorA))).status).toBe(409);
    expect((await admin.query(`select count(*)::int as n from public.audit_finding_attachments where finding_id = $1`, [ctx.f1])).rows[0].n).toBe(1);
  });

  it('cannot be added to a closed finding', async () => {
    const closed = (await api().post(`/api/v1/audit-findings/${ctx.f2}/close`).set(await as(ids.ownerA)).send({ note: 'Fixed' })).body;
    expect(closed.status).toBe('closed');
    const path = `${ids.orgA}/audit/${ctx.record}/findings/${ctx.f2}/late.jpg`;
    await upload(path);
    expect((await post({ storagePath: path, fileName: 'late.jpg', sizeBytes: 1 }, ctx.f2)).status).toBe(409);
  });
});

describe('the audit behind a non-conformance', () => {
  it('shows the finding, the answer and the evidence to someone who may read audits', async () => {
    const res = await api().get(`/api/v1/ncrs/${ctx.ncr2}/audit-source`).set(await as(ids.dual)).expect(200);
    expect(res.body.available).toBe(true);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      record: { id: ctx.record, audit: { title: 'Cell audit' } },
      finding: { id: ctx.f1, title: 'Guard missing', status: 'open', classification: { label: 'Major non-conformity', kind: 'nonconformity' } },
      answers: [{ sequence: 1, question: 'Guard fitted?', result: 'fail', note: 'Guard missing' }],
      files: [{ fileName: 'photo.jpg', sizeBytes: 1000 }],
    });
  });

  it('also shows the earlier link of a deleted non-conformance, and nothing for an NC with no audit', async () => {
    const old = (await api().get(`/api/v1/ncrs/${ctx.ncr}/audit-source`).set(await as(ids.dual)).expect(200)).body;
    expect(old.items).toHaveLength(1);
    const plain = (await api().post('/api/v1/ncrs').set(await as(ids.ownerA)).send({ source: 'internal', title: 'Not from an audit' }).expect(201)).body;
    expect((await api().get(`/api/v1/ncrs/${plain.id}/audit-source`).set(await as(ids.dual)).expect(200)).body).toEqual({ available: true, items: [] });
    expect((await api().get(`/api/v1/ncrs/${ctx.ncr2}/audit-source`).set(await as(ids.ownerB, ids.orgB))).status).toBe(404);
    expect((await api().get(`/api/v1/ncrs/${ids.ownerA}/audit-source`).set(await as(ids.dual))).status).toBe(404);
  });

  it('is hidden, not empty, for someone who may read non-conformances but not audits', async () => {
    const role = (await admin.query(`select id from public.roles where organisation_id = $1 and key = 'viewer'`, [ids.orgA])).rows[0].id;
    await admin.query(`delete from public.role_permissions where role_id = $1 and permission_code = 'audits.read'`, [role]);
    try {
      expect((await api().get(`/api/v1/ncrs/${ctx.ncr2}/audit-source`).set(await as(ids.dual)).expect(200)).body).toEqual({ available: false, items: [] });
    } finally {
      await admin.query(`insert into public.role_permissions (role_id, permission_code) values ($1, 'audits.read') on conflict do nothing`, [role]);
    }
  });
});

describe('a completed record', () => {
  it('can still gain findings, and an abandoned one cannot', async () => {
    const inspector = await as(ids.inspectorA);
    expect((await api().post(`/api/v1/audit-records/${ctx.record}/complete`).set(inspector)).status).toBe(200);
    const late = await create({ responseId: ctx.resp3, classificationId: cls.observation, title: 'Late observation', description: 'Added at review' });
    expect(late.status).toBe(201);
    expect(late.body.record.status).toBe('completed');
    const other = (await api().post('/api/v1/audit-records').set(inspector).send({ auditId: ctx.audit })).body.id;
    await api().post(`/api/v1/audit-records/${other}/abandon`).set(inspector).send({ reason: 'Started by mistake' }).expect(200);
    const refused = await create({ classificationId: cls.ofi, title: 'x', description: 'y' }, inspector, other);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain('abandoned');
  });
});
