/**
 * Document control (DC5) through the API: external documents (issuer, reference, revisions recorded as issued), controlled PDF copies stamped on
 * every page (from a fake file store), and the documents dashboard. The rules are in supabase/tests/document_control_external.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { PDFDocument } from 'pdf-lib';
import { Pool } from 'pg';
import request from 'supertest';
import { configureApp } from '../src/app.factory';
import { AppModule } from '../src/app.module';
import { DocumentFileStore } from '../src/documents/controlled-copy';
import { makeIds, requireDb, seed, testEnv, token } from './helpers';

const ids = makeIds('d5c');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};
const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

class MemoryStore extends DocumentFileStore {
  files = new Map<string, Uint8Array>();
  get enabled() {
    return true;
  }
  async download(path: string) {
    return this.files.get(path) ?? null;
  }
}
const store = new MemoryStore();
const pdf = async (pages = 2) => {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage([595, 842]);
  return d.save();
};
const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-dx');
  const env = testEnv({ RATE_LIMIT_PER_MINUTE: '10000' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).overrideProvider(DocumentFileStore).useValue(store).compile();
  const nest = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, rawBody: true });
  app = configureApp(nest, env);
  await app.init();
  const types = await api().get('/api/v1/document-types').set(await as(ids.ownerA)).expect(200);
  ctx.ext = types.body.data.find((t: { prefix: string }) => t.prefix === 'EXT').id;
  ctx.sop = types.body.data.find((t: { prefix: string }) => t.prefix === 'SOP').id;
});
afterAll(async () => {
  await admin?.query(`delete from public.email_outbox where organisation_id = $1`, [ids.orgA]);
  await app?.close();
  await admin?.end();
});

const addMain = async (rev: string, name: string, bytes: Uint8Array, type = 'application/pdf') => {
  const path = `${ids.orgA}/document/${rev}/${name}`;
  store.files.set(path, bytes);
  const res = await api().post(`/api/v1/document-revisions/${rev}/files`).set(await as(ids.ownerA)).send({ role: 'main', storagePath: path, fileName: name, contentType: type, sizeBytes: bytes.length }).expect(201);
  return res.body.files.find((f: { fileName: string; deletedAt: string | null }) => f.fileName === name && !f.deletedAt).id as string;
};

describe('external documents', () => {
  it('creates one with its issuer, needing only its file', async () => {
    const h = await as(ids.ownerA);
    const bad = await api().post('/api/v1/documents').set(h).send({ typeId: ctx.ext, title: 'X', contentKind: 'file', origin: 'external' }).expect(400);
    expect(JSON.stringify(bad.body)).toMatch(/names who issues it/);
    await api().post('/api/v1/documents').set(h).send({ typeId: ctx.sop, title: 'X', contentKind: 'file', issuer: 'Acme' }).expect(400);
    const created = await api()
      .post('/api/v1/documents')
      .set(h)
      .send({ typeId: ctx.ext, title: 'Acme customer specification', contentKind: 'file', origin: 'external', issuer: 'Acme Ltd', externalReference: 'ACS-1001' })
      .expect(201);
    expect(created.body).toMatchObject({ number: 'EXT-001', origin: 'external', issuer: 'Acme Ltd', externalReference: 'ACS-1001', contentKind: 'file' });
    ctx.doc = created.body.id;
    ctx.rev = created.body.revisions[0].id;
    const draft = await api().get(`/api/v1/document-revisions/${ctx.rev}`).set(h).expect(200);
    expect(draft.body).toMatchObject({ problems: ['Upload the main file'], canRecordIssue: true, issuerRevision: null });
    const changed = await api().patch(`/api/v1/documents/${ctx.doc}`).set(h).send({ externalReference: 'ACS-1001/B', title: 'Acme specification' }).expect(200);
    expect(changed.body).toMatchObject({ externalReference: 'ACS-1001/B', title: 'Acme specification' });
  });

  it('records an issue: our letter, their revision, in force from the date given', async () => {
    ctx.file = await addMain(ctx.rev, 'acs.pdf', await pdf());
    await api().post(`/api/v1/document-revisions/${ctx.rev}/issue-external`).set(await as(ids.inspectorA)).send({ issuerRevision: 'Issue 3', effectiveFrom: day() }).expect(403);
    await api().post(`/api/v1/document-revisions/${ctx.rev}/submit`).set(await as(ids.ownerA)).expect(409);
    const issued = await api().post(`/api/v1/document-revisions/${ctx.rev}/issue-external`).set(await as(ids.ownerA)).send({ issuerRevision: 'Issue 3', effectiveFrom: day(-30) }).expect(200);
    expect(issued.body).toMatchObject({ status: 'effective', letter: 'A', issuerRevision: 'Issue 3', effectiveFrom: day(-30), canRecordIssue: false });
    const doc = await api().get(`/api/v1/documents/${ctx.doc}`).set(await as(ids.ownerA)).expect(200);
    expect(doc.body).toMatchObject({ status: 'active', currentRevision: { letter: 'A' } });
    expect(doc.body.revisions[0]).toMatchObject({ letter: 'A', issuerRevision: 'Issue 3' });
  });

  it('refuses an internal document', async () => {
    const h = await as(ids.ownerA);
    const internal = await api().post('/api/v1/documents').set(h).send({ typeId: ctx.sop, title: 'Inspection', contentKind: 'file' }).expect(201);
    ctx.internalRev = internal.body.revisions[0].id;
    ctx.internalFile = await addMain(ctx.internalRev, 'draft.pdf', await pdf(1));
    const res = await api().post(`/api/v1/document-revisions/${ctx.internalRev}/issue-external`).set(h).send({ issuerRevision: '1', effectiveFrom: day() }).expect(409);
    expect(res.body.error).toMatchObject({ code: 'document_rule' });
    await api().patch(`/api/v1/documents/${internal.body.id}`).set(h).send({ issuer: 'Acme' }).expect(409);
  });
});

describe('controlled copies', () => {
  it('stamps every page of the PDF in force as a controlled copy', async () => {
    const res = await api().get(`/api/v1/document-files/${ctx.file}/controlled-copy`).set(await as(ids.inspectorA)).buffer(true).parse(binary).expect(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['cache-control']).toBe('no-store');
    const read = await PDFDocument.load(res.body as Buffer);
    expect(read.getPageCount()).toBe(2);
    expect(read.getSubject()).toBe('CONTROLLED COPY - EXT-001 rev A (Issue 3)');
  });

  it('marks a draft not for use, refuses other files and other organisations', async () => {
    const draft = await api().get(`/api/v1/document-files/${ctx.internalFile}/controlled-copy`).set(await as(ids.ownerA)).buffer(true).parse(binary).expect(200);
    expect((await PDFDocument.load(draft.body as Buffer)).getSubject()).toBe('NOT ISSUED - NOT FOR USE - SOP-001 draft');
    // The inspector cannot see someone else's draft.
    await api().get(`/api/v1/document-files/${ctx.internalFile}/controlled-copy`).set(await as(ids.inspectorA)).expect(404);
    const word = await addMain(ctx.internalRev, 'notes.docx', new TextEncoder().encode('x'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const refused = await api().get(`/api/v1/document-files/${word}/controlled-copy`).set(await as(ids.ownerA)).expect(409);
    expect(refused.body.error.message).toMatch(/Only a PDF/);
    const broken = await addMain(ctx.internalRev, 'broken.pdf', new TextEncoder().encode('not a pdf'));
    expect((await api().get(`/api/v1/document-files/${broken}/controlled-copy`).set(await as(ids.ownerA)).expect(409)).body.error.message).toMatch(/cannot be stamped/);
    await api().get(`/api/v1/document-files/${ctx.file}/controlled-copy`).set(await as(ids.ownerB, ids.orgB)).expect(404);
  });
});

describe('dashboard', () => {
  it('counts documents in force, external ones and drafts, and lists activity', async () => {
    const res = await api().get(`/api/v1/documents-dashboard?from=${day(-60)}&to=${day()}`).set(await as(ids.ownerA)).expect(200);
    expect(res.body.kpis).toMatchObject({ inForce: 1, external: 1, drafts: 1, madeEffective: 1 });
    expect(res.body.period.bucket).toBe('week');
    expect(res.body.byType).toEqual(expect.arrayContaining([expect.objectContaining({ prefix: 'EXT', inForce: 1 }), expect.objectContaining({ prefix: 'SOP', inProgress: 1 })]));
    expect(res.body.activity.reduce((s: number, a: { effective: number }) => s + a.effective, 0)).toBe(1);
    await api().get(`/api/v1/documents-dashboard?from=${day()}&to=${day(-1)}`).set(await as(ids.ownerA)).expect(400);
    const other = await api().get(`/api/v1/documents-dashboard?from=${day(-60)}&to=${day()}`).set(await as(ids.ownerB, ids.orgB)).expect(200);
    expect(other.body.kpis.inForce).toBe(0);
  });
});
