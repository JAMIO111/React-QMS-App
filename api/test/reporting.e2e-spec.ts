/**
 * Reporting API for Power BI (docs/reporting-api-plan.md): keys made and revoked by people who manage integrations, read-only reads of flat datasets with a key
 * (Bearer or Basic), keyset paging, refusal everywhere else, and the key stopping with its person. The database rules are in supabase/tests/reporting_keys.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { DATASETS } from '../src/reporting/datasets';
import { categoryId, giveControllerSeats, makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('bb10');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const bearer = (secret: string) => ({ Authorization: `Bearer ${secret}` });
const basic = (secret: string) => ({ Authorization: `Basic ${Buffer.from(`powerbi:${secret}`).toString('base64')}` });

const make = async (name = 'Power BI', days = 30) => {
  const res = await api().post('/api/v1/reporting/keys').set(await as(ids.ownerA)).send({ name, days }).expect(201);
  return res.body as { secret: string; key: { id: string; status: string; keyPrefix: string; mine: boolean } };
};

let refA: string;

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-rpt');
  await giveControllerSeats(admin, ids.orgA, [ids.ownerA, ids.dual]);
  await giveControllerSeats(admin, ids.orgB, [ids.ownerB]);
  // A second owner of organisation A (so one owner can be suspended without leaving it without any).
  await admin.query(`update public.user_role_assignments set role_id = (select id from public.roles where organisation_id = $1 and key = 'owner')
    where organisation_id = $1 and membership_id = (select id from public.organisation_users where organisation_id = $1 and user_id = $2)`, [ids.orgA, ids.dual]);
  const catA = await categoryId(admin, ids.orgA);
  const catB = await categoryId(admin, ids.orgB);
  const nc = await admin.query(
    `insert into public.nonconformances (organisation_id, reference, source, title, severity, description, stage, category_id, quantity_affected, detected_at)
     values ($1, 'NC-RP-0001', 'internal', 'Burrs on brackets', 'major', 'x', 'open', $2, 10, '2026-11-02') returning id, reference`,
    [ids.orgA, catA],
  );
  refA = nc.rows[0].reference;
  await admin.query(`insert into public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount) values ($1, $2, 'scrap', 'GBP', 100)`, [ids.orgA, nc.rows[0].id]);
  await admin.query(`insert into public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount) values ($1, $2, 'supplier_recovery', 'GBP', 30)`, [ids.orgA, nc.rows[0].id]);
  for (const [n, t] of [[2, 'Second'], [3, 'Third']] as const) {
    await admin.query(
      `insert into public.nonconformances (organisation_id, reference, source, title, severity, description, stage, category_id) values ($1, $2, 'internal', $3, 'minor', 'x', 'open', $4)`,
      [ids.orgA, `NC-RP-000${n}`, `${t} NC`, catA],
    );
  }
  await admin.query(
    `insert into public.nonconformances (organisation_id, reference, source, title, severity, description, stage, category_id) values ($1, 'NC-RPB-0001', 'internal', 'Beta only', 'minor', 'x', 'open', $2)`,
    [ids.orgB, catB],
  );
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('reporting keys', () => {
  it('are made by someone who manages integrations, shown once, and listed without the key', async () => {
    const { secret, key } = await make('Power BI', 30);
    expect(secret).toMatch(/^fqr_[A-Za-z0-9_-]{43}$/);
    expect(key).toMatchObject({ status: 'active', mine: true, keyPrefix: secret.slice(4, 12) });
    const list = (await api().get('/api/v1/reporting/keys').set(await as(ids.ownerA)).expect(200)).body.data as { id: string }[];
    expect(list.map((k) => k.id)).toContain(key.id);
    expect(JSON.stringify(list)).not.toContain(secret);
    const stored = (await admin.query('select key_hash from public.reporting_keys where id = $1', [key.id])).rows[0].key_hash;
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toContain(secret);
  });

  it('are refused to people without the right, and invalid requests are refused', async () => {
    const inspector = await as(ids.inspectorA);
    expect((await api().post('/api/v1/reporting/keys').set(inspector).send({ name: 'x', days: 5 })).status).toBe(403);
    expect((await api().get('/api/v1/reporting/keys').set(inspector)).status).toBe(403);
    const owner = await as(ids.ownerA);
    expect((await api().post('/api/v1/reporting/keys').set(owner).send({ name: '', days: 5 })).status).toBe(400);
    expect((await api().post('/api/v1/reporting/keys').set(owner).send({ name: 'x', days: 5000 })).status).toBe(400);
    expect((await api().post('/api/v1/reporting/keys').set(owner).send({ name: 'x', days: 5, userId: 'forged' })).status).toBe(400);
  });
});

describe('reading datasets with a key', () => {
  let secret: string;
  let keyId: string;
  beforeAll(async () => {
    const made = await make('Reader', 30);
    secret = made.secret;
    keyId = made.key.id;
  });

  it('lists the datasets and columns', async () => {
    const res = await api().get('/api/v1/reporting/v1/datasets').set(bearer(secret)).expect(200);
    expect(res.body.datasets.map((d: { key: string }) => d.key)).toEqual(DATASETS.map((d) => d.key));
    expect(res.body.datasets[0].columns[0]).toMatchObject({ name: 'id', type: 'text' });
  });

  it('returns the organisation’s non-conformances with typed values, with a Bearer key or a Basic password', async () => {
    for (const headers of [bearer(secret), basic(secret)]) {
      const res = await api().get('/api/v1/reporting/v1/non_conformances').set(headers).expect(200);
      expect(res.body).toMatchObject({ dataset: 'non_conformances', count: 3, nextCursor: null });
      const row = res.body.data.find((r: { reference: string }) => r.reference === refA);
      expect(row).toMatchObject({ title: 'Burrs on brackets', severity: 'major', stage: 'open', quantity_affected: 10, detected_on: '2026-11-02', cost_currency: 'GBP', total_cost: 70, cost_lines: 2 });
      expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      expect(row.organisation_id).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('Beta only');
    }
  });

  it('returns one row per cost line, signed, and the other datasets', async () => {
    const costs = (await api().get('/api/v1/reporting/v1/non_conformance_costs').set(bearer(secret)).expect(200)).body.data as { cost_sign: number; net_organisation_currency: number }[];
    expect(costs).toHaveLength(2);
    expect(costs.reduce((sum, c) => sum + c.net_organisation_currency, 0)).toBe(70);
    expect(costs.map((c) => c.cost_sign).sort()).toEqual([-1, 1]);
    for (const key of ['suppliers', 'scars', 'receipt_lines', 'supplier_scorecards']) {
      const res = await api().get(`/api/v1/reporting/v1/${key}`).set(bearer(secret)).expect(200);
      expect(res.body.dataset).toBe(key);
      expect(Array.isArray(res.body.data)).toBe(true);
    }
  });

  it('pages by keyset: every row once, in order, and only what changed since', async () => {
    const seen: string[] = [];
    let after: string | null = null;
    let pages = 0;
    do {
      const res: request.Response = await api().get('/api/v1/reporting/v1/non_conformances').query({ limit: 1, ...(after ? { after } : {}) }).set(bearer(secret)).expect(200);
      seen.push(...res.body.data.map((r: { id: string }) => r.id));
      after = res.body.nextCursor;
      pages += 1;
    } while (after && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(3);
    const future = new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z');
    const none = await api().get('/api/v1/reporting/v1/non_conformances').query({ updatedSince: future }).set(bearer(secret)).expect(200);
    expect(none.body).toMatchObject({ count: 0, nextCursor: null });
    const all = await api().get('/api/v1/reporting/v1/non_conformances').query({ updatedSince: '2020-01-01T00:00:00Z' }).set(bearer(secret)).expect(200);
    expect(all.body.count).toBe(3);
  });

  it('refuses a bad dataset, limit, cursor or time', async () => {
    expect((await api().get('/api/v1/reporting/v1/nope').set(bearer(secret))).status).toBe(404);
    expect((await api().get('/api/v1/reporting/v1/non_conformances').query({ limit: 0 }).set(bearer(secret))).status).toBe(400);
    expect((await api().get('/api/v1/reporting/v1/non_conformances').query({ limit: 9999 }).set(bearer(secret))).status).toBe(400);
    expect((await api().get('/api/v1/reporting/v1/non_conformances').query({ after: 'garbage' }).set(bearer(secret)))).toMatchObject({ status: 400 });
    expect((await api().get('/api/v1/reporting/v1/non_conformances').query({ updatedSince: 'yesterday' }).set(bearer(secret))).status).toBe(400);
  });

  it('is read-only: a key can call nothing but the reporting datasets', async () => {
    const res = await api().get('/api/v1/ncrs').set(bearer(secret)).set('X-Organisation-Id', ids.orgA);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('report_key_scope');
    expect((await api().post('/api/v1/reporting/keys').set(bearer(secret)).send({ name: 'more', days: 5 })).status).toBe(403);
    expect((await api().get('/api/v1/reporting/keys').set(bearer(secret))).status).toBe(403);
    expect((await api().get('/api/v1/me').set(bearer(secret))).status).toBe(403);
    expect((await api().patch('/api/v1/sites/' + ids.siteA).set(bearer(secret)).send({ name: 'Hijacked' })).status).toBe(403);
  });

  it('always reads the key’s own organisation, whatever the request says', async () => {
    const res = await api().get('/api/v1/reporting/v1/non_conformances').set(bearer(secret)).set('X-Organisation-Id', ids.orgB).expect(200);
    expect(res.body.count).toBe(3);
    expect(JSON.stringify(res.body)).not.toContain('Beta only');
  });

  it('refuses an unknown, malformed or truncated key, and says nothing about which', async () => {
    for (const bad of ['fqr_' + 'A'.repeat(43), 'fqr_short', secret.slice(0, -1)]) {
      const res = await api().get('/api/v1/reporting/v1/datasets').set(bearer(bad));
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('report_key_invalid');
    }
  });

  it('stops when the person it stands for is suspended, and works again when they are back', async () => {
    const made = (await api().post('/api/v1/reporting/keys').set(await as(ids.dual)).send({ name: 'Second owner', days: 30 }).expect(201)).body as { secret: string };
    expect((await api().get('/api/v1/reporting/v1/datasets').set(bearer(made.secret))).status).toBe(200);
    await admin.query(`update public.organisation_users set status = 'suspended' where organisation_id = $1 and user_id = $2`, [ids.orgA, ids.dual]);
    expect((await api().get('/api/v1/reporting/v1/datasets').set(bearer(made.secret))).status).toBe(401);
    await admin.query(`update public.organisation_users set status = 'active' where organisation_id = $1 and user_id = $2`, [ids.orgA, ids.dual]);
    expect((await api().get('/api/v1/reporting/v1/datasets').set(bearer(made.secret))).status).toBe(200);
  });

  it('stops when it expires', async () => {
    await admin.query(`update public.reporting_keys set expires_at = now() - interval '1 minute' where id = $1`, [keyId]);
    expect((await api().get('/api/v1/reporting/v1/datasets').set(bearer(secret))).status).toBe(401);
    const list = (await api().get('/api/v1/reporting/keys').set(await as(ids.ownerA)).expect(200)).body.data as { id: string; status: string }[];
    expect(list.find((k) => k.id === keyId)?.status).toBe('expired');
    await admin.query(`update public.reporting_keys set expires_at = now() + interval '1 day' where id = $1`, [keyId]);
  });

  it('is revoked at once, with a reason, and the record stays', async () => {
    const owner = await as(ids.ownerA);
    expect((await api().post(`/api/v1/reporting/keys/${keyId}/revoke`).set(owner).send({ reason: 'x' })).status).toBe(400);
    expect((await api().post(`/api/v1/reporting/keys/${keyId}/revoke`).set(await as(ids.inspectorA)).send({ reason: 'not mine to revoke' })).status).toBe(403);
    const res = await api().post(`/api/v1/reporting/keys/${keyId}/revoke`).set(owner).send({ reason: 'Moved to a new report' }).expect(201);
    expect(res.body).toMatchObject({ id: keyId, status: 'revoked', revokedReason: 'Moved to a new report' });
    const refused = await api().get('/api/v1/reporting/v1/datasets').set(bearer(secret));
    expect(refused.status).toBe(401);
    expect((await admin.query('select count(*)::int n from public.reporting_keys where id = $1', [keyId])).rows[0].n).toBe(1);
  });

  it('cannot be revoked by another organisation', async () => {
    const made = await make('Other org test', 5);
    const res = await api().post(`/api/v1/reporting/keys/${made.key.id}/revoke`).set(await as(ids.ownerB, ids.orgB)).send({ reason: 'not yours to revoke' });
    expect(res.status).toBe(404);
    expect((await api().get('/api/v1/reporting/v1/datasets').set(bearer(made.secret))).status).toBe(200);
  });
});

describe('the datasets match the database views', () => {
  it.each(DATASETS.map((d) => [d.key, d.view, d.columns.map((c) => c.name)] as const))('%s', async (_key, view, columns) => {
    const res = await admin.query(
      `select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name <> 'organisation_id' order by ordinal_position`,
      [view],
    );
    expect(res.rows.map((r) => r.column_name)).toEqual(columns);
  });
});
