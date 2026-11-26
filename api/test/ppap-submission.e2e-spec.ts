/**
 * PPAP (PP3) through the API: the Part Submission Warrant (typed by a preparer, signed by someone else), submitting (everything frozen), the customer's decision recorded as events,
 * withdrawing what was sent, resubmitting, the periodic review, and the printable warrant. The rules are in supabase/tests/ppap_submission.test.sql; this checks the routes, the
 * answers (what the caller may do, what the submission holds), the words, and the permissions.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('f3b');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};
// Eli prepares (quality engineer), Quinn is a second approver (quality manager); Ada (the owner) approves too.
const ELI = 'f3b00000-0000-0000-0000-0000000000e1';
const QUINN = 'f3b00000-0000-0000-0000-0000000000e2';
/* eslint-disable @typescript-eslint/no-explicit-any */
const element = (body: any, key: string) => body.elements.find((e: any) => e.key === key);
const day = (offset = 0) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

async function addMember(user: string, email: string, role: string, first: string, surname: string) {
  await admin.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [user, email]);
  await admin.query(`update public.profiles set first_name = $2, surname = $3 where id = $1`, [user, first, surname]);
  const m = await admin.query(`insert into public.organisation_users (organisation_id, user_id, status, joined_at) values ($1, $2, 'active', now()) returning id`, [ids.orgA, user]);
  await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = $3`, [ids.orgA, m.rows[0].id, role]);
}

/** Makes a level-1 submission (only the warrant is required) for a part, typed by Eli. */
async function submission(part: string, reason = 'new_part') {
  const made = await api().post('/api/v1/ppaps').set(await as(ELI)).send({ partId: part, customerId: ctx.customer, reason, ownerId: ELI }).expect(201);
  return made.body.id as string;
}
const get = async (id: string, user = ids.ownerA) => (await api().get(`/api/v1/ppaps/${id}`).set(await as(user)).expect(200)).body;
/** Types the warrant (as Eli), has Quinn sign it, marks it ready (as Eli) and sends it (as Eli). */
async function send(id: string, sentOn = day()) {
  await api().put(`/api/v1/ppaps/${id}/psw`).set(await as(ELI)).send({ partWeight: 1.25, weightUnit: 'kg', purchaseOrder: 'PO-1', resultsMeetRequirements: true }).expect(200);
  await api().post(`/api/v1/ppaps/${id}/psw/sign`).set(await as(QUINN)).send({ title: 'Quality Manager', phone: '01234 567890' }).expect(200);
  await api().post(`/api/v1/ppaps/${id}/ready`).set(await as(ELI)).expect(200);
  return (await api().post(`/api/v1/ppaps/${id}/submit`).set(await as(ELI)).send({ sentOn, how: 'Customer portal' }).expect(200)).body;
}

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-ps');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  await addMember(ELI, 'eli@example.test', 'quality_engineer', 'Eli', 'Engineer');
  await addMember(QUINN, 'quinn@example.test', 'quality_manager', 'Quinn', 'Manager');
  const h = await as(ids.ownerA);
  ctx.customer = (await admin.query(`insert into public.customers (organisation_id, code, name, address_line1, city, country) values ($1, 'PS-C1', 'Acme Motors', '1 Factory Road', 'Leeds', 'GB') returning id`, [ids.orgA])).rows[0].id;
  await api().put(`/api/v1/ppap-customer-rules/${ctx.customer}`).set(h).send({ defaultLevel: 1 }).expect(200);
  for (const [key, n] of [['a', 'PS-100'], ['b', 'PS-200'], ['c', 'PS-300'], ['d', 'PS-400'], ['e', 'PS-500'], ['f', 'PS-600']]) {
    const part = (await api().post('/api/v1/parts').set(h).send({ partNumber: n, name: `Part ${n}`, initialRevision: { revision: 'A' } }).expect(201)).body;
    ctx[`part_${key}`] = part.id;
    await api().post(`/api/v1/part-revisions/${part.revisions[0].id}/release`).set(h).expect(200);
  }
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('the warrant', () => {
  it('starts with nothing, and says what is needed', async () => {
    const id = await submission(ctx.part_a);
    ctx.s1 = id;
    const d = await get(id);
    expect(d.psw).toBeNull();
    expect(d.problems).toEqual([expect.stringMatching(/^Part Submission Warrant: fill it in/)]);
    const eli = await get(id, ELI);
    expect(eli.canSavePsw).toBe(true);
    expect(eli.canSign).toBe(false);
  });

  it('is typed by a preparer, then waits for a signature from someone else', async () => {
    const h = await as(ELI);
    await api().put(`/api/v1/ppaps/${ctx.s1}/psw`).set(h).send({ nonsense: 1 }).expect(400);
    await api().put(`/api/v1/ppaps/${ctx.s1}/psw`).set(h).send({}).expect(400);
    await api().put(`/api/v1/ppaps/${ctx.s1}/psw`).set(h).send({ partWeight: -1 }).expect(400);
    const saved = await api().put(`/api/v1/ppaps/${ctx.s1}/psw`).set(h).send({ partWeight: 1.25, weightUnit: 'kg', purchaseOrder: 'PO-77', engineeringChangeLevel: 'EC-3' }).expect(200);
    expect(saved.body.psw).toMatchObject({ partWeight: 1.25, weightUnit: 'kg', purchaseOrder: 'PO-77', engineeringChangeLevel: 'EC-3', resultsMeetRequirements: null, signature: null });
    expect(saved.body.psw.missing).toEqual(['whether the results meet the requirements']);
    expect(element(saved.body, 'part_submission_warrant').status).toBe('in_progress');
    const done = await api().put(`/api/v1/ppaps/${ctx.s1}/psw`).set(h).send({ resultsMeetRequirements: true }).expect(200);
    expect(done.body.psw.missing).toEqual([]);
    expect(done.body.problems).toEqual([expect.stringMatching(/ask an approver who did not prepare/)]);
  });

  it('is signed by an approver who did not prepare it', async () => {
    // Eli prepared it, and he cannot sign (no approval rights at all)
    await api().post(`/api/v1/ppaps/${ctx.s1}/psw/sign`).set(await as(ELI)).send({ title: 'Engineer' }).expect(403);
    const quinn = await get(ctx.s1, QUINN);
    expect(quinn.canSign).toBe(true);
    await api().post(`/api/v1/ppaps/${ctx.s1}/psw/sign`).set(await as(QUINN)).send({}).expect(400);
    const signed = await api().post(`/api/v1/ppaps/${ctx.s1}/psw/sign`).set(await as(QUINN)).send({ title: 'Quality Manager', phone: '01234 567890' }).expect(200);
    expect(signed.body.psw.signature).toMatchObject({ name: 'Quinn Manager', title: 'Quality Manager', phone: '01234 567890', on: day() });
    expect(element(signed.body, 'part_submission_warrant').status).toBe('ready');
    expect(signed.body.problems).toEqual([]);
    expect(signed.body.canMarkReady).toBe(true);
    expect(signed.body.canSign).toBe(false);
    await api().post(`/api/v1/ppaps/${ctx.s1}/psw/sign`).set(await as(QUINN)).send({ title: 'Again' }).expect(409);
    // a signed warrant is not changed
    const refused = await api().put(`/api/v1/ppaps/${ctx.s1}/psw`).set(await as(ELI)).send({ partWeight: 9 }).expect(409);
    expect(refused.body.error.code).toBe('ppap_rule');
  });

  it('never lets the person who prepared it sign it, and says why', async () => {
    const id = await submission(ctx.part_b);
    // Ada, an approver, types it herself and so has prepared it
    await api().put(`/api/v1/ppaps/${id}/psw`).set(await as(ids.ownerA)).send({ partWeight: 2, resultsMeetRequirements: true }).expect(200);
    const d = await get(id);
    expect(d.canSign).toBe(false);
    expect(d.signBlocked).toMatch(/you prepared this submission/i);
    const refused = await api().post(`/api/v1/ppaps/${id}/psw/sign`).set(await as(ids.ownerA)).send({ title: 'Owner' }).expect(409);
    expect(refused.body.error.code).toBe('ppap_rule');
    await api().post(`/api/v1/ppaps/${id}/psw/sign`).set(await as(QUINN)).send({ title: 'Quality Manager' }).expect(200);
  });

  it('can be unsigned by an approver, with a reason, so it can be corrected', async () => {
    const id = await submission(ctx.part_c);
    await api().put(`/api/v1/ppaps/${id}/psw`).set(await as(ELI)).send({ partWeight: 3, resultsMeetRequirements: true }).expect(200);
    await api().post(`/api/v1/ppaps/${id}/psw/sign`).set(await as(QUINN)).send({ title: 'Quality Manager' }).expect(200);
    await api().post(`/api/v1/ppaps/${id}/psw/unsign`).set(await as(ELI)).send({ reason: 'Wrong weight' }).expect(403);
    await api().post(`/api/v1/ppaps/${id}/psw/unsign`).set(await as(QUINN)).send({ reason: 'x' }).expect(400);
    const un = await api().post(`/api/v1/ppaps/${id}/psw/unsign`).set(await as(QUINN)).send({ reason: 'Wrong weight, to be corrected' }).expect(200);
    expect(un.body.psw.signature).toBeNull();
    expect(un.body.psw.unsigned.reason).toBe('Wrong weight, to be corrected');
    expect(element(un.body, 'part_submission_warrant').status).toBe('in_progress');
    await api().put(`/api/v1/ppaps/${id}/psw`).set(await as(ELI)).send({ partWeight: 3.5 }).expect(200);
  });

  it('is shown as a form, and a viewer cannot make or sign one', async () => {
    const form = (await api().get(`/api/v1/ppaps/${ctx.s1}/psw`).set(await as(ELI)).expect(200)).body;
    expect(form).toMatchObject({
      reference: expect.stringMatching(/^PPAP-/), level: 1, reason: 'new_part', organisation: 'Alpha Precision', part: { number: 'PS-100', name: 'Part PS-100' }, revision: { label: 'A' },
      customer: { name: 'Acme Motors', code: 'PS-C1', address: '1 Factory Road, Leeds, GB' }, purchaseOrder: 'PO-77', engineeringChangeLevel: 'EC-3',
      weight: { value: 1.25, unit: 'kg' }, resultsMeetRequirements: true, signer: { name: 'Quinn Manager', title: 'Quality Manager', phone: '01234 567890', signedOn: day() },
      sentOn: null, frozen: false,
    });
    await api().put(`/api/v1/ppaps/${ctx.s1}/psw`).set(await as(ids.dual)).send({ partWeight: 1 }).expect(403);
    await api().post(`/api/v1/ppaps/${ctx.s1}/psw/sign`).set(await as(ids.dual)).send({ title: 'Viewer' }).expect(403);
    await api().get(`/api/v1/ppaps/${ctx.s1}/psw`).set(await as(ids.ownerB, ids.orgB)).expect(404);
  });
});

describe('submitting', () => {
  it('sends a ready submission: frozen, recorded, and no longer editable', async () => {
    const before = await get(ctx.s1, ELI);
    expect(before.status).toBe('in_preparation');
    await api().post(`/api/v1/ppaps/${ctx.s1}/submit`).set(await as(ELI)).send({}).expect(409); // not ready yet
    await api().post(`/api/v1/ppaps/${ctx.s1}/ready`).set(await as(ELI)).expect(200);
    await api().post(`/api/v1/ppaps/${ctx.s1}/submit`).set(await as(ids.dual)).send({}).expect(403);
    await api().post(`/api/v1/ppaps/${ctx.s1}/submit`).set(await as(ELI)).send({ sentOn: day(5) }).expect(409); // not in the future
    const sent = (await api().post(`/api/v1/ppaps/${ctx.s1}/submit`).set(await as(ELI)).send({ sentOn: day(-2), how: 'Customer portal', note: 'Sent with the letter' }).expect(200)).body;
    expect(sent.status).toBe('submitted');
    expect(sent.psw.frozen).toBe(true);
    expect(sent.decisions).toMatchObject([{ seq: 1, kind: 'submitted', decidedOn: day(-2), how: 'Customer portal', note: 'Sent with the letter', recordedBy: { name: 'Eli Engineer' } }]);
    expect(sent.editable).toBe(false);
    expect(sent.canSubmit).toBe(false);
    expect(sent.canRecordDecision).toBe(false); // Eli does not approve
    expect((await get(ctx.s1)).canRecordDecision).toBe(true);
    const form = (await api().get(`/api/v1/ppaps/${ctx.s1}/psw`).set(await as(ELI)).expect(200)).body;
    expect(form).toMatchObject({ frozen: true, sentOn: day(-2) });
    await api().post(`/api/v1/ppaps/${ctx.s1}/submit`).set(await as(ELI)).send({}).expect(409);
    await api().put(`/api/v1/ppaps/${ctx.s1}/psw`).set(await as(ELI)).send({ partWeight: 4 }).expect(409);
  });
});

describe("the customer's decision", () => {
  it('is recorded by an approver, with its reasons, and moves the status', async () => {
    const owner = await as(ids.ownerA);
    await api().post(`/api/v1/ppaps/${ctx.s1}/decisions`).set(await as(ELI)).send({ kind: 'approved', decidedOn: day() }).expect(403);
    await api().post(`/api/v1/ppaps/${ctx.s1}/decisions`).set(owner).send({ kind: 'withdrawn', decidedOn: day() }).expect(400);
    await api().post(`/api/v1/ppaps/${ctx.s1}/decisions`).set(owner).send({ kind: 'approved', decidedOn: day(-3) }).expect(409); // before it was sent
    await api().post(`/api/v1/ppaps/${ctx.s1}/decisions`).set(owner).send({ kind: 'interim_approved', decidedOn: day(-1) }).expect(409); // no expiry
    await api().post(`/api/v1/ppaps/${ctx.s1}/decisions`).set(owner).send({ kind: 'rejected', decidedOn: day(-1) }).expect(409); // no reason
    const interim = (await api().post(`/api/v1/ppaps/${ctx.s1}/decisions`).set(owner).send({ kind: 'interim_approved', decidedOn: day(-1), theirReference: 'ACME-INT-1', expiresOn: day(30), note: 'Until the gauge study is done' }).expect(200)).body;
    expect(interim.status).toBe('interim_approved');
    expect(interim.interimExpiresOn).toBe(day(30));
    expect(interim.interimExpired).toBe(false);
    expect(interim.canRecordDecision).toBe(true); // still open to a further decision
    const approved = (await api().post(`/api/v1/ppaps/${ctx.s1}/decisions`).set(owner).send({
      kind: 'approved', decidedOn: day(), theirReference: 'ACME-OK-9', storagePath: `${ids.orgA}/ppap/${ctx.s1}/psw-signed.pdf`, fileName: 'psw-signed.pdf', contentType: 'application/pdf', sizeBytes: 1234,
    }).expect(200)).body;
    expect(approved.status).toBe('approved');
    expect(approved.nextReviewOn).toBe((await admin.query(`select ($1::date + interval '12 months')::date::text as d`, [day()])).rows[0].d);
    expect(approved.decisions.map((d: any) => d.kind)).toEqual(['submitted', 'interim_approved', 'approved']);
    expect(approved.decisions[2]).toMatchObject({ theirReference: 'ACME-OK-9', file: { fileName: 'psw-signed.pdf', sizeBytes: 1234 } });
    expect(approved.canRecordDecision).toBe(false);
    await api().post(`/api/v1/ppaps/${ctx.s1}/decisions`).set(owner).send({ kind: 'rejected', decidedOn: day(), note: 'Too late' }).expect(409);
  });

  it('refuses a file outside the submission\'s folder', async () => {
    const id = await submission(ctx.part_d);
    await send(id);
    const refused = await api().post(`/api/v1/ppaps/${id}/decisions`).set(await as(ids.ownerA)).send({
      kind: 'approved', decidedOn: day(), storagePath: `${ids.orgA}/ppap/${ctx.s1}/psw.pdf`, fileName: 'psw.pdf', sizeBytes: 10,
    }).expect(409);
    expect(refused.body.error.code).toBe('ppap_rule');
    ctx.sent = id;
  });

  it('shows an interim approval that has run out, without storing it', async () => {
    const id = await submission(ctx.part_e);
    await send(id, day(-40));
    await api().post(`/api/v1/ppaps/${id}/decisions`).set(await as(ids.ownerA)).send({ kind: 'interim_approved', decidedOn: day(-35), expiresOn: day(-5), note: 'Short interim' }).expect(200);
    const d = await get(id);
    expect(d.status).toBe('interim_approved');
    expect(d.interimExpired).toBe(true);
    const list = (await api().get('/api/v1/ppaps?status=interim_approved').set(await as(ids.ownerA)).expect(200)).body;
    expect(list.data.find((x: any) => x.id === id)).toMatchObject({ interimExpired: true, interimExpiresOn: day(-5) });
  });
});

describe('withdrawing, resubmitting and reviewing', () => {
  it('lets an approver withdraw what was sent, and records it', async () => {
    await api().post(`/api/v1/ppaps/${ctx.sent}/withdraw`).set(await as(ELI)).send({ reason: 'Pulled back' }).expect(403);
    await api().post(`/api/v1/ppaps/${ctx.sent}/withdraw`).set(await as(ids.ownerA)).send({ reason: 'x' }).expect(400);
    const w = (await api().post(`/api/v1/ppaps/${ctx.sent}/withdraw`).set(await as(ids.ownerA)).send({ reason: 'The customer cancelled the programme' }).expect(200)).body;
    expect(w.status).toBe('withdrawn');
    expect(w.decisions.map((d: any) => d.kind)).toEqual(['submitted', 'withdrawn']);
    expect(w.canResubmit).toBe(true);
  });

  it('starts a resubmission that names the old one and carries what it can', async () => {
    // a rejected one
    const id = await submission(ctx.part_f);
    await send(id);
    await api().post(`/api/v1/ppaps/${id}/decisions`).set(await as(ids.ownerA)).send({ kind: 'rejected', decidedOn: day(), theirReference: 'ACME-REJ-1', note: 'Dimensional results were missing' }).expect(200);
    await api().post(`/api/v1/ppaps/${id}/resubmission`).set(await as(ids.dual)).send({}).expect(403);
    const again = (await api().post(`/api/v1/ppaps/${id}/resubmission`).set(await as(ELI)).send({}).expect(201)).body;
    expect(again).toMatchObject({ created: true, status: 'draft', replaces: { id, status: 'rejected' } });
    expect(again.psw).toMatchObject({ partWeight: 1.25, signature: null });
    expect(again.id).not.toBe(id);
    const old = await get(id);
    expect(old.replacedBy).toMatchObject([{ id: again.id }]);
    // the same reason cannot be started twice while one is live
    await api().post(`/api/v1/ppaps/${id}/resubmission`).set(await as(ELI)).send({}).expect(409);
    // a submission that was never sent cannot be resubmitted
    await api().post(`/api/v1/ppaps/${again.id}/resubmission`).set(await as(ELI)).send({}).expect(409);
    await api().post(`/api/v1/ppaps/${ctx.s1}/resubmission`).set(await as(ELI)).send({ unknown: 1 }).expect(400);
  });

  it('reviews an approved submission, and revalidating it is recorded as a review', async () => {
    await api().post(`/api/v1/ppaps/${ctx.s1}/reviews`).set(await as(ids.dual)).send({ note: 'Checked' }).expect(403);
    await api().post(`/api/v1/ppaps/${ctx.s1}/reviews`).set(await as(ELI)).send({}).expect(400);
    await api().post(`/api/v1/ppaps/${ctx.s1}/reviews`).set(await as(ELI)).send({ note: 'Checked', nextReviewOn: day() }).expect(409);
    const done = (await api().post(`/api/v1/ppaps/${ctx.s1}/reviews`).set(await as(ELI)).send({ note: 'Process unchanged, studies still current', nextReviewOn: day(200) }).expect(200)).body;
    expect(done.nextReviewOn).toBe(day(200));
    expect(done.reviews).toMatchObject([{ outcome: 'no_change', note: 'Process unchanged, studies still current', nextReviewOn: day(200), by: { name: 'Eli Engineer' } }]);
    const re = (await api().post(`/api/v1/ppaps/${ctx.s1}/resubmission`).set(await as(ELI)).send({ reason: 'engineering_change' }).expect(201)).body;
    expect(re.replaces.id).toBe(ctx.s1);
    expect((await get(ctx.s1)).reviews.map((r: any) => r.outcome)).toEqual(['no_change', 'resubmission_started']);
  });

  it('flags a review that is overdue', async () => {
    const c = await admin.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.ppap_lifecycle', 'on', true)`);
      await c.query(`update public.ppap_submissions set next_review_on = current_date - 3 where id = $1`, [ctx.s1]);
      await c.query('commit');
    } finally {
      c.release();
    }
    const d = await get(ctx.s1);
    expect(d.reviewOverdue).toBe(true);
  });
});

describe('another organisation', () => {
  it('cannot see, sign, send, decide on or resubmit ours', async () => {
    const h = await as(ids.ownerB, ids.orgB);
    await api().get(`/api/v1/ppaps/${ctx.s1}`).set(h).expect(404);
    await api().put(`/api/v1/ppaps/${ctx.s1}/psw`).set(h).send({ partWeight: 1 }).expect(404);
    await api().post(`/api/v1/ppaps/${ctx.s1}/psw/sign`).set(h).send({ title: 'Outsider' }).expect(404);
    await api().post(`/api/v1/ppaps/${ctx.s1}/submit`).set(h).send({}).expect(404);
    await api().post(`/api/v1/ppaps/${ctx.s1}/decisions`).set(h).send({ kind: 'approved', decidedOn: day() }).expect(404);
    await api().post(`/api/v1/ppaps/${ctx.s1}/resubmission`).set(h).send({}).expect(404);
    await api().post(`/api/v1/ppaps/${ctx.s1}/reviews`).set(h).send({ note: 'x' }).expect(404);
  });
});
