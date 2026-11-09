import { Injectable } from '@nestjs/common';
import { sql, SQL } from 'drizzle-orm';
import { z } from 'zod';
import { iso, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { ApproveRequirementBody, CreateRequirementBody, IncomingPreview, PreviewQuery, ReceiptSource, Requirement, RequirementList, RequirementListQuery, RetireRequirementBody, UpdateRequirementBody } from './requirements.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const person = (id: unknown, name: unknown) => (id ? { id: id as string, name: (name as string) ?? 'Unknown user' } : null);

const toRequirement = (r: Row): Requirement => ({
  id: r.id as string,
  name: r.name as string,
  supplier: r.supplier_id ? { id: r.supplier_id as string, code: r.supplier_code as string, name: r.supplier_name as string } : null,
  part: r.part_id ? { id: r.part_id as string, partNumber: r.part_number as string, name: r.part_name as string } : null,
  partFamily: r.part_family_id ? { id: r.part_family_id as string, name: r.family_name as string } : null,
  classification: r.classification_id ? { id: r.classification_id as string, label: r.classification_label as string } : null,
  riskRating: (r.risk_rating as Requirement['riskRating']) ?? null,
  strategy: r.strategy as Requirement['strategy'],
  level: r.level as Requirement['level'],
  sampleSize: r.sample_size === null ? null : Number(r.sample_size),
  percentage: r.percentage === null ? null : Number(r.percentage),
  skipEvery: r.skip_every === null ? null : Number(r.skip_every),
  acceptNumber: Number(r.accept_number),
  plan: (r.plan as Requirement['plan']) ?? null,
  operationCode: r.operation_code as string,
  rationale: (r.rationale as string) ?? null,
  status: r.status as Requirement['status'],
  reducesControls: !!r.reduces_controls,
  supersedesId: (r.supersedes_id as string) ?? null,
  createdBy: person(r.created_by, r.created_by_name),
  createdAt: iso(r.created_at)!,
  approvedBy: person(r.approved_by, r.approved_by_name),
  approvedAt: iso(r.approved_at),
  approvalNote: (r.approval_note as string) ?? null,
  retiredAt: iso(r.retired_at),
  retireReason: (r.retire_reason as string) ?? null,
});

const toBody = (b: Record<string, unknown>) => JSON.stringify(b);

/** Incoming inspection requirements (the rules), the preview of what they say for a delivery, and where a non-conformance came from. Writes are database functions. */
@Injectable()
export class RequirementsService {
  constructor(private readonly database: DatabaseService) {}

  private async load(db: Db, ctx: RequestContext, where: SQL): Promise<Requirement[]> {
    const rows = await db.execute<Row>(sql`
      select q.*, s.code as supplier_code, s.name as supplier_name, p.part_number, p.name as part_name, f.name as family_name, c.label as classification_label,
             ${sql.raw(personName('pc'))} as created_by_name, ${sql.raw(personName('pa'))} as approved_by_name
      from public.supplier_inspection_requirements q left join public.suppliers s on s.id = q.supplier_id left join public.parts p on p.id = q.part_id
      left join public.part_families f on f.id = q.part_family_id left join public.supplier_classifications c on c.id = q.classification_id
      left join public.profiles pc on pc.id = q.created_by left join public.profiles pa on pa.id = q.approved_by
      where q.organisation_id = ${orgOf(ctx)}::uuid and ${where}
      order by array_position(array['draft','approved','superseded','retired'], q.status), q.created_at desc`);
    return rows.rows.map(toRequirement);
  }

  list(ctx: RequestContext, q: RequirementListQuery): Promise<z.infer<typeof RequirementList>> {
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`true`];
      if (q.status === 'active') where.push(sql`q.status in ('draft', 'approved')`);
      else if (q.status !== 'all') where.push(sql`q.status = any(string_to_array(${q.status}, ','))`);
      if (q.supplierId) where.push(sql`q.supplier_id = ${q.supplierId}::uuid`);
      if (q.partId) where.push(sql`q.part_id = ${q.partId}::uuid`);
      return { data: await this.load(db, ctx, sql.join(where, sql` and `)) };
    });
  }

  private one(db: Db, ctx: RequestContext, id: string): Promise<Requirement> {
    return this.load(db, ctx, sql`q.id = ${id}::uuid`).then((r) => {
      if (!r[0]) throw ApiError.notFound('inspection_requirement_not_found', 'Inspection requirement not found');
      return r[0];
    });
  }

  get(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, (db) => this.one(db, ctx, id));
  }

  create(ctx: RequestContext, b: CreateRequirementBody): Promise<Requirement> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ id: string }>(sql`select app.save_inspection_requirement(${orgOf(ctx)}::uuid, null, ${toBody(b)}::jsonb) as id`);
      return this.one(db, ctx, res.rows[0].id);
    });
  }

  update(ctx: RequestContext, id: string, b: UpdateRequirementBody): Promise<Requirement> {
    return this.database.asUser(ctx, async (db) => {
      await this.one(db, ctx, id);
      await db.execute(sql`select app.save_inspection_requirement(${orgOf(ctx)}::uuid, ${id}::uuid, ${toBody(b)}::jsonb)`);
      return this.one(db, ctx, id);
    });
  }

  private command(ctx: RequestContext, id: string, run: (db: Db) => Promise<unknown>): Promise<Requirement> {
    return this.database.asUser(ctx, async (db) => {
      await this.one(db, ctx, id);
      await run(db);
      return this.one(db, ctx, id);
    });
  }
  approve(ctx: RequestContext, id: string, b: ApproveRequirementBody) {
    return this.command(ctx, id, (db) => db.execute(sql`select app.approve_inspection_requirement(${id}::uuid, ${b.note ?? null})`));
  }
  retire(ctx: RequestContext, id: string, b: RetireRequirementBody) {
    return this.command(ctx, id, (db) => db.execute(sql`select app.retire_inspection_requirement(${id}::uuid, ${b.reason})`));
  }

  /** What the approved rules would say for this supplier, part and quantity: nothing is recorded. */
  preview(ctx: RequestContext, q: PreviewQuery): Promise<IncomingPreview> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ r: IncomingPreview }>(sql`select app.preview_incoming_inspection(${q.supplierId}::uuid, ${q.partId ?? null}::uuid, ${q.quantity}::numeric, ${q.siteId ?? null}::uuid) as r`);
      return res.rows[0].r;
    });
  }

  /** The receipt line(s) a non-conformance was raised from. `available` is false for someone who may read NCs but not receiving. */
  receiptSource(ctx: RequestContext, ncrId: string): Promise<z.infer<typeof ReceiptSource>> {
    return this.database.asUser(ctx, async (db) => {
      const ncr = await db.execute(sql`select 1 from public.nonconformances where id = ${ncrId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (!ncr.rows.length) throw ApiError.notFound('ncr_not_found', 'Non-conformance not found');
      const allowed = await db.execute<{ ok: boolean }>(sql`select app.has_permission(${orgOf(ctx)}::uuid, 'receiving.read') as ok`);
      if (!allowed.rows[0].ok) return { available: false, items: [] };
      const rows = await db.execute<Row>(sql`
        select g.id as receipt_id, g.reference, x.line_number, g.received_on::text as received_on, g.delivery_note, l.lot_number, x.quantity_received
        from public.receipt_line_ncrs k join public.goods_receipt_lines x on x.id = k.receipt_line_id join public.goods_receipts g on g.id = x.goods_receipt_id left join public.lots l on l.id = x.lot_id
        where k.ncr_id = ${ncrId}::uuid and k.organisation_id = ${orgOf(ctx)}::uuid order by g.received_on desc`);
      return { available: true, items: rows.rows.map((r) => ({ receiptId: r.receipt_id as string, reference: r.reference as string, lineNumber: Number(r.line_number), receivedOn: (r.received_on as string).slice(0, 10), deliveryNote: (r.delivery_note as string) ?? null, lotNumber: (r.lot_number as string) ?? null, quantityReceived: Number(r.quantity_received) })) };
    });
  }
}
