import { INestApplication } from '@nestjs/common';
import { SignJWT } from 'jose';
import { Pool } from 'pg';
import { createApp } from '../src/app.factory';
import { Env, loadEnv } from '../src/config/env';

export const JWT_SECRET = 'e2e-secret-that-is-at-least-32-characters-long';
export const ISSUER = 'e2e-issuer';

/**
 * Ids for one e2e suite's seed. Each suite uses its own digit so suites never share (and never
 * mutate each other's) users or organisations.
 */
export function makeIds(suite: number) {
  const id = (tail: string) => `${suite}0000000-0000-0000-0000-${tail.padStart(12, '0')}`;
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
