/**
 * File links through the API (docs/security-plan.md SE3): uploads and downloads are signed only after the file's own rule (the same function as
 * the storage policies) allows the person, paths stay inside the organisation, links are shorter while network restrictions are enforced, the
 * network rule applies like every organisation route, and logos can be removed by organisation.manage only. The signer is a fake that records calls.
 */
import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { configureApp } from '../src/app.factory';
import { AppModule } from '../src/app.module';
import { FileLinkSigner } from '../src/files/file-links';
import { pathProblem } from '../src/files/files.service';
import { makeIds, requireDb, seed, testEnv, token } from './helpers';

class FakeSigner extends FileLinkSigner {
  enabled = true;
  calls: string[] = [];
  objects = new Set<string>();
  async signDownload(bucket: string, path: string, expiresIn: number) {
    this.calls.push(`download ${bucket} ${path} ${expiresIn}`);
    return this.objects.has(`${bucket}/${path}`) ? `https://storage.test/${bucket}/${path}?token=d&e=${expiresIn}` : null;
  }
  async signUpload(bucket: string, path: string) {
    this.calls.push(`upload ${bucket} ${path}`);
    return { token: 'tok', signedUrl: `https://storage.test/upload/${bucket}/${path}?token=tok` };
  }
  async remove(bucket: string, path: string) {
    this.calls.push(`remove ${bucket} ${path}`);
    this.objects.delete(`${bucket}/${path}`);
  }
}

const ids = makeIds('5ec3');
const signer = new FakeSigner();
let app: INestApplication;
let admin: Pool;
let ncr: string;
const HQ = '203.0.113.10';
const HOME = '198.51.100.200';
const api = () => request(app.getHttpServer());
const as = async (user: string, from = HQ, org = ids.orgA) => ({
  Authorization: `Bearer ${await token(user)}`,
  'X-Organisation-Id': org,
  'X-Forwarded-For': from,
});

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-se3');
  const env = testEnv({ RATE_LIMIT_PER_MINUTE: '10000', TRUST_PROXY_HOPS: '1' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).overrideProvider(FileLinkSigner).useValue(signer).compile();
  const nest = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, rawBody: true });
  app = configureApp(nest, env);
  await app.init();
  ncr = (await api().post('/api/v1/ncrs').set(await as(ids.ownerA)).send({ source: 'internal', title: 'Scratched face', siteId: ids.siteA }).expect(201)).body.id;
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('paths', () => {
  it('stay in the organisation’s own folder, with no tricks', () => {
    const org = ids.orgA;
    expect(pathProblem(org, `${org}/ncr/x/a.pdf`)).toBeNull();
    expect(pathProblem(org, `${ids.orgB}/ncr/x/a.pdf`)).toMatch(/not in this organisation/);
    expect(pathProblem(org, `${org}/ncr/../../${ids.orgB}/a.pdf`)).toMatch(/not valid/);
    expect(pathProblem(org, `${org}//a.pdf`)).toMatch(/not valid/);
    expect(pathProblem(org, `${org}/ncr\\x/a.pdf`)).toMatch(/not allowed/);
    expect(pathProblem(org, `${org}/a.pdf`)).toMatch(/not valid/);
  });
});

describe('upload links', () => {
  it('are signed for a folder the person may add to', async () => {
    const path = `${ids.orgA}/ncr/${ncr}/abc-photo.jpg`;
    const res = await api().post('/api/v1/files/upload-url').set(await as(ids.ownerA)).send({ bucket: 'nc-files', path }).expect(200);
    expect(res.body).toMatchObject({ bucket: 'nc-files', path, token: 'tok' });
    expect(signer.calls).toContain(`upload nc-files ${path}`);
    signer.objects.add(`nc-files/${path}`);
  });

  it('are refused for a record that does not exist, another organisation, a bad path or someone who may only read', async () => {
    const h = await as(ids.ownerA);
    const before = signer.calls.length;
    const missing = await api().post('/api/v1/files/upload-url').set(h).send({ bucket: 'nc-files', path: `${ids.orgA}/ncr/${ids.orgB}/a.pdf` }).expect(403);
    expect(missing.body.error).toMatchObject({ code: 'file_not_allowed', message: 'You cannot add a file there' });
    const other = await api().post('/api/v1/files/upload-url').set(h).send({ bucket: 'nc-files', path: `${ids.orgB}/ncr/${ncr}/a.pdf` }).expect(400);
    expect(other.body.error.code).toBe('invalid_path');
    await api().post('/api/v1/files/upload-url').set(h).send({ bucket: 'avatars', path: `users/${ids.ownerA}/a.png` }).expect(400);
    await api().post('/api/v1/files/upload-url').set(await as(ids.dual)).send({ bucket: 'nc-files', path: `${ids.orgA}/ncr/${ncr}/v.pdf` }).expect(403);
    await api().post('/api/v1/files/upload-url').set(await as(ids.outsider)).send({ bucket: 'nc-files', path: `${ids.orgA}/ncr/${ncr}/o.pdf` }).expect(404);
    expect(signer.calls.length).toBe(before);
  });
});

