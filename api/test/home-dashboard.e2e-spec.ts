/**
 * The home page's figures through the API: one small answer with what needs attention in every area the caller may read.
 * The point of the endpoint is that it is light AND cannot disagree with the areas' own dashboards, so the main test here asks both and compares
 * them, first for an empty organisation and again with things overdue, critical and waiting. Then who sees which areas.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('e7');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const get = async (path: string, user = ids.ownerA, org = ids.orgA) => (await api().get(`/api/v1${path}`).set(await as(user, org)).expect(200)).body;
const home = (user = ids.ownerA, org = ids.orgA) => get('/home-dashboard', user, org);
/** The period each area's dashboard opens on does not matter for "as of today" figures; the audits card uses the last 90 days, as its dashboard does. */
const last90 = () => `from=${day(-89)}&to=${day(0)}`;

/** What the home page says, rebuilt from each area's own dashboard and registers. */
const fromDashboards = async () => {
  const nc = await get(`/ncr-dashboard?${last90()}`);
  const capa = async (query: string) => (await get(`/capas?${query}pageSize=1`)).total as number;
  const calibration = await get(`/calibration-dashboard?${last90()}`);
  const pc = await get(`/process-control-dashboard?${last90()}`);
  const spc = await get('/spc/alerts?status=open');
  const audits = await get(`/audits-dashboard?${last90()}`);
  const documents = await get(`/documents-dashboard?${last90()}`);
  const supplier = await get(`/supplier-quality/dashboard?${last90()}`);
  const competence = await get(`/competence-dashboard?${last90()}`);
  const master = await get('/master-data-dashboard');
  return {
    nc: { open: nc.kpis.open, criticalOpen: nc.kpis.criticalOpen, awaitingClosure: nc.byStage.find((s: { key: string }) => s.key === 'awaiting_closure').count },
    capa: { running: await capa(''), overdue: await capa('overdue=true&'), awaitingVerification: await capa('stage=awaiting_verification&') },
    calibration: { inUse: calibration.kpis.inUse, overdue: calibration.kpis.overdue, quarantined: calibration.kpis.quarantined, dueNext30: calibration.kpis.dueNext30 },
    processControl: { inProgress: pc.kpis.inProgress, openFailures: pc.kpis.openFailures, awaitingApproval: pc.kpis.awaitingApproval, openSpcAlerts: spc.openCount },
    audits: { openFindings: audits.kpis.openFindings, overdueFindings: audits.kpis.overdueFindings, overdue: audits.kpis.overdue, missed: audits.kpis.missed, days: 90 },
    documents: {
      inForce: documents.kpis.inForce, reviewsOverdue: documents.kpis.reviewsOverdue, readersOverdue: documents.kpis.readersOverdue,
      inReview: documents.kpis.inReview, awaitingApproval: documents.kpis.awaitingApproval, changeRequestsOpen: documents.kpis.changeRequestsOpen,
    },
    supplier: {
      suppliers: supplier.kpis.suppliers, overdueScars: supplier.kpis.overdueScars, expired: supplier.kpis.expired, expiring: supplier.kpis.expiring,
      approvalsWaiting: supplier.kpis.approvalsWaiting, riskReviewsOverdue: supplier.kpis.riskReviewsOverdue,
      receiving: { awaitingDecision: supplier.receiving.awaitingDecision, lateOrderLines: supplier.receiving.lateOrderLines },
    },
    competence: { withGaps: competence.kpis.withGaps, gaps: competence.kpis.gaps, expired: competence.kpis.expired, expiring30: competence.kpis.expiring30, neverAssessed: competence.kpis.neverAssessed },
    masterData: { checks: master.attention.map(({ key, label, kind, count }: { key: string; label: string; kind: string; count: number }) => ({ key, label, kind, count })) },
  };
};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-home');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('an organisation with nothing in it', () => {
  it('answers every area for the owner, all zero, and agrees with each dashboard', async () => {
    const h = await home();
    expect(h.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const { asOf: _asOf, ...areas } = h;
    expect(areas).toEqual(await fromDashboards());
    expect(h.nc).toEqual({ open: 0, criticalOpen: 0, awaitingClosure: 0 });
    expect(h.masterData.checks).toHaveLength(5);
  });
});

