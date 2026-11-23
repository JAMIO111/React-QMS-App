/**
 * Alert evaluation on a save reads only the recent inspections when a saved baseline fixes the limits. That must never change which alerts are
 * raised: the windowed evaluation is compared with the full one at many points in the history and window sizes (small ones force the window to
 * widen), for a measured I-MR chart and a pass/fail P chart, and the save path itself is shown to use the window and still alert.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { DatabaseService } from '../src/database/database.service';
import { alertInput, SpcService } from '../src/spc/spc.service';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('b3');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};

const INSPECTIONS = 26;
const PER = 6; // samples per inspection; every sample reads both characteristics
// A repeatable wobble, with a spike, a run on one side of the centre line and a pair beyond two sigma, so every kind of rule has something to find.
const od = (i: number) => {
  const wobble = [0, 0.012, -0.011, 0.006, -0.008, 0.01, -0.012, 0.004][i % 8];
  const shift = i >= 60 && i <= 80 ? 0.02 : 0; // a stretch on the high side: the zone and run rules
  const spike = i === 100 ? 0.045 : i === 120 ? -0.045 : 0;
  return (25 + wobble + shift + spike).toFixed(3);
};
const failsIn = (inspection: number) => [1, 0, 2, 1, 0, 1, 5, 1, 0, 2][inspection % 10]; // a spike at every tenth inspection (of six checks)
const spc = () => app.get(SpcService);
const user = (id: string) => ({ user: { id, claims: { sub: id, role: 'authenticated' } }, correlationId: 'window', organisationId: ids.orgA });
const part = (key: string, name: string): Record<string, unknown> => ({ part_id: ctx.part, part_number: 'HCR-100', characteristic_key: key, operation_code: 'OP-020', name });

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-spcwin');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA);
  const fam = (await api().post('/api/v1/part-families').set(h).send({ code: 'HCR', name: 'Rods' }).expect(201)).body;
  const p = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'HCR-100', name: 'Rod 100', partFamilyId: fam.id, initialRevision: { revision: 'A' } }).expect(201)).body;
  ctx.part = p.id;
  await api().post(`/api/v1/part-revisions/${p.revisions[0].id}/release`).set(h).expect(200);
  const plan = (await api().post('/api/v1/control-plans').set(h).send({ planCode: 'CP-1', title: 'Rods', partFamilyId: fam.id }).expect(201)).body;
  const planRev = plan.revisions[0].id;
  const rev = (await api().post(`/api/v1/control-plan-revisions/${planRev}/operations`).set(h).send({ operationCode: 'OP-020', name: 'Turning' }).expect(201)).body;
  const op = rev.operations[0].id;
  const add = (body: object) => api().post(`/api/v1/control-plan-revisions/${planRev}/characteristics`).set(h).send({ operationId: op, ...body }).expect(201);
  await add({ characteristicKey: 'OD', name: 'Outer diameter', nominal: 25, lowerLimit: 24.95, upperLimit: 25.05, unitCode: 'mm', criticality: 'major', spcEligible: true, chartType: 'imr', subgroupSize: 1, sampling: [{ triggerType: 'first_off', sampleSize: PER }] });
  await add({ characteristicKey: 'VISUAL', name: 'No chatter marks', dataType: 'attribute', spcEligible: true, criticality: 'minor', sampling: [{ triggerType: 'first_off', sampleSize: PER }] });
  await api().patch(`/api/v1/control-plan-revisions/${planRev}`).set(h).send({ changeReason: 'First' }).expect(200);
  await api().post(`/api/v1/control-plan-revisions/${planRev}/transitions`).set(h).send({ action: 'submit' }).expect(200);
  await api().post(`/api/v1/control-plan-revisions/${planRev}/transitions`).set(h).send({ action: 'approve' }).expect(200);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('windowed alert evaluation', () => {
  it('records the history (no baseline yet, so every save reads everything)', async () => {
    const h = await as(ids.ownerA);
    for (let i = 0; i < INSPECTIONS; i++) {
      const rec = (await api().post('/api/v1/inspections').set(h).send({ siteId: ids.siteA, partId: ctx.part, triggerType: 'first_off' }).expect(201)).body;
      const req = (key: string) => rec.requirements.find((q: { characteristicKey: string }) => q.characteristicKey === key).id;
      for (let sample = 0; sample < PER; sample++) {
        await api()
          .post(`/api/v1/inspections/${rec.id}/samples`)
          .set(h)
          .send({ readings: [{ requirementId: req('OD'), valueNumeric: od(i * PER + sample) }, { requirementId: req('VISUAL'), valuePass: sample >= failsIn(i) }] })
          .expect(201);
      }
    }
  }, 240_000);

  it('without a saved baseline the whole history is read (trial limits depend on all of it)', async () => {
    const db = app.get(DatabaseService);
    const readings = jest.spyOn(spc() as unknown as { readings: (...a: unknown[]) => unknown }, 'readings');
    await db.asUser(user(ids.ownerA), async (tx) => {
      const found = await spc().alertSignals(tx, user(ids.ownerA) as never, part('OD', 'Outer diameter') as never, Date.now() - 3600_000, { start: 3 });
      expect(found?.baseline).toBeNull();
    });
    expect(readings.mock.calls.length).toBe(1); // straight to the full read: no probe, no window tried first
    expect(readings.mock.calls.every((c) => (c[2] as { inspectionIds?: string[] }).inspectionIds === undefined)).toBe(true);
    readings.mockRestore();
  });

  it('with a saved baseline gives exactly the signals of the full evaluation, wherever the new points are and however small the first window', async () => {
    const h = await as(ids.ownerA);
    await api().post('/api/v1/spc/baselines').set(h).send({ partId: ctx.part, characteristicKey: 'OD', operationCode: 'OP-020', firstN: 20 }).expect(201);
    await api().post('/api/v1/spc/baselines').set(h).send({ partId: ctx.part, characteristicKey: 'VISUAL', operationCode: 'OP-020', subgroup: 'inspection', firstN: 10 }).expect(201);

    const db = app.get(DatabaseService);
    const service = spc() as unknown as { readings: (...a: unknown[]) => Promise<{ measuredAt: string }[]>; groupSignals: (...a: unknown[]) => Promise<{ variant: string; baseline: { id: string } | null; signals: unknown[] } | null> };
    const readings = jest.spyOn(service, 'readings');
    let compared = 0;
    let withSignals = 0;
    let windowed = 0;
    for (const [key, name] of [['OD', 'Outer diameter'], ['VISUAL', 'No chatter marks']] as const) {
      await db.asUser(user(ids.ownerA), async (tx) => {
        const g = part(key, name);
        const f = { partId: ctx.part, characteristicKey: key, operationCode: 'OP-020' };
        const all = await service.readings(tx, user(ids.ownerA), f);
        const times = [...new Set(all.map((r) => new Date(r.measuredAt).getTime()))].sort((a, b) => a - b);
        for (let j = 14; j < times.length; j += 5) {
          const since = times[j] - 1;
          const full = await service.groupSignals(tx, user(ids.ownerA), g, all, since);
          expect(full?.baseline).not.toBeNull();
          for (const start of [1, 3, 24]) {
            readings.mockClear();
            const quick = await spc().alertSignals(tx, user(ids.ownerA) as never, g as never, since, { start });
            windowed += readings.mock.calls.filter((c) => (c[2] as { inspectionIds?: string[] }).inspectionIds !== undefined).length;
            expect(quick).toMatchObject({ variant: full!.variant, baseline: { id: full!.baseline!.id } });
            // what an alert stores (not the point's position in the series, which depends on how much history was read)
            const stored = (f: NonNullable<typeof full>) => f.signals.map((sg) => alertInput(f.variant as never, sg as never));
            expect(stored(quick as never)).toEqual(stored(full!));
            compared++;
            if (full!.signals.length) withSignals++;
          }
        }
      });
    }
    readings.mockRestore();
    expect(compared).toBeGreaterThan(30);
    expect(withSignals).toBeGreaterThan(5); // the comparison is not vacuous
    expect(windowed).toBeGreaterThan(20); // and the window really was used
  }, 240_000);

  it('a save with a saved baseline alerts on a spike using the window', async () => {
    const h = await as(ids.ownerA);
    const rec = (await api().post('/api/v1/inspections').set(h).send({ siteId: ids.siteA, partId: ctx.part, triggerType: 'first_off' }).expect(201)).body;
    const readings = jest.spyOn(spc() as unknown as { readings: (...a: unknown[]) => unknown }, 'readings');
    const req = (key: string) => rec.requirements.find((q: { characteristicKey: string }) => q.characteristicKey === key).id;
    await api().post(`/api/v1/inspections/${rec.id}/samples`).set(h).send({ readings: [{ requirementId: req('OD'), valueNumeric: '25.049' }, { requirementId: req('VISUAL'), valuePass: true }] }).expect(201);
    expect(readings.mock.calls.some((c) => (c[2] as { inspectionIds?: string[] }).inspectionIds !== undefined)).toBe(true);
    readings.mockRestore();
    const alerts = (await api().get(`/api/v1/spc/alerts?partId=${ctx.part}&status=open`).set(h).expect(200)).body.data as { characteristicKey: string; rule: string; inspection: { id: string } | null }[];
    expect(alerts.some((a) => a.characteristicKey === 'OD' && a.rule === 'we1' && a.inspection?.id === rec.id)).toBe(true);
  }, 60_000);
});
