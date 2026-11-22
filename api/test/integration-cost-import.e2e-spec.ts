/**
 * Importing NC cost lines through a file connection (docs/cost-import-plan.md, IC2): the NCs first, then their costs linked by the id the source used (or the
 * Fortress reference); every line converted on its own date in its own currency (nothing at the file level), the rates fetched before the lines are written
 * (so they land with theirs), a currency with no published rate imported as waiting and filled later, a source of rates that is down never stopping an import,
 * a booked value kept as Actual, closed and cancelled NCs refusing costs unless the template says so, an add-only re-import, and a preview that says what will wait.
 * No test reaches the network: the source of rates is a fake.
 */
import { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { strToU8 } from 'fflate';
import { Pool } from 'pg';
import request from 'supertest';
import { configureApp } from '../src/app.factory';
import { AppModule } from '../src/app.module';
import { ExchangeRateGateway, RateAnswer } from '../src/currency/exchange-rate.gateway';
import { ExchangeRateService } from '../src/currency/exchange-rate.service';
import { IntegrationFileStore } from '../src/integrations/core/file-store';
import { giveControllerSeats, makeIds, requireDb, seed, testEnv, token } from './helpers';

class FakeRates extends ExchangeRateGateway {
  down = false;
  calls: string[] = [];
  table: Record<string, number> = {};
  /** The day the source says a rate is for, when it differs from the day asked (a weekend). */
  rateDateFor: Record<string, string> = {};
  async fetch(on: string, base: string, quotes: string[]): Promise<RateAnswer> {
    this.calls.push(`${on} ${base}>${quotes.join(',')}`);
    if (this.down) throw new Error('The source is down');
    return { rateDate: this.rateDateFor[on] ?? on, rates: Object.fromEntries(quotes.map((q) => [q, this.table[`${base}>${q}`] ?? null])) };
  }
}

const files = new Map<string, Uint8Array>();
class MemoryStore extends IntegrationFileStore {
  get enabled() {
    return true;
  }
  async download(path: string) {
    return files.get(path) ?? null;
  }
}

const ids = makeIds('cb');
const THU = '2026-10-01';
const SUN = '2026-10-04';
const FRI = '2026-10-02';
const base = '/api/v1/integrations';
const fake = new FakeRates();
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const owner = () => as(ids.ownerA);

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-ci');
  await giveControllerSeats(admin, ids.orgA, [ids.ownerA]);
  await giveControllerSeats(admin, ids.orgB, [ids.ownerB]);
  // The rate cache is global: another suite may have stored the pairs below, and then the source would never be asked.
  await admin.query('delete from public.exchange_rates');
  await admin.query(`update public.organisation_settings set base_currency = 'GBP', vat_rate = 0.2 where organisation_id = $1`, [ids.orgA]);
  const env = testEnv({ RATE_LIMIT_PER_MINUTE: '10000' });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] })
    .overrideProvider(IntegrationFileStore)
    .useValue(new MemoryStore())
    .overrideProvider(ExchangeRateGateway)
    .useValue(fake)
    .compile();
  app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, rawBody: true }), env);
  await app.init();
  Object.assign(fake.table, { 'EUR>GBP': 0.85, 'USD>GBP': 0.79, 'SEK>GBP': 0.08, 'NOK>GBP': 0.07 });
  fake.rateDateFor[SUN] = FRI;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('cost lines from a file', () => {
  let connId: string;
  let cat: string;
  const ncId: Record<string, string> = {};
  const uploaded: Record<string, string> = {};
  const upload = async (name: string, text: string): Promise<string> => {
    const path = `${ids.orgA}/integration/${connId}/${Math.random().toString(36).slice(2)}-${name}`;
    files.set(path, strToU8(text));
    uploaded[name] = (await api().post(`${base}/connections/${connId}/files`).set(await owner()).send({ path, fileName: name, size: text.length }).expect(201)).body.id;
    return uploaded[name];
  };
  const run = async (entityType: string, kind: 'preview' | 'full', fileId: string, templateId?: string) =>
    (await api().post(`${base}/connections/${connId}/runs`).set(await owner()).send({ entityType, kind, fileId, ...(templateId ? { templateId } : {}) }).expect(201)).body;
  const costFields = (extra: Record<string, unknown>[] = [], nc: Record<string, unknown> = { target: 'nonconformance', source: 'NC', match: 'source' }) => [
    nc,
    { target: 'costType', source: 'Type', transform: 'map', values: { Scrap: 'scrap', Freight: 'transport', Labour: 'labour', Sorting: 'sorting', Tooling: 'tools_equipment', Recovery: 'supplier_recovery' } },
    { target: 'incurredOn', source: 'Date' }, { target: 'currency', source: 'Cur' }, { target: 'unitCost', source: 'Amount' }, { target: 'quantity', source: 'Qty' },
    ...extra,
  ];
  const line = async (ext: string) =>
    (
      await admin.query(
        `select k.* from public.ncr_costs k join public.integration_external_records x on x.internal_id = k.id
          where x.organisation_id = $1 and x.entity_type = 'ncr_cost' and x.external_id = $2`,
        [ids.orgA, ext],
      )
    ).rows[0];
  const hasRows = async (ext: string) => !!(await line(ext));

  it('brings the non-conformances in first: an open, a closed and a cancelled one', async () => {
    const c = (await api().post(`${base}/connections`).set(await owner()).send({ providerKey: 'csv', name: 'Legacy QMS', externalSystem: 'legacy' }).expect(201)).body;
    connId = c.id;
    expect(c.importable).toContain('ncr_cost');
    expect(c.writable).toContain('ncr_cost');
    cat = (await admin.query(`select code from public.ncr_classifications where organisation_id = $1 and kind = 'category' and active order by created_at limit 1`, [ids.orgA])).rows[0].code;
    const fileId = await upload('ncs.csv', ['NC,Title,Status,Closed,Cat', `N-OPEN,Open one,Live,,${cat}`, `N-CLOSED,Closed one,Done,2026-09-01,${cat}`, 'N-CANC,Cancelled one,Void,,'].join('\n'));
    await api().put(`${base}/connections/${connId}/mapping`).set(await owner()).send({
      entityType: 'nonconformance', keyField: 'NC', fileId,
      fields: [
        { target: 'title', source: 'Title' }, { target: 'description', source: 'Title' }, { target: 'source', transform: 'constant', value: 'internal' },
        { target: 'stage', source: 'Status', transform: 'map', values: { Done: 'closed', Live: 'open', Void: 'cancelled' } }, { target: 'closedOn', source: 'Closed' },
        { target: 'category', source: 'Cat' }, { target: 'severity', transform: 'constant', value: 'minor' }, { target: 'quantityAffected', transform: 'constant', value: '2' },
      ],
    }).expect(200);
    const real = await run('nonconformance', 'full', fileId);
    expect(real).toMatchObject({ status: 'succeeded', counts: { created: 3 } });
    for (const ext of ['N-OPEN', 'N-CLOSED', 'N-CANC']) {
      ncId[ext] = (await admin.query(`select internal_id from public.integration_external_records where organisation_id = $1 and entity_type = 'nonconformance' and external_id = $2`, [ids.orgA, ext])).rows[0].internal_id;
    }
  });

  it('says the cost fields, the link to the NC and what a template can switch on', async () => {
    const entities = (await api().get(`${base}/entities`).set(await owner()).expect(200)).body.data;
    const cost = entities.find((e: { entityType: string }) => e.entityType === 'ncr_cost');
    expect(cost).toMatchObject({ label: 'NC cost lines' });
    const keys = cost.fields.map((f: { key: string }) => f.key);
    expect(keys).toEqual(expect.arrayContaining(['nonconformance', 'costType', 'incurredOn', 'currency', 'unitCost', 'quantity', 'vatTreatment', 'vatRate', 'bookedValue']));
    const link = cost.fields.find((f: { key: string }) => f.key === 'nonconformance');
    expect(link).toMatchObject({ required: true, ref: { kind: 'nonconformance', source: true } });
    expect(cost.fields.find((f: { key: string }) => f.key === 'costType').options.map((o: { value: string }) => o.value)).toContain('supplier_recovery');
    expect(cost.fields.find((f: { key: string }) => f.key === 'incurredOn')).toMatchObject({ required: true });
    expect(cost.fields.find((f: { key: string }) => f.key === 'currency')).toMatchObject({ required: true, type: 'currency' });
    // the settings of the kind are fixed: always added, never matched
    const s = (await api().get(`${base}/connections/${connId}/settings`).set(await owner()).expect(200)).body.data.find((x: { entityType: string }) => x.entityType === 'ncr_cost');
    expect(s).toMatchObject({ writeMode: 'add_only', fixed: true, canDeactivate: false, tracksMissing: false });
  });

  it('imports lines in every currency on their own dates, with the rates fetched before they were written', async () => {
    const fileId = await upload(
      'costs-1.csv',
      [
        'Line,NC,Type,Date,Cur,Amount,Qty',
        `L-1,N-OPEN,Scrap,${THU},eur,100,2`,
        `L-2,N-OPEN,Freight,${THU},USD,50,`,
        `L-3,N-OPEN,Labour,${SUN},SEK,1000,`,
        `L-4,N-OPEN,Sorting,${THU},GBP,200,`,
        `L-5,N-OPEN,Tooling,${THU},CAD,80,`,
        `L-6,N-CLOSED,Scrap,${THU},GBP,10,`,
      ].join('\n'),
    );
    await api().put(`${base}/connections/${connId}/mapping`).set(await owner()).send({ entityType: 'ncr_cost', keyField: 'Line', fileId, fields: costFields() }).expect(200);
    fake.calls.length = 0;
    const real = await run('ncr_cost', 'full', fileId);
    expect(real).toMatchObject({ status: 'partial', counts: { created: 5, failed: 1 } });
    // the closed NC refused its line, with the table's own words
    const failed = (await admin.query(`select errors from public.integration_inbox where run_id = $1 and status = 'failed'`, [real.id])).rows;
    expect(JSON.stringify(failed[0].errors)).toMatch(/closed/);
    expect(await hasRows('L-6')).toBe(false);
    // the source was asked once for each pair before any line was written
    expect(fake.calls).toEqual(expect.arrayContaining([`${THU} EUR>GBP`, `${THU} USD>GBP`, `${SUN} SEK>GBP`, `${THU} CAD>GBP`]));
    const l1 = await line('L-1');
    expect([l1.cost_type, l1.currency, Number(l1.quantity), Number(l1.amount), l1.rate_status, Number(l1.exchange_rate), Number(l1.net_base), l1.base_currency]).toEqual(['scrap', 'EUR', 2, 200, 'estimated', 0.85, 170, 'GBP']);
    expect(l1.nonconformance_id).toBe(ncId['N-OPEN']);
    // it landed with its rate: nothing had to come back later and fill it in
    const updates = (id: string) => admin.query(`select count(*)::int as n from audit.events where entity_type = 'ncr_costs' and entity_id = $1 and action = 'update'`, [id]).then((r) => r.rows[0].n);
    expect([await updates(l1.id), await updates((await line('L-2')).id), await updates((await line('L-3')).id)]).toEqual([0, 0, 0]);
    expect(l1.created_by).toBe(ids.ownerA);
    expect([Number((await line('L-2')).net_base), (await line('L-2')).rate_status]).toEqual([39.5, 'estimated']);
    const l3 = await line('L-3');
    expect([Number(l3.net_base), l3.rate_date.toISOString().slice(0, 10)]).toEqual([80, FRI]); // a Sunday carries Friday's rate
    expect([(await line('L-4')).rate_status, Number((await line('L-4')).net_base)]).toEqual(['base', 200]);
    // a currency the source does not publish still imports, waiting
    const l5 = await line('L-5');
    expect([l5.rate_status, l5.net_base]).toEqual(['needed', null]);
    // the run says so
    const detail = (await api().get(`${base}/runs/${real.id}`).set(await owner()).expect(200)).body;
    expect(detail.costs).toMatchObject({ waitingNow: 1 });
    expect(detail.costs.currencies.find((c: { currency: string }) => c.currency === 'CAD')).toMatchObject({ lines: 1, waiting: 1 });
  });

  it('writes nothing when the same file is imported again', async () => {
    const fileId = uploaded['costs-1.csv'];
    const before = (await admin.query(`select count(*)::int as n from public.ncr_costs where organisation_id = $1`, [ids.orgA])).rows[0].n;
    const again = await run('ncr_cost', 'full', fileId);
    expect(again.counts).toMatchObject({ created: 0, unchanged: 5, failed: 1 });
    expect((await admin.query(`select count(*)::int as n from public.ncr_costs where organisation_id = $1`, [ids.orgA])).rows[0].n).toBe(before);
  });

  it('fills the waiting line when its rate arrives', async () => {
    fake.table['CAD>GBP'] = 0.58;
    // the source answered "not published" earlier and that answer is trusted for a while: let it go stale, as the worker would find it
    await admin.query(`update public.exchange_rates set fetched_at = fetched_at - interval '8 days' where base = 'CAD'`);
    const settled = await app.get(ExchangeRateService).settle(ids.orgA);
    expect(settled.filled).toBe(1);
    const l5 = await line('L-5');
    expect([l5.rate_status, Number(l5.net_base)]).toEqual(['estimated', 46.4]);
  });

  it('a source of rates that is down never stops an import: the lines wait and are filled later', async () => {
    const fileId = await upload('costs-2.csv', ['Line,NC,Type,Date,Cur,Amount,Qty', `L-7,N-OPEN,Scrap,${THU},NOK,1000,`].join('\n'));
    fake.down = true; // the mapping saved for the first file reads this one too
    const real = await run('ncr_cost', 'full', fileId).finally(() => {
      fake.down = false;
    });
    expect(real).toMatchObject({ status: 'succeeded', counts: { created: 1 } });
    expect((await line('L-7')).rate_status).toBe('needed');
    const settled = await app.get(ExchangeRateService).settle(ids.orgA);
    expect(settled.filled).toBe(1);
    expect(Number((await line('L-7')).net_base)).toBe(70);
  });

  it('links by the Fortress reference as well, and refuses a link that goes nowhere or a negative cost, in the preview', async () => {
    const ref = (await admin.query(`select reference from public.nonconformances where id = $1`, [ncId['N-OPEN']])).rows[0].reference as string;
    const fileId = await upload(
      'costs-3.csv',
      ['Line,NC,Type,Date,Cur,Amount,Qty', `L-8,${ref.toLowerCase()},Scrap,${THU},GBP,5,`, `L-9,N-NOWHERE,Scrap,${THU},GBP,5,`, `L-10,${ref},Scrap,${THU},GBP,-5,`, `L-11,${ref},Recovery,${THU},GBP,15,`].join('\n'),
    );
    // the link goes by Fortress reference in this file
    await api().put(`${base}/connections/${connId}/mapping`).set(await owner()).send({
      entityType: 'ncr_cost', keyField: 'Line', fileId, reason: 'By reference', fields: costFields([], { target: 'nonconformance', source: 'NC', match: 'code' }),
    }).expect(200);
    const preview = await run('ncr_cost', 'preview', fileId);
    expect(preview.counts).toMatchObject({ total: 4, rejected: 2 });
    expect(preview.costs.lines).toBe(2);
    const rejected = (await api().get(`${base}/runs/${preview.id}/rows?status=rejected`).set(await owner()).expect(200)).body.data;
    const messages = JSON.stringify(rejected.map((r: { errors: unknown }) => r.errors));
    expect(messages).toMatch(/non-conformance/i);
    expect(messages).toMatch(/at least 0|below 0|0/);
    expect(await hasRows('L-8')).toBe(false); // a preview writes nothing
  });

  it('imports by Fortress reference and a credit as a supplier recovery, which reduces the cost', async () => {
    const fileId = uploaded['costs-3.csv'];
    const real = await run('ncr_cost', 'full', fileId);
    expect(real.counts).toMatchObject({ created: 2, rejected: 2 });
    const l11 = await line('L-11');
    expect([l11.cost_type, Number(l11.cost_sign)]).toEqual(['supplier_recovery', -1]);
    expect((await line('L-8')).nonconformance_id).toBe(ncId['N-OPEN']);
  });

  it('keeps the source\'s booked value as Actual, beside the published rate', async () => {
    const fileId = await upload('costs-4.csv', ['Line,NC,Type,Date,Cur,Amount,Qty,Booked', `L-12,N-OPEN,Scrap,${THU},EUR,100,,90`, `L-13,N-OPEN,Scrap,${THU},GBP,100,,90`].join('\n'));
    await api().put(`${base}/connections/${connId}/mapping`).set(await owner()).send({
      entityType: 'ncr_cost', keyField: 'Line', fileId, reason: 'Booked values', fields: costFields([{ target: 'bookedValue', source: 'Booked' }]),
    }).expect(200);
    const real = await run('ncr_cost', 'full', fileId);
    expect(real.counts).toMatchObject({ created: 2 });
    const l12 = await line('L-12');
    expect([l12.rate_status, Number(l12.net_base), Number(l12.estimated_rate), l12.override_kind]).toEqual(['actual', 90, 0.85, 'amount']);
    expect([(await line('L-13')).rate_status, Number((await line('L-13')).net_base)]).toEqual(['base', 100]); // already in the site currency: ignored
  });

  it('adds costs to closed and cancelled NCs only when the template says so, and only for NCs an import brought in', async () => {
    const fileId = await upload('costs-5.csv', ['Line,NC,Type,Date,Cur,Amount,Qty', `L-14,N-CLOSED,Scrap,${THU},GBP,10,`, `L-15,N-CANC,Scrap,${THU},GBP,20,`].join('\n'));
    const body = { entityType: 'ncr_cost', keyField: 'Line', fields: costFields(), expectedColumns: ['Line', 'NC', 'Type', 'Date', 'Cur', 'Amount', 'Qty'] };
    const off = (await api().post(`${base}/templates`).set(await owner()).send({ ...body, name: 'Costs, as they come' }).expect(201)).body;
    expect(off.current.settings).toEqual({ writeMode: 'add_only', matchExisting: false, costsOnClosed: false });
    const refused = await run('ncr_cost', 'full', fileId, off.id);
    expect(refused.counts).toMatchObject({ created: 0, failed: 2 });
    const on = (await api().post(`${base}/templates`).set(await owner()).send({ ...body, name: 'Costs, history too', settings: { costsOnClosed: true } }).expect(201)).body;
    expect(on.current.settings).toEqual({ writeMode: 'add_only', matchExisting: false, costsOnClosed: true });
    const preview = await run('ncr_cost', 'preview', fileId, on.id);
    expect(preview.costs).toMatchObject({ lines: 2, onClosed: 1, onCancelled: 1 });
    const real = await run('ncr_cost', 'full', fileId, on.id);
    expect(real).toMatchObject({ status: 'succeeded', counts: { created: 2 }, settings: { costsOnClosed: true } });
    expect((await admin.query(`select stage from public.nonconformances where id = $1`, [ncId['N-CLOSED']])).rows[0].stage).toBe('closed');
    // an NC made by hand and closed stays frozen whatever the template says
    const made = (await admin.query(
      `insert into public.nonconformances (organisation_id, reference, source, stage, title, severity, quantity_affected, description, category_id, closed_at)
       select $1, 'hand-closed', 'internal', 'closed', 'Closed by hand', 'minor', 1, 'x', c.id, now() from public.ncr_classifications c where c.organisation_id = $1 and c.kind = 'category' limit 1 returning id, reference`,
      [ids.orgA],
    )).rows[0];
    const hand = made.id as string;
    const fileId2 = await upload('costs-6.csv', ['Line,NC,Type,Date,Cur,Amount,Qty', `L-16,${made.reference},Scrap,${THU},GBP,10,`].join('\n'));
    await api().put(`${base}/connections/${connId}/mapping`).set(await owner()).send({
      entityType: 'ncr_cost', keyField: 'Line', fileId: fileId2, reason: 'By reference again', fields: costFields([], { target: 'nonconformance', source: 'NC', match: 'code' }),
    }).expect(200);
    const byRef = (await api().post(`${base}/templates`).set(await owner()).send({
      ...body, name: 'Costs by reference, history too', fields: costFields([], { target: 'nonconformance', source: 'NC', match: 'code' }), settings: { costsOnClosed: true },
    }).expect(201)).body;
    const handRun = await run('ncr_cost', 'full', fileId2, byRef.id);
    expect(handRun.counts).toMatchObject({ created: 0, failed: 1 });
    expect((await admin.query(`select count(*)::int as n from public.ncr_costs where nonconformance_id = $1`, [hand])).rows[0].n).toBe(0);
  });

  it('shows nothing of it to another organisation', async () => {
    const other = await as(ids.ownerB, ids.orgB);
    const runId = (await admin.query(`select id from public.integration_sync_runs where organisation_id = $1 and entity_type = 'ncr_cost' limit 1`, [ids.orgA])).rows[0].id;
    await api().get(`${base}/runs/${runId}`).set(other).expect(404);
  });
});
