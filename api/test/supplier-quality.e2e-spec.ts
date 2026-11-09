/**
 * Supplier quality SQ1 through the API: the register (search, filters, sorting, paging), the profile, a supplier that never starts approved, the approval status and its history,
 * classifications, contacts, products and services, permissions and isolation.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { categoryId, makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('f6');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const owner = () => as(ids.ownerA);
const reader = () => as(ids.inspectorA);
const other = () => as(ids.ownerB, ids.orgB);
const ctx: Record<string, string> = {};
const base = '/api/v1/supplier-quality';

// A second person who may approve: a supplier is approved by one person proposing and another deciding (SQ2c).
const qmId = ids.ownerA.replace(/a1$/, 'a4');
const manager = () => as(qmId);
/** Approve (or conditionally approve) a supplier through a decision: the owner proposes with an exception reason, the quality manager decides. */
const approveVia = async (supplier: string, target: 'approved' | 'conditional', extra: Record<string, unknown> = {}) => {
  const proposed = (await api().post(`${base}/suppliers/${supplier}/approval-decisions`).set(await owner()).send({ target, rationale: 'Approved for the tests', exceptionReason: 'No assessment in this test', ...extra }).expect(201)).body;
  await api().post(`${base}/supplier-approval-decisions/${proposed.id}/decide`).set(await manager()).send({ approve: true, note: 'Agreed' }).expect(200);
};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-sq');
  await admin.query(`insert into auth.users (id, email) values ($1, 'qm@example.test') on conflict do nothing`, [qmId]);
  const mem = await admin.query(`insert into public.organisation_users (organisation_id, user_id, status) values ($1, $2, 'active') returning id`, [ids.orgA, qmId]);
  await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = 'quality_manager'`, [ids.orgA, mem.rows[0].id]);
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await owner();
  ctx.part = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'BAR-50', name: 'Bar stock' }).expect(201)).body.id;
  ctx.partB = (await api().post('/api/v1/parts').set(await other()).send({ partNumber: 'B-1', name: 'Beta part' }).expect(201)).body.id;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('creating and editing a supplier', () => {
  it('starts Pending Approval whatever is sent, with classifications and the new fields', async () => {
    const h = await owner();
    const classes = (await api().get(`${base}/classifications`).set(h).expect(200)).body.data as { id: string; key: string }[];
    expect(classes).toHaveLength(9);
    ctx.welding = classes.find((c) => c.key === 'welding')!.id;
    ctx.heat = classes.find((c) => c.key === 'heat_treatment')!.id;
    const res = await api().post(`${base}/suppliers`).set(h).send({
      code: 'acme', name: 'Acme Metals Ltd', displayName: 'Acme', supplierType: 'subcontractor', country: 'GB', city: 'Sheffield', website: 'https://acme.test',
      purchasingReference: 'V-100', classificationIds: [ctx.welding],
    }).expect(201);
    ctx.s1 = res.body.id;
    expect(res.body).toMatchObject({ code: 'ACME', approvalStatus: 'pending_approval', active: true, riskRating: null, supplierType: 'subcontractor', classifications: [{ id: ctx.welding, label: 'Welding' }] });
    // The client cannot ask for an approved supplier or a risk rating.
    await api().post(`${base}/suppliers`).set(h).send({ code: 'SNEAK', name: 'Sneaky', approvalStatus: 'approved' }).expect(400);
    await api().post(`${base}/suppliers`).set(h).send({ code: 'SNEAK', name: 'Sneaky', riskRating: 'low' }).expect(400);
    await api().post(`${base}/suppliers`).set(h).send({ code: 'ACME', name: 'Duplicate' }).expect(409);
    await api().post(`${base}/suppliers`).set(h).send({ code: 'BAD CODE', name: 'x' }).expect(400);
    await api().post(`${base}/suppliers`).set(h).send({ code: 'CTRY', name: 'x', country: 'gb' }).expect(400);
  });

  it('edits the descriptive fields and the activity flag, not the approval status', async () => {
    const h = await owner();
    const res = await api().patch(`${base}/suppliers/${ctx.s1}`).set(h).send({ city: 'Leeds', phone: '0114 000', active: false }).expect(200);
    expect(res.body).toMatchObject({ city: 'Leeds', phone: '0114 000', active: false, approvalStatus: 'pending_approval' });
    await api().patch(`${base}/suppliers/${ctx.s1}`).set(h).send({ approvalStatus: 'approved' }).expect(400);
    await api().patch(`${base}/suppliers/${ctx.s1}`).set(h).send({}).expect(400);
    await api().patch(`${base}/suppliers/${ctx.s1}`).set(h).send({ active: true }).expect(200);
  });
});

describe('the approval status', () => {
  it('moves only through allowed transitions, with a reason, by someone who may approve, and keeps a history', async () => {
    const h = await owner();
    const url = `${base}/suppliers/${ctx.s1}/status`;
    await api().post(url).set(await reader()).send({ status: 'approved', reason: 'I say so' }).expect(403);
    await api().post(url).set(h).send({ status: 'approved' }).expect(400);
    await api().post(url).set(h).send({ status: 'approved', reason: 'ab' }).expect(400);
    await api().post(url).set(h).send({ status: 'bogus', reason: 'Because' }).expect(400);
    // Approval is not a direct move any more: it goes through a decision.
    const direct = await api().post(url).set(h).send({ status: 'approved', reason: 'Passed the audit' });
    expect(direct.status).toBe(409);
    expect(direct.body.error.code).toBe('supplier_rule');
    await approveVia(ctx.s1, 'approved');
    const a = (await api().get(`${base}/suppliers/${ctx.s1}`).set(h).expect(200)).body;
    expect(a).toMatchObject({ approvalStatus: 'approved', approvalStatusChangedBy: { name: expect.any(String) }, active: true });
    await api().post(url).set(h).send({ status: 'pending_approval', reason: 'Back' }).expect(409);
    await api().post(url).set(h).send({ status: 'conditional', reason: 'Late deliveries' }).expect(409); // direct conditional approval is refused too
    await approveVia(ctx.s1, 'conditional', { rationale: 'Late deliveries', conditions: 'Inspect every delivery', reviewOn: '2999-01-01' });
    const c = (await api().get(`${base}/suppliers/${ctx.s1}`).set(h).expect(200)).body;
    expect(c).toMatchObject({ approvalStatus: 'conditional', conditions: 'Inspect every delivery', reviewOn: '2999-01-01' });
    await api().post(url).set(h).send({ status: 'suspended', reason: 'Repeat major non-conformances' }).expect(200);
    const hist = (await api().get(`${base}/suppliers/${ctx.s1}/history`).set(await reader()).expect(200)).body.data;
    expect(hist.map((x: { toStatus: string }) => x.toStatus)).toEqual(['suspended', 'conditional', 'approved', 'pending_approval']);
    expect(hist[1]).toMatchObject({ fromStatus: 'approved', conditions: 'Inspect every delivery', reviewOn: '2999-01-01', changedBy: { name: expect.any(String) } });
    expect(hist[3]).toMatchObject({ fromStatus: null, reason: null });
    // The conditions only show while the status is conditional.
    expect((await api().get(`${base}/suppliers/${ctx.s1}`).set(h).expect(200)).body.conditions).toBeNull();
  });
});

describe('classifications', () => {
  it('are configured by people who may configure, with unique labels, and cannot be added once switched off', async () => {
    const h = await owner();
    await api().post(`${base}/classifications`).set(await reader()).send({ label: 'Nope' }).expect(403);
    const made = (await api().post(`${base}/classifications`).set(h).send({ label: 'Casting foundry' }).expect(201)).body;
    ctx.casting = made.id;
    expect(made).toMatchObject({ key: 'casting_foundry', label: 'Casting foundry', active: true, suppliers: 0 });
    await api().post(`${base}/classifications`).set(h).send({ label: 'casting FOUNDRY' }).expect(409);
    const renamed = (await api().patch(`${base}/classifications/${ctx.casting}`).set(h).send({ label: 'Foundry (casting)', description: 'Sand and die casting' }).expect(200)).body;
    expect(renamed).toMatchObject({ key: 'casting_foundry', label: 'Foundry (casting)' });
    await api().patch(`${base}/classifications/${ctx.casting}`).set(h).send({ key: 'changed' }).expect(400);
    const set = (await api().put(`${base}/suppliers/${ctx.s1}/classifications`).set(h).send({ classificationIds: [ctx.welding, ctx.heat, ctx.casting] }).expect(200)).body;
    expect(set.classifications.map((c: { label: string }) => c.label).sort()).toEqual(['Foundry (casting)', 'Heat treatment', 'Welding']);
    await api().patch(`${base}/classifications/${ctx.heat}`).set(h).send({ active: false }).expect(200);
    await api().put(`${base}/suppliers/${ctx.s1}/classifications`).set(h).send({ classificationIds: [ctx.welding] }).expect(200);
    await api().put(`${base}/suppliers/${ctx.s1}/classifications`).set(h).send({ classificationIds: [ctx.welding, ctx.heat] }).expect(409);
    expect((await api().get(`${base}/classifications`).set(h).expect(200)).body.data.some((c: { id: string }) => c.id === ctx.heat)).toBe(false);
    expect((await api().get(`${base}/classifications?all=true`).set(h).expect(200)).body.data.find((c: { id: string }) => c.id === ctx.heat)).toMatchObject({ active: false });
    await api().put(`${base}/suppliers/${ctx.s1}/classifications`).set(await reader()).send({ classificationIds: [] }).expect(403);
  });
});

describe('contacts, products and services', () => {
  it('keeps one primary contact, deactivates rather than deletes, and links parts once', async () => {
    const h = await owner();
    let d = (await api().post(`${base}/suppliers/${ctx.s1}/contacts`).set(h).send({ name: 'Pat Quality', role: 'quality', email: 'pat@acme.test', isPrimary: true }).expect(201)).body;
    ctx.c1 = d.contacts[0].id;
    d = (await api().post(`${base}/suppliers/${ctx.s1}/contacts`).set(h).send({ name: 'Sam Sales', role: 'sales', isPrimary: true }).expect(201)).body;
    expect(d.contacts.filter((c: { isPrimary: boolean }) => c.isPrimary).map((c: { name: string }) => c.name)).toEqual(['Sam Sales']);
    ctx.c2 = d.contacts.find((c: { name: string }) => c.name === 'Sam Sales').id;
    d = (await api().patch(`${base}/supplier-contacts/${ctx.c2}`).set(h).send({ active: false }).expect(200)).body;
    expect(d.contacts.find((c: { id: string }) => c.id === ctx.c2)).toMatchObject({ active: false, isPrimary: false });
    await api().post(`${base}/suppliers/${ctx.s1}/contacts`).set(h).send({ name: 'X', role: 'astronaut' }).expect(400);
    await api().patch(`${base}/supplier-contacts/${ctx.c1}`).set(await reader()).send({ name: 'Hijack' }).expect(403);

    d = (await api().post(`${base}/suppliers/${ctx.s1}/products`).set(h).send({ kind: 'part', partId: ctx.part, supplierPartNumber: 'AC-BAR-50' }).expect(201)).body;
    expect(d.products[0]).toMatchObject({ kind: 'part', part: { partNumber: 'BAR-50' }, supplierPartNumber: 'AC-BAR-50' });
    ctx.prod = d.products[0].id;
    await api().post(`${base}/suppliers/${ctx.s1}/products`).set(h).send({ kind: 'part', partId: ctx.part }).expect(409);
    await api().post(`${base}/suppliers/${ctx.s1}/products`).set(h).send({ kind: 'service', description: 'Case hardening' }).expect(201);
    await api().post(`${base}/suppliers/${ctx.s1}/products`).set(h).send({ kind: 'material' }).expect(400);
    await api().post(`${base}/suppliers/${ctx.s1}/products`).set(h).send({ kind: 'part' }).expect(400);
    await api().post(`${base}/suppliers/${ctx.s1}/products`).set(h).send({ kind: 'service', partId: ctx.part, description: 'x' }).expect(400);
    d = (await api().patch(`${base}/supplier-products/${ctx.prod}`).set(h).send({ active: false }).expect(200)).body;
    expect(d.products.find((p: { id: string }) => p.id === ctx.prod)).toMatchObject({ active: false });
    await api().patch(`${base}/supplier-products/${ctx.prod}`).set(h).send({ partId: ctx.part }).expect(400);
  });
});

describe('the register', () => {
  beforeAll(async () => {
    const h = await owner();
    ctx.s2 = (await api().post(`${base}/suppliers`).set(h).send({ code: 'BETA', name: 'Beta Fasteners', supplierType: 'manufacturer', country: 'DE', classificationIds: [ctx.welding] }).expect(201)).body.id;
    ctx.s3 = (await api().post(`${base}/suppliers`).set(h).send({ code: 'GAMMA', name: 'Gamma Logistics', supplierType: 'logistics_provider', country: 'GB' }).expect(201)).body.id;
    await approveVia(ctx.s2, 'approved', { rationale: 'Audit passed' });
    await api().patch(`${base}/suppliers/${ctx.s3}`).set(h).send({ active: false }).expect(200);
    // An open and a closed-out non-conformance naming ACME.
    const cat = await categoryId(admin, ids.orgA);
    await api().post('/api/v1/ncrs').set(h).send({ source: 'supplier', title: 'Cracked bar', supplierId: ctx.s1, siteId: ids.siteA, categoryId: cat }).expect(201);
  });

  it('lists active suppliers by default with the open non-conformance count, and carries the profile counts', async () => {
    const h = await reader();
    const res = (await api().get(`${base}/suppliers`).set(h).expect(200)).body;
    expect(res).toMatchObject({ page: 1, pageSize: 25 });
    expect(res.data.map((s: { code: string }) => s.code)).toEqual(['ACME', 'BETA']);
    const acme = res.data[0];
    expect(acme).toMatchObject({ approvalStatus: 'suspended', openNcCount: 1, primaryContact: null }); // the primary contact was deactivated above
    const profile = (await api().get(`${base}/suppliers/${ctx.s1}`).set(h).expect(200)).body;
    expect(profile.counts).toMatchObject({ openNcs: 1, totalNcs: 1, receivedLots: 0, lastReceivedOn: null });
  });

  it('filters by status, type, classification, activity, search and sorts and pages', async () => {
    const h = await owner();
    const codes = async (qs: string) => ((await api().get(`${base}/suppliers?${qs}`).set(h).expect(200)).body.data as { code: string }[]).map((s) => s.code);
    expect(await codes('status=approved')).toEqual(['BETA']);
    expect(await codes('status=approved,suspended')).toEqual(['ACME', 'BETA']);
    expect(await codes('type=manufacturer')).toEqual(['BETA']);
    expect(await codes(`classificationId=${ctx.welding}`)).toEqual(['ACME', 'BETA']);
    expect(await codes('active=inactive')).toEqual(['GAMMA']);
    expect(await codes('active=all')).toEqual(['ACME', 'BETA', 'GAMMA']);
    expect(await codes('active=all&q=logistics')).toEqual(['GAMMA']);
    expect(await codes('q=pat%40acme')).toEqual(['ACME']); // a contact's email
    expect(await codes('q=welding')).toEqual(['ACME', 'BETA']); // a classification's label
    expect(await codes('active=all&sort=name&order=desc')).toEqual(['GAMMA', 'BETA', 'ACME']);
    expect(await codes('active=all&sort=openNcs&order=desc')).toEqual(['ACME', 'BETA', 'GAMMA']);
    const paged = (await api().get(`${base}/suppliers?active=all&pageSize=2&page=2`).set(h).expect(200)).body;
    expect(paged).toMatchObject({ page: 2, pageSize: 2, total: 3 });
    expect(paged.data.map((s: { code: string }) => s.code)).toEqual(['GAMMA']);
    await api().get(`${base}/suppliers?status=bogus`).set(h).expect(400);
    await api().get(`${base}/suppliers?sort=bogus`).set(h).expect(400);
    await api().get(`${base}/suppliers?classificationId=nope`).set(h).expect(400);
  });
});

describe('isolation', () => {
  it('another organisation sees none of it and changes none of it', async () => {
    const h = await other();
    expect((await api().get(`${base}/suppliers?active=all`).set(h).expect(200)).body.total).toBe(0);
    await api().get(`${base}/suppliers/${ctx.s1}`).set(h).expect(404);
    await api().patch(`${base}/suppliers/${ctx.s1}`).set(h).send({ city: 'Hijacked' }).expect(404);
    await api().post(`${base}/suppliers/${ctx.s1}/status`).set(h).send({ status: 'approved', reason: 'Not mine' }).expect(404);
    await api().post(`${base}/suppliers/${ctx.s1}/contacts`).set(h).send({ name: 'Intruder' }).expect(404);
    await api().patch(`${base}/supplier-contacts/${ctx.c1}`).set(h).send({ name: 'Hijack' }).expect(404);
    await api().patch(`${base}/supplier-products/${ctx.prod}`).set(h).send({ active: true }).expect(404);
    await api().put(`${base}/suppliers/${ctx.s1}/classifications`).set(h).send({ classificationIds: [] }).expect(404);
    await api().get(`${base}/suppliers/${ctx.s1}/history`).set(h).expect(404);
    // Its own supplier cannot take A's part or classification.
    const mine = (await api().post(`${base}/suppliers`).set(h).send({ code: 'MINE', name: 'Beta supplier' }).expect(201)).body.id;
    const r = await api().post(`${base}/suppliers/${mine}/products`).set(h).send({ kind: 'part', partId: ctx.part }).expect(400);
    expect(JSON.stringify(r.body)).toContain('invalid_reference');
    await api().put(`${base}/suppliers/${mine}/classifications`).set(h).send({ classificationIds: [ctx.welding] }).expect(409);
    await api().patch(`${base}/classifications/${ctx.welding}`).set(h).send({ label: 'Hijacked' }).expect(404);
    await api().get(`${base}/suppliers`).expect(401);
  });
});
