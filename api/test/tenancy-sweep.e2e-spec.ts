/**
 * Phase 1 exit check, API layer. Driven by the OpenAPI document, so new routes are covered
 * automatically:
 *  - every route is organisation-scoped (X-Organisation-Id) unless it is on the reviewed allowlist;
 *  - every scoped route answers 404 when the caller names an organisation they don't belong to;
 *  - every scoped route with an {id} answers 404 for another organisation's record ids, even when
 *    the caller is Owner of their own organisation (new {id} routes must add a sample body below);
 *  - no list response contains any identifier of the other organisation.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds(4);
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());

/** Routes that are deliberately not organisation-scoped (reviewed). */
const UNSCOPED = new Set([
  'GET /api/v1/health',
  'GET /api/v1/me',
  'PATCH /api/v1/me',
  'POST /api/v1/organisations',
  'GET /api/v1/invitations',
  'POST /api/v1/invitations/{id}/accept',
  'GET /api/v1/units', // global catalogue of measurement units
]);

interface Op {
  method: string;
  path: string;
  scoped: boolean;
}

let ops: Op[];
const a: Record<string, string> = {};
const b: Record<string, string> = {};

/** Valid bodies for routes that take an {id}, so validation passes and the tenant check is what answers. */
const sampleBody = (op: Op): object | undefined =>
  (<Record<string, object | undefined>>{
    'PATCH /api/v1/sites/{id}': { name: 'Hijacked' },
    'PATCH /api/v1/departments/{id}': { name: 'Hijacked' },
    'PATCH /api/v1/members/{id}': { status: 'suspended' },
    'POST /api/v1/members/{id}/role-assignments': { roleId: b.viewerRole },
    'DELETE /api/v1/role-assignments/{id}': undefined,
    'PATCH /api/v1/customers/{id}': { name: 'Hijacked' },
    'PATCH /api/v1/suppliers/{id}': { name: 'Hijacked' },
    'GET /api/v1/parts/{id}': undefined,
    'PATCH /api/v1/parts/{id}': { name: 'Hijacked' },
    'POST /api/v1/parts/{id}/revisions': { revision: 'Z' },
    'PATCH /api/v1/part-revisions/{id}': { drawingRef: 'Hijacked' },
    'POST /api/v1/part-revisions/{id}/release': undefined,
    'POST /api/v1/part-revisions/{id}/obsolete': undefined,
    'GET /api/v1/ncrs/{id}': undefined,
    'PATCH /api/v1/ncrs/{id}': { title: 'Hijacked' },
    'POST /api/v1/ncrs/{id}/transitions': { to: 'cancelled', reason: 'Hijacked' },
    'POST /api/v1/ncrs/{id}/delete': { reason: 'Hijacked' },
    'POST /api/v1/ncrs/{id}/restore': undefined,
    'GET /api/v1/ncrs/{id}/history': undefined,
    'PATCH /api/v1/ncr-classifications/{id}': { name: 'Hijacked' },
    'GET /api/v1/ncrs/{id}/costs': undefined,
    'POST /api/v1/ncrs/{id}/costs': { costType: 'scrap', currency: 'GBP', amount: 1 },
    'GET /api/v1/ncrs/{id}/attachments': undefined,
    'POST /api/v1/ncrs/{id}/attachments': { storagePath: `${b.org}/ncr/${a.ncr}/x.txt`, fileName: 'x.txt', sizeBytes: 1 },
    'PATCH /api/v1/ncr-costs/{id}': { amount: 999 },
    'POST /api/v1/ncr-costs/{id}/delete': { reason: 'Hijacked' },
    'POST /api/v1/ncr-costs/{id}/restore': undefined,
    'POST /api/v1/ncr-attachments/{id}/delete': { reason: 'Hijacked' },
    'POST /api/v1/ncr-attachments/{id}/restore': undefined,
  })[`${op.method} ${op.path}`];

const hasSample = (op: Op) =>
  [
    'PATCH /api/v1/sites/{id}',
    'PATCH /api/v1/departments/{id}',
    'PATCH /api/v1/members/{id}',
    'POST /api/v1/members/{id}/role-assignments',
    'DELETE /api/v1/role-assignments/{id}',
    'PATCH /api/v1/customers/{id}',
    'PATCH /api/v1/suppliers/{id}',
    'GET /api/v1/parts/{id}',
    'PATCH /api/v1/parts/{id}',
    'POST /api/v1/parts/{id}/revisions',
    'PATCH /api/v1/part-revisions/{id}',
    'POST /api/v1/part-revisions/{id}/release',
    'POST /api/v1/part-revisions/{id}/obsolete',
    'GET /api/v1/ncrs/{id}',
    'PATCH /api/v1/ncrs/{id}',
    'POST /api/v1/ncrs/{id}/transitions',
    'POST /api/v1/ncrs/{id}/delete',
    'POST /api/v1/ncrs/{id}/restore',
    'GET /api/v1/ncrs/{id}/history',
    'PATCH /api/v1/ncr-classifications/{id}',
    'GET /api/v1/ncrs/{id}/costs',
    'POST /api/v1/ncrs/{id}/costs',
    'GET /api/v1/ncrs/{id}/attachments',
    'POST /api/v1/ncrs/{id}/attachments',
    'PATCH /api/v1/ncr-costs/{id}',
    'POST /api/v1/ncr-costs/{id}/delete',
    'POST /api/v1/ncr-costs/{id}/restore',
    'POST /api/v1/ncr-attachments/{id}/delete',
    'POST /api/v1/ncr-attachments/{id}/restore',
  ].includes(`${op.method} ${op.path}`);

