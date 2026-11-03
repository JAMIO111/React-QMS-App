import { INestApplication } from '@nestjs/common';
import { SignJWT } from 'jose';
import { Pool } from 'pg';
import { createApp } from '../src/app.factory';
import { Env, loadEnv } from '../src/config/env';

export const JWT_SECRET = 'e2e-secret-that-is-at-least-32-characters-long';
export const ISSUER = 'e2e-issuer';

/** Ids used by the e2e seed (distinct from the SQL tests' fixtures). */
export const ids = {
  orgA: '10000000-0000-0000-0000-00000000000a',
  orgB: '10000000-0000-0000-0000-00000000000b',
  ownerA: '10000000-0000-0000-0000-0000000000a1',
  inspectorA: '10000000-0000-0000-0000-0000000000a2',
  suspendedA: '10000000-0000-0000-0000-0000000000a3',
  ownerB: '10000000-0000-0000-0000-0000000000b1',
  dual: '10000000-0000-0000-0000-0000000000d1',
  outsider: '10000000-0000-0000-0000-0000000000ff',
  ncrA: '10000000-0000-0000-0000-0000000000c1',
  ncrB: '10000000-0000-0000-0000-0000000000c2',
};

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

/** Two organisations with members in different roles, seeded as the superuser (idempotent). */
export async function seed(admin: Pool): Promise<void> {
  const exists = await admin.query('select 1 from public.organisations where id = $1', [ids.orgA]);
  if (exists.rowCount) return;

  await admin.query('begin');
  await admin.query(
    `insert into auth.users (id, email) values ($1,'owner.a@example.test'),($2,'inspector.a@example.test'),
       ($3,'suspended.a@example.test'),($4,'owner.b@example.test'),($5,'dual@example.test'),($6,'outsider@example.test')`,
    [ids.ownerA, ids.inspectorA, ids.suspendedA, ids.ownerB, ids.dual, ids.outsider],
  );
  await admin.query(`update public.profiles set first_name = 'Ada', surname = 'Owner' where id = $1`, [ids.ownerA]);
  await admin.query(
    `insert into public.organisations (id, name, slug) values ($1, 'Alpha Precision', 'alpha-precision'), ($2, 'Beta Castings', 'beta-castings')`,
    [ids.orgA, ids.orgB],
  );
  await admin.query(
    `insert into public.organisation_settings (organisation_id, base_currency, vat_rate) values ($1, 'GBP', 0.2), ($2, 'EUR', 0.21)`,
    [ids.orgA, ids.orgB],
  );
  await admin.query('select app.create_default_roles($1), app.create_default_roles($2)', [ids.orgA, ids.orgB]);

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
