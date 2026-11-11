/**
 * Competence (CO2) through the API: positions held with dates, assessments, the matrix, a person's profile and "my competence".
 * The rules are in supabase/tests/competence_assessments.test.sql; this checks the routes, permissions, own-record reading and the figures.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('c1');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const ctx: Record<string, string> = {};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-cp');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const q1 = async (text: string, params: unknown[]) => (await admin.query(text, params)).rows[0];
  // Two employees: Xavier (no sign-in) and the inspector, whose sign-in is linked to their record.
  ctx.xavier = (await q1(`insert into public."Employees" (organisation_id, first_name, surname) values ($1, 'Xavier', 'Xu') returning id`, [ids.orgA])).id;
  ctx.insp = (await q1(`insert into public."Employees" (organisation_id, first_name, surname, auth_id) values ($1, 'Ines', 'Inspector', $2) returning id`, [ids.orgA, ids.inspectorA])).id;
  ctx.owner = (await q1(`insert into public."Employees" (organisation_id, first_name, surname, auth_id) values ($1, 'Olive', 'Owner', $2) returning id`, [ids.orgA, ids.ownerA])).id;
  ctx.category = (await q1(`select id from public.competence_categories where organisation_id = $1 and key = 'inspection'`, [ids.orgA])).id;
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('competence people', () => {
  it('set-up: skills and a position that requires them', async () => {
    const h = await as(ids.ownerA);
    ctx.cmm = (await api().post('/api/v1/competence/skills').set(h).send({ code: 'CMM', name: 'CMM operation', categoryId: ctx.category, refreshMonths: 12 }).expect(201)).body.id;
    ctx.vis = (await api().post('/api/v1/competence/skills').set(h).send({ code: 'VIS', name: 'Visual inspection', categoryId: ctx.category }).expect(201)).body.id;
    ctx.pos = (await api().post('/api/v1/competence/positions').set(h).send({ code: 'INSP', name: 'Inspector' }).expect(201)).body.id;
    await api().put(`/api/v1/competence/positions/${ctx.pos}/skills`).set(h)
      .send({ skills: [{ skillId: ctx.cmm, requiredLevel: 3 }, { skillId: ctx.vis, requiredLevel: 2 }] }).expect(200);
  });

  it('gives a position from a date, shows the whole requirement as a gap, and refuses a repeat', async () => {
    const h = await as(ids.ownerA);
    const res = await api().post(`/api/v1/competence/people/${ctx.xavier}/positions`).set(h).send({ positionId: ctx.pos, startedOn: day(-90) }).expect(201);
    expect(res.body.positions).toHaveLength(1);
    expect(res.body.positions[0]).toMatchObject({ startedOn: day(-90), endedOn: null, position: { code: 'INSP' } });
    expect(res.body.summary).toMatchObject({ required: 2, gaps: 2, expired: 0 });
    expect(res.body.skills.map((s: { skill: { code: string }; status: string; gap: number }) => [s.skill.code, s.status, s.gap])).toEqual([['CMM', 'not_assessed', 3], ['VIS', 'not_assessed', 2]]);
    const again = await api().post(`/api/v1/competence/people/${ctx.xavier}/positions`).set(h).send({ positionId: ctx.pos, startedOn: day(-10) }).expect(409);
    expect(again.body.error.code).toBe('competence_rule');
    await api().post(`/api/v1/competence/people/${ctx.xavier}/positions`).set(h).send({ positionId: ctx.pos, startedOn: 'yesterday' }).expect(400);
  });

  it('assessing closes the gap, sets the expiry from the skill, and keeps history', async () => {
    const h = await as(ids.ownerA);
    const first = await api().post(`/api/v1/competence/people/${ctx.xavier}/assessments`).set(h).send({ skillId: ctx.cmm, level: 2, assessedOn: day(-30), note: 'Supervised run' }).expect(201);
    const cmm = first.body.skills.find((s: { skill: { code: string } }) => s.skill.code === 'CMM');
    expect(cmm).toMatchObject({ level: 2, required: 3, gap: 1, status: 'gap', assessedOn: day(-30) });
    expect(cmm.expiresOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(cmm.history).toHaveLength(1);
    const second = await api().post(`/api/v1/competence/people/${ctx.xavier}/assessments`).set(h).send({ skillId: ctx.cmm, level: 3, assessedOn: day(-1), expiresOn: day(20) }).expect(201);
    const now = second.body.skills.find((s: { skill: { code: string } }) => s.skill.code === 'CMM');
    expect(now).toMatchObject({ level: 3, gap: 0, status: 'expiring', expiry: 'expiring', expiresOn: day(20) });
    expect(now.history.map((x: { level: number; current: boolean }) => [x.level, x.current])).toEqual([[3, true], [2, false]]);
    expect(second.body.summary).toMatchObject({ gaps: 1, expiring: 1 });
    // A lower level needs a reason; the rules reach the caller in words.
    const lower = await api().post(`/api/v1/competence/people/${ctx.xavier}/assessments`).set(h).send({ skillId: ctx.cmm, level: 1 }).expect(409);
    expect(lower.body.error.message).toMatch(/why the level is lower/);
    await api().post(`/api/v1/competence/people/${ctx.xavier}/assessments`).set(h).send({ skillId: ctx.cmm, level: 7 }).expect(400);
  });

  it('nobody assesses themselves', async () => {
    const h = await as(ids.ownerA);
    const own = await api().post(`/api/v1/competence/people/${ctx.owner}/assessments`).set(h).send({ skillId: ctx.vis, level: 3 }).expect(409);
    expect(own.body.error.message).toMatch(/your own competence/);
  });

  it('the matrix lists employees by skill with filters, status and paging', async () => {
    const h = await as(ids.ownerA);
    const all = (await api().get('/api/v1/competence/matrix').set(h).expect(200)).body;
    expect(all.skills.map((s: { code: string }) => s.code)).toEqual(['CMM', 'VIS']);
    const x = all.data.find((r: { employee: { id: string } }) => r.employee.id === ctx.xavier);
    expect(x.positions.map((p: { name: string }) => p.name)).toEqual(['Inspector']);
    expect(x.cells[ctx.cmm]).toMatchObject({ level: 3, required: 3, status: 'expiring' });
    expect(x.cells[ctx.vis]).toMatchObject({ level: null, required: 2, status: 'not_assessed', gap: 2 });
    const byPosition = (await api().get(`/api/v1/competence/matrix?positionId=${ctx.pos}`).set(h).expect(200)).body;
    expect(byPosition.data.map((r: { employee: { id: string } }) => r.employee.id)).toEqual([ctx.xavier]);
    const gaps = (await api().get('/api/v1/competence/matrix?status=gap').set(h).expect(200)).body;
    expect(gaps.total).toBe(1);
    expect((await api().get('/api/v1/competence/matrix?status=expired').set(h).expect(200)).body.total).toBe(0);
    expect((await api().get('/api/v1/competence/matrix?status=expiring').set(h).expect(200)).body.total).toBe(1);
    expect((await api().get('/api/v1/competence/matrix?q=xavier').set(h).expect(200)).body.total).toBe(1);
    const oneSkill = (await api().get(`/api/v1/competence/matrix?skillId=${ctx.vis}`).set(h).expect(200)).body;
    expect(oneSkill.skills).toHaveLength(1);
    const paged = (await api().get('/api/v1/competence/matrix?pageSize=1&page=2').set(h).expect(200)).body;
    expect(paged.data).toHaveLength(1);
    expect(paged.total).toBeGreaterThan(1);
    await api().get('/api/v1/competence/matrix?status=nonsense').set(h).expect(400);
  });

  it('ending a position keeps it in the history and drops its requirement', async () => {
    const h = await as(ids.ownerA);
    const profile = (await api().get(`/api/v1/competence/people/${ctx.xavier}`).set(h).expect(200)).body;
    const ended = await api().post(`/api/v1/competence/employee-positions/${profile.positions[0].id}/end`).set(h).send({ endedOn: day(-1) }).expect(200);
    expect(ended.body.positions[0].endedOn).toBe(day(-1));
    expect(ended.body.summary.required).toBe(0);
    expect(ended.body.skills.find((s: { skill: { code: string } }) => s.skill.code === 'CMM')).toMatchObject({ required: null, status: 'extra', level: 3 });
    await api().post(`/api/v1/competence/employee-positions/${profile.positions[0].id}/end`).set(h).send({}).expect(409);
    await api().post('/api/v1/competence/employee-positions/00000000-0000-4000-8000-000000000001/end').set(h).send({}).expect(404);
  });

  it('who may do what, and my own record', async () => {
    const inspector = await as(ids.inspectorA);
    // No competence permission: the lists, the matrix and other people are closed.
    await api().get('/api/v1/competence/matrix').set(inspector).expect(403);
    await api().get(`/api/v1/competence/people/${ctx.xavier}`).set(inspector).expect(403);
    await api().post(`/api/v1/competence/people/${ctx.xavier}/assessments`).set(inspector).send({ skillId: ctx.cmm, level: 1 }).expect(403);
    await api().post(`/api/v1/competence/people/${ctx.xavier}/positions`).set(inspector).send({ positionId: ctx.pos, startedOn: day(-1) }).expect(403);

    // The inspector is assessed by the owner, then reads their own record without any competence permission.
    const owner = await as(ids.ownerA);
    await api().post(`/api/v1/competence/people/${ctx.insp}/positions`).set(owner).send({ positionId: ctx.pos, startedOn: day(-5) }).expect(201);
    await api().post(`/api/v1/competence/people/${ctx.insp}/assessments`).set(owner).send({ skillId: ctx.vis, level: 2 }).expect(201);
    const me = (await api().get('/api/v1/competence/me').set(inspector).expect(200)).body;
    expect(me.linked).toBe(true);
    expect(me.employee.name).toBe('Ines Inspector');
    expect(me.skills.find((s: { skill: { code: string } }) => s.skill.code === 'VIS')).toMatchObject({ level: 2, status: 'ok' });
    expect(me.skills.find((s: { skill: { code: string } }) => s.skill.code === 'CMM')).toMatchObject({ level: null, status: 'not_assessed', gap: 3 });
    const meta = (await api().get('/api/v1/me').set(inspector).expect(200)).body.memberships.find((m: { organisation: { id: string } }) => m.organisation.id === ids.orgA);
    expect(meta.permissions).not.toContain('competence.read');
    // A sign-in linked to nobody has no record.
    const none = (await api().get('/api/v1/competence/me').set(await as(ids.dual)).expect(200)).body;
    expect(none).toEqual({ linked: false });
  });

  it('another organisation sees none of it', async () => {
    const b = await as(ids.ownerB, ids.orgB);
    expect((await api().get('/api/v1/competence/matrix').set(b).expect(200)).body.data.some((r: { employee: { id: string } }) => r.employee.id === ctx.xavier)).toBe(false);
    await api().get(`/api/v1/competence/people/${ctx.xavier}`).set(b).expect(404);
    await api().post(`/api/v1/competence/people/${ctx.xavier}/assessments`).set(b).send({ skillId: ctx.cmm, level: 1 }).expect(404);
  });
});
