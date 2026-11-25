/**
 * Gauge R&R coverage (MS5) through the API: every critical or major characteristic of an effective control plan against the gauges that measured it in the last
 * twelve months and the state of the latest study of that gauge and characteristic. Minor characteristics are left out, a characteristic nobody measured says so,
 * an expired study no longer counts, and another organisation sees nothing of it.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a3f');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};
const READINGS = ['25.001', '24.999', '25.000', '25.002', '24.998'];

async function study(gauge: string, conclusion: 'accepted' | 'not_accepted') {
  const h = await as(ids.ownerA);
  const created = (
    await api()
      .post('/api/v1/msa/studies')
      .set(h)
      .send({ studyType: 'type1', gaugeId: gauge, characteristicKey: 'OD', characteristicName: 'Outer diameter', unitCode: 'mm', lowerLimit: 24.95, upperLimit: 25.05, referenceValue: 25, partCount: 1, appraiserCount: 1, trialCount: 5 })
      .expect(201)
  ).body;
  await api().post(`/api/v1/msa/studies/${created.id}/start`).set(h).expect(200);
  const detail = (await api().get(`/api/v1/msa/studies/${created.id}`).set(h).expect(200)).body;
  const cells = (detail.cells as { appraiser: number; part: number; trial: number }[]).map((c, i) => ({ appraiser: c.appraiser, part: c.part, trial: c.trial, value: READINGS[i] }));
  await api().put(`/api/v1/msa/studies/${created.id}/measurements`).set(await as(ids.ownerA)).send({ cells, source: 'grid' }).expect(200);
  await api().post(`/api/v1/msa/studies/${created.id}/complete`).set(h).send({ conclusion, note: 'For the coverage test' }).expect(200);
  return created.id as string;
}

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-msacov');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const gauge = async (n: string) => (await admin.query(`insert into public.gauges (organisation_id, asset_number, description, site_id, resolution, unit_code) values ($1, $2, $3, $4, 0.001, 'mm') returning id`, [ids.orgA, n, `Gauge ${n}`, ids.siteA])).rows[0].id as string;
  ctx.g1 = await gauge('COV-G1');
  ctx.g2 = await gauge('COV-G2');
  ctx.g3 = await gauge('COV-G3');
  ctx.g4 = await gauge('COV-G4');

  const h = await as(ids.ownerA);
  const fam = (await api().post('/api/v1/part-families').set(h).send({ code: 'COV', name: 'Coverage family' }).expect(201)).body;
  const p = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'COV-100', name: 'Coverage part', partFamilyId: fam.id, initialRevision: { revision: 'A' } }).expect(201)).body;
  ctx.part = p.id;
  await api().post(`/api/v1/part-revisions/${p.revisions[0].id}/release`).set(h).expect(200);
  const plan = (await api().post('/api/v1/control-plans').set(h).send({ planCode: 'CP-COV', title: 'Coverage plan', partFamilyId: fam.id }).expect(201)).body;
  ctx.plan = plan.id;
  const planRev = plan.revisions[0].id;
  const rev = (await api().post(`/api/v1/control-plan-revisions/${planRev}/operations`).set(h).send({ operationCode: 'OP-010', name: 'Turning' }).expect(201)).body;
  const op = rev.operations[0].id;
  const add = (body: object) => api().post(`/api/v1/control-plan-revisions/${planRev}/characteristics`).set(h).send({ operationId: op, ...body }).expect(201);
  const sampling = [{ triggerType: 'first_off', sampleSize: 3 }];
  await add({ characteristicKey: 'OD', name: 'Outer diameter', nominal: 25, lowerLimit: 24.95, upperLimit: 25.05, unitCode: 'mm', criticality: 'critical', sampling });
  await add({ characteristicKey: 'BORE', name: 'Bore', nominal: 10, lowerLimit: 9.95, upperLimit: 10.05, unitCode: 'mm', criticality: 'major', sampling });
  await add({ characteristicKey: 'CHAMFER', name: 'Chamfer', nominal: 1, lowerLimit: 0.9, upperLimit: 1.1, unitCode: 'mm', criticality: 'major', sampling });
  await add({ characteristicKey: 'FINISH', name: 'Finish', nominal: 1, lowerLimit: 0.5, upperLimit: 1.5, unitCode: 'mm', criticality: 'minor', sampling });
  await api().patch(`/api/v1/control-plan-revisions/${planRev}`).set(h).send({ changeReason: 'First' }).expect(200);
  await api().post(`/api/v1/control-plan-revisions/${planRev}/transitions`).set(h).send({ action: 'submit' }).expect(200);
  await api().post(`/api/v1/control-plan-revisions/${planRev}/transitions`).set(h).send({ action: 'approve' }).expect(200);

  // Readings: OD by gauges 1, 2 and 4; BORE by gauge 3; nobody measures CHAMFER; FINISH is minor.
  const rec = (await api().post('/api/v1/inspections').set(h).send({ siteId: ids.siteA, partId: ctx.part, triggerType: 'first_off' }).expect(201)).body;
  const req = (key: string) => rec.requirements.find((q: { characteristicKey: string }) => q.characteristicKey === key).id;
  // Every sample reads every applicable check; the chamfer is measured with no gauge recorded, so it has readings but no gauge to cover.
  const sample = (od: number, gauge: string) =>
    api()
      .post(`/api/v1/inspections/${rec.id}/samples`)
      .set(h)
      .send({
        
        readings: [
          { requirementId: req('OD'), valueNumeric: String(od), gaugeId: gauge },
          { requirementId: req('BORE'), valueNumeric: '10.001', gaugeId: ctx.g3 },
          { requirementId: req('CHAMFER'), valueNumeric: '1.0' },
          { requirementId: req('FINISH'), valueNumeric: '1.0', gaugeId: ctx.g3 },
        ],
      });
  for (const [od, g] of [[25.001, ctx.g1], [25.002, ctx.g2], [25.003, ctx.g4]] as [number, string][]) {
    const r = await sample(od, g);
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  }

  ctx.studyOk = await study(ctx.g1, 'accepted');
  ctx.studyNo = await study(ctx.g2, 'not_accepted');
  ctx.studyOld = await study(ctx.g4, 'accepted');
  // The study for gauge 4 was valid when it was made; make it a year old without going through the app (a completed study never changes through it).
  const c = await admin.connect();
  try {
    await c.query('begin');
    await c.query(`set local session_replication_role = replica`);
    await c.query(`update public.msa_studies set valid_until = current_date - 3 where id = $1`, [ctx.studyOld]);
    await c.query('commit');
  } finally {
    c.release();
  }
}, 120_000);

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

const rowsOf = (body: { rows: { characteristic: { key: string }; gauge: { assetNumber: string } | null; state: string }[] }) =>
  body.rows.map((r) => `${r.characteristic.key}:${r.gauge?.assetNumber ?? '-'}:${r.state}`).sort();

describe('coverage', () => {
  it('lists the critical and major characteristics against the gauges that measured them, with what each study says', async () => {
    const body = (await api().get('/api/v1/msa/coverage?state=all').set(await as(ids.ownerA)).expect(200)).body;
    expect(body.available).toBe(true);
    expect(rowsOf(body)).toEqual([
      'BORE:COV-G3:no_study',
      'CHAMFER:-:no_readings',
      'OD:COV-G1:acceptable',
      'OD:COV-G2:not_accepted',
      'OD:COV-G4:expired',
    ]);
    expect(body.counts).toMatchObject({ acceptable: 1, not_accepted: 1, expired: 1, no_study: 1, no_readings: 1, marginal: 0 });
    const g1 = body.rows.find((r: { gauge: { assetNumber: string } | null; characteristic: { key: string } }) => r.gauge?.assetNumber === 'COV-G1' && r.characteristic.key === 'OD');
    expect(g1).toMatchObject({ plan: { code: 'CP-COV' }, characteristic: { criticality: 'critical', operationCode: 'OP-010', nominal: '25', lowerLimit: '24.95', upperLimit: '25.05', unitCode: 'mm' }, readings: 1, part: { partNumber: 'COV-100' }, study: { id: ctx.studyOk, verdict: 'acceptable' } });
  });

  it('leaves minor characteristics out and by default shows only what needs a look', async () => {
    const all = (await api().get('/api/v1/msa/coverage?state=all').set(await as(ids.ownerA)).expect(200)).body;
    expect(all.rows.some((r: { characteristic: { key: string } }) => r.characteristic.key === 'FINISH')).toBe(false);
    const need = (await api().get('/api/v1/msa/coverage').set(await as(ids.ownerA)).expect(200)).body;
    expect(rowsOf(need)).toEqual(['BORE:COV-G3:no_study', 'OD:COV-G2:not_accepted', 'OD:COV-G4:expired']);
    expect(need.counts.acceptable).toBe(1); // the counts are of everything, not of what is shown
  });

  it('filters by state, gauge, plan and characteristic, and refuses nonsense', async () => {
    const h = await as(ids.ownerA);
    expect(rowsOf((await api().get('/api/v1/msa/coverage?state=expired,acceptable').set(h).expect(200)).body)).toEqual(['OD:COV-G1:acceptable', 'OD:COV-G4:expired']);
    expect(rowsOf((await api().get(`/api/v1/msa/coverage?state=all&gaugeId=${ctx.g3}`).set(h).expect(200)).body)).toEqual(['BORE:COV-G3:no_study']);
    expect(rowsOf((await api().get(`/api/v1/msa/coverage?state=all&controlPlanId=${ctx.plan}&characteristicKey=chamfer`).set(h).expect(200)).body)).toEqual(['CHAMFER:-:no_readings']);
    await api().get('/api/v1/msa/coverage?state=bogus').set(h).expect(400);
    await api().get('/api/v1/msa/coverage?gaugeId=not-a-uuid').set(h).expect(400);
  });

  it('a viewer reads it too, and another organisation sees none of it', async () => {
    expect((await api().get('/api/v1/msa/coverage?state=all').set(await as(ids.dual)).expect(200)).body.available).toBe(true);
    const b = (await api().get('/api/v1/msa/coverage?state=all').set(await as(ids.ownerB, ids.orgB)).expect(200)).body;
    expect(b.rows).toEqual([]);
    expect(b.counts.acceptable).toBe(0);
  });

  it('a study planned for a part and a characteristic written on its control plan takes the plan\'s limits, and still refuses a key that is nowhere', async () => {
    const h = await as(ids.ownerA);
    const made = (
      await api().post('/api/v1/msa/studies').set(h).send({ studyType: 'grr_crossed', gaugeId: ctx.g3, partId: ctx.part, characteristicKey: 'bore', partCount: 3, appraiserCount: 2, trialCount: 2 }).expect(201)
    ).body;
    expect(made).toMatchObject({ characteristicKey: 'BORE', characteristicName: 'Bore', unitCode: 'mm', design: { nominal: 10, lowerLimit: 9.95, upperLimit: 10.05 } });
    const nowhere = await api().post('/api/v1/msa/studies').set(h).send({ studyType: 'grr_crossed', gaugeId: ctx.g3, partId: ctx.part, characteristicKey: 'NOT_A_CHECK' }).expect(400);
    expect(nowhere.body.error.code).toBe('unknown_characteristic');
    await api().post(`/api/v1/msa/studies/${made.id}/cancel`).set(h).send({ reason: 'Only for the test' }).expect(200);
  });

  it('also finds a characteristic on a plan written for this one part, a part with no family', async () => {
    const h = await as(ids.ownerA);
    const part = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'COV-SOLO', name: 'Solo part', initialRevision: { revision: 'A' } }).expect(201)).body;
    const plan = (await api().post('/api/v1/control-plans').set(h).send({ planCode: 'CP-COV-SOLO', title: 'One part only' }).expect(201)).body;
    await api().post(`/api/v1/control-plans/${plan.id}/applicability`).set(h).send({ partId: part.id }).expect(201);
    const rev = plan.revisions[0].id;
    const op = (await api().post(`/api/v1/control-plan-revisions/${rev}/operations`).set(h).send({ operationCode: 'OP-900', name: 'Grinding' }).expect(201)).body.operations[0].id;
    await api().post(`/api/v1/control-plan-revisions/${rev}/characteristics`).set(h).send({ operationId: op, characteristicKey: 'SOLO_OD', name: 'Solo diameter', nominal: 30, lowerLimit: 29.9, upperLimit: 30.1, unitCode: 'mm', criticality: 'critical', sampling: [{ triggerType: 'first_off', sampleSize: 1 }] }).expect(201);
    await api().patch(`/api/v1/control-plan-revisions/${rev}`).set(h).send({ changeReason: 'First' }).expect(200);
    await api().post(`/api/v1/part-revisions/${part.revisions[0].id}/release`).set(h).expect(200);
    await api().post(`/api/v1/control-plan-revisions/${rev}/transitions`).set(h).send({ action: 'submit' }).expect(200);
    await api().post(`/api/v1/control-plan-revisions/${rev}/transitions`).set(h).send({ action: 'approve' }).expect(200);
    const made = (await api().post('/api/v1/msa/studies').set(h).send({ studyType: 'grr_crossed', gaugeId: ctx.g3, partId: part.id, characteristicKey: 'solo_od' }).expect(201)).body;
    expect(made).toMatchObject({ characteristicKey: 'SOLO_OD', characteristicName: 'Solo diameter', unitCode: 'mm', design: { nominal: 30, lowerLimit: 29.9, upperLimit: 30.1 } });
    await api().post(`/api/v1/msa/studies/${made.id}/cancel`).set(h).send({ reason: 'Only for the test' }).expect(200);
  });

  it('a study of the same gauge for another characteristic does not cover this one', async () => {
    const h = await as(ids.ownerA);
    const created = (await api().post('/api/v1/msa/studies').set(h).send({ studyType: 'grr_crossed', gaugeId: ctx.g3, characteristicKey: 'OTHER', characteristicName: 'Something else' }).expect(201)).body;
    expect(created.status).toBe('draft');
    expect(rowsOf((await api().get(`/api/v1/msa/coverage?state=all&gaugeId=${ctx.g3}`).set(h).expect(200)).body)).toEqual(['BORE:COV-G3:no_study']);
  });
});
