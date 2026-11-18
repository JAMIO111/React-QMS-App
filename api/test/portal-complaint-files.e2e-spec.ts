/**
 * Files on a complaint (docs/external-portal-plan.md PT5e) through the API: the customer uploads under the portal rule while the complaint is a draft, sees
 * only their own party's files (never staff's), and nobody else can add or open them. The signer is a fake. Rules: supabase/tests/portal_complaint_files.test.sql.
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

const ids = makeIds('9c7b');
const u = (tail: string) => `${'9c7b'.padEnd(8, '0')}-0000-0000-0000-${tail.padStart(12, '0')}`;
const cus = u('e4');
const cus2 = u('e5');
const signer = new FakeSigner();
let app: INestApplication;
let admin: Pool;
let complaintId: string;
let ncrId: string;
const api = () => request(app.getHttpServer());
const staff = async () => ({ Authorization: `Bearer ${await token(ids.ownerA)}`, 'X-Organisation-Id': ids.orgA });
const external = async (user: string) => ({ Authorization: `Bearer ${await token(user, { aal: 'aal2' })}`, 'X-Organisation-Id': ids.orgA });
const bare = async (user: string) => ({ Authorization: `Bearer ${await token(user, { aal: 'aal2' })}` });

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-pt5e');
  for (const [id, email] of [[cus, 'cus@wayne-pt5e.test'], [cus2, 'cus2@other-pt5e.test']]) {
    await admin.query(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now()) on conflict do nothing`, [id, email]);
  }
  await admin.query(`insert into public.customers (organisation_id, code, name) values ($1, 'WAYNE', 'Wayne Ltd'), ($1, 'OTHER', 'Other Co') on conflict do nothing`, [ids.orgA]);
  const wayne = (await admin.query(`select id from public.customers where organisation_id = $1 and code = 'WAYNE'`, [ids.orgA])).rows[0].id;
  const other = (await admin.query(`select id from public.customers where organisation_id = $1 and code = 'OTHER'`, [ids.orgA])).rows[0].id;
  const env = testEnv({ RATE_LIMIT_PER_MINUTE: '10000' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).overrideProvider(FileLinkSigner).useValue(signer).compile();
  const nest = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, rawBody: true });
  app = configureApp(nest, env);
  await app.init();
  await api().put('/api/v1/external-access/settings').set(await staff()).send({ enabled: true, requireMfa: false }).expect(200);
  const party = async (partyId: string, name: string) =>
    (await api().put('/api/v1/external-access/parties').set(await staff()).send({ kind: 'customer', partyId, enabled: true }).expect(200)).body.parties.find((p: { name: string }) => p.name === name).partyId as string;
  const pC = await party(wayne, 'Wayne Ltd');
  const pO = await party(other, 'Other Co');
  for (const [p, email, user] of [[pC, 'cus@wayne-pt5e.test', cus], [pO, 'cus2@other-pt5e.test', cus2]] as const) {
    await api().post('/api/v1/external-access/people').set(await staff()).send({ partyId: p, email, role: 'admin' }).expect(201);
    const inv = (await api().get('/api/v1/portal/invitations').set(await bare(user))).body.data[0];
    await api().post(`/api/v1/portal/invitations/${inv.id}/accept`).set(await bare(user)).expect(201);
  }
  const made = await api().post('/api/v1/portal/complaints').set(await external(cus)).send({ title: 'Bracket cracked', description: 'Cracks at the bend of three brackets.' }).expect(201);
  complaintId = made.body.id;
  ncrId = (await admin.query(`select nonconformance_id from public.portal_complaints where id = $1`, [complaintId])).rows[0].nonconformance_id;
  await admin.query(`insert into public.ncr_attachments (organisation_id, nonconformance_id, storage_path, file_name, size_bytes) values ($1::uuid, $2::uuid, $1::text || '/ncr/' || $2::text || '/staff.pdf', 'staff.pdf', 5)`, [ids.orgA, ncrId]);
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('files on a complaint', () => {
  let fileId: string;

  it('signs an upload into the complaint’s own folder and records the file', async () => {
    const res = await api().post(`/api/v1/portal/complaints/${complaintId}/files/upload-url`).set(await external(cus)).send({ fileName: 'crack photo.jpg' }).expect(200);
    expect(res.body.bucket).toBe('nc-files');
    expect(res.body.path.startsWith(`${ids.orgA}/ncr/${ncrId}/`)).toBe(true);
    expect(res.body.path).toMatch(/-crack_photo\.jpg$|-crack-photo\.jpg$|-crack photo\.jpg$/);
    expect(signer.calls.at(-1)).toBe(`upload nc-files ${res.body.path}`);
    await api().post(`/api/v1/portal/complaints/${complaintId}/files`).set(await external(cus)).send({ path: res.body.path, fileName: 'crack photo.jpg', contentType: 'image/jpeg', sizeBytes: 2048 }).expect(201);
  });

  it('shows the customer only their own party’s files, with a link, and lets them take one back', async () => {
    const list = await api().get('/api/v1/portal/complaints').set(await external(cus)).expect(200);
    const files = list.body.data[0].files;
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ name: 'crack photo.jpg', mine: true, canRemove: true });
    fileId = files[0].id;
    const link = await api().post(`/api/v1/portal/complaint-files/${fileId}/download-url`).set(await external(cus)).expect(200);
    expect(link.body.url).toContain('nc-files');
    await api().post(`/api/v1/portal/complaint-files/${fileId}/remove`).set(await external(cus)).expect(201);
    const after = await api().get('/api/v1/portal/complaints').set(await external(cus)).expect(200);
    expect(after.body.data[0].files).toHaveLength(0);
  });

  it('keeps staff files, other customers and strangers out', async () => {
    const staffFile = (await admin.query(`select id from public.ncr_attachments where nonconformance_id = $1 and file_name = 'staff.pdf'`, [ncrId])).rows[0].id;
    await api().post(`/api/v1/portal/complaint-files/${staffFile}/download-url`).set(await external(cus)).expect(404);
    await api().post(`/api/v1/portal/complaint-files/${staffFile}/remove`).set(await external(cus)).expect(404);
    await api().post(`/api/v1/portal/complaints/${complaintId}/files/upload-url`).set(await external(cus2)).send({ fileName: 'x.jpg' }).expect(404);
    await api().post(`/api/v1/portal/complaints/${complaintId}/files/upload-url`).set(await external(ids.ownerB)).send({ fileName: 'x.jpg' }).expect(404);
  });

  it('refuses a new file once staff have opened the complaint', async () => {
    await admin.query(`update public.nonconformances set stage = 'open', severity = 'minor', quantity_affected = 3, site_id = $2, category_id = (select id from public.ncr_classifications where organisation_id = $1 and kind = 'category' limit 1) where id = $3`, [ids.orgA, ids.siteA, ncrId]);
    await api().post(`/api/v1/portal/complaints/${complaintId}/files/upload-url`).set(await external(cus)).send({ fileName: 'late.jpg' }).expect(403);
  });
});
