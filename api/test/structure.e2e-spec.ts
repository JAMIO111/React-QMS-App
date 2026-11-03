/**
 * Phase 1.4 endpoints: organisations (create/update), sites, departments.
 * Every write is attempted across tenants as well as without the required permission.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds(2);

let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org?: string) => ({
  Authorization: `Bearer ${await token(user)}`,
  ...(org ? { 'X-Organisation-Id': org } : {}),
});

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-structure');
  app = await startApp();
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('POST /organisations', () => {
  it('creates an organisation with the caller as Owner', async () => {
    const res = await api()
      .post('/api/v1/organisations')
      .set(await as(ids.outsider))
      .send({ name: 'Gamma Tooling', site: { name: 'Sheffield', code: 'shf' } })
      .expect(201);
    expect(res.body).toMatchObject({ name: 'Gamma Tooling', slug: 'gamma-tooling', status: 'active', settings: { baseCurrency: 'GBP' } });

    const me = await api().get('/api/v1/me').set(await as(ids.outsider)).expect(200);
    const membership = me.body.memberships.find((m: { organisation: { id: string } }) => m.organisation.id === res.body.id);
    expect(membership.permissions).toContain('roles.manage');

    const sites = await api().get('/api/v1/sites').set(await as(ids.outsider, res.body.id)).expect(200);
    expect(sites.body.data).toEqual([expect.objectContaining({ code: 'SHF', name: 'Sheffield' })]);
  });

  it('is idempotent with the same Idempotency-Key', async () => {
    const headers = { ...(await as(ids.outsider)), 'Idempotency-Key': 'create-delta-1' };
    const first = await api().post('/api/v1/organisations').set(headers).send({ name: 'Delta Moulding' }).expect(201);
    const second = await api().post('/api/v1/organisations').set(headers).send({ name: 'Delta Moulding' }).expect(201);
    expect(second.body.id).toBe(first.body.id);
    const { rows } = await admin.query(`select count(*)::int as n from public.organisations where name = 'Delta Moulding'`);
    expect(rows[0].n).toBe(1);
  });

  it('validates input', async () => {
    const auth = await as(ids.outsider);
    await api().post('/api/v1/organisations').set(auth).send({ name: 'x' }).expect(400);
    await api().post('/api/v1/organisations').set(auth).send({ name: 'Valid', site: { name: 'S', code: 'bad code!' } }).expect(400);
    await api().post('/api/v1/organisations').set(auth).send({ name: 'Valid', status: 'suspended' }).expect(400);
    await api().post('/api/v1/organisations').set({ ...auth, 'Idempotency-Key': 'has spaces' }).send({ name: 'Valid' }).expect(400);
  });

  it('requires sign-in', () => api().post('/api/v1/organisations').send({ name: 'Anon Ltd' }).expect(401));
});

describe('PATCH /organisations/current', () => {
  it('lets an owner rename and change settings, recorded as an API change', async () => {
    const res = await api()
      .patch('/api/v1/organisations/current')
      .set({ ...(await as(ids.ownerA, ids.orgA)), 'X-Change-Reason': 'Rebrand', 'X-Correlation-Id': 'corr-org-1' })
      .send({ name: 'Alpha Precision Ltd', settings: { baseCurrency: 'eur', vatRate: 0.21, ncrReferencePrefix: 'apl' } })
      .expect(200);
    expect(res.body).toMatchObject({ name: 'Alpha Precision Ltd', settings: { baseCurrency: 'EUR', vatRate: 0.21, ncrReferencePrefix: 'APL' } });

    const { rows } = await admin.query(
      `select entity_type, source, reason, correlation_id from audit.events where correlation_id = 'corr-org-1' order by seq`,
    );
    expect(rows).toEqual([
      { entity_type: 'organisations', source: 'api', reason: 'Rebrand', correlation_id: 'corr-org-1' },
      { entity_type: 'organisation_settings', source: 'api', reason: 'Rebrand', correlation_id: 'corr-org-1' },
    ]);
  });

  it('forbids members without organisation.manage', async () => {
    const res = await api().patch('/api/v1/organisations/current').set(await as(ids.inspectorA, ids.orgA)).send({ name: 'Hijack' }).expect(403);
    expect(res.body.error).toMatchObject({ code: 'forbidden', details: { permission: 'organisation.manage' } });
  });

  it('answers 404 for another tenant', () =>
    as(ids.ownerA, ids.orgB).then((h) => api().patch('/api/v1/organisations/current').set(h).send({ name: 'Hijack' }).expect(404)));

  it('validates input', async () => {
    const h = await as(ids.ownerA, ids.orgA);
    await api().patch('/api/v1/organisations/current').set(h).send({}).expect(400);
    await api().patch('/api/v1/organisations/current').set(h).send({ settings: { baseCurrency: 'EURO' } }).expect(400);
    await api().patch('/api/v1/organisations/current').set(h).send({ settings: { vatRate: 1.5 } }).expect(400);
    await api().patch('/api/v1/organisations/current').set(h).send({ slug: 'new-slug' }).expect(400);
  });
});

describe('sites', () => {
  it('lists only the current organisation’s sites', async () => {
    const a = await api().get('/api/v1/sites').set(await as(ids.ownerA, ids.orgA)).expect(200);
    expect(a.body.data.map((s: { id: string }) => s.id)).toContain(ids.siteA);
    expect(a.body.data.map((s: { id: string }) => s.id)).not.toContain(ids.siteB);
    const b = await api().get('/api/v1/sites').set(await as(ids.dual, ids.orgB)).expect(200);
    expect(b.body.data.map((s: { id: string }) => s.id)).toEqual([ids.siteB]);
  });

  it('creates, rejects duplicates and validates', async () => {
    const h = await as(ids.ownerA, ids.orgA);
    const created = await api().post('/api/v1/sites').set(h).send({ code: 'lds', name: 'Leeds', timezone: 'Europe/London' }).expect(201);
    expect(created.body).toMatchObject({ code: 'LDS', name: 'Leeds', timezone: 'Europe/London', active: true });

    const dup = await api().post('/api/v1/sites').set(h).send({ code: 'LDS', name: 'Leeds again' }).expect(409);
    expect(dup.body.error).toMatchObject({ code: 'conflict', message: 'A site with this code already exists' });

    await api().post('/api/v1/sites').set(h).send({ code: 'MAN', name: 'Manchester', timezone: 'Mars/Olympus' }).expect(400);
    // The same code is fine in another organisation.
    await api().post('/api/v1/sites').set(await as(ids.ownerB, ids.orgB)).send({ code: 'LDS', name: 'Beta Leeds' }).expect(201);
  });

  it('requires organisation.manage to create or change', async () => {
    await api().post('/api/v1/sites').set(await as(ids.dual, ids.orgA)).send({ code: 'VW', name: 'Viewer site' }).expect(403);
    await api().patch(`/api/v1/sites/${ids.siteA}`).set(await as(ids.inspectorA, ids.orgA)).send({ name: 'x' }).expect(403);
  });

  it('answers 404 for another tenant’s site, even with valid permissions', async () => {
    const res = await api().patch(`/api/v1/sites/${ids.siteB}`).set(await as(ids.ownerA, ids.orgA)).send({ name: 'Hijacked' }).expect(404);
    expect(res.body.error.code).toBe('site_not_found');
    const { rows } = await admin.query('select name from public.sites where id = $1', [ids.siteB]);
    expect(rows[0].name).toBe('Beta main');
  });

  it('deactivates instead of deleting', async () => {
    const h = await as(ids.ownerA, ids.orgA);
    const created = await api().post('/api/v1/sites').set(h).send({ code: 'OLD', name: 'Old works' }).expect(201);
    await api().patch(`/api/v1/sites/${created.body.id}`).set(h).send({ active: false }).expect(200);
    const active = await api().get('/api/v1/sites').set(h).expect(200);
    expect(active.body.data.map((s: { code: string }) => s.code)).not.toContain('OLD');
    const all = await api().get('/api/v1/sites?includeInactive=true').set(h).expect(200);
    expect(all.body.data.map((s: { code: string }) => s.code)).toContain('OLD');
  });

  it('paginates with an opaque cursor', async () => {
    const h = await as(ids.ownerA, ids.orgA);
    for (const code of ['P1', 'P2', 'P3']) await api().post('/api/v1/sites').set(h).send({ code, name: code });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: request.Response = await api()
        .get(`/api/v1/sites?limit=2${cursor ? `&cursor=${cursor}` : ''}`)
        .set(h)
        .expect(200);
      expect(res.body.data.length).toBeLessThanOrEqual(2);
      seen.push(...res.body.data.map((s: { code: string }) => s.code));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual([...seen].sort());
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expect.arrayContaining(['LDS', 'MAIN', 'P1', 'P2', 'P3']));
    const bad = await api().get('/api/v1/sites?cursor=garbage').set(h).expect(400);
    expect(bad.body.error.code).toBe('invalid_cursor');
  });
});

describe('departments', () => {
  it('creates departments under a site of the same organisation only', async () => {
    const h = await as(ids.ownerA, ids.orgA);
    const created = await api().post('/api/v1/departments').set(h).send({ siteId: ids.siteA, code: 'qa', name: 'Quality' }).expect(201);
    expect(created.body).toMatchObject({ siteId: ids.siteA, code: 'QA', name: 'Quality', active: true });

    const foreign = await api().post('/api/v1/departments').set(h).send({ siteId: ids.siteB, code: 'QA', name: 'Sneaky' }).expect(400);
    expect(foreign.body.error.code).toBe('invalid_reference');

    await api().post('/api/v1/departments').set(h).send({ siteId: ids.siteA, code: 'QA', name: 'Dup' }).expect(409);
  });

  it('filters by site and hides other tenants', async () => {
    await api().post('/api/v1/departments').set(await as(ids.ownerB, ids.orgB)).send({ siteId: ids.siteB, code: 'QA', name: 'Beta quality' }).expect(201);
    const a = await api().get(`/api/v1/departments?siteId=${ids.siteA}`).set(await as(ids.ownerA, ids.orgA)).expect(200);
    expect(a.body.data.every((d: { siteId: string }) => d.siteId === ids.siteA)).toBe(true);
    const crossSite = await api().get(`/api/v1/departments?siteId=${ids.siteB}`).set(await as(ids.ownerA, ids.orgA)).expect(200);
    expect(crossSite.body.data).toEqual([]);
  });

  it('answers 404 when updating another tenant’s department', async () => {
    const { rows } = await admin.query(`select id from public.departments where organisation_id = $1 limit 1`, [ids.orgB]);
    await api().patch(`/api/v1/departments/${rows[0].id}`).set(await as(ids.ownerA, ids.orgA)).send({ name: 'Hijacked' }).expect(404);
  });

  it('rejects a malformed id', () =>
    as(ids.ownerA, ids.orgA).then((h) => api().patch('/api/v1/departments/not-a-uuid').set(h).send({ name: 'x' }).expect(400)));
});
