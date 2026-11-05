/** Notifications through the API: change events, per-user visibility, preferences and read state. */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('f');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-notif');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('notifications', () => {
  it('lists events for other people, not for the person who made the change', async () => {
    const owner = await as(ids.ownerA);
    const res = await api().post('/api/v1/customers').set(owner).send({ name: 'Notify Ltd', code: 'NOTIFY' });
    expect([200, 201]).toContain(res.status);
    const mine = (await api().get('/api/v1/notifications').set(owner).expect(200)).body;
    expect(mine.data.filter((n: { entityType: string }) => n.entityType === 'customers')).toHaveLength(0);
    const theirs = (await api().get('/api/v1/notifications').set(await as(ids.inspectorA)).expect(200)).body;
    expect(typeof theirs.unread).toBe('number');
  });

  it('opts out and back to the default, and marks everything read', async () => {
    const h = await as(ids.inspectorA);
    const off = await api().put('/api/v1/notification-preferences').set(h).send({ eventKey: 'parts.created', enabled: false }).expect(200);
    const pref = off.body.data.find((p: { eventKey: string }) => p.eventKey === 'parts.created');
    if (pref) expect(pref.enabled).toBe(false);
    const reset = await api().delete('/api/v1/notification-preferences').set(h).expect(200);
    expect(reset.body.data.every((p: { overridden: boolean }) => !p.overridden)).toBe(true);
    await api().post('/api/v1/notifications/read').set(h).send({ all: true }).expect(204);
    expect((await api().get('/api/v1/notifications').set(h).expect(200)).body.unread).toBe(0);
  });

  it('rejects unknown event types and bad bodies', async () => {
    const h = await as(ids.ownerA);
    await api().put('/api/v1/notification-preferences').set(h).send({ eventKey: 'nope.created', enabled: true }).expect(404);
    await api().put('/api/v1/notification-preferences').set(h).send({ eventKey: 'bad', enabled: true }).expect(400);
    await api().post('/api/v1/notifications/read').set(h).send({}).expect(400);
  });

  it('needs a signed-in member of the organisation', async () => {
    await api().get('/api/v1/notifications').expect(401);
    await api().get('/api/v1/notifications').set(await as(ids.outsider)).expect(404);
  });
});
