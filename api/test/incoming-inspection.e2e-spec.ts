/**
 * Supplier quality SQ4b through the API: inspection requirements (draft → approval by a different person → frozen, supersession, retirement), the preview, the determination made
 * when a delivery arrives (a lot awaiting inspection is held, a critical part is never reduced), the incoming inspection through the shared engine, dispositions with the
 * evidence they need, and a central non-conformance raised from a receipt line.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('fc');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const owner = () => as(ids.ownerA);
const inspector = () => as(ids.inspectorA);
const other = () => as(ids.ownerB, ids.orgB);
const qmId = ids.ownerA.replace(/a1$/, 'a4');
const engId = ids.ownerA.replace(/a1$/, 'a5');
const manager = () => as(qmId);
const engineer = () => as(engId);
const ctx: Record<string, string> = {};
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/** Runs statements as a signed-in user (row-level security applies), in one transaction. */
const asUser = async (user: string, fn: (q: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>) => Promise<void>) => {
  const client = await admin.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user, role: 'authenticated' })]);
    await client.query('set local role authenticated');
    await fn((text, params) => client.query(text, params));
    await client.query('commit');
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
};

const partWithPlan = async (number: string, criticality: string) =>
  asUser(ids.ownerA, async (q) => {
    const part = (await q(`insert into public.parts (organisation_id, part_number, name) values ($1, $2, $2) returning id`, [ids.orgA, number])).rows[0].id as string;
    await q(`insert into public.part_revisions (organisation_id, part_id, revision) values ($1, $2, 'A')`, [ids.orgA, part]);
    await q(`update public.part_revisions set status = 'released' where part_id = $1`, [part]);
    const plan = (await q(`insert into public.control_plans (organisation_id, plan_code, title) values ($1, $2, 'Incoming') returning id`, [ids.orgA, `CP-${number}`])).rows[0].id as string;
    await q(`insert into public.control_plan_applicability (organisation_id, control_plan_id, part_id) values ($1, $2, $3)`, [ids.orgA, plan, part]);
    const rev = (await q(`insert into public.control_plan_revisions (organisation_id, control_plan_id, revision_code, change_reason) values ($1, $2, 'A', 'First') returning id`, [ids.orgA, plan])).rows[0].id as string;
    const op = (await q(`insert into public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, sequence, name) values ($1, $2, 'INCOMING', 10, 'Incoming') returning id`, [ids.orgA, rev])).rows[0].id as string;
    await q(`insert into public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, sequence, name, nominal, lower_limit, upper_limit, unit_code, criticality) values ($1, $2, $3, 'DIA', 10, 'Diameter', 10, 9.9, 10.1, 'mm', $4)`, [ids.orgA, rev, op, criticality]);
    for (const status of ['pending_approval', 'approved', 'effective']) await q(`update public.control_plan_revisions set status = $1 where id = $2`, [status, rev]);
    ctx[number] = part;
  });

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-inc');
  for (const [user, role] of [[qmId, 'quality_manager'], [engId, 'quality_engineer']] as const) {
    await admin.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [user, `${role}@example.test`]);
    const mem = await admin.query(`insert into public.organisation_users (organisation_id, user_id, status) values ($1, $2, 'active') returning id`, [ids.orgA, user]);
    await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = $3`, [ids.orgA, mem.rows[0].id, role]);
  }
  ctx.site = (await admin.query(`select id from public.sites where organisation_id = $1 limit 1`, [ids.orgA])).rows[0].id;
  ctx.s1 = (await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'ACME', 'Acme Metals') returning id`, [ids.orgA])).rows[0].id;
  ctx.s2 = (await admin.query(`insert into public.suppliers (organisation_id, code, name) values ($1, 'BOLT', 'Bolt Co') returning id`, [ids.orgA])).rows[0].id;
  await partWithPlan('P-MINOR', 'minor');
  await partWithPlan('P-CRIT', 'critical');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

const REQ = (over: Record<string, unknown> = {}) => ({ name: 'Default: every unit', strategy: 'full', level: 'normal', ...over });
const base = '/api/v1/inspection-requirements';

