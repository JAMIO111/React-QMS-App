/**
 * Part approval packages received from a supplier, as the supplier profile, the expiry watchlist and the inspection recommendation show them (PP5c). Information only: nothing here
 * changes a supplier's status or an inspection requirement. The rules for the packages themselves are in supabase/tests/ppap_received.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('f5c');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};
const day = (offset = 0) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

/** A received package taken to "ready": the supplier's warrant as a file is all level 1 asks for. */
const ready = async (partId: string, supplierId = ctx.supplier) => {
  const h = await as(ids.ownerA);
  const made = (await api().post('/api/v1/ppaps').set(h).send({ partId, direction: 'received', supplierId, reason: 'new_part', level: 1 }).expect(201)).body;
  const warrant = made.elements.find((e: { key: string }) => e.key === 'part_submission_warrant');
  await api().post(`/api/v1/ppap-elements/${warrant.id}/files`).set(h).send({ storagePath: `${ids.orgA}/ppap/${made.id}/w.pdf`, fileName: 'w.pdf', sizeBytes: 100 }).expect(201);
  await api().patch(`/api/v1/ppap-elements/${warrant.id}`).set(h).send({ status: 'ready' }).expect(200);
  await api().post(`/api/v1/ppaps/${made.id}/ready`).set(h).expect(200);
  return made.id as string;
};
const sent = async (id: string, sentOn = day(-10)) => api().post(`/api/v1/ppaps/${id}/submit`).set(await as(ids.ownerA)).send({ sentOn, how: 'Emailed' }).expect(200);

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-sppap');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA);
  ctx.supplier = (await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'SP-S1', 'Acme Castings') returning id`, [ids.orgA])).rows[0].id;
  ctx.quiet = (await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'SP-S2', 'Quiet Metals') returning id`, [ids.orgA])).rows[0].id;
  for (const n of ['SP-A', 'SP-B', 'SP-C', 'SP-D']) {
    const part = (await api().post('/api/v1/parts').set(h).send({ partNumber: n, name: `Part ${n}`, initialRevision: { revision: 'A' } }).expect(201)).body;
    ctx[n] = part.id;
    await api().post(`/api/v1/part-revisions/${part.revisions[0].id}/release`).set(h).expect(200);
  }
  // A approved; B interim, still valid for ten days; C only being prepared; D interim that ran out yesterday.
  const a = await ready(ctx['SP-A']);
  await sent(a);
  await api().post(`/api/v1/ppaps/${a}/decisions`).set(h).send({ kind: 'approved', decidedOn: day(-5) }).expect(200);
  const b = await ready(ctx['SP-B']);
  await sent(b);
  await api().post(`/api/v1/ppaps/${b}/decisions`).set(h).send({ kind: 'interim_approved', decidedOn: day(-3), expiresOn: day(10), note: 'Dimensional results to follow' }).expect(200);
  ctx.b = b;
  ctx.c = (await api().post('/api/v1/ppaps').set(h).send({ partId: ctx['SP-C'], direction: 'received', supplierId: ctx.supplier, reason: 'new_part', level: 1 }).expect(201)).body.id;
  const d = await ready(ctx['SP-D']);
  await sent(d, day(-20));
  await api().post(`/api/v1/ppaps/${d}/decisions`).set(h).send({ kind: 'interim_approved', decidedOn: day(-15), expiresOn: day(-1), note: 'Run for a month' }).expect(200);
  ctx.d = d;
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('the supplier profile PPAP tab', () => {
  it('gives each part its state, newest package first decides, and counts them', async () => {
    const r = (await api().get(`/api/v1/supplier-quality/suppliers/${ctx.supplier}/ppap`).set(await as(ids.ownerA)).expect(200)).body;
    expect(r.available).toBe(true);
    expect(Object.fromEntries(r.data.map((x: { partNumber: string; state: string }) => [x.partNumber, x.state]))).toEqual({
      'SP-A': 'approved', 'SP-B': 'interim', 'SP-C': 'in_preparation', 'SP-D': 'interim_lapsed',
    });
    expect(r.counts).toEqual({ approved: 1, interim: 1, notApproved: 2 });
    const b = r.data.find((x: { partNumber: string }) => x.partNumber === 'SP-B');
    expect(b).toMatchObject({ interimExpiresOn: day(10), submissionId: ctx.b, status: 'interim_approved' });
    expect(r.data.find((x: { partNumber: string }) => x.partNumber === 'SP-A').nextReviewOn).toBeTruthy();
  });

  it('shows a supplier with no packages as empty, and leaves another organisation out', async () => {
    const r = (await api().get(`/api/v1/supplier-quality/suppliers/${ctx.quiet}/ppap`).set(await as(ids.ownerA)).expect(200)).body;
    expect(r).toMatchObject({ available: true, data: [], counts: { approved: 0, interim: 0, notApproved: 0 } });
    await api().get(`/api/v1/supplier-quality/suppliers/${ctx.supplier}/ppap`).set(await as(ids.ownerB, ids.orgB)).expect(404);
  });

  it('lets a later package decide: revalidating an approved part leaves it not approved until the new one is', async () => {
    const h = await as(ids.ownerA);
    ctx.third = (await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'SP-S3', 'Third Foundry') returning id`, [ids.orgA])).rows[0].id;
    const part = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'SP-F', name: 'Part F', initialRevision: { revision: 'A' } }).expect(201)).body;
    await api().post(`/api/v1/part-revisions/${part.revisions[0].id}/release`).set(h).expect(200);
    const f = await ready(part.id, ctx.third);
    await sent(f);
    await api().post(`/api/v1/ppaps/${f}/decisions`).set(h).send({ kind: 'approved', decidedOn: day(-5) }).expect(200);
    const before = (await api().get(`/api/v1/supplier-quality/suppliers/${ctx.third}/ppap`).set(h).expect(200)).body;
    expect(before.data[0].state).toBe('approved');
    const again = (await api().post(`/api/v1/ppaps/${f}/resubmission`).set(h).send({ reason: 'process_change' }).expect(201)).body;
    const r = (await api().get(`/api/v1/supplier-quality/suppliers/${ctx.third}/ppap`).set(h).expect(200)).body;
    expect(r.data).toHaveLength(1);
    expect(r.data[0]).toMatchObject({ submissionId: again.id, state: 'in_preparation' });
    expect(r.counts).toEqual({ approved: 0, interim: 0, notApproved: 1 });
  });
});

describe('the expiry watchlist line for interim approvals', () => {
  it('lists interim approvals that ran out or run out soon, never approved ones', async () => {
    const h = await as(ids.ownerA);
    const r = (await api().get('/api/v1/supplier-quality/expiry-watchlist?days=30').set(h).expect(200)).body;
    const ppap = r.data.filter((i: { kind: string }) => i.kind === 'ppap');
    // D ran out yesterday (listed first, as expired) and B has ten days left; A is approved and never appears.
    expect(ppap.map((i: { id: string }) => i.id)).toEqual([ctx.d, ctx.b]);
    expect(ppap[0]).toMatchObject({ state: 'expired', daysLeft: -1, expiresOn: day(-1) });
    expect(ppap[1]).toMatchObject({ state: 'expiring', daysLeft: 10, expiresOn: day(10), supplier: { name: 'Acme Castings' }, detail: 'Interim part approval' });
    expect(ppap[1].title).toContain('SP-B');
    expect(ppap[0].title).toContain('SP-D');
  });

  it('does not list one beyond the window (an expired one is always listed), and the kind filter keeps it apart from certificates and documents', async () => {
    const h = await as(ids.ownerA);
    const narrow = (await api().get('/api/v1/supplier-quality/expiry-watchlist?days=5').set(h).expect(200)).body;
    expect(narrow.data.filter((i: { kind: string }) => i.kind === 'ppap').map((i: { id: string }) => i.id)).toEqual([ctx.d]);
    const only = (await api().get('/api/v1/supplier-quality/expiry-watchlist?days=30&kind=ppap').set(h).expect(200)).body;
    expect(only.data.every((i: { kind: string }) => i.kind === 'ppap')).toBe(true);
    const certs = (await api().get('/api/v1/supplier-quality/expiry-watchlist?days=30&kind=certification').set(h).expect(200)).body;
    expect(certs.data.some((i: { kind: string }) => i.kind === 'ppap')).toBe(false);
  });

  it('counts a lapsed interim approval as expired', async () => {
    const h = await as(ids.ownerA);
    // A second supplier's part on an interim approval that ran out yesterday and was not replaced.
    const part = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'SP-E', name: 'Part E', initialRevision: { revision: 'A' } }).expect(201)).body;
    await api().post(`/api/v1/part-revisions/${part.revisions[0].id}/release`).set(h).expect(200);
    const e = await ready(part.id, ctx.quiet);
    await sent(e, day(-12));
    await api().post(`/api/v1/ppaps/${e}/decisions`).set(h).send({ kind: 'interim_approved', decidedOn: day(-10), expiresOn: day(-1), note: 'Short run' }).expect(200);
    const r = (await api().get('/api/v1/supplier-quality/expiry-watchlist?days=30&kind=ppap').set(h).expect(200)).body;
    const lapsed = r.data.find((i: { id: string }) => i.id === e);
    expect(lapsed).toMatchObject({ state: 'expired', daysLeft: -1 });
    expect(r.counts.expired).toBeGreaterThanOrEqual(1);
  });
});

describe('the inspection recommendation', () => {
  it('suggests increased inspection while a part has no approved package, and names the parts', async () => {
    const h = await as(ids.ownerA);
    const r = (await api().get(`/api/v1/supplier-quality/suppliers/${ctx.supplier}/inspection-recommendation`).set(h).expect(200)).body;
    expect(r.level).toBe('increased');
    const why = r.reasons.find((x: { code: string }) => x.code === 'ppap_not_approved');
    expect(why.message).toContain('SP-C');
    expect(why.message).toContain('SP-D');
    expect(r.basis.ppap).toMatchObject({ available: true, interim: ['SP-B'] });
    expect([...r.basis.ppap.notApproved].sort()).toEqual(['SP-C', 'SP-D']);
  });

  it('only notes an interim approval for a supplier with nothing worse, and changes nothing', async () => {
    const h = await as(ids.ownerA);
    const before = (await admin.query(`select approval_status, risk_rating from public.suppliers where id = $1`, [ctx.supplier])).rows[0];
    // Quiet Metals has one lapsed interim package for SP-E, so it is "not approved" too: end it by withdrawing it, leaving nothing.
    const list = (await api().get(`/api/v1/ppaps?status=all&supplierId=${ctx.quiet}`).set(h).expect(200)).body.data;
    await api().post(`/api/v1/ppaps/${list[0].id}/withdraw`).set(h).send({ reason: 'Recorded against the wrong supplier' }).expect(200);
    const r = (await api().get(`/api/v1/supplier-quality/suppliers/${ctx.quiet}/inspection-recommendation`).set(h).expect(200)).body;
    expect(r.reasons.map((x: { code: string }) => x.code)).not.toContain('ppap_not_approved');
    expect(r.basis.ppap).toEqual({ available: true, notApproved: [], interim: [] });
    const after = (await admin.query(`select approval_status, risk_rating from public.suppliers where id = $1`, [ctx.supplier])).rows[0];
    expect(after).toEqual(before);
  });
});
