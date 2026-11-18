/**
 * A supplier answering a SCAR in the portal (docs/external-portal-plan.md PT3a) through the API: what they see, what they may do, that the internal
 * review and extension decision work unchanged on what they sent, that staff are told, and isolation between suppliers and organisations. The rules
 * themselves are in supabase/tests/portal_scars.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { categoryId, makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('9c73');
const u = (tail: string) => `${'9c73'.padEnd(8, '0')}-0000-0000-0000-${tail.padStart(12, '0')}`;
const sam = u('e1');
const ben = u('e3');
let app: INestApplication;
let admin: Pool;
let scarId: string;
let draftId: string;
const api = () => request(app.getHttpServer());
const staff = async (user = ids.ownerA, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const external = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user, { aal: 'aal2' })}`, 'X-Organisation-Id': org });
const bare = async (user: string) => ({ Authorization: `Bearer ${await token(user, { aal: 'aal2' })}` });
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-pt3');
  for (const [id, email] of [[sam, 'sam@acme-pt3.test'], [ben, 'ben@bolt-pt3.test']]) {
    await admin.query(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now()) on conflict do nothing`, [id, email]);
  }
  await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'ACME', 'Acme Castings'), ($1, 'BOLT', 'Bolt Ltd') on conflict do nothing`, [ids.orgA]);
  const acme = (await admin.query(`select id from public.suppliers where organisation_id = $1 and code = 'ACME'`, [ids.orgA])).rows[0].id;
  const bolt = (await admin.query(`select id from public.suppliers where organisation_id = $1 and code = 'BOLT'`, [ids.orgA])).rows[0].id;
  const nc = await admin.query(
    `insert into public.nonconformances (organisation_id, reference, source, stage, category_id, title, severity, quantity_affected, site_id, supplier_id)
     values ($1, 'PT3-E2E-1', 'supplier', 'open', $2, 'Cracked bar stock', 'major', 10, $3, $4) returning id`,
    [ids.orgA, await categoryId(admin, ids.orgA), ids.siteA, acme],
  );
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  await api().put('/api/v1/external-access/settings').set(await staff()).send({ enabled: true, requireMfa: false }).expect(200);
  const a = await api().put('/api/v1/external-access/parties').set(await staff()).send({ kind: 'supplier', partyId: acme, enabled: true, contactName: 'Pat in Quality' }).expect(200);
  const b = await api().put('/api/v1/external-access/parties').set(await staff()).send({ kind: 'supplier', partyId: bolt, enabled: true }).expect(200);
  const partyA = a.body.parties.find((p: { name: string }) => p.name === 'Acme Castings').partyId;
  const partyB = b.body.parties.find((p: { name: string }) => p.name === 'Bolt Ltd').partyId;
  for (const [party, email, user] of [[partyA, 'sam@acme-pt3.test', sam], [partyB, 'ben@bolt-pt3.test', ben]] as const) {
    await api().post('/api/v1/external-access/people').set(await staff()).send({ partyId: party, email, role: 'admin' }).expect(201);
    const inv = (await api().get('/api/v1/portal/invitations').set(await bare(user))).body.data[0];
    await api().post(`/api/v1/portal/invitations/${inv.id}/accept`).set(await bare(user)).expect(201);
  }
  const create = async (title: string) =>
    (await api().post('/api/v1/supplier-quality/scars').set(await staff()).send({ supplierId: acme, title, severity: 'major', responseDueOn: inDays(10), ncrIds: [nc.rows[0].id] }).expect(201)).body.id as string;
  draftId = await create('Draft only');
  scarId = await create('Cracked castings');
  await api().post(`/api/v1/supplier-quality/scars/${scarId}/issue`).set(await staff()).expect(200);
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('what the supplier sees', () => {
  it('lists the issued SCAR and never the draft', async () => {
    const res = await api().get('/api/v1/portal/scars').set(await external(sam)).expect(200);
    expect(res.body.data.map((s: { id: string }) => s.id)).toEqual([scarId]);
    expect(res.body.data[0]).toMatchObject({ reference: expect.stringMatching(/^SCAR-/), status: 'issued', awaitingResponse: true, overdue: false });
    await api().get(`/api/v1/portal/scars/${draftId}`).set(await external(sam)).expect(404);
  });

  it('shows the SCAR as named fields only', async () => {
    const res = await api().get(`/api/v1/portal/scars/${scarId}`).set(await external(sam)).expect(200);
    expect(Object.keys(res.body.scar).sort()).toEqual(
      ['canAcknowledge', 'canRequestExtension', 'canRespond', 'cancelReason', 'contact', 'containmentRequirements', 'draftFiles', 'extensions', 'issuedAt', 'items', 'objectiveEvidence', 'originalResponseDueOn', 'overdue',
       'problemDescription', 'reference', 'requirementBreached', 'responseDueOn', 'responses', 'severity', 'status', 'title'].sort(),
    );
    expect(res.body.scar.contact).toBe('Pat in Quality');
    expect(JSON.stringify(res.body)).not.toMatch(/owner|capa|ncr|PT3-E2E-1/i);
  });

  it('is home for what needs doing', async () => {
    const res = await api().get('/api/v1/portal/home').set(await external(sam)).expect(200);
    expect(res.body.scarsAwaiting.map((s: { id: string }) => s.id)).toEqual([scarId]);
  });

  it('shows nothing to another supplier, another organisation or a member', async () => {
    expect((await api().get('/api/v1/portal/scars').set(await external(ben)).expect(200)).body.data).toEqual([]);
    await api().get(`/api/v1/portal/scars/${scarId}`).set(await external(ben)).expect(404);
    await api().post(`/api/v1/portal/scars/${scarId}/respond`).set(await external(ben)).send({ rootCause: 'not mine', correctiveAction: 'not mine' }).expect(404);
    await api().get('/api/v1/portal/scars').set(await external(sam, ids.orgB)).expect(404);
    await api().get('/api/v1/portal/scars').set(await external(ids.inspectorA)).expect(404);
  });
});

describe('what the supplier does', () => {
  it('acknowledges, once', async () => {
    const res = await api().post(`/api/v1/portal/scars/${scarId}/acknowledge`).set(await external(sam)).send({ note: 'Got it' }).expect(201);
    expect(res.body.scar.status).toBe('acknowledged');
    expect(res.body.scar.canAcknowledge).toBe(false);
    await api().post(`/api/v1/portal/scars/${scarId}/acknowledge`).set(await external(sam)).send({}).expect(409);
  });

  it('answers with a root cause and a corrective action', async () => {
    await api().post(`/api/v1/portal/scars/${scarId}/respond`).set(await external(sam)).send({ rootCause: 'ab', correctiveAction: 'Fix it properly' }).expect(400);
    await api().post(`/api/v1/portal/scars/${scarId}/respond`).set(await external(sam)).send({ rootCause: 'Mould too cold', correctiveAction: 'Raise the temperature', extra: 1 }).expect(400);
    const res = await api()
      .post(`/api/v1/portal/scars/${scarId}/respond`)
      .set(await external(sam))
      .send({ rootCause: 'Mould too cold', correctiveAction: 'Raise the temperature and check each shift', containment: 'Stock sorted', rootCauseMethod: 'five_whys', plannedCompletionOn: inDays(5) })
      .expect(201);
    expect(res.body.scar.status).toBe('response_received');
    expect(res.body.scar.responses).toHaveLength(1);
    expect(res.body.scar.responses[0].respondedBy).toMatch(/\(Acme Castings\)$/);
    expect(res.body.scar.canRespond).toBe(false);
    await api().post(`/api/v1/portal/scars/${scarId}/respond`).set(await external(sam)).send({ rootCause: 'Again', correctiveAction: 'Again please' }).expect(409);
  });

  it('is reviewed by staff on the unchanged SCAR page, and asked again', async () => {
    const detail = (await api().get(`/api/v1/supplier-quality/scars/${scarId}`).set(await staff()).expect(200)).body;
    expect(detail.responses[0].rootCause).toBe('Mould too cold');
    expect(detail.responses[0].respondedByName).toMatch(/Acme Castings/);
    await api().post(`/api/v1/supplier-quality/scars/${scarId}/start-review`).set(await staff()).expect(200);
    await api().post(`/api/v1/supplier-quality/scars/${scarId}/review`).set(await staff()).send({ decision: 'revision_requested', note: 'Show the evidence of the check' }).expect(200);
    const seen = (await api().get(`/api/v1/portal/scars/${scarId}`).set(await external(sam)).expect(200)).body.scar;
    expect(seen.responses[0].review).toMatchObject({ decision: 'revision_requested', note: 'Show the evidence of the check' });
    expect(seen.canRespond).toBe(true);
  });

  it('asks for more time, takes it back, asks again and is told the decision', async () => {
    await api().post(`/api/v1/portal/scars/${scarId}/extensions`).set(await external(sam)).send({ newDueOn: inDays(1), reason: 'Need longer' }).expect(409);
    const first = await api().post(`/api/v1/portal/scars/${scarId}/extensions`).set(await external(sam)).send({ newDueOn: inDays(20), reason: 'Parts are on a slow boat' }).expect(201);
    const ext = first.body.scar.extensions.find((x: { status: string }) => x.status === 'pending');
    expect(ext).toMatchObject({ mine: true });
    expect(first.body.scar.canRequestExtension).toBe(false);
    await api().post(`/api/v1/portal/scar-extensions/${ext.id}/withdraw`).set(await external(ben)).send({ reason: 'not mine to take back' }).expect(404);
    const back = await api().post(`/api/v1/portal/scar-extensions/${ext.id}/withdraw`).set(await external(sam)).send({ reason: 'Found a faster route' }).expect(201);
    expect(back.body.scar.extensions[0].status).toBe('withdrawn');
    const again = await api().post(`/api/v1/portal/scars/${scarId}/extensions`).set(await external(sam)).send({ newDueOn: inDays(21), reason: 'After all, the boat is late' }).expect(201);
    const pending = again.body.scar.extensions.find((x: { status: string }) => x.status === 'pending');
    // Staff decide on the unchanged route: the one who did not ask.
    await api().post(`/api/v1/supplier-quality/scar-extensions/${pending.id}/decide`).set(await staff()).send({ approve: true, note: 'Agreed, once' }).expect(200);
    const after = (await api().get(`/api/v1/portal/scars/${scarId}`).set(await external(sam)).expect(200)).body.scar;
    expect(after.responseDueOn).toBe(inDays(21));
    expect(after.extensions.find((x: { id: string }) => x.id === pending.id)).toMatchObject({ status: 'approved', decisionNote: 'Agreed, once' });
  });
});

describe('staff are told', () => {
  it('writes what the supplier did, for people who may read it', async () => {
    const rows = await admin.query(`select kind, message from public.portal_activity where organisation_id = $1 order by created_at`, [ids.orgA]);
    expect(rows.rows.map((r) => r.kind)).toEqual(['scar_acknowledged', 'scar_response', 'scar_extension_requested', 'scar_extension_withdrawn', 'scar_extension_requested']);
    const notices = await admin.query(`select count(*)::int as n from public.notifications where organisation_id = $1 and entity_type = 'portal_activity'`, [ids.orgA]);
    expect(notices.rows[0].n).toBe(5);
  });
});
