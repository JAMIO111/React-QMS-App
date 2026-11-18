/**
 * Evidence files on a SCAR response (docs/external-portal-plan.md PT3b) through the API: the supplier uploads under the portal rule, files wait unsent
 * until a response goes, a sent file is kept, and nobody else (another supplier, a stranger, staff writing directly) can add or open them. The
 * signer is a fake that records calls. Rules themselves: supabase/tests/portal_scars.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { configureApp } from '../src/app.factory';
import { AppModule } from '../src/app.module';
import { FileLinkSigner } from '../src/files/file-links';
import { categoryId, makeIds, requireDb, seed, testEnv, token } from './helpers';

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

const ids = makeIds('9c74');
const u = (tail: string) => `${'9c74'.padEnd(8, '0')}-0000-0000-0000-${tail.padStart(12, '0')}`;
const sam = u('e1');
const ben = u('e3');
const signer = new FakeSigner();
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
  await seed(admin, ids, '-pt3b');
  for (const [id, email] of [[sam, 'sam@acme-pt3b.test'], [ben, 'ben@bolt-pt3b.test']]) {
    await admin.query(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now()) on conflict do nothing`, [id, email]);
  }
  await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'ACME', 'Acme Castings'), ($1, 'BOLT', 'Bolt Ltd') on conflict do nothing`, [ids.orgA]);
  const acme = (await admin.query(`select id from public.suppliers where organisation_id = $1 and code = 'ACME'`, [ids.orgA])).rows[0].id;
  const bolt = (await admin.query(`select id from public.suppliers where organisation_id = $1 and code = 'BOLT'`, [ids.orgA])).rows[0].id;
  const nc = await admin.query(
    `insert into public.nonconformances (organisation_id, reference, source, stage, category_id, title, severity, quantity_affected, site_id, supplier_id)
     values ($1, 'PT3B-E2E-1', 'supplier', 'open', $2, 'Cracked bar stock', 'major', 10, $3, $4) returning id`,
    [ids.orgA, await categoryId(admin, ids.orgA), ids.siteA, acme],
  );
  const env = testEnv({ RATE_LIMIT_PER_MINUTE: '10000' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).overrideProvider(FileLinkSigner).useValue(signer).compile();
  const nest = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, rawBody: true });
  app = configureApp(nest, env);
  await app.init();
  await api().put('/api/v1/external-access/settings').set(await staff()).send({ enabled: true, requireMfa: false }).expect(200);
  const a = await api().put('/api/v1/external-access/parties').set(await staff()).send({ kind: 'supplier', partyId: acme, enabled: true }).expect(200);
  const b = await api().put('/api/v1/external-access/parties').set(await staff()).send({ kind: 'supplier', partyId: bolt, enabled: true }).expect(200);
  const partyA = a.body.parties.find((p: { name: string }) => p.name === 'Acme Castings').partyId;
  const partyB = b.body.parties.find((p: { name: string }) => p.name === 'Bolt Ltd').partyId;
  for (const [party, email, user] of [[partyA, 'sam@acme-pt3b.test', sam], [partyB, 'ben@bolt-pt3b.test', ben]] as const) {
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

const upload = async (user: string, name: string) => api().post(`/api/v1/portal/scars/${scarId}/files/upload-url`).set(await external(user)).send({ fileName: name });
let sentFileId: string;

describe('uploading', () => {
  it('chooses the path itself, inside the SCAR’s folder, with a safe name', async () => {
    const res = await upload(sam, '../../evil/..\\report.pdf');
    expect(res.status).toBe(200);
    expect(res.body.bucket).toBe('scar-files');
    expect(res.body.path.startsWith(`${ids.orgA}/scar/${scarId}/`)).toBe(true);
    expect(res.body.path).not.toContain('..');
    expect(res.body.path.split('/')).toHaveLength(4);
    expect(signer.calls.at(-1)).toBe(`upload scar-files ${res.body.path}`);
  });

  it('refuses another supplier, a draft SCAR and the staff route', async () => {
    expect((await upload(ben, 'x.pdf')).status).toBe(404);
    await api().post(`/api/v1/portal/scars/${draftId}/files/upload-url`).set(await external(sam)).send({ fileName: 'x.pdf' }).expect(404);
    const staffWrite = await api()
      .post('/api/v1/files/upload-url')
      .set(await staff())
      .send({ bucket: 'scar-files', path: `${ids.orgA}/scar/${scarId}/${'a'.repeat(8)}-x.pdf` });
    expect(staffWrite.status).toBe(403);
  });
});

describe('files that wait, are taken back or sent', () => {
  it('records an uploaded file as unsent, only inside the folder', async () => {
    const link = (await upload(sam, 'evidence.pdf')).body;
    const res = await api().post(`/api/v1/portal/scars/${scarId}/files`).set(await external(sam)).send({ path: link.path, fileName: 'evidence.pdf', contentType: 'application/pdf', sizeBytes: 2048 }).expect(201);
    expect(res.body.scar.draftFiles).toEqual([expect.objectContaining({ fileName: 'evidence.pdf', sizeBytes: 2048, mine: true })]);
    await api().post(`/api/v1/portal/scars/${scarId}/files`).set(await external(sam)).send({ path: `${ids.orgA}/scar/${draftId}/x.pdf`, fileName: 'x.pdf', sizeBytes: 1 }).expect(409);
    await api().post(`/api/v1/portal/scars/${scarId}/files`).set(await external(ben)).send({ path: link.path, fileName: 'evidence.pdf', sizeBytes: 1 }).expect(404);
  });

  it('can be taken back before a response is sent, by the supplier only', async () => {
    const link = (await upload(sam, 'wrong.pdf')).body;
    const added = await api().post(`/api/v1/portal/scars/${scarId}/files`).set(await external(sam)).send({ path: link.path, fileName: 'wrong.pdf', sizeBytes: 10 }).expect(201);
    const wrong = added.body.scar.draftFiles.find((f: { fileName: string }) => f.fileName === 'wrong.pdf');
    await api().post(`/api/v1/portal/scar-files/${wrong.id}/remove`).set(await external(ben)).expect(404);
    const res = await api().post(`/api/v1/portal/scar-files/${wrong.id}/remove`).set(await external(sam)).expect(201);
    expect(res.body.scar.draftFiles.map((f: { fileName: string }) => f.fileName)).toEqual(['evidence.pdf']);
    await api().post(`/api/v1/portal/scar-files/${wrong.id}/remove`).set(await external(sam)).expect(409);
  });

  it('goes with the response and is then kept', async () => {
    const res = await api().post(`/api/v1/portal/scars/${scarId}/respond`).set(await external(sam)).send({ rootCause: 'Mould too cold', correctiveAction: 'Raise the temperature' }).expect(201);
    expect(res.body.scar.draftFiles).toEqual([]);
    expect(res.body.scar.responses[0].files).toEqual([expect.objectContaining({ fileName: 'evidence.pdf' })]);
    sentFileId = res.body.scar.responses[0].files[0].id;
    await api().post(`/api/v1/portal/scar-files/${sentFileId}/remove`).set(await external(sam)).expect(409);
    // a response is no longer awaited, so no more uploads
    expect((await upload(sam, 'late.pdf')).status).toBe(403);
  });
});

describe('opening files', () => {
  it('gives the supplier a short link to their own file only', async () => {
    const res = await api().post(`/api/v1/portal/scar-files/${sentFileId}/download-url`).set(await external(sam)).expect(200);
    expect(res.body.url).toContain('/scar-files/');
    expect(res.body.expiresIn).toBe(600);
    await api().post(`/api/v1/portal/scar-files/${sentFileId}/download-url`).set(await external(ben)).expect(404);
    await api().post(`/api/v1/portal/scar-files/${u('ff')}/download-url`).set(await external(sam)).expect(404);
  });

  it('shows staff the file on the unchanged SCAR page and lets them open it through /files', async () => {
    const detail = (await api().get(`/api/v1/supplier-quality/scars/${scarId}`).set(await staff()).expect(200)).body;
    const file = detail.responses[0].files[0];
    expect(file).toMatchObject({ fileName: 'evidence.pdf', sizeBytes: 2048 });
    const res = await api().post('/api/v1/files/download-url').set(await staff()).send({ bucket: 'scar-files', path: file.storagePath }).expect(200);
    expect(res.body.url).toContain(file.storagePath);
  });

  it('does not let the supplier use the staff file route', async () => {
    const detail = (await api().get(`/api/v1/supplier-quality/scars/${scarId}`).set(await staff()).expect(200)).body;
    const res = await api().post('/api/v1/files/download-url').set(await external(sam)).send({ bucket: 'scar-files', path: detail.responses[0].files[0].storagePath });
    expect([403, 404]).toContain(res.status);
  });
});