describe('inspection requirements', () => {
  it('are drafted by people who manage, validated, and edited only while drafts', async () => {
    await api().post(base).set(await inspector()).send(REQ()).expect(403);
    const h = await engineer();
    await api().post(base).set(h).send(REQ({ name: '' })).expect(400);
    await api().post(base).set(h).send(REQ({ sampleSize: 5 })).expect(400); // full takes none
    await api().post(base).set(h).send(REQ({ strategy: 'fixed' })).expect(400); // needs a sample size
    await api().post(base).set(h).send(REQ({ strategy: 'percentage', percentage: 150 })).expect(400);
    await api().post(base).set(h).send(REQ({ strategy: 'skip_lot', sampleSize: 3 })).expect(400); // needs skipEvery
    await api().post(base).set(h).send({ ...REQ(), price: 1 }).expect(400);
    expect((await api().post(base).set(h).send(REQ({ strategy: 'plan', plan: [{ fromQuantity: 1, toQuantity: 10, sampleSize: 3, acceptNumber: 3 }] }))).status).toBe(400); // accept number must be below the sample size
    const draft = (await api().post(base).set(h).send(REQ()).expect(201)).body;
    ctx.r1 = draft.id;
    expect(draft).toMatchObject({ status: 'draft', strategy: 'full', level: 'normal', operationCode: 'INCOMING', reducesControls: false, createdBy: { id: engId } });
    const edited = (await api().patch(`${base}/${ctx.r1}`).set(h).send({ name: 'Default: every unit (edited)' }).expect(200)).body;
    expect(edited.name).toBe('Default: every unit (edited)');
    await api().patch(`${base}/${ctx.r1}`).set(h).send({}).expect(400);
    expect((await api().get(`${base}?status=active`).set(await inspector()).expect(200)).body.data).toHaveLength(1);
  });

  it('are approved by a different person with the right, then frozen', async () => {
    await api().post(`${base}/${ctx.r1}/approve`).set(await engineer()).send({}).expect(403);
    const approved = (await api().post(`${base}/${ctx.r1}/approve`).set(await manager()).send({ note: 'Every unit until we know the supplier' }).expect(200)).body;
    expect(approved).toMatchObject({ status: 'approved', approvedBy: { id: qmId }, approvalNote: 'Every unit until we know the supplier' });
    expect((await api().patch(`${base}/${ctx.r1}`).set(await engineer()).send({ name: 'Changed' })).status).toBe(409);
    expect((await api().post(`${base}/${ctx.r1}/approve`).set(await manager()).send({})).status).toBe(409); // only drafts
    // the owner can approve, but not what the owner wrote
    const own = (await api().post(base).set(await owner()).send(REQ({ name: 'Owner draft' })).expect(201)).body;
    expect((await api().post(`${base}/${own.id}/approve`).set(await owner()).send({})).status).toBe(409);
    await api().post(`${base}/${own.id}/retire`).set(await owner()).send({ reason: 'x' }).expect(400);
    const retired = (await api().post(`${base}/${own.id}/retire`).set(await owner()).send({ reason: 'Only a test of the rule' }).expect(200)).body;
    expect(retired).toMatchObject({ status: 'retired', retireReason: 'Only a test of the rule' });
  });

  it('a rule that reduces inspection needs a real reason, and a replacement supersedes the old rule', async () => {
    const h = await engineer();
    const skip = (await api().post(base).set(h).send(REQ({ name: 'Bolt: none', strategy: 'none', level: 'skip', supplierId: ctx.s2, rationale: 'Trusted supplier' })).expect(201)).body;
    expect(skip.reducesControls).toBe(true);
    expect((await api().post(`${base}/${skip.id}/approve`).set(await manager()).send({ note: 'ok' })).status).toBe(409);
    await api().post(`${base}/${skip.id}/approve`).set(await manager()).send({ note: 'Reviewed yearly, no escapes in two years' }).expect(200);
    const next = (await api().post(base).set(h).send(REQ({ name: 'Acme plan', supplierId: ctx.s1, strategy: 'plan', supersedesId: ctx.r1, plan: [{ fromQuantity: 1, toQuantity: 50, sampleSize: 5, acceptNumber: 0 }, { fromQuantity: 51, toQuantity: 500, sampleSize: 20, acceptNumber: 1 }] })).expect(201)).body;
    const spare = (await api().post(base).set(h).send(REQ({ name: 'Spare draft' })).expect(201)).body;
    expect((await api().post(base).set(h).send(REQ({ name: 'Replaces a draft', supersedesId: spare.id }))).status).toBe(409); // only an approved rule can be superseded
    await api().post(`${base}/${next.id}/approve`).set(await manager()).send({ note: 'Moving to a plan' }).expect(200);
    expect((await api().get(`${base}/${ctx.r1}`).set(h).expect(200)).body.status).toBe('superseded'); // the plan replaced the default rule
    ctx.plan = next.id;
    expect((await api().get(`${base}?status=all`).set(h).expect(200)).body.data.length).toBeGreaterThanOrEqual(5);
  });
});

