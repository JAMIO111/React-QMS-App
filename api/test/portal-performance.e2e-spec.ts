/**
 * A supplier's own performance in the portal (docs/external-portal-plan.md PT4) through the API: named fields only, the tiles staff chose, the ranking
 * only when the organisation switches it on, other suppliers and customers refused. The rules are in supabase/tests/portal_performance.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('9c77');
const u = (tail: string) => `${'9c77'.padEnd(8, '0')}-0000-0000-0000-${tail.padStart(12, '0')}`;
const sam = u('e1');
const cus = u('e4');
let app: INestApplication;
let admin: Pool;
let partyA: string;
const api = () => request(app.getHttpServer());
const staff = async () => ({ Authorization: `Bearer ${await token(ids.ownerA)}`, 'X-Organisation-Id': ids.orgA });
const external = async (user: string) => ({ Authorization: `Bearer ${await token(user, { aal: 'aal2' })}`, 'X-Organisation-Id': ids.orgA });
const bare = async (user: string) => ({ Authorization: `Bearer ${await token(user, { aal: 'aal2' })}` });

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-pt4');
  for (const [id, email] of [[sam, 'sam@acme-pt4.test'], [cus, 'cus@wayne-pt4.test']]) {
    await admin.query(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now()) on conflict do nothing`, [id, email]);
  }
  await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'ACME', 'Acme Castings') on conflict do nothing`, [ids.orgA]);
  await admin.query(`insert into public.customers (organisation_id, code, name) values ($1, 'WAYNE', 'Wayne Ltd') on conflict do nothing`, [ids.orgA]);
  const acme = (await admin.query(`select id from public.suppliers where organisation_id = $1 and code = 'ACME'`, [ids.orgA])).rows[0].id;
  const wayne = (await admin.query(`select id from public.customers where organisation_id = $1 and code = 'WAYNE'`, [ids.orgA])).rows[0].id;
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  await api().put('/api/v1/external-access/settings').set(await staff()).send({ enabled: true, requireMfa: false }).expect(200);
  const a = await api().put('/api/v1/external-access/parties').set(await staff()).send({ kind: 'supplier', partyId: acme, enabled: true }).expect(200);
  const c = await api().put('/api/v1/external-access/parties').set(await staff()).send({ kind: 'customer', partyId: wayne, enabled: true }).expect(200);
  partyA = a.body.parties.find((p: { name: string }) => p.name === 'Acme Castings').partyId;
  const partyC = c.body.parties.find((p: { name: string }) => p.name === 'Wayne Ltd').partyId;
  for (const [party, email, user] of [[partyA, 'sam@acme-pt4.test', sam], [partyC, 'cus@wayne-pt4.test', cus]] as const) {
    await api().post('/api/v1/external-access/people').set(await staff()).send({ partyId: party, email, role: 'admin' }).expect(201);
    const inv = (await api().get('/api/v1/portal/invitations').set(await bare(user))).body.data[0];
    await api().post(`/api/v1/portal/invitations/${inv.id}/accept`).set(await bare(user)).expect(201);
  }
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('portal performance', () => {
  it('gives a supplier its own figures as named fields only', async () => {
    const r = await api().get('/api/v1/portal/performance').set(await external(sam)).expect(200);
    expect(Object.keys(r.body).sort()).toEqual(['certs', 'delivery', 'ncs', 'period', 'quality', 'scars', 'score', 'tiles', 'trend']);
    expect(r.body.period.days).toBe(90);
    expect(r.body.score.band).toBe('insufficient');
    expect(JSON.stringify(r.body)).not.toContain('sources');
  });

  it('takes 30, 90 or 365 days and nothing else', async () => {
    await api().get('/api/v1/portal/performance?days=30').set(await external(sam)).expect(200);
    await api().get('/api/v1/portal/performance?days=45').set(await external(sam)).expect(400);
  });

  it('leaves out a tile staff switched off', async () => {
    await api().put('/api/v1/external-access/parties').set(await staff()).send({ kind: 'supplier', partyId: (await admin.query(`select supplier_id from public.portal_parties where id = $1`, [partyA])).rows[0].supplier_id, tiles: { delivery: false, trend: false } }).expect(200);
    const r = await api().get('/api/v1/portal/performance').set(await external(sam)).expect(200);
    expect(r.body.delivery).toBeUndefined();
    expect(r.body.trend).toBeUndefined();
    expect(r.body.quality).toBeDefined();
  });

  it('shows the ranking only when the organisation switched it on, and gives no band without five scored suppliers', async () => {
    expect((await api().get('/api/v1/portal/performance').set(await external(sam))).body.ranking).toBeUndefined();
    await api().put('/api/v1/external-access/settings').set(await staff()).send({ rankingEnabled: true }).expect(200);
    const r = await api().get('/api/v1/portal/performance').set(await external(sam)).expect(200);
    expect(r.body.ranking).toEqual({ band: null, enough: false });
  });

  it('is not for a customer or a stranger', async () => {
    await api().get('/api/v1/portal/performance').set(await external(cus)).expect(404);
    await api().get('/api/v1/portal/performance').set(await external(ids.ownerB)).expect(404);
  });
});
