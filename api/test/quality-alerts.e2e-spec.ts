/**
 * DOC1 through the API: drafting, numbering, scope and targets, issuing, the frozen rule, revisions, withdrawal, discard,
 * expiry, permissions and tenant isolation.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a8');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};
const TOMORROW = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const TODAY = new Date().toISOString().slice(0, 10);
const NEXT_WEEK = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-qalerts');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA);
  const fam = (await api().post('/api/v1/part-families').set(h).send({ code: 'HCR', name: 'Rods' }).expect(201)).body;
  ctx.family = fam.id;
  ctx.part = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'HCR-100', name: 'Rod 100', partFamilyId: fam.id, initialRevision: { revision: 'A' } }).expect(201)).body.id;
  ctx.machine = (await api().post('/api/v1/machines').set(h).send({ code: 'L1', name: 'Lathe 1', siteId: ids.siteA }).expect(201)).body.id;
  ctx.dept = (await api().post('/api/v1/departments').set(h).send({ siteId: ids.siteA, code: 'GI', name: 'Goods-in' }).expect(201)).body.id;
  // Issuing needs somebody to reach: the inspector works in Goods-in.
  await admin.query(`insert into public.department_members (organisation_id, department_id, membership_id)
    select $1, $2, id from public.organisation_users where organisation_id = $1 and user_id = $3`, [ids.orgA, ctx.dept, ids.inspectorA]);
  const roles = (await api().get('/api/v1/roles').set(h).expect(200)).body.data;
  ctx.inspectorRole = roles.find((r: { key: string }) => r.key === 'inspector').id;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

const scope = () => ({
  parts: [{ partId: ctx.part }, { partFamilyId: ctx.family }],
  machines: [ctx.machine],
  operations: ['OP-020'],
  departments: [ctx.dept],
  targets: [{ departmentId: ctx.dept }, { roleId: ctx.inspectorRole }],
});

describe('drafting', () => {
  it('creates a numbered draft with only a title, category and severity', async () => {
    const res = (await api().post('/api/v1/quality-alerts').set(await as(ids.ownerA)).send({ title: 'Incorrect material specification', category: 'product', severity: 'high' }).expect(201)).body;
    expect(res).toMatchObject({ number: 1, reference: 'QA-001', revision: 1, revisionLetter: 'A', status: 'draft', inForce: false, description: null });
    expect(res.revisions).toHaveLength(1);
    ctx.a1 = res.id;
    const second = (await api().post('/api/v1/quality-alerts').set(await as(ids.ownerA)).send({ title: 'Gauge out of calibration', category: 'equipment', severity: 'medium' }).expect(201)).body;
    expect(second.reference).toBe('QA-002');
    ctx.a2 = second.id;
  });

  it('refuses bad input', async () => {
    const h = await as(ids.ownerA);
    await api().post('/api/v1/quality-alerts').set(h).send({ title: 'x', category: 'weather', severity: 'high' }).expect(400);
    await api().post('/api/v1/quality-alerts').set(h).send({ title: '', category: 'product', severity: 'high' }).expect(400);
    await api().post('/api/v1/quality-alerts').set(h).send({ title: 'x', category: 'product', severity: 'high', status: 'active' }).expect(400);
    await api().patch(`/api/v1/quality-alerts/${ctx.a1}`).set(h).send({}).expect(400);
  });

  it('edits content and replaces scope and targets in one call, with labels', async () => {
    const res = (await api().patch(`/api/v1/quality-alerts/${ctx.a1}`).set(await as(ids.ownerA)).send({
      description: 'The certificate says 4140, the drawing needs 4340.',
      actions: [{ description: 'Quarantine lot 77 and tell your supervisor.' }],
      effectiveDate: TODAY,
      acknowledgeBy: TOMORROW,
      expiryDate: NEXT_WEEK,
      scope: scope(),
    }).expect(200)).body;
    expect(res).toMatchObject({ description: expect.stringContaining('4340'), effectiveDate: TODAY, acknowledgeBy: TOMORROW, expiryDate: NEXT_WEEK });
    expect(res.scope.parts.map((p: { kind: string; label: string }) => [p.kind, p.label])).toEqual([['family', 'HCR · Rods'], ['part', 'HCR-100 · Rod 100']]);
    expect(res.scope.machines).toEqual([expect.objectContaining({ machineId: ctx.machine, label: 'L1 · Lathe 1' })]);
    expect(res.actions).toEqual([expect.objectContaining({ position: 1, description: 'Quarantine lot 77 and tell your supervisor.', departmentId: null, machineId: null })]);
    expect(res.scope.operations).toEqual(['OP-020']);
    expect(res.scope.departments[0]).toMatchObject({ departmentId: ctx.dept, label: expect.stringMatching(/^GI · Goods-in/) });
    expect(res.scope.targets.map((t: { kind: string }) => t.kind).sort()).toEqual(['department', 'role']);
    const again = (await api().patch(`/api/v1/quality-alerts/${ctx.a1}`).set(await as(ids.ownerA)).send({ scope: scope() }).expect(200)).body;
    expect(again.scope.targets).toHaveLength(2);
    const bad = await api().patch(`/api/v1/quality-alerts/${ctx.a1}`).set(await as(ids.ownerA)).send({ scope: { machines: ['00000000-0000-0000-0000-000000000000'] } });
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });

  it('actions are line items for departments and machines, replaced in the order given, with labels', async () => {
    const h = await as(ids.ownerA);
    const res = (await api().patch(`/api/v1/quality-alerts/${ctx.a1}`).set(h).send({
      actions: [
        { description: 'Quarantine lot 77.', departmentId: ctx.dept },
        { description: 'Re-check the first piece.', machineId: ctx.machine },
        { description: 'Tell your supervisor.' },
      ],
    }).expect(200)).body;
    expect(res.actions.map((x: { position: number; description: string }) => [x.position, x.description])).toEqual([[1, 'Quarantine lot 77.'], [2, 'Re-check the first piece.'], [3, 'Tell your supervisor.']]);
    expect(res.actions[0]).toMatchObject({ departmentId: ctx.dept, departmentLabel: expect.stringMatching(/^GI · Goods-in/), machineId: null });
    expect(res.actions[1]).toMatchObject({ machineId: ctx.machine, machineLabel: 'L1 · Lathe 1' });
    await api().patch(`/api/v1/quality-alerts/${ctx.a1}`).set(h).send({ actions: [{ description: ' ' }] }).expect(400);
    await api().patch(`/api/v1/quality-alerts/${ctx.a1}`).set(h).send({ actions: [{ description: 'x', machineId: '00000000-0000-0000-0000-000000000000' }] }).expect((r) => expect(r.status).toBeGreaterThanOrEqual(400));
    expect((await api().get(`/api/v1/quality-alerts/${ctx.a1}`).set(h).expect(200)).body.actions).toHaveLength(3); // a refused change leaves them
    await api().patch(`/api/v1/quality-alerts/${ctx.a1}`).set(h).send({ requiredAction: 'old field' }).expect(400);
  });

  it('drafts are seen by those who manage documentation, not by others', async () => {
    const inspector = await as(ids.inspectorA);
    expect((await api().get('/api/v1/quality-alerts').set(inspector).expect(200)).body.data).toEqual([]);
    await api().get(`/api/v1/quality-alerts/${ctx.a1}`).set(inspector).expect(404);
    const owner = (await api().get('/api/v1/quality-alerts').set(await as(ids.ownerA)).expect(200)).body.data;
    expect(owner.map((a: { reference: string }) => a.reference)).toEqual(['QA-002', 'QA-001']);
    await api().post('/api/v1/quality-alerts').set(inspector).send({ title: 'x', category: 'product', severity: 'low' }).expect(403);
  });
});

describe('issuing', () => {
  it('needs documentation.issue, a complete alert and at least one target', async () => {
    const owner = await as(ids.ownerA);
    expect((await api().post(`/api/v1/quality-alerts/${ctx.a2}/issue`).set(owner)).status).toBe(409);
    const incomplete = await api().post(`/api/v1/quality-alerts/${ctx.a2}/issue`).set(owner);
    expect(incomplete.body.error.code).toBe('documentation_rule');
    expect(incomplete.body.error.message).toMatch(/Describe the issue/);
    await api().post(`/api/v1/quality-alerts/${ctx.a1}/issue`).set(await as(ids.inspectorA)).expect(403);
  });

  it('issues, freezes the content, and makes it visible to everyone with read access', async () => {
    const res = (await api().post(`/api/v1/quality-alerts/${ctx.a1}/issue`).set(await as(ids.ownerA)).expect(200)).body;
    expect(res).toMatchObject({ status: 'active', inForce: true, issuedBy: { id: ids.ownerA } });
    const edit = await api().patch(`/api/v1/quality-alerts/${ctx.a1}`).set(await as(ids.ownerA)).send({ title: 'Changed' }).expect(409);
    expect(edit.body.error.code).toBe('documentation_rule');
    await api().delete(`/api/v1/quality-alerts/${ctx.a1}`).set(await as(ids.ownerA)).expect(409);
    const seen = (await api().get('/api/v1/quality-alerts').set(await as(ids.inspectorA)).expect(200)).body.data;
    expect(seen.map((a: { reference: string }) => a.reference)).toEqual(['QA-001']);
    expect((await api().get(`/api/v1/quality-alerts/${ctx.a1}`).set(await as(ids.inspectorA)).expect(200)).body.scope.targets).toHaveLength(2);
  });
});

describe('revisions, withdrawal, discard and expiry', () => {
  it('a revision is a draft copy with a reason; issuing it supersedes the old one', async () => {
    const owner = await as(ids.ownerA);
    await api().post(`/api/v1/quality-alerts/${ctx.a1}/revisions`).set(owner).send({ reason: '  ' }).expect(400);
    const rev = (await api().post(`/api/v1/quality-alerts/${ctx.a1}/revisions`).set(owner).send({ reason: 'It was lot 76, not 77' }).expect(201)).body;
    expect(rev).toMatchObject({ reference: 'QA-001', revision: 2, revisionLetter: 'B', status: 'draft', supersedesId: ctx.a1, revisionReason: 'It was lot 76, not 77', effectiveDate: null });
    expect(rev.scope.targets).toHaveLength(2);
    expect(rev.revisions.map((r: { revisionLetter: string; status: string }) => [r.revisionLetter, r.status])).toEqual([['B', 'draft'], ['A', 'active']]);
    const twice = await api().post(`/api/v1/quality-alerts/${ctx.a1}/revisions`).set(owner).send({ reason: 'again' }).expect(409);
    expect(twice.body.error.message).toMatch(/already a draft revision/);
    await api().patch(`/api/v1/quality-alerts/${rev.id}`).set(owner).send({ title: 'Incorrect material specification (lot 76)', effectiveDate: TODAY, acknowledgeBy: TOMORROW }).expect(200);
    await api().post(`/api/v1/quality-alerts/${rev.id}/issue`).set(owner).expect(200);
    const old = (await api().get(`/api/v1/quality-alerts/${ctx.a1}`).set(owner).expect(200)).body;
    expect(old).toMatchObject({ status: 'superseded', inForce: false });
    ctx.rev2 = rev.id;
    // The register lists the newest revision once.
    const list = (await api().get('/api/v1/quality-alerts?q=QA-001').set(owner).expect(200)).body.data;
    expect(list).toEqual([expect.objectContaining({ id: rev.id, revisionLetter: 'B', status: 'active' })]);
    expect((await api().get('/api/v1/quality-alerts?status=superseded').set(owner).expect(200)).body.data.map((a: { id: string }) => a.id)).toEqual([ctx.a1]);
  });

  it('withdrawing needs a reason and keeps it', async () => {
    const owner = await as(ids.ownerA);
    await api().post(`/api/v1/quality-alerts/${ctx.rev2}/withdraw`).set(owner).send({}).expect(400);
    const res = (await api().post(`/api/v1/quality-alerts/${ctx.rev2}/withdraw`).set(owner).send({ reason: 'Issued in error' }).expect(200)).body;
    expect(res).toMatchObject({ status: 'withdrawn', inForce: false, withdrawn: { reason: 'Issued in error', by: { id: ids.ownerA } } });
    await api().post(`/api/v1/quality-alerts/${ctx.rev2}/withdraw`).set(owner).send({ reason: 'again' }).expect(409);
  });

  it('a draft can be discarded and then disappears', async () => {
    const owner = await as(ids.ownerA);
    await api().delete(`/api/v1/quality-alerts/${ctx.a2}`).set(owner).expect(204);
    await api().get(`/api/v1/quality-alerts/${ctx.a2}`).set(owner).expect(404);
    expect((await api().get('/api/v1/quality-alerts?q=QA-002').set(owner).expect(200)).body.data).toEqual([]);
  });

  it('an active alert past its expiry date is expired when next read', async () => {
    const owner = await as(ids.ownerA);
    const a = (await api().post('/api/v1/quality-alerts').set(owner).send({
      title: 'Temporary inspection frequency change', category: 'process', severity: 'low', description: 'd', actions: [{ description: 'Inspect every 30 minutes.' }],
      effectiveDate: TODAY, expiryDate: NEXT_WEEK, scope: { targets: [{ departmentId: ctx.dept }] },
    }).expect(201)).body;
    await api().post(`/api/v1/quality-alerts/${a.id}/issue`).set(owner).expect(200);
    expect((await api().get(`/api/v1/quality-alerts/${a.id}`).set(owner).expect(200)).body.status).toBe('active');
    // Admin time travel: the expiry date moves into the past.
    await admin.query(`alter table public.quality_alerts disable trigger quality_alerts_rules`);
    await admin.query(`update public.quality_alerts set expiry_date = current_date - 1, effective_date = current_date - 3 where id = $1`, [a.id]);
    await admin.query(`alter table public.quality_alerts enable trigger quality_alerts_rules`);
    const after = (await api().get(`/api/v1/quality-alerts/${a.id}`).set(owner).expect(200)).body;
    expect(after).toMatchObject({ status: 'expired', inForce: false });
    expect(after.history).toEqual([expect.objectContaining({ kind: 'expired', by: null, previousExpiry: expect.any(String), newExpiry: null })]);
    // Reopening: needs documentation.issue, a new expiry from today and a reason; it is logged.
    await api().post(`/api/v1/quality-alerts/${a.id}/reopen`).set(await as(ids.inspectorA)).send({ expiryDate: NEXT_WEEK, reason: 'Still needed' }).expect(403);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    expect((await api().post(`/api/v1/quality-alerts/${a.id}/reopen`).set(owner).send({ expiryDate: yesterday, reason: 'Still needed' })).body.error.code).toBe('documentation_rule');
    await api().post(`/api/v1/quality-alerts/${a.id}/reopen`).set(owner).send({ expiryDate: NEXT_WEEK }).expect(400);
    const reopened = (await api().post(`/api/v1/quality-alerts/${a.id}/reopen`).set(owner).send({ expiryDate: NEXT_WEEK, reason: 'Still needed for the next batch' }).expect(200)).body;
    expect(reopened).toMatchObject({ status: 'active', inForce: true, expiryDate: NEXT_WEEK });
    expect(reopened.history.map((h: { kind: string }) => h.kind)).toEqual(['expired', 'reopened']);
    expect(reopened.history[1]).toMatchObject({ kind: 'reopened', previousExpiry: expect.any(String), newExpiry: NEXT_WEEK, reason: 'Still needed for the next batch', by: { id: ids.ownerA } });
    expect((await api().post(`/api/v1/quality-alerts/${a.id}/reopen`).set(owner).send({ expiryDate: NEXT_WEEK, reason: 'Again' })).body.error.code).toBe('documentation_rule'); // it is active now
    const revision = await api().post(`/api/v1/quality-alerts/${a.id}/revisions`).set(owner).send({ reason: 'Extend it' });
    expect(revision.status).toBe(201);
  });
});

describe('isolation', () => {
  it('another organisation sees and changes nothing', async () => {
    const other = await as(ids.ownerB, ids.orgB);
    expect((await api().get('/api/v1/quality-alerts?status=all').set(other).expect(200)).body.data).toEqual([]);
    await api().get(`/api/v1/quality-alerts/${ctx.a1}`).set(other).expect(404);
    await api().post(`/api/v1/quality-alerts/${ctx.a1}/withdraw`).set(other).send({ reason: 'Hijacked' }).expect(404);
    await api().post(`/api/v1/quality-alerts/${ctx.a1}/revisions`).set(other).send({ reason: 'Hijacked' }).expect(404);
    const first = (await api().post('/api/v1/quality-alerts').set(other).send({ title: 'Beta alert', category: 'safety', severity: 'critical' }).expect(201)).body;
    expect(first.reference).toBe('QA-001'); // numbering is per organisation
  });
});
