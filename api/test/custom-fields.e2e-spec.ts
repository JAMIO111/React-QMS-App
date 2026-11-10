/**
 * Custom fields through the API: definitions (every member reads; custom_fields.manage writes), a record's values (its own permissions), batch reads,
 * the records' own create bodies and responses carrying custom values, register filters, and 409 custom_field_rule from the database.
 * The rules themselves are in supabase/tests/custom_fields.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { categoryId, makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('ca');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-cf');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

const ctx: Record<string, string> = {};

describe('custom field definitions', () => {
  it('start empty, with every kind of record and its stages', async () => {
    const body = (await api().get('/api/v1/custom-fields').set(await as(ids.ownerA)).expect(200)).body;
    expect(body.data).toEqual([]);
    expect(body.limit).toBe(20);
    expect(body.entities).toHaveLength(13);
    expect(body.entities.find((e: { entityType: string }) => e.entityType === 'nonconformance').stages.map((s: { value: string }) => s.value)).toContain('closed');
    expect(body.entities.find((e: { entityType: string }) => e.entityType === 'part').stages).toEqual([]);
  });

  it('let a manager add fields, with a key made from the label', async () => {
    const h = await as(ids.ownerA);
    const text = await api().post('/api/v1/custom-fields').set(h).send({ entityType: 'part', fieldType: 'text', label: 'Surface finish', section: 'Finishing' });
    expect(text.status).toBe(201);
    expect(text.body).toMatchObject({ key: 'surface_finish', label: 'Surface finish', fieldType: 'text', section: 'Finishing', requiredAt: 'never', active: true, position: 1 });
    ctx.text = text.body.id;
    const choice = await api().post('/api/v1/custom-fields').set(h).send({
      entityType: 'part', fieldType: 'choice', label: 'Coating', options: [{ key: 'zinc', label: 'Zinc' }, { key: 'paint', label: 'Paint' }],
    });
    expect(choice.status).toBe(201);
    expect(choice.body.options).toEqual([{ key: 'zinc', label: 'Zinc', active: true }, { key: 'paint', label: 'Paint', active: true }]);
    ctx.choice = choice.body.id;
    const num = await api().post('/api/v1/custom-fields').set(h).send({ entityType: 'part', fieldType: 'number', label: 'Weight', decimals: 1, unit: 'kg', min: 0 });
    expect(num.body).toMatchObject({ decimals: 1, unit: 'kg', min: 0, max: null });
    const ncr = await api().post('/api/v1/custom-fields').set(h).send({ entityType: 'nonconformance', fieldType: 'text', label: 'Shift lead', requiredAt: 'closed' });
    expect(ncr.body.requiredAt).toBe('closed');
  });

  it('refuse bad bodies (400) and the database\'s rules (409 custom_field_rule)', async () => {
    const h = await as(ids.ownerA);
    expect((await api().post('/api/v1/custom-fields').set(h).send({ entityType: 'audit', fieldType: 'text', label: 'X' })).status).toBe(400);
    expect((await api().post('/api/v1/custom-fields').set(h).send({ entityType: 'part', fieldType: 'text', label: '' })).status).toBe(400);
    expect((await api().post('/api/v1/custom-fields').set(h).send({ entityType: 'part', fieldType: 'text', label: 'X', organisationId: ids.orgB })).status).toBe(400);
    const dup = await api().post('/api/v1/custom-fields').set(h).send({ entityType: 'part', fieldType: 'text', label: 'SURFACE FINISH' });
    expect(dup.status).toBe(409);
    const noOptions = await api().post('/api/v1/custom-fields').set(h).send({ entityType: 'part', fieldType: 'choice', label: 'Colour' });
    expect(noOptions.status).toBe(409);
    expect(noOptions.body.error.code).toBe('custom_field_rule');
    const stage = await api().post('/api/v1/custom-fields').set(h).send({ entityType: 'part', fieldType: 'text', label: 'Y', requiredAt: 'closed' });
    expect(stage.status).toBe(409);
    const removeOption = await api().patch(`/api/v1/custom-fields/${ctx.choice}`).set(h).send({ label: 'Coating', options: [{ key: 'zinc', label: 'Zinc' }] });
    expect(removeOption.status).toBe(409);
    expect(removeOption.body.error.message).toMatch(/switch it off/);
  });

  it('only custom_fields.manage changes definitions; every member reads them', async () => {
    const h = await as(ids.inspectorA);
    expect((await api().post('/api/v1/custom-fields').set(h).send({ entityType: 'part', fieldType: 'text', label: 'Mine' })).status).toBe(403);
    expect((await api().patch(`/api/v1/custom-fields/${ctx.text}`).set(h).send({ label: 'Mine' })).status).toBe(403);
    const list = (await api().get('/api/v1/custom-fields?entityType=part').set(h).expect(200)).body;
    expect(list.data.map((d: { key: string }) => d.key)).toEqual(['surface_finish', 'coating', 'weight']);
  });

  it('edit a field, switch an option off, retire and bring back, reorder', async () => {
    const h = await as(ids.ownerA);
    const edited = await api().patch(`/api/v1/custom-fields/${ctx.choice}`).set(h)
      .send({ label: 'Coating type', helpText: 'As on the drawing', options: [{ key: 'zinc', label: 'Zinc', active: false }, { key: 'paint', label: 'Paint' }, { key: 'anod', label: 'Anodised' }] });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ label: 'Coating type', key: 'coating', helpText: 'As on the drawing' });
    expect(edited.body.options.map((o: { active: boolean }) => o.active)).toEqual([false, true, true]);
    expect((await api().post(`/api/v1/custom-fields/${ctx.text}/retire`).set(h).send({ reason: 'x' })).status).toBe(400);
    const retired = await api().post(`/api/v1/custom-fields/${ctx.text}/retire`).set(h).send({ reason: 'No longer recorded' });
    expect(retired.body).toMatchObject({ active: false, retireReason: 'No longer recorded' });
    expect((await api().get('/api/v1/custom-fields?entityType=part').set(h)).body.data).toHaveLength(2);
    expect((await api().get('/api/v1/custom-fields?entityType=part&includeRetired=true').set(h)).body.data).toHaveLength(3);
    expect((await api().post(`/api/v1/custom-fields/${ctx.text}/reactivate`).set(h).send({})).body.active).toBe(true);
    const all = (await api().get('/api/v1/custom-fields?entityType=part&includeRetired=true').set(h)).body.data.map((d: { id: string }) => d.id);
    const order = await api().put('/api/v1/custom-fields/order').set(h).send({ entityType: 'part', ids: [...all].reverse() });
    expect(order.status).toBe(200);
    expect(order.body.data.map((d: { id: string }) => d.id)).toEqual([...all].reverse());
    expect((await api().put('/api/v1/custom-fields/order').set(h).send({ entityType: 'part', ids: all.slice(1) })).status).toBe(409);
  });

  it('keep definitions inside their organisation', async () => {
    const h = await as(ids.ownerB, ids.orgB);
    expect((await api().get('/api/v1/custom-fields').set(h)).body.data).toEqual([]);
    expect((await api().patch(`/api/v1/custom-fields/${ctx.text}`).set(h).send({ label: 'Hijacked' })).status).toBe(404);
    expect((await api().post(`/api/v1/custom-fields/${ctx.text}/retire`).set(h).send({ reason: 'Hijacked' })).status).toBe(404);
  });
});

describe('custom values', () => {
  it('a part is created with its custom values and carries them in its detail and list rows', async () => {
    const h = await as(ids.ownerA);
    const res = await api().post('/api/v1/parts').set(h).send({ partNumber: 'CF-100', name: 'Bracket', customValues: { coating: 'paint', weight: '2.5' } });
    expect(res.status).toBe(201);
    ctx.part = res.body.id;
    expect(res.body.customValues).toEqual({ coating: 'paint', weight: 2.5 });
    expect((await api().get(`/api/v1/parts/${ctx.part}`).set(h).expect(200)).body.customValues).toEqual({ coating: 'paint', weight: 2.5 });
    const list = (await api().get('/api/v1/parts?q=CF-100').set(h).expect(200)).body;
    const rows = Array.isArray(list) ? list : list.data;
    expect(rows.find((p: { id: string }) => p.id === ctx.part).customValues).toEqual({ coating: 'paint', weight: 2.5 });
  });

  it('a bad value on create refuses the whole create', async () => {
    const h = await as(ids.ownerA);
    const res = await api().post('/api/v1/parts').set(h).send({ partNumber: 'CF-101', name: 'Plate', customValues: { coating: 'zinc' } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('custom_field_rule');
    const { rows } = await admin.query(`select count(*)::int as n from public.parts where organisation_id = $1 and part_number = 'CF-101'`, [ids.orgA]);
    expect(rows[0].n).toBe(0);
  });

  it('read and change one record\'s values, and many at once', async () => {
    const h = await as(ids.ownerA);
    const got = await api().get(`/api/v1/custom-values/${ctx.part}?entityType=part`).set(h).expect(200);
    expect(got.body).toEqual({ entityType: 'part', recordId: ctx.part, values: { coating: 'paint', weight: 2.5 } });
    const set = await api().put(`/api/v1/custom-values/${ctx.part}`).set(h).send({ entityType: 'part', values: { surface_finish: ' Ra 0.8 ', weight: null } });
    expect(set.status).toBe(200);
    expect(set.body.values).toEqual({ coating: 'paint', surface_finish: 'Ra 0.8' });
    const bad = await api().put(`/api/v1/custom-values/${ctx.part}`).set(h).send({ entityType: 'part', values: { weight: 'heavy' } });
    expect(bad.status).toBe(409);
    expect(bad.body.error.message).toMatch(/not a number/);
    expect((await api().put(`/api/v1/custom-values/${ctx.part}`).set(h).send({ entityType: 'part', values: { 'Bad Key': 1 } })).status).toBe(400);
    const batch = await api().get(`/api/v1/custom-values?entityType=part&ids=${ctx.part},${ids.ncrA}`).set(h).expect(200);
    expect(batch.body).toEqual({ entityType: 'part', data: { [ctx.part]: { coating: 'paint', surface_finish: 'Ra 0.8' } } });
  });

  it('reading follows the record; writing needs the record\'s edit permission', async () => {
    const insp = await as(ids.inspectorA);
    expect((await api().get(`/api/v1/custom-values/${ctx.part}?entityType=part`).set(insp)).status).toBe(200);
    expect((await api().put(`/api/v1/custom-values/${ctx.part}`).set(insp).send({ entityType: 'part', values: { coating: 'anod' } })).status).toBe(403);
    const other = await as(ids.ownerB, ids.orgB);
    expect((await api().get(`/api/v1/custom-values/${ctx.part}?entityType=part`).set(other)).status).toBe(404);
    expect((await api().put(`/api/v1/custom-values/${ctx.part}`).set(other).send({ entityType: 'part', values: { coating: 'anod' } })).status).toBe(404);
    expect((await api().get(`/api/v1/custom-values?entityType=part&ids=${ctx.part}`).set(other)).body.data).toEqual({});
  });

  it('filters a register by a custom field', async () => {
    const h = await as(ids.ownerA);
    await api().post('/api/v1/parts').set(h).send({ partNumber: 'CF-102', name: 'Bush', customValues: { coating: 'anod', weight: 9 } }).expect(201);
    const rows = async (q: string) => {
      const body = (await api().get(`/api/v1/parts?${q}`).set(h).expect(200)).body;
      return (Array.isArray(body) ? body : body.data).map((p: { partNumber: string }) => p.partNumber).sort();
    };
    expect(await rows('cf_coating=anod')).toEqual(['CF-102']);
    expect(await rows('cf_coating=anod,paint')).toEqual(['CF-100', 'CF-102']);
    expect(await rows('cf_weight=5..')).toEqual(['CF-102']);
    expect(await rows('cf_surface_finish=ra')).toEqual(['CF-100']);
    expect(await rows('cf_weight=-')).toEqual(['CF-100']);
    expect((await api().get('/api/v1/parts?cf_nope=1').set(h)).status).toBe(400);
    expect((await api().get('/api/v1/parts?cf_weight=abc').set(h)).status).toBe(400);
  });

  it('a field required on save must be sent with the create', async () => {
    const h = await as(ids.ownerA);
    await api().post('/api/v1/custom-fields').set(h).send({ entityType: 'machine', fieldType: 'text', label: 'Asset tag', requiredAt: 'save' }).expect(201);
    const missing = await api().post('/api/v1/machines').set(h).send({ code: 'M-1', name: 'Lathe', siteId: ids.siteA });
    expect(missing.status).toBe(409);
    expect(missing.body.error.message).toMatch(/Asset tag/);
    const ok = await api().post('/api/v1/machines').set(h).send({ code: 'M-1', name: 'Lathe', siteId: ids.siteA, customValues: { asset_tag: 'AT-1' } });
    expect(ok.status).toBe(201);
    expect(ok.body.customValues).toEqual({ asset_tag: 'AT-1' });
    const cleared = await api().put(`/api/v1/custom-values/${ok.body.id}`).set(h).send({ entityType: 'machine', values: { asset_tag: '' } });
    expect(cleared.status).toBe(409);
  });

  it('a field required at a stage blocks moving the record into it', async () => {
    const h = await as(ids.ownerA);
    await admin.query(
      `insert into public.nonconformances (id, organisation_id, reference, source, title, description, severity, quantity_affected, site_id, category_id)
       values ($1, $2, 'pending', 'internal', 'Burr', 'Burr on edge', 'minor', 1, $3, $4)`,
      [ids.ncrA, ids.orgA, ids.siteA, await categoryId(admin, ids.orgA)],
    );
    const ncr = (await api().get(`/api/v1/ncrs/${ids.ncrA}`).set(h).expect(200)).body;
    expect(ncr.customValues).toEqual({});
    await api().post('/api/v1/custom-fields').set(h).send({ entityType: 'nonconformance', fieldType: 'text', label: 'Shift', requiredAt: 'open' }).expect(201);
    const open = await api().post(`/api/v1/ncrs/${ids.ncrA}/transitions`).set(h).send({ to: 'open' });
    expect(open.status).toBe(409);
    expect(open.body.error.code).toBe('custom_field_rule');
    expect(open.body.error.message).toMatch(/Shift/);
    await api().put(`/api/v1/custom-values/${ids.ncrA}`).set(h).send({ entityType: 'nonconformance', values: { shift: 'Days' } }).expect(200);
    expect((await api().post(`/api/v1/ncrs/${ids.ncrA}/transitions`).set(h).send({ to: 'open' })).status).toBe(200);
    const list = (await api().get('/api/v1/ncrs?cf_shift=day').set(h).expect(200)).body;
    expect(list.data.map((n: { id: string }) => n.id)).toEqual([ids.ncrA]);
    expect(list.data[0].customValues).toEqual({ shift: 'Days' });
  });
});
