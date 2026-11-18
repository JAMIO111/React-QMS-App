/** Customer contacts (docs/external-portal-plan.md X17) through the API: one primary, deactivated never deleted, staff rights, isolation. */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('9c7a');
let app: INestApplication;
let admin: Pool;
let customerId: string;
const api = () => request(app.getHttpServer());
const as = async (user: string, org: string) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-pt5c');
  customerId = (await admin.query(`insert into public.customers (organisation_id, code, name) values ($1, 'WAYNE', 'Wayne Ltd') returning id`, [ids.orgA])).rows[0].id;
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('customer contacts', () => {
  it('adds contacts, keeps one primary, and never deletes', async () => {
    const h = await as(ids.ownerA, ids.orgA);
    await api().post(`/api/v1/customers/${customerId}/contacts`).set(h).send({ name: 'Pat Quality', role: 'quality', email: 'pat@wayne.test', isPrimary: true }).expect(201);
    const r = await api().post(`/api/v1/customers/${customerId}/contacts`).set(h).send({ name: 'Sam Buyer', role: 'purchasing', isPrimary: true }).expect(201);
    expect(r.body.data.map((c: { name: string; isPrimary: boolean }) => [c.name, c.isPrimary])).toEqual([['Sam Buyer', true], ['Pat Quality', false]]);
    const sam = r.body.data[0];
    const off = await api().patch(`/api/v1/customer-contacts/${sam.id}`).set(h).send({ active: false }).expect(200);
    expect(off.body.data.find((c: { id: string }) => c.id === sam.id)).toMatchObject({ active: false, isPrimary: false });
    await api().patch(`/api/v1/customer-contacts/${sam.id}`).set(h).send({}).expect(400);
    await api().patch(`/api/v1/customer-contacts/${sam.id}`).set(h).send({ customerId: ids.orgA }).expect(400);
  });

  it('is invisible to another organisation', async () => {
    const other = await as(ids.ownerB, ids.orgB);
    await api().get(`/api/v1/customers/${customerId}/contacts`).set(other).expect(404);
    await api().post(`/api/v1/customers/${customerId}/contacts`).set(other).send({ name: 'Intruder' }).expect(404);
  });

  it('lets a viewer read but not add', async () => {
    const viewer = await as(ids.inspectorA, ids.orgA);
    await api().get(`/api/v1/customers/${customerId}/contacts`).set(viewer).expect(200);
    await api().post(`/api/v1/customers/${customerId}/contacts`).set(viewer).send({ name: 'Nope' }).expect(403);
  });
});
