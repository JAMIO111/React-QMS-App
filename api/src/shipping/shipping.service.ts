import { Injectable } from '@nestjs/common';
import { sql, SQL } from 'drizzle-orm';
import { z } from 'zod';
import { iso, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import {
  AgreedDateBody, CreateCustomerOrderBody, CustomerOrderDetail, CustomerOrderListQuery, CustomerOrderPage, CustomerOrderRow, OrderLookup, OrderLookupQuery, ReasonBody, RecordShipmentBody, ShipmentDetail,
  ShipmentListQuery, ShipmentPage, ShipmentRow,
} from './shipping.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
const person = (id: unknown, name: unknown) => (id ? { id: id as string, name: (name as string) ?? 'Unknown user' } : null);
const date = (v: unknown) => (v ? (v as string).slice(0, 10) : null);
const num = (v: unknown) => Number(v ?? 0);

/**
 * What has shipped against an order line: non-cancelled shipments only. Late for an order line: it is open, goods are still outstanding and the latest agreed date (else the requested date)
 * is before today. The shared fragments are written once so the order list, the order page and (later) the customer figures count the same way.
 */
export const SHIPPED_OF = (line: string) =>
  `coalesce((select sum(sl.quantity_shipped) from public.shipment_lines sl join public.shipments sh on sh.id = sl.shipment_id where sl.order_line_id = ${line}.id and sh.status = 'shipped'), 0)`;
const DUE_OF = (line: string) => `coalesce(${line}.agreed_on, ${line}.requested_on)`;
const OUTSTANDING = (line: string) => `${line}.status = 'open' and ${line}.quantity_ordered > ${SHIPPED_OF(line)}`;

const ORDER_SORT: Record<CustomerOrderListQuery['sort'], string> = {
  orderNumber: 'upper(o.order_number)',
  customer: 'lower(c.name)',
  orderedOn: 'o.ordered_on',
  status: `array_position(array['open','closed','cancelled'], o.status)`,
  lines: '(select count(*) from public.customer_order_lines x where x.customer_order_id = o.id)',
  nextDue: `(select min(${DUE_OF('x')}) from public.customer_order_lines x where x.customer_order_id = o.id and ${OUTSTANDING('x')})`,
};
const SHIPMENT_SORT: Record<ShipmentListQuery['sort'], string> = {
  reference: 's.reference',
  customer: 'lower(c.name)',
  shippedOn: 's.shipped_on',
  customerOrder: 'upper(o.order_number)',
  createdAt: 's.created_at',
};

const toOrderRow = (r: Row): CustomerOrderRow => ({
  id: r.id as string,
  orderNumber: r.order_number as string,
  customerReference: (r.customer_reference as string) ?? null,
  customer: { id: r.customer_id as string, code: r.customer_code as string, name: r.customer_name as string },
  status: r.status as CustomerOrderRow['status'],
  orderedOn: date(r.ordered_on)!,
  lineCount: num(r.line_count),
  outstandingLines: num(r.outstanding_lines),
  lateLines: num(r.late_lines),
  nextDueOn: date(r.next_due_on),
  createdAt: iso(r.created_at)!,
});

const toShipmentRow = (r: Row): ShipmentRow => ({
  id: r.id as string,
  reference: r.reference as string,
  customer: { id: r.customer_id as string, code: r.customer_code as string, name: r.customer_name as string },
  customerOrder: r.customer_order_id ? { id: r.customer_order_id as string, orderNumber: r.order_number as string } : null,
  site: r.site_id ? { id: r.site_id as string, name: r.site_name as string } : null,
  shippedOn: date(r.shipped_on)!,
  deliveryNote: (r.delivery_note as string) ?? null,
  status: r.status as ShipmentRow['status'],
  lineCount: num(r.line_count),
  createdAt: iso(r.created_at)!,
});

/** Customer orders and shipments. Every write is a database function (shipping.manage); this service shapes what the screens need. */
@Injectable()
export class ShippingService {
  constructor(private readonly database: DatabaseService) {}

  // ---- customer orders -----------------------------------------------------------------------------

  private orderColumns = sql.raw(`
    o.id, o.order_number, o.customer_reference, o.status, o.ordered_on::text as ordered_on, o.created_at, o.customer_id, c.code as customer_code, c.name as customer_name,
    (select count(*)::int from public.customer_order_lines x where x.customer_order_id = o.id) as line_count,
    (select count(*)::int from public.customer_order_lines x where x.customer_order_id = o.id and ${OUTSTANDING('x')}) as outstanding_lines,
    (select count(*)::int from public.customer_order_lines x where x.customer_order_id = o.id and ${OUTSTANDING('x')} and ${DUE_OF('x')} < current_date) as late_lines,
    (select min(${DUE_OF('x')})::text from public.customer_order_lines x where x.customer_order_id = o.id and ${OUTSTANDING('x')}) as next_due_on`);

  listOrders(ctx: RequestContext, q: CustomerOrderListQuery): Promise<z.infer<typeof CustomerOrderPage>> {
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`o.organisation_id = ${orgOf(ctx)}::uuid`];
      if (q.status !== 'all') where.push(sql`o.status = any(string_to_array(${q.status}, ','))`);
      if (q.customerId) where.push(sql`o.customer_id = ${q.customerId}::uuid`);
      if (q.late) where.push(sql.raw(`exists (select 1 from public.customer_order_lines x where x.customer_order_id = o.id and ${OUTSTANDING('x')} and ${DUE_OF('x')} < current_date)`));
      if (q.q) {
        const like = likePattern(q.q);
        where.push(sql`(o.order_number ilike ${like} or o.customer_reference ilike ${like} or c.name ilike ${like} or c.code ilike ${like}
          or exists (select 1 from public.customer_order_lines x join public.parts p on p.id = x.part_id where x.customer_order_id = o.id and (p.part_number ilike ${like} or p.name ilike ${like})))`);
      }
      const clause = sql.join(where, sql` and `);
      const order = sql.raw(`${ORDER_SORT[q.sort]} ${q.order} nulls last, upper(o.order_number) asc`);
      const rows = await db.execute<Row>(sql`select ${this.orderColumns} from public.customer_orders o join public.customers c on c.id = o.customer_id where ${clause} order by ${order} limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`);
      const count = await db.execute<{ n: number }>(sql`select count(*)::int as n from public.customer_orders o join public.customers c on c.id = o.customer_id where ${clause}`);
      return { data: rows.rows.map(toOrderRow), page: q.page, pageSize: q.pageSize, total: Number(count.rows[0].n) };
    });
  }

  /** Open orders for a picker (for example when recording a shipment). */
  lookupOrders(ctx: RequestContext, q: OrderLookupQuery): Promise<z.infer<typeof OrderLookup>> {
    return this.database.asUser(ctx, async (db) => {
      const like = q.q ? likePattern(q.q) : null;
      const res = await db.execute<Row>(sql`
        select o.id, o.order_number, o.customer_id, c.code as customer_code, c.name as customer_name from public.customer_orders o join public.customers c on c.id = o.customer_id
        where o.organisation_id = ${orgOf(ctx)}::uuid and o.status = 'open' and (${q.customerId ?? null}::uuid is null or o.customer_id = ${q.customerId ?? null}::uuid)
          and (${like}::text is null or o.order_number ilike ${like} or o.customer_reference ilike ${like}) order by o.ordered_on desc limit 50`);
      return { data: res.rows.map((r) => ({ id: r.id as string, orderNumber: r.order_number as string, customer: { id: r.customer_id as string, code: r.customer_code as string, name: r.customer_name as string } })) };
    });
  }

  getOrder(ctx: RequestContext, id: string): Promise<CustomerOrderDetail> {
    return this.database.asUser(ctx, (db) => this.loadOrder(db, ctx, id));
  }

  private async loadOrder(db: Db, ctx: RequestContext, id: string): Promise<CustomerOrderDetail> {
    const head = await db.execute<Row>(sql`
      select ${this.orderColumns}, o.notes, o.cancel_reason, o.closed_at, o.created_by, ${sql.raw(personName('pc'))} as created_by_name
      from public.customer_orders o join public.customers c on c.id = o.customer_id left join public.profiles pc on pc.id = o.created_by
      where o.id = ${id}::uuid and o.organisation_id = ${orgOf(ctx)}::uuid`);
    const h = head.rows[0];
    if (!h) throw ApiError.notFound('customer_order_not_found', 'Customer order not found');
    const [lines, shipments] = await Promise.all([
      db.execute<Row>(sql`
        select l.*, l.requested_on::text as requested_text, l.agreed_on::text as agreed_text, ${sql.raw(DUE_OF('l'))}::text as due_text, p.part_number, p.name as part_name, ${sql.raw(SHIPPED_OF('l'))} as shipped,
               (select min(sh.shipped_on)::text from public.shipment_lines sl join public.shipments sh on sh.id = sl.shipment_id where sl.order_line_id = l.id and sh.status = 'shipped') as first_shipped,
               (select max(sh.shipped_on)::text from public.shipment_lines sl join public.shipments sh on sh.id = sl.shipment_id where sl.order_line_id = l.id and sh.status = 'shipped') as last_shipped,
               (current_date - ${sql.raw(DUE_OF('l'))}) as days_past
        from public.customer_order_lines l join public.parts p on p.id = l.part_id where l.customer_order_id = ${id}::uuid order by l.line_number`),
      db.execute<Row>(sql`
        select s.id, s.reference, s.shipped_on::text as shipped_on, s.delivery_note, s.status, (select count(*)::int from public.shipment_lines x where x.shipment_id = s.id) as line_count
        from public.shipments s where s.customer_order_id = ${id}::uuid order by s.shipped_on desc, s.reference desc`),
    ]);
    return {
      ...toOrderRow(h),
      notes: (h.notes as string) ?? null,
      cancelReason: (h.cancel_reason as string) ?? null,
      closedAt: iso(h.closed_at),
      createdBy: person(h.created_by, h.created_by_name),
      lines: lines.rows.map((r) => {
        const ordered = num(r.quantity_ordered);
        const shipped = num(r.shipped);
        const outstanding = Math.max(0, ordered - shipped);
        const late = r.status === 'open' && outstanding > 0 && num(r.days_past) > 0;
        return {
          id: r.id as string,
          lineNumber: num(r.line_number),
          part: { id: r.part_id as string, partNumber: r.part_number as string, name: r.part_name as string },
          quantityOrdered: ordered,
          unit: (r.unit as string) ?? null,
          requestedOn: date(r.requested_text)!,
          agreedOn: date(r.agreed_text),
          dueOn: date(r.due_text)!,
          status: r.status as 'open' | 'closed' | 'cancelled',
          quantityShipped: shipped,
          quantityOutstanding: outstanding,
          quantityOver: Math.max(0, shipped - ordered),
          late,
          daysLate: late ? num(r.days_past) : 0,
          firstShippedOn: date(r.first_shipped),
          lastShippedOn: date(r.last_shipped),
        };
      }),
      shipments: shipments.rows.map((r) => ({ id: r.id as string, reference: r.reference as string, shippedOn: date(r.shipped_on)!, deliveryNote: (r.delivery_note as string) ?? null, status: r.status as 'shipped' | 'cancelled', lineCount: num(r.line_count) })),
    };
  }

  createOrder(ctx: RequestContext, b: CreateCustomerOrderBody): Promise<CustomerOrderDetail> {
    return this.database.asUser(ctx, async (db) => {
      const lines = b.lines.map((l) => ({ partId: l.partId, quantity: l.quantity, unit: l.unit ?? null, requestedOn: l.requestedOn, agreedOn: l.agreedOn ?? null }));
      const res = await db.execute<{ id: string }>(sql`
        select app.create_customer_order(${b.customerId}::uuid, ${b.orderNumber}, ${b.customerReference ?? null}, ${b.orderedOn ?? null}::date, ${b.notes ?? null}, ${JSON.stringify(lines)}::jsonb) as id`);
      return this.loadOrder(db, ctx, res.rows[0].id);
    });
  }

  private orderCommand(ctx: RequestContext, id: string, run: (db: Db) => Promise<unknown>): Promise<CustomerOrderDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadOrder(db, ctx, id);
      await run(db);
      return this.loadOrder(db, ctx, id);
    });
  }
  closeOrder(ctx: RequestContext, id: string) {
    return this.orderCommand(ctx, id, (db) => db.execute(sql`select app.close_customer_order(${id}::uuid)`));
  }
  cancelOrder(ctx: RequestContext, id: string, b: ReasonBody) {
    return this.orderCommand(ctx, id, (db) => db.execute(sql`select app.cancel_customer_order(${id}::uuid, ${b.reason})`));
  }

  setAgreedDate(ctx: RequestContext, lineId: string, b: AgreedDateBody): Promise<CustomerOrderDetail> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ customer_order_id: string }>(sql`select customer_order_id from public.customer_order_lines where id = ${lineId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (res.rows.length === 0) throw ApiError.notFound('customer_order_line_not_found', 'Order line not found');
      await db.execute(sql`select app.set_order_line_agreed_date(${lineId}::uuid, ${b.agreedOn}::date)`);
      return this.loadOrder(db, ctx, res.rows[0].customer_order_id);
    });
  }

  // ---- shipments -----------------------------------------------------------------------------------

  private shipmentColumns = sql.raw(`
    s.id, s.reference, s.shipped_on::text as shipped_on, s.delivery_note, s.status, s.created_at, s.customer_id, c.code as customer_code, c.name as customer_name,
    s.customer_order_id, o.order_number, s.site_id, st.name as site_name, (select count(*)::int from public.shipment_lines x where x.shipment_id = s.id) as line_count`);
  private shipmentFrom = sql.raw(`public.shipments s join public.customers c on c.id = s.customer_id left join public.customer_orders o on o.id = s.customer_order_id left join public.sites st on st.id = s.site_id`);

  listShipments(ctx: RequestContext, q: ShipmentListQuery): Promise<z.infer<typeof ShipmentPage>> {
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`s.organisation_id = ${orgOf(ctx)}::uuid`];
      if (q.status !== 'all') where.push(sql`s.status = ${q.status}`);
      if (q.customerId) where.push(sql`s.customer_id = ${q.customerId}::uuid`);
      if (q.customerOrderId) where.push(sql`s.customer_order_id = ${q.customerOrderId}::uuid`);
      if (q.lotId) where.push(sql`exists (select 1 from public.shipment_lines x where x.shipment_id = s.id and x.lot_id = ${q.lotId}::uuid)`);
      if (q.partId) where.push(sql`exists (select 1 from public.shipment_lines x where x.shipment_id = s.id and x.part_id = ${q.partId}::uuid)`);
      if (q.from) where.push(sql`s.shipped_on >= ${q.from}::date`);
      if (q.to) where.push(sql`s.shipped_on <= ${q.to}::date`);
      if (q.q) {
        const like = likePattern(q.q);
        where.push(sql`(s.reference ilike ${like} or s.delivery_note ilike ${like} or c.name ilike ${like} or c.code ilike ${like} or o.order_number ilike ${like} or o.customer_reference ilike ${like}
          or exists (select 1 from public.shipment_lines x left join public.lots l on l.id = x.lot_id join public.parts p on p.id = x.part_id where x.shipment_id = s.id
                     and (l.lot_number ilike ${like} or p.part_number ilike ${like} or p.name ilike ${like})))`);
      }
      const clause = sql.join(where, sql` and `);
      const order = sql.raw(`${SHIPMENT_SORT[q.sort]} ${q.order} nulls last, s.reference desc`);
      const rows = await db.execute<Row>(sql`select ${this.shipmentColumns} from ${this.shipmentFrom} where ${clause} order by ${order} limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`);
      const count = await db.execute<{ n: number }>(sql`select count(*)::int as n from ${this.shipmentFrom} where ${clause}`);
      return { data: rows.rows.map(toShipmentRow), page: q.page, pageSize: q.pageSize, total: Number(count.rows[0].n) };
    });
  }

  getShipment(ctx: RequestContext, id: string): Promise<ShipmentDetail> {
    return this.database.asUser(ctx, (db) => this.loadShipment(db, ctx, id));
  }

  private async loadShipment(db: Db, ctx: RequestContext, id: string): Promise<ShipmentDetail> {
    const head = await db.execute<Row>(sql`
      select ${this.shipmentColumns}, s.notes, s.cancelled_at, s.cancelled_by, s.cancel_reason, s.created_by, ${sql.raw(personName('pc'))} as created_by_name, ${sql.raw(personName('px'))} as cancelled_by_name
      from ${this.shipmentFrom} left join public.profiles pc on pc.id = s.created_by left join public.profiles px on px.id = s.cancelled_by
      where s.id = ${id}::uuid and s.organisation_id = ${orgOf(ctx)}::uuid`);
    const h = head.rows[0];
    if (!h) throw ApiError.notFound('shipment_not_found', 'Shipment not found');
    const lines = await db.execute<Row>(sql`
      select x.*, p.part_number, p.name as part_name, l.lot_number, l.status as lot_status, ol.line_number as order_line_number
      from public.shipment_lines x join public.parts p on p.id = x.part_id left join public.lots l on l.id = x.lot_id left join public.customer_order_lines ol on ol.id = x.order_line_id
      where x.shipment_id = ${id}::uuid order by x.line_number`);
    return {
      ...toShipmentRow(h),
      notes: (h.notes as string) ?? null,
      cancelledAt: iso(h.cancelled_at),
      cancelledBy: person(h.cancelled_by, h.cancelled_by_name),
      cancelReason: (h.cancel_reason as string) ?? null,
      createdBy: person(h.created_by, h.created_by_name),
      lines: lines.rows.map((r) => ({
        id: r.id as string,
        lineNumber: num(r.line_number),
        orderLine: r.order_line_id ? { id: r.order_line_id as string, lineNumber: num(r.order_line_number) } : null,
        part: { id: r.part_id as string, partNumber: r.part_number as string, name: r.part_name as string },
        quantityShipped: num(r.quantity_shipped),
        lot: r.lot_id ? { id: r.lot_id as string, lotNumber: r.lot_number as string } : null,
        lotStatus: (r.lot_status as string) ?? null,
        notes: (r.notes as string) ?? null,
      })),
    };
  }

  recordShipment(ctx: RequestContext, b: RecordShipmentBody): Promise<ShipmentDetail> {
    return this.database.asUser(ctx, async (db) => {
      const lines = b.lines.map((l) => ({ orderLineId: l.orderLineId ?? null, partId: l.partId ?? null, quantity: l.quantity, lotId: l.lotId ?? null, lotNumber: l.lotNumber ?? null, notes: l.notes ?? null }));
      const res = await db.execute<{ r: { id: string; created: boolean } }>(sql`
        select app.record_shipment(${b.customerId}::uuid, ${b.customerOrderId ?? null}::uuid, ${b.siteId ?? null}::uuid, ${b.shippedOn}::date, ${b.deliveryNote ?? null}, ${b.notes ?? null},
          ${JSON.stringify(lines)}::jsonb, ${b.clientKey ?? null}) as r`);
      return this.loadShipment(db, ctx, res.rows[0].r.id);
    });
  }

  cancelShipment(ctx: RequestContext, id: string, b: ReasonBody): Promise<ShipmentDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadShipment(db, ctx, id);
      await db.execute(sql`select app.cancel_shipment(${id}::uuid, ${b.reason})`);
      return this.loadShipment(db, ctx, id);
    });
  }
}
