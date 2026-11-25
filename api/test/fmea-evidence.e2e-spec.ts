/**
 * FMEA (FM5b) through the API: tying a failure mode to a failure mode of the non-conformance register, and the occurrence evidence (how many live non-conformances were raised against
 * it, in scope and in the period; the ones the FMEA did not foresee; who may see them). The rules for the link itself are in supabase/tests/fmea_occurrence_link.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { categoryId, makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a4f');
const ENGINEER = 'a4f00000-0000-0000-0000-0000000000e1';
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};

/* eslint-disable @typescript-eslint/no-explicit-any */
const mode = (rev: any, index = 0) => rev.net.items[0].functions[0].failureModes[index];

let seq = 0;
/** A raised (open) non-conformance of Alpha against a failure mode of the register, on a part, `daysAgo` days ago. */
const nc = async (failureMode: string | null, part: string | null, daysAgo = 0, stage = 'open', org = ids.orgA) => {
  seq += 1;
  await admin.query(
    `insert into public.nonconformances (organisation_id, reference, source, stage, title, description, severity, quantity_affected, site_id, category_id, part_id, failure_mode_id, detected_at)
     values ($1, $2, 'internal', $3, $4, 'x', 'minor', 1, $5, $6, $7, $8, current_date - $9::int)`,
    [org, `FO-${seq}`, stage, `NC ${seq}`, org === ids.orgA ? ids.siteA : ids.siteB, await categoryId(admin, org), part, failureMode, daysAgo],
  );
};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-fo');
  await admin.query(`insert into auth.users (id, email) values ($1, 'engineer-fo@example.test')`, [ENGINEER]);
  const m = await admin.query(`insert into public.organisation_users (organisation_id, user_id, status, joined_at) values ($1, $2, 'active', now()) returning id`, [ids.orgA, ENGINEER]);
  await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = 'quality_engineer'`, [ids.orgA, m.rows[0].id]);
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });

  const cls = async (org: string, name: string) =>
    (await admin.query(`insert into public.ncr_classifications (organisation_id, kind, name) values ($1, 'failure_mode', $2) returning id`, [org, name])).rows[0].id as string;
  ctx.fmOversize = await cls(ids.orgA, 'Bore oversize');
  ctx.fmBurr = await cls(ids.orgA, 'Burr left');
  ctx.fmScratch = await cls(ids.orgA, 'Scratched');
  ctx.fmOther = await cls(ids.orgB, 'Bore oversize');
  const part = async (org: string, number: string) => (await admin.query(`insert into public.parts (organisation_id, part_number, name) values ($1, $2, $2) returning id`, [org, number])).rows[0].id as string;
  ctx.partA = await part(ids.orgA, 'FO-PA');
  ctx.partB = await part(ids.orgA, 'FO-PB');
  ctx.partOther = await part(ids.orgB, 'FO-PX');

  // In scope (part A), raised in the last year: three against "Bore oversize", one "Scratched", one with no failure mode, one "Burr left".
  await nc(ctx.fmOversize, ctx.partA, 0);
  await nc(ctx.fmOversize, ctx.partA, 10);
  await nc(ctx.fmOversize, ctx.partA, 30);
  await nc(ctx.fmScratch, ctx.partA, 2);
  await nc(null, ctx.partA, 3);
  await nc(ctx.fmBurr, ctx.partA, 5);
  // Not counted: another part, too old, still a draft, another organisation.
  await nc(ctx.fmOversize, ctx.partB, 1);
  await nc(ctx.fmScratch, ctx.partB, 1);
  await nc(ctx.fmOversize, ctx.partA, 400);
  await nc(ctx.fmOversize, ctx.partA, 1, 'draft');
  await nc(ctx.fmOther, ctx.partOther, 1, 'open', ids.orgB);
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('tying a failure mode to the register', () => {
  it('builds an FMEA for part A with two failure modes and ties one', async () => {
    const h = await as(ids.ownerA);
    const made = await api().post('/api/v1/fmeas').set(h).send({ kind: 'process', title: 'Turning', links: [{ kind: 'part', id: ctx.partA }] }).expect(201);
    ctx.fmea = made.body.id;
    ctx.rev = made.body.inProgress.id;
    let rev = (await api().post(`/api/v1/fmea-revisions/${ctx.rev}/items`).set(h).send({ kind: 'item', name: 'Bracket' }).expect(201)).body;
    rev = (await api().post(`/api/v1/fmea-items/${rev.net.items[0].id}/functions`).set(h).send({ text: 'Hold the bore' }).expect(201)).body;
    const fn = rev.net.items[0].functions[0].id;
    rev = (await api().post(`/api/v1/fmea-functions/${fn}/failure-modes`).set(h).send({ text: 'Bore oversize' }).expect(201)).body;
    rev = (await api().post(`/api/v1/fmea-functions/${fn}/failure-modes`).set(h).send({ text: 'Bore undersize' }).expect(201)).body;
    expect(mode(rev, 0).ncFailureMode).toBeNull();
    ctx.mode1 = mode(rev, 0).id;
    ctx.mode2 = mode(rev, 1).id;
    await api().post(`/api/v1/fmea-failure-modes/${ctx.mode1}/effects`).set(h).send({ level: 'end_user', text: 'Leaks', severity: 8 }).expect(201);
    await api().post(`/api/v1/fmea-failure-modes/${ctx.mode1}/causes`).set(h).send({ text: 'Tool wear', preventionControls: 'Change the tool', occurrence: 2, detection: 3 }).expect(201);

    rev = (await api().patch(`/api/v1/fmea-failure-modes/${ctx.mode1}`).set(h).send({ ncrFailureModeId: ctx.fmOversize }).expect(200)).body;
    expect(mode(rev, 0).ncFailureMode).toEqual({ id: ctx.fmOversize, name: 'Bore oversize' });
  });

  it('refuses a failure mode of another organisation, a malformed id, and clears with null', async () => {
    const h = await as(ids.ownerA);
    const other = await api().patch(`/api/v1/fmea-failure-modes/${ctx.mode2}`).set(h).send({ ncrFailureModeId: ctx.fmOther }).expect(409);
    expect(other.body.error ?? other.body.code).toBeDefined();
    await api().patch(`/api/v1/fmea-failure-modes/${ctx.mode2}`).set(h).send({ ncrFailureModeId: 'nope' }).expect(400);
    const tied = (await api().patch(`/api/v1/fmea-failure-modes/${ctx.mode2}`).set(h).send({ ncrFailureModeId: ctx.fmBurr }).expect(200)).body;
    expect(mode(tied, 1).ncFailureMode).toMatchObject({ name: 'Burr left' });
    const cleared = (await api().patch(`/api/v1/fmea-failure-modes/${ctx.mode2}`).set(h).send({ ncrFailureModeId: null }).expect(200)).body;
    expect(mode(cleared, 1).ncFailureMode).toBeNull();
  });
});

describe('occurrence evidence', () => {
  it('counts the live non-conformances in scope and in the period, beside the total, and flags a low occurrence rating', async () => {
    const h = await as(ids.ownerA);
    const e = (await api().get(`/api/v1/fmea-revisions/${ctx.rev}/occurrence-evidence`).set(h).expect(200)).body;
    expect(e).toMatchObject({ available: true, scoped: true, days: 365 });
    expect(e.modes).toHaveLength(2);
    const tied = e.modes.find((m: any) => m.id === ctx.mode1);
    expect(tied).toMatchObject({ tied: true, ncFailureModeName: 'Bore oversize', count: 3, inScope: 3, total: 4, maxOccurrence: 2, flag: 'seen_but_rated_low' });
    expect(tied.latestOn).toBe(new Date().toISOString().slice(0, 10));
    expect(e.modes.find((m: any) => m.id === ctx.mode2)).toMatchObject({ tied: false, flag: 'untied', count: null });
    expect(e.totals).toEqual({ failureModes: 2, tied: 1, withNonConformances: 1, toLookAt: 1 });
  });

  it('lists what happened in scope that nothing in the analysis foresaw, with examples, and counts the unclassified apart', async () => {
    const h = await as(ids.ownerA);
    const e = (await api().get(`/api/v1/fmea-revisions/${ctx.rev}/occurrence-evidence`).set(h).expect(200)).body;
    expect(e.notForeseen.available).toBe(true);
    expect(e.notForeseen.groups.map((g: any) => [g.name, g.count])).toEqual([['Scratched', 1], ['Burr left', 1]]); // one each: the newer first
    const scratched = e.notForeseen.groups.find((g: any) => g.name === 'Scratched');
    expect(scratched.examples).toHaveLength(1);
    expect(scratched.examples[0]).toMatchObject({ reference: expect.stringMatching(/^FO-/), detectedOn: expect.any(String) });
    expect(e.notForeseen.unclassified).toBe(1);
    // Tying the second failure mode to "Burr left" makes that one foreseen.
    await api().patch(`/api/v1/fmea-failure-modes/${ctx.mode2}`).set(h).send({ ncrFailureModeId: ctx.fmBurr }).expect(200);
    const after = (await api().get(`/api/v1/fmea-revisions/${ctx.rev}/occurrence-evidence`).set(h).expect(200)).body;
    expect(after.notForeseen.groups.map((g: any) => g.name)).toEqual(['Scratched']);
    expect(after.modes.find((m: any) => m.id === ctx.mode2)).toMatchObject({ count: 1, flag: 'seen' });
  });

  it('looks back as far as asked, and refuses a silly period', async () => {
    const h = await as(ids.ownerA);
    const far = (await api().get(`/api/v1/fmea-revisions/${ctx.rev}/occurrence-evidence?days=730`).set(h).expect(200)).body;
    expect(far.days).toBe(730);
    expect(far.modes.find((m: any) => m.id === ctx.mode1)).toMatchObject({ count: 4, inScope: 4, total: 5 });
    await api().get(`/api/v1/fmea-revisions/${ctx.rev}/occurrence-evidence?days=3`).set(h).expect(400);
    await api().get(`/api/v1/fmea-revisions/${ctx.rev}/occurrence-evidence?days=5000`).set(h).expect(400);
  });

  it('counts every non-conformance, and cannot say what was not foreseen, when the FMEA has no scope', async () => {
    const h = await as(ids.ownerA);
    await api().put(`/api/v1/fmea-revisions/${ctx.rev}/links`).set(h).send({ links: [] }).expect(200);
    const e = (await api().get(`/api/v1/fmea-revisions/${ctx.rev}/occurrence-evidence`).set(h).expect(200)).body;
    expect(e.scoped).toBe(false);
    expect(e.modes.find((m: any) => m.id === ctx.mode1)).toMatchObject({ count: 4, total: 4, inScope: null });
    expect(e.notForeseen.available).toBe(false);
    expect(e.notForeseen.reason).toMatch(/scope/);
    await api().put(`/api/v1/fmea-revisions/${ctx.rev}/links`).set(h).send({ links: [{ kind: 'part', id: ctx.partA }] }).expect(200);
  });

  it('never shows another organisation\'s non-conformances or revisions', async () => {
    const hb = await as(ids.ownerB, ids.orgB);
    await api().get(`/api/v1/fmea-revisions/${ctx.rev}/occurrence-evidence`).set(hb).expect(404);
  });

  it('tells a person who cannot read non-conformances that the evidence is not available, never that nothing happened', async () => {
    // A quality engineer manages FMEAs (so reads the draft), and here is made unable to read non-conformances by taking ncr.read from the role.
    const role = (await admin.query(`select id from public.roles where organisation_id = $1 and key = 'quality_engineer'`, [ids.orgA])).rows[0].id as string;
    await admin.query(`delete from public.role_permissions where role_id = $1 and permission_code = 'ncr.read'`, [role]);
    try {
      const e = (await api().get(`/api/v1/fmea-revisions/${ctx.rev}/occurrence-evidence`).set(await as(ENGINEER)).expect(200)).body;
      expect(e.available).toBe(false);
      expect(e.reason).toMatch(/cannot read non-conformances/);
      expect(e.modes).toBeUndefined();
    } finally {
      await admin.query(`insert into public.role_permissions (role_id, permission_code) values ($1, 'ncr.read') on conflict do nothing`, [role]);
    }
  });
});
