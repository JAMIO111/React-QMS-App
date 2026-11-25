/**
 * Gauge R&R / measurement system analysis (MS3) through the API: designing a study, the run sheet, pasted readings, the live analysis, completing from the stored
 * data, the frozen result equalling a recomputation from its frozen data, the report, repeat and cancel, the gauge card, permissions and tenancy. The database rules
 * are in supabase/tests/gauge_rr.test.sql; the statistics in api/src/msa/*.spec.ts.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { analyseStudy, canonicalText, dataHash, frozenResult, type CellRow, type PartRow, type StudyHeader } from '../src/msa/msa-data';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a2f');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};
const daysFromToday = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-msa');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const a = await admin.query(`insert into public.gauges (organisation_id, asset_number, description, site_id, resolution, unit_code) values ($1, 'MSA-G1', 'Bore gauge', $2, 0.001, 'mm') returning id`, [ids.orgA, ids.siteA]);
  ctx.gauge = a.rows[0].id;
  const b = await admin.query(`insert into public.gauges (organisation_id, asset_number, description) values ($1, 'MSA-GB', 'Beta gauge') returning id`, [ids.orgB]);
  ctx.gaugeB = b.rows[0].id;
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

/** The same readings for every study, so a result can be checked: three appraisers' worth of small differences around each part's size. */
const reading = (a: number, p: number, t: number) => (25 + p * 0.01 + a * 0.002 + t * 0.001 + ((a * 7 + p * 3 + t) % 5) * 0.0004).toFixed(4);

/** Every cell of a study's run sheet with a reading (or decision), in one call. */
async function fillAll(study: string, user = ids.inspectorA, source: 'grid' | 'paste' = 'grid', skip = 0) {
  const detail = (await api().get(`/api/v1/msa/studies/${study}`).set(await as(ids.ownerA)).expect(200)).body;
  const cells = (detail.cells as { appraiser: number; part: number; trial: number }[]).slice(skip).map((c) =>
    detail.studyType === 'attribute'
      ? { appraiser: c.appraiser, part: c.part, trial: c.trial, decision: detail.parts[c.part - 1].referenceDecision as boolean }
      : { appraiser: c.appraiser, part: c.part, trial: c.trial, value: reading(c.appraiser, c.part, c.trial) },
  );
  return api().put(`/api/v1/msa/studies/${study}/measurements`).set(await as(user)).send({ cells, source });
}

