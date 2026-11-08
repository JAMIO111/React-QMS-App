/**
 * Saved filters through the API: a person's own named filters for a register, up to five, a name that is unique per person, and nobody else can see, change or delete them.
 * The rules themselves are in supabase/tests/saved_filters.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('b6');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-sf');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

const list = async (h: Record<string, string>) => (await api().get('/api/v1/saved-filters?scope=ncr_register').set(h).expect(200)).body;
const save = async (name: string, filters: object, h: Record<string, string>) => api().post('/api/v1/saved-filters').set(h).send({ scope: 'ncr_register', name, filters });

describe('saved filters', () => {
  const ctx: Record<string, string> = {};

  it('start empty, with the limit', async () => {
    const body = await list(await as(ids.ownerA));
    expect(body).toEqual({ data: [], limit: 5 });
  });

  it('save a name with the register\'s filters, dropping empty ones, and list them in order', async () => {
    const h = await as(ids.ownerA);
    const res = await save('  Open majors ', { stage: 'open', severity: 'major', search: '', partLabel: 'BRK-100' }, h);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ scope: 'ncr_register', name: 'Open majors', filters: { stage: 'open', severity: 'major', partLabel: 'BRK-100' }, position: 0 });
    ctx.first = res.body.id;
    expect((await save('Customer complaints', { source: 'customer' }, h)).body.position).toBe(1);
    expect((await list(h)).data.map((f: { name: string }) => f.name)).toEqual(['Open majors', 'Customer complaints']);
  });

  it('refuse a bad name, a bad body and an unknown register', async () => {
    const h = await as(ids.ownerA);
    expect((await save('', {}, h)).status).toBe(400);
    expect((await save('x'.repeat(41), {}, h)).status).toBe(400);
    expect((await save('Ok', { 'bad key!': 'x' }, h)).status).toBe(400);
    expect((await save('Ok', { stage: 5 }, h)).status).toBe(400);
    expect((await api().post('/api/v1/saved-filters').set(h).send({ scope: 'nope', name: 'x', filters: {} })).status).toBe(400);
    expect((await api().post('/api/v1/saved-filters').set(h).send({ scope: 'ncr_register', name: 'x', filters: {}, userId: 'forged' })).status).toBe(400);
    expect((await api().get('/api/v1/saved-filters').set(h)).status).toBe(400);
  });

  it('refuse a name already used, whatever its case, with a message', async () => {
    const res = await save('OPEN MAJORS', {}, await as(ids.ownerA));
    expect(res.status).toBe(409);
    expect(res.body.message ?? res.body.error?.message).toMatch(/already have a saved filter with that name/);
  });

  it('rename and replace the filters of one', async () => {
    const h = await as(ids.ownerA);
    const res = await api().patch(`/api/v1/saved-filters/${ctx.first}`).set(h).send({ name: 'Open and major', filters: { stage: 'open,contained' } }).expect(200);
    expect(res.body).toMatchObject({ name: 'Open and major', filters: { stage: 'open,contained' } });
    expect((await api().patch(`/api/v1/saved-filters/${ctx.first}`).set(h).send({}).expect(400)).status).toBe(400);
    expect((await api().patch(`/api/v1/saved-filters/${ctx.first}`).set(h).send({ name: 'Customer complaints' })).status).toBe(409);
  });

  it('stop at five, say why, and make room when one is deleted', async () => {
    const h = await as(ids.ownerA);
    for (const n of ['Three', 'Four', 'Five']) expect((await save(n, {}, h)).status).toBe(201);
    const sixth = await save('Six', {}, h);
    expect(sixth.status).toBe(409);
    expect(JSON.stringify(sixth.body)).toMatch(/saved_filter_rule/);
    expect(JSON.stringify(sixth.body)).toMatch(/up to 5/);
    const five = (await list(h)).data.find((f: { name: string }) => f.name === 'Five');
    await api().delete(`/api/v1/saved-filters/${five.id}`).set(h).expect(204);
    expect((await save('Six', {}, h)).status).toBe(201);
    expect((await list(h)).data).toHaveLength(5);
  });

  it('are private to the person: a colleague sees none, cannot change or delete them, and has their own five', async () => {
    const owner = await as(ids.ownerA);
    const other = await as(ids.inspectorA);
    expect((await list(other)).data).toEqual([]);
    expect((await api().patch(`/api/v1/saved-filters/${ctx.first}`).set(other).send({ name: 'Hijacked' })).status).toBe(404);
    expect((await api().delete(`/api/v1/saved-filters/${ctx.first}`).set(other)).status).toBe(404);
    expect((await save('Open and major', {}, other)).status).toBe(201); // the same name is fine for someone else
    expect((await list(owner)).data.find((f: { id: string }) => f.id === ctx.first)).toBeTruthy();
  });

  it('answer 404 for another organisation and for an unknown id, and need a sign-in', async () => {
    const b = await as(ids.ownerB, ids.orgB);
    expect((await api().patch(`/api/v1/saved-filters/${ctx.first}`).set(b).send({ name: 'x1' })).status).toBe(404);
    expect((await list(b)).data).toEqual([]);
    expect((await api().delete('/api/v1/saved-filters/00000000-0000-0000-0000-000000000000').set(await as(ids.ownerA))).status).toBe(404);
    expect((await api().get('/api/v1/saved-filters?scope=ncr_register')).status).toBe(401);
  });
});
