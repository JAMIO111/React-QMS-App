/**
 * Supplier quality SQ2a through the API: documents (versions, verification, removal), certifications (renewal, verification, withdrawal), the expiry state worked out on
 * read, the expiry watchlist, permissions and isolation. Expiry never changes a supplier's approval status.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('f7');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const owner = () => as(ids.ownerA);
const reader = () => as(ids.inspectorA);
const other = () => as(ids.ownerB, ids.orgB);
const ctx: Record<string, string> = {};
const base = '/api/v1/supplier-quality';
const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-sqc');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await owner();
  ctx.s1 = (await api().post(`${base}/suppliers`).set(h).send({ code: 'ACME', name: 'Acme Metals' }).expect(201)).body.id;
  ctx.s2 = (await api().post(`${base}/suppliers`).set(h).send({ code: 'BOLT', name: 'Bolt Co' }).expect(201)).body.id;
  ctx.sb = (await api().post(`${base}/suppliers`).set(await other()).send({ code: 'BETA', name: 'Beta Ltd' }).expect(201)).body.id;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

const path = (supplier: string, name: string) => `${ids.orgA}/supplier/${supplier}/${name}`;
const doc = (over: Record<string, unknown> = {}) => ({ docType: 'quality_manual', title: 'Quality manual', revision: 'A', storagePath: path(ctx.s1, `m-${Math.random()}.pdf`), fileName: 'manual.pdf', contentType: 'application/pdf', sizeBytes: 1000, ...over });

describe('documents', () => {
  it('records a document, edits it until verified, then freezes it', async () => {
    const h = await owner();
    const res = await api().post(`${base}/suppliers/${ctx.s1}/documents`).set(h).send(doc({ expiresOn: day(20), documentDate: day(-10) })).expect(201);
    ctx.d1 = res.body.id;
    expect(res.body).toMatchObject({ status: 'current', title: 'Quality manual', revision: 'A', verification: null, expiry: { state: 'expiring', daysLeft: 20 }, createdBy: { id: ids.ownerA } });
    const edited = (await api().patch(`${base}/supplier-documents/${ctx.d1}`).set(h).send({ revision: 'B', notes: 'Scanned' }).expect(200)).body;
    expect(edited).toMatchObject({ revision: 'B', notes: 'Scanned' });
    await api().patch(`${base}/supplier-documents/${ctx.d1}`).set(h).send({}).expect(400);
    const verified = (await api().post(`${base}/supplier-documents/${ctx.d1}/verify`).set(h).send({ note: 'Checked against the original' }).expect(200)).body;
    expect(verified.verification).toMatchObject({ by: { id: ids.ownerA }, note: 'Checked against the original' });
    const frozen = await api().patch(`${base}/supplier-documents/${ctx.d1}`).set(h).send({ title: 'Changed' });
    expect(frozen.status).toBe(409);
    expect(frozen.body.error.code).toBe('supplier_rule');
    expect((await api().post(`${base}/supplier-documents/${ctx.d1}/verify`).set(h).send({})).status).toBe(409);
  });

  it('refuses a bad type, a file in another supplier\'s folder and impossible dates', async () => {
    const h = await owner();
    await api().post(`${base}/suppliers/${ctx.s1}/documents`).set(h).send(doc({ docType: 'wizardry' })).expect(400);
    await api().post(`${base}/suppliers/${ctx.s1}/documents`).set(h).send(doc({ unexpected: true })).expect(400);
    expect((await api().post(`${base}/suppliers/${ctx.s1}/documents`).set(h).send(doc({ storagePath: path(ctx.s2, 'x.pdf') }))).status).toBeGreaterThanOrEqual(400);
    const late = await api().post(`${base}/suppliers/${ctx.s1}/documents`).set(h).send(doc({ documentDate: day(0), expiresOn: day(-1) }));
    expect(late.status).toBe(409);
  });

  it('a new version replaces the current one, which stays as superseded', async () => {
    const h = await owner();
    const v2 = (await api().post(`${base}/suppliers/${ctx.s1}/documents`).set(h).send(doc({ revision: 'C', replacesId: ctx.d1, expiresOn: day(300) })).expect(201)).body;
    ctx.d2 = v2.id;
    expect(v2).toMatchObject({ replacesId: ctx.d1, expiry: { state: 'valid' } });
    const list = (await api().get(`${base}/suppliers/${ctx.s1}/documents`).set(h).expect(200)).body.data;
    expect(list.map((d: { id: string; status: string }) => [d.id, d.status])).toEqual([[ctx.d2, 'current'], [ctx.d1, 'superseded']]);
    expect(list[1].expiry).toEqual({ state: 'no_expiry', daysLeft: null }); // a superseded document is not in force
    expect((await api().post(`${base}/suppliers/${ctx.s1}/documents`).set(h).send(doc({ replacesId: ctx.d1 }))).status).toBe(409);
  });

  it('is removed with a reason and stays on record', async () => {
    const h = await owner();
    const d = (await api().post(`${base}/suppliers/${ctx.s1}/documents`).set(h).send(doc({ title: 'Wrong file' })).expect(201)).body;
    await api().post(`${base}/supplier-documents/${d.id}/remove`).set(h).send({ reason: 'x' }).expect(400);
    const removed = (await api().post(`${base}/supplier-documents/${d.id}/remove`).set(h).send({ reason: 'Uploaded in error' }).expect(200)).body;
    expect(removed).toMatchObject({ status: 'removed', removal: { reason: 'Uploaded in error', by: { id: ids.ownerA } } });
    const list = (await api().get(`${base}/suppliers/${ctx.s1}/documents`).set(h).expect(200)).body.data;
    expect(list.find((x: { id: string }) => x.id === d.id).status).toBe('removed');
  });
});

describe('certifications', () => {
  it('adds a certification with an evidence document and works out its expiry state', async () => {
    const h = await owner();
    const res = await api().post(`${base}/suppliers/${ctx.s1}/certifications`).set(h).send({
      certType: 'iso_9001', certificateNumber: 'Q-123', issuingBody: 'BSI', scope: 'Machining', issuedOn: day(-300), expiresOn: day(30), documentId: ctx.d2,
    }).expect(201);
    ctx.c1 = res.body.id;
    expect(res.body).toMatchObject({ status: 'current', certificateNumber: 'Q-123', expiry: { state: 'expiring', daysLeft: 30 }, document: { id: ctx.d2, fileName: 'manual.pdf' }, verification: null });
    const far = (await api().post(`${base}/suppliers/${ctx.s2}/certifications`).set(h).send({ certType: 'as9100', certificateNumber: 'A-1', issuingBody: 'DNV', expiresOn: day(400) }).expect(201)).body;
    expect(far.expiry.state).toBe('valid');
    const none = (await api().post(`${base}/suppliers/${ctx.s2}/certifications`).set(h).send({ certType: 'rohs_reach', certificateNumber: 'R-1', issuingBody: 'Lab' }).expect(201)).body;
    expect(none.expiry).toEqual({ state: 'no_expiry', daysLeft: null });
    await api().post(`${base}/suppliers/${ctx.s1}/certifications`).set(h).send({ certType: 'nonsense', certificateNumber: 'X', issuingBody: 'Y' }).expect(400);
    await api().post(`${base}/suppliers/${ctx.s1}/certifications`).set(h).send({ certType: 'iso_9001', issuingBody: 'Y' }).expect(400);
    expect((await api().post(`${base}/suppliers/${ctx.s1}/certifications`).set(h).send({ certType: 'iso_9001', certificateNumber: 'X', issuingBody: 'Y', issuedOn: day(0), expiresOn: day(-5) })).status).toBe(409);
    expect((await api().post(`${base}/suppliers/${ctx.s1}/certifications`).set(h).send({ certType: 'iso_9001', certificateNumber: 'X', issuingBody: 'Y', documentId: ctx.d1 })).status).toBe(409); // superseded evidence
  });

  it('is edited until verified, verified once, then renewed rather than changed', async () => {
    const h = await owner();
    expect((await api().patch(`${base}/supplier-certifications/${ctx.c1}`).set(h).send({ scope: 'CNC machining and finishing' }).expect(200)).body.scope).toBe('CNC machining and finishing');
    const v = (await api().post(`${base}/supplier-certifications/${ctx.c1}/verify`).set(h).send({ note: 'Register checked' }).expect(200)).body;
    expect(v.verification).toMatchObject({ by: { id: ids.ownerA }, note: 'Register checked' });
    expect((await api().patch(`${base}/supplier-certifications/${ctx.c1}`).set(h).send({ scope: 'x' })).status).toBe(409);
    const renewed = (await api().post(`${base}/supplier-certifications/${ctx.c1}/renew`).set(h).send({ certificateNumber: 'Q-456', issuingBody: 'BSI', issuedOn: day(0), expiresOn: day(1095) }).expect(201)).body;
    ctx.c2 = renewed.id;
    expect(renewed).toMatchObject({ certType: 'iso_9001', replacesId: ctx.c1, status: 'current', verification: null, expiry: { state: 'valid' } });
    const list = (await api().get(`${base}/suppliers/${ctx.s1}/certifications`).set(h).expect(200)).body.data;
    expect(list.map((c: { id: string; status: string }) => [c.id, c.status])).toEqual([[ctx.c2, 'current'], [ctx.c1, 'superseded']]);
    expect((await api().post(`${base}/supplier-certifications/${ctx.c1}/renew`).set(h).send({ certificateNumber: 'Q-9', issuingBody: 'BSI' })).status).toBe(409);
  });

  it('is withdrawn with a reason and a document that is its evidence cannot be removed meanwhile', async () => {
    const h = await owner();
    const c = (await api().post(`${base}/suppliers/${ctx.s1}/certifications`).set(h).send({ certType: 'iso_14001', certificateNumber: 'E-1', issuingBody: 'BSI', documentId: ctx.d2 }).expect(201)).body;
    expect((await api().post(`${base}/supplier-documents/${ctx.d2}/remove`).set(h).send({ reason: 'Not needed any more' })).status).toBe(409);
    await api().post(`${base}/supplier-certifications/${c.id}/withdraw`).set(h).send({ reason: '' }).expect(400);
    const w = (await api().post(`${base}/supplier-certifications/${c.id}/withdraw`).set(h).send({ reason: 'Suspended by the body' }).expect(200)).body;
    expect(w).toMatchObject({ status: 'withdrawn', withdrawal: { reason: 'Suspended by the body' } });
  });
});

describe('the expiry watchlist', () => {
  it('lists current records that expired or expire soon, soonest first, and never changes a supplier\'s status', async () => {
    const h = await owner();
    const expired = (await api().post(`${base}/suppliers/${ctx.s2}/certifications`).set(h).send({ certType: 'nadcap', certificateNumber: 'N-1', issuingBody: 'PRI', issuedOn: day(-400), expiresOn: day(-2) }).expect(201)).body;
    const res = (await api().get(`${base}/expiry-watchlist`).set(h).expect(200)).body;
    expect(res.days).toBe(60);
    const keys = res.data.map((i: { kind: string; id: string }) => `${i.kind}:${i.id}`);
    expect(keys).toContain(`certification:${expired.id}`);
    const soon = (await api().post(`${base}/suppliers/${ctx.s1}/documents`).set(h).send(doc({ title: 'Insurance certificate', docType: 'insurance', expiresOn: day(10) })).expect(201)).body;
    expect((await api().get(`${base}/expiry-watchlist`).set(h).expect(200)).body.data.map((i: { kind: string; id: string }) => `${i.kind}:${i.id}`)).toContain(`document:${soon.id}`);
    expect(res.data[0]).toMatchObject({ id: expired.id, state: 'expired', daysLeft: -2, supplier: { code: 'BOLT' } });
    const days = res.data.map((i: { daysLeft: number }) => i.daysLeft);
    expect(days).toEqual([...days].sort((a, b) => a - b));
    expect(res.counts.expired).toBeGreaterThanOrEqual(1);
    // Superseded, withdrawn and removed records and records beyond the window are not listed.
    expect(keys).not.toContain(`certification:${ctx.c1}`);
    expect(keys).not.toContain(`document:${ctx.d1}`);
    const narrow = (await api().get(`${base}/expiry-watchlist?days=5`).set(h).expect(200)).body;
    expect(narrow.data.every((i: { daysLeft: number }) => i.daysLeft <= 5)).toBe(true);
    expect((await api().get(`${base}/expiry-watchlist?kind=document`).set(h).expect(200)).body.data.every((i: { kind: string }) => i.kind === 'document')).toBe(true);
    await api().get(`${base}/expiry-watchlist?days=0`).set(h).expect(400);
    // A certification expired for supplier BOLT does not touch its approval status.
    expect((await api().get(`${base}/suppliers/${ctx.s2}`).set(h).expect(200)).body.approvalStatus).toBe('pending_approval');
  });
});

describe('permissions and isolation', () => {
  it('a reader sees everything but changes nothing', async () => {
    const r = await reader();
    expect((await api().get(`${base}/suppliers/${ctx.s1}/documents`).set(r).expect(200)).body.data.length).toBeGreaterThan(0);
    expect((await api().get(`${base}/suppliers/${ctx.s1}/certifications`).set(r).expect(200)).body.data.length).toBeGreaterThan(0);
    await api().get(`${base}/expiry-watchlist`).set(r).expect(200);
    await api().post(`${base}/suppliers/${ctx.s1}/documents`).set(r).send(doc()).expect(403);
    await api().post(`${base}/suppliers/${ctx.s1}/certifications`).set(r).send({ certType: 'iso_9001', certificateNumber: 'R-1', issuingBody: 'x' }).expect(403);
    await api().post(`${base}/supplier-certifications/${ctx.c2}/verify`).set(r).send({}).expect(403);
    await api().post(`${base}/supplier-documents/${ctx.d2}/remove`).set(r).send({ reason: 'Because I can' }).expect(403);
  });

  it('another organisation sees and changes nothing', async () => {
    const o = await other();
    await api().get(`${base}/suppliers/${ctx.s1}/documents`).set(o).expect(404);
    await api().get(`${base}/suppliers/${ctx.s1}/certifications`).set(o).expect(404);
    await api().post(`${base}/suppliers/${ctx.s1}/certifications`).set(o).send({ certType: 'iso_9001', certificateNumber: 'H-1', issuingBody: 'x' }).expect(404);
    await api().post(`${base}/supplier-certifications/${ctx.c2}/withdraw`).set(o).send({ reason: 'Hijacked' }).expect(404);
    await api().post(`${base}/supplier-documents/${ctx.d2}/verify`).set(o).send({}).expect(404);
    expect((await api().get(`${base}/expiry-watchlist?days=365`).set(o).expect(200)).body.data).toEqual([]);
  });
});
