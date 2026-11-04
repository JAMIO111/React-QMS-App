import { Injectable } from '@nestjs/common';
import { SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { Attachment, Cost, CreateAttachmentBody, CreateCostBody, DeletedQuery, UpdateCostBody } from './ncr-records.schemas';

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
  vatTreatment: 'vat_treatment', vatRate: 'vat_rate', amount: 'amount', exchangeRate: 'exchange_rate',
};

/**
 * Costs and attachments of a non-conformance. RLS (through the parent NCR's site) decides what a
 * user sees and changes; the database works out cost totals and enforces locking with the NCR.
 */
@Injectable()
export class NcrRecordsService {
  constructor(private readonly database: DatabaseService) {}

  // ---- costs ---------------------------------------------------------------------------------

  listCosts(ctx: RequestContext, ncrId: string, q: z.infer<typeof DeletedQuery>) {
    return this.database.asUser(ctx, async (db) => {
      await this.assertNcrVisible(db, ctx, ncrId);
      const result = await db.execute<Row>(sql`
        ${sql.raw(COST_SELECT)} where c.nonconformance_id = ${ncrId}::uuid and ${deletedFilter('c', q.deleted)}
        order by c.incurred_on desc, c.created_at desc`);
      const settings = await db.execute<Row>(sql`select base_currency from public.organisation_settings where organisation_id = ${ctx.organisationId!}::uuid`);
      const data = result.rows.map(toCost);
      const live = data.filter((c) => !c.deletedAt);
      const sum = (k: 'netBase' | 'grossBase') => Math.round(live.reduce((t, c) => t + c[k], 0) * 100) / 100;
      return {
        data,
        totals: { baseCurrency: (settings.rows[0]?.base_currency as string) ?? 'GBP', net: sum('netBase'), gross: sum('grossBase'), count: live.length },
      };
    });
  }

  createCost(ctx: RequestContext, ncrId: string, body: z.infer<typeof CreateCostBody>): Promise<Cost> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertNcrVisible(db, ctx, ncrId);
      const result = await db.execute<{ id: string }>(sql`
        insert into public.ncr_costs (organisation_id, nonconformance_id, cost_type, description, incurred_on, currency, vat_treatment, vat_rate, amount, exchange_rate)
        values (${ctx.organisationId!}::uuid, ${ncrId}::uuid, ${body.costType}, ${body.description ?? null}, coalesce(${body.incurredOn ?? null}::date, current_date),
                ${body.currency}, ${body.vatTreatment}, ${body.vatRate}, ${body.amount}, ${body.exchangeRate})
        returning id`);
      return this.loadCost(db, ctx, result.rows[0].id);
    });
  }

  updateCost(ctx: RequestContext, id: string, body: z.infer<typeof UpdateCostBody>): Promise<Cost> {
    const sets = Object.entries(body)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => sql`${sql.raw(COST_COLUMNS[k])} = ${v}`);
    return this.changeCost(ctx, id, sql.join(sets, sql`, `));
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
  select c.*, to_char(c.incurred_on, 'YYYY-MM-DD') as incurred_on_text, ${personName('pc')} as created_by_name
  from public.ncr_costs c left join public.profiles pc on pc.id = c.created_by`;

const ATTACHMENT_SELECT = `
  select a.*, ${personName('pc')} as created_by_name
  from public.ncr_attachments a left join public.profiles pc on pc.id = a.created_by`;

const toCost = (r: Row): Cost => ({
  id: r.id as string,
  costType: r.cost_type as Cost['costType'],
  description: (r.description as string) ?? null,
  incurredOn: r.incurred_on_text as string,
  currency: r.currency as string,
  vatTreatment: r.vat_treatment as Cost['vatTreatment'],
  vatRate: num(r.vat_rate),
  amount: num(r.amount),
  exchangeRate: num(r.exchange_rate),
  netAmount: num(r.net_amount),
  vatAmount: num(r.vat_amount),
  grossAmount: num(r.gross_amount),
  baseCurrency: r.base_currency as string,
  netBase: num(r.net_base),
  grossBase: num(r.gross_base),
  createdAt: iso(r.created_at)!,
  createdBy: ref(r.created_by, r.created_by_name),
  deletedAt: iso(r.deleted_at),
  deleteReason: (r.delete_reason as string) ?? null,
});

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