describe('the preview', () => {
  it('says what the approved rules decide, and never reduces a critical part', async () => {
    const h = await inspector();
    const get = async (q: Record<string, string | number>) => (await api().get(`/api/v1/incoming-inspection/preview?${new URLSearchParams(Object.fromEntries(Object.entries(q).map(([k, v]) => [k, String(v)])))}`).set(h).expect(200)).body;
    await api().get(`/api/v1/incoming-inspection/preview?supplierId=${ctx.s1}`).set(h).expect(400);
    const plan = await get({ supplierId: ctx.s1, partId: ctx['P-MINOR'], quantity: 30 });
    expect(plan).toMatchObject({ required: true, strategy: 'plan', sampleSize: 5, acceptNumber: 0, overridden: false });
    expect(await get({ supplierId: ctx.s1, partId: ctx['P-MINOR'], quantity: 200 })).toMatchObject({ sampleSize: 20, acceptNumber: 1 });
    expect(await get({ supplierId: ctx.s2, partId: ctx['P-MINOR'], quantity: 10 })).toMatchObject({ required: false, strategy: 'none' });
    expect(await get({ supplierId: ctx.s2, partId: ctx['P-CRIT'], quantity: 10 })).toMatchObject({ required: true, strategy: 'full', overridden: true, controlled: true, sampleSize: 10 });
    expect(await get({ supplierId: ctx.s2, quantity: 10 })).toMatchObject({ required: false }); // a material
    await api().get(`/api/v1/incoming-inspection/preview?supplierId=${ctx.s1}&partId=${ctx['P-MINOR']}&quantity=5`).set(await other()).expect(404);
  });
});

