/**
 * Recovery when everyone is locked out (docs/security-plan.md SE5): an organisation enforces from an address that later changes, so its own owner is
 * blocked; only a platform operator with an MFA session can put it back to monitor (never off), with a reason and how ownership was verified; the
 * owner gets in again, the approved networks are kept, the history shows it and owners and admins are told. The rules are in
 * supabase/tests/network_policy_recovery.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('5ec5');
let app: INestApplication;
let admin: Pool;
const OLD_LINE = '203.0.113.10';
const NEW_LINE = '198.51.100.200';
const api = () => request(app.getHttpServer());
const as = async (user: string, from: string, claims: Record<string, unknown> = {}) => ({
  Authorization: `Bearer ${await token(user, claims)}`,
  'X-Organisation-Id': ids.orgA,
  'X-Forwarded-For': from,
});
const operator = (claims = { aal: 'aal2' }) => as(ids.outsider, NEW_LINE, claims);
const body = { reason: 'The factory changed internet provider overnight', verification: 'Called Ada back on the number held for the account' };

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-se5');
  await admin.query(`insert into public.platform_admins (user_id, note) values ($1, 'e2e operator') on conflict do nothing`, [ids.outsider]);
  app = await startApp({ TRUST_PROXY_HOPS: '1', RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA, OLD_LINE);
  await api().post('/api/v1/security/networks').set(h).send({ name: 'Factory', network: OLD_LINE }).expect(201);
  await api().put('/api/v1/security/access-policy').set(h).send({ mode: 'enforce', confirm: true }).expect(200);
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('locked out', () => {
  it('the owner on the new line is blocked', async () => {
    const res = await api().get('/api/v1/security/access-policy').set(await as(ids.ownerA, NEW_LINE)).expect(403);
    expect(res.body.error).toMatchObject({ code: 'network_not_allowed', details: { address: NEW_LINE } });
  });

  it('the operator panel shows which organisations enforce', async () => {
    const res = await api().get('/api/v1/platform/organisations').query({ search: 'Alpha Precision' }).set(await operator()).expect(200);
    const row = res.body.data.find((o: { organisationId: string }) => o.organisationId === ids.orgA);
    expect(row.networkPolicy).toBe('enforce');
  });
});

describe('recovery', () => {
  const path = `/api/v1/platform/organisations/${ids.orgA}/recover-network-policy`;

  it('is only for a platform operator with an MFA session', async () => {
    expect((await api().post(path).set(await as(ids.ownerA, OLD_LINE, { aal: 'aal2' })).send(body).expect(404)).body.error.code).toBe('not_found');
    expect((await api().post(path).set(await operator({ aal: 'aal1' })).send(body).expect(403)).body.error.code).toBe('mfa_required');
  });

  it('needs a reason and how ownership was verified', async () => {
    await api().post(path).set(await operator()).send({ reason: 'short', verification: body.verification }).expect(400);
    await api().post(path).set(await operator()).send({ reason: body.reason }).expect(400);
  });

  it('puts the policy back to monitor; the owner gets in, the networks are kept, the history and the owners know', async () => {
    const res = await api().post(path).set(await operator()).send(body).expect(200);
    expect(res.body).toMatchObject({ organisationId: ids.orgA, networkPolicy: 'monitor' });

    const policy = (await api().get('/api/v1/security/access-policy').set(await as(ids.ownerA, NEW_LINE)).expect(200)).body;
    expect(policy).toMatchObject({ mode: 'monitor', activeCount: 1, covered: false });
    expect(policy.history[0]).toMatchObject({ kind: 'recovery', from: 'enforce', to: 'monitor', by: 'Fortress support', reason: body.reason, verification: body.verification });
    expect(policy.history[1]).toMatchObject({ kind: 'change', from: 'off', to: 'enforce', by: 'Ada Owner' });

    const notes = await admin.query(
      `select n.body, n.actor_user_id from public.notifications n join public.notification_event_types t on t.id = n.event_type_id
        where n.organisation_id = $1 and t.key = 'network_policy_changes.created' order by n.created_at`,
      [ids.orgA],
    );
    expect(notes.rows.map((r) => r.actor_user_id)).toEqual([null, null]);
    expect(notes.rows[0].body).toMatch(/If everyone is locked out/);
    expect(notes.rows[1].body).toMatch(/Fortress support put network restrictions back to monitor/);
  });

  it('there is nothing to recover once it no longer enforces', async () => {
    expect((await api().post(path).set(await operator()).send(body).expect(409)).body.error.code).toBe('security_rule');
  });

  it('an unknown organisation is 404', async () => {
    await api().post(`/api/v1/platform/organisations/${ids.orgB.replace(/.$/, '9')}/recover-network-policy`).set(await operator()).send(body).expect(404);
  });
});
