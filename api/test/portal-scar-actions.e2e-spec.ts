/**
 * Actions staff set on a SCAR, completed by the supplier in the portal (docs/external-portal-plan.md PT3d) through the API: staff routes and rights, what
 * the supplier sees (named fields, cancelled ones hidden), completing with a note, counts on the portal home, staff told, isolation between suppliers.
 * The rules themselves are in supabase/tests/portal_scar_actions.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { categoryId, makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('9c75');
const u = (tail: string) => `${'9c75'.padEnd(8, '0')}-0000-0000-0000-${tail.padStart(12, '0')}`;
const sam = u('e1');
const ben = u('e3');
let app: INestApplication;
let admin: Pool;
let scarId: string;
let draftId: string;
let a1: string;
let a2: string;
const api = () => request(app.getHttpServer());
const staff = async (user = ids.ownerA, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const external = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user, { aal: 'aal2' })}`, 'X-Organisation-Id': org });
const bare = async (user: string) => ({ Authorization: `Bearer ${await token(user, { aal: 'aal2' })}` });
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-pt3d');
  for (const [id, email] of [[sam, 'sam@acme-pt3d.test'], [ben, 'ben@bolt-pt3d.test']]) {
    await admin.query(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now()) on conflict do nothing`, [id, email]);
  }
  await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'ACME', 'Acme Castings'), ($1, 'BOLT', 'Bolt Ltd') on conflict do nothing`, [ids.orgA]);
  const acme = (await admin.query(`select id from public.suppliers where organisation_id = $1 and code = 'ACME'`, [ids.orgA])).rows[0].id;
  const bolt = (await admin.query(`select id from public.suppliers where organisation_id = $1 and code = 'BOLT'`, [ids.orgA])).rows[0].id;
  const nc = await admin.query(
    `insert into public.nonconformances (organisation_id, reference, source, stage, category_id, title, severity, quantity_affected, site_id, supplier_id)
     values ($1, 'PT3D-E2E-1', 'supplier', 'open', $2, 'Cracked bar stock', 'major', 10, $3, $4) returning id`,
    [ids.orgA, await categoryId(admin, ids.orgA), ids.siteA, acme],
  );
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  await api().put('/api/v1/external-access/settings').set(await staff()).send({ enabled: true, requireMfa: false }).expect(200);
  const a = await api().put('/api/v1/external-access/parties').set(await staff()).send({ kind: 'supplier', partyId: acme, enabled: true }).expect(200);
  const b = await api().put('/api/v1/external-access/parties').set(await staff()).send({ kind: 'supplier', partyId: bolt, enabled: true }).expect(200);
  const partyA = a.body.parties.find((p: { name: string }) => p.name === 'Acme Castings').partyId;
  const partyB = b.body.parties.find((p: { name: string }) => p.name === 'Bolt Ltd').partyId;
  for (const [party, email, user] of [[partyA, 'sam@acme-pt3d.test', sam], [partyB, 'ben@bolt-pt3d.test', ben]] as const) {
    await api().post('/api/v1/external-access/people').set(await staff()).send({ partyId: party, email, role: 'admin' }).expect(201);
    const inv = (await api().get('/api/v1/portal/invitations').set(await bare(user))).body.data[0];
    await api().post(`/api/v1/portal/invitations/${inv.id}/accept`).set(await bare(user)).expect(201);
  }
  const create = async (title: string) =>
    (await api().post('/api/v1/supplier-quality/scars').set(await staff()).send({ supplierId: acme, title, severity: 'major', responseDueOn: inDays(10), ncrIds: [nc.rows[0].id] }).expect(201)).body.id as string;
  draftId = await create('Draft with an action');
  scarId = await create('Cracked castings');
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('staff set actions', () => {
  it('add, change and cancel actions; an inspector may not', async () => {
    await api().post(`/api/v1/supplier-quality/scars/${draftId}/actions`).set(await staff()).send({ description: 'Prepared before issuing' }).expect(200);
    await api().post(`/api/v1/supplier-quality/scars/${scarId}/actions`).set(await staff(ids.inspectorA)).send({ description: 'Not allowed' }).expect(403);
    await api().post(`/api/v1/supplier-quality/scars/${scarId}/actions`).set(await staff()).send({ description: 'xx' }).expect(400);
    const one = await api().post(`/api/v1/supplier-quality/scars/${scarId}/actions`).set(await staff()).send({ description: 'Sort the stock in your warehouse', dueOn: inDays(7) }).expect(200);
    a1 = one.body.actions[0].id;
    expect(one.body.actions[0]).toMatchObject({ description: 'Sort the stock in your warehouse', status: 'open', overdue: false, resultNote: null });
    const two = await api().post(`/api/v1/supplier-quality/scars/${scarId}/actions`).set(await staff()).send({ description: 'Send us the heat treatment records' }).expect(200);
    a2 = two.body.actions.find((x: { description: string }) => x.description.startsWith('Send us')).id;
    const changed = await api().patch(`/api/v1/supplier-quality/scar-actions/${a2}`).set(await staff()).send({ description: 'Send us the heat treatment records for lot 77', dueOn: inDays(14) }).expect(200);
    expect(changed.body.actions.map((x: { description: string }) => x.description)).toContain('Send us the heat treatment records for lot 77');
    await api().post(`/api/v1/supplier-quality/scar-actions/${a2}/cancel`).set(await staff(ids.inspectorA)).send({ reason: 'not mine to cancel' }).expect(403);
    await api().post(`/api/v1/supplier-quality/scar-actions/${ids.orgB}/cancel`).set(await staff()).send({ reason: 'unknown action' }).expect(404);
  });
});

describe('what the supplier sees and does', () => {
  it('sees nothing until the SCAR is issued, then the actions in named fields', async () => {
    await api().get(`/api/v1/portal/scars/${scarId}`).set(await external(sam)).expect(404);
    await api().post(`/api/v1/supplier-quality/scars/${scarId}/issue`).set(await staff()).expect(200);
    const res = await api().get(`/api/v1/portal/scars/${scarId}`).set(await external(sam)).expect(200);
    expect(res.body.scar.actions).toHaveLength(2);
    expect(Object.keys(res.body.scar.actions[0]).sort()).toEqual(['canComplete', 'completedAt', 'completedBy', 'description', 'dueOn', 'id', 'overdue', 'resultNote', 'status']);
    const home = await api().get('/api/v1/portal/home').set(await external(sam)).expect(200);
    expect(home.body.scarsWithActions.map((s: { id: string }) => s.id)).toEqual([scarId]);
    expect(home.body.scarsWithActions[0]).toMatchObject({ openActions: 2, lateActions: 0 });
    const list = await api().get('/api/v1/portal/scars').set(await external(sam)).expect(200);
    expect(list.body.data[0].openActions).toBe(2);
    const other = await api().get('/api/v1/portal/home').set(await external(ben)).expect(200);
    expect(other.body.scarsWithActions).toEqual([]);
  });

  it('completes an action with a note, once; another supplier and a member cannot', async () => {
    await api().post(`/api/v1/portal/scar-actions/${a1}/complete`).set(await external(ben)).send({ note: 'done by the wrong supplier' }).expect(404);
    await api().post(`/api/v1/portal/scar-actions/${a1}/complete`).set(await external(ids.inspectorA)).send({ note: 'a member is not the supplier' }).expect(404);
    await api().post(`/api/v1/portal/scar-actions/${a1}/complete`).set(await external(sam)).send({ note: 'ok' }).expect(400);
    const done = await api().post(`/api/v1/portal/scar-actions/${a1}/complete`).set(await external(sam)).send({ note: 'Sorted 480 pieces, 31 scrapped' }).expect(201);
    const mine = done.body.scar.actions.find((x: { id: string }) => x.id === a1);
    expect(mine).toMatchObject({ status: 'done', resultNote: 'Sorted 480 pieces, 31 scrapped', canComplete: false });
    const again = await api().post(`/api/v1/portal/scar-actions/${a1}/complete`).set(await external(sam)).send({ note: 'once more please' }).expect(409);
    expect(again.body.error.code).toBe('portal_rule');
    const home = await api().get('/api/v1/portal/home').set(await external(sam)).expect(200);
    expect(home.body.scarsWithActions[0].openActions).toBe(1);
  });

  it('staff see the result, are told, and can reopen it; a cancelled action disappears for the supplier', async () => {
    const detail = await api().get(`/api/v1/supplier-quality/scars/${scarId}`).set(await staff()).expect(200);
    const finished = detail.body.actions.find((x: { id: string }) => x.id === a1);
    expect(finished).toMatchObject({ status: 'done', resultNote: 'Sorted 480 pieces, 31 scrapped', doneByName: expect.any(String) });
    const told = await admin.query(`select message from public.portal_activity where record_id = $1 and kind = 'scar_action_done'`, [scarId]);
    expect(told.rows).toHaveLength(1);
    await api().post(`/api/v1/supplier-quality/scar-actions/${a1}/reopen`).set(await staff()).send({ reason: 'The count does not match the delivery note' }).expect(200);
    const cancelled = await api().post(`/api/v1/supplier-quality/scar-actions/${a2}/cancel`).set(await staff()).send({ reason: 'We already hold them' }).expect(200);
    expect(cancelled.body.actions.find((x: { id: string }) => x.id === a2)).toMatchObject({ status: 'cancelled', cancelReason: 'We already hold them' });
    const res = await api().get(`/api/v1/portal/scars/${scarId}`).set(await external(sam)).expect(200);
    expect(res.body.scar.actions).toHaveLength(1);
    expect(res.body.scar.actions[0]).toMatchObject({ id: a1, status: 'open', canComplete: true });
  });
});
