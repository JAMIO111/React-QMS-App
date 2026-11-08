import { Injectable } from '@nestjs/common';
import { SQL, sql } from 'drizzle-orm';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { assignments, insertParts, iso, num, Row } from '../calibration/calibration.service';
import { DatabaseService, Db } from '../database/database.service';
import {
  CreateLotBody,
  CreateOperationBody,
  CreateOrderBody,
  CreateSerialsBody,
  Lot,
  LotListQuery,
  LotOption,
  Operation,
  ProductionOrder,
  ProductionOrderDetail,
  Serial,
  SerialListQuery,
  SerialOption,
  UpdateLotBody,
  UpdateOperationBody,
  UpdateOrderBody,
  UpdateSerialBody,
  OrderListQuery,
} from './production.schemas';
import type { z } from 'zod';
import type { OrderLookupQuery, LotLookupQuery, SerialLookupQuery, OrderOption } from './production.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
const sortSql = (parts: string[], order: 'asc' | 'desc') => sql.raw(parts.map((x) => `${x} ${order} nulls last`).join(', '));
const partRef = (r: Row) => ({ id: r.part_id as string, partNumber: r.part_number as string, name: r.part_name as string });
const codeRef = (r: Row, prefix: string) => (r[`${prefix}_id`] ? { id: r[`${prefix}_id`] as string, code: r[`${prefix}_code`] as string, name: r[`${prefix}_name`] as string } : null);

// ------------------------------------------------------------------------------------------------------------------------------------ SQL
const ORDER_SELECT = `
  select o.id, o.order_number, o.quantity_planned, to_char(o.due_date, 'YYYY-MM-DD') as due_date, o.status, o.status_reason, o.notes,
         o.external_system, o.external_id, o.created_at, o.updated_at,
         p.id as part_id, p.part_number, p.name as part_name,
         r.id as rev_id, r.revision as rev_revision, r.version as rev_version,
         c.id as customer_id, c.code as customer_code, c.name as customer_name,
         s.id as site_id, s.code as site_code, s.name as site_name,
         (select count(*) from public.lots l where l.production_order_id = o.id) as lot_count,
         (select count(*) from public.serial_numbers n where n.production_order_id = o.id) as serial_count,
         (select count(*) from public.production_operations x where x.production_order_id = o.id) as operation_count
  from public.production_orders o
  join public.parts p on p.id = o.part_id
  left join public.part_revisions r on r.id = o.part_revision_id
  left join public.customers c on c.id = o.customer_id
  left join public.sites s on s.id = o.site_id`;
const ORDER_FROM_WHERE = `from public.production_orders o join public.parts p on p.id = o.part_id left join public.customers c on c.id = o.customer_id`;
const ORDER_SORT: Record<string, string[]> = {
  orderNumber: ['upper(o.order_number)'],
  part: ['lower(p.part_number)'],
  customer: ['lower(c.name)'],
  quantityPlanned: ['o.quantity_planned'],
  dueDate: ['o.due_date'],
  status: ['o.status'],
  createdAt: ['o.created_at'],
};

const LOT_SELECT = `
  select l.id, l.lot_number, l.origin, l.quantity, to_char(l.received_on, 'YYYY-MM-DD') as received_on, l.status, l.status_reason, l.notes, l.created_at, l.updated_at,
         p.id as part_id, p.part_number, p.name as part_name,
         o.id as order_id, o.order_number,
         sp.id as supplier_id, sp.code as supplier_code, sp.name as supplier_name,
         s.id as site_id, s.code as site_code, s.name as site_name,
         (select count(*) from public.serial_numbers n where n.lot_id = l.id) as serial_count
  from public.lots l
  join public.parts p on p.id = l.part_id
  left join public.production_orders o on o.id = l.production_order_id
  left join public.suppliers sp on sp.id = l.supplier_id
  left join public.sites s on s.id = l.site_id`;
const LOT_SORT: Record<string, string[]> = {
  lotNumber: ['upper(l.lot_number)'],
  part: ['lower(p.part_number)'],
  origin: ['l.origin'],
  quantity: ['l.quantity'],
  status: ['l.status'],
  createdAt: ['l.created_at'],
};

