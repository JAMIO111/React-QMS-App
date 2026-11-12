/**
 * Quality objectives (MR1) through the API: defining objectives, the fixed system measures worked out as the caller, owners recording values of their own
 * objective without the permission, corrections, retiring, and tenancy. The rules are in supabase/tests/quality_objectives.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a1f');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const today = () => new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-qo');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('quality objectives (MR1)', () => {
  let manual = '';
  let ncrs = '';

  it('lists the fixed measures, saying which the caller may read', async () => {
    const owner = (await api().get('/api/v1/quality-objective-measures').set(await as(ids.ownerA)).expect(200)).body.data;
    expect(owner.map((m: { key: string }) => m.key)).toEqual(['manual', 'ncr_count', 'supplier_ppm', 'capa_on_time', 'audit_pass_rate']);
    expect(owner.every((m: { available: boolean }) => m.available)).toBe(true);
    expect(owner.find((m: { key: string }) => m.key === 'supplier_ppm')).toMatchObject({ unit: 'PPM', direction: 'at_most' });
  });

  it('defines objectives; a system measure brings its own unit and direction', async () => {
    const h = await as(ids.ownerA);
    await api().post('/api/v1/quality-objectives').set(await as(ids.inspectorA)).send({ title: 'x', target: 1 }).expect(403);
    await api().post('/api/v1/quality-objectives').set(h).send({ title: 'x' }).expect(400);
    await api().post('/api/v1/quality-objectives').set(h).send({ title: 'x', target: 1, measure: 'made_up' }).expect(400);
    const wrong = await api().post('/api/v1/quality-objectives').set(h).send({ title: 'NCs', target: 5, measure: 'ncr_count', direction: 'at_least' }).expect(409);
    expect(wrong.body.error.code).toBe('management_review_rule');
    const made = (
      await api().post('/api/v1/quality-objectives').set(h).send({ title: 'Complaints answered in 5 days', target: 95, unit: '%', direction: 'at_least', ownerId: ids.inspectorA, frequency: 'quarterly' }).expect(201)
    ).body;
    manual = made.id;
    expect(made).toMatchObject({ reference: 'QO-001', measure: 'manual', frequency: 'quarterly', owner: { id: ids.inspectorA }, canManage: true, canRecord: true, standing: 'no_value' });
    expect(made.periods).toHaveLength(1);
    expect(made.periods[0]).toMatchObject({ current: true, value: null, standing: 'no_value' });
    expect(made.periods[0].label).toMatch(/^Q[1-4] \d{4}$/);

    const sys = (await api().post('/api/v1/quality-objectives').set(h).send({ title: 'Fewer non-conformances', target: 3, measure: 'ncr_count', startsOn: '2026-01-15' }).expect(201)).body;
    ncrs = sys.id;
    expect(sys).toMatchObject({ reference: 'QO-002', unit: 'NCs', direction: 'at_most', startsOn: '2026-01-01', canRecord: false, available: true });
    const thisMonth = today().slice(0, 7);
    const counted = await admin.query(
      `select count(*)::int as n from public.nonconformances where organisation_id = $1 and deleted_at is null and stage <> 'cancelled' and to_char(created_at, 'YYYY-MM') = $2`,
      [ids.orgA, thisMonth],
    );
    const current = sys.periods.at(-1);
    expect(current).toMatchObject({ current: true, value: counted.rows[0].n });
    expect(current.standing).toBe(counted.rows[0].n <= 3 ? 'on_target' : 'off_target');
    const capa = (await api().post('/api/v1/quality-objectives').set(h).send({ title: '8Ds on time', target: 90, measure: 'capa_on_time' }).expect(201)).body;
    expect(capa.periods.at(-1)).toMatchObject({ value: null, denominator: 0, standing: 'no_value' });
  });

  it('lets the owner record values of their own objective without the permission; a second value is a correction with a note', async () => {
    const inspector = await as(ids.inspectorA);
    const listed = (await api().get('/api/v1/quality-objectives').set(inspector).expect(200)).body;
    expect(listed.data.map((o: { id: string }) => o.id)).toEqual([manual]);
    expect(listed.canManage).toBe(false);
    await api().get(`/api/v1/quality-objectives/${ncrs}`).set(inspector).expect(404);
    const first = (await api().post(`/api/v1/quality-objectives/${manual}/values`).set(inspector).send({ periodStart: today(), value: 92 }).expect(201)).body;
    expect(first.periods.at(-1)).toMatchObject({ value: 92, standing: 'off_target', corrections: [] });
    const again = await api().post(`/api/v1/quality-objectives/${manual}/values`).set(inspector).send({ periodStart: today(), value: 96 }).expect(409);
    expect(again.body.error.message).toMatch(/say why it is corrected/);
    const fixed = (await api().post(`/api/v1/quality-objectives/${manual}/values`).set(inspector).send({ periodStart: today(), value: 96, note: 'Two answers were logged twice' }).expect(201)).body;
    expect(fixed.periods.at(-1)).toMatchObject({ value: 96, note: 'Two answers were logged twice', standing: 'on_target', corrections: [{ value: 92 }] });
    expect(fixed.latest).toMatchObject({ value: 96 });
    await api().post(`/api/v1/quality-objectives/${ncrs}/values`).set(await as(ids.ownerA)).send({ periodStart: today(), value: 1 }).expect(409);
    await api().patch(`/api/v1/quality-objectives/${manual}`).set(inspector).send({ target: 80 }).expect(403);
  });

  it('changes what may change, retires with a reason and brings back', async () => {
    const h = await as(ids.ownerA);
    await api().patch(`/api/v1/quality-objectives/${manual}`).set(h).send({ frequency: 'monthly' }).expect(400);
    const changed = (await api().patch(`/api/v1/quality-objectives/${manual}`).set(h).send({ target: 90, description: 'From the complaints log' }).expect(200)).body;
    expect(changed).toMatchObject({ target: 90, description: 'From the complaints log' });
    await api().post(`/api/v1/quality-objectives/${manual}/retire`).set(h).send({ reason: 'x' }).expect(400);
    const retired = (await api().post(`/api/v1/quality-objectives/${manual}/retire`).set(h).send({ reason: 'Replaced by the survey' }).expect(200)).body;
    expect(retired).toMatchObject({ active: false, retiredReason: 'Replaced by the survey', canRecord: false });
    expect((await api().get('/api/v1/quality-objectives').set(h).expect(200)).body.data.map((o: { id: string }) => o.id)).not.toContain(manual);
    expect((await api().get('/api/v1/quality-objectives?all=true').set(h).expect(200)).body.data.map((o: { id: string }) => o.id)).toContain(manual);
    expect((await api().post(`/api/v1/quality-objectives/${manual}/reactivate`).set(h).expect(200)).body.active).toBe(true);
  });

  it('keeps another organisation out', async () => {
    const other = await as(ids.ownerB, ids.orgB);
    await api().get(`/api/v1/quality-objectives/${manual}`).set(other).expect(404);
    await api().post(`/api/v1/quality-objectives/${manual}/values`).set(other).send({ periodStart: today(), value: 1, note: 'x' }).expect(404);
    expect((await api().get('/api/v1/quality-objectives').set(other).expect(200)).body.data).toEqual([]);
  });
});