/** Organisation A's record id for the resource a path refers to. */
const foreignIdFor = (path: string) => {
  if (path.startsWith('/api/v1/sites/')) return a.site;
  if (path.startsWith('/api/v1/departments/')) return a.department;
  if (path.startsWith('/api/v1/members/')) return a.ownerMembership;
  if (path.startsWith('/api/v1/role-assignments/')) return a.ownerAssignment;
  if (path.startsWith('/api/v1/customers/')) return a.customer;
  if (path.startsWith('/api/v1/suppliers/')) return a.supplier;
  if (path.startsWith('/api/v1/parts/')) return a.part;
  if (path.startsWith('/api/v1/part-revisions/')) return a.draftRevision;
  if (path.startsWith('/api/v1/ncrs/')) return a.ncr;
  if (path.startsWith('/api/v1/ncr-classifications/')) return a.classification;
  if (path.startsWith('/api/v1/ncr-costs/')) return a.cost;
  if (path.startsWith('/api/v1/ncr-attachments/')) return a.attachment;
  return undefined;
};

const call = (op: Op, path: string, headers: Record<string, string>, body?: object) => {
  const m = op.method.toLowerCase() as 'get' | 'post' | 'patch' | 'delete';
  const req = api()[m](path).set(headers);
  return body === undefined ? req : req.send(body);
};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-sweep');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });

  const doc = (await api().get('/api/v1/openapi.json').expect(200)).body;
  ops = Object.entries(doc.paths as Record<string, Record<string, { parameters?: { in: string; name: string }[] }>>).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, spec]) => ({
      method: method.toUpperCase(),
      path,
      scoped: (spec.parameters ?? []).some((p) => p.in === 'header' && p.name === 'X-Organisation-Id'),
    })),
  );

  const one = async (q: string, params: unknown[]) => (await admin.query(q, params)).rows[0];
  a.org = ids.orgA;
  a.site = ids.siteA;
  a.department = (await one(`insert into public.departments (organisation_id, site_id, code, name) values ($1, $2, 'QA', 'Quality A') returning id`, [ids.orgA, ids.siteA])).id;
  a.ownerMembership = (await one('select id from public.organisation_users where organisation_id = $1 and user_id = $2', [ids.orgA, ids.ownerA])).id;
  a.ownerAssignment = (await one('select id from public.user_role_assignments where membership_id = $1', [a.ownerMembership])).id;
  a.ownerRole = (await one(`select id from public.roles where organisation_id = $1 and key = 'owner'`, [ids.orgA])).id;
  a.ownerUser = ids.ownerA;
  a.customer = (await one(`insert into public.customers (organisation_id, code, name) values ($1, 'ACUST', 'Alpha customer') returning id`, [ids.orgA])).id;
  a.supplier = (await one(`insert into public.suppliers (organisation_id, code, name) values ($1, 'ASUPP', 'Alpha supplier') returning id`, [ids.orgA])).id;
  a.part = (await one(`insert into public.parts (organisation_id, part_number, name) values ($1, 'A-PART', 'Alpha part') returning id`, [ids.orgA])).id;
  a.draftRevision = (await one(`insert into public.part_revisions (organisation_id, part_id, revision) values ($1, $2, 'A') returning id`, [ids.orgA, a.part])).id;
  a.classification = (await one(`insert into public.ncr_classifications (organisation_id, kind, name) values ($1, 'failure_mode', 'Alpha failure') returning id`, [ids.orgA])).id;
  a.ncr = (await one(`insert into public.nonconformances (organisation_id, reference, source, title) values ($1, 'A-NCR-1', 'internal', 'Alpha NCR') returning id`, [ids.orgA])).id;
  a.cost = (await one(`insert into public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount) values ($1, $2, 'scrap', 'GBP', 10) returning id`, [ids.orgA, a.ncr])).id;
  a.attachment = (await one(`insert into public.ncr_attachments (organisation_id, nonconformance_id, storage_path, file_name, size_bytes) values ($1::uuid, $2::uuid, $1::text || '/ncr/' || $2::text || '/a.txt', 'a.txt', 1) returning id`, [ids.orgA, a.ncr])).id;
  b.org = ids.orgB;
  b.viewerRole = (await one(`select id from public.roles where organisation_id = $1 and key = 'viewer'`, [ids.orgB])).id;
  await admin.query(`insert into public.departments (organisation_id, site_id, code, name) values ($1, $2, 'QA', 'Quality B')`, [ids.orgB, ids.siteB]);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('tenancy sweep over every API route', () => {
  it('discovers the documented routes', () => {
    expect(ops.length).toBeGreaterThanOrEqual(15);
  });

  it('scopes every route to an organisation unless it is on the reviewed allowlist', () => {
    const unscoped = ops.filter((o) => !o.scoped).map((o) => `${o.method} ${o.path}`).sort();
    expect(unscoped).toEqual([...UNSCOPED].sort());
  });

  it('answers 404 on every scoped route for an organisation the caller does not belong to', async () => {
    const auth = { Authorization: `Bearer ${await token(ids.ownerB)}`, 'X-Organisation-Id': ids.orgA };
    const results: string[] = [];
    for (const op of ops.filter((o) => o.scoped)) {
      const path = op.path.replace('{id}', foreignIdFor(op.path) ?? '00000000-0000-0000-0000-000000000000');
      const res = await call(op, path, auth, op.method === 'GET' || op.method === 'DELETE' ? undefined : {});
      if (res.status !== 404 || res.body?.error?.code !== 'organisation_not_found') results.push(`${op.method} ${op.path} -> ${res.status}`);
    }
    expect(results).toEqual([]);
  });

  it('answers 404 for another organisation’s record ids, even to an Owner of their own organisation', async () => {
    const auth = { Authorization: `Bearer ${await token(ids.ownerB)}`, 'X-Organisation-Id': ids.orgB };
    const idOps = ops.filter((o) => o.scoped && o.path.includes('{id}'));
    expect(idOps.filter((o) => !hasSample(o)).map((o) => `${o.method} ${o.path} needs a sample body in this test`)).toEqual([]);

    const results: string[] = [];
    for (const op of idOps) {
      const res = await call(op, op.path.replace('{id}', foreignIdFor(op.path)!), auth, sampleBody(op));
      if (res.status !== 404) results.push(`${op.method} ${op.path} -> ${res.status} ${JSON.stringify(res.body)}`);
    }
    expect(results).toEqual([]);

    // Nothing of A changed.
    const { rows } = await admin.query(
      `select (select name from public.sites where id = $1) site, (select name from public.departments where id = $2) dept,
              (select status from public.organisation_users where id = $3) member, (select count(*)::int from public.user_role_assignments where id = $4) assignment,
              (select name from public.customers where id = $5) customer, (select name from public.suppliers where id = $6) supplier,
              (select name from public.parts where id = $7) part,
              (select status || '/' || coalesce(drawing_ref, '') || '/' || (select count(*) from public.part_revisions where part_id = $7) from public.part_revisions where id = $8) revision,
              (select title || '/' || stage || '/' || (deleted_at is null) from public.nonconformances where id = $9) ncr,
              (select name from public.ncr_classifications where id = $10) classification,
              (select amount || '/' || (deleted_at is null) from public.ncr_costs where id = $11) cost,
              (select (deleted_at is null)::text from public.ncr_attachments where id = $12) attachment,
              (select count(*)::int from public.ncr_costs where nonconformance_id = $9) costs,
              (select count(*)::int from public.ncr_attachments where nonconformance_id = $9) attachments`,
      [a.site, a.department, a.ownerMembership, a.ownerAssignment, a.customer, a.supplier, a.part, a.draftRevision, a.ncr, a.classification, a.cost, a.attachment],
    );
    expect(rows[0]).toEqual({
      site: 'Alpha main', dept: 'Quality A', member: 'active', assignment: 1,
      customer: 'Alpha customer', supplier: 'Alpha supplier', part: 'Alpha part', revision: 'draft//1',
      ncr: 'Alpha NCR/draft/true', classification: 'Alpha failure',
      cost: '10/true', attachment: 'true', costs: 1, attachments: 1,
    });
  });

  it('never includes another organisation’s identifiers in list responses', async () => {
    const auth = { Authorization: `Bearer ${await token(ids.ownerB)}`, 'X-Organisation-Id': ids.orgB };
    const lists = ops.filter((o) => o.scoped && o.method === 'GET' && !o.path.includes('{id}'));
    const leaks: string[] = [];
    // Routes that need query parameters get a valid set, so the tenant check is what is tested.
    const listQuery: Record<string, string> = { '/api/v1/ncr-dashboard': '?from=2025-01-01&to=2027-12-31' };
    for (const op of lists) {
      const res = await call(op, op.path + (listQuery[op.path] ?? ''), auth);
      expect(res.status).toBe(200);
      const text = JSON.stringify(res.body);
      for (const [name, id] of Object.entries(a)) if (text.includes(id)) leaks.push(`${op.path} contains A ${name}`);
    }
    // Also the unscoped reads.
    for (const path of ['/api/v1/me', '/api/v1/invitations']) {
      const text = JSON.stringify((await api().get(path).set({ Authorization: auth.Authorization }).expect(200)).body);
      for (const [name, id] of Object.entries(a)) if (text.includes(id)) leaks.push(`${path} contains A ${name}`);
    }
    expect(leaks).toEqual([]);
  });
});