const SERIAL_SELECT = `
  select n.id, n.serial_number, n.status, n.status_reason, n.notes, n.created_at, n.updated_at,
         p.id as part_id, p.part_number, p.name as part_name,
         l.id as lot_id, l.lot_number,
         o.id as order_id, o.order_number,
         s.id as site_id, s.code as site_code, s.name as site_name
  from public.serial_numbers n
  join public.parts p on p.id = n.part_id
  left join public.lots l on l.id = n.lot_id
  left join public.production_orders o on o.id = n.production_order_id
  left join public.sites s on s.id = n.site_id`;
const SERIAL_SORT: Record<string, string[]> = {
  serialNumber: ['upper(n.serial_number)'],
  part: ['lower(p.part_number)'],
  lot: ['upper(l.lot_number)'],
  status: ['n.status'],
  createdAt: ['n.created_at'],
};

// ------------------------------------------------------------------------------------------------------------------------------------ Mapping
const toOperation = (r: Row): z.infer<typeof Operation> => ({
  id: r.id as string,
  sequence: Number(r.sequence),
  operationCode: r.operation_code as string,
  description: (r.description as string) ?? null,
  machine: codeRef(r, 'machine'),
  status: r.status as z.infer<typeof Operation>['status'],
});

const toOrder = (r: Row): ProductionOrder => ({
  id: r.id as string,
  orderNumber: r.order_number as string,
  part: partRef(r),
  partRevision: r.rev_id ? { id: r.rev_id as string, revision: r.rev_revision as string, version: Number(r.rev_version ?? 1) } : null,
  customer: codeRef(r, 'customer'),
  site: codeRef(r, 'site'),
  quantityPlanned: num(r.quantity_planned)!,
  dueDate: (r.due_date as string) ?? null,
  status: r.status as ProductionOrder['status'],
  statusReason: (r.status_reason as string) ?? null,
  notes: (r.notes as string) ?? null,
  external: r.external_id ? { system: r.external_system as string, id: r.external_id as string } : null,
  lotCount: Number(r.lot_count),
  serialCount: Number(r.serial_count),
  operationCount: Number(r.operation_count),
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

const toLot = (r: Row): Lot => ({
  id: r.id as string,
  lotNumber: r.lot_number as string,
  part: partRef(r),
  origin: r.origin as Lot['origin'],
  productionOrder: r.order_id ? { id: r.order_id as string, orderNumber: r.order_number as string } : null,
  supplier: codeRef(r, 'supplier'),
  site: codeRef(r, 'site'),
  quantity: num(r.quantity),
  receivedOn: (r.received_on as string) ?? null,
  status: r.status as Lot['status'],
  statusReason: (r.status_reason as string) ?? null,
  notes: (r.notes as string) ?? null,
  serialCount: Number(r.serial_count),
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

const toSerial = (r: Row): Serial => ({
  id: r.id as string,
  serialNumber: r.serial_number as string,
  part: partRef(r),
  lot: r.lot_id ? { id: r.lot_id as string, lotNumber: r.lot_number as string } : null,
  productionOrder: r.order_id ? { id: r.order_id as string, orderNumber: r.order_number as string } : null,
  site: codeRef(r, 'site'),
  status: r.status as Serial['status'],
  statusReason: (r.status_reason as string) ?? null,
  notes: (r.notes as string) ?? null,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

/** Production orders, operations, lots and serial numbers (Phase 3, TR2). Written under RLS (production.manage); the database owns every rule (status moves, part/lot/order agreement). */
@Injectable()
export class ProductionService {
  constructor(private readonly database: DatabaseService) {}

  // ---------------------------------------------------------------------------------------------------------------------------- Orders
  listOrders(ctx: RequestContext, q: OrderListQuery) {
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`o.organisation_id = ${orgOf(ctx)}::uuid`];
      if (q.status.length) where.push(sql`o.status = any (string_to_array(${q.status.join(',')}, ','))`);
      if (q.partId) where.push(sql`o.part_id = ${q.partId}::uuid`);
      if (q.customerId) where.push(sql`o.customer_id = ${q.customerId}::uuid`);
      if (q.siteId) where.push(sql`o.site_id = ${q.siteId}::uuid`);
      if (q.q) {
        const like = likePattern(q.q);
        where.push(sql`(o.order_number ilike ${like} or p.part_number ilike ${like} or p.name ilike ${like} or c.name ilike ${like})`);
      }
      const order = sql`${sortSql(ORDER_SORT[q.sort], q.order)}, o.id asc`;
      const rows = await db.execute<Row>(sql`${sql.raw(ORDER_SELECT)} where ${sql.join(where, sql` and `)} order by ${order} limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`);
      const count = await db.execute<{ n: string }>(sql`select count(*) as n ${sql.raw(ORDER_FROM_WHERE)} where ${sql.join(where, sql` and `)}`);
      return { data: rows.rows.map(toOrder), page: q.page, pageSize: q.pageSize, total: Number(count.rows[0].n) };
    });
  }

  lookupOrders(ctx: RequestContext, q: z.infer<typeof OrderLookupQuery>): Promise<z.infer<typeof OrderOption>[]> {
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`o.organisation_id = ${orgOf(ctx)}::uuid`];
      if (!q.includeClosed) where.push(sql`o.status not in ('closed', 'cancelled')`);
      if (q.partId) where.push(sql`o.part_id = ${q.partId}::uuid`);
      if (q.q) where.push(sql`(o.order_number ilike ${likePattern(q.q)} or p.part_number ilike ${likePattern(q.q)})`);
      const rows = await db.execute<Row>(sql`select o.id, o.order_number, o.status, o.quantity_planned, p.id as part_id, p.part_number, p.name as part_name
        from public.production_orders o join public.parts p on p.id = o.part_id where ${sql.join(where, sql` and `)} order by o.created_at desc limit 30`);
      return rows.rows.map((r) => ({ id: r.id as string, orderNumber: r.order_number as string, part: partRef(r), status: r.status as ProductionOrder['status'], quantityPlanned: num(r.quantity_planned)! }));
    });
  }

  getOrder(ctx: RequestContext, id: string): Promise<ProductionOrderDetail> {
    return this.database.asUser(ctx, (db) => this.loadOrder(db, ctx, id));
  }

  createOrder(ctx: RequestContext, body: CreateOrderBody): Promise<ProductionOrderDetail> {
    return this.database.asUser(ctx, async (db) => {
      const siteId = body.siteId === undefined ? await this.onlySite(db, ctx) : body.siteId;
      const parts = insertParts(
        { ...body, siteId },
        { orderNumber: 'order_number', partId: 'part_id', partRevisionId: 'part_revision_id', customerId: 'customer_id', siteId: 'site_id', quantityPlanned: 'quantity_planned', dueDate: 'due_date', notes: 'notes' },
        { organisation_id: orgOf(ctx) },
      );
      const result = await db.execute<{ id: string }>(sql`insert into public.production_orders (${parts.columns}) values (${parts.values}) returning id`);
      return this.loadOrder(db, ctx, result.rows[0].id);
    });
  }

  updateOrder(ctx: RequestContext, id: string, body: UpdateOrderBody): Promise<ProductionOrderDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadOrder(db, ctx, id); // 404 outside this organisation
      const set = assignments(body, { partRevisionId: 'part_revision_id', customerId: 'customer_id', quantityPlanned: 'quantity_planned', dueDate: 'due_date', notes: 'notes', status: 'status', statusReason: 'status_reason' });
      const result = await db.execute(sql`update public.production_orders set ${sql.join(set, sql`, `)} where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid returning id`);
      if (!result.rows.length) throw ApiError.forbidden();
      return this.loadOrder(db, ctx, id);
    });
  }

  createOperation(ctx: RequestContext, orderId: string, body: CreateOperationBody): Promise<ProductionOrderDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadOrder(db, ctx, orderId);
      let sequence = body.sequence;
      if (sequence === undefined) {
        const next = await db.execute<{ n: number }>(sql`select coalesce(max(sequence), 0) + 10 as n from public.production_operations where production_order_id = ${orderId}::uuid`);
        sequence = Math.min(Number(next.rows[0].n), 9999);
      }
      await db.execute(sql`insert into public.production_operations (organisation_id, production_order_id, sequence, operation_code, description, machine_id)
        values (${orgOf(ctx)}::uuid, ${orderId}::uuid, ${sequence}, ${body.operationCode}, ${body.description ?? null}, ${body.machineId ?? null}::uuid)`);
      return this.loadOrder(db, ctx, orderId);
    });
  }

  updateOperation(ctx: RequestContext, id: string, body: UpdateOperationBody): Promise<ProductionOrderDetail> {
    return this.database.asUser(ctx, async (db) => {
      const found = await db.execute<{ production_order_id: string }>(sql`select production_order_id from public.production_operations where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (!found.rows.length) throw ApiError.notFound('operation_not_found', 'Operation not found');
      const set = assignments(body, { sequence: 'sequence', operationCode: 'operation_code', description: 'description', machineId: 'machine_id', status: 'status' });
      const result = await db.execute(sql`update public.production_operations set ${sql.join(set, sql`, `)} where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid returning id`);
      if (!result.rows.length) throw ApiError.forbidden();
      return this.loadOrder(db, ctx, found.rows[0].production_order_id);
    });
  }

  // ---------------------------------------------------------------------------------------------------------------------------- Lots
  listLots(ctx: RequestContext, q: LotListQuery) {
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`l.organisation_id = ${orgOf(ctx)}::uuid`];
      if (q.status.length) where.push(sql`l.status = any (string_to_array(${q.status.join(',')}, ','))`);
      if (q.origin) where.push(sql`l.origin = ${q.origin}`);
      if (q.partId) where.push(sql`l.part_id = ${q.partId}::uuid`);
      if (q.supplierId) where.push(sql`l.supplier_id = ${q.supplierId}::uuid`);
      if (q.productionOrderId) where.push(sql`l.production_order_id = ${q.productionOrderId}::uuid`);
      if (q.siteId) where.push(sql`l.site_id = ${q.siteId}::uuid`);
      if (q.q) where.push(sql`(l.lot_number ilike ${likePattern(q.q)} or p.part_number ilike ${likePattern(q.q)} or p.name ilike ${likePattern(q.q)})`);
      const order = sql`${sortSql(LOT_SORT[q.sort], q.order)}, l.id asc`;
      const rows = await db.execute<Row>(sql`${sql.raw(LOT_SELECT)} where ${sql.join(where, sql` and `)} order by ${order} limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`);
      const count = await db.execute<{ n: string }>(sql`select count(*) as n from public.lots l join public.parts p on p.id = l.part_id where ${sql.join(where, sql` and `)}`);
      return { data: rows.rows.map(toLot), page: q.page, pageSize: q.pageSize, total: Number(count.rows[0].n) };
    });
  }

  lookupLots(ctx: RequestContext, q: z.infer<typeof LotLookupQuery>): Promise<z.infer<typeof LotOption>[]> {
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`l.organisation_id = ${orgOf(ctx)}::uuid`];
      if (!q.includeClosed) where.push(sql`l.status <> 'closed'`);
      if (q.partId) where.push(sql`l.part_id = ${q.partId}::uuid`);
      if (q.productionOrderId) where.push(sql`l.production_order_id = ${q.productionOrderId}::uuid`);
      if (q.q) where.push(sql`(l.lot_number ilike ${likePattern(q.q)} or p.part_number ilike ${likePattern(q.q)})`);
      const rows = await db.execute<Row>(sql`select l.id, l.lot_number, l.origin, l.status, l.status_reason, p.id as part_id, p.part_number, p.name as part_name, o.id as order_id, o.order_number
        from public.lots l join public.parts p on p.id = l.part_id left join public.production_orders o on o.id = l.production_order_id
        where ${sql.join(where, sql` and `)} order by l.created_at desc limit 30`);
      return rows.rows.map((r) => ({
        id: r.id as string,
        lotNumber: r.lot_number as string,
        part: partRef(r),
        origin: r.origin as Lot['origin'],
        productionOrder: r.order_id ? { id: r.order_id as string, orderNumber: r.order_number as string } : null,
        status: r.status as Lot['status'],
        statusReason: (r.status_reason as string) ?? null,
      }));
    });
  }

  getLot(ctx: RequestContext, id: string): Promise<Lot> {
    return this.database.asUser(ctx, (db) => this.loadLot(db, ctx, id));
  }

  createLot(ctx: RequestContext, body: CreateLotBody): Promise<Lot> {
    return this.database.asUser(ctx, async (db) => {
      const parts = insertParts(body, { lotNumber: 'lot_number', partId: 'part_id', origin: 'origin', productionOrderId: 'production_order_id', supplierId: 'supplier_id', siteId: 'site_id', quantity: 'quantity', receivedOn: 'received_on', notes: 'notes' }, { organisation_id: orgOf(ctx) });
      const result = await db.execute<{ id: string }>(sql`insert into public.lots (${parts.columns}) values (${parts.values}) returning id`);
      return this.loadLot(db, ctx, result.rows[0].id);
    });
  }

  updateLot(ctx: RequestContext, id: string, body: UpdateLotBody): Promise<Lot> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadLot(db, ctx, id);
      const set = assignments(body, { supplierId: 'supplier_id', quantity: 'quantity', receivedOn: 'received_on', notes: 'notes', status: 'status', statusReason: 'status_reason' });
      const result = await db.execute(sql`update public.lots set ${sql.join(set, sql`, `)} where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid returning id`);
      if (!result.rows.length) throw ApiError.forbidden();
      return this.loadLot(db, ctx, id);
    });
  }

  // ---------------------------------------------------------------------------------------------------------------------------- Serial numbers
  listSerials(ctx: RequestContext, q: SerialListQuery) {
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`n.organisation_id = ${orgOf(ctx)}::uuid`];
      if (q.status.length) where.push(sql`n.status = any (string_to_array(${q.status.join(',')}, ','))`);
      if (q.partId) where.push(sql`n.part_id = ${q.partId}::uuid`);
      if (q.lotId) where.push(sql`n.lot_id = ${q.lotId}::uuid`);
      if (q.productionOrderId) where.push(sql`n.production_order_id = ${q.productionOrderId}::uuid`);
      if (q.q) where.push(sql`(n.serial_number ilike ${likePattern(q.q)} or p.part_number ilike ${likePattern(q.q)} or l.lot_number ilike ${likePattern(q.q)})`);
      // Serial numbers made together share a timestamp, so ties go in number order.
      const order = sql`${sortSql(SERIAL_SORT[q.sort], q.order)}, upper(n.serial_number) asc, n.id asc`;
      const rows = await db.execute<Row>(sql`${sql.raw(SERIAL_SELECT)} where ${sql.join(where, sql` and `)} order by ${order} limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`);
      const count = await db.execute<{ n: string }>(sql`select count(*) as n from public.serial_numbers n join public.parts p on p.id = n.part_id left join public.lots l on l.id = n.lot_id where ${sql.join(where, sql` and `)}`);
      return { data: rows.rows.map(toSerial), page: q.page, pageSize: q.pageSize, total: Number(count.rows[0].n) };
    });
  }

  lookupSerials(ctx: RequestContext, q: z.infer<typeof SerialLookupQuery>): Promise<z.infer<typeof SerialOption>[]> {
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`n.organisation_id = ${orgOf(ctx)}::uuid`];
      if (!q.includeClosed) where.push(sql`n.status <> 'scrapped'`);
      if (q.partId) where.push(sql`n.part_id = ${q.partId}::uuid`);
      if (q.lotId) where.push(sql`n.lot_id = ${q.lotId}::uuid`);
      if (q.productionOrderId) where.push(sql`n.production_order_id = ${q.productionOrderId}::uuid`);
      if (q.q) where.push(sql`(n.serial_number ilike ${likePattern(q.q)} or p.part_number ilike ${likePattern(q.q)})`);
      const rows = await db.execute<Row>(sql`select n.id, n.serial_number, n.status, p.id as part_id, p.part_number, p.name as part_name, l.id as lot_id, l.lot_number, o.id as order_id, o.order_number
        from public.serial_numbers n join public.parts p on p.id = n.part_id left join public.lots l on l.id = n.lot_id left join public.production_orders o on o.id = n.production_order_id
        where ${sql.join(where, sql` and `)} order by n.created_at desc, n.serial_number limit 30`);
      return rows.rows.map((r) => ({
        id: r.id as string,
        serialNumber: r.serial_number as string,
        part: partRef(r),
        lot: r.lot_id ? { id: r.lot_id as string, lotNumber: r.lot_number as string } : null,
        productionOrder: r.order_id ? { id: r.order_id as string, orderNumber: r.order_number as string } : null,
        status: r.status as Serial['status'],
      }));
    });
  }

  getSerial(ctx: RequestContext, id: string): Promise<Serial> {
    return this.database.asUser(ctx, (db) => this.loadSerial(db, ctx, id));
  }

  /** One serial number, a list or a numbered range, all in one transaction: a clash or a rule failure creates none of them. */
  createSerials(ctx: RequestContext, body: CreateSerialsBody): Promise<{ data: Serial[] }> {
    const numbers = body.serialNumber
      ? [body.serialNumber]
      : body.serials
        ? body.serials
        : Array.from({ length: body.range!.to - body.range!.from + 1 }, (_, i) => `${body.range!.prefix}${String(body.range!.from + i).padStart(body.range!.pad, '0')}`);
    if (numbers.some((n) => n.length > 60)) throw ApiError.badRequest('invalid_value', 'A serial number is at most 60 characters');
    if (new Set(numbers.map((n) => n.toUpperCase())).size !== numbers.length) throw new ApiError(409, 'conflict', 'The list names the same serial number twice');
    return this.database.asUser(ctx, async (db) => {
      const ids: string[] = [];
      for (const serial of numbers) {
        const result = await db.execute<{ id: string }>(sql`insert into public.serial_numbers (organisation_id, serial_number, part_id, lot_id, production_order_id, site_id, notes)
          values (${orgOf(ctx)}::uuid, ${serial}, ${body.partId}::uuid, ${body.lotId ?? null}::uuid, ${body.productionOrderId ?? null}::uuid, ${body.siteId ?? null}::uuid, ${body.notes ?? null}) returning id`);
        ids.push(result.rows[0].id);
      }
      const rows = await db.execute<Row>(sql`${sql.raw(SERIAL_SELECT)} where n.id = any (string_to_array(${ids.join(',')}, ',')::uuid[]) order by upper(n.serial_number)`);
      return { data: rows.rows.map(toSerial) };
    });
  }

  updateSerial(ctx: RequestContext, id: string, body: UpdateSerialBody): Promise<Serial> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadSerial(db, ctx, id);
      const set = assignments(body, { lotId: 'lot_id', productionOrderId: 'production_order_id', notes: 'notes', status: 'status', statusReason: 'status_reason' });
      const result = await db.execute(sql`update public.serial_numbers set ${sql.join(set, sql`, `)} where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid returning id`);
      if (!result.rows.length) throw ApiError.forbidden();
      return this.loadSerial(db, ctx, id);
    });
  }

  // ---------------------------------------------------------------------------------------------------------------------------- Helpers
  /** A site is chosen for the order when the organisation has exactly one (rows are site-scoped for permissions); with several the caller must say. */
  private async onlySite(db: Db, ctx: RequestContext): Promise<string | null> {
    const sites = await db.execute<{ id: string }>(sql`select id from public.sites where organisation_id = ${orgOf(ctx)}::uuid limit 2`);
    return sites.rows.length === 1 ? sites.rows[0].id : null;
  }

  private async loadOrder(db: Db, ctx: RequestContext, id: string): Promise<ProductionOrderDetail> {
    const result = await db.execute<Row>(sql`${sql.raw(ORDER_SELECT)} where o.id = ${id}::uuid and o.organisation_id = ${orgOf(ctx)}::uuid`);
    if (!result.rows.length) throw ApiError.notFound('production_order_not_found', 'Production order not found');
    const ops = await db.execute<Row>(sql`select x.id, x.sequence, x.operation_code, x.description, x.status, m.id as machine_id, m.code as machine_code, m.name as machine_name
      from public.production_operations x left join public.machines m on m.id = x.machine_id where x.production_order_id = ${id}::uuid order by x.sequence`);
    return { ...toOrder(result.rows[0]), operations: ops.rows.map(toOperation) };
  }

  private async loadLot(db: Db, ctx: RequestContext, id: string): Promise<Lot> {
    const result = await db.execute<Row>(sql`${sql.raw(LOT_SELECT)} where l.id = ${id}::uuid and l.organisation_id = ${orgOf(ctx)}::uuid`);
    if (!result.rows.length) throw ApiError.notFound('lot_not_found', 'Lot not found');
    return toLot(result.rows[0]);
  }

  private async loadSerial(db: Db, ctx: RequestContext, id: string): Promise<Serial> {
    const result = await db.execute<Row>(sql`${sql.raw(SERIAL_SELECT)} where n.id = ${id}::uuid and n.organisation_id = ${orgOf(ctx)}::uuid`);
    if (!result.rows.length) throw ApiError.notFound('serial_number_not_found', 'Serial number not found');
    return toSerial(result.rows[0]);
  }
}