describe('designing a study', () => {
  it('a viewer reads but does not design, an inspector records but does not design', async () => {
    const body = { studyType: 'grr_crossed', gaugeId: ctx.gauge };
    await api().post('/api/v1/msa/studies').set(await as(ids.dual)).send(body).expect(403);
    await api().post('/api/v1/msa/studies').set(await as(ids.inspectorA)).send(body).expect(403);
    await api().get('/api/v1/msa/studies').set(await as(ids.dual)).expect(200);
  });

  it('refuses unknown fields, bad shapes and another organisation\'s gauge', async () => {
    const h = await as(ids.ownerA);
    await api().post('/api/v1/msa/studies').set(h).send({ studyType: 'grr_crossed', gaugeId: ctx.gauge, colour: 'red' }).expect(400);
    await api().post('/api/v1/msa/studies').set(h).send({ studyType: 'made_up', gaugeId: ctx.gauge }).expect(400);
    await api().post('/api/v1/msa/studies').set(h).send({ studyType: 'grr_crossed', gaugeId: ctx.gauge, sigmaMultiplier: 4 }).expect(400);
    await api().post('/api/v1/msa/studies').set(h).send({ studyType: 'grr_crossed', gaugeId: ctx.gaugeB }).expect(404);
    const bad = await api().post('/api/v1/msa/studies').set(h).send({ studyType: 'grr_crossed', gaugeId: ctx.gauge, partCount: 1 }).expect(409);
    expect(bad.body.error.code).toBe('msa_rule');
    expect(bad.body.error.message).toMatch(/2 to 50 parts/);
  });

  it('a part\'s released characteristic brings its name, unit and limits', async () => {
    const h = await as(ids.ownerA);
    const part = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'MSA-P1', name: 'Bore part', initialRevision: { revision: 'A' } }).expect(201)).body;
    ctx.part = part.id;
    await api().post(`/api/v1/part-revisions/${part.revisions[0].id}/characteristics`).set(h).send({ characteristicKey: 'bore', description: 'Bore diameter', nominal: 25, lowerLimit: 24.9, upperLimit: 25.1, unitCode: 'mm' }).expect(201);
    await api().post(`/api/v1/part-revisions/${part.revisions[0].id}/release`).set(h).expect(200);
    const unknown = await api().post('/api/v1/msa/studies').set(h).send({ studyType: 'grr_crossed', gaugeId: ctx.gauge, partId: ctx.part, characteristicKey: 'nope' }).expect(400);
    expect(unknown.body.error.code).toBe('unknown_characteristic');
    const made = (
      await api().post('/api/v1/msa/studies').set(h).send({ studyType: 'grr_crossed', gaugeId: ctx.gauge, partId: ctx.part, characteristicKey: 'bore', partCount: 3, appraiserCount: 2, trialCount: 2 }).expect(201)
    ).body;
    ctx.crossed = made.id;
    expect(made).toMatchObject({
      reference: expect.stringMatching(/^MSA-\d{2}-0001$/), studyType: 'grr_crossed', status: 'draft', characteristicKey: 'BORE', characteristicName: 'Bore diameter', unitCode: 'mm',
      partCount: 3, appraiserCount: 2, trialCount: 2, progress: { filled: 0, total: 12 }, canManage: true, canRecord: false, verdict: null,
      gauge: { assetNumber: 'MSA-G1' }, part: { partNumber: 'MSA-P1' },
      design: { nominal: 25, lowerLimit: 24.9, upperLimit: 25.1, gaugeResolution: 0.001, sigmaMultiplier: 6, interactionAlpha: 0.05, kPercent: 20, lMultiplier: 6 },
    });
    expect(made.appraisers.map((a: { name: string }) => a.name)).toEqual(['Appraiser 1', 'Appraiser 2']);
    expect(made.parts.map((p: { label: string }) => p.label)).toEqual(['Part 1', 'Part 2', 'Part 3']);
    expect(made.cells).toEqual([]);
    const read = (await api().get(`/api/v1/msa/studies/${made.id}`).set(h).expect(200)).body;
    expect(typeof read.rowVersion).toBe('string');
  });

  it('the design changes while it is a draft, with the appraisers from the Employees register', async () => {
    const h = await as(ids.ownerA);
    const emp = (await admin.query(`insert into public."Employees" (organisation_id, first_name, surname, active) values ($1, 'Ada', 'Lovelace', true) returning id`, [ids.orgA])).rows[0].id;
    const changed = (
      await api().patch(`/api/v1/msa/studies/${ctx.crossed}`).set(h).send({ appraisers: [{ employeeId: emp }, { name: 'Visitor' }], parts: [{ label: 'P1' }, { label: 'P2' }, { label: 'P3' }] }).expect(200)
    ).body;
    expect(changed.appraisers.map((a: { name: string; employeeId: string | null }) => [a.name, a.employeeId !== null])).toEqual([['Ada Lovelace', true], ['Visitor', false]]);
    expect(changed.parts.map((p: { label: string }) => p.label)).toEqual(['P1', 'P2', 'P3']);
    await api().patch(`/api/v1/msa/studies/${ctx.crossed}`).set(h).send({ parts: [{ label: 'X' }, { label: 'x' }] }).expect(409);
    await api().patch(`/api/v1/msa/studies/${ctx.crossed}`).set(await as(ids.inspectorA)).send({ characteristicName: 'Hack' }).expect(403);
  });
});

