/**
 * Sharing records with a supplier or customer (docs/external-portal-plan.md PT2) through the API: who may share, the curated view the party gets,
 * the conversation (names, ten-minute withdrawal), "seen", withdrawing, and isolation between parties and organisations. The rules themselves are in
 * supabase/tests/portal_sharing.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { categoryId, makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('9c72');
const u = (tail: string) => `${'9c72'.padEnd(8, '0')}-0000-0000-0000-${tail.padStart(12, '0')}`;
const sam = u('e1');
const ben = u('e3');
let app: INestApplication;
let admin: Pool;
let partyA: string;
let partyB: string;
let ncId: string;
let shareId: string;
const api = () => request(app.getHttpServer());
const staff = async (user = ids.ownerA, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const external = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user, { aal: 'aal2' })}`, 'X-Organisation-Id': org });
const bare = async (user: string) => ({ Authorization: `Bearer ${await token(user, { aal: 'aal2' })}` });

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-pt2');
  for (const [id, email] of [[sam, 'sam@acme-pt2.test'], [ben, 'ben@bolt-pt2.test']]) {
    await admin.query(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now()) on conflict do nothing`, [id, email]);
  }
  await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'ACME', 'Acme Castings'), ($1, 'BOLT', 'Bolt Ltd') on conflict do nothing`, [ids.orgA]);
  const acme = (await admin.query(`select id from public.suppliers where organisation_id = $1 and code = 'ACME'`, [ids.orgA])).rows[0].id;
  const nc = await admin.query(
    `insert into public.nonconformances (organisation_id, reference, source, stage, category_id, title, description, severity, quantity_affected, site_id, supplier_id)
     values ($1, 'PT2-E2E-1', 'supplier', 'open', $2, 'Cracked bar stock', 'Cracks on lot 77', 'major', 10, $3, $4) returning id`,
    [ids.orgA, await categoryId(admin, ids.orgA), ids.siteA, acme],
  );
  ncId = nc.rows[0].id;
  await admin.query(`insert into public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount) values ($1, $2, 'scrap', 'GBP', 12345)`, [ids.orgA, ncId]);
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  // The portal, the two parties and their admins (two-factor off for this suite: the guard's own rules are covered in external-portal.e2e-spec.ts).
  await api().put('/api/v1/external-access/settings').set(await staff()).send({ enabled: true, requireMfa: false }).expect(200);
  const supA = acme;
  const supB = (await admin.query(`select id from public.suppliers where organisation_id = $1 and code = 'BOLT'`, [ids.orgA])).rows[0].id;
  const a = await api().put('/api/v1/external-access/parties').set(await staff()).send({ kind: 'supplier', partyId: supA, enabled: true, contactName: 'Pat in Quality' }).expect(200);
  const b = await api().put('/api/v1/external-access/parties').set(await staff()).send({ kind: 'supplier', partyId: supB, enabled: true }).expect(200);
  partyA = a.body.parties.find((p: { name: string }) => p.name === 'Acme Castings').partyId;
  partyB = b.body.parties.find((p: { name: string }) => p.name === 'Bolt Ltd').partyId;
  for (const [party, email, user] of [[partyA, 'sam@acme-pt2.test', sam], [partyB, 'ben@bolt-pt2.test', ben]] as const) {
    await api().post('/api/v1/external-access/people').set(await staff()).send({ partyId: party, email, role: 'admin' }).expect(201);
    const inv = (await api().get('/api/v1/portal/invitations').set(await bare(user))).body.data[0];
    await api().post(`/api/v1/portal/invitations/${inv.id}/accept`).set(await bare(user)).expect(201);
  }
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('sharing a non-conformance', () => {
  it('only people with the share permission see the card or share', async () => {
    await api().get(`/api/v1/external-access/shares?kind=ncr&recordId=${ncId}`).set(await staff(ids.inspectorA)).expect(403);
    await api().post('/api/v1/external-access/shares').set(await staff(ids.inspectorA)).send({ kind: 'ncr', recordId: ncId, partyId: partyA }).expect(403);
    const card = await api().get(`/api/v1/external-access/shares?kind=ncr&recordId=${ncId}`).set(await staff()).expect(200);
    expect(card.body.data).toEqual([]);
    expect(card.body.eligible.map((p: { partyName: string }) => p.partyName)).toEqual(['Acme Castings']);
  });

  it('shares only with the supplier the NC names', async () => {
    const wrong = await api().post('/api/v1/external-access/shares').set(await staff()).send({ kind: 'ncr', recordId: ncId, partyId: partyB }).expect(409);
    expect(wrong.body.error).toMatchObject({ code: 'portal_rule', message: expect.stringMatching(/only with a supplier or customer it names/) });
    const res = await api().post('/api/v1/external-access/shares').set(await staff()).send({ kind: 'ncr', recordId: ncId, partyId: partyA }).expect(201);
    expect(res.body.data).toMatchObject([{ partyName: 'Acme Castings', viewers: 0, comments: 0, withdrawnAt: null }]);
    expect(res.body.eligible).toEqual([]);
    expect(res.body.email).toEqual({ attempted: 0, sent: 0 }); // no mail provider in tests
    shareId = res.body.data[0].id;
    await api().post('/api/v1/external-access/shares').set(await staff()).send({ kind: 'ncr', recordId: ncId, partyId: partyA }).expect(409);
  });

  it('another organisation cannot see or share our record', async () => {
    const other = await staff(ids.ownerB, ids.orgB);
    await api().get(`/api/v1/external-access/shares?kind=ncr&recordId=${ncId}`).set(other).expect(404);
    await api().post('/api/v1/external-access/shares').set(other).send({ kind: 'ncr', recordId: ncId, partyId: partyA }).expect(404);
    await api().get(`/api/v1/external-access/shares/${shareId}/comments`).set(other).expect(404);
  });
});

describe('what the party sees', () => {
  it('lists it as new, and opening it shows the agreed fields and nothing internal', async () => {
    const home = await api().get('/api/v1/portal/home').set(await external(sam)).expect(200);
    expect(home.body.attention).toMatchObject([{ id: shareId, reference: 'PT2-E2E-1', viewed: false }]);
    const list = await api().get('/api/v1/portal/shares').set(await external(sam)).expect(200);
    expect(list.body.data).toMatchObject([{ id: shareId, kind: 'ncr', title: 'Cracked bar stock', newComments: 0, viewed: false }]);

    const res = await api().get(`/api/v1/portal/shares/${shareId}`).set(await external(sam)).expect(200);
    expect(res.body.kind).toBe('ncr');
    expect(res.body.record).toMatchObject({ reference: 'PT2-E2E-1', title: 'Cracked bar stock', severity: 'major', quantityAffected: 10, contact: 'Pat in Quality' });
    expect(JSON.stringify(res.body)).not.toMatch(/12345|costs?"/i);
    expect(Object.keys(res.body.record).sort()).toEqual(
      ['actualResult', 'containment', 'contact', 'customerReference', 'description', 'detectedAt', 'disposition', 'lotNumber', 'partName', 'partNumber', 'partRevision', 'purchaseOrder',
       'quantityAffected', 'quantityInspected', 'reference', 'requirement', 'serialNumber', 'severity', 'sharedAt', 'stage', 'title'].sort(),
    );
    const after = await api().get('/api/v1/portal/home').set(await external(sam)).expect(200);
    expect(after.body.attention).toEqual([]);
    const card = await api().get(`/api/v1/external-access/shares?kind=ncr&recordId=${ncId}`).set(await staff()).expect(200);
    expect(card.body.data[0]).toMatchObject({ viewers: 1, firstViewedAt: expect.any(String) });
  });

  it('another party and staff routes reach nothing', async () => {
    await api().get(`/api/v1/portal/shares/${shareId}`).set(await external(ben)).expect(404);
    await api().post(`/api/v1/portal/shares/${shareId}/comments`).set(await external(ben)).send({ body: 'hello' }).expect(404);
    const list = await api().get('/api/v1/portal/shares').set(await external(ben)).expect(200);
    expect(list.body.data).toEqual([]);
    await api().get(`/api/v1/ncrs/${ncId}`).set(await external(sam)).expect(404);
    await api().get(`/api/v1/external-access/shares?kind=ncr&recordId=${ncId}`).set(await external(sam)).expect(404);
  });
});

describe('the conversation', () => {
  let staffComment: string;
  let partyComment: string;

  it('staff write as the organisation, the party sees what is new, and replies', async () => {
    const staffed = await api().post(`/api/v1/external-access/shares/${shareId}/comments`).set(await staff()).send({ body: 'Please confirm lot 77 is quarantined' }).expect(201);
    expect(staffed.body.data).toMatchObject([{ side: 'staff', author: 'Ada Owner', mine: true, canWithdraw: true }]);
    staffComment = staffed.body.data[0].id;
    const list = await api().get('/api/v1/portal/shares').set(await external(sam)).expect(200);
    expect(list.body.data[0]).toMatchObject({ comments: 1, newComments: 1 });
    const seen = await api().get(`/api/v1/portal/shares/${shareId}`).set(await external(sam)).expect(200);
    expect(seen.body.comments).toMatchObject([{ side: 'staff', author: 'Alpha Precision', body: 'Please confirm lot 77 is quarantined', mine: false }]);
    expect(JSON.stringify(seen.body.comments)).not.toMatch(/Ada/);
    const replied = await api().post(`/api/v1/portal/shares/${shareId}/comments`).set(await external(sam)).send({ body: 'Held in our cage' }).expect(201);
    expect(replied.body.data).toHaveLength(2);
    partyComment = replied.body.data[1].id;
    expect(replied.body.data[1]).toMatchObject({ side: 'external', author: 'sam', mine: true, canWithdraw: true });
    await api().post(`/api/v1/portal/shares/${shareId}/comments`).set(await external(sam)).send({ body: '   ' }).expect(400);
  });

  it('staff see the person and the company; withdrawing is for your own comment, within ten minutes', async () => {
    const thread = await api().get(`/api/v1/external-access/shares/${shareId}/comments`).set(await staff()).expect(200);
    expect(thread.body.data[1].author).toBe('sam (Acme Castings)');
    const refused = await api().post(`/api/v1/portal/comments/${staffComment}/withdraw`).set(await external(sam)).expect(409);
    expect(refused.body.error.code).toBe('portal_rule');
    await api().post(`/api/v1/external-access/comments/${partyComment}/withdraw`).set(await staff()).expect(409);
    await api().post(`/api/v1/portal/comments/${partyComment}/withdraw`).set(await external(sam)).expect(201);
    const after = await api().get(`/api/v1/portal/shares/${shareId}`).set(await external(sam)).expect(200);
    expect(after.body.comments[1]).toMatchObject({ withdrawn: true, body: null });
    await admin.query(`update public.portal_comments set created_at = now() - interval '11 minutes' where id = $1`, [staffComment]);
    const late = await api().post(`/api/v1/external-access/comments/${staffComment}/withdraw`).set(await staff()).expect(409);
    expect(late.body.error.message).toMatch(/within ten minutes/);
  });
});

describe('withdrawing the share', () => {
  it('ends it at once for the party; staff keep the conversation', async () => {
    await api().post(`/api/v1/external-access/shares/${shareId}/withdraw`).set(await staff()).send({ reason: 'x' }).expect(400);
    const res = await api().post(`/api/v1/external-access/shares/${shareId}/withdraw`).set(await staff()).send({ reason: 'Shared by mistake' }).expect(201);
    expect(res.body.data[0]).toMatchObject({ withdrawnReason: 'Shared by mistake' });
    await api().get(`/api/v1/portal/shares/${shareId}`).set(await external(sam)).expect(404);
    const list = await api().get('/api/v1/portal/shares').set(await external(sam)).expect(200);
    expect(list.body.data).toEqual([]);
    await api().post(`/api/v1/portal/shares/${shareId}/comments`).set(await external(sam)).send({ body: 'still there?' }).expect(404);
    const thread = await api().get(`/api/v1/external-access/shares/${shareId}/comments`).set(await staff()).expect(200);
    expect(thread.body.data.length).toBe(2);
    const again = await api().post('/api/v1/external-access/shares').set(await staff()).send({ kind: 'ncr', recordId: ncId, partyId: partyA }).expect(201);
    expect(again.body.data.filter((s: { withdrawnAt: string | null }) => !s.withdrawnAt)).toHaveLength(1);
  });

  it('switching the party off hides everything shared', async () => {
    const supA = (await admin.query(`select id from public.suppliers where organisation_id = $1 and code = 'ACME'`, [ids.orgA])).rows[0].id;
    await api().put('/api/v1/external-access/parties').set(await staff()).send({ kind: 'supplier', partyId: supA, enabled: false }).expect(200);
    await api().get('/api/v1/portal/shares').set(await external(sam)).expect(404);
    await api().put('/api/v1/external-access/parties').set(await staff()).send({ kind: 'supplier', partyId: supA, enabled: true }).expect(200);
    const list = await api().get('/api/v1/portal/shares').set(await external(sam)).expect(200);
    expect(list.body.data).toHaveLength(1);
  });
});
