import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { Row } from '../calibration/calibration.service';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse } from '../common/validation';
import { DatabaseService } from '../database/database.service';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { EXPIRY_WARNING_DAYS } from './expiry';
import { AWAITING_RESPONSE } from './supplier-scar.schemas';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const n = (v: unknown) => Number(v ?? 0);
const day = (v: unknown) => (v ? String(v).slice(0, 10) : null);
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

export const SupplierDashboardQuery = z
  .object({ from: isoDate, to: isoDate })
  .refine((q) => q.from <= q.to, { message: '"from" must be on or before "to"', path: ['from'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 3 * 366, { message: 'At most three years', path: ['from'] });

/** How many suppliers are scored for the performance section (each is worked out by the database, as on its own Performance tab). */
export const PERFORMANCE_SUPPLIER_LIMIT = 300;

const Id = z.string().uuid();
const SupplierRef = z.object({ id: Id, code: z.string(), name: z.string() });
const STATUSES = ['pending_approval', 'approved', 'conditional', 'suspended', 'disqualified', 'archived'] as const;
const RISKS = ['low', 'medium', 'high', 'critical', 'none'] as const;
const BANDS = ['good', 'watch', 'poor', 'insufficient'] as const;
const RUNNING_SCAR = ['draft', 'issued', 'acknowledged', 'response_received', 'under_review', 'revision_requested', 'accepted', 'verifying'] as const;

export const SupplierDashboard = z.object({
  period: z.object({ from: isoDate, to: isoDate, bucket: z.enum(['week', 'month']) }),
  /** As of today, active suppliers that are not archived unless said otherwise. */
  kpis: z.object({
    suppliers: z.number(),
    approved: z.number(),
    pendingApproval: z.number(),
    /** Approval proposals waiting for an approver. */
    approvalsWaiting: z.number(),
    /** Rated high or critical. */
    highRisk: z.number(),
    riskNotAssessed: z.number(),
    riskReviewsOverdue: z.number(),
    /** Current certifications and documents past their expiry / expiring within the warning days. */
    expired: z.number(),
    expiring: z.number(),
    openScars: z.number(),
    overdueScars: z.number(),
  }),
  byStatus: z.array(z.object({ key: z.enum(STATUSES), count: z.number() })),
  byRisk: z.array(z.object({ key: z.enum(RISKS), count: z.number() })),
  scarsByStatus: z.array(z.object({ key: z.enum(RUNNING_SCAR), count: z.number() })),
  /** Non-conformances that name a supplier as responsible. `available` is false without `ncr.read` (the figures are then empty, not zero). */
  ncs: z.object({
    available: z.boolean(),
    open: z.number(),
    raised: z.number(),
    trend: z.array(z.object({ start: isoDate, critical: z.number(), major: z.number(), minor: z.number(), unclassified: z.number() })),
    bySupplier: z.array(SupplierRef.extend({ count: z.number(), critical: z.number() })),
  }),
  /** Deliveries. `available` is false without `receiving.read`. */
  receiving: z.object({
    available: z.boolean(),
    /** Delivered lines of the period (cancelled receipts left out) and those whose latest decision is rejected. */
    lines: z.number(),
    rejectedLines: z.number(),
    lotRejectionPercent: z.number().nullable(),
    /** As of today: lines that need inspection and have no decision or are held; open order lines past their due date; material certificates waiting for review. */
    awaitingDecision: z.number(),
    lateOrderLines: z.number(),
    certificatesToReview: z.number(),
    trend: z.array(z.object({ start: isoDate, accepted: z.number(), rejected: z.number(), undecided: z.number() })),
  }),
  /** Every supplier scored over the period by the database, exactly as on its Performance tab. Needs `receiving.read` too. */
  performance: z.object({
    available: z.boolean(),
    scored: z.number(),
    truncated: z.boolean(),
    bands: z.array(z.object({ key: z.enum(BANDS), count: z.number() })),
    otdPercent: z.number().nullable(),
    onTimeLines: z.number(),
    matchedLines: z.number(),
    ppm: z.number().nullable(),
    rejectedUnits: z.number(),
    receivedUnits: z.number(),
    inFullPercent: z.number().nullable(),
    /** Poor or watch, or carrying a warning; worst first. */
    attention: z.array(SupplierRef.extend({ band: z.enum(BANDS), score: z.number().nullable(), warnings: z.number(), reason: z.string().nullable() })),
  }),
  overdueScarList: z.array(z.object({ id: Id, reference: z.string(), title: z.string(), severity: z.string(), supplier: SupplierRef, dueOn: isoDate, daysOverdue: z.number() })),
  approvalList: z.array(z.object({ id: Id, supplier: SupplierRef, target: z.enum(['approved', 'conditional']), proposedAt: z.string(), proposedBy: z.string().nullable() })),
  expiryList: z.array(z.object({ kind: z.enum(['certification', 'document']), id: Id, supplier: SupplierRef, title: z.string(), expiresOn: isoDate, days: z.number() })),
  riskReviewList: z.array(z.object({ supplier: SupplierRef, rating: z.string(), reviewOn: isoDate, daysOverdue: z.number() })),
});
export type SupplierDashboard = z.infer<typeof SupplierDashboard>;

const supplierRef = (r: Row) => ({ id: r.supplier_id as string, code: r.supplier_code as string, name: r.supplier_name as string });
/** Suppliers the dashboard counts: in use and not archived. */
export const LIVE = `s.active and s.approval_status <> 'archived'`;
export const AWAITING = AWAITING_RESPONSE.map((s) => `'${s}'`).join(',');
/** Current certifications and documents that can expire, of live suppliers. */
export const EXPIRING = (org: string) => sql`
  select 'certification' as kind, c.id, c.supplier_id, coalesce(c.title, c.certificate_number) as title, c.expires_on
    from public.supplier_certifications c join public.suppliers s on s.id = c.supplier_id and ${sql.raw(LIVE)}
   where c.organisation_id = ${org}::uuid and c.status = 'current' and c.expires_on is not null
  union all
  select 'document', d.id, d.supplier_id, d.title, d.expires_on
    from public.supplier_documents d join public.suppliers s on s.id = d.supplier_id and ${sql.raw(LIVE)}
   where d.organisation_id = ${org}::uuid and d.status = 'current' and d.expires_on is not null`;
/** Delivered lines of live receipts with their latest decision and whether inspection was required. */
export const LINES = (org: string) => sql`
  select x.id, g.received_on, d.decision, coalesce(det.required, false) as required
    from public.goods_receipt_lines x
    join public.goods_receipts g on g.id = x.goods_receipt_id and g.status = 'received'
    left join public.incoming_inspection_determinations det on det.receipt_line_id = x.id
    left join lateral (select r.decision from public.receipt_line_dispositions r where r.receipt_line_id = x.id order by r.decided_at desc, r.id desc limit 1) d on true
   where g.organisation_id = ${org}::uuid`;

interface Scored {
  band: (typeof BANDS)[number];
  score: number | null;
  warnings: Array<{ level: string; message: string }>;
  metrics: Record<string, Record<string, unknown>>;
}

@Injectable()
export class SupplierDashboardService {
  constructor(private readonly database: DatabaseService) {}

  get(ctx: RequestContext, q: z.infer<typeof SupplierDashboardQuery>): Promise<SupplierDashboard> {
    const org = ctx.organisationId!;
    const bucket: 'week' | 'month' = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 92 ? 'week' : 'month';
    return this.database.asUser(ctx, async (db) => {
      const one = async (query: ReturnType<typeof sql>) => (await db.execute<Row>(query)).rows[0] ?? {};
      const many = async (query: ReturnType<typeof sql>) => (await db.execute<Row>(query)).rows;
      const can = await one(sql`select app.has_permission_somewhere(${org}::uuid, 'ncr.read') as ncr, app.has_permission(${org}::uuid, 'receiving.read') as receiving`);

      const suppliers = await many(sql`
        select s.approval_status, s.risk_rating, count(*)::int as n from public.suppliers s
         where s.organisation_id = ${org}::uuid and s.active group by s.approval_status, s.risk_rating`);
      const live = suppliers.filter((r) => r.approval_status !== 'archived');
      const sum = (rows: Row[], f: (r: Row) => boolean) => rows.filter(f).reduce((t, r) => t + n(r.n), 0);

      const approvals = await many(sql`
        select d.id, d.target_status, d.proposed_at, nullif(trim(concat_ws(' ', p.first_name, p.surname)), '') as proposed_by,
               s.id as supplier_id, s.code as supplier_code, s.name as supplier_name, count(*) over ()::int as total
          from public.supplier_approval_decisions d join public.suppliers s on s.id = d.supplier_id
          left join public.profiles p on p.id = d.proposed_by
         where d.organisation_id = ${org}::uuid and d.status = 'proposed' order by d.proposed_at limit 8`);
      const reviews = await many(sql`
        select s.id as supplier_id, s.code as supplier_code, s.name as supplier_name, a.rating, a.review_on::text as review_on, (current_date - a.review_on)::int as days,
               count(*) over ()::int as total
          from public.supplier_risk_assessments a join public.suppliers s on s.id = a.supplier_id and ${sql.raw(LIVE)}
         where a.organisation_id = ${org}::uuid and a.status = 'current' and a.review_on < current_date order by a.review_on limit 8`);
      const exp = await one(sql`
        select count(*) filter (where expires_on < current_date)::int as expired,
               count(*) filter (where expires_on >= current_date and expires_on <= current_date + ${EXPIRY_WARNING_DAYS}::int)::int as expiring
          from (${EXPIRING(org)}) x`);
      const expiryList = await many(sql`
        select x.kind, x.id, x.title, x.expires_on::text as expires_on, (x.expires_on - current_date)::int as days, s.id as supplier_id, s.code as supplier_code, s.name as supplier_name
          from (${EXPIRING(org)}) x join public.suppliers s on s.id = x.supplier_id
         where x.expires_on <= current_date + ${EXPIRY_WARNING_DAYS}::int order by x.expires_on, lower(s.name) limit 10`);

      const scars = await many(sql`
        select c.status, count(*)::int as n, count(*) filter (where c.status in (${sql.raw(AWAITING)}) and c.response_due_on < current_date)::int as overdue
          from public.supplier_scars c where c.organisation_id = ${org}::uuid and c.status not in ('closed', 'cancelled') group by c.status`);
      const overdueScars = await many(sql`
        select c.id, c.reference, c.title, c.severity, c.response_due_on::text as due_on, (current_date - c.response_due_on)::int as days,
               s.id as supplier_id, s.code as supplier_code, s.name as supplier_name
          from public.supplier_scars c join public.suppliers s on s.id = c.supplier_id
         where c.organisation_id = ${org}::uuid and c.status in (${sql.raw(AWAITING)}) and c.response_due_on < current_date
         order by c.response_due_on, c.reference limit 8`);

      // Non-conformances naming a supplier as responsible (RLS shows them only to people who may read NCs).
      const NC = sql`from public.nonconformances nc where nc.organisation_id = ${org}::uuid and nc.supplier_id is not null and nc.deleted_at is null and nc.stage <> 'cancelled'`;
      const ncTotals = can.ncr
        ? await one(sql`select count(*) filter (where nc.stage <> 'closed')::int as open, count(*) filter (where nc.detected_at between ${q.from}::date and ${q.to}::date)::int as raised ${NC}`)
        : {};
      const ncTrend = can.ncr
        ? await many(sql`
            select to_char(date_trunc(${bucket}, nc.detected_at), 'YYYY-MM-DD') as start,
                   count(*) filter (where nc.severity = 'critical')::int as critical, count(*) filter (where nc.severity = 'major')::int as major,
                   count(*) filter (where nc.severity = 'minor')::int as minor, count(*) filter (where nc.severity is null)::int as unclassified
              ${NC} and nc.detected_at between ${q.from}::date and ${q.to}::date group by 1 order by 1`)
        : [];
      const ncBySupplier = can.ncr
        ? await many(sql`
            select s.id as supplier_id, s.code as supplier_code, s.name as supplier_name, count(*)::int as n, count(*) filter (where nc.severity = 'critical')::int as critical
              from public.nonconformances nc join public.suppliers s on s.id = nc.supplier_id
             where nc.organisation_id = ${org}::uuid and nc.deleted_at is null and nc.stage <> 'cancelled' and nc.detected_at between ${q.from}::date and ${q.to}::date
             group by s.id, s.code, s.name order by n desc, critical desc, lower(s.name) limit 8`)
        : [];

      const rec = can.receiving
        ? await one(sql`
            select count(*) filter (where l.received_on between ${q.from}::date and ${q.to}::date)::int as lines,
                   count(*) filter (where l.received_on between ${q.from}::date and ${q.to}::date and l.decision = 'rejected')::int as rejected,
                   count(*) filter (where l.required and (l.decision is null or l.decision = 'held'))::int as awaiting
              from (${LINES(org)}) l`)
        : {};
      const recTrend = can.receiving
        ? await many(sql`
            select to_char(date_trunc(${bucket}, l.received_on), 'YYYY-MM-DD') as start,
                   count(*) filter (where l.decision = 'rejected')::int as rejected,
                   count(*) filter (where l.decision in ('accepted', 'conditional') or (l.decision is null and not l.required))::int as accepted,
                   count(*) filter (where l.decision = 'held' or (l.decision is null and l.required))::int as undecided
              from (${LINES(org)}) l where l.received_on between ${q.from}::date and ${q.to}::date group by 1 order by 1`)
        : [];
      const recNow = can.receiving
        ? await one(sql`
            select (select count(*)::int from public.purchase_order_lines pl join public.purchase_orders o on o.id = pl.purchase_order_id
                     where o.organisation_id = ${org}::uuid and o.status = 'open' and pl.status = 'open' and coalesce(pl.agreed_on, pl.requested_on) < current_date
                       and pl.quantity_ordered > coalesce((select sum(rl.quantity_received) from public.goods_receipt_lines rl join public.goods_receipts g2 on g2.id = rl.goods_receipt_id
                                                            where rl.po_line_id = pl.id and g2.status = 'received'), 0)) as late,
                   (select count(*)::int from public.supplier_material_certificates m where m.organisation_id = ${org}::uuid and m.status = 'received') as certs`)
        : {};

      // Performance: the database scores each supplier (so the dashboard, the Performance tab, a scorecard and the watchlist cannot disagree); this only adds them up.
      const scored: Array<Scored & { ref: ReturnType<typeof supplierRef> }> = [];
      let truncated = false;
      if (can.receiving) {
        const list = await many(sql`
          select s.id as supplier_id, s.code as supplier_code, s.name as supplier_name from public.suppliers s
           where s.organisation_id = ${org}::uuid and ${sql.raw(LIVE)} order by s.code limit ${PERFORMANCE_SUPPLIER_LIMIT + 1}`);
        truncated = list.length > PERFORMANCE_SUPPLIER_LIMIT;
        for (const s of list.slice(0, PERFORMANCE_SUPPLIER_LIMIT)) {
          const r = (await db.execute<{ r: Scored }>(sql`select app.supplier_performance(${s.supplier_id as string}::uuid, ${q.from}::date, ${q.to}::date) as r`)).rows[0].r;
          scored.push({ ...r, score: r.score === null || r.score === undefined ? null : Number(r.score), ref: supplierRef(s) });
        }
      }
      const total = (metric: string, key: string) => scored.reduce((t, r) => t + n(r.metrics?.[metric]?.[key]), 0);
      const flagged = (r: Scored) => r.warnings.filter((w) => w.level !== 'info');
      const bandOrder = { poor: 0, watch: 1, insufficient: 2, good: 3 } as const;
      const attention = scored
        .filter((r) => r.band === 'poor' || r.band === 'watch' || flagged(r).length > 0)
        .sort((a, b) => bandOrder[a.band] - bandOrder[b.band] || (a.score ?? 101) - (b.score ?? 101) || flagged(b).length - flagged(a).length || a.ref.code.localeCompare(b.ref.code))
        .slice(0, 8);
      const inFullJudged = total('inFull', 'lines') - total('inFull', 'pending');
      const received = total('ppm', 'receivedUnits');

      const lines = n(rec.lines);
      return {
        period: { from: q.from, to: q.to, bucket },
        kpis: {
          suppliers: sum(live, () => true),
          approved: sum(live, (r) => r.approval_status === 'approved'),
          pendingApproval: sum(live, (r) => r.approval_status === 'pending_approval'),
          approvalsWaiting: n(approvals[0]?.total),
          highRisk: sum(live, (r) => r.risk_rating === 'high' || r.risk_rating === 'critical'),
          riskNotAssessed: sum(live, (r) => !r.risk_rating),
          riskReviewsOverdue: n(reviews[0]?.total),
          expired: n(exp.expired),
          expiring: n(exp.expiring),
          openScars: scars.reduce((t, r) => t + n(r.n), 0),
          overdueScars: scars.reduce((t, r) => t + n(r.overdue), 0),
        },
        byStatus: STATUSES.map((key) => ({ key, count: sum(suppliers, (r) => r.approval_status === key) })),
        byRisk: RISKS.map((key) => ({ key, count: sum(live, (r) => (key === 'none' ? !r.risk_rating : r.risk_rating === key)) })),
        scarsByStatus: RUNNING_SCAR.map((key) => ({ key, count: n(scars.find((r) => r.status === key)?.n) })),
        ncs: {
          available: !!can.ncr,
          open: n(ncTotals.open),
          raised: n(ncTotals.raised),
          trend: ncTrend.map((r) => ({ start: r.start as string, critical: n(r.critical), major: n(r.major), minor: n(r.minor), unclassified: n(r.unclassified) })),
          bySupplier: ncBySupplier.map((r) => ({ ...supplierRef(r), count: n(r.n), critical: n(r.critical) })),
        },
        receiving: {
          available: !!can.receiving,
          lines,
          rejectedLines: n(rec.rejected),
          lotRejectionPercent: pct(n(rec.rejected), lines),
          awaitingDecision: n(rec.awaiting),
          lateOrderLines: n(recNow.late),
          certificatesToReview: n(recNow.certs),
          trend: recTrend.map((r) => ({ start: r.start as string, accepted: n(r.accepted), rejected: n(r.rejected), undecided: n(r.undecided) })),
        },
        performance: {
          available: !!can.receiving,
          scored: scored.length,
          truncated,
          bands: BANDS.map((key) => ({ key, count: scored.filter((r) => r.band === key).length })),
          otdPercent: pct(total('otd', 'onTime'), total('otd', 'matchedLines')),
          onTimeLines: total('otd', 'onTime'),
          matchedLines: total('otd', 'matchedLines'),
          ppm: received > 0 ? Math.round((total('ppm', 'rejectedUnits') / received) * 1_000_000) : null,
          rejectedUnits: total('ppm', 'rejectedUnits'),
          receivedUnits: received,
          inFullPercent: pct(total('inFull', 'inFull'), inFullJudged),
          attention: attention.map((r) => ({ ...r.ref, band: r.band, score: r.score, warnings: flagged(r).length, reason: flagged(r)[0]?.message ?? null })),
        },
        overdueScarList: overdueScars.map((r) => ({
          id: r.id as string, reference: r.reference as string, title: r.title as string, severity: r.severity as string, supplier: supplierRef(r), dueOn: day(r.due_on) as string, daysOverdue: n(r.days),
        })),
        approvalList: approvals.map((r) => ({
          id: r.id as string, supplier: supplierRef(r), target: r.target_status as 'approved' | 'conditional', proposedAt: new Date(r.proposed_at as string).toISOString(), proposedBy: (r.proposed_by as string) ?? null,
        })),
        expiryList: expiryList.map((r) => ({
          kind: r.kind as 'certification' | 'document', id: r.id as string, supplier: supplierRef(r), title: r.title as string, expiresOn: day(r.expires_on) as string, days: n(r.days),
        })),
        riskReviewList: reviews.map((r) => ({ supplier: supplierRef(r), rating: r.rating as string, reviewOn: day(r.review_on) as string, daysOverdue: n(r.days) })),
      };
    });
  }
}

/**
 * Supplier quality dashboard: the supplier base as of today (approval, risk, expiring records, corrective action requests), and the period's
 * non-conformances, deliveries and performance. Read as the caller; sections the caller may not read say `available: false`.
 */
@ApiTags('supplier-quality')
@ApiBearerAuth()
@Controller('supplier-quality/dashboard')
export class SupplierDashboardController {
  constructor(private readonly service: SupplierDashboardService) {}

  @Get()
  @OrganisationScoped('supplier_quality.read')
  @ApiQuery({ name: 'from', required: true, description: 'From (YYYY-MM-DD)' })
  @ApiQuery({ name: 'to', required: true, description: 'To (YYYY-MM-DD)' })
  @ApiOkResponse({ schema: openApiSchema(SupplierDashboard) })
  get(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.get(ctx, parse(SupplierDashboardQuery, query));
  }
}