describe('download links', () => {
  const path = () => `${ids.orgA}/ncr/${ncr}/abc-photo.jpg`;

  it('are signed for someone who may read the record, ten minutes by default and an hour at most', async () => {
    const res = await api().post('/api/v1/files/download-url').set(await as(ids.dual)).send({ bucket: 'nc-files', path: path() }).expect(200);
    expect(res.body).toMatchObject({ url: expect.stringContaining('e=600'), expiresIn: 600 });
    const long = await api().post('/api/v1/files/download-url').set(await as(ids.dual)).send({ bucket: 'nc-files', path: path(), expiresIn: 3600 }).expect(200);
    expect(long.body.expiresIn).toBe(3600);
    await api().post('/api/v1/files/download-url').set(await as(ids.dual)).send({ bucket: 'nc-files', path: path(), expiresIn: 7200 }).expect(400);
  });

  it('answer 404 for a file that is not there, and nothing from another organisation', async () => {
    const missing = await api().post('/api/v1/files/download-url').set(await as(ids.ownerA)).send({ bucket: 'nc-files', path: `${ids.orgA}/ncr/${ncr}/none.pdf` }).expect(404);
    expect(missing.body.error.code).toBe('file_not_found');
    await api().post('/api/v1/files/download-url').set(await as(ids.ownerB, HQ, ids.orgB)).send({ bucket: 'nc-files', path: path() }).expect(400);
  });
});

describe('while network restrictions are enforced', () => {
  beforeAll(async () => {
    const h = await as(ids.ownerA);
    await api().post('/api/v1/security/networks').set(h).send({ name: 'HQ', network: '203.0.113.0/24' }).expect(201);
    await api().put('/api/v1/security/access-policy').set(h).send({ mode: 'enforce', confirm: true }).expect(200);
  });
  afterAll(async () => {
    await api().put('/api/v1/security/access-policy').set(await as(ids.ownerA)).send({ mode: 'off' }).expect(200);
  });

  it('links come only from an approved network, and last five minutes at most', async () => {
    const body = { bucket: 'nc-files', path: `${ids.orgA}/ncr/${ncr}/abc-photo.jpg`, expiresIn: 3600 };
    const outside = await api().post('/api/v1/files/download-url').set(await as(ids.dual, HOME)).send(body).expect(403);
    expect(outside.body.error.code).toBe('network_not_allowed');
    await api().post('/api/v1/files/upload-url').set(await as(ids.ownerA, HOME)).send({ bucket: 'nc-files', path: `${ids.orgA}/ncr/${ncr}/h.pdf` }).expect(403);
    const inside = await api().post('/api/v1/files/download-url').set(await as(ids.dual)).send(body).expect(200);
    expect(inside.body.expiresIn).toBe(300);
  });

  it('the API’s own check that an upload arrived still works (it reads storage as its own login)', async () => {
    await admin.query(`insert into storage.objects (bucket_id, name) values ('nc-files', $1)`, [`${ids.orgA}/ncr/${ncr}/arrived.pdf`]);
    const res = await api().post(`/api/v1/ncrs/${ncr}/attachments`).set(await as(ids.ownerA))
      .send({ storagePath: `${ids.orgA}/ncr/${ncr}/arrived.pdf`, fileName: 'arrived.pdf', contentType: 'application/pdf', sizeBytes: 10 });
    expect(res.status).toBe(201);
  });
});

describe('logos', () => {
  it('upload into the logo folder and removal need organisation.manage', async () => {
    const path = `${ids.orgA}/logo/new.png`;
    await api().post('/api/v1/files/upload-url').set(await as(ids.ownerA)).send({ bucket: 'org-logos', path }).expect(200);
    await api().post('/api/v1/files/upload-url').set(await as(ids.ownerA)).send({ bucket: 'org-logos', path: `${ids.orgA}/other/new.png` }).expect(403);
    await api().post('/api/v1/files/remove').set(await as(ids.dual)).send({ bucket: 'org-logos', path }).expect(403);
    await api().post('/api/v1/files/remove').set(await as(ids.ownerA)).send({ bucket: 'nc-files', path: `${ids.orgA}/ncr/${ncr}/abc-photo.jpg` }).expect(400);
    await api().post('/api/v1/files/remove').set(await as(ids.ownerA)).send({ bucket: 'org-logos', path }).expect(200);
    expect(signer.calls).toContain(`remove org-logos ${path}`);
  });

  it('every member can open the logo', async () => {
    signer.objects.add(`org-logos/${ids.orgA}/logo/a.png`);
    await api().post('/api/v1/files/download-url').set(await as(ids.inspectorA)).send({ bucket: 'org-logos', path: `${ids.orgA}/logo/a.png` }).expect(200);
  });
});

describe('without a storage key', () => {
  it('answers 503 file_storage_unavailable', async () => {
    signer.enabled = false;
    try {
      const res = await api().post('/api/v1/files/upload-url').set(await as(ids.ownerA)).send({ bucket: 'nc-files', path: `${ids.orgA}/ncr/${ncr}/x.pdf` }).expect(503);
      expect(res.body.error.code).toBe('file_storage_unavailable');
    } finally {
      signer.enabled = true;
    }
  });
});
