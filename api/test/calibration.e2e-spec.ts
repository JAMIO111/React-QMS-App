/**
 * Calibration through the API: gauge types and template characteristics, gauges (template copy,
 * filters, sorting, soft delete, history), calibration records with readings (outcome and the
 * gauge's dates and status), raising an NC, certificates, the dashboard, permissions and site scope.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds(9);
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org: string = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const SITE_USER = '90000000-0000-0000-0000-00000000aa77';
let plantB: string;
let typeId: string;
let gauge: string;
let gaugeB: string;

const isoDaysFromToday = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-calibration');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const one = async (q: string, params: unknown[]) => (await admin.query(q, params)).rows[0];
  await admin.query(`insert into storage.buckets (id, name) values ('calibration-files', 'calibration-files') on conflict do nothing`);
  plantB = (await one(`insert into public.sites (organisation_id, code, name) values ($1, 'PB', 'Plant B') returning id`, [ids.orgA])).id;
  await admin.query(`insert into auth.users (id, email) values ($1, 'site.user@cal.test')`, [SITE_USER]);
  const m = await one(`insert into public.organisation_users (organisation_id, user_id, status) values ($1, $2, 'active') returning id`, [ids.orgA, SITE_USER]);
  await admin.query(
    `insert into public.user_role_assignments (organisation_id, membership_id, role_id, site_id) select $1, $2, id, $3 from public.roles where organisation_id = $1 and key = 'inspector'`,
    [ids.orgA, m.id, plantB],
  );
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('gauge types', () => {
  it('creates a type with template characteristics', async () => {
    const h = await as(ids.ownerA);
    const t = await api().post('/api/v1/gauge-types').set(h).send({ code: 'CAL-150', name: 'Digital caliper 0-150', intervalValue: 6, intervalUnit: 'months' }).expect(201);
    typeId = t.body.id;
    expect(t.body).toMatchObject({ code: 'CAL-150', name: 'Digital caliper 0-150', intervalValue: 6, intervalUnit: 'months', active: true, characteristicCount: 0 });
    await api().post(`/api/v1/gauge-types/${typeId}/characteristics`).set(h)
      .send({ name: '25 mm block', nominal: 25, toleranceMinus: 0.02, tolerancePlus: 0.02, unitCode: 'mm' }).expect(201);
    const second = await api().post(`/api/v1/gauge-types/${typeId}/characteristics`).set(h)
      .send({ name: '100 mm block', nominal: 100, toleranceMinus: 0.03, tolerancePlus: 0.03, unitCode: 'mm', method: 'Gauge block, jaws' }).expect(201);
    expect(second.body).toMatchObject({ sortOrder: 2, lower: 99.97, upper: 100.03, method: 'Gauge block, jaws' });
    await api().post('/api/v1/gauge-types').set(h).send({ code: 'CAL-151', name: 'digital caliper 0-150' }).expect(409);
    // The code identifies the type: required, unique ignoring case, and it can be changed.
    await api().post('/api/v1/gauge-types').set(h).send({ name: 'Height gauge' }).expect(400);
    const dup = await api().post('/api/v1/gauge-types').set(h).send({ code: 'cal-150', name: 'Height gauge' }).expect(409);
    expect(dup.body.error.message).toBe('A gauge type with this code already exists');
    const other = await api().post('/api/v1/gauge-types').set(h).send({ code: 'HG-300', name: 'Height gauge' }).expect(201);
    expect((await api().patch(`/api/v1/gauge-types/${other.body.id}`).set(h).send({ code: 'HG-600' }).expect(200)).body.code).toBe('HG-600');
    await api().patch(`/api/v1/gauge-types/${other.body.id}`).set(h).send({ code: 'Cal-150' }).expect(409);
    await api().patch(`/api/v1/gauge-types/${other.body.id}`).set(h).send({ active: false }).expect(200);
    await api().post(`/api/v1/gauge-types/${typeId}/characteristics`).set(h)
      .send({ name: 'Bad', nominal: 1, toleranceMinus: -1, tolerancePlus: 0, unitCode: 'mm' }).expect(400);
    const list = await api().get('/api/v1/gauge-types').set(h).expect(200);
    expect(list.body.data).toEqual([expect.objectContaining({ id: typeId, characteristicCount: 2, gaugeCount: 0 })]);
  });

  it('lets only calibration managers change types', async () => {
    const h = await as(ids.inspectorA);
    await api().get('/api/v1/gauge-types').set(h).expect(200);
    await api().post('/api/v1/gauge-types').set(h).send({ code: 'MINE', name: 'Mine' }).expect(403);
    await api().patch(`/api/v1/gauge-types/${typeId}`).set(h).send({ name: 'Mine' }).expect(403);
  });
});

describe('gauges', () => {
  it('creates a gauge of a type with its characteristics copied', async () => {
    const h = await as(ids.ownerA);
    const g = await api().post('/api/v1/gauges').set(h)
      .send({ assetNumber: 'G-001', description: 'Caliper 150 mm', gaugeTypeId: typeId, siteId: ids.siteA, manufacturer: 'Mitutoyo', serialNumber: 'SN1', nextDueOn: isoDaysFromToday(-3) })
      .expect(201);
    gauge = g.body.id;
    expect(g.body).toMatchObject({
      assetNumber: 'G-001', type: { id: typeId, name: 'Digital caliper 0-150' }, intervalValue: 6, intervalUnit: 'months', status: 'active',
      dueState: 'overdue', daysUntilDue: -3, calibrationCount: 0, lastOutcome: null, createdBy: { id: ids.ownerA },
    });
    const ch = await api().get(`/api/v1/gauges/${gauge}/characteristics`).set(h).expect(200);
    expect(ch.body.data.map((c: { name: string }) => c.name)).toEqual(['25 mm block', '100 mm block']);
    expect(ch.body.data[0].templateId).toBeTruthy();

    gaugeB = (await api().post('/api/v1/gauges').set(h).send({ assetNumber: 'G-002', description: 'Micrometer', siteId: plantB, nextDueOn: isoDaysFromToday(60) }).expect(201)).body.id;
    await api().post(`/api/v1/gauges/${gaugeB}/characteristics`).set(h).send({ name: 'Zero', nominal: 0, toleranceMinus: 0.002, tolerancePlus: 0.002, unitCode: 'mm' }).expect(201);
    await api().post('/api/v1/gauges').set(h).send({ assetNumber: 'g-001', description: 'Duplicate' }).expect(409);
    await api().post('/api/v1/gauges').set(h).send({ assetNumber: 'G-X', description: 'Bad range', rangeMin: 10, rangeMax: 1 }).expect(400);
  });

  it('filters, searches and sorts the register', async () => {
    const h = await as(ids.ownerA);
    const all = await api().get('/api/v1/gauges').set(h).expect(200);
    expect(all.body.data.map((g: { assetNumber: string }) => g.assetNumber)).toEqual(['G-001', 'G-002']); // by next due
    const overdue = await api().get('/api/v1/gauges?due=overdue').set(h).expect(200);
    expect(overdue.body.data.map((g: { id: string }) => g.id)).toEqual([gauge]);
    const due90 = await api().get('/api/v1/gauges?due=due_90,overdue').set(h).expect(200);
    expect(due90.body.total).toBe(2);
    expect((await api().get(`/api/v1/gauges?typeId=${typeId}`).set(h).expect(200)).body.total).toBe(1);
    expect((await api().get('/api/v1/gauges?q=micro').set(h).expect(200)).body.data[0].id).toBe(gaugeB);
    expect((await api().get(`/api/v1/gauges?siteId=${plantB}`).set(h).expect(200)).body.total).toBe(1);
    expect((await api().get('/api/v1/gauges?sort=assetNumber&order=desc').set(h).expect(200)).body.data[0].id).toBe(gaugeB);
    expect((await api().get(`/api/v1/gauges?from=${isoDaysFromToday(0)}`).set(h).expect(200)).body.total).toBe(1);
    await api().get('/api/v1/gauges?status=broken').set(h).expect(400);
  });

  it('shows site-scoped users only their site’s gauges', async () => {
    const h = await as(SITE_USER);
    const list = await api().get('/api/v1/gauges').set(h).expect(200);
    expect(list.body.data.map((g: { id: string }) => g.id)).toEqual([gaugeB]);
    await api().get(`/api/v1/gauges/${gauge}`).set(h).expect(404);
    await api().patch(`/api/v1/gauges/${gaugeB}`).set(h).send({ location: 'Bench' }).expect(403);
  });
});

describe('calibration records', () => {
  let failed: string;

  it('records a passing calibration with readings and updates the gauge', async () => {
    const h = await as(ids.ownerA);
    const ch = (await api().get(`/api/v1/gauges/${gauge}/characteristics`).set(h).expect(200)).body.data;
    const res = await api().post(`/api/v1/gauges/${gauge}/calibrations`).set(h)
      .send({
        calibratedOn: isoDaysFromToday(-10), technicianId: ids.ownerA, temperatureC: 20.1, referenceStandards: 'Gauge block set GB-01',
        readings: [{ characteristicId: ch[0].id, asFound: 25.01 }, { characteristicId: ch[1].id, asFound: 99.99 }],
      })
      .expect(201);
    expect(res.body).toMatchObject({ outcome: 'pass', readingCount: 2, failedCount: 0, technician: { id: ids.ownerA, name: 'Ada Owner' }, temperatureC: 20.1 });
    expect(res.body.reference).toMatch(/^CAL-\d{2}-001$/);
    expect(res.body.readings[0]).toMatchObject({ name: '25 mm block', lower: 24.98, upper: 25.02, asFound: 25.01, asFoundOk: true });
    const g = (await api().get(`/api/v1/gauges/${gauge}`).set(h).expect(200)).body;
    expect(g).toMatchObject({ lastCalibratedOn: isoDaysFromToday(-10), lastOutcome: 'pass', calibrationCount: 1, status: 'active' });
    expect(g.nextDueOn > isoDaysFromToday(150)).toBe(true); // six months on
    expect(g.dueState).toBe('ok');
  });

  it('quarantines the gauge on failure, raises an NC once, and reinstates after adjustment', async () => {
    const h = await as(ids.ownerA);
    const ch = (await api().get(`/api/v1/gauges/${gauge}/characteristics`).set(h).expect(200)).body.data;
    const res = await api().post(`/api/v1/gauges/${gauge}/calibrations`).set(h)
      .send({ certificateNumber: 'C-77', readings: [{ characteristicId: ch[0].id, asFound: 25.05 }, { characteristicId: ch[1].id, asFound: 100 }] })
      .expect(201);
    failed = res.body.id;
    expect(res.body).toMatchObject({ outcome: 'fail', failedCount: 1, gauge: { status: 'quarantined' } });
    expect((await api().get(`/api/v1/gauges/${gauge}`).set(h).expect(200)).body).toMatchObject({ status: 'quarantined', statusReason: `Failed calibration ${res.body.reference}` });

    const ncr = await api().post(`/api/v1/calibrations/${failed}/raise-ncr`).set(h).expect(201);
    expect(ncr.body).toMatchObject({ source: 'calibration' });
    // The organisation's Calibration category is already chosen (a person can change it).
    expect((await api().get(`/api/v1/ncrs/${ncr.body.id}`).set(h).expect(200)).body.category).toMatchObject({ name: 'Calibration' });
    const nc = (await api().get(`/api/v1/ncrs/${ncr.body.id}`).set(h).expect(200)).body;
    expect(nc).toMatchObject({ stage: 'draft', site: { id: ids.siteA } });
    expect(nc.title).toContain('G-001');
    expect(nc.description).toContain('as found 25.05 mm (limits 24.98 to 25.02)');
    await api().post(`/api/v1/calibrations/${failed}/raise-ncr`).set(h).expect(409);
    expect((await api().get(`/api/v1/calibrations/${failed}`).set(h).expect(200)).body.nonconformance).toMatchObject({ id: ncr.body.id, reference: ncr.body.reference });

    // Adjusted back into tolerance: outcome "adjusted", gauge active again.
    const adjusted = await api().patch(`/api/v1/calibrations/${failed}`).set(h).send({ readings: [{ characteristicId: ch[0].id, asFound: 25.05, asLeft: 25.0 }] }).expect(200);
    expect(adjusted.body).toMatchObject({ outcome: 'adjusted', failedCount: 0, gauge: { status: 'active' } });
  });

  it('keeps a given outcome without readings, validates, and needs calibration.record', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/gauges/${gaugeB}/calibrations`).set(h).send({ performedBy: 'external' }).expect(400); // no readings, no outcome
    await api().post(`/api/v1/gauges/${gaugeB}/calibrations`).set(h).send({ calibratedOn: isoDaysFromToday(2), outcome: 'pass' }).expect(409); // future
    const ext = await api().post(`/api/v1/gauges/${gaugeB}/calibrations`).set(h).send({ performedBy: 'external', certificateNumber: 'UKAS-1', outcome: 'pass' }).expect(201);
    expect(ext.body).toMatchObject({ performedBy: 'external', outcome: 'pass', readingCount: 0 });
    await api().post(`/api/v1/calibrations/${ext.body.id}/raise-ncr`).set(h).expect(409); // passed
    // The Plant B inspector records at their site only; viewers cannot record.
    await api().post(`/api/v1/gauges/${gaugeB}/calibrations`).set(await as(SITE_USER)).send({ outcome: 'pass' }).expect(201);
    await api().post(`/api/v1/gauges/${gauge}/calibrations`).set(await as(SITE_USER)).send({ outcome: 'pass' }).expect(404);
    await api().post(`/api/v1/gauges/${gaugeB}/calibrations`).set(await as(ids.dual)).send({ outcome: 'pass' }).expect(403);
  });

  it('soft-deletes and restores records; the gauge follows', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/calibrations/${failed}/delete`).set(h).send({ reason: 'x' }).expect(400);
    const del = await api().post(`/api/v1/calibrations/${failed}/delete`).set(h).send({ reason: 'Wrong gauge' }).expect(200);
    expect(del.body).toMatchObject({ deleteReason: 'Wrong gauge', deletedBy: { id: ids.ownerA } });
    expect((await api().get(`/api/v1/gauges/${gauge}`).set(h).expect(200)).body).toMatchObject({ calibrationCount: 1, lastCalibratedOn: isoDaysFromToday(-10) });
    await api().patch(`/api/v1/calibrations/${failed}`).set(h).send({ notes: 'x' }).expect(409);
    expect((await api().get(`/api/v1/gauges/${gauge}/calibrations?deleted=only`).set(h).expect(200)).body.data).toHaveLength(1);
    await api().post(`/api/v1/calibrations/${failed}/restore`).set(h).expect(200);
    expect((await api().get(`/api/v1/gauges/${gauge}/calibrations`).set(h).expect(200)).body.data).toHaveLength(2);
  });

  it('attaches certificates uploaded to the record folder', async () => {
    const h = await as(ids.ownerA);
    const path = `${ids.orgA}/calibration/${failed}/abc-cert.pdf`;
    await api().post(`/api/v1/calibrations/${failed}/attachments`).set(h).send({ storagePath: path, fileName: 'cert.pdf', sizeBytes: 10 }).expect(400); // not uploaded
    await admin.query(`insert into storage.objects (bucket_id, name) values ('calibration-files', $1)`, [path]);
    await api().post(`/api/v1/calibrations/${failed}/attachments`).set(h).send({ storagePath: `${ids.orgA}/calibration/${gauge}/x.pdf`, fileName: 'x.pdf', sizeBytes: 1 }).expect(400);
    const a = await api().post(`/api/v1/calibrations/${failed}/attachments`).set(h).send({ storagePath: path, fileName: 'cert.pdf', sizeBytes: 10, contentType: 'application/pdf' }).expect(201);
    expect((await api().get(`/api/v1/calibrations/${failed}`).set(h).expect(200)).body.attachmentCount).toBe(1);
    await api().post(`/api/v1/calibration-attachments/${a.body.id}/delete`).set(h).send({ reason: 'Superseded' }).expect(200);
    expect((await api().get(`/api/v1/calibrations/${failed}/attachments`).set(h).expect(200)).body.data).toHaveLength(0);
    await api().post(`/api/v1/calibration-attachments/${a.body.id}/restore`).set(h).expect(200);
  });
});

describe('gauge lifecycle', () => {
  it('soft-deletes and restores a gauge, with history', async () => {
    const h = await as(ids.ownerA);
    await api().patch(`/api/v1/gauges/${gaugeB}`).set(h).send({ location: 'Lab 2', status: 'out_of_service', statusReason: 'Damaged anvil' }).expect(200);
    const del = await api().post(`/api/v1/gauges/${gaugeB}/delete`).set(h).send({ reason: 'Duplicate entry' }).expect(200);
    expect(del.body).toMatchObject({ deleteReason: 'Duplicate entry' });
    await api().patch(`/api/v1/gauges/${gaugeB}`).set(h).send({ location: 'x' }).expect(409);
    expect((await api().get('/api/v1/gauges').set(h).expect(200)).body.total).toBe(1);
    expect((await api().get('/api/v1/gauges?deleted=only').set(h).expect(200)).body.data[0].id).toBe(gaugeB);
    await api().post(`/api/v1/gauges/${gaugeB}/restore`).set(h).expect(200);

    const history = (await api().get(`/api/v1/gauges/${gaugeB}/history`).set(h).expect(200)).body.data;
    expect(history.some((e: { entityType: string }) => e.entityType === 'gauge_characteristics')).toBe(true);
    const created = history.find((e: { action: string; entityType: string }) => e.action === 'insert' && e.entityType === 'gauges');
    expect(created.names[plantB]).toBe('Plant B');
  });
});

describe('dashboard', () => {
  it('summarises gauges and calibrations', async () => {
    const h = await as(ids.ownerA);
    const res = await api().get(`/api/v1/calibration-dashboard?from=${isoDaysFromToday(-60)}&to=${isoDaysFromToday(0)}`).set(h).expect(200);
    expect(res.body.kpis).toMatchObject({ gauges: 2, inUse: 1, overdue: 0, quarantined: 0, calibrated: 4, failed: 0 });
    expect(res.body.kpis.firstTimePassRate).toBe(75);
    expect(res.body.dueSchedule).toHaveLength(12);
    expect(res.body.byStatus.find((s: { key: string }) => s.key === 'out_of_service').count).toBe(1);
    expect(res.body.outcomes.reduce((t: number, b: { adjusted: number }) => t + b.adjusted, 0)).toBe(1);
    await api().get('/api/v1/calibration-dashboard?from=2026-02-01&to=2026-01-01').set(h).expect(400);
  });
});

describe('pass/fail (attribute) characteristics', () => {
  it('adds a check without limits and records it as pass or fail', async () => {
    const h = await as(ids.ownerA);
    const t = await api().post(`/api/v1/gauge-types/${typeId}/characteristics`).set(h)
      .send({ kind: 'attribute', name: 'Valid certificate', nominal: 5, unitCode: 'mm' }).expect(201);
    expect(t.body).toMatchObject({ kind: 'attribute', nominal: null, unitCode: null, lower: null });
    await api().post(`/api/v1/gauge-types/${typeId}/characteristics`).set(h).send({ name: 'No limits' }).expect(400);

    const g = (await api().post('/api/v1/gauges').set(h).send({ assetNumber: 'G-ATTR', description: 'Attribute test', gaugeTypeId: typeId }).expect(201)).body;
    const ch = (await api().get(`/api/v1/gauges/${g.id}/characteristics`).set(h).expect(200)).body.data;
    const check = ch.find((c: { kind: string }) => c.kind === 'attribute');
    const measured = ch.filter((c: { kind: string }) => c.kind === 'variable');
    expect(check.name).toBe('Valid certificate');

    // A value for a check (or pass/fail for a measurement) is refused.
    await api().post(`/api/v1/gauges/${g.id}/calibrations`).set(h).send({ readings: [{ characteristicId: check.id, asFound: 1 }] }).expect(409);
    await api().post(`/api/v1/gauges/${g.id}/calibrations`).set(h).send({ readings: [{ characteristicId: check.id, asFound: 1, asFoundPass: true }] }).expect(400);

    const res = await api().post(`/api/v1/gauges/${g.id}/calibrations`).set(h)
      .send({ readings: [...measured.map((c: { id: string; nominal: number }) => ({ characteristicId: c.id, asFound: c.nominal })), { characteristicId: check.id, asFoundPass: false }] })
      .expect(201);
    expect(res.body).toMatchObject({ outcome: 'fail', failedCount: 1, gauge: { status: 'quarantined' } });
    expect(res.body.readings.find((r: { kind: string }) => r.kind === 'attribute')).toMatchObject({ asFoundPass: false, asFoundOk: false, asFound: null, lower: null });
    const ncr = await api().post(`/api/v1/calibrations/${res.body.id}/raise-ncr`).set(h).expect(201);
    expect((await api().get(`/api/v1/ncrs/${ncr.body.id}`).set(h).expect(200)).body.description).toContain('- Valid certificate: failed as found');

    const fixed = await api().patch(`/api/v1/calibrations/${res.body.id}`).set(h).send({ readings: [{ characteristicId: check.id, asFoundPass: false, asLeftPass: true }] }).expect(200);
    expect(fixed.body).toMatchObject({ outcome: 'adjusted', gauge: { status: 'active' } });

    // Switch the template check back to measured: needs limits.
    await api().patch(`/api/v1/gauge-type-characteristics/${t.body.id}`).set(h).send({ kind: 'variable' }).expect(400);
    const back = await api().patch(`/api/v1/gauge-type-characteristics/${t.body.id}`).set(h)
      .send({ kind: 'variable', nominal: 1, toleranceMinus: 0, tolerancePlus: 0, unitCode: 'mm' }).expect(200);
    expect(back.body).toMatchObject({ kind: 'variable', lower: 1, upper: 1 });
    await api().patch(`/api/v1/gauge-type-characteristics/${t.body.id}`).set(h).send({ kind: 'attribute' }).expect(200);
  });
});
