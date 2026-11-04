/**
 * Process control PC2 through the API: operations and characteristics (fixed, part-specific,
 * conditional, pass/fail) with sampling rules and reactions, value checks with readable messages,
 * draft-only editing, the copy into a new revision and the comparison with the revision it replaces.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('b');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-pcc');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA);
  const fam = await api().post('/api/v1/part-families').set(h).send({ code: 'HCR', name: 'Rods' }).expect(201);
  ctx.family = fam.body.id;
  for (const pn of ['HCR-100', 'HCR-200']) {
    const p = await api().post('/api/v1/parts').set(h).send({ partNumber: pn, name: pn, partFamilyId: ctx.family }).expect(201);
    ctx[pn] = p.body.id;
  }
  ctx.outside = (await api().post('/api/v1/parts').set(h).send({ partNumber: 'OTHER', name: 'Other' }).expect(201)).body.id;
  const plan = await api().post('/api/v1/control-plans').set(h).send({ planCode: 'CP-1', title: 'Rods', partFamilyId: ctx.family }).expect(201);
  ctx.plan = plan.body.id;
  ctx.revA = plan.body.revisions[0].id;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('authoring a draft revision', () => {
  it('adds operations and characteristics of every kind', async () => {
    const h = await as(ids.ownerA);
    let rev = (await api().post(`/api/v1/control-plan-revisions/${ctx.revA}/operations`).set(h).send({ operationCode: 'op-020', sequence: 20, name: 'CNC turning' }).expect(201)).body;
    rev = (await api().post(`/api/v1/control-plan-revisions/${ctx.revA}/operations`).set(h).send({ operationCode: 'OP-030', sequence: 30, name: 'Grinding' }).expect(201)).body;
    expect(rev.operations.map((o: { operationCode: string }) => o.operationCode)).toEqual(['OP-020', 'OP-030']);
    ctx.op20 = rev.operations[0].id;
    ctx.op30 = rev.operations[1].id;
    const dup = await api().post(`/api/v1/control-plan-revisions/${ctx.revA}/operations`).set(h).send({ operationCode: 'OP-020', name: 'Again' }).expect(409);
    expect(dup.body.error.message).toBe('This revision already has an operation with that code');

    rev = (
      await api()
        .post(`/api/v1/control-plan-revisions/${ctx.revA}/characteristics`)
        .set(h)
        .send({
          operationId: ctx.op20,
          characteristicKey: 'OD',
          charNumber: '3',
          name: 'Outer diameter',
          nominal: 25,
          lowerLimit: 24.95,
          upperLimit: 25.05,
          unitCode: 'mm',
          criticality: 'critical',
          spcEligible: true,
          chartType: 'xbar_r',
          subgroupSize: 5,
          sampling: [
            { triggerType: 'first_off', sampleSize: 1 },
            { triggerType: 'every_n_minutes', intervalValue: 30, sampleSize: 5 },
          ],
          reactions: [{ triggerType: 'out_of_spec', action: 'hold', instruction: 'Quarantine since the last good check' }],
        })
        .expect(201)
    ).body;
    const od = rev.operations[0].characteristics[0];
    expect(od).toMatchObject({ characteristicKey: 'OD', spcEligible: true, chartType: 'xbar_r', subgroupSize: 5 });
    expect(od.sampling.map((s: { triggerType: string }) => s.triggerType)).toEqual(['first_off', 'every_n_minutes']);
    ctx.od = od.id;

    rev = (
      await api()
        .post(`/api/v1/control-plan-revisions/${ctx.revA}/characteristics`)
        .set(h)
        // Values sent for a part-specific check are dropped: limits come from the part.
        .send({ operationId: ctx.op20, characteristicKey: 'length', name: 'Overall length', valueSource: 'part_spec', specKey: 'length', unitCode: 'mm', upperLimit: 9, spcEligible: true, chartType: 'imr' })
        .expect(201)
    ).body;
    const len = rev.operations[0].characteristics.find((c: { characteristicKey: string }) => c.characteristicKey === 'LENGTH');
    expect(len).toMatchObject({ valueSource: 'part_spec', specKey: 'LENGTH', upperLimit: null, chartType: 'imr', subgroupSize: 1 });

    rev = (
      await api()
        .post(`/api/v1/control-plan-revisions/${ctx.revA}/characteristics`)
        .set(h)
        .send({ operationId: ctx.op30, characteristicKey: 'GROOVE_POS', name: 'Groove position', valueSource: 'part_spec', specKey: 'GROOVE_POS', unitCode: 'mm', appliesTo: 'selected', partIds: [ctx['HCR-200']] })
        .expect(201)
    ).body;
    expect(rev.operations[1].characteristics[0].parts).toEqual([{ id: ctx['HCR-200'], partNumber: 'HCR-200' }]);
    expect(rev.scopeParts.map((p: { partNumber: string }) => p.partNumber)).toEqual(['HCR-100', 'HCR-200']);

    rev = (
      await api()
        .post(`/api/v1/control-plan-revisions/${ctx.revA}/characteristics`)
        .set(h)
        .send({ operationId: ctx.op30, characteristicKey: 'VISUAL', name: 'No chatter marks', dataType: 'attribute', unitCode: 'mm', upperLimit: 1 })
        .expect(201)
    ).body;
    expect(rev.operations[1].characteristics.find((c: { characteristicKey: string }) => c.characteristicKey === 'VISUAL')).toMatchObject({
      dataType: 'attribute',
      unitCode: null,
      upperLimit: null,
    });

    rev = (await api().put(`/api/v1/control-plan-revisions/${ctx.revA}/reactions`).set(h).send({ reactions: [{ triggerType: 'gauge_invalid', action: 'stop', instruction: 'Use a calibrated gauge' }] }).expect(200)).body;
    expect(rev.reactions).toHaveLength(1);
  });

  it('explains what is wrong with a characteristic', async () => {
    const h = await as(ids.ownerA);
    const noLimit = await api().post(`/api/v1/control-plan-revisions/${ctx.revA}/characteristics`).set(h).send({ operationId: ctx.op20, characteristicKey: 'X', name: 'X', nominal: 1 }).expect(400);
    expect(noLimit.body.error.message).toBe('Choose the unit of measure. Give at least one limit');
    const subgroup = await api().post(`/api/v1/control-plan-revisions/${ctx.revA}/characteristics`).set(h)
      .send({ operationId: ctx.op20, characteristicKey: 'X', name: 'X', upperLimit: 1, unitCode: 'mm', spcEligible: true, chartType: 'xbar_r', subgroupSize: 1 }).expect(400);
    expect(subgroup.body.error.message).toBe('X-bar/R charts need a subgroup size of 2 to 10');
    const outside = await api().post(`/api/v1/control-plan-revisions/${ctx.revA}/characteristics`).set(h)
      .send({ operationId: ctx.op30, characteristicKey: 'X', name: 'X', upperLimit: 1, unitCode: 'mm', appliesTo: 'selected', partIds: [ctx.outside] }).expect(409);
    expect(outside.body.error.message).toBe('The part is not in this plan’s scope'.replace('’', "'"));
    const interval = await api().patch(`/api/v1/control-plan-characteristics/${ctx.od}`).set(h).send({ sampling: [{ triggerType: 'every_n_parts', sampleSize: 2 }] }).expect(400);
    expect(interval.body.error.message).toMatch(/Give the interval/);
    const busy = await api().delete(`/api/v1/control-plan-operations/${ctx.op20}`).set(h).expect(409);
    expect(busy.body.error.message).toMatch(/still has characteristics/);
    // Inspectors read but cannot author.
    await api().get(`/api/v1/control-plan-revisions/${ctx.revA}`).set(await as(ids.inspectorA)).expect(200);
    await api().post(`/api/v1/control-plan-revisions/${ctx.revA}/operations`).set(await as(ids.inspectorA)).send({ operationCode: 'OP-9', name: 'x' }).expect(403);
  });
});

describe('revisions', () => {
  it('locks an approved revision, copies it into the next and compares them', async () => {
    const h = await as(ids.ownerA);
    await api().patch(`/api/v1/control-plan-revisions/${ctx.revA}`).set(h).send({ changeReason: 'Initial issue' }).expect(200);
    await api().post(`/api/v1/control-plan-revisions/${ctx.revA}/transitions`).set(h).send({ action: 'submit' }).expect(200);
    await api().post(`/api/v1/control-plan-revisions/${ctx.revA}/transitions`).set(h).send({ action: 'approve' }).expect(200);
    const locked = await api().patch(`/api/v1/control-plan-characteristics/${ctx.od}`).set(h).send({ upperLimit: 25.1 }).expect(409);
    expect(locked.body.error.message).toMatch(/Revision A is effective and can no longer be edited/);

    const revB = (await api().post(`/api/v1/control-plans/${ctx.plan}/revisions`).set(h).send({ revisionCode: 'B', changeReason: 'Tighter OD, groove on all parts' }).expect(201)).body;
    let b = (await api().get(`/api/v1/control-plan-revisions/${revB.id}`).set(h).expect(200)).body;
    expect(b.operations.flatMap((o: { characteristics: { characteristicKey: string }[] }) => o.characteristics.map((c) => c.characteristicKey)).sort()).toEqual(['GROOVE_POS', 'LENGTH', 'OD', 'VISUAL']);
    expect(b.reactions).toHaveLength(1);
    const odB = b.operations[0].characteristics.find((c: { characteristicKey: string }) => c.characteristicKey === 'OD');
    expect(odB.sampling).toHaveLength(2);
    const grooveB = b.operations[1].characteristics.find((c: { characteristicKey: string }) => c.characteristicKey === 'GROOVE_POS');
    const visualB = b.operations[1].characteristics.find((c: { characteristicKey: string }) => c.characteristicKey === 'VISUAL');

    await api().patch(`/api/v1/control-plan-characteristics/${odB.id}`).set(h).send({ lowerLimit: 24.98, upperLimit: 25.02 }).expect(200);
    b = (await api().patch(`/api/v1/control-plan-characteristics/${grooveB.id}`).set(h).send({ appliesTo: 'all' }).expect(200)).body;
    expect(b.operations[1].characteristics.find((c: { id: string }) => c.id === grooveB.id).parts).toEqual([]);
    await api().delete(`/api/v1/control-plan-characteristics/${visualB.id}`).set(h).expect(200);
    await api().post(`/api/v1/control-plan-revisions/${revB.id}/characteristics`).set(h)
      .send({ operationId: b.operations[0].id, characteristicKey: 'RA', name: 'Surface finish', upperLimit: 1.6, unitCode: 'µm' }).expect(201);

    const cmp = (await api().get(`/api/v1/control-plan-revisions/${revB.id}/comparison`).set(h).expect(200)).body;
    expect(cmp.base).toEqual({ id: ctx.revA, revisionCode: 'A' });
    expect(cmp.summary).toEqual({ added: 1, removed: 1, changed: 2 });
    expect(cmp.characteristics.map((c: { change: string; characteristicKey: string }) => `${c.change}:${c.characteristicKey}`)).toEqual([
      'removed:VISUAL',
      'changed:GROOVE_POS',
      'changed:OD',
      'added:RA',
    ]);
    expect(cmp.characteristics.find((c: { characteristicKey: string }) => c.characteristicKey === 'OD').tolerance).toBe('tightened');

    // A is unchanged.
    const a = (await api().get(`/api/v1/control-plan-revisions/${ctx.revA}`).set(h).expect(200)).body;
    expect(a.operations[0].characteristics.find((c: { characteristicKey: string }) => c.characteristicKey === 'OD').upperLimit).toBe(25.05);
    expect(a.operations[1].characteristics).toHaveLength(2);
  });
});
