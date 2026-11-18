/**
 * Sharing a document in force or a quality alert in force with a supplier or customer, and their acknowledgement (docs/external-portal-plan.md PT3c)
 * through the API: staff share and see who acknowledged, the party reads the curated view, opens files on short links, acknowledges once per person and
 * revision, and nobody else reaches any of it. The rules themselves are in supabase/tests/portal_acknowledgements.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { configureApp } from '../src/app.factory';
import { AppModule } from '../src/app.module';
import { FileLinkSigner } from '../src/files/file-links';
import { makeIds, requireDb, seed, testEnv, token } from './helpers';

class FakeSigner extends FileLinkSigner {
  enabled = true;
  calls: string[] = [];
  async signDownload(bucket: string, path: string, expiresIn: number) {
    this.calls.push(`download ${bucket} ${path}`);
    return `https://storage.test/${bucket}/${path}?e=${expiresIn}`;
  }
  async signUpload(bucket: string, path: string) {
    return { token: 't', signedUrl: `https://storage.test/upload/${bucket}/${path}` };
  }
  async remove() {}
}

const ids = makeIds('9c73');
const u = (tail: string) => `${'9c73'.padEnd(8, '0')}-0000-0000-0000-${tail.padStart(12, '0')}`;
const sam = u('e1');
const sue = u('e2');
const ben = u('e3');
const signer = new FakeSigner();
let app: INestApplication;
let admin: Pool;
let partyA: string;
let partyB: string;
let docId: string;
let revId: string;
let fileId: string;
let alertId: string;
let docShare: string;
let alertShare: string;
const api = () => request(app.getHttpServer());
const staff = async (user = ids.ownerA, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const external = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user, { aal: 'aal2' })}`, 'X-Organisation-Id': org });
const bare = async (user: string) => ({ Authorization: `Bearer ${await token(user, { aal: 'aal2' })}` });

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-pt3c');
  for (const [id, email] of [[sam, 'sam@acme-pt3c.test'], [sue, 'sue@acme-pt3c.test'], [ben, 'ben@bolt-pt3c.test']]) {
    await admin.query(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now()) on conflict do nothing`, [id, email]);
  }
  await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'ACME', 'Acme Castings'), ($1, 'BOLT', 'Bolt Ltd') on conflict do nothing`, [ids.orgA]);
  // A document in force and an alert in force, written straight in (their own workflows are tested elsewhere).
  const c = await admin.connect();
  try {
    await c.query(`set session_replication_role = replica`);
    const type = (await c.query(`select id from public.document_types where organisation_id = $1 and prefix = 'EXT'`, [ids.orgA])).rows[0].id;
    docId = (await c.query(
      `insert into public.documents (organisation_id, number, title, type_id, content_kind, owner_user_id, status, origin, issuer)
       values ($1, 'EXT-901', 'Packing specification', $2, 'file', $3, 'active', 'external', 'Alpha') returning id`,
      [ids.orgA, type, ids.ownerA],
    )).rows[0].id;
    revId = (await c.query(
      `insert into public.document_revisions (organisation_id, document_id, sequence, author_id, letter, status, approved_at, effective_from, change_summary)
       values ($1, $2, 1, $3, 'A', 'effective', now(), current_date - 1, 'Issue 1') returning id`,
      [ids.orgA, docId, ids.ownerA],
    )).rows[0].id;
    await c.query(`update public.documents set current_revision_id = $2 where id = $1`, [docId, revId]);
    fileId = (await c.query(
      `insert into public.document_revision_files (organisation_id, revision_id, role, storage_path, file_name, content_type, size_bytes)
       values ($1, $2, 'main', $3, 'ps.pdf', 'application/pdf', 1000) returning id`,
      [ids.orgA, revId, `${ids.orgA}/document/${revId}/uuid-ps.pdf`],
    )).rows[0].id;
    alertId = (await c.query(
      `insert into public.quality_alerts (organisation_id, alert_number, reference, revision, title, category, severity, status, description, required_action, effective_date, issued_at)
       values ($1, 901, 'QA-901', 1, 'Cracks in bar stock', 'supplier', 'high', 'active', 'Cracks found in lot 77', 'a', current_date, now()) returning id`,
      [ids.orgA],
    )).rows[0].id;
    await c.query(`insert into public.quality_alert_actions (organisation_id, alert_id, position, description) values ($1, $2, 1, 'Sort your stock')`, [ids.orgA, alertId]);
  } finally {
    await c.query(`reset session_replication_role`);
    c.release();
  }
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(testEnv({ RATE_LIMIT_PER_MINUTE: '10000' }))] }).overrideProvider(FileLinkSigner).useValue(signer).compile();
  const nest = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, rawBody: true });
  app = configureApp(nest, testEnv({ RATE_LIMIT_PER_MINUTE: '10000' }));
  await app.init();
  await api().put('/api/v1/external-access/settings').set(await staff()).send({ enabled: true, requireMfa: false }).expect(200);
  const acme = (await admin.query(`select id from public.suppliers where organisation_id = $1 and code = 'ACME'`, [ids.orgA])).rows[0].id;
  const bolt = (await admin.query(`select id from public.suppliers where organisation_id = $1 and code = 'BOLT'`, [ids.orgA])).rows[0].id;
  const a = await api().put('/api/v1/external-access/parties').set(await staff()).send({ kind: 'supplier', partyId: acme, enabled: true }).expect(200);
  const b = await api().put('/api/v1/external-access/parties').set(await staff()).send({ kind: 'supplier', partyId: bolt, enabled: true }).expect(200);
  partyA = a.body.parties.find((p: { name: string }) => p.name === 'Acme Castings').partyId;
  partyB = b.body.parties.find((p: { name: string }) => p.name === 'Bolt Ltd').partyId;
  for (const [party, email, user, role] of [[partyA, 'sam@acme-pt3c.test', sam, 'admin'], [partyA, 'sue@acme-pt3c.test', sue, 'member'], [partyB, 'ben@bolt-pt3c.test', ben, 'admin']] as const) {
    await api().post('/api/v1/external-access/people').set(await staff()).send({ partyId: party, email, role }).expect(201);
    const inv = (await api().get('/api/v1/portal/invitations').set(await bare(user))).body.data[0];
    await api().post(`/api/v1/portal/invitations/${inv.id}/accept`).set(await bare(user)).expect(201);
  }
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('sharing', () => {
  it('only people with the share permission share a document or an alert, with any party that has the portal on', async () => {
    await api().post('/api/v1/external-access/shares').set(await staff(ids.inspectorA)).send({ kind: 'document', recordId: docId, partyId: partyA }).expect(403);
    const card = await api().get(`/api/v1/external-access/shares?kind=document&recordId=${docId}`).set(await staff()).expect(200);
    expect(card.body.eligible.map((p: { partyName: string }) => p.partyName).sort()).toEqual(['Acme Castings', 'Bolt Ltd']);
    const d = await api().post('/api/v1/external-access/shares').set(await staff()).send({ kind: 'document', recordId: docId, partyId: partyA }).expect(201);
    docShare = d.body.data[0].id;
    expect(d.body.data[0].acknowledgement).toEqual({ acknowledged: 0, people: 2, subject: 'EXT-901 rev A' });
    const a = await api().post('/api/v1/external-access/shares').set(await staff()).send({ kind: 'quality_alert', recordId: alertId, partyId: partyA }).expect(201);
    alertShare = a.body.data[0].id;
    await api().post('/api/v1/external-access/shares').set(await staff()).send({ kind: 'document', recordId: docId, partyId: partyA }).expect(409);
  });

  it('another organisation’s records are not found', async () => {
    await api().get(`/api/v1/external-access/shares?kind=document&recordId=${docId}`).set(await staff(ids.ownerB, ids.orgB)).expect(404);
    await api().get(`/api/v1/external-access/shares/${docShare}/acknowledgements`).set(await staff(ids.ownerB, ids.orgB)).expect(404);
  });
});

describe('what the party sees and does', () => {
  it('lists both, waiting for acknowledgement, and shows only the named fields', async () => {
    const home = await api().get('/api/v1/portal/home').set(await external(sam)).expect(200);
    expect(home.body.toAcknowledge).toBe(2);
    expect(home.body.attention.every((i: { needsAcknowledgement: boolean }) => i.needsAcknowledgement)).toBe(true);
    const doc = await api().get(`/api/v1/portal/shares/${docShare}`).set(await external(sam)).expect(200);
    expect(doc.body.kind).toBe('document');
    expect(Object.keys(doc.body.record).sort()).toEqual(['acknowledgedAt', 'body', 'canAcknowledge', 'changeSummary', 'contact', 'contentKind', 'description', 'effectiveFrom', 'files', 'number', 'revision', 'sharedAt', 'title', 'type']);
    const alert = await api().get(`/api/v1/portal/shares/${alertShare}`).set(await external(sam)).expect(200);
    expect(Object.keys(alert.body.record).sort()).toEqual(['acknowledgeBy', 'acknowledgedAt', 'actions', 'canAcknowledge', 'category', 'contact', 'description', 'effectiveDate', 'expiryDate', 'reference', 'revision', 'severity', 'sharedAt', 'status', 'title']);
    await api().get(`/api/v1/portal/shares/${docShare}`).set(await external(ben)).expect(404);
  });

  it('opens a file of the revision in force on a ten-minute link, and nobody else’s', async () => {
    const res = await api().post(`/api/v1/portal/shares/${docShare}/file-url`).set(await external(sam)).send({ fileId }).expect(200);
    expect(res.body).toMatchObject({ expiresIn: 600, url: expect.stringContaining('document-files') });
    expect(signer.calls.some((c) => c.includes(`document-files ${ids.orgA}/document/${revId}/`))).toBe(true);
    await api().post(`/api/v1/portal/shares/${docShare}/file-url`).set(await external(ben)).send({ fileId }).expect(404);
    await api().post(`/api/v1/portal/shares/${alertShare}/file-url`).set(await external(sam)).send({ fileId }).expect(404);
    await api().post(`/api/v1/portal/shares/${docShare}/file-url`).set(await external(sam)).send({ fileId: ids.orgB }).expect(404);
  });

  it('acknowledges once per person, and staff see who and how many', async () => {
    await api().post(`/api/v1/portal/shares/${docShare}/acknowledge`).set(await external(sam)).send({ note: 'Read and understood' }).expect(201);
    await api().post(`/api/v1/portal/shares/${docShare}/acknowledge`).set(await external(sam)).send({}).expect(409);
    await api().post(`/api/v1/portal/shares/${docShare}/acknowledge`).set(await external(ben)).send({}).expect(404);
    const home = await api().get('/api/v1/portal/home').set(await external(sam)).expect(200);
    expect(home.body.toAcknowledge).toBe(1);
    const sue2 = await api().get('/api/v1/portal/home').set(await external(sue)).expect(200);
    expect(sue2.body.toAcknowledge).toBe(2);
    const card = await api().get(`/api/v1/external-access/shares?kind=document&recordId=${docId}`).set(await staff()).expect(200);
    expect(card.body.data[0].acknowledgement).toEqual({ acknowledged: 1, people: 2, subject: 'EXT-901 rev A' });
    const who = await api().get(`/api/v1/external-access/shares/${docShare}/acknowledgements`).set(await staff()).expect(200);
    expect(who.body.data).toMatchObject([{ note: 'Read and understood', current: true, subject: expect.stringContaining('EXT-901 rev A') }]);
    await api().get(`/api/v1/external-access/shares/${docShare}/acknowledgements`).set(await staff(ids.inspectorA)).expect(403);
    const doc = await api().get(`/api/v1/portal/shares/${docShare}`).set(await external(sam)).expect(200);
    expect(doc.body.record.acknowledgedAt).toBeTruthy();
    expect(doc.body.record.canAcknowledge).toBe(false);
  });

  it('a quality alert that is no longer in force cannot be acknowledged', async () => {
    await admin.query(`update public.quality_alerts set status = 'expired' where id = $1`, [alertId]);
    const res = await api().post(`/api/v1/portal/shares/${alertShare}/acknowledge`).set(await external(sue)).send({}).expect(409);
    expect(res.body.error.code).toBe('portal_rule');
    await admin.query(`update public.quality_alerts set status = 'active' where id = $1`, [alertId]);
  });
});
