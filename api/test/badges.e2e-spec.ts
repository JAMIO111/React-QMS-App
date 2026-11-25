/**
 * The menu badges in one request. The point of the endpoint is that it is cheap AND cannot disagree with the pages the badges lead to, so the main test
 * asks both and compares; then who gets which figure (a figure the caller may not read is null, never zero).
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('ba');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const call = async (path: string, user = ids.ownerA, org = ids.orgA) => api().get(`/api/v1${path}`).set(await as(user, org));
const get = async (path: string, user = ids.ownerA, org = ids.orgA) => (await call(path, user, org)).body;
const badges = (user = ids.ownerA, org = ids.orgA) => get('/badges', user, org);

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-badges');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

/** Each figure as the page behind it gives it. */
const fromPages = async (user: string) => {
  const maybe = async (path: string, pick: (b: Record<string, number>) => number) => {
    const res = await call(path, user);
    return res.status === 200 ? pick(res.body) : null;
  };
  return {
    notifications: (await get('/notifications?limit=1', user)).unread,
    tasks: (await get('/workflow-tasks/mine?status=open', user)).openCount,
    alerts: await maybe('/quality-alerts/mine/count', (b) => b.unacknowledged),
    documents: (await get('/my-documents/count', user)).total,
    capaActions: await maybe('/capa-actions/mine?status=open', (b) => b.openCount),
    riskWork: await maybe('/risk-work/count', (b) => b.total),
    changes: await maybe('/changes/mine/count', (b) => b.total),
    fmeaActions: await maybe('/fmea-actions/mine?status=open', (b) => b.openCount),
    reviewActions: (await get('/management-review-actions/mine?status=open', user)).openCount,
  };
};

describe('badges', () => {
  it('give the owner every figure, the same as each page', async () => {
    const b = await badges();
    expect(Object.values(b).every((v) => v !== null)).toBe(true);
    expect(b).toEqual(await fromPages(ids.ownerA));
  });

  it('give an inspector a figure only where the page behind it would let them in, and agree with it', async () => {
    const b = await badges(ids.inspectorA);
    expect(b).toEqual(await fromPages(ids.inspectorA));
    // The ungated ones are always numbers.
    for (const k of ['notifications', 'tasks', 'documents', 'reviewActions']) expect(typeof b[k]).toBe('number');
  });

  it('leave out a figure when the permission is taken away, rather than say zero', async () => {
    const before = await badges(ids.dual);
    expect(before.riskWork).not.toBeNull();
    await admin.query(`delete from public.role_permissions where permission_code = 'risk.read' and role_id = (select id from public.roles where organisation_id = $1 and key = 'viewer')`, [ids.orgA]);
    const after = await badges(ids.dual);
    expect(after.riskWork).toBeNull();
    expect(after.tasks).toBe(before.tasks);
  });

  it('refuse people who do not belong, and answer for the organisation asked about only', async () => {
    await api().get('/api/v1/badges').set(await as(ids.outsider)).expect(404);
    await api().get('/api/v1/badges').expect(401);
    const other = await badges(ids.ownerB, ids.orgB);
    expect(other.tasks).toBe(0);
  });
});
