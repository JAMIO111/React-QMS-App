/**
 * Integrations IN1 through the API: the provider catalogue, creating and changing connections (configuration checked by the database), the lifecycle with a second approver,
 * credentials stored in Vault and never returned, permissions and tenant isolation.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { giveControllerSeats, makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('1f');
const approverId = `${String('1f').padEnd(8, '0')}-0000-0000-0000-0000000000e1`;
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const owner = () => as(ids.ownerA);
const approver = () => as(approverId);
const inspector = () => as(ids.inspectorA);
const other = () => as(ids.ownerB, ids.orgB);
const base = '/api/v1/integrations';
const SECRET = 'e2e-super-secret-token-123';

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-in');
  await admin.query(`insert into auth.users (id, email) values ($1, 'approver@example.test')`, [approverId]);
  const { rows } = await admin.query(`insert into public.organisation_users (organisation_id, user_id, status, joined_at) values ($1, $2, 'active', now()) returning id`, [ids.orgA, approverId]);
  await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = 'quality_manager'`, [ids.orgA, rows[0].id]);
  await giveControllerSeats(admin, ids.orgA, [ids.ownerA, approverId]);
  await giveControllerSeats(admin, ids.orgB, [ids.ownerB]);
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('integration connections', () => {
  let csvId: string;
  let restId: string;

  it('lists the providers, and only for people who may read integrations', async () => {
    const res = (await api().get(`${base}/providers`).set(await owner()).expect(200)).body.data;
    expect(res.map((p: { key: string }) => p.key)).toEqual(['csv', 'rest_api', 'sql_agent']);
    expect(res.find((p: { key: string }) => p.key === 'sql_agent').status).toBe('planned');
    await api().get(`${base}/providers`).set(await inspector()).expect(403);
    await api().get(`${base}/connections`).set(await inspector()).expect(403);
  });

  it('creates a draft connection and validates what it is given', async () => {
    const c = (await api().post(`${base}/connections`).set(await owner()).send({ providerKey: 'csv', name: 'ERP parts file', externalSystem: 'erp', config: { delimiter: ';' } }).expect(201)).body;
    csvId = c.id;
    expect(c).toMatchObject({ status: 'draft', externalSystem: 'erp', provider: { key: 'csv' }, credential: null, problems: [] });
    expect(c.events).toHaveLength(1);
    await api().post(`${base}/connections`).set(await inspector()).send({ providerKey: 'csv', name: 'Nope', externalSystem: 'nope' }).expect(403);
    await api().post(`${base}/connections`).set(await owner()).send({ providerKey: 'csv', name: 'x', externalSystem: 'erp3' }).expect(400); // name too short
    await api().post(`${base}/connections`).set(await owner()).send({ providerKey: 'csv', name: 'Dup code', externalSystem: 'ERP 2' }).expect(400);
    await api().post(`${base}/connections`).set(await owner()).send({ providerKey: 'csv', name: 'erp PARTS file', externalSystem: 'erp9' }).expect(409);
    await api().post(`${base}/connections`).set(await owner()).send({ providerKey: 'csv', name: 'Other', externalSystem: 'erp' }).expect(409);
    await api().post(`${base}/connections`).set(await owner()).send({ providerKey: 'sql_agent', name: 'Agent', externalSystem: 'agent' }).expect(409);
    await api().post(`${base}/connections`).set(await owner()).send({ providerKey: 'csv', name: 'Bad delimiter', externalSystem: 'bad1', config: { delimiter: 'x' } }).expect(409);
    await api().post(`${base}/connections`).set(await owner()).send({ providerKey: 'csv', name: 'Extra', externalSystem: 'bad2', extra: 1 }).expect(400);
    for (const baseUrl of ['http://api.example.com', 'https://localhost/x', 'https://10.0.0.1/x', 'https://169.254.169.254/latest', 'https://u:p@api.example.com']) {
      await api().post(`${base}/connections`).set(await owner()).send({ providerKey: 'rest_api', name: `Bad ${baseUrl}`.slice(0, 40), externalSystem: 'badrest', config: { baseUrl } }).expect(409);
    }
    const r = (await api().post(`${base}/connections`).set(await owner()).send({ providerKey: 'rest_api', name: 'ERP REST', externalSystem: 'erp-api', config: { baseUrl: 'https://api.example.com/v1', authType: 'bearer' } }).expect(201)).body;
    restId = r.id;
    const list = (await api().get(`${base}/connections`).set(await owner()).expect(200)).body.data;
    expect(list.map((x: { name: string }) => x.name)).toEqual(['ERP parts file', 'ERP REST']);
  });

  it('stores a credential without ever returning, logging or auditing its value', async () => {
    await api().put(`${base}/connections/${restId}/credential`).set(await inspector()).send({ kind: 'bearer', secret: SECRET }).expect(403);
    await api().put(`${base}/connections/${restId}/credential`).set(await owner()).send({ kind: 'oauth_client', secret: SECRET }).expect(409);
    const res = await api().put(`${base}/connections/${restId}/credential`).set(await owner()).send({ kind: 'bearer', secret: SECRET }).expect(200);
    expect(res.body.credential).toMatchObject({ kind: 'bearer' });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect((await api().get(`${base}/connections/${restId}`).set(await owner()).expect(200)).text).not.toContain(SECRET);
    expect((await api().get(`${base}/connections`).set(await owner()).expect(200)).text).not.toContain(SECRET);
    // the wrong kind is refused with a message that does not echo the value
    const bad = await api().put(`${base}/connections/${restId}/credential`).set(await owner()).send({ kind: 'oauth_client', secret: SECRET }).expect(409);
    expect(JSON.stringify(bad.body)).not.toContain(SECRET);
    await api().put(`${base}/connections/${restId}/credential`).set(await owner()).send({ kind: 'bearer', secret: '' }).expect(400);
    const inVault = await admin.query(`select count(*)::int as n from public.integration_credentials where connection_id = $1 and revoked_at is null and secret_id is not null`, [restId]);
    expect(inVault.rows[0].n).toBe(1);
    const leaked = await admin.query(`select count(*)::int as n from audit.events where new_values::text like $1 or previous_values::text like $1`, [`%${SECRET}%`]);
    expect(leaked.rows[0].n).toBe(0);
    const hist = await admin.query(`select count(*)::int as n from public.integration_connection_events where note like $1`, [`%${SECRET}%`]);
    expect(hist.rows[0].n).toBe(0);
  });

  it('a REST connection cannot be tested or made ready until its connector exists; a file connection can', async () => {
    const t = await api().post(`${base}/connections/${restId}/test`).set(await owner()).send({}).expect(409);
    expect(t.body.error.message).toMatch(/not available yet/);
    const r = await api().post(`${base}/connections/${restId}/ready`).set(await owner()).send({}).expect(409);
    expect(r.body.error.message).toMatch(/Test the connection/);
    const tested = (await api().post(`${base}/connections/${csvId}/test`).set(await owner()).send({}).expect(200)).body;
    expect(tested.lastTest).toMatchObject({ ok: true });
    await api().post(`${base}/connections/${csvId}/test`).set(await inspector()).send({}).expect(403);
    const ready = (await api().post(`${base}/connections/${csvId}/ready`).set(await approver()).send({}).expect(200)).body;
    expect(ready).toMatchObject({ status: 'ready', readyBy: { name: expect.any(String) }, canActivate: false });
  });

  it('activation needs a different person with approval rights (an owner or admin may activate their own), and the lifecycle keeps its history', async () => {
    await api().post(`${base}/connections/${csvId}/activate`).set(await approver()).send({}).expect(409); // the preparer, a quality manager
    await api().post(`${base}/connections/${csvId}/activate`).set(await inspector()).send({}).expect(403);
    expect((await api().get(`${base}/connections/${csvId}`).set(await owner()).expect(200)).body.canActivate).toBe(true);
    const active = (await api().post(`${base}/connections/${csvId}/activate`).set(await owner()).send({}).expect(200)).body;
    expect(active).toMatchObject({ status: 'active' });
    expect(active.activatedBy).not.toBeNull();
    await api().patch(`${base}/connections/${csvId}`).set(await owner()).send({ name: 'Renamed while active' }).expect(409);
    await api().post(`${base}/connections/${csvId}/pause`).set(await owner()).send({ reason: 'x' }).expect(400);
    await api().post(`${base}/connections/${csvId}/pause`).set(await owner()).send({ reason: 'Source being rebuilt' }).expect(200);
    const renamed = (await api().patch(`${base}/connections/${csvId}`).set(await owner()).send({ name: 'ERP parts (file)' }).expect(200)).body;
    expect(renamed.name).toBe('ERP parts (file)');
    await api().post(`${base}/connections/${csvId}/resume`).set(await owner()).send({}).expect(200);
    const detail = (await api().get(`${base}/connections/${csvId}`).set(await owner()).expect(200)).body;
    expect(detail.events.map((e: { action: string }) => e.action).reverse()).toEqual(expect.arrayContaining(['created', 'tested', 'ready', 'activated', 'paused', 'resumed']));
  });

  it('revoking a credential deletes the secret and retiring is final', async () => {
    await api().post(`${base}/connections/${restId}/credential/revoke`).set(await owner()).send({ reason: 'no' }).expect(400);
    const revoked = (await api().post(`${base}/connections/${restId}/credential/revoke`).set(await owner()).send({ reason: 'Key exposed in a ticket' }).expect(200)).body;
    expect(revoked.credential).toBeNull();
    await api().post(`${base}/connections/${restId}/credential/revoke`).set(await owner()).send({ reason: 'Again please' }).expect(404);
    const live = await admin.query(`select count(*)::int as n from vault.secrets where name like $1`, [`integration/${restId}/%`]);
    expect(live.rows[0].n).toBe(0);
    await api().post(`${base}/connections/${restId}/retire`).set(await owner()).send({ reason: 'Replaced by the file importer' }).expect(200);
    await api().post(`${base}/connections/${restId}/resume`).set(await owner()).send({}).expect(409);
    await api().put(`${base}/connections/${restId}/credential`).set(await owner()).send({ kind: 'bearer', secret: SECRET }).expect(409);
    const list = (await api().get(`${base}/connections`).set(await owner()).expect(200)).body.data;
    expect(list[list.length - 1]).toMatchObject({ id: restId, status: 'retired' });
  });

  it('is invisible to another organisation', async () => {
    await api().get(`${base}/connections/${csvId}`).set(await other()).expect(404);
    await api().patch(`${base}/connections/${csvId}`).set(await other()).send({ name: 'Hijacked' }).expect(404);
    await api().put(`${base}/connections/${csvId}/credential`).set(await other()).send({ kind: 'bearer', secret: 'x' }).expect(404);
    await api().post(`${base}/connections/${csvId}/pause`).set(await other()).send({ reason: 'Hijacked' }).expect(404);
    expect((await api().get(`${base}/connections`).set(await other()).expect(200)).body.data).toEqual([]);
  });
});

describe('Controller seats and owners activating their own', () => {
  it('an owner sets up and activates a connection on their own', async () => {
    const c = (await api().post(`${base}/connections`).set(await owner()).send({ providerKey: 'csv', name: 'Owner solo file', externalSystem: 'solo' }).expect(201)).body;
    const ready = (await api().post(`${base}/connections/${c.id}/ready`).set(await owner()).send({}).expect(200)).body;
    expect(ready.canActivate).toBe(true);
    const active = (await api().post(`${base}/connections/${c.id}/activate`).set(await owner()).send({}).expect(200)).body;
    expect(active).toMatchObject({ status: 'active', readyBy: { id: ids.ownerA }, activatedBy: { id: ids.ownerA } });
  });

  it('someone whose role allows integrations but who holds no Controller seat sees nothing and the menu lists no integrations permission', async () => {
    await admin.query(
      `insert into public.user_role_assignments (organisation_id, membership_id, role_id)
       select $1, m.id, r.id from public.organisation_users m join public.roles r on r.organisation_id = $1 and r.key = 'admin' where m.organisation_id = $1 and m.user_id = $2`,
      [ids.orgA, ids.dual],
    );
    const dual = await as(ids.dual);
    await api().get(`${base}/connections`).set(dual).expect(403);
    await api().post(`${base}/connections`).set(dual).send({ providerKey: 'csv', name: 'No seat', externalSystem: 'noseat' }).expect(403);
    const me = (await api().get('/api/v1/me').set(dual).expect(200)).body;
    const perms = me.memberships.find((m: { organisation: { id: string } }) => m.organisation.id === ids.orgA).permissions as string[];
    expect(perms.some((p) => p.startsWith('integrations.'))).toBe(false);
    expect(perms).toContain('capa.manage'); // the rest of the admin role is unchanged
  });
});
