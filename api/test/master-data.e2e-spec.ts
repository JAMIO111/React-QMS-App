/**
 * Phase 2.1: units, customers, suppliers, parts and part revisions through the API, including the
 * revision lifecycle (release supersedes, released revisions are locked) and its outbox events.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds(6);
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org: string) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-master');
  app = await startApp();
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('units', () => {
  it('lists the global catalogue to any signed-in user', async () => {
    const res = await api().get('/api/v1/units').set({ Authorization: `Bearer ${await token(ids.outsider)}` }).expect(200);
    expect(res.body.data.find((u: { code: string }) => u.code === 'mm')).toEqual({ code: 'mm', name: 'Millimetre', quantityKind: 'length' });
  });
});

describe('customers and suppliers', () => {
  let customerId: string;

  it('creates, searches and updates customers', async () => {
    const h = await as(ids.ownerA, ids.orgA);
    const created = await api().post('/api/v1/customers').set(h).send({ code: 'acme', name: 'Acme Fabrication Ltd', displayName: 'Acme' }).expect(201);
    customerId = created.body.id;
    expect(created.body).toMatchObject({ code: 'ACME', name: 'Acme Fabrication Ltd', displayName: 'Acme', active: true });

    const found = await api().get('/api/v1/customers?q=fabrication').set(h).expect(200);
    expect(found.body.data.map((c: { id: string }) => c.id)).toEqual([customerId]);

    const updated = await api().patch(`/api/v1/customers/${customerId}`).set(h).send({ active: false, notes: '' }).expect(200);
    expect(updated.body).toMatchObject({ active: false, notes: null });
    const listed = await api().get('/api/v1/customers').set(h).expect(200);
    expect(listed.body.data.some((c: { id: string }) => c.id === customerId)).toBe(false);
    const all = await api().get('/api/v1/customers?includeInactive=true').set(h).expect(200);
    expect(all.body.data.some((c: { id: string }) => c.id === customerId)).toBe(true);
  });

  it('rejects duplicate codes and bad input', async () => {
    const h = await as(ids.ownerA, ids.orgA);
    const dup = await api().post('/api/v1/customers').set(h).send({ code: 'ACME', name: 'Again' }).expect(409);
    expect(dup.body.error.message).toBe('A customer with this code already exists');
    await api().post('/api/v1/customers').set(h).send({ code: 'has space', name: 'X' }).expect(400);
    await api().post('/api/v1/suppliers').set(h).send({ code: 'S1', name: 'X', organisationId: ids.orgB }).expect(400);
  });

  it('keeps customers and suppliers separate', async () => {
    const h = await as(ids.ownerA, ids.orgA);
    await api().post('/api/v1/suppliers').set(h).send({ code: 'ACME', name: 'Acme as a supplier' }).expect(201);
    const suppliers = await api().get('/api/v1/suppliers').set(h).expect(200);
    expect(suppliers.body.data.map((s: { code: string }) => s.code)).toContain('ACME');
  });

  it('lets read-only members list but not change', async () => {
    await api().get('/api/v1/customers').set(await as(ids.inspectorA, ids.orgA)).expect(200);
    await api().post('/api/v1/customers').set(await as(ids.inspectorA, ids.orgA)).send({ code: 'NOPE', name: 'Nope' }).expect(403);
  });
});

describe('parts and revisions', () => {
  let partId: string;
  let revA: string;
  let revB: string;

  it('creates a part with a draft first revision', async () => {
    const h = await as(ids.ownerA, ids.orgA);
    const res = await api()
      .post('/api/v1/parts')
      .set(h)
      .send({ partNumber: 'BRK-100', name: 'Bracket', description: 'Mild steel', initialRevision: { revision: 'A', drawingRef: 'DRG-100' } })
      .expect(201);
    partId = res.body.id;
    revA = res.body.revisions[0].id;
    expect(res.body).toMatchObject({ partNumber: 'BRK-100', name: 'Bracket', currentRevision: null, customer: null });
    expect(res.body.revisions).toEqual([expect.objectContaining({ revision: 'A', drawingRef: 'DRG-100', status: 'draft', releasedAt: null })]);
  });

  it('refuses a duplicate part number in any letter case', async () => {
    const res = await api().post('/api/v1/parts').set(await as(ids.ownerA, ids.orgA)).send({ partNumber: 'brk-100', name: 'Copy' }).expect(409);
    expect(res.body.error.message).toBe('A part with this number already exists');
  });

  it('refuses another organisation’s customer', async () => {
    const other = await api().post('/api/v1/customers').set(await as(ids.ownerB, ids.orgB)).send({ code: 'BCUST', name: 'B customer' }).expect(201);
    const res = await api().post('/api/v1/parts').set(await as(ids.ownerA, ids.orgA)).send({ partNumber: 'X-1', name: 'X', customerId: other.body.id }).expect(400);
    expect(res.body.error.code).toBe('invalid_reference');
  });

  it('releases a draft, locks it, and supersedes it with the next release', async () => {
    const h = { ...(await as(ids.ownerA, ids.orgA)), 'X-Correlation-Id': 'corr-release-a' };
    const released = await api().post(`/api/v1/part-revisions/${revA}/release`).set(h).expect(200);
    expect(released.body).toMatchObject({ status: 'released', releasedAt: expect.any(String) });
    expect((await api().get(`/api/v1/parts/${partId}`).set(h).expect(200)).body.currentRevision).toBe('A');

    const locked = await api().patch(`/api/v1/part-revisions/${revA}`).set(h).send({ drawingRef: 'changed' }).expect(409);
    expect(locked.body.error).toMatchObject({ code: 'invalid_revision_state', message: 'Revision A is released and can no longer be edited' });

    revB = (await api().post(`/api/v1/parts/${partId}/revisions`).set(h).send({ revision: 'B', changeSummary: 'Hole moved' }).expect(201)).body.id;
    await api().post(`/api/v1/parts/${partId}/revisions`).set(h).send({ revision: 'b' }).expect(409);
    await api().patch(`/api/v1/part-revisions/${revB}`).set(h).send({ drawingRef: 'DRG-100 iss B' }).expect(200);
    await api().post(`/api/v1/part-revisions/${revB}/release`).set(h).expect(200);

    const detail = (await api().get(`/api/v1/parts/${partId}`).set(h).expect(200)).body;
    expect(detail.currentRevision).toBe('B');
    expect(Object.fromEntries(detail.revisions.map((r: { revision: string; status: string }) => [r.revision, r.status]))).toEqual({ A: 'superseded', B: 'released' });
  });

  it('records a release event in the outbox with the request correlation id', async () => {
    const { rows } = await admin.query(
      `select event_type, payload->>'revision' as revision, correlation_id from public.outbox_events where entity_id = $1`,
      [revA],
    );
    expect(rows).toEqual([{ event_type: 'part.revision.released', revision: 'A', correlation_id: 'corr-release-a' }]);
  });

  it('retires revisions and refuses invalid transitions', async () => {
    const h = await as(ids.ownerA, ids.orgA);
    await api().post(`/api/v1/part-revisions/${revA}/obsolete`).set(h).expect(200);
    const again = await api().post(`/api/v1/part-revisions/${revA}/release`).set(h).expect(409);
    expect(again.body.error.code).toBe('invalid_revision_state');
  });

  it('searches the parts list and pages through it', async () => {
    const h = await as(ids.ownerA, ids.orgA);
    for (const n of ['AX-1', 'AX-2', 'AX-3']) await api().post('/api/v1/parts').set(h).send({ partNumber: n, name: `Axle ${n}` }).expect(201);
    const first = await api().get('/api/v1/parts?q=axle&limit=2').set(h).expect(200);
    expect(first.body.data.map((p: { partNumber: string }) => p.partNumber)).toEqual(['AX-1', 'AX-2']);
    const second = await api().get(`/api/v1/parts?q=axle&limit=2&cursor=${first.body.nextCursor}`).set(h).expect(200);
    expect(second.body.data.map((p: { partNumber: string }) => p.partNumber)).toEqual(['AX-3']);
    expect(second.body.nextCursor).toBeNull();
  });

  it('lets read-only members view parts but not change them', async () => {
    const h = await as(ids.inspectorA, ids.orgA);
    await api().get(`/api/v1/parts/${partId}`).set(h).expect(200);
    await api().post('/api/v1/parts').set(h).send({ partNumber: 'INS-1', name: 'Nope' }).expect(403);
    await api().post(`/api/v1/part-revisions/${revB}/obsolete`).set(h).expect(403);
  });

  it('answers 404 for an unknown part', () =>
    as(ids.ownerA, ids.orgA).then((h) => api().get('/api/v1/parts/00000000-0000-0000-0000-000000000000').set(h).expect(404)));
});
