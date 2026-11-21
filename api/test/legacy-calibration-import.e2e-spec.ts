/**
 * Legacy calibration records through the API: a file of old calibrations is imported against gauges by asset number, each record is marked legacy (with where
 * it came from), carries no readings, shows in the calibration API as legacy, makes the gauge show its last and next due dates, can only be added (a second
 * import of the same record writes nothing), and a bad outcome or an unknown gauge rejects only that row.
 */
import { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { strToU8 } from 'fflate';
import { Pool } from 'pg';
import request from 'supertest';
import { configureApp } from '../src/app.factory';
import { AppModule } from '../src/app.module';
import { IntegrationFileStore } from '../src/integrations/core/file-store';
import { giveControllerSeats, makeIds, requireDb, seed, testEnv, token } from './helpers';

const ids = makeIds('9c7e');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const owner = () => as(ids.ownerA);
const base = '/api/v1/integrations';

const files = new Map<string, Uint8Array>();
class MemoryStore extends IntegrationFileStore {
  get enabled() {
    return true;
  }
  async download(path: string) {
    return files.get(path) ?? null;
  }
}

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-lc');
  await giveControllerSeats(admin, ids.orgA, [ids.ownerA]);
  const env = testEnv({ RATE_LIMIT_PER_MINUTE: '10000' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).overrideProvider(IntegrationFileStore).useValue(new MemoryStore()).compile();
  const nest = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, rawBody: true });
  app = configureApp(nest, env);
  await app.init();
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('legacy calibration records', () => {
  let connId: string;
  let gaugeId: string;
  const upload = async (name: string, text: string): Promise<string> => {
    const path = `${ids.orgA}/integration/${connId}/${Math.random().toString(36).slice(2)}-${name}`;
    files.set(path, strToU8(text));
    return (await api().post(`${base}/connections/${connId}/files`).set(await owner()).send({ path, fileName: name, size: text.length }).expect(201)).body.id;
  };
  const run = async (fileId: string) =>
    (await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType: 'calibration', kind: 'full', fileId }).expect(201)).body;

  it('offers calibration records as an importable kind that is always add only', async () => {
    connId = (await api().post(`${base}/connections`).set(await owner()).send({ providerKey: 'csv', name: 'Old QMS', externalSystem: 'oldqms' }).expect(201)).body.id;
    const c = (await api().get(`${base}/connections/${connId}`).set(await owner()).expect(200)).body;
    expect(c.importable).toContain('calibration');
    expect(c.writable).toContain('calibration');
    const entities = (await api().get(`${base}/entities`).set(await owner()).expect(200)).body.data;
    expect(entities.find((e: { entityType: string }) => e.entityType === 'calibration')).toMatchObject({ label: 'Calibration records (legacy)' });
    const bad = await api().put(`${base}/connections/${connId}/settings`).set(await owner()).send({ entityType: 'calibration', writeMode: 'add_update' }).expect(409);
    expect(bad.body.error.message).toMatch(/only ever added/);
    gaugeId = (await admin.query(`insert into public.gauges (organisation_id, asset_number, description) values ($1, 'LC-001', 'Old caliper') returning id`, [ids.orgA])).rows[0].id;
  });

  it('imports old calibrations as legacy records and rejects only the bad rows', async () => {
    const fileId = await upload('cal.csv', [
      'Id,Gauge,Date,Result,Next,Cert,Who',
      '1,LC-001,2026-06-01,PASS,2026-12-01,C-77,A. Hand',
      '2,LC-001,2025-12-01,adjusted,2026-06-01,,',
      '3,LC-001,2026-05-01,maybe,,,',
      '4,NO-SUCH,2026-05-01,pass,,,',
    ].join('\n'));
    await api().put(`${base}/connections/${connId}/mapping`).set(await owner()).send({
      entityType: 'calibration', keyField: 'Id', fileId,
      fields: [
        { target: 'gauge', source: 'Gauge', match: 'code' }, { target: 'calibratedOn', source: 'Date' },
        { target: 'outcome', source: 'Result', steps: [{ kind: 'lower' }] }, { target: 'nextDueOn', source: 'Next' },
        { target: 'certificateNumber', source: 'Cert' }, { target: 'technicianName', source: 'Who' },
      ],
    }).expect(200);
    const res = await run(fileId);
    expect(res.counts).toMatchObject({ total: 4, created: 2, rejected: 2 });
    const rows = (await admin.query(
      `select is_legacy, imported_from, imported_technician, outcome, certificate_number,
              (select count(*)::int from public.calibration_readings r where r.calibration_id = c.id) as readings
         from public.calibrations c where organisation_id = $1 order by calibrated_on desc`, [ids.orgA])).rows;
    expect(rows).toEqual([
      { is_legacy: true, imported_from: 'oldqms', imported_technician: 'A. Hand', outcome: 'pass', certificate_number: 'C-77', readings: 0 },
      { is_legacy: true, imported_from: 'oldqms', imported_technician: null, outcome: 'adjusted', certificate_number: null, readings: 0 },
    ]);
    const g = (await admin.query(`select to_char(last_calibrated_on, 'YYYY-MM-DD') as last, to_char(next_due_on, 'YYYY-MM-DD') as next from public.gauges where id = $1`, [gaugeId])).rows[0];
    expect(g).toEqual({ last: '2026-06-01', next: '2026-12-01' });
    expect((await admin.query(`select count(*)::int as n from public.outbox_events where organisation_id = $1 and event_type = 'calibration.recorded'`, [ids.orgA])).rows[0].n).toBe(0);
  });

  it('shows the legacy mark in the calibration API, and the same file again adds nothing', async () => {
    const list = (await api().get(`/api/v1/gauges/${gaugeId}/calibrations`).set(await owner()).expect(200)).body;
    const items = list.data ?? list;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ legacy: true, importedFrom: 'oldqms', readingCount: 0 });
    const fileId = await upload('cal2.csv', ['Id,Gauge,Date,Result', '1,LC-001,2026-06-01,pass'].join('\n'));
    const again = await run(fileId);
    expect(again.counts).toMatchObject({ created: 0 });
    expect((await admin.query(`select count(*)::int as n from public.calibrations where organisation_id = $1`, [ids.orgA])).rows[0].n).toBe(2);
  });
});
