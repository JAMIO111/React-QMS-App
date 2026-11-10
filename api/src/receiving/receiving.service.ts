import { writeCustomValues } from '../custom-fields/custom-values';
import type { CustomValuesInput } from '../custom-fields/custom-fields.schemas';
import { Injectable } from '@nestjs/common';
import { sql, SQL } from 'drizzle-orm';
import { z } from 'zod';
import { iso, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import {
  AgreedDateBody, CreatePurchaseOrderBody, PoLookup, PoLookupQuery, PurchaseOrderDetail, PurchaseOrderListQuery, PurchaseOrderPage, PurchaseOrderRow, ReasonBody, ReceiptDetail, ReceiptListQuery,
  ReceiptPage, ReceiptRow, RecordReceiptBody, DispositionBody, RaiseNcrBody,
} from './receiving.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
const person = (id: unknown, name: unknown) => (id ? { id: id as string, name: (name as string) ?? 'Unknown user' } : null);
const date = (v: unknown) => (v ? (v as string).slice(0, 10) : null);
const num = (v: unknown) => Number(v ?? 0);

/**
 * "Late" for a purchase order line: it is open, goods are still outstanding and the latest agreed date (else the requested date) is before today. This is the live view; the on-time
 * policy for performance (requested vs agreed date) is chosen where scorecards are calculated, not here.
 */
const RECEIVED = sql.raw(`coalesce((select sum(rl.quantity_received) from public.goods_receipt_lines rl join public.goods_receipts g on g.id = rl.goods_receipt_id where rl.po_line_id = l.id and g.status = 'received'), 0)`);
const DUE = sql.raw(`coalesce(l.agreed_on, l.requested_on)`);

const PO_SORT: Record<PurchaseOrderListQuery['sort'], string> = {
  poNumber: 'upper(o.po_number)',
  supplier: 'lower(s.name)',
  orderedOn: 'o.ordered_on',
  status: `array_position(array['open','closed','cancelled'], o.status)`,
  lines: '(select count(*) from public.purchase_order_lines x where x.purchase_order_id = o.id)',
  nextDue: `(select min(coalesce(x.agreed_on, x.requested_on)) from public.purchase_order_lines x where x.purchase_order_id = o.id and x.status = 'open')`,
};
const RECEIPT_SORT: Record<ReceiptListQuery['sort'], string> = {
  reference: 'g.reference',
  supplier: 'lower(s.name)',
  receivedOn: 'g.received_on',
  purchaseOrder: 'upper(o.po_number)',
  createdAt: 'g.created_at',
};

const toPoRow = (r: Row): PurchaseOrderRow => ({
  id: r.id as string,
  poNumber: r.po_number as string,
  supplier: { id: r.supplier_id as string, code: r.supplier_code as string, name: r.supplier_name as string },
  status: r.status as PurchaseOrderRow['status'],
  orderedOn: date(r.ordered_on)!,
  lineCount: num(r.line_count),
  outstandingLines: num(r.outstanding_lines),
  lateLines: num(r.late_lines),
  nextDueOn: date(r.next_due_on),
  createdAt: iso(r.created_at)!,
});

const toReceiptRow = (r: Row): ReceiptRow => ({
  id: r.id as string,
  reference: r.reference as string,
  supplier: { id: r.supplier_id as string, code: r.supplier_code as string, name: r.supplier_name as string },
  purchaseOrder: r.purchase_order_id ? { id: r.purchase_order_id as string, poNumber: r.po_number as string } : null,
  site: r.site_id ? { id: r.site_id as string, name: r.site_name as string } : null,
  receivedOn: date(r.received_on)!,
  deliveryNote: (r.delivery_note as string) ?? null,
  status: r.status as ReceiptRow['status'],
  lineCount: num(r.line_count),
  createdAt: iso(r.created_at)!,
});

/** Purchase orders, goods receipts and the lots a receipt makes. Every write is a database function (receiving.manage); this service shapes what the screens need. */
@Injectable()
export class ReceivingService {
  constructor(private readonly database: DatabaseService) {}

  // ---- purchase orders -----------------------------------------------------------------------------

  private poColumns = sql.raw(`
    o.id, o.po_number, o.status, o.ordered_on::text as ordered_on, o.created_at, o.supplier_id, s.code as supplier_code, s.name as supplier_name,
    (select count(*)::int from public.purchase_order_lines x where x.purchase_order_id = o.id) as line_count,
    (select count(*)::int from public.purchase_order_lines x where x.purchase_order_id = o.id and x.status = 'open'
       and x.quantity_ordered > coalesce((select sum(rl.quantity_received) from public.goods_receipt_lines rl join public.goods_receipts g on g.id = rl.goods_receipt_id where rl.po_line_id = x.id and g.status = 'received'), 0)) as outstanding_lines,
    (select count(*)::int from public.purchase_order_lines x where x.purchase_order_id = o.id and x.status = 'open' and coalesce(x.agreed_on, x.requested_on) < current_date
       and x.quantity_ordered > coalesce((select sum(rl.quantity_received) from public.goods_receipt_lines rl join public.goods_receipts g on g.id = rl.goods_receipt_id where rl.po_line_id = x.id and g.status = 'received'), 0)) as late_lines,
    (select min(coalesce(x.agreed_on, x.requested_on))::text from public.purchase_order_lines x where x.purchase_order_id = o.id and x.status = 'open'
       and x.quantity_ordered > coalesce((select sum(rl.quantity_received) from public.goods_receipt_lines rl join public.goods_receipts g on g.id = rl.goods_receipt_id where rl.po_line_id = x.id and g.status = 'received'), 0)) as next_due_on`);

  listOrders(ctx: RequestContext, q: PurchaseOrderListQuery): Promise<z.infer<typeof PurchaseOrderPage>> {
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`o.organisation_id = ${orgOf(ctx)}::uuid`];
      if (q.status !== 'all') where.push(sql`o.status = any(string_to_array(${q.status}, ','))`);
      if (q.supplierId) where.push(sql`o.supplier_id = ${q.supplierId}::uuid`);
      if (q.late) {
        where.push(sql`exists (select 1 from public.purchase_order_lines x where x.purchase_order_id = o.id and x.status = 'open' and coalesce(x.agreed_on, x.requested_on) < current_date
          and x.quantity_ordered > coalesce((select sum(rl.quantity_received) from public.goods_receipt_lines rl join public.goods_receipts g on g.id = rl.goods_receipt_id where rl.po_line_id = x.id and g.status = 'received'), 0))`);
      }
      if (q.q) {
        const like = likePattern(q.q);
        where.push(sql`(o.po_number ilike ${like} or s.name ilike ${like} or s.code ilike ${like}
          or exists (select 1 from public.purchase_order_lines x left join public.parts p on p.id = x.part_id where x.purchase_order_id = o.id and (x.material ilike ${like} or p.part_number ilike ${like} or p.name ilike ${like})))`);
      }
      const clause = sql.join(where, sql` and `);
      const order = sql.raw(`${PO_SORT[q.sort]} ${q.order} nulls last, upper(o.po_number) asc`);
      const rows = await db.execute<Row>(sql`select ${this.poColumns} from public.purchase_orders o join public.suppliers s on s.id = o.supplier_id where ${clause} order by ${order} limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`);
      const count = await db.execute<{ n: number }>(sql`select count(*)::int as n from public.purchase_orders o join public.suppliers s on s.id = o.supplier_id where ${clause}`);
      return { data: rows.rows.map(toPoRow), page: q.page, pageSize: q.pageSize, total: Number(count.rows[0].n) };
    });
  }

  /** Open orders for a picker (for example when recording a receipt). */
  lookupOrders(ctx: RequestContext, q: PoLookupQuery): Promise<z.infer<typeof PoLookup>> {
    return this.database.asUser(ctx, async (db) => {
      const like = q.q ? likePattern(q.q) : null;
      const res = await db.execute<Row>(sql`
        select o.id, o.po_number, o.supplier_id, s.code as supplier_code, s.name as supplier_name from public.purchase_orders o join public.suppliers s on s.id = o.supplier_id
        where o.organisation_id = ${orgOf(ctx)}::uuid and o.status = 'open' and (${q.supplierId ?? null}::uuid is null or o.supplier_id = ${q.supplierId ?? null}::uuid)
          and (${like}::text is null or o.po_number ilike ${like}) order by o.ordered_on desc limit 50`);
      return { data: res.rows.map((r) => ({ id: r.id as string, poNumber: r.po_number as string, supplier: { id: r.supplier_id as string, code: r.supplier_code as string, name: r.supplier_name as string } })) };
    });
  }

  getOrder(ctx: RequestContext, id: string): Promise<PurchaseOrderDetail> {
    return this.database.asUser(ctx, (db) => this.loadOrder(db, ctx, id));
  }

  private async loadOrder(db: Db, ctx: RequestContext, id: string): Promise<PurchaseOrderDetail> {
    const head = await db.execute<Row>(sql`
      select ${this.poColumns}, o.notes, o.cancel_reason, o.closed_at, o.created_by, ${sql.raw(personName('pc'))} as created_by_name
      from public.purchase_orders o join public.suppliers s on s.id = o.supplier_id left join public.profiles pc on pc.id = o.created_by
      where o.id = ${id}::uuid and o.organisation_id = ${orgOf(ctx)}::uuid`);
    const h = head.rows[0];
    if (!h) throw ApiError.notFound('purchase_order_not_found', 'Purchase order not found');
    const [lines, receipts] = await Promise.all([
      db.execute<Row>(sql`
        select l.*, l.requested_on::text as requested_text, l.agreed_on::text as agreed_text, ${DUE}::text as due_text, p.part_number, p.name as part_name, ${RECEIVED} as received,
               (select min(g.received_on)::text from public.goods_receipt_lines rl join public.goods_receipts g on g.id = rl.goods_receipt_id where rl.po_line_id = l.id and g.status = 'received') as first_received,
               (select max(g.received_on)::text from public.goods_receipt_lines rl join public.goods_receipts g on g.id = rl.goods_receipt_id where rl.po_line_id = l.id and g.status = 'received') as last_received,
               (current_date - ${DUE}) as days_past
        from public.purchase_order_lines l left join public.parts p on p.id = l.part_id where l.purchase_order_id = ${id}::uuid order by l.line_number`),
      db.execute<Row>(sql`
        select g.id, g.reference, g.received_on::text as received_on, g.delivery_note, g.status, (select count(*)::int from public.goods_receipt_lines x where x.goods_receipt_id = g.id) as line_count
        from public.goods_receipts g where g.purchase_order_id = ${id}::uuid order by g.received_on desc, g.reference desc`),
    ]);
    return {
      ...toPoRow(h),
      notes: (h.notes as string) ?? null,
      cancelReason: (h.cancel_reason as string) ?? null,
      closedAt: iso(h.closed_at),
      createdBy: person(h.created_by, h.created_by_name),
      lines: lines.rows.map((r) => {
        const ordered = num(r.quantity_ordered);
        const received = num(r.received);
        const outstanding = Math.max(0, ordered - received);
        const late = r.status === 'open' && outstanding > 0 && num(r.days_past) > 0;
        return {
          id: r.id as string,
          lineNumber: num(r.line_number),
          part: r.part_id ? { id: r.part_id as string, partNumber: r.part_number as string, name: r.part_name as string } : null,
          material: (r.material as string) ?? null,
          quantityOrdered: ordered,
          unit: (r.unit as string) ?? null,
          requestedOn: date(r.requested_text)!,
          agreedOn: date(r.agreed_text),
          dueOn: date(r.due_text)!,
          status: r.status as 'open' | 'closed' | 'cancelled',
          quantityReceived: received,
          quantityOutstanding: outstanding,
          late,
          daysLate: late ? num(r.days_past) : 0,
          firstReceivedOn: date(r.first_received),
          lastReceivedOn: date(r.last_received),
        };
      }),
      receipts: receipts.rows.map((r) => ({ id: r.id as string, reference: r.reference as string, receivedOn: date(r.received_on)!, deliveryNote: (r.delivery_note as string) ?? null, status: r.status as 'received' | 'cancelled', lineCount: num(r.line_count) })),
    };
  }

  createOrder(ctx: RequestContext, b: CreatePurchaseOrderBody): Promise<PurchaseOrderDetail> {
    return this.database.asUser(ctx, async (db) => {
      const lines = b.lines.map((l) => ({ partId: l.partId ?? null, material: l.material ?? null, quantity: l.quantity, unit: l.unit ?? null, requestedOn: l.requestedOn, agreedOn: l.agreedOn ?? null }));
      const res = await db.execute<{ id: string }>(sql`select app.create_purchase_order(${b.supplierId}::uuid, ${b.poNumber}, ${b.orderedOn ?? null}::date, ${b.notes ?? null}, ${JSON.stringify(lines)}::jsonb) as id`);
      return this.loadOrder(db, ctx, res.rows[0].id);
    });
  }

  private orderCommand(ctx: RequestContext, id: string, run: (db: Db) => Promise<unknown>): Promise<PurchaseOrderDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadOrder(db, ctx, id);
      await run(db);
      return this.loadOrder(db, ctx, id);
    });
  }
  closeOrder(ctx: RequestContext, id: string) {
    return this.orderCommand(ctx, id, (db) => db.execute(sql`select app.close_purchase_order(${id}::uuid)`));
  }
  cancelOrder(ctx: RequestContext, id: string, b: ReasonBody) {
    return this.orderCommand(ctx, id, (db) => db.execute(sql`select app.cancel_purchase_order(${id}::uuid, ${b.reason})`));
  }

  async setAgreedDate(ctx: RequestContext, lineId: string, b: AgreedDateBody): Promise<PurchaseOrderDetail> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ purchase_order_id: string }>(sql`select purchase_order_id from public.purchase_order_lines where id = ${lineId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (res.rows.length === 0) throw ApiError.notFound('purchase_order_line_not_found', 'Order line not found');
      await db.execute(sql`select app.set_po_line_agreed_date(${lineId}::uuid, ${b.agreedOn}::date)`);
      return this.loadOrder(db, ctx, res.rows[0].purchase_order_id);
    });
  }

  // ---- goods receipts ------------------------------------------------------------------------------

  private receiptColumns = sql.raw(`
    g.id, g.reference, g.received_on::text as received_on, g.delivery_note, g.status, g.created_at, g.supplier_id, s.code as supplier_code, s.name as supplier_name,
    g.purchase_order_id, o.po_number, g.site_id, st.name as site_name, (select count(*)::int from public.goods_receipt_lines x where x.goods_receipt_id = g.id) as line_count`);
  private receiptFrom = sql.raw(`public.goods_receipts g join public.suppliers s on s.id = g.supplier_id left join public.purchase_orders o on o.id = g.purchase_order_id left join public.sites st on st.id = g.site_id`);

  listReceipts(ctx: RequestContext, q: ReceiptListQuery): Promise<z.infer<typeof ReceiptPage>> {
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`g.organisation_id = ${orgOf(ctx)}::uuid`];
      if (q.status !== 'all') where.push(sql`g.status = ${q.status}`);
      if (q.supplierId) where.push(sql`g.supplier_id = ${q.supplierId}::uuid`);
      if (q.purchaseOrderId) where.push(sql`g.purchase_order_id = ${q.purchaseOrderId}::uuid`);
      if (q.lotId) where.push(sql`exists (select 1 from public.goods_receipt_lines x where x.goods_receipt_id = g.id and x.lot_id = ${q.lotId}::uuid)`);
      if (q.from) where.push(sql`g.received_on >= ${q.from}::date`);
      if (q.to) where.push(sql`g.received_on <= ${q.to}::date`);
      if (q.q) {
        const like = likePattern(q.q);
        where.push(sql`(g.reference ilike ${like} or g.delivery_note ilike ${like} or s.name ilike ${like} or s.code ilike ${like} or o.po_number ilike ${like}
          or exists (select 1 from public.goods_receipt_lines x left join public.lots l on l.id = x.lot_id left join public.parts p on p.id = x.part_id where x.goods_receipt_id = g.id
                     and (l.lot_number ilike ${like} or x.material ilike ${like} or p.part_number ilike ${like})))`);
      }
      const clause = sql.join(where, sql` and `);
      const order = sql.raw(`${RECEIPT_SORT[q.sort]} ${q.order} nulls last, g.reference desc`);
      const rows = await db.execute<Row>(sql`select ${this.receiptColumns} from ${this.receiptFrom} where ${clause} order by ${order} limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`);
      const count = await db.execute<{ n: number }>(sql`select count(*)::int as n from ${this.receiptFrom} where ${clause}`);
      return { data: rows.rows.map(toReceiptRow), page: q.page, pageSize: q.pageSize, total: Number(count.rows[0].n) };
    });
  }

  getReceipt(ctx: RequestContext, id: string): Promise<ReceiptDetail> {
    return this.database.asUser(ctx, (db) => this.loadReceipt(db, ctx, id));
  }

  private async loadReceipt(db: Db, ctx: RequestContext, id: string): Promise<ReceiptDetail> {
    const head = await db.execute<Row>(sql`
      select ${this.receiptColumns}, g.notes, g.cancelled_at, g.cancelled_by, g.cancel_reason, g.created_by, ${sql.raw(personName('pc'))} as created_by_name, ${sql.raw(personName('px'))} as cancelled_by_name
      from ${this.receiptFrom} left join public.profiles pc on pc.id = g.created_by left join public.profiles px on px.id = g.cancelled_by
      where g.id = ${id}::uuid and g.organisation_id = ${orgOf(ctx)}::uuid`);
    const h = head.rows[0];
    if (!h) throw ApiError.notFound('goods_receipt_not_found', 'Goods receipt not found');
    const lines = await db.execute<Row>(sql`
      select x.*, p.part_number, p.name as part_name, l.lot_number, l.status as lot_status, pl.line_number as po_line_number,
             d.required as d_required, d.rule_id as d_rule_id, d.rule_name as d_rule_name, d.strategy as d_strategy, d.level as d_level, d.sample_size as d_sample_size, d.accept_number as d_accept,
             d.operation_code as d_operation, d.basis as d_basis, d.overridden as d_overridden,
             case when d.id is null then null else app.incoming_inspection_assessment(x.id) end as assessment, app.receipt_line_certificates(x.id) as certs
      from public.goods_receipt_lines x left join public.parts p on p.id = x.part_id left join public.lots l on l.id = x.lot_id left join public.purchase_order_lines pl on pl.id = x.po_line_id
      left join public.incoming_inspection_determinations d on d.receipt_line_id = x.id
      where x.goods_receipt_id = ${id}::uuid order by x.line_number`);
    const [decisions, ncrs] = await Promise.all([
      db.execute<Row>(sql`
        select s.*, ${sql.raw(personName('p'))} as decided_by_name from public.receipt_line_dispositions s left join public.profiles p on p.id = s.decided_by
        where s.receipt_line_id in (select id from public.goods_receipt_lines where goods_receipt_id = ${id}::uuid) order by s.decided_at, s.id`),
      db.execute<Row>(sql`
        select k.receipt_line_id, n.id, n.reference, n.stage from public.receipt_line_ncrs k join public.nonconformances n on n.id = k.ncr_id
        where k.receipt_line_id in (select id from public.goods_receipt_lines where goods_receipt_id = ${id}::uuid) and k.ended_at is null and n.deleted_at is null order by k.linked_at`),
    ]);
    const toDecision = (r: Row) => ({ decision: r.decision as 'held' | 'accepted' | 'rejected' | 'conditional', reason: (r.reason as string) ?? null, conditions: (r.conditions as string) ?? null, quantityRejected: r.quantity_rejected === null || r.quantity_rejected === undefined ? null : Number(r.quantity_rejected), decidedAt: iso(r.decided_at)!, decidedBy: person(r.decided_by, r.decided_by_name) });
    return {
      ...toReceiptRow(h),
      notes: (h.notes as string) ?? null,
      cancelledAt: iso(h.cancelled_at),
      cancelledBy: person(h.cancelled_by, h.cancelled_by_name),
      cancelReason: (h.cancel_reason as string) ?? null,
      createdBy: person(h.created_by, h.created_by_name),
      lines: lines.rows.map((r) => {
        const history = decisions.rows.filter((d) => d.receipt_line_id === r.id).map(toDecision);
        const current = history.length ? history[history.length - 1] : null;
        const required = r.d_required === null || r.d_required === undefined ? null : !!r.d_required;
        return {
        id: r.id as string,
        status: current ? current.decision : required ? ('pending' as const) : ('not_required' as const),
        determination:
          required === null
            ? null
            : { required, ruleId: (r.d_rule_id as string) ?? null, ruleName: (r.d_rule_name as string) ?? null, strategy: r.d_strategy as string, level: r.d_level as string, sampleSize: r.d_sample_size === null ? null : num(r.d_sample_size), acceptNumber: num(r.d_accept), operationCode: (r.d_operation as string) ?? null, basis: r.d_basis as string, overridden: !!r.d_overridden },
        assessment: r.assessment
          ? (() => {
              const a = r.assessment as Record<string, unknown>;
              return { state: a.state as 'not_required' | 'not_started' | 'in_progress' | 'completed' | 'abandoned', samples: num(a.samples), failedSamples: num(a.failedSamples), requiredSamples: a.requiredSamples === null || a.requiredSamples === undefined ? null : num(a.requiredSamples), acceptNumber: num(a.acceptNumber), outcome: a.outcome as 'acceptable' | 'not_acceptable' | 'incomplete', inspectionId: (a.inspectionId as string) ?? null, inspectionReference: (a.inspectionReference as string) ?? null };
            })()
          : null,
        disposition: current,
        dispositions: history,
        lotStatus: (r.lot_status as string) ?? null,
        certificates: { received: Number((r.certs as Record<string, number>).received), accepted: Number((r.certs as Record<string, number>).accepted), rejected: Number((r.certs as Record<string, number>).rejected) },
        ncrs: ncrs.rows.filter((n) => n.receipt_line_id === r.id).map((n) => ({ id: n.id as string, reference: n.reference as string, stage: n.stage as string })),
        poLine: r.po_line_id ? { id: r.po_line_id as string, lineNumber: num(r.po_line_number) } : null,
        part: r.part_id ? { id: r.part_id as string, partNumber: r.part_number as string, name: r.part_name as string } : null,
        material: (r.material as string) ?? null,
        quantityReceived: num(r.quantity_received),
        lot: r.lot_id ? { id: r.lot_id as string, lotNumber: r.lot_number as string } : null,
        notes: (r.notes as string) ?? null,
        };
      }),
    };
  }

  /** Commands on one receipt line; each answers with the whole receipt. */
  async lineCommand(ctx: RequestContext, lineId: string, run: (db: Db) => Promise<unknown>): Promise<ReceiptDetail> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ goods_receipt_id: string }>(sql`select goods_receipt_id from public.goods_receipt_lines where id = ${lineId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (res.rows.length === 0) throw ApiError.notFound('goods_receipt_line_not_found', 'Receipt line not found');
      await run(db);
      return this.loadReceipt(db, ctx, res.rows[0].goods_receipt_id);
    });
  }
  startInspection(ctx: RequestContext, lineId: string, customValues?: CustomValuesInput) {
    return this.lineCommand(ctx, lineId, async (db) => {
      const res = await db.execute<{ id: string }>(sql`select app.start_incoming_inspection(${lineId}::uuid) as id`);
      await writeCustomValues(db, 'inspection', res.rows[0].id, customValues);
    });
  }
  disposition(ctx: RequestContext, lineId: string, b: DispositionBody) {
    return this.lineCommand(ctx, lineId, (db) => db.execute(sql`select app.disposition_receipt_line(${lineId}::uuid, ${b.decision}, ${b.reason ?? null}, ${b.conditions ?? null}, ${b.quantity ?? null}::numeric)`));
  }
  /** Raises a central non-conformance from a line and answers with its id (created: false when one was already raised). */
  async raiseNcr(ctx: RequestContext, lineId: string, b: RaiseNcrBody): Promise<{ nonconformanceId: string; created: boolean }> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<Row>(sql`select 1 from public.goods_receipt_lines where id = ${lineId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (res.rows.length === 0) throw ApiError.notFound('goods_receipt_line_not_found', 'Receipt line not found');
      const r = await db.execute<{ r: { nonconformanceId: string; created: boolean } }>(sql`
        select app.raise_ncr_from_receipt_line(${lineId}::uuid, ${b.title ?? null}, ${b.description ?? null}, ${b.severity ?? 'major'}, ${b.categoryId ?? null}::uuid, ${b.quantity ?? null}::numeric) as r`);
      if (r.rows[0].r.created) await writeCustomValues(db, 'nonconformance', r.rows[0].r.nonconformanceId, b.customValues);
      return r.rows[0].r;
    });
  }

  recordReceipt(ctx: RequestContext, b: RecordReceiptBody): Promise<ReceiptDetail> {
    return this.database.asUser(ctx, async (db) => {
      const lines = b.lines.map((l) => ({ poLineId: l.poLineId ?? null, partId: l.partId ?? null, material: l.material ?? null, quantity: l.quantity, lotNumber: l.lotNumber ?? null, notes: l.notes ?? null }));
      const res = await db.execute<{ r: { id: string; created: boolean } }>(sql`
        select app.record_goods_receipt(${b.supplierId}::uuid, ${b.purchaseOrderId ?? null}::uuid, ${b.siteId ?? null}::uuid, ${b.receivedOn}::date, ${b.deliveryNote ?? null}, ${b.notes ?? null},
          ${JSON.stringify(lines)}::jsonb, ${b.clientKey ?? null}) as r`);
      return this.loadReceipt(db, ctx, res.rows[0].r.id);
    });
  }

  cancelReceipt(ctx: RequestContext, id: string, b: ReasonBody): Promise<ReceiptDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadReceipt(db, ctx, id);
      await db.execute(sql`select app.cancel_goods_receipt(${id}::uuid, ${b.reason})`);
      return this.loadReceipt(db, ctx, id);
    });
  }
}
