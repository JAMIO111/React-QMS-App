/**
 * Files on a lot shared with a customer (docs/external-portal-plan.md PT5f) through the API: staff share a certificate with one customer the lot is for,
 * the customer lists and opens only theirs, removal hides it at once, other customers and strangers get nothing. The signer is a fake.
 * Rules: supabase/tests/lot_evidence.test.sql.
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
    return { token: 'tok', signedUrl: `https://storage.test/upload/${bucket}/${path}?token=tok` };
  }
  async remove() {}
}

const ids = makeIds('9c7c');
const u = (tail: string) => `${'9c7c'.padEnd(8, '0')}-0000-0000-0000-${tail.padStart(12, '0')}`;
const cus = u('e4');
const cus2 = u('e5');
const signer = new FakeSigner();
let app: INestApplication;
let admin: Pool;
let lotId: string;
let wayne: string;
let other: string;
const api = () => request(app.getHttpServer());
const staff = async (user = ids.ownerA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': ids.orgA });
const external = async (user: string) => ({ Authorization: `Bearer ${await token(user, { aal: 'aal2' })}`, 'X-Organisation-Id': ids.orgA });
const bare = async (user: string) => ({ Authorization: `Bearer ${await token(user, { aal: 'aal2' })}` });

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-pt5f');
  for (const [id, email] of [[cus, 'cus@wayne-pt5f.test'], [cus2, 'cus2@other-pt5f.test']]) {
    await admin.query(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now()) on conflict do nothing`, [id, email]);
  }
  await admin.query(`insert into public.customers (organisation_id, code, name) values ($1, 'WAYNE', 'Wayne Ltd'), ($1, 'OTHER', 'Other Co') on conflict do nothing`, [ids.orgA]);
  wayne = (await admin.query(`select id from public.customers where organisation_id = $1 and code = 'WAYNE'`, [ids.orgA])).rows[0].id;
  other = (await admin.query(`select id from public.customers where organisation_id = $1 and code = 'OTHER'`, [ids.orgA])).rows[0].id;
  const part = (await admin.query(`insert into public.parts (organisation_id, part_number, name) values ($1, 'P5F-1', 'Bracket') returning id`, [ids.orgA])).rows[0].id;
  await admin.query(`insert into public.part_customers (organisation_id, part_id, customer_id, is_primary) values ($1, $2, $3, true)`, [ids.orgA, part, wayne]);
  lotId = (await admin.query(`insert into public.lots (organisation_id, lot_number, origin, part_id, quantity) values ($1, 'LOT-5F', 'received', $2, 10) returning id`, [ids.orgA, part])).rows[0].id;
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
  for (const [p, email, user] of [[pC, 'cus@wayne-pt5f.test', cus], [pO, 'cus2@other-pt5f.test', cus2]] as const) {
    await api().post('/api/v1/external-access/people').set(await staff()).send({ partyId: p, email, role: 'admin' }).expect(201);
    const inv = (await api().get('/api/v1/portal/invitations').set(await bare(user))).body.data[0];
    await api().post(`/api/v1/portal/invitations/${inv.id}/accept`).set(await bare(user)).expect(201);
  }
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('lot evidence for a customer', () => {
  let fileId: string;
  const path = () => `${ids.orgA}/lot/${lotId}/aaaa-coc.pdf`;

  it('offers only the customers the lot is for, and shares a file with one of them', async () => {
    const before = await api().get(`/api/v1/external-access/lots/${lotId}/evidence`).set(await staff()).expect(200);
    expect(before.body.customers.map((c: { name: string }) => c.name)).toEqual(['Wayne Ltd']);
    await api().post(`/api/v1/external-access/lots/${lotId}/evidence`).set(await staff()).send({ customerId: other, kind: 'certificate_of_conformance', path: path(), fileName: 'coc.pdf', sizeBytes: 100 }).expect(409);
    const r = await api().post(`/api/v1/external-access/lots/${lotId}/evidence`).set(await staff()).send({ customerId: wayne, kind: 'certificate_of_conformance', description: 'Certificate', path: path(), fileName: 'coc.pdf', contentType: 'application/pdf', sizeBytes: 100 }).expect(201);
    expect(r.body.data[0]).toMatchObject({ customerName: 'Wayne Ltd', kind: 'certificate_of_conformance', fileName: 'coc.pdf' });
    fileId = r.body.data[0].id;
  });

  it('shows the customer their file with the lot and part, and a ten-minute link', async () => {
    const list = await api().get('/api/v1/portal/evidence').set(await external(cus)).expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ lotNumber: 'LOT-5F', partNumber: 'P5F-1', kind: 'certificate_of_conformance', fileName: 'coc.pdf' });
    expect(Object.keys(list.body.data[0]).sort()).toEqual(['addedAt', 'description', 'fileName', 'id', 'kind', 'lotNumber', 'partName', 'partNumber', 'sizeBytes']);
    const link = await api().post(`/api/v1/portal/evidence/${fileId}/download-url`).set(await external(cus)).expect(200);
    expect(link.body.url).toContain('lot-evidence');
    expect(signer.calls.at(-1)).toBe(`download lot-evidence ${path()} 600`);
  });

  it('keeps it from another customer, an inspector and a stranger', async () => {
    expect((await api().get('/api/v1/portal/evidence').set(await external(cus2))).body.data).toHaveLength(0);
    await api().post(`/api/v1/portal/evidence/${fileId}/download-url`).set(await external(cus2)).expect(404);
    await api().get(`/api/v1/external-access/lots/${lotId}/evidence`).set(await staff(ids.inspectorA)).expect(403);
    await api().get('/api/v1/portal/evidence').set(await external(ids.ownerB)).expect(404);
  });

  it('hides a removed file from the customer at once, and keeps it for staff with the reason', async () => {
    await api().post(`/api/v1/external-access/lot-evidence/${fileId}/remove`).set(await staff()).send({ reason: 'x' }).expect(400);
    const r = await api().post(`/api/v1/external-access/lot-evidence/${fileId}/remove`).set(await staff()).send({ reason: 'Wrong certificate' }).expect(201);
    expect(r.body.data[0]).toMatchObject({ removeReason: 'Wrong certificate' });
    expect((await api().get('/api/v1/portal/evidence').set(await external(cus))).body.data).toHaveLength(0);
    await api().post(`/api/v1/portal/evidence/${fileId}/download-url`).set(await external(cus)).expect(404);
  });
});
