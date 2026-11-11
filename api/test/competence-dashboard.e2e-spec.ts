/**
 * Competence dashboard (CO4) through the API: gaps against positions, expiry, people never assessed and training for the period, all read as the caller.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('c3');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const ctx: Record<string, string> = {};
const URL = `/api/v1/competence-dashboard?from=${day(-30)}&to=${day(0)}`;

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-cd');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const q1 = async (text: string, params: unknown[]) => (await admin.query(text, params)).rows[0];
  const emp = async (first: string) => (await q1(`insert into public."Employees" (organisation_id, first_name, surname) values ($1, $2, 'Test') returning id`, [ids.orgA, first])).id;
  ctx.xavier = await emp('Xavier');
  ctx.yara = await emp('Yara');
  ctx.zed = await emp('Zed');
  ctx.wes = await emp('Wes');
  const h = await as(ids.ownerA);
  const category = (await q1(`select id from public.competence_categories where organisation_id = $1 and key = 'inspection'`, [ids.orgA])).id;
  ctx.cmm = (await api().post('/api/v1/competence/skills').set(h).send({ code: 'CMM', name: 'CMM operation', categoryId: category, refreshMonths: 12 }).expect(201)).body.id;
  ctx.vis = (await api().post('/api/v1/competence/skills').set(h).send({ code: 'VIS', name: 'Visual inspection', categoryId: category }).expect(201)).body.id;
  const pos = (await api().post('/api/v1/competence/positions').set(h).send({ code: 'INSP', name: 'Inspector' }).expect(201)).body.id;
  await api().put(`/api/v1/competence/positions/${pos}/skills`).set(h).send({ skills: [{ skillId: ctx.cmm, requiredLevel: 3 }, { skillId: ctx.vis, requiredLevel: 2 }] }).expect(200);
  for (const who of [ctx.xavier, ctx.yara]) await api().post(`/api/v1/competence/people/${who}/positions`).set(h).send({ positionId: pos, startedOn: day(-60) }).expect(201);
  const assess = (who: string, skillId: string, level: number, body: object = {}) => api().post(`/api/v1/competence/people/${who}/assessments`).set(h).send({ skillId, level, ...body }).expect(201);
  await assess(ctx.xavier, ctx.cmm, 2, { assessedOn: day(-20) });
  await assess(ctx.yara, ctx.cmm, 3, { assessedOn: day(-20), expiresOn: day(20) });
  await assess(ctx.yara, ctx.vis, 2, { assessedOn: day(-20) });
  await assess(ctx.wes, ctx.vis, 2, { assessedOn: day(-40), expiresOn: day(-1) });
  const session = (await api().post('/api/v1/competence/training-sessions').set(h).send({
    title: 'CMM basics', kind: 'course', providerType: 'external', providerName: 'Zeiss', startsOn: day(-10), employeeIds: [ctx.xavier, ctx.yara],
  }).expect(201)).body;
  const attendee = (who: string) => session.attendees.find((a: { employee: { id: string } }) => a.employee.id === who).id;
  await api().post(`/api/v1/competence/training-sessions/${session.id}/record`).set(h).send({ attendeeIds: [attendee(ctx.xavier)], outcome: 'completed', completedOn: day(-3) }).expect(200);
  await api().post(`/api/v1/competence/training-sessions/${session.id}/record`).set(h).send({ attendeeIds: [attendee(ctx.yara)], outcome: 'failed', completedOn: day(-2), note: 'Missed the practical' }).expect(200);
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('competence dashboard', () => {
  it('works out the headline figures', async () => {
    const d = (await api().get(URL).set(await as(ids.ownerA)).expect(200)).body;
    expect(d.period).toMatchObject({ from: day(-30), to: day(0), bucket: 'week' });
    expect(d.kpis.people).toBeGreaterThanOrEqual(4);
    expect(d.kpis.withRequirements).toBe(2);
    expect(d.kpis.withGaps).toBe(1);
    expect(d.kpis.gaps).toBe(2);
    expect(d.kpis.expired).toBe(1);
    expect(d.kpis.expiring30).toBe(1);
    expect(d.kpis.expiring90).toBe(1);
    expect(d.kpis.neverAssessed).toBeGreaterThanOrEqual(1);
    expect(d.kpis).toMatchObject({ sessions: 1, completions: 1, failures: 1 });
  });

  it('lists the gaps by skill and the people furthest short', async () => {
    const d = (await api().get(URL).set(await as(ids.ownerA)).expect(200)).body;
    expect(d.gapsBySkill.map((s: { code: string; people: number; required: number }) => [s.code, s.people, s.required]).sort()).toEqual([['CMM', 1, 2], ['VIS', 1, 2]]);
    expect(d.worstGaps).toHaveLength(1);
    expect(d.worstGaps[0]).toMatchObject({ employeeId: ctx.xavier, name: 'Xavier Test', gapSkills: 2, totalGap: 3 });
    expect(d.worstGaps[0].skills).toEqual(expect.arrayContaining(['CMM operation', 'Visual inspection']));
  });

  it('lists the next expiries with the days left, expired ones first', async () => {
    const d = (await api().get(URL).set(await as(ids.ownerA)).expect(200)).body;
    expect(d.nextExpiries.map((e: { employeeId: string; days: number }) => [e.employeeId, e.days])).toEqual([[ctx.wes, -1], [ctx.yara, 20]]);
    expect(d.nextExpiries[1]).toMatchObject({ skill: 'CMM operation', level: 3, expiresOn: day(20) });
  });

  it('shows the spread of levels, people never assessed, and training for the period', async () => {
    const d = (await api().get(URL).set(await as(ids.ownerA)).expect(200)).body;
    expect(d.levels.map((l: { label: string }) => l.label)).toEqual(['None', 'Learning', 'Supervised', 'Competent', 'Can train others']);
    expect(d.levels.find((l: { level: number }) => l.level === 2).count).toBe(3);
    expect(d.levels.find((l: { level: number }) => l.level === 3).count).toBe(1);
    expect(d.neverAssessedPeople.map((p: { employeeId: string }) => p.employeeId)).toContain(ctx.zed);
    expect(d.neverAssessedPeople.some((p: { employeeId: string }) => p.employeeId === ctx.xavier)).toBe(false);
    expect(d.training.reduce((a: number, t: { completed: number }) => a + t.completed, 0)).toBe(1);
    expect(d.training.reduce((a: number, t: { failed: number }) => a + t.failed, 0)).toBe(1);
    expect(d.recentTraining[0]).toMatchObject({ title: 'CMM basics', startsOn: day(-10), completed: 1, attendees: 2 });
  });

  it('uses months for a long period', async () => {
    const d = (await api().get(`/api/v1/competence-dashboard?from=${day(-300)}&to=${day(0)}`).set(await as(ids.ownerA)).expect(200)).body;
    expect(d.period.bucket).toBe('month');
  });

  it('refuses bad periods and people without the right', async () => {
    const h = await as(ids.ownerA);
    await api().get('/api/v1/competence-dashboard').set(h).expect(400);
    await api().get(`/api/v1/competence-dashboard?from=${day(0)}&to=${day(-5)}`).set(h).expect(400);
    await api().get(`/api/v1/competence-dashboard?from=2020-01-01&to=${day(0)}`).set(h).expect(400);
    await api().get(URL).set(await as(ids.inspectorA)).expect(403);
  });

  it('another organisation sees none of it', async () => {
    const d = (await api().get(URL).set(await as(ids.ownerB, ids.orgB)).expect(200)).body;
    expect(d.gapsBySkill).toEqual([]);
    expect(d.worstGaps).toEqual([]);
    expect(d.nextExpiries).toEqual([]);
    expect(d.recentTraining).toEqual([]);
    expect(d.kpis).toMatchObject({ gaps: 0, expired: 0, sessions: 0 });
  });
});
