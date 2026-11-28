import { Injectable } from '@nestjs/common';
import { SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import { onceByKey } from '../common/client-key';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { ExchangeRateService } from '../currency/exchange-rate.service';
import { Attachment, Cost, CostTotals, CreateAttachmentBody, CreateCostBody, DeletedQuery, RateBody, UpdateCostBody } from './ncr-records.schemas';

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v);
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const personName = (alias: string) => `nullif(trim(concat_ws(' ', ${alias}.first_name, ${alias}.surname)), '')`;
const ref = (id: unknown, name: unknown) => (id ? { id: id as string, name: (name as string) ?? 'Unknown user' } : null);

const deletedFilter = (alias: string, deleted: z.infer<typeof DeletedQuery>['deleted']): SQL =>
  deleted === 'exclude' ? sql.raw(`${alias}.deleted_at is null`) : deleted === 'only' ? sql.raw(`${alias}.deleted_at is not null`) : sql`true`;

/** Column names for cost fields the API accepts. */
const COST_COLUMNS: Record<string, string> = {
  costType: 'cost_type', description: 'description', incurredOn: 'incurred_on', currency: 'currency',
  vatTreatment: 'vat_treatment', vatRate: 'vat_rate', quantity: 'quantity', unitCost: 'unit_cost',
};

/**
 * Costs and attachments of a non-conformance. RLS (through the parent NCR's site) decides what a
 * user sees and changes; the database works out cost totals and enforces locking with the NCR.
 */
