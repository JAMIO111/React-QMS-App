/**
 * Document control (DC1) through the API: types, numbering, documents with a first draft, text bodies, files, who sees drafts.
 * The rules are in supabase/tests/document_control_core.test.sql; this checks the routes, permissions, the shape of the answers and that errors reach the caller in words.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('d1c');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};
const BODY = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Purpose' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Quarantine suspect parts at once.' }] },
  ],
};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-dc');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('document types', () => {
  it('lists the seeded types to readers and lets a manager add and change one', async () => {
    const list = await api().get('/api/v1/document-types').set(await as(ids.inspectorA)).expect(200);
    expect(list.body.data.map((t: { prefix: string }) => t.prefix)).toEqual(['SOP', 'WI', 'FRM', 'SPEC', 'POL', 'EXT']);
    ctx.sop = list.body.data[0].id;
    ctx.frm = list.body.data[2].id;
    await api().post('/api/v1/document-types').set(await as(ids.inspectorA)).send({ name: 'Drawing', prefix: 'DWG' }).expect(403);
    const created = await api().post('/api/v1/document-types').set(await as(ids.ownerA)).send({ name: 'Drawing', prefix: 'dwg', reviewMonths: 60 }).expect(201);
    expect(created.body).toMatchObject({ name: 'Drawing', prefix: 'DWG', reviewMonths: 60, contentHint: 'file', active: true, documents: 0 });
    const clash = await api().post('/api/v1/document-types').set(await as(ids.ownerA)).send({ name: 'Other', prefix: 'SOP' }).expect(409);
    expect(clash.body.error).toMatchObject({ code: 'document_rule' });
    expect(clash.body.error.message).toMatch(/prefix SOP/);
    await api().post('/api/v1/document-types').set(await as(ids.ownerA)).send({ name: 'Bad', prefix: '-X' }).expect(400);
    const off = await api().patch(`/api/v1/document-types/${created.body.id}`).set(await as(ids.ownerA)).send({ active: false }).expect(200);
    expect(off.body.active).toBe(false);
    const all = await api().get('/api/v1/document-types?all=true').set(await as(ids.ownerA)).expect(200);
    expect(all.body.data).toHaveLength(7);
  });
});

describe('documents and drafts', () => {
  it('creates a numbered text document with its first draft', async () => {
    const res = await api().post('/api/v1/documents').set(await as(ids.ownerA)).send({ typeId: ctx.sop, title: 'Control of nonconforming product', contentKind: 'text' }).expect(201);
    ctx.doc = res.body.id;
    expect(res.body).toMatchObject({
      number: 'SOP-001', status: 'draft', contentKind: 'text', type: { prefix: 'SOP', name: 'Procedure' }, owner: { id: ids.ownerA }, nextLetter: 'A', canManage: true,
    });
    expect(res.body.revisions).toHaveLength(1);
    expect(res.body.inProgress).toMatchObject({ status: 'draft', sequence: 1 });
    ctx.rev = res.body.revisions[0].id;
  });

  it('brings an existing document across with its number and letter, and numbers past it', async () => {
    const h = await as(ids.ownerA);
    const typed = await api().post('/api/v1/documents').set(h).send({ typeId: ctx.sop, title: 'Calibration', contentKind: 'file', number: 'SOP-010', startLetter: 'd' }).expect(201);
    expect(typed.body).toMatchObject({ number: 'SOP-010', startLetter: 'D', numberTyped: true, nextLetter: 'D' });
    ctx.fileDoc = typed.body.id;
    ctx.fileRev = typed.body.revisions[0].id;
    const next = await api().post('/api/v1/documents').set(h).send({ typeId: ctx.sop, title: 'Purchasing', contentKind: 'text' }).expect(201);
    expect(next.body.number).toBe('SOP-011');
    await api().post('/api/v1/documents').set(h).send({ typeId: ctx.sop, title: 'X', contentKind: 'file', number: 'OLD-1' }).expect(400);
    const dup = await api().post('/api/v1/documents').set(h).send({ typeId: ctx.sop, title: 'X', contentKind: 'file', number: 'sop-001', startLetter: 'A' }).expect(409);
    expect(dup.body.error.message).toMatch(/already exists/);
    await api().post('/api/v1/documents').set(await as(ids.inspectorA)).send({ typeId: ctx.sop, title: 'X', contentKind: 'text' }).expect(403);
  });

  it('saves a text body and a change summary on a draft, and refuses what does not fit', async () => {
    const h = await as(ids.ownerA);
    const res = await api().patch(`/api/v1/document-revisions/${ctx.rev}`).set(h).send({ changeSummary: 'First issue', body: BODY }).expect(200);
    expect(res.body).toMatchObject({ status: 'draft', letter: null, plannedLetter: 'A', changeSummary: 'First issue', canEdit: true, document: { number: 'SOP-001' } });
    expect(res.body.body).toEqual(BODY);
    await api().patch(`/api/v1/document-revisions/${ctx.rev}`).set(h).send({ body: '<p>x</p>' }).expect(400);
    const onFile = await api().patch(`/api/v1/document-revisions/${ctx.fileRev}`).set(h).send({ body: BODY }).expect(409);
    expect(onFile.body.error.message).toMatch(/file document/);
    const found = await api().get('/api/v1/documents?q=quarantine').set(h).expect(200);
    expect(found.body.data.map((d: { number: string }) => d.number)).toEqual(['SOP-001']);
  });

  it('records files on a file draft; a new main file replaces the old one; removing needs a reason', async () => {
    const h = await as(ids.ownerA);
    const path = (name: string) => `${ids.orgA}/document/${ctx.fileRev}/${name}`;
    await api().post(`/api/v1/document-revisions/${ctx.fileRev}/files`).set(h).send({ role: 'main', storagePath: path('a-cal.docx'), fileName: 'cal.docx', sizeBytes: 100 }).expect(201);
    const second = await api().post(`/api/v1/document-revisions/${ctx.fileRev}/files`).set(h).send({ role: 'main', storagePath: path('b-cal.pdf'), fileName: 'cal.pdf', contentType: 'application/pdf', sizeBytes: 100 }).expect(201);
    const mains = second.body.files.filter((f: { role: string }) => f.role === 'main');
    expect(mains.map((f: { fileName: string; deletedAt: string | null }) => [f.fileName, f.deletedAt === null])).toEqual([['cal.docx', false], ['cal.pdf', true]]);
    expect(mains.find((f: { fileName: string }) => f.fileName === 'cal.docx').deleteReason).toBe('Replaced by cal.pdf');
    const att = await api().post(`/api/v1/document-revisions/${ctx.fileRev}/files`).set(h).send({ storagePath: path('c-src.xlsx'), fileName: 'src.xlsx', sizeBytes: 5 }).expect(201);
    const attachment = att.body.files.find((f: { fileName: string }) => f.fileName === 'src.xlsx');
    expect(attachment.role).toBe('attachment');
    const wrong = await api().post(`/api/v1/document-revisions/${ctx.fileRev}/files`).set(h).send({ storagePath: `${ids.orgA}/document/${ctx.rev}/x.pdf`, fileName: 'x.pdf', sizeBytes: 1 }).expect(409);
    expect(wrong.body.error.message).toMatch(/folder/);
    await api().post(`/api/v1/document-files/${attachment.id}/delete`).set(h).send({ reason: 'no' }).expect(400);
    const removed = await api().post(`/api/v1/document-files/${attachment.id}/delete`).set(h).send({ reason: 'Wrong file' }).expect(200);
    expect(removed.body.files.find((f: { id: string }) => f.id === attachment.id).deleteReason).toBe('Wrong file');
    const back = await api().post(`/api/v1/document-files/${attachment.id}/restore`).set(h).expect(200);
    expect(back.body.files.find((f: { id: string }) => f.id === attachment.id).deletedAt).toBeNull();
    const listed = await api().get(`/api/v1/document-revisions/${ctx.fileRev}/files`).set(h).expect(200);
    expect(listed.body.data).toHaveLength(3);
    const byFile = await api().get('/api/v1/documents?q=src.xlsx').set(h).expect(200);
    expect(byFile.body.data.map((d: { number: string }) => d.number)).toEqual(['SOP-010']);
  });

  it('keeps drafts from readers who are not their author or owner', async () => {
    const h = await as(ids.inspectorA);
    const list = await api().get('/api/v1/documents').set(h).expect(200);
    expect(list.body.total).toBe(0);
    await api().get(`/api/v1/documents/${ctx.doc}`).set(h).expect(404);
    await api().get(`/api/v1/document-revisions/${ctx.rev}`).set(h).expect(404);
    await api().get(`/api/v1/documents/${ctx.doc}`).set(await as(ids.ownerB, ids.orgB)).expect(404);
  });

  it('edits the header and filters the register', async () => {
    const h = await as(ids.ownerA);
    const res = await api().patch(`/api/v1/documents/${ctx.doc}`).set(h).send({ title: 'Nonconforming product', description: 'All sites' }).expect(200);
    expect(res.body).toMatchObject({ title: 'Nonconforming product', description: 'All sites' });
    await api().patch(`/api/v1/documents/${ctx.doc}`).set(h).send({ contentKind: 'file' }).expect(400);
    const notMember = await api().patch(`/api/v1/documents/${ctx.doc}`).set(h).send({ ownerId: ids.outsider }).expect(409);
    expect(notMember.body.error.message).toMatch(/active member/);
    const files = await api().get('/api/v1/documents?kind=file').set(h).expect(200);
    expect(files.body.data.map((d: { number: string }) => d.number)).toEqual(['SOP-010']);
    const sorted = await api().get('/api/v1/documents?sort=title&order=desc').set(h).expect(200);
    expect(sorted.body.data.map((d: { title: string }) => d.title)).toEqual(['Purchasing', 'Nonconforming product', 'Calibration']);
    const mine = await api().get('/api/v1/documents?owner=me').set(h).expect(200);
    expect(mine.body.total).toBe(3);
    await api().get('/api/v1/documents?status=nope').set(h).expect(400);
  });

  it('discards a draft with a reason, which discards a document never in force', async () => {
    const h = await as(ids.ownerA);
    const doc = await api().post('/api/v1/documents').set(h).send({ typeId: ctx.frm, title: 'Old form', contentKind: 'file' }).expect(201);
    await api().post(`/api/v1/document-revisions/${doc.body.revisions[0].id}/discard`).set(h).send({ reason: 'x' }).expect(400);
    const res = await api().post(`/api/v1/document-revisions/${doc.body.revisions[0].id}/discard`).set(h).send({ reason: 'Not needed' }).expect(200);
    expect(res.body).toMatchObject({ status: 'discarded', discardReason: 'Not needed', canEdit: false, document: { status: 'discarded', canManage: false } });
    const again = await api().patch(`/api/v1/document-revisions/${doc.body.revisions[0].id}`).set(h).send({ changeSummary: 'x' }).expect(409);
    expect(again.body.error.code).toBe('document_rule');
    const list = await api().get('/api/v1/documents').set(h).expect(200);
    expect(list.body.data.map((d: { number: string }) => d.number)).not.toContain('FRM-001');
    const discarded = await api().get('/api/v1/documents?status=discarded').set(h).expect(200);
    expect(discarded.body.data.map((d: { number: string }) => d.number)).toEqual(['FRM-001']);
  });
});
