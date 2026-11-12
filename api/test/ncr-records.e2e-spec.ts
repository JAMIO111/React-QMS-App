/**
 * NCR costs and attachments through the API: totals worked out by the server, soft delete and
 * restore, upload-folder rules, locking with the NCR, site scoping and permissions.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { categoryId, makeIds, requireDb, seed, settleNcr, startApp, token } from './helpers';

const ids = makeIds(8);
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org: string = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const SITE_USER = '80000000-0000-0000-0000-00000000aa77';
let plantB: string;
let ncr: string;
let ncrAtB: string;

const upload = (path: string) => admin.query(`insert into storage.objects (bucket_id, name) values ('nc-files', $1)`, [path]);

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-ncr-records');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const one = async (q: string, params: unknown[]) => (await admin.query(q, params)).rows[0];
  await admin.query(`insert into storage.buckets (id, name) values ('nc-files', 'nc-files') on conflict do nothing`);
  await admin.query(`update public.organisation_settings set base_currency = 'GBP', vat_rate = 0.2 where organisation_id = $1`, [ids.orgA]);
  plantB = (await one(`insert into public.sites (organisation_id, code, name) values ($1, 'PB', 'Plant B') returning id`, [ids.orgA])).id;
  await admin.query(`insert into auth.users (id, email) values ($1, 'site.user@records.test')`, [SITE_USER]);
  const m = await one(`insert into public.organisation_users (organisation_id, user_id, status) values ($1, $2, 'active') returning id`, [ids.orgA, SITE_USER]);
  await admin.query(
    `insert into public.user_role_assignments (organisation_id, membership_id, role_id, site_id) select $1, $2, id, $3 from public.roles where organisation_id = $1 and key = 'quality_engineer'`,
    [ids.orgA, m.id, plantB],
  );
  const h = await as(ids.ownerA);
  ncr = (await api().post('/api/v1/ncrs').set(h).send({ source: 'internal', title: 'Scrapped batch', siteId: ids.siteA }).expect(201)).body.id;
  ncrAtB = (await api().post('/api/v1/ncrs').set(h).send({ source: 'internal', title: 'At plant B', siteId: plantB }).expect(201)).body.id;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('costs', () => {
  let costId: string;

  it('adds costs with VAT and currency worked out by the server', async () => {
    const h = await as(ids.ownerA);
    const inc = await api().post(`/api/v1/ncrs/${ncr}/costs`).set(h)
      .send({ costType: 'scrap', currency: 'gbp', vatTreatment: 'inclusive', vatRate: 0.2, quantity: 4, unitCost: 30, description: 'Scrapped bar' }).expect(201);
    expect(inc.body).toMatchObject({ costType: 'scrap', currency: 'GBP', quantity: 4, unitCost: 30, amount: 120, netAmount: 100, vatAmount: 20, grossAmount: 120, grossBase: 120, baseCurrency: 'GBP', createdBy: { id: ids.ownerA } });
    costId = inc.body.id;
    const eur = await api().post(`/api/v1/ncrs/${ncr}/costs`).set(h)
      .send({ costType: 'transport', currency: 'EUR', unitCost: 50, exchangeRate: 0.85, incurredOn: '2026-10-01' }).expect(201);
    expect(eur.body).toMatchObject({ quantity: 1, unitCost: 50, vatTreatment: 'none', grossAmount: 50, netBase: 42.5, grossBase: 42.5, incurredOn: '2026-10-01' });

    const list = await api().get(`/api/v1/ncrs/${ncr}/costs`).set(h).expect(200);
    expect(list.body.totals).toEqual({ baseCurrency: 'GBP', net: 142.5, gross: 162.5, count: 2 });

    // The register shows each NCR's total cost and can sort by it.
    const register = await api().get('/api/v1/ncrs?source=internal&sort=totalCost&order=desc').set(h).expect(200);
    const row = register.body.data.find((n: { id: string }) => n.id === ncr);
    expect(row).toMatchObject({ totalCost: 162.5, costCurrency: 'GBP' });
    expect(register.body.data[0].id).toBe(ncr);
    expect(register.body.data.find((n: { id: string }) => n.id === ncrAtB)).toMatchObject({ totalCost: 0 });
    expect(list.body.data.map((c: { costType: string }) => c.costType)).toEqual(['scrap', 'transport']);
  });

  it('validates input', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/ncrs/${ncr}/costs`).set(h).send({ costType: 'bribes', currency: 'GBP', unitCost: 1 }).expect(400);
    await api().post(`/api/v1/ncrs/${ncr}/costs`).set(h).send({ costType: 'scrap', currency: 'GBP', unitCost: -5 }).expect(400);
    await api().post(`/api/v1/ncrs/${ncr}/costs`).set(h).send({ costType: 'scrap', currency: 'GBP', unitCost: 5, quantity: 0 }).expect(400);
    // The amount is worked out by the database, never sent.
    await api().post(`/api/v1/ncrs/${ncr}/costs`).set(h).send({ costType: 'scrap', currency: 'GBP', unitCost: 5, amount: 1 }).expect(400);
    await api().post(`/api/v1/ncrs/${ncr}/costs`).set(h).send({ costType: 'scrap', currency: 'GBP', unitCost: 1, netAmount: 0 }).expect(400);
    await api().patch(`/api/v1/ncr-costs/${costId}`).set(h).send({}).expect(400);
  });

  it('edits, deletes with a reason and restores', async () => {
    const h = await as(ids.ownerA);
    const edited = await api().patch(`/api/v1/ncr-costs/${costId}`).set(h).send({ vatTreatment: 'exclusive', unitCost: 25 }).expect(200);
    expect(edited.body).toMatchObject({ quantity: 4, unitCost: 25, amount: 100, netAmount: 100, grossAmount: 120 });
    const halves = await api().patch(`/api/v1/ncr-costs/${costId}`).set(h).send({ quantity: 2.5 }).expect(200);
    expect(halves.body).toMatchObject({ amount: 62.5, grossAmount: 75 });
    await api().patch(`/api/v1/ncr-costs/${costId}`).set(h).send({ quantity: 4 }).expect(200);
    await api().post(`/api/v1/ncr-costs/${costId}/delete`).set(h).send({}).expect(400);
    const deleted = await api().post(`/api/v1/ncr-costs/${costId}/delete`).set(h).send({ reason: 'Duplicate' }).expect(200);
    expect(deleted.body).toMatchObject({ deleteReason: 'Duplicate' });
    expect((await api().get(`/api/v1/ncrs/${ncr}/costs`).set(h).expect(200)).body.totals.count).toBe(1);
    expect((await api().get(`/api/v1/ncrs/${ncr}`).set(h).expect(200)).body.totalCost).toBe(42.5);
    expect((await api().get(`/api/v1/ncrs/${ncr}/costs?deleted=only`).set(h).expect(200)).body.data.map((c: { id: string }) => c.id)).toEqual([costId]);
    const locked = await api().patch(`/api/v1/ncr-costs/${costId}`).set(h).send({ unitCost: 1 }).expect(409);
    expect(locked.body.error.message).toBe('This cost is deleted');
    await api().post(`/api/v1/ncr-costs/${costId}/restore`).set(h).expect(200);
    expect((await api().get(`/api/v1/ncrs/${ncr}/costs`).set(h).expect(200)).body.totals.count).toBe(2);
  });

  it('needs ncr.update to add costs and keeps site-scoped users to their site', async () => {
    await api().post(`/api/v1/ncrs/${ncr}/costs`).set(await as(ids.inspectorA)).send({ costType: 'scrap', currency: 'GBP', unitCost: 1 }).expect(403);
    await api().get(`/api/v1/ncrs/${ncr}/costs`).set(await as(ids.inspectorA)).expect(200);
    const site = await as(SITE_USER);
    await api().get(`/api/v1/ncrs/${ncr}/costs`).set(site).expect(404);
    await api().patch(`/api/v1/ncr-costs/${costId}`).set(site).send({ unitCost: 1 }).expect(404);
    await api().post(`/api/v1/ncrs/${ncrAtB}/costs`).set(site).send({ costType: 'sorting', currency: 'GBP', unitCost: 25 }).expect(201);
  });
});

describe('register filters', () => {
  const refs = async (qs: string) =>
    ((await api().get(`/api/v1/ncrs?source=internal&${qs}`).set(await as(ids.ownerA)).expect(200)).body.data as { id: string }[]).map((n) => n.id).sort();

  it('filters by total cost, quantity, severity and detected date', async () => {
    const h = await as(ids.ownerA);
    await api().patch(`/api/v1/ncrs/${ncr}`).set(h).send({ severity: 'major', quantityAffected: 12, detectedAt: '2026-10-05' }).expect(200);
    await api().patch(`/api/v1/ncrs/${ncrAtB}`).set(h).send({ severity: 'minor', quantityAffected: 3, detectedAt: '2026-11-01' }).expect(200);
    // ncr has 162.50 of costs, ncrAtB has 25.00 (added in the cost tests).
    expect(await refs('costMin=100')).toEqual([ncr]);
    expect(await refs('costMax=100')).toEqual([ncrAtB]);
    expect(await refs('costMin=20&costMax=30')).toEqual([ncrAtB]);
    expect(await refs('qtyMin=10')).toEqual([ncr]);
    expect(await refs('qtyMax=5')).toEqual([ncrAtB]);
    expect(await refs('severity=major')).toEqual([ncr]);
    expect(await refs('severity=major,minor')).toEqual([ncr, ncrAtB].sort());
    expect(await refs('from=2026-10-20')).toEqual([ncrAtB]);
    expect(await refs('to=2026-10-20')).toEqual([ncr]);
    expect(await refs('severity=major&qtyMax=5')).toEqual([]);
    // Stages (both are drafts here; the register's stage filter takes a comma-separated list).
    expect(await refs('stage=draft')).toEqual([ncr, ncrAtB].sort());
    expect(await refs('stage=open,closed')).toEqual([]);
    await api().get('/api/v1/ncrs?severity=huge').set(h).expect(400);
    await api().get('/api/v1/ncrs?costMin=-1').set(h).expect(400);
  });

  it('reports the highest cost and quantity for the sliders', async () => {
    const res = await api().get('/api/v1/ncrs/ranges?source=internal').set(await as(ids.ownerA)).expect(200);
    expect(res.body).toEqual({ cost: { max: 162.5 }, quantity: { max: 12 }, baseCurrency: 'GBP' });
    const supplier = await api().get('/api/v1/ncrs/ranges?source=supplier').set(await as(ids.ownerA)).expect(200);
    expect(supplier.body).toMatchObject({ cost: { max: 0 }, quantity: { max: 0 } });
  });
});

describe('attachments', () => {
  let fileId: string;

  it('records an uploaded file in the NCR folder', async () => {
    const h = await as(ids.ownerA);
    const path = `${ids.orgA}/ncr/${ncr}/abc-photo.jpg`;
    const notYet = await api().post(`/api/v1/ncrs/${ncr}/attachments`).set(h).send({ storagePath: path, fileName: 'photo.jpg', contentType: 'image/jpeg', sizeBytes: 2048 }).expect(400);
    expect(notYet.body.error.code).toBe('file_not_uploaded');
    await upload(path);
    const res = await api().post(`/api/v1/ncrs/${ncr}/attachments`).set(h).send({ storagePath: path, fileName: 'photo.jpg', contentType: 'image/jpeg', sizeBytes: 2048 }).expect(201);
    expect(res.body).toMatchObject({ fileName: 'photo.jpg', sizeBytes: 2048, storagePath: path, createdBy: { id: ids.ownerA } });
    fileId = res.body.id;
    expect((await api().get(`/api/v1/ncrs/${ncr}/attachments`).set(h).expect(200)).body.data.map((f: { id: string }) => f.id)).toEqual([fileId]);
  });

  it('refuses files outside the NCR folder and oversized files', async () => {
    const h = await as(ids.ownerA);
    for (const storagePath of [`${ids.orgA}/ncr/${ncrAtB}/x.jpg`, `${ids.orgB}/ncr/${ncr}/x.jpg`, `${ids.orgA}/ncr/${ncr}/../x.jpg`, `${ids.orgA}/ncr/${ncr}/`]) {
      const res = await api().post(`/api/v1/ncrs/${ncr}/attachments`).set(h).send({ storagePath, fileName: 'x.jpg', sizeBytes: 1 }).expect(400);
      expect(res.body.error.code).toBe('invalid_path');
    }
    await api().post(`/api/v1/ncrs/${ncr}/attachments`).set(h).send({ storagePath: `${ids.orgA}/ncr/${ncr}/big.bin`, fileName: 'big.bin', sizeBytes: 26 * 1024 * 1024 }).expect(400);
  });

  it('removes with a reason (the stored file stays) and restores', async () => {
    const h = await as(ids.ownerA);
    await api().post(`/api/v1/ncr-attachments/${fileId}/delete`).set(h).send({ reason: 'Wrong photo' }).expect(200);
    expect((await api().get(`/api/v1/ncrs/${ncr}/attachments`).set(h).expect(200)).body.data).toEqual([]);
    const { rows } = await admin.query(`select count(*)::int as n from storage.objects where name = $1`, [`${ids.orgA}/ncr/${ncr}/abc-photo.jpg`]);
    expect(rows[0].n).toBe(1);
    await api().post(`/api/v1/ncr-attachments/${fileId}/restore`).set(h).expect(200);
  });

  it('locks costs and files when the NCR is closed', async () => {
    const h = await as(ids.ownerA);
    await api().patch(`/api/v1/ncrs/${ncr}`).set(h).send({ severity: 'minor', quantityAffected: 1, description: 'x', categoryId: await categoryId(admin, ids.orgA) }).expect(200);
    await api().post(`/api/v1/ncrs/${ncr}/transitions`).set(h).send({ to: 'open' }).expect(200);
    await settleNcr(app.getHttpServer(), h, ncr);
    await api().post(`/api/v1/ncrs/${ncr}/transitions`).set(h).send({ to: 'closed' }).expect(200);
    const res = await api().post(`/api/v1/ncrs/${ncr}/costs`).set(h).send({ costType: 'scrap', currency: 'GBP', unitCost: 1 }).expect(409);
    expect(res.body.error.message).toBe('This non-conformance is closed; reopen it to make changes');
    await api().post(`/api/v1/ncr-attachments/${fileId}/delete`).set(h).send({ reason: 'Late' }).expect(409);
  });
});

describe('NC dashboard', () => {
  it('summarises the period: KPIs, trend, failure modes, stages, severity and parts', async () => {
    const h = await as(ids.ownerA);
    const today = new Date().toISOString().slice(0, 10);
    const res = await api().get(`/api/v1/ncr-dashboard?source=internal&from=2026-10-01&to=${today}`).set(h).expect(200);
    const d = res.body;
    // ncr: detected 2026-10-05, minor and qty 1 (set by the locking test), £162.50, closed today.
    // ncrAtB: detected 2026-11-01, minor, qty 3, £25, draft.
    expect(d.kpis).toMatchObject({ raised: 2, open: 1, criticalOpen: 0, closed: 1, cost: 187.5, quantity: 4, raisedPrevious: 0, costPrevious: 0 });
    expect(d.kpis.avgDaysToClose).toBeGreaterThan(0);
    expect(d.baseCurrency).toBe('GBP');
    expect(d.trend.reduce((t: number, b: { total: number }) => t + b.total, 0)).toBe(2);
    expect(d.trend.reduce((t: number, b: { bySource: Record<string, number> }) => t + (b.bySource.internal ?? 0), 0)).toBe(2);
    expect(d.trend.every((b: { bySource: Record<string, number> }) => Object.keys(b.bySource).every((k) => k === 'internal'))).toBe(true);
    // By source: all eleven in the fixed order; by category: the NC with a category, and the one without ("Uncategorised").
    expect(d.bySource.map((s: { key: string }) => s.key)).toEqual(['internal', 'customer', 'supplier', 'internal_audit', 'external_audit', 'production_inspection', 'final_inspection', 'calibration', 'goods_receiving', 'engineering', 'management_review']);
    expect(d.bySource.find((s: { key: string }) => s.key === 'internal')).toEqual({ key: 'internal', label: 'Internal', count: 2 });
    expect(d.bySource.filter((s: { count: number }) => s.count > 0)).toHaveLength(1);
    expect(d.byCategory).toEqual([{ key: expect.any(String), label: 'Product', count: 1 }, { key: 'none', label: 'Uncategorised', count: 1 }]);
    expect(d.trend.reduce((t: number, b: { cost: number }) => t + b.cost, 0)).toBe(187.5);
    expect(d.byFailureMode).toEqual([{ key: 'none', label: 'Not classified', count: 2 }]);
    expect(d.byStage.find((s: { key: string }) => s.key === 'draft').count).toBe(1);
    expect(d.bySeverity.map((s: { count: number }) => s.count)).toEqual([0, 0, 2, 0]);
    expect(d.topParts).toEqual([]);

    // The site-scoped user only counts their own site's NCR.
    const site = await api().get(`/api/v1/ncr-dashboard?from=2026-10-01&to=${today}`).set(await as(SITE_USER)).expect(200);
    expect(site.body.kpis).toMatchObject({ raised: 1, cost: 25 });

    await api().get('/api/v1/ncr-dashboard?from=2026-12-01&to=2026-01-01').set(h).expect(400);
    await api().get('/api/v1/ncr-dashboard').set(h).expect(400);
  });
});
