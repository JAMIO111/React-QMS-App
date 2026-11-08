/**
 * Non-conformances: category and source as separate things, through the API — the organisation's categories (eleven seeded, managed by the organisation), the eleven fixed
 * sources, a category needed to open and kept once open, filtering and sorting by both, changing the source with a reason, and the dashboard by source and category.
 * The rules themselves are in supabase/tests/ncr_category_source.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { categoryId, makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('b5');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};
const SOURCES = ['internal', 'customer', 'supplier', 'internal_audit', 'external_audit', 'production_inspection', 'final_inspection', 'calibration', 'goods_receiving', 'engineering', 'management_review'];
const full = { severity: 'minor', quantityAffected: 2, description: 'x' };

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-cs');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  ctx.product = await categoryId(admin, ids.orgA);
  ctx.process = await categoryId(admin, ids.orgA, 'PROCESS');
  ctx.customer = (await admin.query(`insert into public.customers (organisation_id, code, name) values ($1, 'ACME', 'Acme') returning id`, [ids.orgA])).rows[0].id;
  ctx.failureMode = (await admin.query(`insert into public.ncr_classifications (organisation_id, kind, name) values ($1, 'failure_mode', 'Crack') returning id`, [ids.orgA])).rows[0].id;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

const create = async (body: object, h?: Record<string, string>) => api().post('/api/v1/ncrs').set(h ?? (await as(ids.ownerA))).send(body);

describe('categories', () => {
  it('start as the eleven defaults, in order, for every organisation', async () => {
    const res = await api().get('/api/v1/ncr-classifications?kind=category').set(await as(ids.dual)).expect(200);
    expect(res.body.data.map((c: { name: string }) => c.name)).toEqual(['Product', 'Process', 'Tooling', 'Equipment', 'Calibration', 'Material', 'Documentation', 'Inspection', 'System', 'Traceability', 'Packaging & Handling']);
    expect(res.body.data[0]).toMatchObject({ kind: 'category', code: 'PRODUCT', parentId: null, active: true });
    expect((await api().get('/api/v1/ncr-classifications?kind=category').set(await as(ids.ownerB, ids.orgB)).expect(200)).body.data).toHaveLength(11);
  });

  it('are added, renamed and switched off by someone who manages lookups, and nothing else is a category', async () => {
    const owner = await as(ids.ownerA);
    expect((await api().post('/api/v1/ncr-classifications').set(await as(ids.dual)).send({ kind: 'category', name: 'Software' })).status).toBe(403);
    const made = await api().post('/api/v1/ncr-classifications').set(owner).send({ kind: 'category', code: 'software', name: 'Software' });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ kind: 'category', code: 'SOFTWARE', name: 'Software', active: true });
    expect((await api().post('/api/v1/ncr-classifications').set(owner).send({ kind: 'category', name: 'software' })).status).toBe(409);
    expect((await api().post('/api/v1/ncr-classifications').set(owner).send({ kind: 'category', name: 'Child', parentId: ctx.product })).status).toBeGreaterThanOrEqual(400);
    const patch = (b: object) => api().patch(`/api/v1/ncr-classifications/${made.body.id}`).set(owner).send(b);
    expect((await patch({ name: 'Software and IT' })).body.name).toBe('Software and IT');
    expect((await patch({ active: false })).body.active).toBe(false);
    const listed = (await api().get('/api/v1/ncr-classifications?kind=category').set(owner).expect(200)).body.data.map((c: { name: string }) => c.name);
    expect(listed).not.toContain('Software and IT');
    expect((await api().get('/api/v1/ncr-classifications?kind=category&includeInactive=true').set(owner).expect(200)).body.data.map((c: { name: string }) => c.name)).toContain('Software and IT');
    // The organisation's other lists are not categories, and a non-category cannot be chosen as one.
    const wrong = await create({ source: 'internal', title: 'Wrong kind', categoryId: ctx.failureMode });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.message).toContain('category must be one of');
  });
});

describe('the source and the category on a non-conformance', () => {
  it('takes any of the eleven sources, and nothing else', async () => {
    for (const source of SOURCES) {
      const res = await create({ source, title: `From ${source}` });
      expect([source, res.status]).toEqual([source, 201]);
      expect(res.body.source).toBe(source);
    }
    expect((await create({ source: 'inspection', title: 'The old value' })).status).toBe(400);
    expect((await create({ source: 'other', title: 'Nope' })).status).toBe(400);
  });

  it('shows the category it was given, and none for one without', async () => {
    const withCat = await create({ source: 'calibration', title: 'Gauge failed', categoryId: ctx.process });
    expect(withCat.body).toMatchObject({ source: 'calibration', category: { id: ctx.process, name: 'Process' } });
    ctx.draft = withCat.body.id;
    const without = await create({ source: 'engineering', title: 'Wrong drawing' });
    expect(without.body.category).toBeNull();
    expect((await create({ source: 'internal', title: 'Foreign', categoryId: ids.ownerA })).status).toBeGreaterThanOrEqual(400);
  });

  it('needs a category to open, and keeps one once open (it can be changed, not cleared)', async () => {
    const h = await as(ids.ownerA);
    const noCat = await create({ source: 'internal', title: 'No category', ...full, open: true });
    expect(noCat.status).toBe(409);
    expect(noCat.body.error.message).toBe('To open this non-conformance, fill in: category');
    const opened = await create({ source: 'internal', title: 'With category', ...full, categoryId: ctx.product, open: true });
    expect(opened.status).toBe(201);
    ctx.open = opened.body.id;
    const cleared = await api().patch(`/api/v1/ncrs/${ctx.open}`).set(h).send({ categoryId: null });
    expect(cleared.status).toBe(409);
    expect(cleared.body.error.message).toContain('can be changed but not cleared');
    const changed = await api().patch(`/api/v1/ncrs/${ctx.open}`).set(h).send({ categoryId: ctx.process }).expect(200);
    expect(changed.body.category.name).toBe('Process');
    // A draft may have its category taken away, and a transition to open is refused until it has one again.
    const draft = (await create({ source: 'internal', title: 'Draft', ...full, categoryId: ctx.product })).body.id;
    await api().patch(`/api/v1/ncrs/${draft}`).set(h).send({ categoryId: null }).expect(200);
    const refused = await api().post(`/api/v1/ncrs/${draft}/transitions`).set(h).send({ to: 'open' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe('To open this non-conformance, fill in: category');
  });

  it('records a category change in the history with its name', async () => {
    const res = await api().get(`/api/v1/ncrs/${ctx.open}/history`).set(await as(ids.ownerA)).expect(200);
    const entry = res.body.data.find((e: { changedFields: string[] }) => e.changedFields.includes('category_id'));
    expect(entry.current.category_id).toBe(ctx.process);
    expect(entry.names[ctx.process]).toBe('Process');
  });
});

describe('the register', () => {
  const list = async (query = '', h?: Record<string, string>) => (await api().get(`/api/v1/ncrs${query}`).set(h ?? (await as(ids.ownerA))).expect(200)).body;
  const titles = (r: { data: { title: string }[] }) => r.data.map((n) => n.title).sort();

  it('filters by one or several sources, a category, and those without a category', async () => {
    expect(titles(await list('?source=customer'))).toEqual(['From customer']);
    expect(titles(await list('?source=customer,supplier'))).toEqual(['From customer', 'From supplier']);
    expect(titles(await list('?source=calibration,engineering'))).toEqual(['Gauge failed', 'From calibration', 'From engineering', 'Wrong drawing'].sort());
    expect(titles(await list(`?categoryId=${ctx.process}`))).toEqual(['Gauge failed', 'With category']);
    const none = await list('?uncategorised=true&pageSize=100');
    expect(none.data.every((n: { category: unknown }) => n.category === null)).toBe(true);
    expect(none.data.map((n: { title: string }) => n.title)).toContain('Wrong drawing');
    expect(none.data.map((n: { title: string }) => n.title)).not.toContain('Gauge failed');
    expect((await api().get('/api/v1/ncrs?source=bogus').set(await as(ids.ownerA))).status).toBe(400);
    expect((await api().get('/api/v1/ncrs?source=customer,bogus').set(await as(ids.ownerA))).status).toBe(400);
  });

  it('takes the exact lists the register and dashboard quick tabs send (Internal, Customer, Supplier with goods receiving)', async () => {
    const h = await as(ids.ownerA);
    const today = new Date().toISOString().slice(0, 10);
    const tabs = [
      'internal,internal_audit,external_audit,production_inspection,final_inspection,calibration,engineering,management_review',
      'customer',
      'supplier,goods_receiving',
    ];
    for (const t of tabs) {
      expect((await api().get(`/api/v1/ncrs?source=${t}`).set(h)).status).toBe(200);
      expect((await api().get(`/api/v1/ncrs/ranges?source=${t}`).set(h)).status).toBe(200);
      expect((await api().get(`/api/v1/ncr-dashboard?source=${t}&from=2026-01-01&to=${today}`).set(h)).status).toBe(200);
    }
    // Together the three tabs hold every non-conformance exactly once.
    const all = (await list('?pageSize=100')).total;
    const sum = (await Promise.all(tabs.map(async (t) => (await list(`?source=${t}&pageSize=100`)).total))).reduce((a, b) => a + b, 0);
    expect(sum).toBe(all);
  });

  it('shows source and category on every row, and sorts by them', async () => {
    const res = await list('?pageSize=100');
    const row = res.data.find((n: { title: string }) => n.title === 'Gauge failed');
    expect(row).toMatchObject({ source: 'calibration', category: { id: ctx.process, name: 'Process' } });
    const bySource = (await list('?sort=source&order=asc&pageSize=100')).data.map((n: { source: string }) => n.source);
    expect(bySource).toEqual([...bySource].sort());
    const byCat = (await list('?sort=category&order=asc&pageSize=100')).data.filter((n: { category: unknown }) => n.category).map((n: { category: { name: string } }) => n.category.name.toLowerCase());
    expect(byCat).toEqual([...byCat].sort());
  });

  it('gives the ranges for the chosen sources only', async () => {
    await create({ source: 'management_review', title: 'Big one', quantityAffected: 987 });
    const h = await as(ids.ownerA);
    const q = async (s: string) => (await api().get(`/api/v1/ncrs/ranges?source=${s}`).set(h).expect(200)).body.quantity.max;
    expect(await q('management_review,customer')).toBe(987);
    expect(await q('customer,supplier')).toBeLessThan(987);
    expect((await api().get('/api/v1/ncrs/ranges').set(h).expect(200)).body.quantity.max).toBe(987);
  });
});

describe('changing the source', () => {
  const change = async (id: string, body: object, h?: Record<string, string>) => api().post(`/api/v1/ncrs/${id}/source`).set(h ?? (await as(ids.ownerA))).send(body);

  it('needs ncr.update, a real source other than the current one, and a reason', async () => {
    expect((await change(ctx.open, { source: 'calibration', reason: 'Gauge failed' }, await as(ids.dual))).status).toBe(403);
    expect((await change(ctx.open, { source: 'bogus', reason: 'Gauge failed' })).status).toBe(400);
    expect((await change(ctx.open, { source: 'calibration' })).status).toBe(400);
    expect((await change(ctx.open, { source: 'calibration', reason: 'x' })).status).toBe(400);
    expect((await change(ctx.open, { source: 'calibration', reason: 'Gauge failed', extra: 1 })).status).toBe(400);
    const same = await change(ctx.open, { source: 'internal', reason: 'Gauge failed' });
    expect(same.status).toBe(409);
    expect(same.body.error.message).toBe('It already has that source');
  });

  it('changes it, keeping the reason, and says what the party needs first', async () => {
    const res = await change(ctx.open, { source: 'calibration', reason: 'The bore gauge failed its calibration' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'calibration', sourceChangeReason: 'The bore gauge failed its calibration', stage: 'open', category: { name: 'Process' } });
    const needs = await change(ctx.open, { source: 'customer', reason: 'The customer found it too' });
    expect(needs.status).toBe(409);
    expect(needs.body.error.message).toContain('Choose the customer first');
    await api().patch(`/api/v1/ncrs/${ctx.open}`).set(await as(ids.ownerA)).send({ customerId: ctx.customer }).expect(200);
    expect((await change(ctx.open, { source: 'customer', reason: 'The customer found it too' })).body.source).toBe('customer');
    // Moving away keeps what was entered.
    const away = await change(ctx.open, { source: 'engineering', reason: 'Raised against the drawing' });
    expect(away.body).toMatchObject({ source: 'engineering', customer: { name: 'Acme' } });
  });

  it('is in the history, with the reason and the new source', async () => {
    const res = await api().get(`/api/v1/ncrs/${ctx.open}/history`).set(await as(ids.ownerA)).expect(200);
    const entries = res.body.data.filter((e: { changedFields: string[] }) => e.changedFields.includes('source'));
    expect(entries.map((e: { current: { source: string } }) => e.current.source)).toEqual(['calibration', 'customer', 'engineering']);
    expect(entries[0].current.source_change_reason).toBe('The bore gauge failed its calibration');
    expect(entries[0].previous.source).toBe('internal');
  });

  it('is refused for a closed non-conformance and answers 404 for another organisation', async () => {
    const closed = (await create({ source: 'internal', title: 'To close', ...full, categoryId: ctx.product, open: true })).body.id;
    const h = await as(ids.ownerA);
    await admin.query(`update public.nonconformances set containment_not_needed_reason = 'n/a' where id = $1`, [closed]);
    await admin.query(`insert into public.ncr_dispositions (organisation_id, nonconformance_id, decision, quantity, instructions, status, approved_at) values ($1, $2, 'scrap', 2, 'Scrap', 'approved', now())`, [ids.orgA, closed]).catch(() => undefined);
    await api().post(`/api/v1/ncrs/${closed}/transitions`).set(h).send({ to: 'cancelled', reason: 'Not needed' }).expect(200);
    const res = await change(closed, { source: 'engineering', reason: 'Too late to change' });
    expect(res.status).toBe(409);
    expect((await change(ctx.open, { source: 'engineering', reason: 'Not mine' }, await as(ids.ownerB, ids.orgB))).status).toBe(404);
  });
});

describe('the dashboard', () => {
  it('filters by several sources and counts by source and category', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const h = await as(ids.ownerA);
    const all = (await api().get(`/api/v1/ncr-dashboard?from=2026-01-01&to=${today}`).set(h).expect(200)).body;
    expect(all.bySource).toHaveLength(11);
    expect(all.bySource.find((s: { key: string }) => s.key === 'engineering').count).toBeGreaterThanOrEqual(2);
    expect(all.byCategory.some((c: { label: string }) => c.label === 'Uncategorised')).toBe(true);
    expect(all.byCategory.some((c: { label: string }) => c.label === 'Process')).toBe(true);
    const two = (await api().get(`/api/v1/ncr-dashboard?source=customer,supplier&from=2026-01-01&to=${today}`).set(h).expect(200)).body;
    expect(two.kpis.raised).toBe(2);
    expect(two.bySource.filter((s: { count: number }) => s.count > 0).map((s: { key: string }) => s.key)).toEqual(['customer', 'supplier']);
    expect(two.trend.reduce((t: number, b: { total: number }) => t + b.total, 0)).toBe(2);
    expect((await api().get(`/api/v1/ncr-dashboard?source=bogus&from=2026-01-01&to=${today}`).set(h)).status).toBe(400);
  });
});