describe('a delivery, its inspection and what is decided', () => {
  it('determines inspection per line and holds a lot awaiting it', async () => {
    const h = await owner();
    const gr = (await api().post('/api/v1/goods-receipts').set(h).send({
      supplierId: ctx.s2, receivedOn: day(0), deliveryNote: 'DN-9', siteId: ctx.site,
      lines: [{ partId: ctx['P-MINOR'], quantity: 10, lotNumber: 'LOT-NONE' }, { partId: ctx['P-CRIT'], quantity: 4, lotNumber: 'LOT-CRIT' }, { material: 'Loose steel', quantity: 3 }],
    }).expect(201)).body;
    ctx.gr = gr.id;
    const [none, crit, material] = gr.lines;
    expect(none).toMatchObject({ status: 'not_required', determination: { required: false, strategy: 'none' }, lotStatus: 'open' });
    expect(crit).toMatchObject({ status: 'pending', determination: { required: true, strategy: 'full', overridden: true, sampleSize: 4 }, lotStatus: 'on_hold', assessment: { state: 'not_started', outcome: 'incomplete', requiredSamples: 4 } });
    expect(material).toMatchObject({ status: 'not_required', determination: { required: false } });
    ctx.critLine = crit.id;
    ctx.noneLine = none.id;
  });

  it('is inspected through the shared engine and cannot be accepted before the evidence is in', async () => {
    const h = await owner();
    await api().post(`/api/v1/goods-receipt-lines/${ctx.noneLine}/start-inspection`).set(h).expect(409); // none required
    const accept = (who = h) => api().post(`/api/v1/goods-receipt-lines/${ctx.critLine}/disposition`).set(who).send({ decision: 'accepted' });
    expect((await accept()).status).toBe(409); // not started
    const started = (await api().post(`/api/v1/goods-receipt-lines/${ctx.critLine}/start-inspection`).set(h).expect(200)).body;
    const line = started.lines.find((l: { id: string }) => l.id === ctx.critLine);
    expect(line.assessment).toMatchObject({ state: 'in_progress', samples: 0 });
    expect(line.assessment.inspectionReference).toMatch(/^IPI-\d{2}-\d{4}$/);
    ctx.inspection = line.assessment.inspectionId;
    expect((await api().post(`/api/v1/goods-receipt-lines/${ctx.critLine}/start-inspection`).set(h)).status).toBe(409); // one per line
    const insp = (await admin.query(`select trigger_type, lot, lot_size from public.inspection_records where id = $1`, [ctx.inspection])).rows[0];
    expect(insp).toMatchObject({ trigger_type: 'incoming', lot: 'LOT-CRIT', lot_size: 4 });
    expect((await accept()).status).toBe(409); // in progress
    await asUser(ids.ownerA, async (q) => {
      for (let i = 0; i < 3; i += 1) {
        const s = (await q(`insert into public.inspection_samples (organisation_id, inspection_record_id, trigger_type) values ($1, $2, 'manual') returning id`, [ids.orgA, ctx.inspection])).rows[0].id as string;
        await q(`insert into public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric) select $1, $2, $3, q.id, 10 from public.resolved_inspection_requirements q where q.inspection_record_id = $2`, [ids.orgA, ctx.inspection, s]);
      }
      await q(`update public.inspection_records set status = 'completed' where id = $1`, [ctx.inspection]);
    });
    const detail = (await api().get(`/api/v1/goods-receipts/${ctx.gr}`).set(h).expect(200)).body;
    expect(detail.lines.find((l: { id: string }) => l.id === ctx.critLine).assessment).toMatchObject({ state: 'completed', samples: 3, requiredSamples: 4, outcome: 'incomplete' });
    expect((await accept()).status).toBe(409); // 3 of 4 samples
  });

  it('decisions are held, rejected, conditionally accepted by an approver, and kept in order', async () => {
    const h = await owner();
    const decide = (body: Record<string, unknown>, who = h) => api().post(`/api/v1/goods-receipt-lines/${ctx.critLine}/disposition`).set(who).send(body);
    await decide({ decision: 'maybe' }).expect(400);
    await decide({ decision: 'held' }).expect(409); // a reason
    await decide({ decision: 'held', reason: 'Waiting for the fourth sample' }, await viewerLike()).expect(403);
    await decide({ decision: 'held', reason: 'Waiting for the fourth sample' }).expect(200);
    expect((await decide({ decision: 'held', reason: 'Again please' })).status).toBe(409);
    await decide({ decision: 'conditional', reason: 'Needed on the line', conditions: 'Use on job 12 only' }, await engineer()).expect(403);
    const rejected = (await decide({ decision: 'rejected', reason: 'Four units out of tolerance' }).expect(200)).body;
    expect(rejected.lines.find((l: { id: string }) => l.id === ctx.critLine)).toMatchObject({ status: 'rejected', lotStatus: 'on_hold' });
    await decide({ decision: 'held', reason: 'Second thoughts' }, await engineer()).expect(403); // only an approver changes a rejection
    const cond = (await decide({ decision: 'conditional', reason: 'Needed on the line; sorted by us', conditions: 'Use on job 12 only, re-inspect every unit' }, await manager()).expect(200)).body;
    const l = cond.lines.find((x: { id: string }) => x.id === ctx.critLine);
    expect(l).toMatchObject({ status: 'conditional', lotStatus: 'released', disposition: { decision: 'conditional', conditions: 'Use on job 12 only, re-inspect every unit' } });
    expect(l.dispositions.map((d: { decision: string }) => d.decision)).toEqual(['held', 'rejected', 'conditional']);
  });

  it('raises a central non-conformance from a line, once, and the NC page can say where it came from', async () => {
    const h = await owner();
    const raise = (body: Record<string, unknown>, who = h) => api().post(`/api/v1/goods-receipt-lines/${ctx.critLine}/raise-ncr`).set(who).send(body);
    await raise({}, await viewerLike()).expect(403); // ncr.create
    await raise({ severity: 'huge' }).expect(400);
    expect((await raise({ quantity: 99 })).status).toBe(409);
    const made = (await raise({ description: 'Out of tolerance on arrival', severity: 'major', quantity: 2 }).expect(200)).body;
    expect(made.created).toBe(true);
    const nc = (await admin.query(`select source, stage, severity, supplier_id, part_id, lot_number, quantity_affected::float as q from public.nonconformances where id = $1`, [made.nonconformanceId])).rows[0];
    expect(nc).toMatchObject({ source: 'goods_receiving', stage: 'draft', severity: 'major', supplier_id: ctx.s2, part_id: ctx['P-CRIT'], lot_number: 'LOT-CRIT', q: 2 });
    expect((await raise({}).expect(200)).body).toMatchObject({ nonconformanceId: made.nonconformanceId, created: false });
    const detail = (await api().get(`/api/v1/goods-receipts/${ctx.gr}`).set(h).expect(200)).body;
    expect(detail.lines.find((l: { id: string }) => l.id === ctx.critLine).ncrs).toEqual([expect.objectContaining({ id: made.nonconformanceId, stage: 'draft' })]);
    const source = (await api().get(`/api/v1/ncrs/${made.nonconformanceId}/receipt-source`).set(h).expect(200)).body;
    expect(source).toMatchObject({ available: true, items: [expect.objectContaining({ receiptId: ctx.gr, lineNumber: 2, lotNumber: 'LOT-CRIT', deliveryNote: 'DN-9' })] });
    await api().get(`/api/v1/ncrs/00000000-0000-0000-0000-000000000001/receipt-source`).set(h).expect(404);
  });

  it('accepts inspected goods once the evidence supports it, and releases the lot', async () => {
    const h = await owner();
    const gr = (await api().post('/api/v1/goods-receipts').set(h).send({ supplierId: ctx.s1, receivedOn: day(0), siteId: ctx.site, lines: [{ partId: ctx['P-MINOR'], quantity: 30, lotNumber: 'LOT-OK' }] }).expect(201)).body;
    const line = gr.lines[0];
    expect(line.determination).toMatchObject({ required: true, sampleSize: 5, acceptNumber: 0, ruleName: 'Acme plan' });
    const started = (await api().post(`/api/v1/goods-receipt-lines/${line.id}/start-inspection`).set(h).expect(200)).body;
    const inspectionId = started.lines[0].assessment.inspectionId as string;
    await asUser(ids.ownerA, async (q) => {
      for (let i = 0; i < 5; i += 1) {
        const s = (await q(`insert into public.inspection_samples (organisation_id, inspection_record_id, trigger_type) values ($1, $2, 'manual') returning id`, [ids.orgA, inspectionId])).rows[0].id as string;
        await q(`insert into public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric) select $1, $2, $3, q.id, 10 from public.resolved_inspection_requirements q where q.inspection_record_id = $2`, [ids.orgA, inspectionId, s]);
      }
      await q(`update public.inspection_records set status = 'completed' where id = $1`, [inspectionId]);
    });
    const accepted = (await api().post(`/api/v1/goods-receipt-lines/${line.id}/disposition`).set(h).send({ decision: 'accepted' }).expect(200)).body;
    expect(accepted.lines[0]).toMatchObject({ status: 'accepted', lotStatus: 'released', assessment: { outcome: 'acceptable', samples: 5, failedSamples: 0 } });
  });
});