describe('with things late, critical and waiting', () => {
  beforeAll(async () => {
    const h = await as(ids.ownerA);
    const post = async (path: string, body: object) => (await api().post(`/api/v1${path}`).set(h).send(body).expect(201)).body;
    // Non-conformances: one critical, one not.
    await post('/ncrs', { source: 'internal', title: 'Cracked housing', severity: 'critical' });
    await post('/ncrs', { source: 'internal', title: 'Scratch' });
    // 8Ds: one past its due date, one not.
    const late = await post('/capas', { title: 'Recurring burrs', problemStatement: 'Burrs on every third part' });
    await post('/capas', { title: 'Loose fixture', problemStatement: 'Fixture moves' });
    await admin.query(`update public.capas set due_date = current_date - 3 where id = $1`, [late.id]);
    // Gauges: one overdue, one due soon, one far off.
    await post('/gauges', { assetNumber: 'G-1', description: 'Caliper', siteId: ids.siteA, nextDueOn: day(-3) });
    await post('/gauges', { assetNumber: 'G-2', description: 'Micrometer', siteId: ids.siteA, nextDueOn: day(10) });
    await post('/gauges', { assetNumber: 'G-3', description: 'Height gauge', siteId: ids.siteA, nextDueOn: day(200) });
    // Master data with gaps: a part with no released revision, family or customer; a machine with no site; an employee with no department (and never assessed).
    await post('/parts', { partNumber: 'P-1', name: 'One', initialRevision: { revision: 'A' } });
    const machine = await post('/machines', { code: 'M-1', name: 'Mill' });
    await post('/employees', { firstName: 'Grace', surname: 'Hopper' });
    await post('/suppliers', { code: 'SUP', name: 'Supplier' });
    // An audit with one slot overdue (inside its grace) and one missed.
    const audit = await post('/audits', {
      title: 'Cell audit', auditType: 'layered_process', frequency: { kind: 'on_demand' }, graceDays: 2, passMark: 50,
      questions: [{ question: 'Guard fitted?', answerType: 'pass_fail' }], targets: [{ kind: 'machine', machineId: machine.id }],
    });
    for (const due of [-1, -12]) {
      await admin.query(`insert into public.audit_occurrences (organisation_id, audit_definition_id, due_on, status) values ($1, $2, $3, 'scheduled')`, [ids.orgA, audit.id, day(due)]);
    }
  });

  it('counts them, and still agrees with each dashboard', async () => {
    const h = await home();
    expect(h.nc).toMatchObject({ open: 2, criticalOpen: 1 });
    expect(h.capa).toEqual({ running: 2, overdue: 1, awaitingVerification: 0 });
    expect(h.calibration).toEqual({ inUse: 3, overdue: 1, quarantined: 0, dueNext30: 1 });
    expect(h.audits).toMatchObject({ overdue: 1, missed: 1, days: 90 });
    expect(h.supplier).toMatchObject({ suppliers: 1, overdueScars: 0 });
    expect(h.competence).toMatchObject({ neverAssessed: 1 });
    const failing = h.masterData.checks.filter((c: { count: number }) => c.count > 0).map((c: { key: string }) => c.key).sort();
    expect(failing).toEqual(['employees_without_department', 'machines_without_site', 'parts_without_customer', 'parts_without_family', 'parts_without_release']);
    const { asOf: _asOf, ...areas } = h;
    expect(areas).toEqual(await fromDashboards());
  });
});

describe('who sees what', () => {
  it('leaves out the areas a person may not read, as those areas themselves refuse them', async () => {
    const h = await home(ids.inspectorA);
    // An inspector reads non-conformances and gauges but holds no competence permission.
    expect(h.nc).not.toBeNull();
    expect(h.calibration).not.toBeNull();
    expect(h.competence).toBeNull();
    await api().get(`/api/v1/competence-dashboard?${last90()}`).set(await as(ids.inspectorA)).expect(403);
    // Every area the home page gives them is one whose own dashboard lets them in, and the other way round.
    const routes: Record<string, string> = {
      nc: `/ncr-dashboard?${last90()}`, capa: '/capas?pageSize=1', calibration: `/calibration-dashboard?${last90()}`, processControl: `/process-control-dashboard?${last90()}`,
      audits: `/audits-dashboard?${last90()}`, documents: `/documents-dashboard?${last90()}`, supplier: `/supplier-quality/dashboard?${last90()}`,
      competence: `/competence-dashboard?${last90()}`, masterData: '/master-data-dashboard',
    };
    for (const [area, path] of Object.entries(routes)) {
      const status = (await api().get(`/api/v1${path}`).set(await as(ids.inspectorA))).status;
      expect({ area, allowed: h[area] !== null }).toEqual({ area, allowed: status === 200 });
    }
  });

  it('gives only the SPC and receiving figures a person may read', async () => {
    const strip = async (permission: string) =>
      admin.query(`delete from public.role_permissions where permission_code = $2 and role_id = (select id from public.roles where organisation_id = $1 and key = 'viewer')`, [ids.orgA, permission]);
    // A viewer reads process control with its SPC alerts, and supplier quality with its deliveries.
    const before = await home(ids.dual);
    expect(before.processControl.openSpcAlerts).toBe(0);
    expect(before.supplier.receiving).toEqual({ awaitingDecision: 0, lateOrderLines: 0 });
    await strip('spc.read');
    await strip('receiving.read');
    const after = await home(ids.dual);
    expect(after.processControl).toMatchObject({ inProgress: 0, openSpcAlerts: null });
    expect(after.supplier).toMatchObject({ suppliers: 1, receiving: null });
  });

  it('keeps organisations apart and refuses people who do not belong', async () => {
    const other = await home(ids.ownerB, ids.orgB);
    expect(other.nc).toEqual({ open: 0, criticalOpen: 0, awaitingClosure: 0 });
    expect(other.capa).toEqual({ running: 0, overdue: 0, awaitingVerification: 0 });
    await api().get('/api/v1/home-dashboard').set(await as(ids.ownerB, ids.orgA)).expect(404);
    await api().get('/api/v1/home-dashboard').set(await as(ids.suspendedA)).expect(404);
    await api().get('/api/v1/home-dashboard').set({ 'X-Organisation-Id': ids.orgA }).expect(401);
  });
});
