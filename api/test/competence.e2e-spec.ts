/**
 * Competence (CO1) through the API: categories, skills, positions and what a position requires. The rules themselves are in supabase/tests/competence_core.test.sql;
 * this checks the routes, the permissions (including the Controller-seat read) and that errors reach the caller in words.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { giveControllerSeats, makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('c0');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-co');
  // The "dual" user is a viewer in Alpha; the seat is what lets them read competence.
  await giveControllerSeats(admin, ids.orgA, [ids.dual]);
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('competence set-up', () => {
  const ctx: Record<string, string> = {};

  it('categories are seeded and can be added, renamed and switched off', async () => {
    const h = await as(ids.ownerA);
    const list = (await api().get('/api/v1/competence/categories').set(h).expect(200)).body.data;
    expect(list.map((c: { key: string }) => c.key)).toEqual(['inspection', 'measurement', 'machine_operation', 'quality_system', 'health_safety', 'other']);
    ctx.inspection = list[0].id;
    const created = await api().post('/api/v1/competence/categories').set(h).send({ label: 'Welding' }).expect(201);
    expect(created.body).toMatchObject({ key: 'welding', label: 'Welding', active: true, skills: 0 });
    const renamed = await api().patch(`/api/v1/competence/categories/${created.body.id}`).set(h).send({ label: 'Weld inspection', active: false }).expect(200);
    expect(renamed.body).toMatchObject({ key: 'welding', label: 'Weld inspection', active: false });
    expect((await api().get('/api/v1/competence/categories').set(h).expect(200)).body.data.some((c: { key: string }) => c.key === 'welding')).toBe(false);
    expect((await api().get('/api/v1/competence/categories?all=true').set(h).expect(200)).body.data.some((c: { key: string }) => c.key === 'welding')).toBe(true);
    await api().post('/api/v1/competence/categories').set(h).send({ label: 'weld inspection' }).expect(409);
  });

  it('skills: add, edit, refuse bad input and a repeated code, retire and bring back', async () => {
    const h = await as(ids.ownerA);
    const cmm = await api().post('/api/v1/competence/skills').set(h).send({ code: 'CMM', name: 'CMM operation', categoryId: ctx.inspection, refreshMonths: 12 }).expect(201);
    expect(cmm.body).toMatchObject({ code: 'CMM', name: 'CMM operation', refreshMonths: 12, active: true, positions: 0, category: { id: ctx.inspection, label: 'Inspection' } });
    ctx.cmm = cmm.body.id;
    const vis = await api().post('/api/v1/competence/skills').set(h).send({ code: 'VIS', name: 'Visual inspection', categoryId: ctx.inspection, description: 'To the visual standard' }).expect(201);
    ctx.vis = vis.body.id;
    expect(vis.body.refreshMonths).toBeNull();

    const dup = await api().post('/api/v1/competence/skills').set(h).send({ code: 'cmm', name: 'Other', categoryId: ctx.inspection }).expect(409);
    expect(dup.body.error.code).toBe('competence_rule');
    expect(dup.body.error.message).toMatch(/already exists/);
    await api().post('/api/v1/competence/skills').set(h).send({ code: 'X', name: 'X', categoryId: ctx.inspection, refreshMonths: 0 }).expect(400);
    await api().post('/api/v1/competence/skills').set(h).send({ code: 'X', name: 'X', categoryId: ctx.inspection, oops: 1 }).expect(400);

    const edited = await api().patch(`/api/v1/competence/skills/${ctx.cmm}`).set(h).send({ name: 'CMM operation (Zeiss)', refreshMonths: null }).expect(200);
    expect(edited.body).toMatchObject({ name: 'CMM operation (Zeiss)', refreshMonths: null, code: 'CMM' });
    await api().patch(`/api/v1/competence/skills/${ctx.cmm}`).set(h).send({}).expect(400);

    const filtered = (await api().get('/api/v1/competence/skills?q=visual').set(h).expect(200)).body.data;
    expect(filtered.map((s: { code: string }) => s.code)).toEqual(['VIS']);
  });

  it('positions: add, require skills as a whole list, and a skill a position needs cannot be retired', async () => {
    const h = await as(ids.ownerA);
    const pos = await api().post('/api/v1/competence/positions').set(h).send({ code: 'INSP', name: 'CMM inspector', description: 'Runs the CMM' }).expect(201);
    ctx.pos = pos.body.id;
    expect(pos.body).toMatchObject({ code: 'INSP', name: 'CMM inspector', active: true, skills: [] });

    const set = await api().put(`/api/v1/competence/positions/${ctx.pos}/skills`).set(h)
      .send({ skills: [{ skillId: ctx.cmm, requiredLevel: 3 }, { skillId: ctx.vis, requiredLevel: 2 }] }).expect(200);
    expect(set.body.skills).toEqual([
      { skillId: ctx.cmm, code: 'CMM', name: 'CMM operation (Zeiss)', category: 'Inspection', requiredLevel: 3, skillActive: true },
      { skillId: ctx.vis, code: 'VIS', name: 'Visual inspection', category: 'Inspection', requiredLevel: 2, skillActive: true },
    ]);
    expect((await api().get('/api/v1/competence/skills').set(h).expect(200)).body.data.find((s: { id: string }) => s.id === ctx.cmm).positions).toBe(1);

    await api().put(`/api/v1/competence/positions/${ctx.pos}/skills`).set(h).send({ skills: [{ skillId: ctx.cmm, requiredLevel: 5 }] }).expect(400);
    const twice = await api().put(`/api/v1/competence/positions/${ctx.pos}/skills`).set(h)
      .send({ skills: [{ skillId: ctx.cmm, requiredLevel: 2 }, { skillId: ctx.cmm, requiredLevel: 3 }] }).expect(409);
    expect(twice.body.error.code).toBe('competence_rule');

    const refused = await api().post(`/api/v1/competence/skills/${ctx.cmm}/retire`).set(h).send({ reason: 'No longer used' }).expect(409);
    expect(refused.body.error.message).toMatch(/required by CMM inspector/);
    await api().put(`/api/v1/competence/positions/${ctx.pos}/skills`).set(h).send({ skills: [{ skillId: ctx.vis, requiredLevel: 2 }] }).expect(200);
    const retired = await api().post(`/api/v1/competence/skills/${ctx.cmm}/retire`).set(h).send({ reason: 'No longer used' }).expect(200);
    expect(retired.body).toMatchObject({ active: false, retiredReason: 'No longer used' });
    expect((await api().get('/api/v1/competence/skills').set(h).expect(200)).body.data.some((s: { id: string }) => s.id === ctx.cmm)).toBe(false);
    expect((await api().post(`/api/v1/competence/skills/${ctx.cmm}/reactivate`).set(h).expect(200)).body.active).toBe(true);

    const one = await api().get(`/api/v1/competence/positions/${ctx.pos}`).set(h).expect(200);
    expect(one.body.skills).toHaveLength(1);
    const gone = await api().post(`/api/v1/competence/positions/${ctx.pos}/retire`).set(h).send({ reason: 'Merged' }).expect(200);
    expect(gone.body.active).toBe(false);
    expect((await api().get('/api/v1/competence/positions').set(h).expect(200)).body.data).toEqual([]);
    expect((await api().get('/api/v1/competence/positions?all=true').set(h).expect(200)).body.data).toHaveLength(1);
    await api().post(`/api/v1/competence/positions/${ctx.pos}/reactivate`).set(h).expect(200);
  });

  it('who may do what: quality engineer reads, a viewer does not, a Controller-seat holder reads but cannot write', async () => {
    const owner = await as(ids.ownerA);
    // The inspector holds no competence permission.
    const inspector = await as(ids.inspectorA);
    await api().get('/api/v1/competence/skills').set(inspector).expect(403);
    await api().post('/api/v1/competence/skills').set(inspector).send({ code: 'Z', name: 'Z', categoryId: ctx.inspection }).expect(403);

    // The viewer-with-a-seat reads everything and writes nothing.
    const seat = await as(ids.dual);
    expect((await api().get('/api/v1/competence/skills').set(seat).expect(200)).body.data.length).toBeGreaterThan(0);
    expect((await api().get('/api/v1/competence/positions').set(seat).expect(200)).body.data.length).toBeGreaterThan(0);
    await api().post('/api/v1/competence/skills').set(seat).send({ code: 'Z', name: 'Z', categoryId: ctx.inspection }).expect(403);
    await api().post(`/api/v1/competence/skills/${ctx.vis}/retire`).set(seat).send({ reason: 'Nope' }).expect(403);
    const me = (await api().get('/api/v1/me').set(seat).expect(200)).body;
    const membership = me.memberships.find((m: { organisation: { id: string } }) => m.organisation.id === ids.orgA);
    expect(membership.permissions).toContain('competence.read');
    expect(membership.permissions).not.toContain('competence.manage');
    // The same person has no seat, so no read, in the other organisation.
    await api().get('/api/v1/competence/skills').set(await as(ids.dual, ids.orgB)).expect(403);
    expect((await api().get('/api/v1/me').set(owner).expect(200)).body.memberships.find((m: { organisation: { id: string } }) => m.organisation.id === ids.orgA).permissions).toEqual(expect.arrayContaining(['competence.read', 'competence.manage', 'competence.assess']));
  });

  it('another organisation sees none of it and cannot change it', async () => {
    const b = await as(ids.ownerB, ids.orgB);
    expect((await api().get('/api/v1/competence/skills?all=true').set(b).expect(200)).body.data).toEqual([]);
    expect((await api().get('/api/v1/competence/categories').set(b).expect(200)).body.data).toHaveLength(6);
    await api().patch(`/api/v1/competence/skills/${ctx.vis}`).set(b).send({ name: 'Hijacked' }).expect(404);
    await api().get(`/api/v1/competence/positions/${ctx.pos}`).set(b).expect(404);
    await api().put(`/api/v1/competence/positions/${ctx.pos}/skills`).set(b).send({ skills: [] }).expect(404);
  });
});
