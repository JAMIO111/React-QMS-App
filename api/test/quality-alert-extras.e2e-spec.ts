/**
 * DOC3 through the API: alerts where work happens (active-for-context), attachments on drafts, links to NC/supplier/gauge/calibration,
 * revisions carrying files and links, permissions and isolation.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('b1');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};
const TODAY = new Date().toISOString().slice(0, 10);
const TOMORROW = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const UNKNOWN = '00000000-0000-0000-0000-000000000000';

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-qextras');
  await admin.query(`insert into storage.buckets (id, name) values ('quality-alert-files', 'quality-alert-files') on conflict do nothing`);
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA);
  const fam = (await api().post('/api/v1/part-families').set(h).send({ code: 'HCR', name: 'Rods' }).expect(201)).body;
  ctx.family = fam.id;
  ctx.part = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'HCR-100', name: 'Rod 100', partFamilyId: fam.id, initialRevision: { revision: 'A' } }).expect(201)).body.id;
  ctx.otherPart = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'OTH-1', name: 'Other', initialRevision: { revision: 'A' } }).expect(201)).body.id;
  ctx.machine = (await api().post('/api/v1/machines').set(h).send({ code: 'L1', name: 'Lathe 1', siteId: ids.siteA }).expect(201)).body.id;
  ctx.machine2 = (await api().post('/api/v1/machines').set(h).send({ code: 'L2', name: 'Lathe 2', siteId: ids.siteA }).expect(201)).body.id;
  ctx.supplier = (await api().post('/api/v1/suppliers').set(h).send({ code: 'BAR', name: 'Bar Co' }).expect(201)).body.id;
  ctx.ncr = (await api().post('/api/v1/ncrs').set(h).send({ source: 'internal', title: 'Scrapped batch', siteId: ids.siteA }).expect(201)).body.id;
  ctx.ncrB = (await api().post('/api/v1/ncrs').set(await as(ids.ownerB, ids.orgB)).send({ source: 'internal', title: 'At B', siteId: ids.siteB }).expect(201)).body.id;
  ctx.dept = (await api().post('/api/v1/departments').set(h).send({ siteId: ids.siteA, code: 'GI', name: 'Goods-in' }).expect(201)).body.id;
  await admin.query(`insert into public.department_members (organisation_id, department_id, membership_id)
    select $1, $2, id from public.organisation_users where organisation_id = $1 and user_id = $3`, [ids.orgA, ctx.dept, ids.inspectorA]);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

const draft = async (title: string, scope: object = {}, extra: object = {}) =>
  (await api().post('/api/v1/quality-alerts').set(await as(ids.ownerA)).send({
    title, category: 'process', severity: 'medium', description: 'd', requiredAction: 'Stop and check', effectiveDate: TODAY, acknowledgeBy: TOMORROW,
    scope: { targets: [{ departmentId: ctx.dept }], ...scope }, ...extra,
  }).expect(201)).body;
const issue = async (id: string) => api().post(`/api/v1/quality-alerts/${id}/issue`).set(await as(ids.ownerA)).expect(200);
const active = async (query: string, user = ids.inspectorA) => (await api().get(`/api/v1/quality-alerts/active?${query}`).set(await as(user)).expect(200)).body.data as {
  id: string; title: string; matched: string[]; acknowledged: boolean | null; severity: string;
}[];

describe('alerts where work happens', () => {
  it('finds issued alerts for the part, its family, the machine or the operation, and only those', async () => {
    const byPart = await draft('Part alert', { parts: [{ partId: ctx.part }] });
    const byFamily = await draft('Family alert', { parts: [{ partFamilyId: ctx.family }] }, { severity: 'critical' });
    const byMachine = await draft('Machine alert', { machines: [ctx.machine] });
    const byOp = await draft('Operation alert', { operations: ['OP-020'] }, { severity: 'low' });
    const unscoped = await draft('Applies to nobody in particular');
    const notIssued = await draft('Still a draft', { parts: [{ partId: ctx.part }] });
    for (const a of [byPart, byFamily, byMachine, byOp, unscoped]) await issue(a.id);
    Object.assign(ctx, { byPart: byPart.id, byFamily: byFamily.id, byMachine: byMachine.id, byOp: byOp.id, notIssued: notIssued.id });

    const forPart = await active(`partId=${ctx.part}`);
    expect(forPart.map((a) => a.title)).toEqual(['Family alert', 'Part alert']); // critical first, family found through the part
    expect(forPart.find((a) => a.title === 'Family alert')!.matched).toEqual(['family']);
    expect(forPart.find((a) => a.title === 'Part alert')!.matched).toEqual(['part']);

    expect((await active(`partFamilyId=${ctx.family}`)).map((a) => a.title)).toEqual(['Family alert']);
    expect((await active(`machineId=${ctx.machine}`)).map((a) => a.title)).toEqual(['Machine alert']);
    expect(await active(`machineId=${ctx.machine2}`)).toEqual([]);
    expect((await active(`operationCode=OP-020`)).map((a) => a.title)).toEqual(['Operation alert']);
    expect((await active(`partId=${ctx.otherPart}`))).toEqual([]);
    // Several at once: everything that matches any of them, each saying why.
    const all = await active(`partId=${ctx.part}&machineId=${ctx.machine}&operationCode=OP-020`);
    expect(all.map((a) => a.title)).toEqual(['Family alert', 'Machine alert', 'Part alert', 'Operation alert']);
    expect(all.map((a) => a.title)).not.toContain('Still a draft');
  });

  it('says whether the caller has acknowledged it, and null when it is not addressed to them', async () => {
    const inspector = await active(`machineId=${ctx.machine}`);
    expect(inspector[0].acknowledged).toBe(false);
    await api().post(`/api/v1/quality-alerts/${ctx.byMachine}/acknowledge`).set(await as(ids.inspectorA)).send({}).expect(200);
    expect((await active(`machineId=${ctx.machine}`))[0].acknowledged).toBe(true);
    expect((await active(`machineId=${ctx.machine}`, ids.ownerA))[0].acknowledged).toBeNull();
  });

  it('needs something to look for, and drops alerts that are no longer in force', async () => {
    await api().get('/api/v1/quality-alerts/active').set(await as(ids.ownerA)).expect(400);
    await api().get('/api/v1/quality-alerts/active?partId=nope').set(await as(ids.ownerA)).expect(400);
    await api().post(`/api/v1/quality-alerts/${ctx.byOp}/withdraw`).set(await as(ids.ownerA)).send({ reason: 'Issued in error' }).expect(200);
    expect(await active(`operationCode=OP-020`)).toEqual([]);
  });

  it('is private to the organisation and needs documentation.read', async () => {
    const foreign = await api().get(`/api/v1/quality-alerts/active?machineId=${ctx.machine}`).set({ Authorization: `Bearer ${await token(ids.ownerB)}`, 'X-Organisation-Id': ids.orgA });
    expect([403, 404]).toContain(foreign.status);
    await api().get(`/api/v1/quality-alerts/active?machineId=${ctx.machine}`).expect(401);
  });
});

describe('links', () => {
  it('a draft refers to an NC and a supplier, labelled; unknown or foreign records are refused', async () => {
    const owner = await as(ids.ownerA);
    const a = await draft('Supplier material defect', { links: [{ supplierId: ctx.supplier }, { nonconformanceId: ctx.ncr }] });
    ctx.linked = a.id;
    expect(a.links).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'supplier', recordId: ctx.supplier, label: 'Bar Co' }),
      expect.objectContaining({ kind: 'nonconformance', recordId: ctx.ncr, label: expect.stringContaining(' · ') }),
    ]));
    const bad = await api().patch(`/api/v1/quality-alerts/${a.id}`).set(owner).send({ scope: { links: [{ supplierId: UNKNOWN }] } });
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe('documentation_rule');
    await api().patch(`/api/v1/quality-alerts/${a.id}`).set(owner).send({ scope: { links: [{ nonconformanceId: ctx.ncrB }] } }).expect(409); // another organisation's
    await api().patch(`/api/v1/quality-alerts/${a.id}`).set(owner).send({ scope: { links: [{ supplierId: ctx.supplier, gaugeId: UNKNOWN }] } }).expect(400);
    const same = (await api().get(`/api/v1/quality-alerts/${a.id}`).set(owner).expect(200)).body;
    expect(same.links).toHaveLength(2);
  });

  it('changing the links alone leaves the scope alone; sending none clears them', async () => {
    const owner = await as(ids.ownerA);
    const a = await draft('Scoped and linked', { parts: [{ partId: ctx.part }], links: [{ supplierId: ctx.supplier }] });
    const changed = (await api().patch(`/api/v1/quality-alerts/${a.id}`).set(owner).send({ scope: { links: [] } }).expect(200)).body;
    expect(changed.links).toEqual([]);
    expect(changed.scope.parts).toHaveLength(1);
    expect(changed.scope.targets).toHaveLength(1);
  });

  it('links are frozen once issued and travel into a revision', async () => {
    const owner = await as(ids.ownerA);
    await issue(ctx.linked);
    await api().patch(`/api/v1/quality-alerts/${ctx.linked}`).set(owner).send({ scope: { links: [] } }).expect(409);
    const rev = (await api().post(`/api/v1/quality-alerts/${ctx.linked}/revisions`).set(owner).send({ reason: 'More detail' }).expect(201)).body;
    expect(rev.links.map((l: { kind: string }) => l.kind).sort()).toEqual(['nonconformance', 'supplier']);
  });
});

describe('attachments', () => {
  const pathFor = (alert: string, name = 'cert.pdf') => `${ids.orgA}/quality-alerts/${alert}/${name}`;
  const uploaded = (path: string) => admin.query(`insert into storage.objects (bucket_id, name) values ('quality-alert-files', $1)`, [path]);

  it('records a file uploaded to the draft\'s own folder, lists it, removes it with a reason and restores it', async () => {
    const owner = await as(ids.ownerA);
    const a = await draft('With files');
    ctx.files = a.id;
    const path = pathFor(a.id);
    await api().post(`/api/v1/quality-alerts/${a.id}/attachments`).set(owner).send({ storagePath: path, fileName: 'cert.pdf', sizeBytes: 10 }).expect(400); // not uploaded yet
    await uploaded(path);
    await api().post(`/api/v1/quality-alerts/${a.id}/attachments`).set(owner).send({ storagePath: pathFor(UNKNOWN), fileName: 'x.pdf', sizeBytes: 1 }).expect(400); // another folder
    const att = (await api().post(`/api/v1/quality-alerts/${a.id}/attachments`).set(owner).send({ storagePath: path, fileName: 'cert.pdf', contentType: 'application/pdf', sizeBytes: 10 }).expect(201)).body;
    expect(att).toMatchObject({ fileName: 'cert.pdf', storagePath: path, deletedAt: null, createdBy: expect.objectContaining({ name: 'Ada Owner' }) });
    expect((await api().get(`/api/v1/quality-alerts/${a.id}/attachments`).set(owner).expect(200)).body.data).toHaveLength(1);

    await api().post(`/api/v1/quality-alert-attachments/${att.id}/delete`).set(owner).send({ reason: 'x' }).expect(400); // reason too short
    const removed = (await api().post(`/api/v1/quality-alert-attachments/${att.id}/delete`).set(owner).send({ reason: 'Wrong certificate' }).expect(200)).body;
    expect(removed).toMatchObject({ deleteReason: 'Wrong certificate' });
    expect(removed.deletedAt).not.toBeNull();
    expect((await api().get(`/api/v1/quality-alerts/${a.id}/attachments`).set(owner).expect(200)).body.data).toHaveLength(0);
    expect((await api().get(`/api/v1/quality-alerts/${a.id}/attachments?deleted=include`).set(owner).expect(200)).body.data).toHaveLength(1);
    const restored = (await api().post(`/api/v1/quality-alert-attachments/${att.id}/restore`).set(owner).expect(200)).body;
    expect(restored.deletedAt).toBeNull();
    ctx.att = att.id;
  });

  it('only people who manage documentation can attach, and a draft\'s files are hidden from everyone else', async () => {
    const inspector = await as(ids.inspectorA);
    await api().post(`/api/v1/quality-alerts/${ctx.files}/attachments`).set(inspector).send({ storagePath: pathFor(ctx.files, 'v.pdf'), fileName: 'v.pdf', sizeBytes: 1 }).expect(403);
    await api().post(`/api/v1/quality-alert-attachments/${ctx.att}/delete`).set(inspector).send({ reason: 'Not mine to remove' }).expect(403);
    await api().get(`/api/v1/quality-alerts/${ctx.files}/attachments`).set(inspector).expect(404);
  });

  it('issuing freezes the files; recipients can list them; a revision carries the live ones', async () => {
    const owner = await as(ids.ownerA);
    await issue(ctx.files);
    await api().post(`/api/v1/quality-alert-attachments/${ctx.att}/delete`).set(owner).send({ reason: 'Too late to change' }).expect(409);
    const late = pathFor(ctx.files, 'late.pdf');
    await uploaded(late).catch(() => undefined);
    await api().post(`/api/v1/quality-alerts/${ctx.files}/attachments`).set(owner).send({ storagePath: late, fileName: 'late.pdf', sizeBytes: 1 }).expect(409);
    const seen = (await api().get(`/api/v1/quality-alerts/${ctx.files}/attachments`).set(await as(ids.inspectorA)).expect(200)).body.data;
    expect(seen.map((x: { fileName: string }) => x.fileName)).toEqual(['cert.pdf']);
    const rev = (await api().post(`/api/v1/quality-alerts/${ctx.files}/revisions`).set(owner).send({ reason: 'Clarified' }).expect(201)).body;
    const copied = (await api().get(`/api/v1/quality-alerts/${rev.id}/attachments`).set(owner).expect(200)).body.data;
    expect(copied).toHaveLength(1);
    expect(copied[0].storagePath).toBe(pathFor(ctx.files)); // same stored file
  });

  it('another organisation sees none of it', async () => {
    await api().get(`/api/v1/quality-alerts/${ctx.files}/attachments`).set(await as(ids.ownerB, ids.orgB)).expect(404);
    await api().post(`/api/v1/quality-alert-attachments/${ctx.att}/restore`).set(await as(ids.ownerB, ids.orgB)).expect(404);
  });
});
