/**
 * Competence (CO3) through the API: training sessions with an attendee list, each attendee completed on their own day, files, and reading your own sessions.
 * The rules are in supabase/tests/competence_training.test.sql; this checks the routes, permissions, the shape of the answers and that errors reach the caller in words.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('c2');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const ctx: Record<string, string> = {};
const URL = '/api/v1/competence/training-sessions';

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-ct');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const q1 = async (text: string, params: unknown[]) => (await admin.query(text, params)).rows[0];
  ctx.xavier = (await q1(`insert into public."Employees" (organisation_id, first_name, surname) values ($1, 'Xavier', 'Xu') returning id`, [ids.orgA])).id;
  ctx.yara = (await q1(`insert into public."Employees" (organisation_id, first_name, surname) values ($1, 'Yara', 'Yu') returning id`, [ids.orgA])).id;
  ctx.trainer = (await q1(`insert into public."Employees" (organisation_id, first_name, surname) values ($1, 'Tina', 'Trainer') returning id`, [ids.orgA])).id;
  ctx.insp = (await q1(`insert into public."Employees" (organisation_id, first_name, surname, auth_id) values ($1, 'Ines', 'Inspector', $2) returning id`, [ids.orgA, ids.inspectorA])).id;
  ctx.category = (await q1(`select id from public.competence_categories where organisation_id = $1 and key = 'inspection'`, [ids.orgA])).id;
  ctx.skill = (await api().post('/api/v1/competence/skills').set(await as(ids.ownerA)).send({ code: 'CMM', name: 'CMM', categoryId: ctx.category }).expect(201)).body.id;
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('training sessions', () => {
  it('creates a session with its attendee list, supported skills and a trainer', async () => {
    const h = await as(ids.ownerA);
    const res = await api().post(URL).set(h).send({
      title: 'CMM basics', kind: 'course', providerType: 'internal', trainerEmployeeId: ctx.trainer, startsOn: day(-10), hours: 4,
      skillIds: [ctx.skill], employeeIds: [ctx.xavier, ctx.yara, ctx.insp],
    }).expect(201);
    ctx.session = res.body.id;
    expect(res.body).toMatchObject({ title: 'CMM basics', status: 'open', providerType: 'internal', trainer: { id: ctx.trainer, name: 'Tina Trainer' }, hours: 4, attendeeCount: 3, enrolledCount: 3 });
    expect(res.body.reference).toMatch(/^TS-\d{2}-0001$/);
    expect(res.body.skills).toEqual([{ id: ctx.skill, code: 'CMM', name: 'CMM' }]);
    expect(res.body.attendees.map((a: { employee: { name: string }; status: string }) => [a.employee.name, a.status])).toEqual([['Ines Inspector', 'enrolled'], ['Xavier Xu', 'enrolled'], ['Yara Yu', 'enrolled']]);
    ctx.aX = res.body.attendees.find((a: { employee: { id: string } }) => a.employee.id === ctx.xavier).id;
    ctx.aY = res.body.attendees.find((a: { employee: { id: string } }) => a.employee.id === ctx.yara).id;
    ctx.aI = res.body.attendees.find((a: { employee: { id: string } }) => a.employee.id === ctx.insp).id;
  });

  it('refuses bad input in words', async () => {
    const h = await as(ids.ownerA);
    const noTrainer = await api().post(URL).set(h).send({ title: 'X', kind: 'course', providerType: 'internal', startsOn: day(-1) }).expect(409);
    expect(noTrainer.body.error.code).toBe('competence_rule');
    expect(noTrainer.body.error.message).toMatch(/who runs it/);
    const noName = await api().post(URL).set(h).send({ title: 'X', kind: 'course', providerType: 'external', startsOn: day(-1) }).expect(409);
    expect(noName.body.error.message).toMatch(/outside provider/);
    await api().post(URL).set(h).send({ title: 'X', kind: 'party', providerType: 'external', providerName: 'A', startsOn: day(-1) }).expect(400);
    await api().post(URL).set(h).send({ title: 'X', kind: 'course', providerType: 'external', providerName: 'A', startsOn: 'soon' }).expect(400);
    await api().post(URL).set(h).send({ title: 'X', kind: 'course', providerType: 'external', providerName: 'A', startsOn: day(-1), oops: 1 }).expect(400);
    await api().patch(`${URL}/${ctx.session}`).set(h).send({}).expect(400);
  });

  it('records several people on one day and others on another, then freezes them', async () => {
    const h = await as(ids.ownerA);
    const first = await api().post(`${URL}/${ctx.session}/record`).set(h).send({ attendeeIds: [ctx.aX, ctx.aY], outcome: 'completed', completedOn: day(-8), note: 'Passed' }).expect(200);
    expect(first.body.completedCount).toBe(2);
    const second = await api().post(`${URL}/${ctx.session}/record`).set(h).send({ attendeeIds: [ctx.aI], outcome: 'completed', completedOn: day(-2) }).expect(200);
    expect(second.body.attendees.map((a: { completedOn: string }) => a.completedOn).sort()).toEqual([day(-8), day(-8), day(-2)].sort());
    const again = await api().post(`${URL}/${ctx.session}/record`).set(h).send({ attendeeIds: [ctx.aX], outcome: 'completed', completedOn: day(-1) }).expect(409);
    expect(again.body.error.message).toMatch(/still be enrolled/);
    await api().post(`${URL}/${ctx.session}/record`).set(h).send({ attendeeIds: [ctx.aX], outcome: 'passed', completedOn: day(-1) }).expect(400);
    const future = await api().post(`${URL}/${ctx.session}/record`).set(h).send({ attendeeIds: [ctx.aX], outcome: 'completed', completedOn: day(3) }).expect(409);
    expect(future.body.error.message).toBeDefined();
  });

  it('corrects by voiding and adding the person again; removes with a reason', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/competence/session-attendees/${ctx.aX}/void`).set(h).send({ reason: 'x' }).expect(400);
    const voided = await api().post(`/api/v1/competence/session-attendees/${ctx.aX}/void`).set(h).send({ reason: 'Wrong person ticked' }).expect(200);
    expect(voided.body.attendees.find((a: { id: string }) => a.id === ctx.aX)).toMatchObject({ status: 'voided', reason: 'Wrong person ticked' });
    const added = await api().post(`${URL}/${ctx.session}/attendees`).set(h).send({ employeeId: ctx.xavier }).expect(201);
    ctx.aX2 = added.body.attendees.find((a: { employee: { id: string }; status: string }) => a.employee.id === ctx.xavier && a.status === 'enrolled').id;
    const twice = await api().post(`${URL}/${ctx.session}/attendees`).set(h).send({ employeeId: ctx.xavier }).expect(409);
    expect(twice.body.error.message).toMatch(/already on this session/);
    const removed = await api().post(`/api/v1/competence/session-attendees/${ctx.aX2}/remove`).set(h).send({ reason: 'Not needed after all' }).expect(200);
    expect(removed.body.attendees.find((a: { id: string }) => a.id === ctx.aX2).status).toBe('removed');
    expect(removed.body.attendeeCount).toBe(2);
  });

  it('files on the session and on an attendee; removed with a reason, never deleted', async () => {
    const h = await as(ids.ownerA);
    const org = ids.orgA;
    const onSession = await api().post(`${URL}/${ctx.session}/attachments`).set(h)
      .send({ storagePath: `${org}/competence/session/${ctx.session}/sheet.pdf`, fileName: 'sheet.pdf', contentType: 'application/pdf', sizeBytes: 10 }).expect(201);
    expect(onSession.body.files).toHaveLength(1);
    const onAttendee = await api().post(`${URL}/${ctx.session}/attachments`).set(h)
      .send({ attendeeId: ctx.aI, storagePath: `${org}/competence/attendee/${ctx.aI}/cert.pdf`, fileName: 'cert.pdf', sizeBytes: 10, description: 'Certificate' }).expect(201);
    expect(onAttendee.body.attendees.find((a: { id: string }) => a.id === ctx.aI).files).toHaveLength(1);
    const wrong = await api().post(`${URL}/${ctx.session}/attachments`).set(h).send({ storagePath: `${org}/competence/session/other/x.pdf`, fileName: 'x.pdf', sizeBytes: 1 }).expect(409);
    expect(wrong.body.error.message).toMatch(/session's folder/);
    const fileId = onSession.body.files[0].id;
    const gone = await api().post(`/api/v1/competence/competence-attachments/${fileId}/delete`).set(h).send({ reason: 'Wrong sheet' }).expect(200);
    expect(gone.body.files[0]).toMatchObject({ deletedAt: expect.any(String), deleteReason: 'Wrong sheet' });
    const back = await api().post(`/api/v1/competence/competence-attachments/${fileId}/restore`).set(h).expect(200);
    expect(back.body.files[0].deletedAt).toBeNull();
  });

  it('closes only when nobody is enrolled, can be reopened, and a cancelled session takes nobody', async () => {
    const h = await as(ids.ownerA);
    const other = await api().post(URL).set(h).send({ title: 'Welding awareness', kind: 'external', providerType: 'external', providerName: 'Acme', startsOn: day(-3), employeeIds: [ctx.xavier] }).expect(201);
    expect(other.body.reference).toMatch(/-0002$/);
    const open = await api().post(`${URL}/${other.body.id}/close`).set(h).expect(409);
    expect(open.body.error.message).toMatch(/still enrolled/);
    await api().post(`${URL}/${other.body.id}/cancel`).set(h).send({ reason: 'Provider cancelled' }).expect(200);
    await api().post(`${URL}/${other.body.id}/attendees`).set(h).send({ employeeId: ctx.yara }).expect(409);

    const closed = await api().post(`${URL}/${ctx.session}/close`).set(h).expect(200);
    expect(closed.body.status).toBe('closed');
    await api().patch(`${URL}/${ctx.session}`).set(h).send({ title: 'Changed' }).expect(409);
    const reopened = await api().post(`${URL}/${ctx.session}/reopen`).set(h).send({ reason: 'Forgot one person' }).expect(200);
    expect(reopened.body).toMatchObject({ status: 'open', reopenReason: 'Forgot one person' });
    const edited = await api().patch(`${URL}/${ctx.session}`).set(h).send({ title: 'CMM basics (Zeiss)', location: 'Lab', skillIds: [] }).expect(200);
    expect(edited.body).toMatchObject({ title: 'CMM basics (Zeiss)', location: 'Lab', skills: [] });
  });

  it('lists with filters and paging', async () => {
    const h = await as(ids.ownerA);
    const all = (await api().get(URL).set(h).expect(200)).body;
    expect(all.total).toBe(2);
    expect((await api().get(`${URL}?status=cancelled`).set(h).expect(200)).body.data.map((s: { title: string }) => s.title)).toEqual(['Welding awareness']);
    expect((await api().get(`${URL}?q=zeiss`).set(h).expect(200)).body.total).toBe(1);
    expect((await api().get(`${URL}?q=tina`).set(h).expect(200)).body.total).toBe(1);
    expect((await api().get(`${URL}?employeeId=${ctx.insp}`).set(h).expect(200)).body.total).toBe(1);
    expect((await api().get(`${URL}?skillId=${ctx.skill}`).set(h).expect(200)).body.total).toBe(0);
    expect((await api().get(`${URL}?pageSize=1&page=2&sort=reference&order=asc`).set(h).expect(200)).body.data).toHaveLength(1);
    await api().get(`${URL}?status=nonsense`).set(h).expect(400);
  });

  it('shows on the person profile', async () => {
    const h = await as(ids.ownerA);
    const p = (await api().get(`/api/v1/competence/people/${ctx.insp}`).set(h).expect(200)).body;
    expect(p.training).toHaveLength(1);
    expect(p.training[0]).toMatchObject({ title: 'CMM basics (Zeiss)', status: 'completed', completedOn: day(-2), sessionStatus: 'open' });
  });

  it('who may do what: an attendee reads only their own session, without any competence permission', async () => {
    const inspector = await as(ids.inspectorA);
    await api().post(URL).set(inspector).send({ title: 'X', kind: 'course', providerType: 'external', providerName: 'A', startsOn: day(-1) }).expect(403);
    await api().post(`${URL}/${ctx.session}/close`).set(inspector).expect(403);
    await api().post(`${URL}/${ctx.session}/record`).set(inspector).send({ attendeeIds: [ctx.aI], outcome: 'absent' }).expect(403);
    const mine = (await api().get(URL).set(inspector).expect(200)).body;
    expect(mine.data.map((s: { title: string }) => s.title)).toEqual(['CMM basics (Zeiss)']);
    const detail = (await api().get(`${URL}/${ctx.session}`).set(inspector).expect(200)).body;
    expect(detail.attendees.map((a: { employee: { id: string } }) => a.employee.id)).toEqual([ctx.insp]);
    // Someone on no session sees nothing.
    expect((await api().get(URL).set(await as(ids.dual)).expect(200)).body.data).toEqual([]);
  });

  it('another organisation sees none of it', async () => {
    const b = await as(ids.ownerB, ids.orgB);
    expect((await api().get(URL).set(b).expect(200)).body.data).toEqual([]);
    await api().get(`${URL}/${ctx.session}`).set(b).expect(404);
    await api().post(`${URL}/${ctx.session}/attendees`).set(b).send({ employeeId: ctx.xavier }).expect(404);
  });
});
