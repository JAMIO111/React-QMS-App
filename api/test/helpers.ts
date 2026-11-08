import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { SignJWT } from 'jose';
import { Pool } from 'pg';
import { createApp } from '../src/app.factory';
import { Env, loadEnv } from '../src/config/env';

export const JWT_SECRET = 'e2e-secret-that-is-at-least-32-characters-long';
export const ISSUER = 'e2e-issuer';

/**
 * Ids for one e2e suite's seed. Every suite needs its OWN prefix (one or two hex characters, padded with zeros to the
 * first uuid group) so suites never share, or mutate, each other's users and organisations: `seed` stops when the
 * organisation exists, so two suites with one prefix would silently depend on which runs first.
 */
export function makeIds(suite: number | string) {
  const head = String(suite).padEnd(8, '0');
  const id = (tail: string) => `${head}-0000-0000-0000-${tail.padStart(12, '0')}`;
  return {
    orgA: id('a'),
    orgB: id('b'),
    ownerA: id('a1'),
    inspectorA: id('a2'),
    suspendedA: id('a3'),
    ownerB: id('b1'),
    dual: id('d1'),
    outsider: id('ff'),
    siteA: id('5a1'),
    siteB: id('5b1'),
    ncrA: id('c1'),
    ncrB: id('c2'),
  };
}
export type Ids = ReturnType<typeof makeIds>;

/** Default ids (suite 1). */
export const ids = makeIds(1);

export function requireDb(): { url: string; adminUrl: string } {
  const url = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!url || !adminUrl) {
    throw new Error('e2e tests need DATABASE_URL and DATABASE_ADMIN_URL — run `npm run api:test:e2e` from the repo root');
  }
  return { url, adminUrl };
}

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: requireDb().url,
    SUPABASE_JWT_SECRET: JWT_SECRET,
    JWT_ISSUER: ISSUER,
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

export async function startApp(overrides: Record<string, string> = {}): Promise<INestApplication> {
  const app = await createApp(testEnv(overrides));
  await app.init();
  return app;
}

export function token(userId: string, claims: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({ role: 'authenticated', email: `${userId.slice(-2)}@example.test`, ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

/**
 * Two organisations with members in different roles, seeded as the superuser (idempotent).
 * `slugSuffix` keeps slugs (globally unique) distinct between suites.
 */
export async function seed(admin: Pool, ids: Ids = makeIds(1), slugSuffix = ''): Promise<void> {
  const exists = await admin.query('select 1 from public.organisations where id = $1', [ids.orgA]);
  if (exists.rowCount) return;

  await admin.query('begin');
  await admin.query(
    `insert into auth.users (id, email)
     select u::uuid, u || '@example.test' from unnest(array[$1, $2, $3, $4, $5, $6]::text[]) as u`,
    [ids.ownerA, ids.inspectorA, ids.suspendedA, ids.ownerB, ids.dual, ids.outsider],
  );
  await admin.query(`update public.profiles set first_name = 'Ada', surname = 'Owner' where id = $1`, [ids.ownerA]);
  await admin.query(
    `insert into public.organisations (id, name, slug) values ($1, 'Alpha Precision', $3), ($2, 'Beta Castings', $4)`,
    [ids.orgA, ids.orgB, `alpha-precision${slugSuffix}`, `beta-castings${slugSuffix}`],
  );
  await admin.query(
    `insert into public.organisation_settings (organisation_id, base_currency, vat_rate) values ($1, 'GBP', 0.2), ($2, 'EUR', 0.21)`,
    [ids.orgA, ids.orgB],
  );
  await admin.query('select app.create_default_roles($1), app.create_default_roles($2)', [ids.orgA, ids.orgB]);
  await admin.query(
    `insert into public.sites (id, organisation_id, code, name) values ($1, $2, 'MAIN', 'Alpha main'), ($3, $4, 'MAIN', 'Beta main')`,
    [ids.siteA, ids.orgA, ids.siteB, ids.orgB],
  );

  const members: [string, string, string, string][] = [
    [ids.orgA, ids.ownerA, 'owner', 'active'],
    [ids.orgA, ids.inspectorA, 'inspector', 'active'],
    [ids.orgA, ids.suspendedA, 'quality_manager', 'suspended'],
    [ids.orgA, ids.dual, 'viewer', 'active'],
    [ids.orgB, ids.ownerB, 'owner', 'active'],
    [ids.orgB, ids.dual, 'viewer', 'active'],
  ];
  for (const [org, user, role, status] of members) {
    const { rows } = await admin.query(
      `insert into public.organisation_users (organisation_id, user_id, status, joined_at) values ($1, $2, 'active', now()) returning id`,
      [org, user],
    );
    await admin.query(
      `insert into public.user_role_assignments (organisation_id, membership_id, role_id)
       select $1, $2, id from public.roles where organisation_id = $1 and key = $3`,
      [org, rows[0].id, role],
    );
    if (status !== 'active') {
      await admin.query('update public.organisation_users set status = $1 where id = $2', [status, rows[0].id]);
    }
  }
  await admin.query(
    `insert into public."NCM" (id, organisation_id, ncm_id, description) values ($1, $2, 'NCM-26-001', 'A'), ($3, $4, 'NCM-26-001', 'B')`,
    [ids.ncrA, ids.orgA, ids.ncrB, ids.orgB],
  );
  await admin.query('commit');
}

/**
 * What a non-conformance needs before it can reach Dispositioned and beyond: containment resolved (not needed) and approved dispositions over the whole
 * quantity affected. For tests that move NCs through the stages; `h` must be someone who may edit and approve (the owner).
 */
export async function settleNcr(server: unknown, h: Record<string, string>, id: string): Promise<void> {
  const api = () => request(server as never);
  await api().put(`/api/v1/ncrs/${id}/containment-reason`).set(h).send({ reason: 'Not needed (test)' }).expect(200);
  const d = (await api().get(`/api/v1/ncrs/${id}/dispositions`).set(h).expect(200)).body;
  if (d.remaining > 0) {
    await api().post(`/api/v1/ncrs/${id}/dispositions`).set(h).send({ decision: 'scrap', quantity: d.remaining, instructions: 'Scrap the affected items (test)' }).expect(201);
  }
  const all = (await api().get(`/api/v1/ncrs/${id}/dispositions`).set(h).expect(200)).body.data as { id: string; status: string }[];
  for (const x of all.filter((y) => y.status === 'proposed')) await api().post(`/api/v1/ncr-dispositions/${x.id}/approve`).set(h).send({}).expect(200);
}

const categories = new Map<string, string>();
/** The id of one of an organisation's seeded categories (default "Product"): a category is needed to open a non-conformance. */
export async function categoryId(admin: Pool, organisationId: string, code = 'PRODUCT'): Promise<string> {
  const key = `${organisationId}/${code}`;
  if (!categories.has(key)) {
    const r = await admin.query(`select id from public.ncr_classifications where organisation_id = $1 and kind = 'category' and code = $2`, [organisationId, code]);
    if (!r.rows[0]) throw new Error(`No ${code} category for ${organisationId}`);
    categories.set(key, r.rows[0].id);
  }
  return categories.get(key)!;
}
