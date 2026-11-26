import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { Row } from '../calibration/calibration.service';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse } from '../common/validation';
import { DatabaseService } from '../database/database.service';
import { OrganisationScoped } from '../tenancy/organisation.guard';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const n = (v: unknown) => Number(v ?? 0);
const nn = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const day = (v: unknown) => (v ? String(v).slice(0, 10) : null);
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

/** On-time delivery below this is flagged for a customer on the attention list (a reading aid, not a contract term). */
export const ON_TIME_TARGET = 90;
/** How many customers the dashboard lists (the database works every customer out in one statement). */
export const CUSTOMER_LIMIT = 300;

export const CustomerDashboardQuery = z
  .object({ from: isoDate, to: isoDate, policy: z.enum(['requested', 'agreed']).default('requested'), grace: z.coerce.number().int().min(0).max(60).default(0) })
  .refine((q) => q.from <= q.to, { message: '"from" must be on or before "to"', path: ['from'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 3 * 366, { message: 'At most three years', path: ['from'] });

const Id = z.string().uuid();
const CustomerRef = z.object({ id: Id, code: z.string(), name: z.string() });
const SEVERITIES = ['critical', 'major', 'minor', 'unrated'] as const;

export const CustomerDashboard = z.object({
  /** False when the caller may not read non-conformances as well as shipping: the figures are then empty, not zero. */
  available: z.boolean(),
  reason: z.string().nullable(),
  period: z.object({ from: isoDate, to: isoDate, bucket: z.enum(['week', 'month']), policy: z.enum(['requested', 'agreed']), graceDaysAfter: z.number() }),
  totals: z.object({
    /** Customers that were shipped to in the period. */
    customers: z.number(),
    shipments: z.number(),
    shippedUnits: z.number(),
    matchedLines: z.number(),
    onTimeLines: z.number(),
    onTimePercent: z.number().nullable(),
    inFullJudged: z.number(),
    inFullLines: z.number(),
    inFullPercent: z.number().nullable(),
    ncsRaised: z.number(),
    ncUnits: z.number(),
    /** Defects reported in the period over units shipped in the period; null when nothing shipped. */
    ppm: z.number().nullable(),
    /** The traced figure: affected units on lots shipped to the customer over units shipped with a lot. */
    ppmLot: z.number().nullable(),
    tracedPercent: z.number().nullable(),
    returnedUnits: z.number(),
    returnedPercent: z.number().nullable(),
    openNcs: z.number(),
    openLateLines: z.number(),
    cost: z.number(),
    costCurrency: z.string().nullable(),
    shippedWithoutOrder: z.number(),
    shippedWithoutLot: z.number(),
  }),
  bySeverity: z.array(z.object({ key: z.enum(SEVERITIES), count: z.number() })),
  trend: z.array(z.object({ start: isoDate, shippedUnits: z.number(), ncUnits: z.number(), ncs: z.number(), critical: z.number(), major: z.number(), minor: z.number(), ppm: z.number().nullable() })),
  /** Customers shipped to, or with NCs, in the period, worst PPM first. */
  customers: z.array(
    CustomerRef.extend({
      shippedUnits: z.number(), shipments: z.number(), onTimePercent: z.number().nullable(), matchedLines: z.number(), inFullPercent: z.number().nullable(),
      ncs: z.number(), critical: z.number(), ncUnits: z.number(), ppm: z.number().nullable(), ppmLot: z.number().nullable(), returnedUnits: z.number(), openNcs: z.number(), openLateLines: z.number(),
    }),
  ),
  /** Customers that need a look, with the first reason in words. */
  attention: z.array(CustomerRef.extend({ reasons: z.array(z.string()) })),
  /** Open order lines past their due date, longest first. */
  lateOrderLines: z.array(z.object({ orderId: Id, orderNumber: z.string(), lineNumber: z.number(), customer: CustomerRef, partNumber: z.string(), outstanding: z.number(), dueOn: isoDate, daysLate: z.number() })),
});
export type CustomerDashboard = z.infer<typeof CustomerDashboard>;

const customerRef = (r: Row) => ({ id: r.customer_id as string, code: r.customer_code as string, name: r.customer_name as string });

/** Reasons a customer is on the attention list, worst first. Pure, so it can be tested without a database. */
export function attentionReasons(c: { critical: number; onTimePercent: number | null; matchedLines: number; ppm: number | null; ncUnits: number; openLateLines: number }): string[] {
  const out: string[] = [];
  if (c.critical > 0) out.push(c.critical === 1 ? 'A critical complaint in the period' : `${c.critical} critical complaints in the period`);
  if (c.ppm !== null && c.ncUnits > 0) out.push(`${Math.round(c.ppm).toLocaleString('en-GB')} PPM reported`);
  if (c.onTimePercent !== null && c.onTimePercent < ON_TIME_TARGET) out.push(`On time ${c.onTimePercent}% (aim ${ON_TIME_TARGET}%)`);
  if (c.openLateLines > 0) out.push(c.openLateLines === 1 ? 'An order line is past its date' : `${c.openLateLines} order lines are past their date`);
  return out;
}

const emptyTotals = {
  customers: 0, shipments: 0, shippedUnits: 0, matchedLines: 0, onTimeLines: 0, onTimePercent: null, inFullJudged: 0, inFullLines: 0, inFullPercent: null, ncsRaised: 0, ncUnits: 0, ppm: null, ppmLot: null,
  tracedPercent: null, returnedUnits: 0, returnedPercent: null, openNcs: 0, openLateLines: 0, cost: 0, costCurrency: null, shippedWithoutOrder: 0, shippedWithoutLot: 0,
};

@Injectable()
export class CustomerDashboardService {
  constructor(private readonly database: DatabaseService) {}

  get(ctx: RequestContext, q: z.infer<typeof CustomerDashboardQuery>): Promise<CustomerDashboard> {
    const org = ctx.organisationId!;
    const bucket: 'week' | 'month' = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 92 ? 'week' : 'month';
    const period = { from: q.from, to: q.to, bucket, policy: q.policy, graceDaysAfter: q.grace };
    return this.database.asUser(ctx, async (db) => {
      const many = async (query: ReturnType<typeof sql>) => (await db.execute<Row>(query)).rows;
      const can = (await many(sql`select app.has_permission(${org}::uuid, 'ncr.read') as ncr, app.has_permission(${org}::uuid, 'shipping.read') as shipping`))[0] ?? {};
      if (!can.ncr || !can.shipping) {
        return {
          available: false,
          reason: 'Customer figures need permission to read both shipping and non-conformances.',
          period, totals: emptyTotals, bySeverity: SEVERITIES.map((key) => ({ key, count: 0 })), trend: [], customers: [], attention: [], lateOrderLines: [],
        };
      }
      // Every customer worked out by the database in one statement, exactly as for one customer, so the figures cannot disagree.
      const rows = await many(sql`select metrics from app.customer_performance(${org}::uuid, ${q.from}::date, ${q.to}::date, ${q.policy}, ${q.grace}::int, null)`);
      const all = rows.map((r) => r.metrics as Record<string, Record<string, unknown>>);
      const sum = (a: string, b: string) => all.reduce((t, m) => t + n(m[a]?.[b]), 0);
      const active = all.filter((m) => n(m.shipped?.lines) > 0 || n(m.ncs?.raised) > 0 || n(m.delivery?.openLate) > 0 || n(m.ncs?.openNow) > 0);

      const customers = active
        .map((m) => {
          const c = m.customer as unknown as { id: string; code: string; name: string };
          return {
            id: c.id, code: c.code, name: c.name,
            shippedUnits: n(m.shipped.units), shipments: n(m.shipped.shipments), onTimePercent: nn(m.delivery.onTimePct), matchedLines: n(m.delivery.matched), inFullPercent: nn(m.inFull.pct),
            ncs: n(m.ncs.raised), critical: n((m.ncs.bySeverity as Record<string, unknown>).critical), ncUnits: n(m.ncs.units), ppm: nn(m.ppm.value), ppmLot: nn(m.ppmLot.value),
            returnedUnits: n(m.returns.units), openNcs: n(m.ncs.openNow), openLateLines: n(m.delivery.openLate),
          };
        })
        .sort((a, b) => (b.ppm ?? -1) - (a.ppm ?? -1) || b.ncUnits - a.ncUnits || b.shippedUnits - a.shippedUnits || a.code.localeCompare(b.code))
        .slice(0, CUSTOMER_LIMIT);
      const attention = customers
        .map((c) => ({ id: c.id, code: c.code, name: c.name, reasons: attentionReasons(c), critical: c.critical, ppm: c.ppm ?? 0, onTime: c.onTimePercent ?? 101 }))
        .filter((c) => c.reasons.length > 0)
        .sort((a, b) => b.critical - a.critical || b.ppm - a.ppm || a.onTime - b.onTime || a.code.localeCompare(b.code))
        .slice(0, 8)
        .map(({ id, code, name, reasons }) => ({ id, code, name, reasons }));

      const trendShipped = await many(sql`
        select to_char(date_trunc(${bucket}, s.shipped_on), 'YYYY-MM-DD') as start, sum(l.quantity_shipped) as units
          from public.shipments s join public.shipment_lines l on l.shipment_id = s.id
         where s.organisation_id = ${org}::uuid and s.status = 'shipped' and s.shipped_on between ${q.from}::date and ${q.to}::date group by 1`);
      const trendNcs = await many(sql`
        select to_char(date_trunc(${bucket}, nc.detected_at), 'YYYY-MM-DD') as start, count(*)::int as ncs, coalesce(sum(nc.quantity_affected), 0) as units,
               count(*) filter (where nc.severity = 'critical')::int as critical, count(*) filter (where nc.severity = 'major')::int as major, count(*) filter (where nc.severity = 'minor')::int as minor
          from public.nonconformances nc
         where nc.organisation_id = ${org}::uuid and nc.source = 'customer' and nc.customer_id is not null and nc.deleted_at is null and nc.stage not in ('draft', 'cancelled')
           and nc.detected_at between ${q.from}::date and ${q.to}::date group by 1`);
      const starts = [...new Set([...trendShipped, ...trendNcs].map((r) => r.start as string))].sort();
      const trend = starts.map((start) => {
        const s = trendShipped.find((r) => r.start === start);
        const c = trendNcs.find((r) => r.start === start);
        const shippedUnits = n(s?.units);
        const ncUnits = n(c?.units);
        return { start, shippedUnits, ncUnits, ncs: n(c?.ncs), critical: n(c?.critical), major: n(c?.major), minor: n(c?.minor), ppm: shippedUnits > 0 ? Math.round((ncUnits / shippedUnits) * 1_000_000) : null };
      });

      const late = await many(sql`
        select o.id as order_id, o.order_number, ol.line_number, cu.id as customer_id, cu.code as customer_code, cu.name as customer_name, p.part_number,
               (ol.quantity_ordered - coalesce((select sum(x.quantity_shipped) from public.shipment_lines x join public.shipments sh on sh.id = x.shipment_id
                                                  where x.order_line_id = ol.id and sh.status = 'shipped'), 0)) as outstanding,
               (case when ${q.policy} = 'requested' then ol.requested_on else coalesce(ol.agreed_on, ol.requested_on) end) as due,
               (current_date - (case when ${q.policy} = 'requested' then ol.requested_on else coalesce(ol.agreed_on, ol.requested_on) end))::int as days
          from public.customer_order_lines ol join public.customer_orders o on o.id = ol.customer_order_id
          join public.customers cu on cu.id = o.customer_id join public.parts p on p.id = ol.part_id
         where ol.organisation_id = ${org}::uuid and ol.status = 'open' and o.status = 'open'
           and (case when ${q.policy} = 'requested' then ol.requested_on else coalesce(ol.agreed_on, ol.requested_on) end) + ${q.grace}::int < current_date
           and ol.quantity_ordered > coalesce((select sum(x.quantity_shipped) from public.shipment_lines x join public.shipments sh on sh.id = x.shipment_id where x.order_line_id = ol.id and sh.status = 'shipped'), 0)
         order by days desc, o.order_number, ol.line_number limit 8`);

      const shippedUnits = sum('shipped', 'units');
      const matched = sum('delivery', 'matched');
      const full = sum('inFull', 'full');
      const judged = sum('inFull', 'full') + sum('inFull', 'short') + sum('inFull', 'over');
      const ncUnits = sum('ncs', 'units');
      const traced = sum('ppmLot', 'shippedUnits');
      const returned = sum('returns', 'units');
      const sev = (k: string) => all.reduce((t, m) => t + n((m.ncs.bySeverity as Record<string, unknown>)[k]), 0);
      return {
        available: true,
        reason: null,
        period,
        totals: {
          customers: all.filter((m) => n(m.shipped.lines) > 0).length,
          shipments: sum('shipped', 'shipments'),
          shippedUnits,
          matchedLines: matched,
          onTimeLines: sum('delivery', 'onTime'),
          onTimePercent: pct(sum('delivery', 'onTime'), matched),
          inFullJudged: judged,
          inFullLines: full,
          inFullPercent: pct(full, judged),
          ncsRaised: sum('ncs', 'raised'),
          ncUnits,
          ppm: shippedUnits > 0 ? Math.round((ncUnits / shippedUnits) * 1_000_000) : null,
          ppmLot: traced > 0 ? Math.round((sum('ppmLot', 'affectedUnits') / traced) * 1_000_000) : null,
          tracedPercent: pct(traced, shippedUnits),
          returnedUnits: returned,
          returnedPercent: shippedUnits > 0 ? Math.round((returned / shippedUnits) * 10_000) / 100 : null,
          openNcs: sum('ncs', 'openNow'),
          openLateLines: sum('delivery', 'openLate'),
          cost: sum('ncs', 'cost'),
          costCurrency: (all[0]?.ncs?.costCurrency as string) ?? null,
          shippedWithoutOrder: sum('coverage', 'withoutOrder'),
          shippedWithoutLot: sum('coverage', 'withoutLot'),
        },
        bySeverity: SEVERITIES.map((key) => ({ key, count: sev(key === 'unrated' ? 'unrated' : key) })),
        trend,
        customers,
        attention,
        lateOrderLines: late.map((r) => ({
          orderId: r.order_id as string, orderNumber: r.order_number as string, lineNumber: n(r.line_number), customer: customerRef(r), partNumber: r.part_number as string,
          outstanding: n(r.outstanding), dueOn: day(r.due) as string, daysLate: n(r.days),
        })),
      };
    });
  }
}

/**
 * Customer quality dashboard: what was shipped, on time and in full, what customers reported (NC quantities, PPM by period and by lot), and what came back
 * under an RMA. Every customer's figures come from `app.customer_performance`, the same function a single customer's figures use. Read as the caller; it needs
 * shipping and non-conformance read permission, and says so when it does not have them.
 */
@ApiTags('customer-quality')
@ApiBearerAuth()
@Controller('customer-quality/dashboard')
export class CustomerDashboardController {
  constructor(private readonly service: CustomerDashboardService) {}

  @Get()
  @OrganisationScoped('shipping.read')
  @ApiQuery({ name: 'from', required: true, description: 'From (YYYY-MM-DD)' })
  @ApiQuery({ name: 'to', required: true, description: 'To (YYYY-MM-DD)' })
  @ApiQuery({ name: 'policy', required: false, description: 'requested (default) or agreed: the date on-time is measured against' })
  @ApiQuery({ name: 'grace', required: false, description: 'Days of grace after the date (0 to 60)' })
  @ApiOkResponse({ schema: openApiSchema(CustomerDashboard) })
  get(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.get(ctx, parse(CustomerDashboardQuery, query));
  }
}