describe('collecting readings', () => {
  it('starting makes the empty run sheet and locks the design; the inspector cannot start', async () => {
    await api().post(`/api/v1/msa/studies/${ctx.crossed}/start`).set(await as(ids.inspectorA)).expect(403);
    const started = (await api().post(`/api/v1/msa/studies/${ctx.crossed}/start`).set(await as(ids.ownerA)).expect(200)).body;
    expect(started).toMatchObject({ status: 'collecting', progress: { filled: 0, total: 12 }, canManage: true });
    expect(started.cells).toHaveLength(12);
    expect(started.cells.every((c: { value: string | null; runOrder: number }) => c.value === null && c.runOrder >= 1 && c.runOrder <= 3)).toBe(true);
    await api().patch(`/api/v1/msa/studies/${ctx.crossed}`).set(await as(ids.ownerA)).send({ partCount: 5 }).expect(409);
    await api().post(`/api/v1/msa/studies/${ctx.crossed}/start`).set(await as(ids.ownerA)).expect(409);
  });

  it('an inspector records readings; a viewer cannot; values are kept as typed', async () => {
    const cells = [{ appraiser: 1, part: 1, trial: 1, value: '25.010' }, { appraiser: 1, part: 2, trial: 1, value: 24.98 }];
    await api().put(`/api/v1/msa/studies/${ctx.crossed}/measurements`).set(await as(ids.dual)).send({ cells }).expect(403);
    const done = await api().put(`/api/v1/msa/studies/${ctx.crossed}/measurements`).set(await as(ids.inspectorA)).send({ cells, source: 'paste' }).expect(200);
    expect(done.body).toEqual({ recorded: 2, progress: { filled: 2, total: 12 } });
    const detail = (await api().get(`/api/v1/msa/studies/${ctx.crossed}`).set(await as(ids.dual)).expect(200)).body;
    const cell = detail.cells.find((c: { appraiser: number; part: number; trial: number }) => c.appraiser === 1 && c.part === 1 && c.trial === 1);
    expect(cell).toMatchObject({ value: '25.010', source: 'paste', enteredAt: expect.any(String) });
    expect(detail.canRecord).toBe(false);
    await api().put(`/api/v1/msa/studies/${ctx.crossed}/measurements`).set(await as(ids.inspectorA)).send({ cells: [{ appraiser: 9, part: 1, trial: 1, value: 1 }] }).expect(409);
    await api().put(`/api/v1/msa/studies/${ctx.crossed}/measurements`).set(await as(ids.inspectorA)).send({ cells: [{ appraiser: 1, part: 1, trial: 1, value: 'abc' }] }).expect(400);
    await api().put(`/api/v1/msa/studies/${ctx.crossed}/measurements`).set(await as(ids.inspectorA)).send({ cells: [{ appraiser: 1, part: 1, trial: 1, decision: true }] }).expect(409);
  });

  it('pasted text becomes cells without saving, with the rows that cannot be placed', async () => {
    const h = await as(ids.inspectorA);
    const ok = (await api().post(`/api/v1/msa/studies/${ctx.crossed}/measurements/parse`).set(h).send({ text: 'appraiser\tpart\ttrial\tvalue\nAda Lovelace\tP3\t1\t25,031\n2\tP3\t2\t25.030' }).expect(200)).body;
    expect(ok.ok).toBe(true);
    expect(ok.cells.map((c: { appraiser: number; part: number; trial: number; value: string }) => [c.appraiser, c.part, c.trial, c.value])).toEqual([[1, 3, 1, '25.031'], [2, 3, 2, '25.030']]);
    const bad = (await api().post(`/api/v1/msa/studies/${ctx.crossed}/measurements/parse`).set(h).send({ text: 'appraiser,part,trial,value\nNobody,P1,1,1\nAda Lovelace,P1,1,x' }).expect(200)).body;
    expect(bad.ok).toBe(false);
    expect(bad.problems.map((p: { line: number }) => p.line)).toEqual([2, 3]);
    const stored = (await api().get(`/api/v1/msa/studies/${ctx.crossed}`).set(h).expect(200)).body;
    expect(stored.progress.filled).toBe(2);
    await api().post(`/api/v1/msa/studies/${ctx.crossed}/measurements/parse`).set(await as(ids.dual)).send({ text: 'x' }).expect(403);
  });

  it('the live analysis says what is missing, then gives the result once every reading is in', async () => {
    const h = await as(ids.ownerA);
    const early = (await api().get(`/api/v1/msa/studies/${ctx.crossed}/analysis`).set(h).expect(200)).body;
    expect(early).toMatchObject({ frozen: false, complete: false, filled: 2, total: 12, result: null, problem: '10 of 12 readings are still missing.' });
    await api().post(`/api/v1/msa/studies/${ctx.crossed}/complete`).set(h).send({ conclusion: 'accepted', note: 'Too early' }).expect(409);
    const done = await fillAll(ctx.crossed, ids.inspectorA, 'grid');
    expect(done.status).toBe(200);
    expect(done.body.progress).toEqual({ filled: 12, total: 12 });
    const full = (await api().get(`/api/v1/msa/studies/${ctx.crossed}/analysis`).set(h).expect(200)).body;
    expect(full).toMatchObject({ frozen: false, complete: true, problem: null, result: { studyType: 'grr_crossed', algorithm: 'msa-1', criteria: 'aiag-msa-4' } });
    expect(full.result.verdict).toHaveProperty('band');
  });
});