@Injectable()
export class NcrRecordsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly rates: ExchangeRateService,
  ) {}

  // ---- costs ---------------------------------------------------------------------------------

  listCosts(ctx: RequestContext, ncrId: string, q: z.infer<typeof DeletedQuery>) {
    return this.database.asUser(ctx, async (db) => {
      await this.assertNcrVisible(db, ctx, ncrId);
      const result = await db.execute<Row>(sql`
        ${sql.raw(COST_SELECT)} where c.nonconformance_id = ${ncrId}::uuid and ${deletedFilter('c', q.deleted)}
        order by c.incurred_on desc, c.created_at desc`);
      // An NC with no lines yet still has a currency: its site's (the organisation's when it has no site).
      const currencies = await db.execute<Row>(sql`
        select coalesce(si.currency, st.base_currency, 'GBP') as base_currency, coalesce(st.base_currency, 'GBP') as org_currency
        from public.nonconformances n
        left join public.sites si on si.id = n.site_id and si.organisation_id = n.organisation_id
        left join public.organisation_settings st on st.organisation_id = n.organisation_id
        where n.id = ${ncrId}::uuid`);
      const data = result.rows.map(toCost);
      return { data, totals: costTotals(data, (currencies.rows[0]?.base_currency as string) ?? 'GBP', (currencies.rows[0]?.org_currency as string) ?? 'GBP') };
    });
  }

  /** The line's rate is looked up by the database; when none is cached yet the published one is fetched and the line filled before the answer. */
  async createCost(ctx: RequestContext, ncrId: string, body: z.infer<typeof CreateCostBody>): Promise<Cost> {
    return onceByKey({
      database: this.database,
      ctx,
      table: 'ncr_costs',
      key: body.clientKey,
      parent: ncrId,
      make: async () => {
        const cost = await this.database.asUser(ctx, async (db) => {
          await this.assertNcrVisible(db, ctx, ncrId);
          const result = await db.execute<{ id: string }>(sql`
            insert into public.ncr_costs (organisation_id, nonconformance_id, cost_type, description, incurred_on, currency, vat_treatment, vat_rate, quantity, unit_cost, client_key)
            values (${ctx.organisationId!}::uuid, ${ncrId}::uuid, ${body.costType}, ${body.description ?? null}, coalesce(${body.incurredOn ?? null}::date, current_date),
                    ${body.currency}, ${body.vatTreatment}, ${body.vatRate}, ${body.quantity}, ${body.unitCost}, ${body.clientKey ?? null})
            returning id`);
          return this.loadCost(db, ctx, result.rows[0].id);
        });
        return this.withRate(ctx, cost);
      },
      read: async (id) => this.withRate(ctx, await this.database.asUser(ctx, (db) => this.loadCost(db, ctx, id))),
    });
  }

  async updateCost(ctx: RequestContext, id: string, body: z.infer<typeof UpdateCostBody>): Promise<Cost> {
    const sets = Object.entries(body)
      .filter(([k, v]) => v !== undefined && COST_COLUMNS[k])
      .map(([k, v]) => sql`${sql.raw(COST_COLUMNS[k])} = ${v}`);
    if (!sets.length) return this.database.asUser(ctx, (db) => this.loadCost(db, ctx, id));
    return this.withRate(ctx, await this.changeCost(ctx, id, sql.join(sets, sql`, `)));
  }

  /** States the rate actually got, or the converted amount (the database checks who may, and keeps the published rate beside it). */
  setRate(ctx: RequestContext, id: string, body: z.infer<typeof RateBody>): Promise<Cost> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertCostVisible(db, ctx, id);
      await db.execute(sql`select app.override_cost_rate(${id}::uuid, ${body.kind}, ${body.value}::numeric, ${body.note ?? null})`);
      return this.loadCost(db, ctx, id);
    });
  }

  /** Drops a stated rate and takes the published one again (fetching it when it is not cached yet). */
  async resetRate(ctx: RequestContext, id: string): Promise<Cost> {
    const cost = await this.database.asUser(ctx, async (db) => {
      await this.assertCostVisible(db, ctx, id);
      await db.execute(sql`select app.reset_cost_rate(${id}::uuid)`);
      return this.loadCost(db, ctx, id);
    });
    return this.withRate(ctx, cost);
  }

  removeCost(ctx: RequestContext, id: string, reason: string): Promise<Cost> {
    return this.changeCost(ctx, id, sql`deleted_at = now(), delete_reason = ${reason}`);
  }

  restoreCost(ctx: RequestContext, id: string): Promise<Cost> {
    return this.changeCost(ctx, id, sql`deleted_at = null`);
  }

  // ---- attachments ---------------------------------------------------------------------------

  listAttachments(ctx: RequestContext, ncrId: string, q: z.infer<typeof DeletedQuery>): Promise<Attachment[]> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertNcrVisible(db, ctx, ncrId);
      const result = await db.execute<Row>(sql`
        ${sql.raw(ATTACHMENT_SELECT)} where a.nonconformance_id = ${ncrId}::uuid and ${deletedFilter('a', q.deleted)}
        order by a.created_at desc`);
      return result.rows.map(toAttachment);
    });
  }

  /**
   * Records a file the client has already uploaded to storage at <org>/ncr/<ncr id>/<name>
   * (storage policies decide who may upload there).
   */
  createAttachment(ctx: RequestContext, ncrId: string, body: z.infer<typeof CreateAttachmentBody>): Promise<Attachment> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertNcrVisible(db, ctx, ncrId);
      const folder = `${ctx.organisationId}/ncr/${ncrId}/`;
      if (!body.storagePath.startsWith(folder) || body.storagePath.includes('..') || body.storagePath.length === folder.length) {
        throw ApiError.badRequest('invalid_path', `Files for this non-conformance must be uploaded to ${folder}`);
      }
      const stored = await db.execute(sql`select 1 from storage.objects where bucket_id = 'nc-files' and name = ${body.storagePath}`);
      if (!stored.rows.length) throw ApiError.badRequest('file_not_uploaded', 'Upload the file before attaching it');
      const result = await db.execute<{ id: string }>(sql`
        insert into public.ncr_attachments (organisation_id, nonconformance_id, storage_path, file_name, content_type, size_bytes, description)
        values (${ctx.organisationId!}::uuid, ${ncrId}::uuid, ${body.storagePath}, ${body.fileName}, ${body.contentType ?? null}, ${body.sizeBytes}, ${body.description ?? null})
        returning id`);
      return this.loadAttachment(db, ctx, result.rows[0].id);
    });
  }

  removeAttachment(ctx: RequestContext, id: string, reason: string): Promise<Attachment> {
    return this.changeAttachment(ctx, id, sql`deleted_at = now(), delete_reason = ${reason}`);
  }

  restoreAttachment(ctx: RequestContext, id: string): Promise<Attachment> {
    return this.changeAttachment(ctx, id, sql`deleted_at = null`);
  }

  // ---- internals -----------------------------------------------------------------------------

  private async assertNcrVisible(db: Db, ctx: RequestContext, ncrId: string) {
    const found = await db.execute(sql`select 1 from public.nonconformances where id = ${ncrId}::uuid and organisation_id = ${ctx.organisationId!}::uuid`);
    if (!found.rows.length) throw ApiError.notFound('ncr_not_found', 'Non-conformance not found');
  }

  /** A line waiting for its rate: ask the source for what is missing (best effort, never fails the save) and read the line again. */
  private async withRate(ctx: RequestContext, cost: Cost): Promise<Cost> {
    if (cost.rateStatus !== 'needed') return cost;
    await this.rates.settle(ctx.organisationId!, ctx.correlationId, 6000);
    return this.database.asUser(ctx, (db) => this.loadCost(db, ctx, cost.id));
  }

  private async assertCostVisible(db: Db, ctx: RequestContext, id: string) {
    const found = await db.execute(sql`select 1 from public.ncr_costs where id = ${id}::uuid and organisation_id = ${ctx.organisationId!}::uuid`);
    if (!found.rows.length) throw ApiError.notFound('cost_not_found', 'Cost not found');
  }

  private changeCost(ctx: RequestContext, id: string, set: SQL): Promise<Cost> {
    return this.database.asUser(ctx, async (db) => {
      const result = await db.execute(sql`
        update public.ncr_costs set ${set} where id = ${id}::uuid and organisation_id = ${ctx.organisationId!}::uuid returning id`);
      if (!result.rows.length) throw ApiError.notFound('cost_not_found', 'Cost not found');
      return this.loadCost(db, ctx, id);
    });
  }

  private changeAttachment(ctx: RequestContext, id: string, set: SQL): Promise<Attachment> {
    return this.database.asUser(ctx, async (db) => {
      const result = await db.execute(sql`
        update public.ncr_attachments set ${set} where id = ${id}::uuid and organisation_id = ${ctx.organisationId!}::uuid returning id`);
      if (!result.rows.length) throw ApiError.notFound('attachment_not_found', 'File not found');
      return this.loadAttachment(db, ctx, id);
    });
  }

  private async loadCost(db: Db, ctx: RequestContext, id: string): Promise<Cost> {
    const result = await db.execute<Row>(sql`${sql.raw(COST_SELECT)} where c.id = ${id}::uuid and c.organisation_id = ${ctx.organisationId!}::uuid`);
    if (!result.rows.length) throw ApiError.notFound('cost_not_found', 'Cost not found');
    return toCost(result.rows[0]);
  }

  private async loadAttachment(db: Db, ctx: RequestContext, id: string): Promise<Attachment> {
    const result = await db.execute<Row>(sql`${sql.raw(ATTACHMENT_SELECT)} where a.id = ${id}::uuid and a.organisation_id = ${ctx.organisationId!}::uuid`);
    if (!result.rows.length) throw ApiError.notFound('attachment_not_found', 'File not found');
    return toAttachment(result.rows[0]);
  }
}

