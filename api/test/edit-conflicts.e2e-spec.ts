/**
 * Edit conflicts EC2 (docs/edit-conflicts-plan.md) through the API: a record's GET and PATCH answers carry `rowVersion` (and an ETag); a save that
 * sends the version it was based on is refused with 409 edit_conflict when the record changed since, saying which fields changed, who and when;
 * the version may come in the body or as If-Match; a save without a version behaves as before (last save wins). The database side is in
 * supabase/tests/edit_conflicts.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('ec2a');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });

let ncr: string;
let risk: string;

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-edits');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA);
  ncr = (await api().post('/api/v1/ncrs').set(h).send({ source: 'internal', title: 'Bore oversize', siteId: ids.siteA }).expect(201)).body.id;
  const cat = (await admin.query(`select id from public.risk_categories where organisation_id = $1 order by key limit 1`, [ids.orgA])).rows[0].id;
  risk = (await api().post('/api/v1/risks').set(h).send({ categoryId: cat, title: 'Single source for castings' }).expect(201)).body.id;
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('a record carries its version', () => {
  it('in the answer, never as the ETag (the answer holds child rows that change without moving the version; the browser would serve a stale copy)', async () => {
    const res = await api().get(`/api/v1/ncrs/${ncr}`).set(await as(ids.ownerA)).expect(200);
    expect(res.body.rowVersion).toMatch(/^[0-9]{10,20}$/);
    expect(res.headers.etag).not.toBe(`"${res.body.rowVersion}"`);
  });
});

describe('two people save the same non-conformance', () => {
  it('the first save on the version both opened goes through and moves the version', async () => {
    const h = await as(ids.ownerA);
    const opened = (await api().get(`/api/v1/ncrs/${ncr}`).set(h).expect(200)).body.rowVersion;
    const first = await api().patch(`/api/v1/ncrs/${ncr}`).set(h).send({ title: 'Bore oversize on op 20', rowVersion: opened }).expect(200);
    expect(first.body.title).toBe('Bore oversize on op 20');
    expect(first.body.rowVersion).not.toBe(opened);

    // the second person opened the same version, changed another field, and saves
    const second = await api().patch(`/api/v1/ncrs/${ncr}`).set(h).send({ description: 'Found at final inspection', rowVersion: opened }).expect(409);
    expect(second.body.error.code).toBe('edit_conflict');
    expect(second.body.error.message).toBe('Ada Owner changed this since you opened it');
    expect(second.body.error.details).toMatchObject({ version: first.body.rowVersion, changedBy: { name: 'Ada Owner' } });
    expect(second.body.error.details.fields).toContain('title');
    expect(second.body.error.details.fields).not.toContain('updatedAt');
    const now = (await api().get(`/api/v1/ncrs/${ncr}`).set(h).expect(200)).body;
    expect(now.description ?? null).toBeNull(); // nothing was written

    // saving again on the version now current goes through (the screen does this when the fields do not clash)
    const again = await api().patch(`/api/v1/ncrs/${ncr}`).set(h).send({ description: 'Found at final inspection', rowVersion: second.body.error.details.version }).expect(200);
    expect(again.body).toMatchObject({ title: 'Bore oversize on op 20', description: 'Found at final inspection' });
  });

  it('takes the version as an If-Match header too', async () => {
    const h = await as(ids.ownerA);
    const current = (await api().get(`/api/v1/ncrs/${ncr}`).set(h).expect(200)).body.rowVersion;
    await api().patch(`/api/v1/ncrs/${ncr}`).set({ ...h, 'If-Match': `"${current}"` }).send({ title: 'Header save' }).expect(200);
    const stale = await api().patch(`/api/v1/ncrs/${ncr}`).set({ ...h, 'If-Match': `W/"${current}"` }).send({ title: 'Stale header save' }).expect(409);
    expect(stale.body.error.code).toBe('edit_conflict');
  });

  it('a save without a version behaves as before: the last save wins', async () => {
    const h = await as(ids.ownerA);
    await api().patch(`/api/v1/ncrs/${ncr}`).set(h).send({ title: 'No version given' }).expect(200);
    await api().patch(`/api/v1/ncrs/${ncr}`).set(h).send({ title: 'Still no version' }).expect(200);
  });

  it('a malformed version is ignored rather than refused (the body stays strict for everything else)', async () => {
    const h = await as(ids.ownerA);
    await api().patch(`/api/v1/ncrs/${ncr}`).set(h).send({ title: 'Odd version', rowVersion: 'not-a-version' }).expect(200);
    await api().patch(`/api/v1/ncrs/${ncr}`).set(h).send({ title: 'Unknown key', colour: 'red' }).expect(400);
  });
});

describe('a record changed inside a database function (risk)', () => {
  it('is checked the same way', async () => {
    const h = await as(ids.ownerA);
    const opened = (await api().get(`/api/v1/risks/${risk}`).set(h).expect(200)).body.rowVersion;
    await api().patch(`/api/v1/risks/${risk}`).set(h).send({ title: 'Single source for castings and forgings', rowVersion: opened }).expect(200);
    const stale = await api().patch(`/api/v1/risks/${risk}`).set(h).send({ cause: 'One foundry', rowVersion: opened }).expect(409);
    expect(stale.body.error.details.fields).toContain('title');
  });
});

describe('someone outside the organisation', () => {
  it('learns nothing from a version', async () => {
    const res = await api().patch(`/api/v1/ncrs/${ncr}`).set(await as(ids.ownerB, ids.orgB)).send({ title: 'Not mine', rowVersion: '1' });
    expect([403, 404]).toContain(res.status);
    expect(res.body.error.code).not.toBe('edit_conflict');
  });
});

describe('register rows carry their version too', () => {
  it('so a dialog opened from a row can say what it was based on', async () => {
    const h = await as(ids.ownerA);
    const created = (await api().post('/api/v1/machines').set(h).send({ code: 'EC-M1', name: 'Lathe', siteId: ids.siteA }).expect(201)).body;
    const list = await api().get('/api/v1/machines?q=EC-M1').set(h).expect(200);
    const row = (list.body.items ?? list.body.data).find((m: { id: string }) => m.id === created.id);
    expect(row.rowVersion).toMatch(/^[0-9]{10,20}$/);
    await api().patch(`/api/v1/machines/${created.id}`).set(h).send({ name: 'Lathe 2', rowVersion: row.rowVersion }).expect(200);
    const stale = await api().patch(`/api/v1/machines/${created.id}`).set(h).send({ description: 'Bay 4', rowVersion: row.rowVersion }).expect(409);
    expect(stale.body.error.details.fields).toContain('name');
  });
});

describe('the More details card (custom fields)', () => {
  it('two people filling in different fields are both kept; the same field is refused naming it', async () => {
    const h = await as(ids.ownerA);
    await api().post('/api/v1/custom-fields').set(h).send({ entityType: 'nonconformance', fieldType: 'text', label: 'Batch ref' }).expect(201);
    await api().post('/api/v1/custom-fields').set(h).send({ entityType: 'nonconformance', fieldType: 'text', label: 'Shift' }).expect(201);
    const first = (await api().put(`/api/v1/custom-values/${ncr}`).set(h).send({ entityType: 'nonconformance', values: { batch_ref: 'B-1' } }).expect(200)).body;
    expect(first.rowVersion).toMatch(/^[0-9]{10,20}$/);
    const read = (await api().get(`/api/v1/custom-values/${ncr}`).set(h).expect(200)).body; // no entity type needed
    expect(read).toMatchObject({ entityType: 'nonconformance', values: { batch_ref: 'B-1' }, rowVersion: first.rowVersion });

    // someone sets the batch ref; a save based on the earlier version that names the shift is refused, naming the batch ref only
    await api().put(`/api/v1/custom-values/${ncr}`).set(h).send({ entityType: 'nonconformance', values: { batch_ref: 'B-2' }, rowVersion: first.rowVersion }).expect(200);
    const stale = await api().put(`/api/v1/custom-values/${ncr}`).set(h).send({ entityType: 'nonconformance', values: { shift: 'Nights' }, rowVersion: first.rowVersion }).expect(409);
    expect(stale.body.error.code).toBe('edit_conflict');
    expect(stale.body.error.details.fields).toEqual(['values.batch_ref']);
    // saving again on the new version keeps both (values merge by field)
    const both = await api().put(`/api/v1/custom-values/${ncr}`).set(h).send({ entityType: 'nonconformance', values: { shift: 'Nights' }, rowVersion: stale.body.error.details.version }).expect(200);
    expect(both.body.values).toEqual({ batch_ref: 'B-2', shift: 'Nights' });
  });
});

describe('action lines', () => {
  it('an NC containment action carries its version and refuses a stale save', async () => {
    const h = await as(ids.ownerA);
    const a = (await api().post(`/api/v1/ncrs/${ncr}/containment-actions`).set(h).send({ kind: 'sort', description: 'Sort the stock' }).expect(201)).body;
    const listed = (await api().get(`/api/v1/ncrs/${ncr}/containment`).set(h).expect(200)).body.actions.find((x: { id: string }) => x.id === a.id);
    expect(listed.rowVersion).toMatch(/^[0-9]{10,20}$/);
    const saved = await api().patch(`/api/v1/ncr-containment-actions/${a.id}`).set(h).send({ description: 'Sort all stock', rowVersion: listed.rowVersion }).expect(200);
    expect(saved.body.rowVersion).not.toBe(listed.rowVersion);
    const stale = await api().patch(`/api/v1/ncr-containment-actions/${a.id}`).set(h).send({ description: 'Sort the stock in bay 2', rowVersion: listed.rowVersion }).expect(409);
    expect(stale.body.error.details.fields).toContain('description');
  });

  it('a risk action is versioned inside the risk it belongs to', async () => {
    const h = await as(ids.ownerA);
    const withAction = (await api().post(`/api/v1/risks/${risk}/actions`).set(h).send({ description: 'Second foundry quote' }).expect(201)).body;
    const action = (await api().get(`/api/v1/risks/${risk}`).set(h).expect(200)).body.actions.find((x: { description: string }) => x.description === 'Second foundry quote');
    expect(withAction).toBeTruthy();
    expect(action.rowVersion).toMatch(/^[0-9]{10,20}$/);
    const saved = (await api().patch(`/api/v1/risk-actions/${action.id}`).set(h).send({ description: 'Two foundry quotes', rowVersion: action.rowVersion }).expect(200)).body;
    const after = saved.actions.find((x: { id: string }) => x.id === action.id);
    expect(after.rowVersion).toMatch(/^[0-9]{10,20}$/);
    expect(after.rowVersion).not.toBe(action.rowVersion);
    const stale = await api().patch(`/api/v1/risk-actions/${action.id}`).set(h).send({ description: 'Three quotes', rowVersion: action.rowVersion }).expect(409);
    expect(stale.body.error.code).toBe('edit_conflict');
  });
});
