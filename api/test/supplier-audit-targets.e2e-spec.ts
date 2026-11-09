/**
 * Supplier quality SQ6a through the API: a supplier as something an audit is relevant to - on the definition, in its versions, on the record and in the filters -
 * with the same rules as machines, operations and departments (own organisation only, no duplicates, only the audit's own suppliers on a record).
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('ff');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const body = (over: object = {}) => ({
  title: 'Supplier process audit', auditType: 'supplier', purpose: null, procedure: null, frequency: { kind: 'on_demand' }, graceDays: 0, weekdaysOnly: false, auditor: { kind: 'none' }, passMark: 80,
  questions: [{ question: 'Is the quality manual current?', answerType: 'pass_fail', critical: false }],
  targets: [{ kind: 'supplier', supplierId: ctx.s1 }, { kind: 'supplier', supplierId: ctx.s2 }], ...over,
});

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-sat');
  ctx.s1 = (await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'ACME', 'Acme Metals') returning id`, [ids.orgA])).rows[0].id;
  ctx.s2 = (await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'BOLT', 'Bolt Co') returning id`, [ids.orgA])).rows[0].id;
  ctx.s3 = (await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'CAST', 'Cast Ltd') returning id`, [ids.orgA])).rows[0].id;
  ctx.sB = (await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'OTHR', 'Other') returning id`, [ids.orgB])).rows[0].id;
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('suppliers as audit targets', () => {
  it('are listed on the definition with their names, and refused when foreign or doubled', async () => {
    const h = await as(ids.ownerA);
    await api().post('/api/v1/audits').set(h).send(body({ targets: [{ kind: 'supplier', supplierId: ctx.sB }] })).expect(404);
    await api().post('/api/v1/audits').set(h).send(body({ targets: [{ kind: 'supplier', supplierId: ctx.s1 }, { kind: 'supplier', supplierId: ctx.s1 }] })).expect(409);
    await api().post('/api/v1/audits').set(h).send(body({ targets: [{ kind: 'supplier' }] })).expect(400);
    const a = (await api().post('/api/v1/audits').set(h).send(body()).expect(201)).body;
    ctx.audit = a.id;
    expect(a.targets).toEqual([{ kind: 'supplier', id: ctx.s1, label: 'ACME · Acme Metals' }, { kind: 'supplier', id: ctx.s2, label: 'BOLT · Bolt Co' }]);
    expect(a.version).toBe(1);
  });

  it('change only with a reason, and the version history names the suppliers', async () => {
    const h = await as(ids.ownerA);
    await api().patch(`/api/v1/audits/${ctx.audit}`).set(h).send({ targets: [{ kind: 'supplier', supplierId: ctx.s1 }, { kind: 'supplier', supplierId: ctx.s3 }] }).expect(409);
    const v2 = (await api().patch(`/api/v1/audits/${ctx.audit}`).set(h).send({ targets: [{ kind: 'supplier', supplierId: ctx.s1 }, { kind: 'supplier', supplierId: ctx.s3 }], changeReason: 'Replaced Bolt with Cast' }).expect(200)).body;
    expect(v2.version).toBe(2);
    const versions = (await api().get(`/api/v1/audits/${ctx.audit}/versions`).set(h).expect(200)).body;
    const latest = versions.data[0];
    expect(latest.version).toBe(2);
    expect(latest.summary.join(' ')).toMatch(/Cast Ltd/);
    const detail = (await api().get(`/api/v1/audits/${ctx.audit}/versions/1`).set(h).expect(200)).body;
    expect(detail.targets.map((t: { label: string }) => t.label)).toEqual(['ACME · Acme Metals', 'BOLT · Bolt Co']);
  });

  it('are carried out on by a record, one of the audit\'s own, and found by filter', async () => {
    const insp = await as(ids.inspectorA);
    const rec = (await api().post('/api/v1/audit-records').set(insp).send({ auditId: ctx.audit, targets: [{ kind: 'supplier', supplierId: ctx.s3 }] }).expect(201)).body;
    ctx.record = rec.id;
    expect(rec.targets).toEqual([{ kind: 'supplier', id: ctx.s3, label: 'CAST · Cast Ltd' }]);
    expect(rec.availableTargets.map((t: { label: string }) => t.label).sort()).toEqual(['ACME · Acme Metals', 'CAST · Cast Ltd']);
    await api().put(`/api/v1/audit-records/${ctx.record}/targets`).set(insp).send({ targets: [{ kind: 'supplier', supplierId: ctx.s2 }] }).expect(409);
    const ok = (await api().put(`/api/v1/audit-records/${ctx.record}/targets`).set(insp).send({ targets: [{ kind: 'supplier', supplierId: ctx.s1 }, { kind: 'supplier', supplierId: ctx.s3 }] }).expect(200)).body;
    expect(ok.targets).toHaveLength(2);
    const h = await as(ids.ownerA);
    expect((await api().get(`/api/v1/audit-records?supplierId=${ctx.s1}`).set(h).expect(200)).body.data.map((r: { id: string }) => r.id)).toEqual([ctx.record]);
    expect((await api().get(`/api/v1/audit-records?supplierId=${ctx.s2}`).set(h).expect(200)).body.data).toEqual([]);
    expect((await api().get(`/api/v1/audits?supplierId=${ctx.s3}`).set(h).expect(200)).body.data.map((a: { id: string }) => a.id)).toEqual([ctx.audit]);
    expect((await api().get(`/api/v1/audits?supplierId=${ctx.s2}`).set(h).expect(200)).body.data).toEqual([]);
    await api().get('/api/v1/audits?supplierId=nope').set(h).expect(400);
  });

  it('show in the audits dashboard coverage once audited', async () => {
    const h = await as(ids.ownerA);
    const d = (await api().get(`/api/v1/audits-dashboard?from=${day(-29)}&to=${day(0)}`).set(h).expect(200)).body;
    const labels = d.coverage.items.filter((i: { kind: string }) => i.kind === 'supplier').map((i: { label: string }) => i.label);
    expect(labels).toEqual(expect.arrayContaining(['ACME · Acme Metals', 'CAST · Cast Ltd']));
  });
});