const COST_SELECT = `
  select c.*, to_char(c.incurred_on, 'YYYY-MM-DD') as incurred_on_text, to_char(c.rate_date, 'YYYY-MM-DD') as rate_date_text,
         ${personName('pc')} as created_by_name, ${personName('po')} as overridden_by_name
  from public.ncr_costs c left join public.profiles pc on pc.id = c.created_by left join public.profiles po on po.id = c.overridden_by`;

const ATTACHMENT_SELECT = `
  select a.*, ${personName('pc')} as created_by_name
  from public.ncr_attachments a left join public.profiles pc on pc.id = a.created_by`;

const nullableNum = (v: unknown) => (v === null || v === undefined ? null : Number(v));

const toCost = (r: Row): Cost => ({
  id: r.id as string,
  costType: r.cost_type as Cost['costType'],
  description: (r.description as string) ?? null,
  incurredOn: r.incurred_on_text as string,
  currency: r.currency as string,
  vatTreatment: r.vat_treatment as Cost['vatTreatment'],
  vatRate: num(r.vat_rate),
  quantity: num(r.quantity),
  unitCost: num(r.unit_cost),
  amount: num(r.amount),
  netAmount: num(r.net_amount),
  vatAmount: num(r.vat_amount),
  grossAmount: num(r.gross_amount),
  costSign: num(r.cost_sign),
  baseCurrency: r.base_currency as string,
  exchangeRate: nullableNum(r.exchange_rate),
  netBase: nullableNum(r.net_base),
  grossBase: nullableNum(r.gross_base),
  orgCurrency: r.org_currency as string,
  orgRate: nullableNum(r.org_rate),
  netOrg: nullableNum(r.net_org),
  grossOrg: nullableNum(r.gross_org),
  rateStatus: r.rate_status as Cost['rateStatus'],
  rateSource: r.rate_source as Cost['rateSource'],
  rateDate: (r.rate_date_text as string) ?? null,
  estimatedRate: nullableNum(r.estimated_rate),
  overrideKind: (r.override_kind as Cost['overrideKind']) ?? null,
  overrideNote: (r.override_note as string) ?? null,
  overriddenAt: iso(r.overridden_at),
  overriddenBy: ref(r.overridden_by, r.overridden_by_name),
  createdAt: iso(r.created_at)!,
  createdBy: ref(r.created_by, r.created_by_name),
  deletedAt: iso(r.deleted_at),
  deleteReason: (r.delete_reason as string) ?? null,
});

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Totals of the live lines, net of credits. Lines waiting for a rate are counted but add nothing. */
export const costTotals = (data: Cost[], fallbackBase: string, fallbackOrg: string = fallbackBase): CostTotals => {
  const live = data.filter((c) => !c.deletedAt);
  const add = (f: (c: Cost) => number | null) => round2(live.reduce((t, c) => t + (f(c) ?? 0) * c.costSign, 0));
  const byCurrency = new Map<string, { currency: string; net: number; gross: number; lines: number }>();
  for (const c of live) {
    const row = byCurrency.get(c.currency) ?? { currency: c.currency, net: 0, gross: 0, lines: 0 };
    row.net += c.netAmount * c.costSign;
    row.gross += c.grossAmount * c.costSign;
    row.lines += 1;
    byCurrency.set(c.currency, row);
  }
  const count = (s: Cost['rateStatus']) => live.filter((c) => c.rateStatus === s).length;
  return {
    baseCurrency: live[0]?.baseCurrency ?? fallbackBase,
    orgCurrency: live[0]?.orgCurrency ?? fallbackOrg,
    net: add((c) => c.netBase),
    gross: add((c) => c.grossBase),
    netOrg: add((c) => c.netOrg),
    grossOrg: add((c) => c.grossOrg),
    count: live.length,
    byCurrency: [...byCurrency.values()].map((r) => ({ ...r, net: round2(r.net), gross: round2(r.gross) })),
    rates: { base: count('base'), estimated: count('estimated'), actual: count('actual'), needed: count('needed') },
  };
};

const toAttachment = (r: Row): Attachment => ({
  id: r.id as string,
  fileName: r.file_name as string,
  contentType: (r.content_type as string) ?? null,
  sizeBytes: num(r.size_bytes),
  description: (r.description as string) ?? null,
  storagePath: r.storage_path as string,
  createdAt: iso(r.created_at)!,
  createdBy: ref(r.created_by, r.created_by_name),
  deletedAt: iso(r.deleted_at),
  deleteReason: (r.delete_reason as string) ?? null,
});
