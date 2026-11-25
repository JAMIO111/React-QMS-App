/**
 * FMEA rating model (FM2) through the API: the neutral default, saving a version (an approver, a reason, unchanged refused, an invalid grid refused in words), the preview
 * on a saved version, reading an action priority grid from CSV, permissions and tenancy. The rules are in supabase/tests/fmea_rating_model.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a2e');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const GRID = [
  { sFrom: 1, sTo: 8, oFrom: 1, oTo: 5, dFrom: 1, dTo: 10, priority: 'low' },
  { sFrom: 1, sTo: 8, oFrom: 6, oTo: 10, dFrom: 1, dTo: 10, priority: 'medium' },
  { sFrom: 9, sTo: 10, oFrom: 1, oTo: 10, dFrom: 1, dTo: 10, priority: 'high' },
];
const GRID_CSV = 'S,O,D,Priority\n1-8,1-5,1-10,L\n1-8,6-10,1-10,M\n9-10,1-10,1-10,H\n';

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-fmr');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('the model', () => {
  it('starts as a neutral default that rates by RPN', async () => {
    const m = (await api().get('/api/v1/fmea-model').set(await as(ids.inspectorA)).expect(200)).body;
    expect(m).toMatchObject({ version: 1, current: true, canChange: false, reason: null });
    expect(m.config).toMatchObject({ method: 'rpn', rpnHighFrom: 200, rpnMediumFrom: 100, severityFloor: 9, reviewMonths: 12, apRules: [] });
    expect(m.config.scales.design.severity).toHaveLength(10);
    expect(m.versions).toHaveLength(1);
    expect(m.versions[0].config).toBeUndefined();
    const owner = (await api().get('/api/v1/fmea-model').set(await as(ids.ownerA)).expect(200)).body;
    expect(owner.canChange).toBe(true);
  });

  it('is not shown to another organisation', async () => {
    const other = (await api().get('/api/v1/fmea-model').set(await as(ids.ownerB, ids.orgB)).expect(200)).body;
    expect(other.id).not.toBe((await api().get('/api/v1/fmea-model').set(await as(ids.ownerA)).expect(200)).body.id);
  });
});

describe('saving a version', () => {
  it('needs an approver and a reason, and refuses a model that says nothing new', async () => {
    const current = (await api().get('/api/v1/fmea-model').set(await as(ids.ownerA)).expect(200)).body.config;
    await api().put('/api/v1/fmea-model').set(await as(ids.inspectorA)).send({ config: current, reason: 'try' }).expect(403);
    const h = await as(ids.ownerA);
    await api().put('/api/v1/fmea-model').set(h).send({ config: current }).expect(400);
    await api().put('/api/v1/fmea-model').set(h).send({ config: { ...current, colour: 'red' }, reason: 'extra key' }).expect(400);
    const same = await api().put('/api/v1/fmea-model').set(h).send({ config: current, reason: 'no change' }).expect(409);
    expect(same.body.error.code).toBe('fmea_rule');
    expect(same.body.error.message).toMatch(/Nothing has changed/);
  });

  it('refuses an action priority grid with a gap, in words', async () => {
    const h = await as(ids.ownerA);
    const current = (await api().get('/api/v1/fmea-model').set(h).expect(200)).body.config;
    const r = await api().put('/api/v1/fmea-model').set(h).send({ config: { ...current, method: 'ap', apRules: GRID.slice(0, 2) }, reason: 'gap' }).expect(409);
    expect(r.body.error.message).toMatch(/exactly once/);
    const none = await api().put('/api/v1/fmea-model').set(h).send({ config: { ...current, method: 'ap', apRules: [] }, reason: 'no grid' }).expect(409);
    expect(none.body.error.message).toMatch(/needs an action priority grid/);
  });

  it('saves a new version with the organisation\'s own grid, and keeps the earlier one', async () => {
    const h = await as(ids.ownerA);
    const current = (await api().get('/api/v1/fmea-model').set(h).expect(200)).body.config;
    const saved = (await api().put('/api/v1/fmea-model').set(h).send({ config: { ...current, method: 'ap', reviewMonths: 6, apRules: GRID }, reason: 'Use our grid' }).expect(200)).body;
    expect(saved).toMatchObject({ version: 2, reason: 'Use our grid', current: true });
    expect(saved.config).toMatchObject({ method: 'ap', reviewMonths: 6 });
    expect(saved.versions.map((v: { version: number; current: boolean }) => [v.version, v.current])).toEqual([[2, true], [1, false]]);
    expect(saved.versions[0].createdBy).toBeTruthy();
  });
});

describe('the preview', () => {
  it('scores on the current version by its method, and on an earlier version by its own', async () => {
    const h = await as(ids.inspectorA);
    const now = (await api().post('/api/v1/fmea-model/preview').set(h).send({ kind: 'process', severity: 9, occurrence: 1, detection: 1 }).expect(200)).body;
    expect(now).toMatchObject({ method: 'ap', priority: 'high', needsAttention: true, rpn: 9, modelVersion: 2, severityLabel: 'Severe' });
    const then = (await api().post('/api/v1/fmea-model/preview').set(h).send({ kind: 'process', severity: 8, occurrence: 10, detection: 10, version: 1 }).expect(200)).body;
    expect(then).toMatchObject({ method: 'rpn', priority: 'high', rpn: 800, modelVersion: 1 });
    const grid = (await api().post('/api/v1/fmea-model/preview').set(h).send({ kind: 'design', severity: 8, occurrence: 10, detection: 10 }).expect(200)).body;
    expect(grid).toMatchObject({ method: 'ap', priority: 'medium' });
  });

  it('refuses levels outside 1 to 10 and a version that does not exist', async () => {
    const h = await as(ids.inspectorA);
    await api().post('/api/v1/fmea-model/preview').set(h).send({ kind: 'process', severity: 11, occurrence: 1, detection: 1 }).expect(400);
    await api().post('/api/v1/fmea-model/preview').set(h).send({ kind: 'service', severity: 1, occurrence: 1, detection: 1 }).expect(400);
    await api().post('/api/v1/fmea-model/preview').set(h).send({ kind: 'process', severity: 1, occurrence: 1, detection: 1, version: 99 }).expect(404);
  });
});

describe('reading a grid from CSV', () => {
  it('turns a complete file into ranges the database accepts, and saves nothing', async () => {
    const h = await as(ids.ownerA);
    const before = (await api().get('/api/v1/fmea-model').set(h).expect(200)).body.version;
    const r = (await api().post('/api/v1/fmea-model/ap-import').set(h).send({ csv: GRID_CSV }).expect(200)).body;
    expect(r).toMatchObject({ errors: [], problem: null, covered: true });
    expect(r.rules).toEqual(GRID);
    expect((await api().get('/api/v1/fmea-model').set(h).expect(200)).body.version).toBe(before);
  });

  it('says what the database thinks of an incomplete grid, and which lines could not be read', async () => {
    const h = await as(ids.ownerA);
    const gap = (await api().post('/api/v1/fmea-model/ap-import').set(h).send({ csv: 'S,O,D,AP\n1-8,1-10,1-10,L\n' }).expect(200)).body;
    expect(gap.covered).toBe(false);
    expect(gap.problem).toMatch(/exactly once/);
    const bad = (await api().post('/api/v1/fmea-model/ap-import').set(h).send({ csv: 'S,O,D,AP\n1-8,1-10,1-10,L\nzzz,1,1,H\n' }).expect(200)).body;
    expect(bad.errors).toEqual([{ line: 3, message: expect.stringMatching(/S is a level or a range/) }]);
    expect(bad.rules).toHaveLength(1);
    expect(bad.covered).toBe(false);
  });

  it('is for approvers', async () => {
    await api().post('/api/v1/fmea-model/ap-import').set(await as(ids.inspectorA)).send({ csv: GRID_CSV }).expect(403);
    await api().post('/api/v1/fmea-model/ap-import').set(await as(ids.ownerA)).send({}).expect(400);
  });
});
