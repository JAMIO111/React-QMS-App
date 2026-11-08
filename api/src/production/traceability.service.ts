import { Injectable } from '@nestjs/common';
import { sql, SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { SUBJECT_TYPES, TraceQuery, Traceability } from './traceability.schemas';

type Row = Record<string, unknown>;
type Kind = (typeof SUBJECT_TYPES)[number];
const num = (v: unknown) => (v == null ? null : Number(v));
const iso = (v: unknown) => new Date(v as string).toISOString();
const party = (id: unknown, name: unknown) => (id ? { id: id as string, name: name as string } : null);
const LIMIT = 100;
const SERIAL_LIMIT = 200;

/**
 * Traceability (TR5): what a production order, lot or serial number touched and what touched it. Read-only: every row comes through row-level security as the caller, and a section the
 * caller may not read is reported unavailable rather than empty. A record matches at the subject's own level (the production links fill in the levels above, so an order sees what was
 * recorded against its lots and serial numbers too); an NC also matches through a live affected lot or affected serial number.
 */
@Injectable()
export class TraceabilityService {
  constructor(private readonly database: DatabaseService) {}

  search(ctx: RequestContext, q: string) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return this.database.asUser(ctx, async (db) => {
      const org = ctx.organisationId!;
      const r = await db.execute<Row>(sql`
        select * from (
          select 'order'::text as type, o.id, o.order_number as number, o.status, p.id as part_id, p.part_number, p.name as part_name
            from public.production_orders o join public.parts p on p.id = o.part_id where o.organisation_id = ${org}::uuid and o.order_number ilike ${like}
          union all
          select 'lot', l.id, l.lot_number, l.status, p.id, p.part_number, p.name
            from public.lots l join public.parts p on p.id = l.part_id where l.organisation_id = ${org}::uuid and l.lot_number ilike ${like}
          union all
          select 'serial', s.id, s.serial_number, s.status, p.id, p.part_number, p.name
            from public.serial_numbers s join public.parts p on p.id = s.part_id where s.organisation_id = ${org}::uuid and s.serial_number ilike ${like}
        ) x order by (lower(number) = lower(${q})) desc, number limit 20`);
      return r.rows.map((x) => ({ type: x.type as Kind, id: x.id as string, number: x.number as string, status: x.status as string, part: { id: x.part_id as string, partNumber: x.part_number as string, name: x.part_name as string } }));
    });
  }

  trace(ctx: RequestContext, q: z.infer<typeof TraceQuery>): Promise<Traceability> {
    return this.database.asUser(ctx, async (db) => {
      const org = ctx.organisationId!;
      const subject = await this.loadSubject(db, org, q.type, q.id);
      const orderId = subject.orderId;

      // Matching at the subject's own level.
      const linked = (alias: 'i' | 'n'): SQL =>
        q.type === 'order'
          ? sql`${sql.raw(alias)}.production_order_id = ${q.id}::uuid`
          : q.type === 'lot'
            ? sql`${sql.raw(alias)}.lot_id = ${q.id}::uuid`
            : sql`${sql.raw(alias)}.serial_id = ${q.id}::uuid`;
      const affected: SQL =
        q.type === 'order'
          ? sql`exists (select 1 from public.ncr_affected_lots al join public.lots l on l.id = al.lot_id where al.nonconformance_id = n.id and al.removed_at is null and l.production_order_id = ${q.id}::uuid)`
          : q.type === 'lot'
            ? sql`exists (select 1 from public.ncr_affected_lots al where al.nonconformance_id = n.id and al.removed_at is null and al.lot_id = ${q.id}::uuid)`
            : sql`exists (select 1 from public.ncr_affected_lots al where al.nonconformance_id = n.id and al.removed_at is null and ${q.id}::uuid = any (al.serial_ids))`;

      const can = await db.execute<Row>(sql`select app.has_permission_somewhere(${org}::uuid, 'inspection.read') as insp, app.has_permission_somewhere(${org}::uuid, 'ncr.read') as ncr, app.has_permission_somewhere(${org}::uuid, 'capa.read') as capa`);
      const mayInspect = can.rows[0].insp === true;
      const mayNcr = can.rows[0].ncr === true;
      const mayCapa = can.rows[0].capa === true;

      const [order, lots, serials, inspections, ncrs, machines, gauges] = await Promise.all([
        orderId ? this.loadOrder(db, org, orderId) : Promise.resolve(null),
        this.loadLots(db, org, q.type, q.id, subject.lotId),
        this.loadSerials(db, org, q.type, q.id, orderId),
        mayInspect ? this.loadInspections(db, linked('i')) : Promise.resolve(null),
        mayNcr ? this.loadNcrs(db, mayCapa, linked('n'), affected) : Promise.resolve(null),
        this.loadMachines(db, mayInspect, linked('i'), orderId),
        mayInspect ? this.loadGauges(db, linked('i')) : Promise.resolve([]),
      ]);

      return {
        subject: subject.view,
        order,
        lots,
        serials,
        inspections: inspections ?? { available: false, total: 0, passed: 0, failed: 0, inProgress: 0, data: [] },
        ncrs: ncrs ?? { available: false, total: 0, data: [] },
        equipment: { machines, gauges },
      };
    });
  }

  // ------------------------------------------------------------------------------------------------------------------------ subject
  private async loadSubject(db: Db, org: string, type: Kind, id: string) {
    const table = type === 'order' ? 'production_orders' : type === 'lot' ? 'lots' : 'serial_numbers';
    const r = await db.execute<Row>(sql`
      select x.id, x.status, x.part_id, p.part_number, p.name as part_name,
             ${sql.raw(type === 'order' ? 'x.order_number' : type === 'lot' ? 'x.lot_number' : 'x.serial_number')} as number,
             ${sql.raw(type === 'order' ? 'x.part_revision_id' : 'null::uuid')} as revision_id,
             ${sql.raw(type === 'order' ? 'x.customer_id' : 'null::uuid')} as customer_id,
             ${sql.raw(type === 'lot' ? 'x.supplier_id' : 'null::uuid')} as supplier_id,
             x.site_id,
             ${sql.raw(type === 'order' ? 'x.quantity_planned' : type === 'lot' ? 'x.quantity' : 'null::numeric')} as quantity,
             ${sql.raw(type === 'order' ? 'x.id' : 'x.production_order_id')} as order_id,
             ${sql.raw(type === 'order' ? 'null::uuid' : type === 'lot' ? 'x.id' : 'x.lot_id')} as lot_id
        from public.${sql.raw(table)} x join public.parts p on p.id = x.part_id
       where x.id = ${id}::uuid and x.organisation_id = ${org}::uuid`);
    if (!r.rows.length) throw ApiError.notFound('trace_subject_not_found', 'Production order, lot or serial number not found');
    const x = r.rows[0];
    // A serial number or lot without its own order takes the order of its lot.
    let orderId = (x.order_id as string | null) ?? null;
    if (!orderId && x.lot_id) {
      const l = await db.execute<Row>(sql`select production_order_id from public.lots where id = ${x.lot_id as string}::uuid`);
      orderId = (l.rows[0]?.production_order_id as string | null) ?? null;
    }
    const names = await db.execute<Row>(sql`
      select (select part_revisions.revision || case when part_revisions.version > 1 then ' v' || part_revisions.version else '' end from public.part_revisions where id = ${x.revision_id as string | null}::uuid) as revision,
             (select coalesce(display_name, name) from public.customers where id = ${x.customer_id as string | null}::uuid) as customer,
             (select coalesce(display_name, name) from public.suppliers where id = ${x.supplier_id as string | null}::uuid) as supplier,
             (select name from public.sites where id = ${x.site_id as string | null}::uuid) as site`);
    const n = names.rows[0];
    return {
      orderId,
      lotId: (x.lot_id as string | null) ?? null,
      view: {
        type,
        id,
        number: x.number as string,
        status: x.status as string,
        part: { id: x.part_id as string, partNumber: x.part_number as string, name: x.part_name as string },
        partRevision: (n.revision as string) ?? null,
        customer: party(x.customer_id, n.customer),
        supplier: party(x.supplier_id, n.supplier),
        site: party(x.site_id, n.site),
        quantity: num(x.quantity),
      },
    };
  }

  private async loadOrder(db: Db, org: string, orderId: string): Promise<Traceability['order']> {
    const o = await db.execute<Row>(sql`select id, order_number, status, quantity_planned, to_char(due_date, 'YYYY-MM-DD') as due_date from public.production_orders where id = ${orderId}::uuid and organisation_id = ${org}::uuid`);
    if (!o.rows.length) return null;
    const ops = await db.execute<Row>(sql`
      select po.id, po.sequence, po.operation_code, po.description, po.status, m.id as machine_id, m.code as machine_code, m.name as machine_name
        from public.production_operations po left join public.machines m on m.id = po.machine_id
       where po.production_order_id = ${orderId}::uuid order by po.sequence`);
    const x = o.rows[0];
    return {
      id: x.id as string,
      orderNumber: x.order_number as string,
      status: x.status as string,
      quantityPlanned: Number(x.quantity_planned),
      dueDate: (x.due_date as string) ?? null,
      operations: ops.rows.map((p) => ({
        id: p.id as string,
        sequence: Number(p.sequence),
        code: p.operation_code as string,
        description: (p.description as string) ?? null,
        status: p.status as string,
        machine: p.machine_id ? { id: p.machine_id as string, code: p.machine_code as string, name: p.machine_name as string } : null,
      })),
    };
  }

  private async loadLots(db: Db, org: string, type: Kind, id: string, lotId: string | null): Promise<Traceability['lots']> {
    const where = type === 'order' ? sql`l.production_order_id = ${id}::uuid` : lotId ? sql`l.id = ${lotId}::uuid` : sql`false`;
    const r = await db.execute<Row>(sql`
      select l.id, l.lot_number, l.status, l.status_reason, l.origin, l.quantity, l.supplier_id, coalesce(s.display_name, s.name) as supplier_name, count(*) over () as total
        from public.lots l left join public.suppliers s on s.id = l.supplier_id
       where l.organisation_id = ${org}::uuid and ${where} order by l.lot_number limit ${LIMIT}`);
    return {
      total: r.rows.length ? Number(r.rows[0].total) : 0,
      data: r.rows.map((l) => ({ id: l.id as string, lotNumber: l.lot_number as string, status: l.status as string, statusReason: (l.status_reason as string) ?? null, origin: l.origin as string, quantity: num(l.quantity), supplier: party(l.supplier_id, l.supplier_name) })),
    };
  }

  private async loadSerials(db: Db, org: string, type: Kind, id: string, orderId: string | null): Promise<Traceability['serials']> {
    const where =
      type === 'serial' ? sql`s.id = ${id}::uuid` : type === 'lot' ? sql`s.lot_id = ${id}::uuid` : sql`(s.production_order_id = ${id}::uuid or s.lot_id in (select id from public.lots where production_order_id = ${orderId ?? id}::uuid))`;
    const r = await db.execute<Row>(sql`
      select s.id, s.serial_number, s.status, l.id as lot_id, l.lot_number, count(*) over () as total
        from public.serial_numbers s left join public.lots l on l.id = s.lot_id
       where s.organisation_id = ${org}::uuid and ${where} order by s.serial_number limit ${SERIAL_LIMIT}`);
    return {
      total: r.rows.length ? Number(r.rows[0].total) : 0,
      data: r.rows.map((s) => ({ id: s.id as string, serialNumber: s.serial_number as string, status: s.status as string, lot: s.lot_id ? { id: s.lot_id as string, lotNumber: s.lot_number as string } : null })),
    };
  }

  private async loadInspections(db: Db, match: SQL): Promise<Traceability['inspections']> {
    const r = await db.execute<Row>(sql`
      select i.id, i.reference, i.status, i.result, i.operation_code, i.started_at, i.work_order, i.lot, i.serial,
             m.id as machine_id, m.code as machine_code, m.name as machine_name,
             (select count(*) from public.inspection_measurements x where x.inspection_record_id = i.id and x.result = 'fail'
                 and not exists (select 1 from public.inspection_measurements c where c.supersedes_id = x.id)) as failures,
             count(*) over () as total,
             count(*) filter (where i.result = 'pass') over () as passed,
             count(*) filter (where i.result = 'fail') over () as failed,
             count(*) filter (where i.status = 'in_progress') over () as in_progress
        from public.inspection_records i left join public.machines m on m.id = i.machine_id
       where ${match} order by i.started_at desc, i.id limit ${LIMIT}`);
    const first = r.rows[0];
    return {
      available: true,
      total: first ? Number(first.total) : 0,
      passed: first ? Number(first.passed) : 0,
      failed: first ? Number(first.failed) : 0,
      inProgress: first ? Number(first.in_progress) : 0,
      data: r.rows.map((i) => ({
        id: i.id as string,
        reference: i.reference as string,
        status: i.status as string,
        result: (i.result as string) ?? null,
        operationCode: (i.operation_code as string) ?? null,
        startedAt: iso(i.started_at),
        failures: Number(i.failures),
        machine: i.machine_id ? { id: i.machine_id as string, code: i.machine_code as string, name: i.machine_name as string } : null,
        lot: (i.lot as string) ?? null,
        serial: (i.serial as string) ?? null,
      })),
    };
  }

  private async loadNcrs(db: Db, mayCapa: boolean, match: SQL, affected: SQL): Promise<Traceability['ncrs']> {
    const r = await db.execute<Row>(sql`
      select n.id, n.reference, n.title, n.stage, n.source, n.severity, n.quantity_affected, (${match}) as is_linked, count(*) over () as total,
             (select count(*) from public.ncr_containment_actions a where a.nonconformance_id = n.id and a.status = 'open') as c_open,
             (select count(*) from public.ncr_containment_actions a where a.nonconformance_id = n.id and a.status = 'done') as c_done,
             (select count(*) from public.ncr_dispositions d where d.nonconformance_id = n.id and d.status = 'proposed') as d_proposed,
             (select count(*) from public.ncr_dispositions d where d.nonconformance_id = n.id and d.status = 'approved') as d_approved,
             (select coalesce(sum(d.quantity), 0) from public.ncr_dispositions d where d.nonconformance_id = n.id and d.status = 'approved') as d_qty
        from public.nonconformances n
       where n.deleted_at is null and n.stage <> 'cancelled' and ((${match}) or (${affected}))
       order by n.created_at desc, n.id limit ${LIMIT}`);
    const ids = r.rows.map((n) => n.id as string);
    const capas = new Map<string, { id: string; reference: string; stage: string; title: string }[]>();
    if (mayCapa && ids.length) {
      const c = await db.execute<Row>(sql`
        select l.nonconformance_id, c.id, c.reference, c.stage, c.title
          from public.capa_ncr_links l join public.capas c on c.id = l.capa_id
         where l.ended_at is null and l.nonconformance_id = any (string_to_array(${ids.join(',')}, ',')::uuid[]) order by c.reference`);
      for (const x of c.rows) {
        const list = capas.get(x.nonconformance_id as string) ?? [];
        list.push({ id: x.id as string, reference: x.reference as string, stage: x.stage as string, title: x.title as string });
        capas.set(x.nonconformance_id as string, list);
      }
    }
    return {
      available: true,
      total: r.rows.length ? Number(r.rows[0].total) : 0,
      data: r.rows.map((n) => ({
        id: n.id as string,
        reference: n.reference as string,
        title: n.title as string,
        stage: n.stage as string,
        source: n.source as string,
        severity: (n.severity as string) ?? null,
        quantityAffected: num(n.quantity_affected),
        matchedVia: n.is_linked ? ('linked' as const) : ('affected_lot' as const),
        containment: { open: Number(n.c_open), done: Number(n.c_done) },
        dispositions: { proposed: Number(n.d_proposed), approved: Number(n.d_approved), approvedQuantity: Number(n.d_qty) },
        capas: capas.get(n.id as string) ?? [],
      })),
    };
  }

  private async loadMachines(db: Db, mayInspect: boolean, match: SQL, orderId: string | null): Promise<Traceability['equipment']['machines']> {
    const r = await db.execute<Row>(sql`
      select m.id, m.code, m.name,
             ${mayInspect ? sql`(select count(*) from public.inspection_records i where i.machine_id = m.id and (${match}))` : sql`0`} as inspections,
             ${orderId ? sql`(select count(*) from public.production_operations po where po.machine_id = m.id and po.production_order_id = ${orderId}::uuid)` : sql`0`} as operations
        from public.machines m
       where ${mayInspect ? sql`exists (select 1 from public.inspection_records i where i.machine_id = m.id and (${match}))` : sql`false`}
          or ${orderId ? sql`exists (select 1 from public.production_operations po where po.machine_id = m.id and po.production_order_id = ${orderId}::uuid)` : sql`false`}
       order by m.code`);
    return r.rows.map((m) => ({ id: m.id as string, code: m.code as string, name: m.name as string, inspections: Number(m.inspections), operations: Number(m.operations) }));
  }

  private async loadGauges(db: Db, match: SQL): Promise<Traceability['equipment']['gauges']> {
    const r = await db.execute<Row>(sql`
      select x.gauge_id as id, max(x.gauge_asset_number) as asset_number, count(*) as readings, count(*) filter (where x.gauge_valid = false) as out_of_calibration, max(x.measured_at) as last_used
        from public.inspection_measurements x join public.inspection_records i on i.id = x.inspection_record_id
       where x.gauge_id is not null and (${match}) group by x.gauge_id order by max(x.gauge_asset_number)`);
    return r.rows.map((g) => ({ id: g.id as string, assetNumber: g.asset_number as string, readings: Number(g.readings), outOfCalibration: Number(g.out_of_calibration), lastUsed: iso(g.last_used) }));
  }
}
