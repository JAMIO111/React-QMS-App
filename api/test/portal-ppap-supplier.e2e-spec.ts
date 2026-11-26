/**
 * A supplier prepares and submits a part approval package in the portal (docs/ppap-plan.md PP5b): staff ask, the supplier sees named fields only, adds files to the elements asked of
 * them, and submits; other suppliers and customers are refused. The rules are in supabase/tests/portal_ppap_supplier.test.sql.
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
    this.calls.push(`download ${bucket} ${path} ${expiresIn}`);
    return `https://storage.test/${bucket}/${path}?e=${expiresIn}`;
  }
  async signUpload(bucket: string, path: string) {
    this.calls.push(`upload ${bucket} ${path}`);
    return { token: 'tok', signedUrl: `https://storage.test/upload/${bucket}/${path}?token=tok` };
  }
  async remove() {}
}
const signer = new FakeSigner();

const ids = makeIds('f5b');
const u = (tail: string) => `${'f5b'.padEnd(8, '0')}-0000-0000-0000-${tail.padStart(12, '0')}`;
const sam = u('e1');
const sue = u('e2');
const cus = u('e3');
const ELI = u('e4');
let app: INestApplication;
let admin: Pool;
const ctx: Record<string, string> = {};
const api = () => request(app.getHttpServer());
const staff = async (user = ids.ownerA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': ids.orgA });
const external = async (user: string) => ({ Authorization: `Bearer ${await token(user, { aal: 'aal2' })}`, 'X-Organisation-Id': ids.orgA });
const bare = async (user: string) => ({ Authorization: `Bearer ${await token(user, { aal: 'aal2' })}` });

async function addMember(user: string, email: string, role: string, first: string, surname: string) {
  await admin.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [user, email]);
  await admin.query(`update public.profiles set first_name = $2, surname = $3 where id = $1`, [user, first, surname]);
  const m = await admin.query(`insert into public.organisation_users (organisation_id, user_id, status, joined_at) values ($1, $2, 'active', now()) returning id`, [ids.orgA, user]);
  await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = $3`, [ids.orgA, m.rows[0].id, role]);
}

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-pp5b');
  for (const [id, email] of [[sam, 'sam@acme-pp5b.test'], [sue, 'sue@other-pp5b.test'], [cus, 'cus@wayne-pp5b.test']]) {
    await admin.query(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now()) on conflict do nothing`, [id, email]);
  }
  const env = testEnv({ RATE_LIMIT_PER_MINUTE: '10000' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).overrideProvider(FileLinkSigner).useValue(signer).compile();
  const nest = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, rawBody: true });
  app = configureApp(nest, env);
  await app.init();
  await addMember(ELI, 'eli@pp5b.test', 'quality_engineer', 'Eli', 'Engineer');
  const h = await staff();
  await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'ACME', 'Acme Castings'), ($1, 'OTHER', 'Other Metals') on conflict do nothing`, [ids.orgA]);
  await admin.query(`insert into public.customers (organisation_id, code, name) values ($1, 'WAYNE', 'Wayne Ltd') on conflict do nothing`, [ids.orgA]);
  const one = async (s: string) => (await admin.query(s, [ids.orgA])).rows[0].id as string;
  const acme = await one(`select id from public.suppliers where organisation_id = $1 and code = 'ACME'`);
  const other = await one(`select id from public.suppliers where organisation_id = $1 and code = 'OTHER'`);
  const wayne = await one(`select id from public.customers where organisation_id = $1 and code = 'WAYNE'`);
  ctx.acme = acme;
  const part = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'P5B-100', name: 'Bracket', initialRevision: { revision: 'A' } }).expect(201)).body;
  ctx.part = part.id;
  await api().post(`/api/v1/part-revisions/${part.revisions[0].id}/release`).set(h).expect(200);
  await api().put('/api/v1/external-access/settings').set(h).send({ enabled: true, requireMfa: false }).expect(200);
  const party = async (kind: 'supplier' | 'customer', partyId: string, name: string) =>
    (await api().put('/api/v1/external-access/parties').set(h).send({ kind, partyId, enabled: true }).expect(200)).body.parties.find((p: { name: string }) => p.name === name).partyId as string;
  const pA = await party('supplier', acme, 'Acme Castings');
  const pO = await party('supplier', other, 'Other Metals');
  const pC = await party('customer', wayne, 'Wayne Ltd');
  for (const [p, email, user] of [[pA, 'sam@acme-pp5b.test', sam], [pO, 'sue@other-pp5b.test', sue], [pC, 'cus@wayne-pp5b.test', cus]] as const) {
    await api().post('/api/v1/external-access/people').set(h).send({ partyId: p, email, role: 'admin' }).expect(201);
    const inv = (await api().get('/api/v1/portal/invitations').set(await bare(user))).body.data[0];
    await api().post(`/api/v1/portal/invitations/${inv.id}/accept`).set(await bare(user)).expect(201);
  }
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('a supplier preparing a part approval package in the portal', () => {
  let requestId: string;
  let packageId: string;

  it('is asked by staff for a received package, one request at a time', async () => {
    const h = await staff(ELI);
    const made = await api().post('/api/v1/ppaps').set(h).send({ partId: ctx.part, direction: 'received', supplierId: ctx.acme, reason: 'new_part', level: 1, ownerId: ELI }).expect(201);
    packageId = made.body.id;
    const asked = await api().post(`/api/v1/ppaps/${packageId}/supplier-requests`).set(h).send({ note: 'Please send the package.' }).expect(201);
    requestId = asked.body.data[0].id;
    expect(asked.body.data[0]).toMatchObject({ status: 'pending', customer: 'Acme Castings', requestNote: 'Please send the package.' });
    expect(asked.body.supplier).toMatchObject({ name: 'Acme Castings' });
    await api().post(`/api/v1/ppaps/${packageId}/supplier-requests`).set(h).send({}).expect(409);
    await api().post(`/api/v1/ppaps/${packageId}/supplier-requests`).set(await external(sam)).send({}).expect(404);
  });

  it('shows the supplier the package in named fields only, and nobody else', async () => {
    const list = await api().get('/api/v1/portal/ppap-packages').set(await external(sam)).expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(Object.keys(list.body.data[0]).sort()).toEqual(['answeredAt', 'canEdit', 'id', 'level', 'partName', 'partNumber', 'reference', 'requestedAt', 'status', 'submissionStatus']);
    const one = await api().get(`/api/v1/portal/ppap-packages/${requestId}`).set(await external(sam)).expect(200);
    expect(Object.keys(one.body).sort()).toEqual([
      'answeredAt', 'canEdit', 'canSubmit', 'contact', 'decidedOn', 'decision', 'decisionExpiresOn', 'decisionNote', 'elements', 'id', 'level', 'missing', 'partName', 'partNumber', 'reason',
      'reference', 'requestNote', 'requestedAt', 'revision', 'status', 'submissionStatus', 'submittedOn',
    ]);
    expect(Object.keys(one.body.elements[0]).sort()).toEqual(['files', 'key', 'name', 'provided', 'requirement', 'waived']);
    expect(one.body).toMatchObject({ partNumber: 'P5B-100', level: 1, canEdit: true, canSubmit: false, missing: ['Part Submission Warrant'] });
    const home = await api().get('/api/v1/portal/home').set(await external(sam)).expect(200);
    expect(home.body.ppapPackagesToPrepare).toBe(1);
    // customers and other suppliers
    await api().get('/api/v1/portal/ppap-packages').set(await external(cus)).expect(404);
    expect((await api().get('/api/v1/portal/ppap-packages').set(await external(sue)).expect(200)).body.data).toEqual([]);
    await api().get(`/api/v1/portal/ppap-packages/${requestId}`).set(await external(sue)).expect(404);
    await api().post(`/api/v1/portal/ppap-packages/${requestId}/submit`).set(await external(sue)).send({}).expect(404);
  });

  it('refuses a submission while something is missing, and files to an element not asked of them', async () => {
    const h = await external(sam);
    const missing = await api().post(`/api/v1/portal/ppap-packages/${requestId}/submit`).set(h).send({}).expect(409);
    expect(missing.body.error.message).toMatch(/Part Submission Warrant/);
    await api().post(`/api/v1/portal/ppap-packages/${requestId}/files/upload-url`).set(h).send({ elementKey: 'dfmea', fileName: 'x.pdf' }).expect(403);
    await api().post(`/api/v1/portal/ppap-packages/${requestId}/files`).set(h).send({ elementKey: 'part_submission_warrant', path: `${ids.orgA}/ppap/${packageId}/../x.pdf`, fileName: 'x.pdf', sizeBytes: 1 }).expect(409);
  });

  it('takes a file for the warrant, then submits, and the supplier sees our decision', async () => {
    const h = await external(sam);
    const path = `${ids.orgA}/ppap/${packageId}/${'a'.repeat(8)}-warrant.pdf`;
    const link = await api().post(`/api/v1/portal/ppap-packages/${requestId}/files/upload-url`).set(h).send({ elementKey: 'part_submission_warrant', fileName: 'My warrant.pdf' }).expect(200);
    expect(link.body.bucket).toBe('ppap-files');
    expect(link.body.path.startsWith(`${ids.orgA}/ppap/${packageId}/`)).toBe(true);
    expect(link.body.path.endsWith('My-warrant.pdf') || link.body.path.endsWith('My_warrant.pdf') || link.body.path.includes('warrant.pdf')).toBe(true);
    expect(signer.calls.at(-1)).toBe(`upload ppap-files ${link.body.path}`);
    const added = await api().post(`/api/v1/portal/ppap-packages/${requestId}/files`).set(h).send({ elementKey: 'part_submission_warrant', path, fileName: 'warrant.pdf', contentType: 'application/pdf', sizeBytes: 1000 }).expect(201);
    expect(added.body.missing).toEqual([]);
    expect(added.body.canSubmit).toBe(true);
    const warrant = added.body.elements.find((e: { key: string }) => e.key === 'part_submission_warrant');
    expect(warrant.files).toEqual([expect.objectContaining({ name: 'warrant.pdf', mine: true })]);
    await api().post(`/api/v1/portal/ppap-package-files/${warrant.files[0].id}/remove`).set(await external(sue)).expect(404);
    await api().post(`/api/v1/portal/ppap-package-files/${warrant.files[0].id}/download-url`).set(await external(sue)).expect(404);
    const open = await api().post(`/api/v1/portal/ppap-package-files/${warrant.files[0].id}/download-url`).set(h).expect(200);
    expect(open.body.url).toContain(`ppap-files/${path}`);
    expect(open.body.expiresIn).toBe(600);
    const submitted = await api().post(`/api/v1/portal/ppap-packages/${requestId}/submit`).set(h).send({ note: 'All attached.' }).expect(200);
    expect(submitted.body).toMatchObject({ submissionStatus: 'submitted', canEdit: false, canSubmit: false, status: 'answered' });
    await api().post(`/api/v1/portal/ppap-packages/${requestId}/submit`).set(h).send({}).expect(409);
    await api().post(`/api/v1/portal/ppap-package-files/${warrant.files[0].id}/remove`).set(h).expect(404);
    // staff see it submitted by the supplier, then decide
    const detail = await api().get(`/api/v1/ppaps/${packageId}`).set(await staff()).expect(200);
    expect(detail.body.status).toBe('submitted');
    expect(detail.body.decisions[0]).toMatchObject({ kind: 'submitted', how: 'Supplier portal', note: 'All attached.' });
    const told = await admin.query(`select count(*)::int as n from public.portal_activity where kind = 'ppap_submitted' and record_id = $1 and record_kind = 'ppap'`, [packageId]);
    expect(told.rows[0].n).toBe(1);
    await api().post(`/api/v1/ppaps/${packageId}/decisions`).set(await staff()).send({ kind: 'rejected', decidedOn: new Date().toISOString().slice(0, 10), note: 'The capability study is missing.' }).expect(200);
    const after = await api().get(`/api/v1/portal/ppap-packages/${requestId}`).set(h).expect(200);
    expect(after.body).toMatchObject({ decision: 'rejected', decisionNote: 'The capability study is missing.' });
  });
});
