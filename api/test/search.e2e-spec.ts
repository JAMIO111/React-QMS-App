/**
 * The header palette's record search: it finds records by the words people type (a reference, a number, a name), answers only for kinds the
 * caller may read (a kind they may not read is absent, never an empty list), shows only what row-level security lets them read, and escapes
 * what is typed so "%" and "_" mean themselves.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('e8');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const find = async (query: string, user = ids.ownerA, org = ids.orgA) => (await api().get(`/api/v1/search?${query}`).set(await as(user, org)).expect(200)).body;
const kinds = (body: { groups: { kind: string }[] }) => body.groups.map((g) => g.kind).sort();

const ctx: Record<string, string> = {};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-search');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA);
  const post = async (path: string, body: object) => (await api().post(`/api/v1${path}`).set(h).send(body).expect(201)).body;
  ctx.ncr = (await post('/ncrs', { source: 'internal', title: 'Cracked housing on line 3' })).id;
  ctx.capa = (await post('/capas', { title: 'Recurring cracks', problemStatement: 'Housing cracks after anodising' })).id;
  ctx.part = (await post('/parts', { partNumber: 'HOUS-100', name: 'Pump housing', initialRevision: { revision: 'A' } })).id;
  await post('/parts', { partNumber: 'PLUG_50%', name: 'Odd plug', initialRevision: { revision: 'A' } });
  ctx.supplier = (await post('/suppliers', { code: 'ACME', name: 'Acme Castings' })).id;
  const gaugeType = (await post('/gauge-types', { code: 'BORE', name: 'Bore gauge' })).id;
  ctx.gauge = (await post('/gauges', { assetNumber: 'CAL-HOUS-1', description: 'Housing bore gauge', gaugeTypeId: gaugeType, siteId: ids.siteA })).id;
  const types = (await api().get('/api/v1/document-types').set(h).expect(200)).body.data;
  ctx.doc = (await post('/documents', { typeId: types[0].id, title: 'Housing inspection procedure', contentKind: 'text' })).id;
  // Another organisation has a record with the same word in it.
  const other = await as(ids.ownerB, ids.orgB);
  await api().post('/api/v1/parts').set(other).send({ partNumber: 'HOUS-999', name: 'Their housing', initialRevision: { revision: 'A' } }).expect(201);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('finding records', () => {
  it('answers with a group for every kind that has a match, each with its total and the first rows', async () => {
    const r = await find('q=hous');
    expect(r.q).toBe('hous');
    expect(kinds(r)).toEqual(['capa', 'document', 'gauge', 'ncr', 'part']);
    const group = (kind: string) => r.groups.find((g: { kind: string }) => g.kind === kind);
    expect(group('part')).toMatchObject({ total: 1, items: [{ id: ctx.part, title: 'HOUS-100', subtitle: 'Pump housing' }] });
    expect(group('ncr').items[0]).toMatchObject({ id: ctx.ncr, subtitle: 'Cracked housing on line 3' });
    expect(group('ncr').items[0].title).toMatch(/^[A-Z]{1,5}-\d{2}-\d{4}$/);
    expect(group('gauge').items[0]).toMatchObject({ id: ctx.gauge, title: 'CAL-HOUS-1' });
    expect(group('document').items[0]).toMatchObject({ id: ctx.doc, subtitle: 'Housing inspection procedure', status: 'draft' });
    expect(group('capa').items[0].id).toBe(ctx.capa);
  });

  it('finds by reference, number and code and ranks a start-of-word match first', async () => {
    const ncr = (await find('q=hous&kind=ncr')).groups[0].items[0];
    expect(kinds(await find(`q=${encodeURIComponent(ncr.title)}`))).toEqual(['ncr']);
    expect(kinds(await find('q=acme'))).toEqual(['supplier']);
    const parts = await find('q=hous-&kind=part');
    expect(parts.groups[0].items.map((i: { title: string }) => i.title)).toEqual(['HOUS-100']);
  });

  it('takes one kind and a limit, and says how many matched in all', async () => {
    const h = await as(ids.ownerA);
    for (const n of [1, 2, 3]) {
      await api().post('/api/v1/parts').set(h).send({ partNumber: `BRKT-${n}`, name: 'Bracket', initialRevision: { revision: 'A' } }).expect(201);
    }
    const r = await find('q=brkt&kind=part&limit=2');
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]).toMatchObject({ kind: 'part', total: 3 });
    expect(r.groups[0].items).toHaveLength(2);
  });

  it('treats % and _ as the characters themselves', async () => {
    expect((await find('q=' + encodeURIComponent('50%'))).groups[0].items.map((i: { title: string }) => i.title)).toEqual(['PLUG_50%']);
    expect((await find('q=' + encodeURIComponent('PLUG_'))).groups[0].items).toHaveLength(1);
    expect(await find('q=' + encodeURIComponent('%%'))).toMatchObject({ groups: [] });
  });

  it('asks for at least two characters, one known kind and a sensible limit', async () => {
    const h = await as(ids.ownerA);
    await api().get('/api/v1/search?q=a').set(h).expect(400);
    await api().get('/api/v1/search').set(h).expect(400);
    await api().get('/api/v1/search?q=hous&kind=nonsense').set(h).expect(400);
    await api().get('/api/v1/search?q=hous&limit=500').set(h).expect(400);
  });
});

describe('who finds what', () => {
  it('never shows another organisation its neighbour\'s records, and refuses people who do not belong', async () => {
    const theirs = await find('q=hous', ids.ownerB, ids.orgB);
    expect(kinds(theirs)).toEqual(['part']);
    expect(theirs.groups[0].items.map((i: { title: string }) => i.title)).toEqual(['HOUS-999']);
    await api().get('/api/v1/search?q=hous').set(await as(ids.ownerB, ids.orgA)).expect(404);
    await api().get('/api/v1/search?q=hous').set(await as(ids.suspendedA)).expect(404);
    await api().get('/api/v1/search?q=hous').set({ 'X-Organisation-Id': ids.orgA }).expect(401);
  });

  it('leaves out a kind the person may not read, as that kind\'s own register refuses them', async () => {
    const strip = async (permission: string) =>
      admin.query(`delete from public.role_permissions where permission_code = $2 and role_id = (select id from public.roles where organisation_id = $1 and key = 'viewer')`, [ids.orgA, permission]);
    const before = await find('q=hous', ids.dual);
    expect(kinds(before)).toEqual(expect.arrayContaining(['part', 'ncr']));
    await strip('master_data.read');
    const after = await find('q=hous', ids.dual);
    expect(kinds(after)).not.toContain('part');
    expect(kinds(after)).toContain('ncr');
    await api().get('/api/v1/parts?q=hous').set(await as(ids.dual)).expect(403);
  });
});