describe('completing', () => {
  it('needs calibration.manage; refuses a note that is too short and a validity in the past', async () => {
    await api().post(`/api/v1/msa/studies/${ctx.crossed}/complete`).set(await as(ids.inspectorA)).send({ conclusion: 'accepted', note: 'Fine by me' }).expect(403);
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/msa/studies/${ctx.crossed}/complete`).set(h).send({ conclusion: 'accepted', note: 'x' }).expect(400);
    await api().post(`/api/v1/msa/studies/${ctx.crossed}/complete`).set(h).send({ conclusion: 'maybe', note: 'Fine' }).expect(400);
    const past = await api().post(`/api/v1/msa/studies/${ctx.crossed}/complete`).set(h).send({ conclusion: 'accepted', note: 'Fine', validUntil: daysFromToday(-1) }).expect(409);
    expect(past.body.error.code).toBe('msa_rule');
  });

  it('freezes the study with a result equal to a recomputation from its frozen data', async () => {
    const h = await as(ids.ownerA);
    const done = (await api().post(`/api/v1/msa/studies/${ctx.crossed}/complete`).set(h).send({ conclusion: 'accepted_with_conditions', note: 'Repeat after the next calibration' }).expect(200)).body;
    expect(done).toMatchObject({
      status: 'completed', conclusion: 'accepted_with_conditions', conclusionNote: 'Repeat after the next calibration', algorithmVersion: 'msa-1', criteriaId: 'aiag-msa-4',
      validity: { state: 'valid' }, canManage: false, canRecord: false,
    });
    expect(['acceptable', 'marginal', 'unacceptable']).toContain(done.verdict);
    expect(done.headline.pctGrr).not.toBeNull();
    expect(done.completedBy).toBe('Ada Owner');

    // Recompute from the stored rows, building the canonical text in TypeScript: it must equal what the database hashed and the result must equal what was frozen.
    const s = (
      await admin.query(
        `select study_type, part_count, appraiser_count, trial_count, coalesce(nominal::text, '') nominal, coalesce(lower_limit::text, '') lower_limit, coalesce(upper_limit::text, '') upper_limit,
                coalesce(gauge_resolution::text, '') resolution, sigma_multiplier::text sigma, interaction_alpha::text alpha, coalesce(reference_value::text, '') reference_value,
                k_percent::text k, l_multiplier::text l from public.msa_studies where id = $1`,
        [ctx.crossed],
      )
    ).rows[0];
    const header: StudyHeader = {
      studyType: s.study_type, partCount: s.part_count, appraiserCount: s.appraiser_count, trialCount: s.trial_count, nominal: s.nominal, lowerLimit: s.lower_limit, upperLimit: s.upper_limit,
      resolution: s.resolution, sigma: s.sigma, alpha: s.alpha, referenceValue: s.reference_value, kPercent: s.k, lMultiplier: s.l,
    };
    const parts: PartRow[] = (await admin.query(`select position, label, reference_decision from public.msa_study_parts where study_id = $1 order by position`, [ctx.crossed])).rows.map(
      (r) => ({ position: r.position, label: r.label, referenceDecision: r.reference_decision }),
    );
    const cells: CellRow[] = (
      await admin.query(
        `select a.position appraiser, p.position part, m.trial, m.value::text value, m.decision from public.msa_study_measurements m
           join public.msa_study_appraisers a on a.id = m.appraiser_id join public.msa_study_parts p on p.id = m.part_id where m.study_id = $1`,
        [ctx.crossed],
      )
    ).rows;
    const stored = (await admin.query(`select result, data_hash, verdict, encode(sha256(convert_to(app.msa_data_canonical($1), 'UTF8')), 'hex') as sql_hash from public.msa_study_results where study_id = $1`, [ctx.crossed])).rows[0];
    expect(canonicalText(header, parts, cells)).toBe((await admin.query(`select app.msa_data_canonical($1) as t`, [ctx.crossed])).rows[0].t);
    expect(dataHash(header, parts, cells)).toBe(stored.data_hash);
    expect(stored.sql_hash).toBe(stored.data_hash);
    const again = analyseStudy(header, parts, cells);
    expect(again.complete).toBe(true);
    expect(JSON.parse(JSON.stringify(frozenResult(again.analysis!)))).toEqual(stored.result);
    expect(stored.verdict).toBe(done.verdict);
  });

  it('is frozen: the analysis is the stored result, readings and the design no longer change, it cannot be cancelled', async () => {
    const h = await as(ids.ownerA);
    const frozen = (await api().get(`/api/v1/msa/studies/${ctx.crossed}/analysis`).set(h).expect(200)).body;
    expect(frozen).toMatchObject({ frozen: true, complete: true, dataHash: expect.stringMatching(/^[0-9a-f]{64}$/), result: { algorithm: 'msa-1' } });
    await api().put(`/api/v1/msa/studies/${ctx.crossed}/measurements`).set(await as(ids.inspectorA)).send({ cells: [{ appraiser: 1, part: 1, trial: 1, value: 1 }] }).expect(409);
    await api().patch(`/api/v1/msa/studies/${ctx.crossed}`).set(h).send({ characteristicName: 'Changed' }).expect(409);
    await api().post(`/api/v1/msa/studies/${ctx.crossed}/cancel`).set(h).send({ reason: 'too late to cancel' }).expect(409);
    await api().post(`/api/v1/msa/studies/${ctx.crossed}/complete`).set(h).send({ conclusion: 'accepted', note: 'Again' }).expect(409);
  });

  it('the report carries the study, the frozen result and whether the data still matches its hash', async () => {
    const report = (await api().get(`/api/v1/msa/studies/${ctx.crossed}/report`).set(await as(ids.dual)).expect(200)).body;
    expect(report).toMatchObject({ dataMatchesResult: true, study: { status: 'completed', cells: expect.any(Array) }, result: { studyType: 'grr_crossed' } });
    expect(report.study.cells).toHaveLength(12);
  });

  it('a result for other data is refused by the database (the stale-hash rule), whoever calls', async () => {
    const study = (await api().post('/api/v1/msa/studies').set(await as(ids.ownerA)).send({ studyType: 'type1', gaugeId: ctx.gauge, characteristicName: 'Master ring', referenceValue: '25.000', trialCount: 5, nominal: 25, lowerLimit: 24.9, upperLimit: 25.1 }).expect(201)).body;
    await api().post(`/api/v1/msa/studies/${study.id}/start`).set(await as(ids.ownerA)).expect(200);
    await fillAll(study.id);
    const r = await admin.query(
      `select app.system_complete_msa_study($1, $2, $3, 'accepted', 'Tampered', null, '{"algorithm":"msa-1","criteria":"aiag-msa-4","verdict":{"band":"acceptable"}}'::jsonb, $4)`,
      [ids.orgA, study.id, ids.ownerA, '0'.repeat(64)],
    ).then(() => 'ok', (e: Error) => e.message);
    expect(r).toMatch(/not worked out from the readings now stored/);
    ctx.type1 = study.id;
  });
});

describe('the other study types', () => {
  it('a Type 1 study completes with Cg and Cgk and the readings in the order of the trials', async () => {
    const h = await as(ids.ownerA);
    const analysis = (await api().get(`/api/v1/msa/studies/${ctx.type1}/analysis`).set(h).expect(200)).body;
    expect(analysis.result).toMatchObject({ studyType: 'type1', n: 5, reference: 25 });
    expect(analysis.result.cg).not.toBeNull();
    const done = (await api().post(`/api/v1/msa/studies/${ctx.type1}/complete`).set(h).send({ conclusion: 'accepted', note: 'Gauge is capable', validUntil: daysFromToday(90) }).expect(200)).body;
    expect(done).toMatchObject({ status: 'completed', studyType: 'type1', validUntil: daysFromToday(90), validity: { state: 'valid', daysLeft: 90 } });
    expect(done.headline.cgk).not.toBeNull();
  });

  it('an attribute study takes decisions, and its result counts effectiveness against the reference', async () => {
    const h = await as(ids.ownerA);
    const study = (
      await api().post('/api/v1/msa/studies').set(h).send({
        studyType: 'attribute', gaugeId: ctx.gauge, characteristicName: 'Go / no-go', appraiserCount: 2, trialCount: 1,
        parts: [true, false, true, false, true, false].map((d, i) => ({ label: `S${i + 1}`, referenceDecision: d })),
      }).expect(201)
    ).body;
    await api().post(`/api/v1/msa/studies/${study.id}/start`).set(h).expect(200);
    await api().put(`/api/v1/msa/studies/${study.id}/measurements`).set(await as(ids.inspectorA)).send({ cells: [{ appraiser: 1, part: 1, trial: 1, value: 1 }] }).expect(409);
    const filled = await fillAll(study.id);
    expect(filled.status).toBe(200);
    const done = (await api().post(`/api/v1/msa/studies/${study.id}/complete`).set(h).send({ conclusion: 'accepted', note: 'Perfect agreement' }).expect(200)).body;
    expect(done).toMatchObject({ status: 'completed', verdict: 'acceptable', headline: { effectiveness: 1 } });
    ctx.attribute = study.id;
  });
});

describe('repeat, cancel, lists and the gauge page', () => {
  it('a repeat is a new draft with the same design and no readings; only a completed study is repeated', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/msa/studies/${ctx.crossed}/repeat`).set(await as(ids.inspectorA)).expect(403);
    const again = (await api().post(`/api/v1/msa/studies/${ctx.crossed}/repeat`).set(h).expect(201)).body;
    ctx.repeat = again.id;
    expect(again).toMatchObject({ status: 'draft', repeatOfId: ctx.crossed, partCount: 3, appraiserCount: 2, trialCount: 2, characteristicKey: 'BORE', reference: expect.stringMatching(/-0004$/) });
    expect(again.appraisers.map((a: { name: string }) => a.name)).toEqual(['Ada Lovelace', 'Visitor']);
    await api().post(`/api/v1/msa/studies/${again.id}/repeat`).set(h).expect(409);
  });

  it('a draft is cancelled with a reason and stays in the record', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/msa/studies/${ctx.repeat}/cancel`).set(h).send({ reason: 'no' }).expect(400);
    const cancelled = (await api().post(`/api/v1/msa/studies/${ctx.repeat}/cancel`).set(h).send({ reason: 'Started by mistake' }).expect(200)).body;
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelReason: 'Started by mistake' });
    await api().post(`/api/v1/msa/studies/${ctx.repeat}/start`).set(h).expect(409);
  });

  it('lists page by page with filters, search and sorting; cancelled studies are left out unless asked for', async () => {
    const h = await as(ids.dual);
    const all = (await api().get('/api/v1/msa/studies').set(h).expect(200)).body;
    expect(all).toMatchObject({ page: 1, pageSize: 50, total: 3 });
    expect(all.data.map((s: { studyType: string }) => s.studyType).sort()).toEqual(['attribute', 'grr_crossed', 'type1']);
    expect((await api().get('/api/v1/msa/studies?status=cancelled').set(h).expect(200)).body.total).toBe(1);
    expect((await api().get('/api/v1/msa/studies?type=type1').set(h).expect(200)).body.data[0].reference).toMatch(/^MSA-/);
    expect((await api().get('/api/v1/msa/studies?q=go%20%2F%20no').set(h).expect(200)).body.total).toBe(1);
    expect((await api().get('/api/v1/msa/studies?q=MSA-G1').set(h).expect(200)).body.total).toBe(3);
    expect((await api().get('/api/v1/msa/studies?verdict=acceptable').set(h).expect(200)).body.data.every((s: { verdict: string }) => s.verdict === 'acceptable')).toBe(true);
    expect((await api().get('/api/v1/msa/studies?valid=valid').set(h).expect(200)).body.total).toBe(3);
    expect((await api().get('/api/v1/msa/studies?valid=expired').set(h).expect(200)).body.total).toBe(0);
    expect((await api().get('/api/v1/msa/studies?valid=expiring').set(h).expect(200)).body.total).toBe(0);
    const page = (await api().get('/api/v1/msa/studies?pageSize=2&page=2&sort=reference&order=asc').set(h).expect(200)).body;
    expect(page).toMatchObject({ page: 2, pageSize: 2, total: 3 });
    expect(page.data).toHaveLength(1);
    await api().get('/api/v1/msa/studies?sort=nonsense').set(h).expect(400);
    await api().get('/api/v1/msa/studies?status=bogus').set(h).expect(400);
  });

  it('the gauge page shows the current study per characteristic and what is open', async () => {
    const card = (await api().get(`/api/v1/gauges/${ctx.gauge}/msa`).set(await as(ids.dual)).expect(200)).body;
    expect(card.current.map((s: { studyType: string }) => s.studyType).sort()).toEqual(['attribute', 'grr_crossed', 'type1']);
    expect(card.open).toEqual([]);
    expect(card.earlier).toEqual([]);
    await api().get(`/api/v1/gauges/${ctx.gaugeB}/msa`).set(await as(ids.ownerA)).expect(404);
  });
});

describe('tenancy', () => {
  it('another organisation sees none of it and cannot reach it', async () => {
    const b = await as(ids.ownerB, ids.orgB);
    expect((await api().get('/api/v1/msa/studies').set(b).expect(200)).body.total).toBe(0);
    for (const path of ['', '/analysis', '/report']) await api().get(`/api/v1/msa/studies/${ctx.crossed}${path}`).set(b).expect(404);
    await api().post(`/api/v1/msa/studies/${ctx.crossed}/repeat`).set(b).expect(404);
    await api().put(`/api/v1/msa/studies/${ctx.crossed}/measurements`).set(b).send({ cells: [{ appraiser: 1, part: 1, trial: 1, value: 1 }] }).expect(404);
    await api().post('/api/v1/msa/studies').set(b).send({ studyType: 'grr_crossed', gaugeId: ctx.gauge }).expect(404);
    // the same id sent as the other organisation's member must not complete it either
    await api().post(`/api/v1/msa/studies/${ctx.crossed}/complete`).set(b).send({ conclusion: 'accepted', note: 'Nope' }).expect(404);
  });
});
