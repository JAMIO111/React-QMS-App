/**
 * Process control PC1 through the API: machines, part families (and a part's family), part
 * revision characteristic values (locked once released, copied into the next draft), control plans
 * with scope and the revision lifecycle (submit → approve → effective → superseded), permissions
 * per action, history and outbox events.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-pc');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

const ctx: Record<string, string> = {};

describe('machines and part families', () => {
  it('creates, lists and updates machines', async () => {
    const h = await as(ids.ownerA);
    const m = await api().post('/api/v1/machines').set(h).send({ code: 'lathe-01', name: 'CNC lathe 1', siteId: ids.siteA, workCentre: 'Turning' }).expect(201);
    expect(m.body).toMatchObject({ code: 'LATHE-01', site: { id: ids.siteA, name: 'Alpha main' }, workCentre: 'Turning', active: true });
    const dup = await api().post('/api/v1/machines').set(h).send({ code: 'LATHE-01', name: 'Again' }).expect(409);
    expect(dup.body.error.message).toBe('A machine with this code already exists');
    await api().patch(`/api/v1/machines/${m.body.id}`).set(h).send({ active: false }).expect(200);
    expect((await api().get('/api/v1/machines').set(h).expect(200)).body.data).toEqual([]);
    expect((await api().get('/api/v1/machines?includeInactive=true').set(h).expect(200)).body.data).toHaveLength(1);
    // Inspectors read master data but cannot change it.
    await api().post('/api/v1/machines').set(await as(ids.inspectorA)).send({ code: 'X', name: 'X' }).expect(403);
  });

  it('groups parts into a family', async () => {
    const h = await as(ids.ownerA);
    const fam = await api().post('/api/v1/part-families').set(h).send({ code: 'hcr', name: 'Hydraulic cylinder rods' }).expect(201);
    ctx.family = fam.body.id;
    expect(fam.body).toMatchObject({ code: 'HCR', partCount: 0, planCount: 0, parts: [], plans: [] });
    const p100 = await api().post('/api/v1/parts').set(h).send({ partNumber: 'HCR-100', name: 'Rod 100', partFamilyId: ctx.family, initialRevision: { revision: 'A' } }).expect(201);
    ctx.part100 = p100.body.id;
    ctx.rev100A = p100.body.revisions[0].id;
    expect(p100.body.partFamily).toEqual({ id: ctx.family, code: 'HCR', name: 'Hydraulic cylinder rods' });
    const p200 = await api().post('/api/v1/parts').set(h).send({ partNumber: 'HCR-200', name: 'Rod 200' }).expect(201);
    await api().patch(`/api/v1/parts/${p200.body.id}`).set(h).send({ partFamilyId: ctx.family }).expect(200);
    const detail = await api().get(`/api/v1/part-families/${ctx.family}`).set(h).expect(200);
    expect(detail.body.parts.map((p: { partNumber: string }) => p.partNumber)).toEqual(['HCR-100', 'HCR-200']);
    const filtered = await api().get(`/api/v1/parts?partFamilyId=${ctx.family}`).set(h).expect(200);
    expect(filtered.body.data).toHaveLength(2);
  });
});

describe('part revision characteristic values', () => {
  it('are edited on a draft, locked on release and copied into the next draft', async () => {
    const h = await as(ids.ownerA);
    const len = await api().post(`/api/v1/part-revisions/${ctx.rev100A}/characteristics`).set(h)
      .send({ characteristicKey: 'length', nominal: 100, lowerLimit: 99.9, upperLimit: 100.1, unitCode: 'mm' }).expect(201);
    expect(len.body).toMatchObject({ characteristicKey: 'LENGTH', nominal: 100, lowerLimit: 99.9, upperLimit: 100.1 });
    await api().post(`/api/v1/part-revisions/${ctx.rev100A}/characteristics`).set(h)
      .send({ characteristicKey: 'groove pos', nominal: 20, lowerLimit: 19.95, upperLimit: 20.05, unitCode: 'mm' }).expect(201);
    const bad = await api().post(`/api/v1/part-revisions/${ctx.rev100A}/characteristics`).set(h)
      .send({ characteristicKey: 'X', nominal: 5, lowerLimit: 6, unitCode: 'mm' }).expect(400);
    expect(bad.body.error.code).toBe('validation_failed');
    await api().patch(`/api/v1/part-revision-characteristics/${len.body.id}`).set(h).send({ upperLimit: 100.15 }).expect(200);

    await api().post(`/api/v1/part-revisions/${ctx.rev100A}/release`).set(h).expect(200);
    const locked = await api().patch(`/api/v1/part-revision-characteristics/${len.body.id}`).set(h).send({ nominal: 101 }).expect(409);
    expect(locked.body.error).toMatchObject({ code: 'control_plan_rule' });
    expect(locked.body.error.message).toMatch(/Revision A is released/);
    await api().delete(`/api/v1/part-revision-characteristics/${len.body.id}`).set(h).expect(409);

    const revB = await api().post(`/api/v1/parts/${ctx.part100}/revisions`).set(h).send({ revision: 'B' }).expect(201);
    const copied = await api().get(`/api/v1/part-revisions/${revB.body.id}/characteristics`).set(h).expect(200);
    expect(copied.body.data.map((v: { characteristicKey: string; upperLimit: number }) => [v.characteristicKey, v.upperLimit])).toEqual([
      ['GROOVE_POS', 20.05],
      ['LENGTH', 100.15],
    ]);
    const groove = copied.body.data.find((v: { characteristicKey: string }) => v.characteristicKey === 'GROOVE_POS');
    await api().delete(`/api/v1/part-revision-characteristics/${groove.id}`).set(h).expect(204);
  });
});

describe('control plans', () => {
  it('creates a plan with a first draft and a scope', async () => {
    const h = await as(ids.ownerA);
    const plan = await api().post('/api/v1/control-plans').set(h)
      .send({ planCode: 'cp-hcr-001', title: 'Rods – turning and finishing', partFamilyId: ctx.family, ownerId: ids.ownerA }).expect(201);
    ctx.plan = plan.body.id;
    ctx.revA = plan.body.revisions[0].id;
    expect(plan.body).toMatchObject({
      planCode: 'CP-HCR-001',
      owner: { id: ids.ownerA, name: 'Ada Owner' },
      families: ['HCR'],
      effectiveRevision: null,
      openRevision: { revisionCode: 'A', status: 'draft' },
    });
    const scoped = await api().post(`/api/v1/control-plans/${ctx.plan}/applicability`).set(h)
      .send({ partFamilyId: ctx.family, partId: ctx.part100, operationCode: 'op-020' }).expect(201);
    expect(scoped.body.applicability).toHaveLength(2);
    const entry = scoped.body.applicability.find((a: { part: unknown }) => a.part);
    expect(entry).toMatchObject({ part: { partNumber: 'HCR-100' }, operationCode: 'OP-020' });
    await api().post(`/api/v1/control-plans/${ctx.plan}/applicability`).set(h).send({ partFamilyId: ctx.family }).expect(409);
    const removed = await api().delete(`/api/v1/control-plan-applicability/${entry.id}`).set(h).expect(200);
    expect(removed.body.applicability).toHaveLength(1);
    const listed = await api().get(`/api/v1/control-plans?partFamilyId=${ctx.family}`).set(h).expect(200);
    expect(listed.body.data.map((p: { planCode: string }) => p.planCode)).toEqual(['CP-HCR-001']);
    expect((await api().get(`/api/v1/part-families/${ctx.family}`).set(h).expect(200)).body.plans).toMatchObject([{ planCode: 'CP-HCR-001', scope: 'All parts' }]);
  });

  it('runs the revision lifecycle with the right permissions', async () => {
    const owner = await as(ids.ownerA);
    const inspector = await as(ids.inspectorA);
    // Inspectors can read but not draft or move revisions.
    await api().get(`/api/v1/control-plans/${ctx.plan}`).set(inspector).expect(200);
    await api().patch(`/api/v1/control-plan-revisions/${ctx.revA}`).set(inspector).send({ changeReason: 'x' }).expect(403);
    await api().post(`/api/v1/control-plan-revisions/${ctx.revA}/transitions`).set(inspector).send({ action: 'submit' }).expect(403);

    const noReason = await api().post(`/api/v1/control-plan-revisions/${ctx.revA}/transitions`).set(owner).send({ action: 'submit' }).expect(409);
    expect(noReason.body.error.message).toMatch(/Describe the change/);
    await api().patch(`/api/v1/control-plan-revisions/${ctx.revA}`).set(owner).send({ changeReason: 'Initial issue' }).expect(200);
    const submitted = await api().post(`/api/v1/control-plan-revisions/${ctx.revA}/transitions`).set(owner).send({ action: 'submit' }).expect(200);
    expect(submitted.body).toMatchObject({ status: 'pending_approval', submittedBy: { id: ids.ownerA } });
    await api().patch(`/api/v1/control-plan-revisions/${ctx.revA}`).set(owner).send({ changeReason: 'Edited' }).expect(409);
    await api().post(`/api/v1/control-plan-revisions/${ctx.revA}/transitions`).set(owner).send({ action: 'send_back' }).expect(400);
    const back = await api().post(`/api/v1/control-plan-revisions/${ctx.revA}/transitions`).set(owner).send({ action: 'send_back', comment: 'Add the OD check' }).expect(200);
    expect(back.body).toMatchObject({ status: 'draft', reviewComment: 'Add the OD check', submittedAt: null });
    await api().post(`/api/v1/control-plan-revisions/${ctx.revA}/transitions`).set(owner).send({ action: 'submit' }).expect(200);
    const approved = await api().post(`/api/v1/control-plan-revisions/${ctx.revA}/transitions`).set(owner).send({ action: 'approve', comment: 'OK' }).expect(200);
    expect(approved.body).toMatchObject({ status: 'effective', approvedBy: { id: ids.ownerA, name: 'Ada Owner' }, reviewComment: 'OK' });
    expect(approved.body.effectiveFrom).not.toBeNull();

    // B, dated next week, stays approved until then; C made effective now supersedes A.
    const inWeek = new Date(Date.now() + 7 * 86400_000).toISOString();
    const revB = await api().post(`/api/v1/control-plans/${ctx.plan}/revisions`).set(owner).send({ revisionCode: 'B', changeReason: 'Tighter OD', effectiveFrom: inWeek }).expect(201);
    expect(revB.body.supersedesRevision).toEqual({ id: ctx.revA, revisionCode: 'A' });
    await api().post(`/api/v1/control-plans/${ctx.plan}/revisions`).set(owner).send({ revisionCode: 'X' }).expect(409);
    await api().post(`/api/v1/control-plan-revisions/${revB.body.id}/transitions`).set(owner).send({ action: 'submit' }).expect(200);
    const bApproved = await api().post(`/api/v1/control-plan-revisions/${revB.body.id}/transitions`).set(owner).send({ action: 'approve' }).expect(200);
    expect(bApproved.body.status).toBe('approved');
    const early = await api().post(`/api/v1/control-plan-revisions/${revB.body.id}/transitions`).set(owner).send({ action: 'make_effective' }).expect(409);
    expect(early.body.error.message).toMatch(/becomes effective on/);
    await api().post(`/api/v1/control-plan-revisions/${revB.body.id}/transitions`).set(owner).send({ action: 'obsolete' }).expect(400);
    await api().post(`/api/v1/control-plan-revisions/${revB.body.id}/transitions`).set(owner).send({ action: 'obsolete', reason: 'Replaced by C' }).expect(200);

    const revC = await api().post(`/api/v1/control-plans/${ctx.plan}/revisions`).set(owner).send({ revisionCode: 'C', changeReason: 'Groove check' }).expect(201);
    await api().post(`/api/v1/control-plan-revisions/${revC.body.id}/transitions`).set(owner).send({ action: 'submit' }).expect(200);
    await api().post(`/api/v1/control-plan-revisions/${revC.body.id}/transitions`).set(owner).send({ action: 'approve' }).expect(200);
    const plan = await api().get(`/api/v1/control-plans/${ctx.plan}`).set(owner).expect(200);
    expect(plan.body.effectiveRevision).toBe('C');
    expect(plan.body.openRevision).toBeNull();
    expect(plan.body.revisions.map((r: { revisionCode: string; status: string }) => `${r.revisionCode}:${r.status}`)).toEqual(['C:effective', 'B:obsolete', 'A:superseded']);
    expect(plan.body.revisions[2].effectiveUntil).not.toBeNull();

    const events = await admin.query(
      `select payload ->> 'to' as "to" from public.outbox_events where organisation_id = $1 and event_type = 'control_plan.revision.status_changed' order by created_at, id`,
      [ids.orgA],
    );
    expect(events.rows.map((r) => r.to).sort()).toEqual(
      ['approved', 'approved', 'approved', 'draft', 'effective', 'effective', 'obsolete', 'pending_approval', 'pending_approval', 'pending_approval', 'pending_approval', 'superseded'].sort(),
    );
    const history = await api().get(`/api/v1/control-plans/${ctx.plan}/history`).set(owner).expect(200);
    const types = new Set(history.body.data.map((e: { entityType: string }) => e.entityType));
    expect(types).toEqual(new Set(['control_plans', 'control_plan_applicability', 'control_plan_revisions']));
    const ownerEntry = history.body.data.find((e: { entityType: string; action: string }) => e.entityType === 'control_plans' && e.action === 'insert');
    expect(ownerEntry.names[ids.ownerA]).toBe('Ada Owner');
    // Revision updates carry only changed fields; the revision is named by its id.
    const statusChange = history.body.data.find((e: { entityType: string; entityId: string; action: string }) => e.entityType === 'control_plan_revisions' && e.entityId === ctx.revA && e.action === 'update');
    expect(statusChange.names[ctx.revA]).toBe('revision A');
  });

  it('filters plans by status', async () => {
    const h = await as(ids.ownerA);
    await api().post('/api/v1/control-plans').set(h).send({ planCode: 'CP-NEW', title: 'Not yet effective' }).expect(201);
    const none = await api().get('/api/v1/control-plans?status=no_effective').set(h).expect(200);
    expect(none.body.data.map((p: { planCode: string }) => p.planCode)).toEqual(['CP-NEW']);
    const eff = await api().get('/api/v1/control-plans?status=effective').set(h).expect(200);
    expect(eff.body.data.map((p: { planCode: string }) => p.planCode)).toEqual(['CP-HCR-001']);
  });
});
