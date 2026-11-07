/**
 * The master data overview through the API: totals and active counts, the data-quality checks (zero is shown, not hidden), growth by week, the shape of the data,
 * recent changes, the change-event stream (outbox) and who may see what.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('e1');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};
const get = async (user = ids.ownerA, org = ids.orgA) => (await api().get('/api/v1/master-data-dashboard').set(await as(user, org)).expect(200)).body;
const entity = (d: { entities: { kind: string }[] }, kind: string) => d.entities.find((e) => e.kind === kind);
const attention = (d: { attention: { key: string }[] }, key: string) => d.attention.find((a) => a.key === key);

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-mdd');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('an organisation with no master data', () => {
  it('shows zeros for every kind and every check, twelve weeks of growth and an empty change stream', async () => {
    const d = await get();
    expect(d.entities.map((e: { kind: string }) => e.kind)).toEqual(['parts', 'partFamilies', 'machines', 'customers', 'suppliers', 'employees']);
    expect(d.entities.every((e: { total: number; active: number; added30Days: number }) => e.total === 0 && e.active === 0 && e.added30Days === 0)).toBe(true);
    expect(d.attention).toHaveLength(5);
    expect(d.attention.every((a: { count: number; of: number }) => a.count === 0 && a.of === 0)).toBe(true);
    expect(d.growth).toHaveLength(12);
    expect(d.growth[0]).toEqual({ start: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), parts: 0, partFamilies: 0, machines: 0, customers: 0, suppliers: 0, employees: 0 });
    expect(d.recent).toEqual([]);
    expect(d.events).toMatchObject({ available: true, last24Hours: 0, waiting: 0, oldestWaitingAt: null, byType: [], recent: [] });
  });
});

describe('with data', () => {
  beforeAll(async () => {
    const h = await as(ids.ownerA);
    const post = async (path: string, body: object) => (await api().post(`/api/v1${path}`).set(h).send(body).expect(201)).body;
    ctx.famA = (await post('/part-families', { code: 'ROD', name: 'Rods' })).id;
    ctx.famB = (await post('/part-families', { code: 'PIN', name: 'Pins' })).id;
    // P1: family, released, customer. P2: no family, only a draft revision, no customer. P3: the same gaps as P2, then made inactive (so it must not be counted).
    const p1 = await post('/parts', { partNumber: 'P-1', name: 'One', partFamilyId: ctx.famA, initialRevision: { revision: 'A' } });
    const p2 = await post('/parts', { partNumber: 'P-2', name: 'Two', initialRevision: { revision: 'A' } });
    const p3 = await post('/parts', { partNumber: 'P-3', name: 'Three', initialRevision: { revision: 'A' } });
    Object.assign(ctx, { p1: p1.id, p2: p2.id, p3: p3.id });
    await api().post(`/api/v1/part-revisions/${p1.revisions[0].id}/release`).set(h).expect(200);
    const customer = await post('/customers', { code: 'ACME', name: 'Acme' });
    await post('/suppliers', { code: 'SUP', name: 'Supplier' });
    await post(`/parts/${p1.id}/customers`, { customerId: customer.id });
    await api().patch(`/api/v1/parts/${p3.id}`).set(h).send({ active: false }).expect(200);
    await post('/machines', { code: 'M-1', name: 'Lathe', siteId: ids.siteA });
    ctx.noSite = (await post('/machines', { code: 'M-2', name: 'Mill' })).id;
    const retired = (await post('/machines', { code: 'M-3', name: 'Retired' })).id;
    await api().patch(`/api/v1/machines/${retired}`).set(h).send({ active: false }).expect(200);
    const dept = await post('/departments', { siteId: ids.siteA, code: 'MFG', name: 'Manufacturing' });
    await post('/employees', { firstName: 'Ada', surname: 'Lovelace', departmentId: dept.id });
    await post('/employees', { firstName: 'Grace', surname: 'Hopper' });
    const left = (await post('/employees', { firstName: 'Old', surname: 'Timer' })).id;
    await api().patch(`/api/v1/employees/${left}`).set(h).send({ active: false }).expect(200);
  });

  it('counts each kind, its active records and what was added in the last 30 days', async () => {
    const d = await get();
    expect(entity(d, 'parts')).toEqual({ kind: 'parts', total: 3, active: 2, added30Days: 3 });
    expect(entity(d, 'partFamilies')).toMatchObject({ total: 2, active: 2 });
    expect(entity(d, 'machines')).toMatchObject({ total: 3, active: 2 });
    expect(entity(d, 'customers')).toMatchObject({ total: 1 });
    expect(entity(d, 'suppliers')).toMatchObject({ total: 1 });
    expect(entity(d, 'employees')).toMatchObject({ total: 3, active: 2 });
  });

  it('counts the data-quality checks over active records only', async () => {
    const d = await get();
    expect(attention(d, 'parts_without_release')).toMatchObject({ count: 1, of: 2 }); // P-2 (P-3 is inactive)
    expect(attention(d, 'parts_without_family')).toMatchObject({ count: 1, of: 2 }); // P-2
    expect(attention(d, 'parts_without_customer')).toMatchObject({ count: 1, of: 2 }); // P-2
    expect(attention(d, 'machines_without_site')).toMatchObject({ count: 1, of: 2 });
    expect(attention(d, 'employees_without_department')).toMatchObject({ count: 1, of: 2 }); // Grace
  });

  it('puts this week’s additions in the last growth bucket', async () => {
    const d = await get();
    const last = d.growth[d.growth.length - 1];
    expect(last).toMatchObject({ parts: 3, partFamilies: 2, machines: 3, customers: 1, suppliers: 1, employees: 3 });
    expect(d.growth.slice(0, -1).every((w: Record<string, number | string>) => KINDS.every((k) => w[k] === 0))).toBe(true);
  });

  it('shows the shape: parts per family (with the part that has none), machines per site, employees per department, revisions by status', async () => {
    const d = await get();
    expect(d.partsByFamily).toEqual([{ key: ctx.famA, label: 'ROD · Rods', count: 1 }, { key: 'none', label: 'No family', count: 1 }]); // inactive P-3 is not counted
    expect(d.machinesBySite.map((r: { label: string; count: number }) => [r.label, r.count]).sort()).toEqual([['Alpha main', 1], ['No site', 1]]);
    expect(d.employeesByDepartment.map((r: { label: string; count: number }) => [r.label, r.count]).sort()).toEqual([['Manufacturing', 1], ['No department', 1]]);
    expect(Object.fromEntries(d.revisionsByStatus.map((r: { key: string; count: number }) => [r.key, r.count]))).toEqual({ draft: 2, released: 1 });
  });

  it('lists the latest records, newest first, and calls a later edit "changed"', async () => {
    let d = await get();
    expect(d.recent).toHaveLength(10);
    expect(d.recent[0].at >= d.recent[9].at).toBe(true);
    expect(d.recent.every((r: { action: string }) => r.action === 'added')).toBe(true);
    expect(d.recent.find((r: { label: string }) => r.label === 'Ada Lovelace')).toMatchObject({ kind: 'employees', by: 'Ada Owner' });
    await new Promise((r) => setTimeout(r, 2300)); // "changed" means edited more than two seconds after it was created
    await api().patch(`/api/v1/parts/${ctx.p1}`).set(await as(ids.ownerA)).send({ name: 'One, renamed' }).expect(200);
    d = await get();
    expect(d.recent[0]).toMatchObject({ kind: 'parts', label: 'P-1', action: 'changed' });
  });

  it('shows the change events written by the outbox: a released revision waiting for a consumer', async () => {
    const d = await get();
    expect(d.events).toMatchObject({ available: true, waiting: 1, last24Hours: 1 });
    expect(d.events.oldestWaitingAt).toEqual(expect.any(String));
    expect(d.events.byType).toEqual([{ key: 'part.revision.released', label: 'part.revision.released', count: 1 }]);
    expect(d.events.recent[0]).toMatchObject({ type: 'part.revision.released', entityType: 'part_revision', processedAt: null, by: 'Ada Owner' });
    await admin.query(`update public.outbox_events set processed_at = now() where organisation_id = $1`, [ids.orgA]);
    expect((await get()).events).toMatchObject({ waiting: 0, oldestWaitingAt: null, last24Hours: 1 });
  });
});

describe('who may see what', () => {
  it('hides the change stream from people without audit.read but keeps the rest', async () => {
    const d = await get(ids.inspectorA);
    expect(d.events).toEqual({ available: false, last24Hours: 0, waiting: 0, oldestWaitingAt: null, byType: [], recent: [] });
    expect(entity(d, 'parts')).toMatchObject({ total: 3 });
  });

  it('is for members only, and another organisation sees only its own data', async () => {
    await api().get('/api/v1/master-data-dashboard').set(await as(ids.outsider)).expect(404);
    await api().get('/api/v1/master-data-dashboard').set({ Authorization: `Bearer ${await token(ids.ownerA)}`, 'X-Organisation-Id': ids.orgB }).expect(404);
    const other = await get(ids.ownerB, ids.orgB);
    expect(other.entities.every((e: { total: number }) => e.total === 0)).toBe(true);
    expect(other.recent).toEqual([]);
    expect(other.events.recent).toEqual([]);
  });
});

const KINDS = ['parts', 'partFamilies', 'machines', 'customers', 'suppliers', 'employees'];
