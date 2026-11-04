/**
 * End-to-end tests against a migrated throwaway Postgres (run via `npm run api:test:e2e`).
 * The API connects as qms_api, exactly as in production.
 */
import { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import request from 'supertest';
import { DatabaseService } from '../src/database/database.service';
import { ids, requireDb, seed, startApp, token } from './helpers';

let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const bearer = async (user: string) => ({ Authorization: `Bearer ${await token(user)}` });

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin);
  app = await startApp();
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('health and conventions', () => {
  it('reports health without a token and issues a correlation id', async () => {
    const res = await api().get('/api/v1/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', checks: { database: 'ok' } });
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('echoes a supplied correlation id', async () => {
    const res = await api().get('/api/v1/health').set('X-Correlation-Id', 'trace-42').expect(200);
    expect(res.headers['x-correlation-id']).toBe('trace-42');
  });

  it('uses the standard error format for unknown routes', async () => {
    const res = await api().get('/api/v1/nope').set(await bearer(ids.ownerA)).expect(404);
    expect(res.body.error).toMatchObject({ code: 'not_found', correlationId: expect.any(String) });
  });

  it('publishes OpenAPI', async () => {
    const res = await api().get('/api/v1/openapi.json').expect(200);
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining(['/api/v1/health', '/api/v1/me', '/api/v1/organisations/current']),
    );
    expect(res.body.components.securitySchemes.bearer).toBeDefined();
  });

  it('does not advertise the framework', async () => {
    const res = await api().get('/api/v1/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('authentication', () => {
  it('rejects requests without a token', async () => {
    const res = await api().get('/api/v1/me').expect(401);
    expect(res.body.error).toMatchObject({ code: 'unauthenticated', correlationId: expect.any(String) });
  });

  it('rejects a malformed Authorization header', () =>
    api().get('/api/v1/me').set('Authorization', 'Basic abc').expect(401));

  it('rejects a service_role token', async () => {
    const t = await token(ids.ownerA, { role: 'service_role' });
    await api().get('/api/v1/me').set('Authorization', `Bearer ${t}`).expect(401);
  });
});

describe('GET/PATCH /me', () => {
  it('returns the profile, organisations and effective permissions', async () => {
    const res = await api().get('/api/v1/me').set(await bearer(ids.ownerA)).expect(200);
    expect(res.body.profile).toMatchObject({ id: ids.ownerA, firstName: 'Ada', surname: 'Owner' });
    expect(res.body.memberships).toHaveLength(1);
    expect(res.body.memberships[0].organisation).toMatchObject({ id: ids.orgA, slug: 'alpha-precision' });
    expect(res.body.memberships[0].permissions).toEqual(expect.arrayContaining(['ncr.delete', 'members.manage', 'audit.read']));
  });

  it('lists each organisation with that organisation’s permissions', async () => {
    const res = await api().get('/api/v1/me').set(await bearer(ids.dual)).expect(200);
    expect(res.body.memberships.map((m: { organisation: { name: string } }) => m.organisation.name)).toEqual([
      'Alpha Precision',
      'Beta Castings',
    ]);
    for (const m of res.body.memberships) expect(m.permissions).toEqual(['calibration.read', 'master_data.read', 'ncr.read', 'process_control.read']);
  });

  it('hides organisations where membership is suspended', async () => {
    const res = await api().get('/api/v1/me').set(await bearer(ids.suspendedA)).expect(200);
    expect(res.body.memberships).toEqual([]);
  });

  it('returns an empty membership list for a user without organisations', async () => {
    const res = await api().get('/api/v1/me').set(await bearer(ids.outsider)).expect(200);
    expect(res.body).toMatchObject({ profile: { id: ids.outsider }, memberships: [] });
  });

  it('updates only the caller’s own profile', async () => {
    const res = await api()
      .patch('/api/v1/me')
      .set(await bearer(ids.inspectorA))
      .send({ firstName: '  Ivy ', jobTitle: 'Inspector' })
      .expect(200);
    expect(res.body.profile).toMatchObject({ id: ids.inspectorA, firstName: 'Ivy', jobTitle: 'Inspector' });
    const { rows } = await admin.query('select first_name from public.profiles where id = $1', [ids.ownerA]);
    expect(rows[0].first_name).toBe('Ada');
  });

  it('validates the body', async () => {
    const auth = await bearer(ids.inspectorA);
    const unknown = await api().patch('/api/v1/me').set(auth).send({ firstName: 'x', id: ids.ownerA }).expect(400);
    expect(unknown.body.error.code).toBe('validation_failed');
    await api().patch('/api/v1/me').set(auth).send({}).expect(400);
    await api().patch('/api/v1/me').set(auth).send({ firstName: '' }).expect(400);
  });
});

describe('organisation scope', () => {
  const current = '/api/v1/organisations/current';

  it('requires the X-Organisation-Id header', async () => {
    const res = await api().get(current).set(await bearer(ids.ownerA)).expect(400);
    expect(res.body.error.code).toBe('organisation_required');
  });

  it('rejects a malformed organisation id', async () => {
    const res = await api().get(current).set(await bearer(ids.ownerA)).set('X-Organisation-Id', 'abc').expect(400);
    expect(res.body.error.code).toBe('invalid_organisation_id');
  });

  it('returns the organisation for a member', async () => {
    const res = await api().get(current).set(await bearer(ids.ownerA)).set('X-Organisation-Id', ids.orgA).expect(200);
    expect(res.body).toEqual({
      id: ids.orgA,
      name: 'Alpha Precision',
      slug: 'alpha-precision',
      status: 'active',
      settings: { baseCurrency: 'GBP', vatRate: 0.2, ncrReferencePrefix: 'NCM', themeColour: 'purple', requireMfa: false, logoPath: null },
    });
  });

  it('answers 404 (not 403) for another tenant’s organisation', async () => {
    const res = await api().get(current).set(await bearer(ids.ownerA)).set('X-Organisation-Id', ids.orgB).expect(404);
    expect(res.body.error.code).toBe('organisation_not_found');
  });

  it('answers 404 for an organisation that does not exist', async () => {
    await api().get(current).set(await bearer(ids.ownerA)).set('X-Organisation-Id', '10000000-0000-0000-0000-000000000999').expect(404);
  });

  it('answers 404 for a suspended member', async () => {
    await api().get(current).set(await bearer(ids.suspendedA)).set('X-Organisation-Id', ids.orgA).expect(404);
  });

  it('lets a member of two organisations act in either', async () => {
    const auth = await bearer(ids.dual);
    await api().get(current).set(auth).set('X-Organisation-Id', ids.orgA).expect(200);
    const b = await api().get(current).set(auth).set('X-Organisation-Id', ids.orgB).expect(200);
    expect(b.body.settings).toMatchObject({ baseCurrency: 'EUR', vatRate: 0.21 });
  });
});

describe('database access runs as the caller (RLS + audit context)', () => {
  const ctx = (userId: string, extra: Partial<{ correlationId: string; reason: string }> = {}) => ({
    user: { id: userId, claims: { sub: userId, role: 'authenticated' } },
    correlationId: extra.correlationId ?? 'e2e',
    reason: extra.reason,
  });

  it('runs as authenticated with the caller’s identity, never as the login role', async () => {
    const db = app.get(DatabaseService);
    const row = await db.asUser(ctx(ids.ownerA), async (tx) => {
      const r = await tx.execute<{ role: string; uid: string }>(sql`select current_user as role, auth.uid()::text as uid`);
      return r.rows[0];
    });
    expect(row).toEqual({ role: 'authenticated', uid: ids.ownerA });
  });

  it('only sees the caller’s tenant data', async () => {
    const db = app.get(DatabaseService);
    const counts = await db.asUser(ctx(ids.ownerA), async (tx) => {
      const r = await tx.execute<{ own: string; other: string }>(sql`
        select (select count(*) from public."NCM" where id = ${ids.ncrA}::uuid) as own,
               (select count(*) from public."NCM" where id = ${ids.ncrB}::uuid) as other`);
      return r.rows[0];
    });
    expect(counts).toEqual({ own: '1', other: '0' });
  });

  it('records source=api, correlation id and reason in the audit trail', async () => {
    const db = app.get(DatabaseService);
    await db.asUser(ctx(ids.ownerA, { correlationId: 'corr-e2e-1', reason: 'Re-measured' }), (tx) =>
      tx.execute(sql`update public."NCM" set description = 'A (re-measured)' where id = ${ids.ncrA}::uuid`),
    );
    const { rows } = await admin.query(
      `select actor_user_id, source, correlation_id, reason, changed_fields from audit.events
       where entity_id = $1 and action = 'update' order by seq desc limit 1`,
      [ids.ncrA],
    );
    expect(rows[0]).toEqual({
      actor_user_id: ids.ownerA,
      source: 'api',
      correlation_id: 'corr-e2e-1',
      reason: 'Re-measured',
      changed_fields: ['description'],
    });
  });

  it('rolls back everything when the work fails', async () => {
    const db = app.get(DatabaseService);
    await expect(
      db.asUser(ctx(ids.ownerA), async (tx) => {
        await tx.execute(sql`update public."NCM" set description = 'should not persist' where id = ${ids.ncrA}::uuid`);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const { rows } = await admin.query('select description from public."NCM" where id = $1', [ids.ncrA]);
    expect(rows[0].description).toBe('A (re-measured)');
  });

  it('does not leak role or claims to the next request on the same connection', async () => {
    const db = app.get(DatabaseService);
    const client = await db.pool.connect();
    try {
      const r = await client.query(`select current_user as role, nullif(current_setting('request.jwt.claims', true), '') as claims`);
      expect(r.rows[0]).toEqual({ role: 'qms_api', claims: null });
    } finally {
      client.release();
    }
  });
});

describe('rate limiting', () => {
  it('returns 429 with the standard error format once the limit is reached', async () => {
    const limited = await startApp({ RATE_LIMIT_PER_MINUTE: '3' });
    try {
      const auth = await bearer(ids.ownerA);
      for (let i = 0; i < 3; i++) await request(limited.getHttpServer()).get('/api/v1/me').set(auth).expect(200);
      const res = await request(limited.getHttpServer()).get('/api/v1/me').set(auth).expect(429);
      expect(res.body.error.code).toBe('rate_limited');
      // Health checks are not rate limited.
      await request(limited.getHttpServer()).get('/api/v1/health').expect(200);
    } finally {
      await limited.close();
    }
  });
});