describe('another organisation', () => {
  it('sees nothing and can change nothing', async () => {
    const h = await other();
    expect((await api().get(`${base}?status=all`).set(h).expect(200)).body.data).toHaveLength(0);
    await api().get(`${base}/${ctx.r1}`).set(h).expect(404);
    await api().post(`${base}/${ctx.r1}/approve`).set(h).send({}).expect(404);
    await api().post(`/api/v1/goods-receipt-lines/${ctx.critLine}/disposition`).set(h).send({ decision: 'held', reason: 'Foreign hold' }).expect(404);
    await api().post(`/api/v1/goods-receipt-lines/${ctx.critLine}/start-inspection`).set(h).expect(404);
    await api().post(`/api/v1/goods-receipt-lines/${ctx.critLine}/raise-ncr`).set(h).send({}).expect(404);
  });
});

/** A signed-in person who can read receiving but not manage it. */
async function viewerLike() {
  const id = ids.ownerA.replace(/a1$/, 'a6');
  await admin.query(`insert into auth.users (id, email) values ($1, 'viewer2@example.test') on conflict do nothing`, [id]);
  const exists = await admin.query(`select 1 from public.organisation_users where organisation_id = $1 and user_id = $2`, [ids.orgA, id]);
  if (exists.rowCount === 0) {
    const mem = await admin.query(`insert into public.organisation_users (organisation_id, user_id, status) values ($1, $2, 'active') returning id`, [ids.orgA, id]);
    await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = 'viewer'`, [ids.orgA, mem.rows[0].id]);
  }
  return as(id);
}
