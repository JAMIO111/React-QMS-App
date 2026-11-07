/**
 * Correcting a released part revision through the API: start (reason, rights), the draft, the impact list, release, what new and old inspections use, the frozen
 * wrong version, the job hub's superseded flag, and tenancy. The rules themselves are tested in supabase/tests/part_revision_correction.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('f1');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-corr');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA);
  const fam = (await api().post('/api/v1/part-families').set(h).send({ code: 'COR', name: 'Corrected' }).expect(201)).body;
  const part = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'COR-1', name: 'Corrected part', partFamilyId: fam.id, initialRevision: { revision: 'A', drawingRef: 'DWG-1' } }).expect(201)).body;
  ctx.part = part.id;
  ctx.v1 = part.revisions[0].id;
  await api().post(`/api/v1/part-revisions/${ctx.v1}/characteristics`).set(h).send({ characteristicKey: 'LENGTH', nominal: 100, lowerLimit: 99.9, upperLimit: 100.1, unitCode: 'mm' }).expect(201);
  const plan = (await api().post('/api/v1/control-plans').set(h).send({ planCode: 'CP-COR', title: 'Plan', partFamilyId: fam.id }).expect(201)).body;
  const rev = plan.revisions[0].id;
  const op = (await api().post(`/api/v1/control-plan-revisions/${rev}/operations`).set(h).send({ operationCode: 'OP-10', name: 'Turning' }).expect(201)).body.operations[0].id;
  await api().post(`/api/v1/control-plan-revisions/${rev}/characteristics`).set(h).send({ operationId: op, characteristicKey: 'VISUAL', name: 'No chatter', dataType: 'attribute', sampling: [{ triggerType: 'first_off', sampleSize: 1 }] }).expect(201);
  await api().patch(`/api/v1/control-plan-revisions/${rev}`).set(h).send({ changeReason: 'First' }).expect(200);
  await api().post(`/api/v1/part-revisions/${ctx.v1}/release`).set(h).expect(200);
  await api().post(`/api/v1/control-plan-revisions/${rev}/transitions`).set(h).send({ action: 'submit' }).expect(200);
  await api().post(`/api/v1/control-plan-revisions/${rev}/transitions`).set(h).send({ action: 'approve' }).expect(200);
  // Work that ran on Rev A v1: a running inspection and a non-conformance.
  ctx.insp1 = (await api().post('/api/v1/inspections').set(h).send({ siteId: ids.siteA, partId: ctx.part }).expect(201)).body.id;
  ctx.ncr = (await api().post('/api/v1/ncrs').set(h).send({ source: 'internal', title: 'Length out', partId: ctx.part, partRevisionId: ctx.v1, siteId: ids.siteA }).expect(201)).body.id;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('starting a correction', () => {
  it('needs a reason and manage rights, and only works on the current released revision', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/part-revisions/${ctx.v1}/correction`).set(h).send({}).expect(400);
    await api().post(`/api/v1/part-revisions/${ctx.v1}/correction`).set(h).send({ reason: '   ' }).expect(400);
    await api().post(`/api/v1/part-revisions/${ctx.v1}/correction`).set(h).send({ reason: 'x', extra: true }).expect(400);
    await api().post(`/api/v1/part-revisions/${ctx.v1}/correction`).set(await as(ids.dual)).send({ reason: 'Not allowed' }).expect(403);
    const draft = (await api().post(`/api/v1/part-revisions/${ctx.v1}/correction`).set(h).send({ reason: '  Upper limit is 100.2 on the drawing  ' }).expect(201)).body;
    ctx.v2 = draft.id;
    expect(draft).toMatchObject({ revision: 'A', version: 2, status: 'draft', correctsId: ctx.v1, correctionReason: 'Upper limit is 100.2 on the drawing', drawingRef: 'DWG-1' });
    const dup = await api().post(`/api/v1/part-revisions/${ctx.v1}/correction`).set(h).send({ reason: 'Again' }).expect(409);
    expect(dup.body.error.code).toBe('invalid_revision_state');
    await api().post(`/api/v1/part-revisions/${ctx.v2}/correction`).set(h).send({ reason: 'A draft cannot be corrected' }).expect(409);
  });

  it('lists every version on the part, with the released one still the current', async () => {
    const part = (await api().get(`/api/v1/parts/${ctx.part}`).set(await as(ids.ownerA)).expect(200)).body;
    expect(part).toMatchObject({ currentRevision: 'A', currentVersion: 1 });
    expect(part.revisions.map((r: { version: number; status: string }) => [r.version, r.status]).sort()).toEqual([[1, 'released'], [2, 'draft']]);
  });

  it('is edited like any draft: the drawing reference, the summary and the copied values', async () => {
    const h = await as(ids.ownerA);
    await api().patch(`/api/v1/part-revisions/${ctx.v2}`).set(h).send({ changeSummary: 'Upper limit corrected' }).expect(200);
    const values = (await api().get(`/api/v1/part-revisions/${ctx.v2}/characteristics`).set(h).expect(200)).body.data;
    expect(values).toHaveLength(1);
    await api().patch(`/api/v1/part-revision-characteristics/${values[0].id}`).set(h).send({ upperLimit: 100.2 }).expect(200);
    await api().patch(`/api/v1/part-revisions/${ctx.v1}`).set(h).send({ drawingRef: 'Hijacked' }).expect(409); // the released version is still frozen
  });
});

describe('the impact list', () => {
  it('lists the running inspection and the non-conformance that used the version being replaced', async () => {
    const d = (await api().get(`/api/v1/part-revisions/${ctx.v2}/correction-impact`).set(await as(ids.ownerA)).expect(200)).body;
    expect(d.corrected).toMatchObject({ id: ctx.v1, revision: 'A', version: 1, status: 'released' });
    expect(d.correction).toMatchObject({ id: ctx.v2, version: 2, status: 'draft' });
    expect(d).toMatchObject({ canReadInspections: true, canReadNcrs: true, inspectionsTotal: 1, ncrsTotal: 1 });
    expect(d.inspections[0]).toMatchObject({ id: ctx.insp1, status: 'in_progress', operationCode: null, startedBy: 'Ada Owner' });
    expect(d.ncrs[0]).toMatchObject({ id: ctx.ncr, source: 'internal', title: 'Length out' });
  });

  it('shows people only what they may read: a viewer without inspection or NC access gets the flags and empty lists', async () => {
    const viewerRole = `(select id from public.roles where organisation_id = $1 and key = 'viewer')`;
    const removed = await admin.query(`delete from public.role_permissions where role_id = ${viewerRole} and permission_code in ('inspection.read', 'ncr.read') returning permission_code`, [ids.orgA]);
    expect(removed.rowCount).toBe(2);
    try {
      const d = (await api().get(`/api/v1/part-revisions/${ctx.v2}/correction-impact`).set(await as(ids.dual)).expect(200)).body;
      expect(d).toMatchObject({ canReadInspections: false, canReadNcrs: false, inspectionsTotal: 0, inspections: [], ncrsTotal: 0, ncrs: [] });
    } finally {
      for (const row of removed.rows) await admin.query(`insert into public.role_permissions (role_id, permission_code) select ${viewerRole}, $2`, [ids.orgA, row.permission_code]);
    }
  });

  it('says there is no correction for an ordinary revision', async () => {
    const part = (await api().get(`/api/v1/parts/${ctx.part}`).set(await as(ids.ownerA)).expect(200)).body;
    const plain = part.revisions.find((r: { version: number; status: string }) => r.version === 1);
    expect((await api().get(`/api/v1/part-revisions/${plain.id}/correction-impact`).set(await as(ids.ownerA)).expect(400)).body.error.code).toBe('not_a_correction');
  });
});

describe('releasing the correction', () => {
  it('needs rights', async () => {
    await api().post(`/api/v1/part-revisions/${ctx.v2}/release`).set(await as(ids.dual)).expect(403);
  });

  it('replaces the wrong version: it becomes corrected and the correction is the released one', async () => {
    const h = await as(ids.ownerA);
    const rel = (await api().post(`/api/v1/part-revisions/${ctx.v2}/release`).set(h).expect(200)).body;
    expect(rel).toMatchObject({ id: ctx.v2, revision: 'A', version: 2, status: 'released' });
    const part = (await api().get(`/api/v1/parts/${ctx.part}`).set(h).expect(200)).body;
    expect(part).toMatchObject({ currentRevision: 'A', currentVersion: 2 });
    const old = part.revisions.find((r: { id: string }) => r.id === ctx.v1);
    expect(old).toMatchObject({ status: 'corrected', correctedAt: expect.any(String) });
  });

  it('keeps the wrong version frozen and not correctable', async () => {
    const h = await as(ids.ownerA);
    expect((await api().patch(`/api/v1/part-revisions/${ctx.v1}`).set(h).send({ drawingRef: 'Hijacked' }).expect(409)).body.error.code).toBe('invalid_revision_state');
    await api().post(`/api/v1/part-revisions/${ctx.v1}/correction`).set(h).send({ reason: 'Too late' }).expect(409);
    await api().post(`/api/v1/part-revisions/${ctx.v1}/obsolete`).set(h).expect(409);
  });

  it('can be asked about from the corrected version too', async () => {
    const d = (await api().get(`/api/v1/part-revisions/${ctx.v1}/correction-impact`).set(await as(ids.ownerA)).expect(200)).body;
    expect(d.corrected).toMatchObject({ id: ctx.v1, status: 'corrected' });
    expect(d.correction).toMatchObject({ id: ctx.v2, status: 'released' });
    expect(d.inspectionsTotal).toBe(1);
  });

  it('sends new inspections to the corrected version and leaves the earlier one where it was', async () => {
    const h = await as(ids.ownerA);
    const second = (await api().post('/api/v1/inspections').set(h).send({ siteId: ids.siteA, partId: ctx.part }).expect(201)).body;
    expect(second.partRevision).toBe('A');
    const rows = (await admin.query(`select id, part_revision_id from public.inspection_records where id = any($1)`, [[ctx.insp1, second.id]])).rows;
    expect(Object.fromEntries(rows.map((r) => [r.id, r.part_revision_id]))).toEqual({ [ctx.insp1]: ctx.v1, [second.id]: ctx.v2 });
  });

  it('flags a job still running on the replaced version', async () => {
    const res = (await api().get(`/api/v1/jobs/${ctx.insp1}/revisions`).set(await as(ids.ownerA)).expect(200)).body;
    expect(res.partRevisionSuperseded).toBe(true);
    expect(res.data.find((r: { kind: string; current: boolean }) => r.kind === 'part_revision' && r.current)).toMatchObject({ revision: 'A', runningOnIt: false });
  });
});

describe('an ordinary revision after a correction', () => {
  it('still releases the usual way and supersedes the corrected version', async () => {
    const h = await as(ids.ownerA);
    const b = (await api().post(`/api/v1/parts/${ctx.part}/revisions`).set(h).send({ revision: 'B' }).expect(201)).body;
    await api().post(`/api/v1/part-revisions/${b.id}/release`).set(h).expect(200);
    const part = (await api().get(`/api/v1/parts/${ctx.part}`).set(h).expect(200)).body;
    expect(part).toMatchObject({ currentRevision: 'B', currentVersion: 1 });
    expect(part.revisions.find((r: { id: string }) => r.id === ctx.v2).status).toBe('superseded');
  });
});
