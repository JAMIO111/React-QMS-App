/**
 * Operator jobs through the API: preview (what is derived, what is asked, what blocks), start from a machine and a part, the
 * quantity only when a check is sampled every N parts, the operation only when the plan has several, work order and quantity
 * afterwards, the caller's own jobs, recent non-conformances and recent revisions, and permissions.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { categoryId, makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('f');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};

const makePart = async (h: Record<string, string>, family: string, partNumber: string, planCode: string, ops: string[], sampling: object[]) => {
  const fam = (await api().post('/api/v1/part-families').set(h).send({ code: family, name: family }).expect(201)).body;
  const part = (await api().post('/api/v1/parts').set(h).send({ partNumber, name: partNumber, partFamilyId: fam.id, initialRevision: { revision: 'A' } }).expect(201)).body;
  const plan = (await api().post('/api/v1/control-plans').set(h).send({ planCode, title: planCode, partFamilyId: fam.id }).expect(201)).body;
  const rev = plan.revisions[0].id;
  for (const code of ops) {
    const op = (await api().post(`/api/v1/control-plan-revisions/${rev}/operations`).set(h).send({ operationCode: code, name: `Op ${code}` }).expect(201)).body.operations.find((o: { operationCode: string }) => o.operationCode === code).id;
    await api().post(`/api/v1/control-plan-revisions/${rev}/characteristics`).set(h).send({ operationId: op, characteristicKey: `V${code}`, name: `Visual ${code}`, dataType: 'attribute', sampling }).expect(201);
  }
  await api().patch(`/api/v1/control-plan-revisions/${rev}`).set(h).send({ changeReason: 'First' }).expect(200);
  return { partId: part.id as string, familyId: fam.id as string, partRevision: part.revisions[0].id as string, planRev: rev as string };
};
const ready = async (h: Record<string, string>, p: { partRevision: string; planRev: string }) => {
  await api().post(`/api/v1/part-revisions/${p.partRevision}/release`).set(h).expect(200);
  await api().post(`/api/v1/control-plan-revisions/${p.planRev}/transitions`).set(h).send({ action: 'submit' }).expect(200);
  await api().post(`/api/v1/control-plan-revisions/${p.planRev}/transitions`).set(h).send({ action: 'approve' }).expect(200);
};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-jobs');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA);
  ctx.machine = (await api().post('/api/v1/machines').set(h).send({ code: 'CNC-1', name: 'Lathe 1' }).expect(201)).body.id;
  ctx.machine2 = (await api().post('/api/v1/machines').set(h).send({ code: 'CNC-2', name: 'Lathe 2' }).expect(201)).body.id;
  // P1: one operation, sampled every N parts. P2: two operations, first-off only.
  const p1 = await makePart(h, 'ROD', 'ROD-1', 'CP-ROD', ['OP-10'], [{ triggerType: 'first_off', sampleSize: 1 }, { triggerType: 'every_n_parts', intervalValue: 50, sampleSize: 1 }]);
  const p2 = await makePart(h, 'PIN', 'PIN-1', 'CP-PIN', ['OP-10', 'OP-20'], [{ triggerType: 'first_off', sampleSize: 1 }]);
  Object.assign(ctx, { p1: p1.partId, p1Family: p1.familyId, p1Rev: p1.partRevision, p1PlanRev: p1.planRev, p2: p2.partId });
  ctx.pending = p1.partId;
  ctx.p2prep = JSON.stringify(p2);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

const q = (machineId: string, partId: string, extra = '') => `machineId=${machineId}&partId=${partId}${extra}`;

describe('preview and start', () => {
  it('says why a part cannot be inspected yet, and refuses to start', async () => {
    const h = await as(ids.ownerA);
    const p = (await api().get(`/api/v1/jobs/preview?${q(ctx.machine, ctx.p1)}`).set(h).expect(200)).body;
    expect(p.status).toBe('blocked');
    expect(p.problems.length).toBeGreaterThan(0);
    const res = await api().post('/api/v1/jobs').set(h).send({ machineId: ctx.machine, partId: ctx.p1 }).expect(409);
    expect(res.body.error.code).toBe('inspection_rule');
    await ready(h, { partRevision: ctx.p1Rev, planRev: ctx.p1PlanRev });
    const p2 = JSON.parse(ctx.p2prep);
    await ready(h, p2);
  });

  it('works out the site, operation and what is still to be asked', async () => {
    const h = await as(ids.ownerA);
    const p = (await api().get(`/api/v1/jobs/preview?${q(ctx.machine, ctx.p1)}`).set(h).expect(200)).body;
    expect(p).toMatchObject({
      status: 'ok', machine: { code: 'CNC-1' }, part: { partNumber: 'ROD-1' }, site: { id: ids.siteA }, needsOperation: false, operationCode: 'OP-10', needsLotSize: true,
      partRevision: 'A', plan: { planCode: 'CP-ROD', revisionCode: 'A' },
    });
    const two = (await api().get(`/api/v1/jobs/preview?${q(ctx.machine, ctx.p2)}`).set(h).expect(200)).body;
    expect(two).toMatchObject({ needsOperation: true, operationCode: null, needsLotSize: false });
    expect(two.operations.map((o: { code: string }) => o.code)).toEqual(['OP-10', 'OP-20']);
    const chosen = (await api().get(`/api/v1/jobs/preview?${q(ctx.machine, ctx.p2, '&operationCode=OP-20')}`).set(h).expect(200)).body;
    expect(chosen).toMatchObject({ needsOperation: false, operationCode: 'OP-20' });
  });

  it('resolves the control plan from the part alone, before any machine is chosen', async () => {
    const h = await as(ids.ownerA);
    const p = (await api().get(`/api/v1/jobs/preview?partId=${ctx.p2}`).set(h).expect(200)).body;
    expect(p).toMatchObject({ machine: null, status: 'ok', plan: { planCode: 'CP-PIN', revisionCode: 'A' }, needsOperation: true });
    expect(p.operations.map((o: { code: string }) => o.code)).toEqual(['OP-10', 'OP-20']);
    await api().get(`/api/v1/jobs/preview?partId=${ctx.p1}&machineId=${ids.orgB}`).set(h).expect(404);
    await api().post('/api/v1/jobs').set(h).send({ partId: ctx.p2, operationCode: 'OP-10' }).expect(400); // starting still needs a machine
  });

  it('asks for the quantity only when a check is sampled every N parts, and for the operation only when there are several', async () => {
    const h = await as(ids.ownerA);
    expect((await api().post('/api/v1/jobs').set(h).send({ machineId: ctx.machine, partId: ctx.p1 }).expect(400)).body.error.code).toBe('lot_size_required');
    expect((await api().post('/api/v1/jobs').set(h).send({ machineId: ctx.machine, partId: ctx.p2 }).expect(400)).body.error.code).toBe('operation_required');
    expect((await api().post('/api/v1/jobs').set(h).send({ machineId: ctx.machine, partId: ctx.p2, operationCode: 'OP-99' }).expect(400)).body.error.code).toBe('invalid_operation');
    await api().post('/api/v1/jobs').set(h).send({ machineId: ctx.machine, partId: ctx.p1, lotSize: 0 }).expect(400);
    await api().post('/api/v1/jobs').set(h).send({ machineId: ctx.machine, partId: ctx.p1, hacked: true }).expect(400);
    await api().post('/api/v1/jobs').set(h).send({ machineId: ids.orgB, partId: ctx.p1, lotSize: 10 }).expect(404);
  });

  it('starts a job from a machine and a part, as the signed-in operator', async () => {
    const h = await as(ids.inspectorA);
    const job = (await api().post('/api/v1/jobs').set(h).send({ machineId: ctx.machine, partId: ctx.p1, lotSize: 200 }).expect(201)).body;
    ctx.job = job.id;
    expect(job).toMatchObject({
      status: 'in_progress', part: { partNumber: 'ROD-1' }, machine: { code: 'CNC-1' }, site: { id: ids.siteA }, operationCode: 'OP-10', triggerType: 'first_off',
      workOrder: null, lotSize: 200, startedBy: { id: ids.inspectorA },
    });
    const h2 = await as(ids.ownerA);
    const two = (await api().post('/api/v1/jobs').set(h2).send({ machineId: ctx.machine2, partId: ctx.p2, operationCode: 'OP-20' }).expect(201)).body;
    ctx.job2 = two.id;
    expect(two).toMatchObject({ operationCode: 'OP-20', triggerType: 'first_off', lotSize: null });
  });
});

describe('job details', () => {
  it('sets and clears the work order, lot, quantity and serial while the job runs', async () => {
    const h = await as(ids.inspectorA);
    const set = (await api().patch(`/api/v1/jobs/${ctx.job}`).set(h).send({ workOrder: ' WO-5001 ', lot: 'L-9', lotSize: 250, serial: 'S-1' }).expect(200)).body;
    expect(set).toMatchObject({ workOrder: 'WO-5001', lot: 'L-9', lotSize: 250, serial: 'S-1' });
    const cleared = (await api().patch(`/api/v1/jobs/${ctx.job}`).set(h).send({ serial: null }).expect(200)).body;
    expect(cleared).toMatchObject({ workOrder: 'WO-5001', lot: 'L-9', lotSize: 250, serial: null });
  });

  it('validates the body', async () => {
    const h = await as(ids.inspectorA);
    await api().patch(`/api/v1/jobs/${ctx.job}`).set(h).send({}).expect(400);
    await api().patch(`/api/v1/jobs/${ctx.job}`).set(h).send({ lotSize: 0 }).expect(400);
    await api().patch(`/api/v1/jobs/${ctx.job}`).set(h).send({ workOrder: 'x'.repeat(61) }).expect(400);
    await api().patch(`/api/v1/jobs/${ctx.job}`).set(h).send({ machineId: ctx.machine2 }).expect(400);
    await api().patch(`/api/v1/jobs/not-a-uuid`).set(h).send({ lot: 'x' }).expect(400);
  });

  it('is only for a job in progress', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/inspections/${ctx.job2}/abandon`).set(h).send({ reason: 'Wrong part' }).expect(200);
    const res = await api().patch(`/api/v1/jobs/${ctx.job2}`).set(h).send({ workOrder: 'WO-LATE' }).expect(409);
    expect(res.body.error.code).toBe('inspection_rule');
  });
});

describe('my jobs', () => {
  it('lists only the caller’s running jobs', async () => {
    const mine = (await api().get('/api/v1/jobs/mine').set(await as(ids.inspectorA)).expect(200)).body;
    expect(mine.data.map((r: { id: string }) => r.id)).toEqual([ctx.job]);
    const owner = (await api().get('/api/v1/jobs/mine').set(await as(ids.ownerA)).expect(200)).body;
    expect(owner.data.map((r: { id: string }) => r.id)).not.toContain(ctx.job); // the owner's job was abandoned
    expect(owner.total).toBe(0);
  });
});

describe('recent non-conformances', () => {
  it('shows NCs of the same part and family, open first, not another part’s and not cancelled ones', async () => {
    const h = await as(ids.ownerA);
    const nc = async (partId: string, title: string, open: boolean) => {
      const id = (await api().post('/api/v1/ncrs').set(h).send({ source: 'internal', title, partId, siteId: ids.siteA }).expect(201)).body.id;
      if (open) {
        await api().patch(`/api/v1/ncrs/${id}`).set(h).send({ severity: 'minor', quantityAffected: 2, description: title, categoryId: await categoryId(admin, ids.orgA) }).expect(200);
        await api().post(`/api/v1/ncrs/${id}/transitions`).set(h).send({ to: 'open' }).expect(200);
      }
      return id;
    };
    ctx.ncSame = await nc(ctx.p1, 'Rod burr', true);
    await nc(ctx.p2, 'Pin chatter', true); // another part, another family: not shown
    ctx.ncDraft = await nc(ctx.p1, 'Draft only', false); // drafts are not shown
    const res = (await api().get(`/api/v1/jobs/${ctx.job}/recent-ncrs`).set(await as(ids.inspectorA)).expect(200)).body;
    expect(res).toMatchObject({ canRead: true, days: 90 });
    expect(res.data.map((n: { title: string }) => n.title)).toEqual(['Rod burr']);
    expect(res.data[0]).toMatchObject({ id: ctx.ncSame, source: 'internal', matched: ['part'], open: true, severity: 'minor', part: { partNumber: 'ROD-1' } });
    expect(res.data.map((n: { id: string }) => n.id)).not.toContain(ctx.ncDraft);
  });

  it('includes an NC of another part when it was raised from an inspection on the same machine', async () => {
    const h = await as(ids.ownerA);
    const other = (await api().post('/api/v1/ncrs').set(h).send({ source: 'internal', title: 'Pin on the same lathe', partId: ctx.p2, siteId: ids.siteA }).expect(201)).body.id;
    await api().patch(`/api/v1/ncrs/${other}`).set(h).send({ severity: 'minor', quantityAffected: 1, description: 'x', categoryId: await categoryId(admin, ids.orgA) }).expect(200);
    await api().post(`/api/v1/ncrs/${other}/transitions`).set(h).send({ to: 'open' }).expect(200);
    // job2 ran on CNC-2 (abandoned); link the NC to the running job's inspection (machine CNC-1) as the raise-from-inspection function would.
    await admin.query(`insert into public.inspection_ncr_links (organisation_id, nonconformance_id, inspection_record_id) values ($1, $2, $3)`, [ids.orgA, other, ctx.job]);
    const res = (await api().get(`/api/v1/jobs/${ctx.job}/recent-ncrs`).set(await as(ids.inspectorA)).expect(200)).body;
    const found = res.data.find((n: { id: string }) => n.id === other);
    expect(found.matched).toEqual(expect.arrayContaining(['machine', 'operation']));
    expect(found.matched).not.toContain('part');
    expect(res.data.map((n: { title: string }) => n.title)).not.toContain('Pin chatter');
  });

  it('validates ?days', async () => {
    const h = await as(ids.ownerA);
    await api().get(`/api/v1/jobs/${ctx.job}/recent-ncrs?days=0`).set(h).expect(400);
    await api().get(`/api/v1/jobs/${ctx.job}/recent-ncrs?days=7`).set(h).expect(200);
  });
});

describe('recent revisions', () => {
  it('flags the revisions in force, new ones, and the one the job runs on', async () => {
    const h = await as(ids.inspectorA);
    const res = (await api().get(`/api/v1/jobs/${ctx.job}/revisions`).set(h).expect(200)).body;
    expect(res).toMatchObject({ days: 30, partRevisionSuperseded: false, planRevisionSuperseded: false });
    expect(res.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'part_revision', revision: 'A', subject: 'ROD-1', current: true, runningOnIt: true, isNew: true }),
      expect.objectContaining({ kind: 'plan_revision', revision: 'A', subject: 'CP-ROD', current: true, runningOnIt: true, isNew: true, changeSummary: 'First' }),
    ]));
  });

  it('says when the job runs on a revision that has since been replaced', async () => {
    const h = await as(ids.ownerA);
    const rev = (await api().post(`/api/v1/control-plans/${(await api().get('/api/v1/control-plans?q=CP-ROD').set(h).expect(200)).body.data[0].id}/revisions`).set(h).send({ revisionCode: 'B' }).expect(201)).body;
    const planRev = rev.revisions?.find((r: { revisionCode: string }) => r.revisionCode === 'B')?.id ?? rev.id;
    await api().patch(`/api/v1/control-plan-revisions/${planRev}`).set(h).send({ changeReason: 'Tighter sampling' }).expect(200);
    await api().post(`/api/v1/control-plan-revisions/${planRev}/transitions`).set(h).send({ action: 'submit' }).expect(200);
    await api().post(`/api/v1/control-plan-revisions/${planRev}/transitions`).set(h).send({ action: 'approve' }).expect(200);
    const res = (await api().get(`/api/v1/jobs/${ctx.job}/revisions`).set(h).expect(200)).body;
    expect(res.planRevisionSuperseded).toBe(true);
    expect(res.data.find((r: { revision: string; kind: string }) => r.kind === 'plan_revision' && r.revision === 'B')).toMatchObject({ current: true, runningOnIt: false });
  });
});

describe('permissions and tenancy', () => {
  it('needs inspection.record, and another organisation sees nothing', async () => {
    const viewer = await as(ids.dual);
    await api().get(`/api/v1/jobs/preview?${q(ctx.machine, ctx.p1)}`).set(viewer).expect(403);
    await api().post('/api/v1/jobs').set(viewer).send({ machineId: ctx.machine, partId: ctx.p1, lotSize: 5 }).expect(403);
    await api().get('/api/v1/jobs/mine').set(viewer).expect(403);
    await api().get(`/api/v1/jobs/${ctx.job}/revisions`).set(viewer).expect(403);
    const other = await as(ids.ownerB, ids.orgB);
    await api().get(`/api/v1/jobs/${ctx.job}/recent-ncrs`).set(other).expect(404);
    await api().patch(`/api/v1/jobs/${ctx.job}`).set(other).send({ workOrder: 'HIJACK' }).expect(404);
    await api().get(`/api/v1/jobs/preview?${q(ctx.machine, ctx.p1)}`).set(other).expect(404);
    await api().get('/api/v1/jobs/mine').set(await as(ids.inspectorA)).expect(200);
  });
});
