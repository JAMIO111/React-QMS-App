/**
 * Risk register (RK1) through the API: the matrix and its versions, the score preview, categories, raising, editing, assessing, retiring, the register's
 * filters, permissions and tenancy. The rules are in supabase/tests/risk_register_core.test.sql; this checks the routes and that errors reach the caller in words.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a1c');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-rk');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('the matrix', () => {
  it('gives the seeded matrix and scores a cell without saving anything', async () => {
    const h = await as(ids.inspectorA);
    const model = await api().get('/api/v1/risk-model').set(h).expect(200);
    expect(model.body).toMatchObject({ version: 1, current: true, canChange: false, config: { acceptanceBand: 'medium' } });
    expect(model.body.config.likelihood).toHaveLength(5);
    expect(model.body.config.bands[4][4]).toBe('critical');
    const score = await api().get('/api/v1/risk-score?likelihood=4&consequence=4').set(h).expect(200);
    expect(score.body).toMatchObject({ score: 16, band: 'high', acceptable: false, likelihoodLabel: 'Likely', consequenceLabel: 'Major', modelVersion: 1 });
    await api().get('/api/v1/risk-score?likelihood=6&consequence=1').set(h).expect(400);
  });

  it('saves a new version with a reason (approvers only)', async () => {
    const owner = await as(ids.ownerA);
    const model = (await api().get('/api/v1/risk-model').set(owner).expect(200)).body;
    expect(model.canChange).toBe(true);
    const config = { ...model.config, acceptanceBand: 'low' };
    await api().put('/api/v1/risk-model').set(await as(ids.inspectorA)).send({ config, reason: 'Not mine' }).expect(403);
    await api().put('/api/v1/risk-model').set(owner).send({ config }).expect(400);
    const same = await api().put('/api/v1/risk-model').set(owner).send({ config: model.config, reason: 'No change' }).expect(409);
    expect(same.body.error).toMatchObject({ code: 'risk_rule', message: 'Nothing has changed in the matrix' });
    const saved = await api().put('/api/v1/risk-model').set(owner).send({ config, reason: 'Stricter acceptance' }).expect(200);
    expect(saved.body).toMatchObject({ version: 2, reason: 'Stricter acceptance', config: { acceptanceBand: 'low' } });
    expect(saved.body.versions.map((v: { version: number; current: boolean }) => [v.version, v.current])).toEqual([[2, true], [1, false]]);
    expect((await api().get('/api/v1/risk-score?likelihood=3&consequence=3').set(owner).expect(200)).body).toMatchObject({ band: 'medium', acceptable: false, modelVersion: 2 });
  });
});

describe('categories', () => {
  it('lists the seeded ones, adds, renames and switches off', async () => {
    const h = await as(ids.ownerA);
    const list = await api().get('/api/v1/risk-categories').set(h).expect(200);
    expect(list.body.data).toHaveLength(10);
    ctx.process = list.body.data.find((c: { key: string }) => c.key === 'process').id;
    ctx.other = list.body.data.find((c: { key: string }) => c.key === 'other').id;
    await api().post('/api/v1/risk-categories').set(await as(ids.inspectorA)).send({ label: 'Tooling' }).expect(403);
    const made = await api().post('/api/v1/risk-categories').set(h).send({ label: 'Tooling' }).expect(201);
    expect(made.body).toMatchObject({ key: 'tooling', label: 'Tooling', active: true, risks: 0 });
    await api().post('/api/v1/risk-categories').set(h).send({ label: 'tooling' }).expect(409);
    const off = await api().patch(`/api/v1/risk-categories/${made.body.id}`).set(h).send({ label: 'Tools and fixtures', active: false }).expect(200);
    expect(off.body).toMatchObject({ key: 'tooling', label: 'Tools and fixtures', active: false });
    expect((await api().get('/api/v1/risk-categories').set(h).expect(200)).body.data).toHaveLength(10);
    expect((await api().get('/api/v1/risk-categories?all=true').set(h).expect(200)).body.data).toHaveLength(11);
    ctx.off = made.body.id;
  });
});

describe('risks', () => {
  it('raises a draft, numbered, owned by whoever raised it', async () => {
    const h = await as(ids.ownerA);
    await api().post('/api/v1/risks').set(await as(ids.inspectorA)).send({ categoryId: ctx.process, title: 'Not allowed' }).expect(403);
    await api().post('/api/v1/risks').set(h).send({ categoryId: ctx.process }).expect(400);
    const off = await api().post('/api/v1/risks').set(h).send({ categoryId: ctx.off, title: 'Switched off' }).expect(409);
    expect(off.body.error.message).toMatch(/active category/);
    const made = await api().post('/api/v1/risks').set(h).send({ categoryId: ctx.process, title: 'Single source for castings', cause: 'One approved foundry', effect: 'Line stop', siteId: ids.siteA }).expect(201);
    expect(made.body).toMatchObject({
      reference: 'RSK-001', kind: 'risk', status: 'draft', title: 'Single source for castings', category: { id: ctx.process, label: 'Process' },
      owner: { id: ids.ownerA, name: 'Ada Owner' }, site: { id: ids.siteA }, inherent: null, assessments: [], canManage: true, canEdit: true,
    });
    ctx.risk = made.body.id;
    const second = await api().post('/api/v1/risks').set(h).send({ kind: 'opportunity', categoryId: ctx.other, title: 'Second CMM shift', ownerId: ids.inspectorA }).expect(201);
    expect(second.body).toMatchObject({ reference: 'RSK-002', kind: 'opportunity', owner: { id: ids.inspectorA } });
    ctx.opportunity = second.body.id;
    const outsider = await api().post('/api/v1/risks').set(h).send({ categoryId: ctx.process, title: 'x', ownerId: ids.ownerB }).expect(409);
    expect(outsider.body.error.message).toMatch(/active member/);
  });

  it('assesses: the database scores it, the first assessment opens it, a second supersedes', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/risks/${ctx.risk}/assessments`).set(h).send({ likelihood: 4, consequence: 4 }).expect(400);
    await api().post(`/api/v1/risks/${ctx.risk}/assessments`).set(await as(ids.inspectorA)).send({ likelihood: 1, consequence: 1, rationale: 'Not mine' }).expect(403);
    const first = await api().post(`/api/v1/risks/${ctx.risk}/assessments`).set(h).send({ likelihood: 4, consequence: 4, rationale: 'Two stoppages last year' }).expect(200);
    expect(first.body).toMatchObject({ status: 'open', inherent: { likelihood: 4, consequence: 4, score: 16, band: 'high', modelVersion: 2 } });
    const second = await api().post(`/api/v1/risks/${ctx.risk}/assessments`).set(h).send({ likelihood: 2, consequence: 4, rationale: 'Second foundry on trial' }).expect(200);
    expect(second.body.inherent).toMatchObject({ score: 8, band: 'medium' });
    expect(second.body.assessments).toMatchObject([
      { score: 8, current: true, rationale: 'Second foundry on trial', likelihoodLabel: 'Unlikely', consequenceLabel: 'Major', assessedBy: 'Ada Owner' },
      { score: 16, current: false },
    ]);
    const fixed = await api().patch(`/api/v1/risks/${ctx.risk}`).set(h).send({ kind: 'opportunity' }).expect(409);
    expect(fixed.body.error.code).toBe('risk_rule');
    const edited = await api().patch(`/api/v1/risks/${ctx.risk}`).set(h).send({ title: 'Single source for castings (EU)', effect: '' }).expect(200);
    expect(edited.body).toMatchObject({ title: 'Single source for castings (EU)', effect: null, cause: 'One approved foundry' });
  });

  it('filters and sorts the register', async () => {
    const h = await as(ids.inspectorA);
    const all = await api().get('/api/v1/risks').set(h).expect(200);
    expect(all.body).toMatchObject({ total: 2, page: 1 });
    expect(all.body.data.map((r: { reference: string }) => r.reference)).toEqual(['RSK-001', 'RSK-002']);
    const pick = async (q: string) => (await api().get(`/api/v1/risks?${q}`).set(h).expect(200)).body.data.map((r: { reference: string }) => r.reference);
    expect(await pick('kind=opportunity')).toEqual(['RSK-002']);
    expect(await pick('band=medium')).toEqual(['RSK-001']);
    expect(await pick('band=unassessed')).toEqual(['RSK-002']);
    expect(await pick('band=high,unassessed')).toEqual(['RSK-002']);
    expect(await pick('status=draft')).toEqual(['RSK-002']);
    expect(await pick('owner=me')).toEqual(['RSK-002']);
    expect(await pick(`categoryId=${ctx.process}`)).toEqual(['RSK-001']);
    expect(await pick('q=foundry')).toEqual(['RSK-001']);
    expect(await pick('sort=score&order=desc')).toEqual(['RSK-001', 'RSK-002']);
    await api().get('/api/v1/risks?status=nope').set(h).expect(400);
  });

  it('retires with a reason and brings back', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/risks/${ctx.opportunity}/retire`).set(h).send({}).expect(400);
    const retired = await api().post(`/api/v1/risks/${ctx.opportunity}/retire`).set(h).send({ reason: 'No budget this year' }).expect(200);
    expect(retired.body).toMatchObject({ status: 'retired', retiredReason: 'No budget this year', canEdit: false });
    expect((await api().get('/api/v1/risks').set(h).expect(200)).body.total).toBe(1);
    expect((await api().get('/api/v1/risks?status=retired').set(h).expect(200)).body.total).toBe(1);
    expect((await api().get('/api/v1/risks?status=all').set(h).expect(200)).body.total).toBe(2);
    const refused = await api().post(`/api/v1/risks/${ctx.opportunity}/assessments`).set(h).send({ likelihood: 1, consequence: 1, rationale: 'After' }).expect(409);
    expect(refused.body.error.message).toMatch(/retired/);
    const back = await api().post(`/api/v1/risks/${ctx.opportunity}/reactivate`).set(h).expect(200);
    expect(back.body).toMatchObject({ status: 'draft', retiredReason: null });
  });

  it('keeps another organisation out', async () => {
    const b = await as(ids.ownerB, ids.orgB);
    expect((await api().get('/api/v1/risks').set(b).expect(200)).body.total).toBe(0);
    await api().get(`/api/v1/risks/${ctx.risk}`).set(b).expect(404);
    await api().post(`/api/v1/risks/${ctx.risk}/assessments`).set(b).send({ likelihood: 1, consequence: 1, rationale: 'Hijack' }).expect(404);
    await api().patch(`/api/v1/risk-categories/${ctx.process}`).set(b).send({ label: 'Hijack' }).expect(404);
    expect((await api().get('/api/v1/risk-model').set(b).expect(200)).body.version).toBe(1);
  });
});
