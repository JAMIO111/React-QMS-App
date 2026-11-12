import { Controller, Get, Injectable } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { REC_JOIN, STATE_SQL } from '../audits/audit-schedule.service';
import { IN_USE } from '../calibration/calibration.service';
import { RUNNING } from '../capa/capa.service';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema } from '../common/validation';
import { CELLS, EXPIRING as COMPETENCE_EXPIRING } from '../competence/competence-dashboard';
import { DatabaseService } from '../database/database.service';
import { dataQualityChecks } from '../master-data/master-data-dashboard';
import { UNHANDLED_FAILURE } from '../process-control/process-control-dashboard';
import { EXPIRY_WARNING_DAYS } from '../supplier-quality/expiry';
import { AWAITING, EXPIRING as SUPPLIER_EXPIRING, LINES, LIVE } from '../supplier-quality/supplier-dashboard';
import { OrganisationScoped } from '../tenancy/organisation.guard';

/** The audits card looks back this many days for missed audits, as the audits dashboard does when it opens (its default period). */
export const HOME_AUDIT_DAYS = 90;

const count = z.number().int();
export const HomeDashboard = z.object({
  /** Today in the caller's time zone: every "overdue" and "due soon" is measured from it. */
  asOf: z.string(),
  /** Each area is `null` when the caller may not read it (the same rule as that area's own dashboard). */
  nc: z.object({ open: count, criticalOpen: count, awaitingClosure: count }).nullable(),
  capa: z.object({ running: count, overdue: count, awaitingVerification: count }).nullable(),
  calibration: z.object({ inUse: count, overdue: count, quarantined: count, dueNext30: count }).nullable(),
  /** `openSpcAlerts` is `null` without `spc.read`. */
  processControl: z.object({ inProgress: count, openFailures: count, awaitingApproval: count, openSpcAlerts: count.nullable() }).nullable(),
  audits: z.object({ openFindings: count, overdueFindings: count, overdue: count, missed: count, days: count }).nullable(),
  documents: z.object({ inForce: count, reviewsOverdue: count, readersOverdue: count, inReview: count, awaitingApproval: count, changeRequestsOpen: count }).nullable(),
  /** `receiving` is `null` without `receiving.read`. */
  supplier: z
    .object({
      suppliers: count,
      overdueScars: count,
      expired: count,
      expiring: count,
      approvalsWaiting: count,
      riskReviewsOverdue: count,
      receiving: z.object({ awaitingDecision: count, lateOrderLines: count }).nullable(),
    })
    .nullable(),
  competence: z.object({ withGaps: count, gaps: count, expired: count, expiring30: count, neverAssessed: count }).nullable(),
  masterData: z.object({ checks: z.array(z.object({ key: z.string(), label: z.string(), kind: z.string(), count })) }).nullable(),
});
export type HomeDashboard = z.infer<typeof HomeDashboard>;

type Row = Record<string, unknown>;
const n = (v: unknown) => Number(v ?? 0);

/**
 * The home page's figures: for every area the caller may read, what needs attention as of today. One request and a handful of small counts,
 * instead of every area's full dashboard (charts, lists, supplier scoring). Each count uses the same rule as that area's dashboard (the shared
 * SQL fragments imported above), and `home-dashboard.e2e-spec.ts` checks the two agree. Read as the caller, so RLS limits the rows as it does there.
 */
@Injectable()
export class HomeDashboardService {
  constructor(private readonly database: DatabaseService) {}

  get(ctx: RequestContext): Promise<HomeDashboard> {
    const org = ctx.organisationId!;
    return this.database.asUser(ctx, async (db) => {
      const many = async (query: ReturnType<typeof sql>) => (await db.execute<Row>(query)).rows;
      const one = async (query: ReturnType<typeof sql>) => (await many(query))[0] ?? {};

      // The same checks the areas' own routes make: any scope where the dashboard admits any scope, organisation-wide otherwise.
      const can = await one(sql`
        select to_char(current_date, 'YYYY-MM-DD') as today,
               app.has_permission_somewhere(${org}::uuid, 'ncr.read') as nc,
               app.has_permission(${org}::uuid, 'capa.read') as capa,
               app.has_permission_somewhere(${org}::uuid, 'calibration.read') as calibration,
               app.has_permission_somewhere(${org}::uuid, 'process_control.read') as process_control,
               app.has_permission(${org}::uuid, 'spc.read') as spc,
               app.has_permission(${org}::uuid, 'audits.read') as audits,
               app.has_permission(${org}::uuid, 'documentation.read') as documents,
               app.has_permission(${org}::uuid, 'supplier_quality.read') as supplier,
               app.has_permission(${org}::uuid, 'receiving.read') as receiving,
               app.has_permission(${org}::uuid, 'competence.read') as competence,
               app.has_permission(${org}::uuid, 'master_data.read') as master_data`);

      const nc = async () => {
        const r = await one(sql`
          select count(*) filter (where n.stage <> all(array['closed','cancelled']))::int as open,
                 count(*) filter (where n.stage <> all(array['closed','cancelled']) and n.severity = 'critical')::int as critical_open,
                 count(*) filter (where n.stage = 'awaiting_closure')::int as awaiting_closure
            from public.nonconformances n where n.organisation_id = ${org}::uuid and n.deleted_at is null`);
        return { open: n(r.open), criticalOpen: n(r.critical_open), awaitingClosure: n(r.awaiting_closure) };
      };

      const capa = async () => {
        const r = await one(sql`
          select count(*) filter (where ${RUNNING})::int as running,
                 count(*) filter (where c.due_date is not null and c.due_date < current_date and ${RUNNING})::int as overdue,
                 count(*) filter (where c.stage = 'awaiting_verification')::int as awaiting_verification
            from public.capas c where c.organisation_id = ${org}::uuid`);
        return { running: n(r.running), overdue: n(r.overdue), awaitingVerification: n(r.awaiting_verification) };
      };

      const calibration = async () => {
        const r = await one(sql`
          select count(*) filter (where ${sql.raw(IN_USE)})::int as in_use,
                 count(*) filter (where ${sql.raw(IN_USE)} and g.next_due_on < current_date)::int as overdue,
                 count(*) filter (where ${sql.raw(IN_USE)} and g.next_due_on between current_date and current_date + 30)::int as due_30,
                 count(*) filter (where g.status = 'quarantined')::int as quarantined
            from public.gauges g where g.organisation_id = ${org}::uuid and g.deleted_at is null`);
        return { inUse: n(r.in_use), overdue: n(r.overdue), quarantined: n(r.quarantined), dueNext30: n(r.due_30) };
      };

      const processControl = async () => {
        const r = await one(sql`
          select (select count(*) from public.control_plan_revisions r where r.organisation_id = ${org}::uuid and r.status = 'pending_approval')::int as awaiting,
                 (select count(*) from public.inspection_records r where r.organisation_id = ${org}::uuid and r.status = 'in_progress')::int as in_progress,
                 (select count(*) from public.inspection_measurements m where m.organisation_id = ${org}::uuid and ${UNHANDLED_FAILURE})::int as open_failures`);
        const alerts = can.spc ? await one(sql`select count(*)::int as n from public.spc_alerts where organisation_id = ${org}::uuid and status = 'open'`) : null;
        return { inProgress: n(r.in_progress), openFailures: n(r.open_failures), awaitingApproval: n(r.awaiting), openSpcAlerts: alerts ? n(alerts.n) : null };
      };

      const audits = async () => {
        // Slots are made when someone looks (no worker), as on the audits dashboard.
        await db.execute(sql`select app.generate_audit_occurrences(${org}::uuid, current_date)`);
        const state = sql.raw(STATE_SQL);
        const slots = await one(sql`
          select count(*) filter (where ${state} = 'overdue')::int as overdue, count(*) filter (where ${state} = 'missed')::int as missed
            from public.audit_occurrences o join public.audit_definitions d on d.id = o.audit_definition_id ${sql.raw(REC_JOIN)}
           where o.organisation_id = ${org}::uuid and o.due_on between current_date - ${HOME_AUDIT_DAYS - 1}::int and current_date`);
        const findings = await one(sql`
          select count(*) filter (where f.status = 'open')::int as open_now, count(*) filter (where f.status = 'open' and f.due_on < current_date)::int as overdue_now
            from public.audit_findings f where f.organisation_id = ${org}::uuid`);
        return { openFindings: n(findings.open_now), overdueFindings: n(findings.overdue_now), overdue: n(slots.overdue), missed: n(slots.missed), days: HOME_AUDIT_DAYS };
      };

      const documents = async () => {
        // Revisions take effect when someone looks (no worker), as on every documents read.
        await db.execute(sql`select app.settle_documents(${org}::uuid)`);
        const r = await one(sql`
          select (select count(*) from public.documents where organisation_id = ${org}::uuid and status = 'active')::int as in_force,
                 (select count(*) from public.documents where organisation_id = ${org}::uuid and status = 'active' and next_review_on < current_date)::int as reviews_overdue,
                 (select count(*) from public.document_revisions where organisation_id = ${org}::uuid and status = 'in_review')::int as in_review,
                 (select count(*) from public.document_revisions where organisation_id = ${org}::uuid and status = 'awaiting_approval')::int as awaiting,
                 (select count(*) from public.document_recipients x join public.documents d on d.current_revision_id = x.revision_id and d.status = 'active'
                   where x.organisation_id = ${org}::uuid and x.acknowledged_at is null and x.due_on < current_date)::int as readers_overdue,
                 (select count(*) from public.document_change_requests where organisation_id = ${org}::uuid and status = 'open')::int as changes_open`);
        return { inForce: n(r.in_force), reviewsOverdue: n(r.reviews_overdue), readersOverdue: n(r.readers_overdue), inReview: n(r.in_review), awaitingApproval: n(r.awaiting), changeRequestsOpen: n(r.changes_open) };
      };

      const supplier = async () => {
        const r = await one(sql`
          select (select count(*) from public.suppliers s where s.organisation_id = ${org}::uuid and ${sql.raw(LIVE)})::int as suppliers,
                 (select count(*) from public.supplier_approval_decisions d join public.suppliers s on s.id = d.supplier_id
                   where d.organisation_id = ${org}::uuid and d.status = 'proposed')::int as approvals,
                 (select count(*) from public.supplier_risk_assessments a join public.suppliers s on s.id = a.supplier_id and ${sql.raw(LIVE)}
                   where a.organisation_id = ${org}::uuid and a.status = 'current' and a.review_on < current_date)::int as reviews,
                 (select count(*) from public.supplier_scars c
                   where c.organisation_id = ${org}::uuid and c.status in (${sql.raw(AWAITING)}) and c.response_due_on < current_date)::int as overdue_scars`);
        const exp = await one(sql`
          select count(*) filter (where expires_on < current_date)::int as expired,
                 count(*) filter (where expires_on >= current_date and expires_on <= current_date + ${EXPIRY_WARNING_DAYS}::int)::int as expiring
            from (${SUPPLIER_EXPIRING(org)}) x`);
        const rec = can.receiving
          ? await one(sql`
              select (select count(*) from (${LINES(org)}) l where l.required and (l.decision is null or l.decision = 'held'))::int as awaiting,
                     (select count(*) from public.purchase_order_lines pl join public.purchase_orders o on o.id = pl.purchase_order_id
                       where o.organisation_id = ${org}::uuid and o.status = 'open' and pl.status = 'open' and coalesce(pl.agreed_on, pl.requested_on) < current_date
                         and pl.quantity_ordered > coalesce((select sum(rl.quantity_received) from public.goods_receipt_lines rl join public.goods_receipts g2 on g2.id = rl.goods_receipt_id
                                                              where rl.po_line_id = pl.id and g2.status = 'received'), 0))::int as late`)
          : null;
        return {
          suppliers: n(r.suppliers),
          overdueScars: n(r.overdue_scars),
          expired: n(exp.expired),
          expiring: n(exp.expiring),
          approvalsWaiting: n(r.approvals),
          riskReviewsOverdue: n(r.reviews),
          receiving: rec ? { awaitingDecision: n(rec.awaiting), lateOrderLines: n(rec.late) } : null,
        };
      };

      const competence = async () => {
        const people = await one(sql`
          select count(*) filter (where not exists (select 1 from public.competence_assessments a where a.employee_id = e.id))::int as never_assessed
            from public."Employees" e where e.organisation_id = ${org}::uuid and e.active`);
        const gaps = await one(sql`select count(*) filter (where gap > 0)::int as gaps, count(distinct employee_id) filter (where gap > 0)::int as people from (${CELLS(org)}) c`);
        const exp = await one(sql`
          select count(*) filter (where expires_on < current_date)::int as expired,
                 count(*) filter (where expires_on >= current_date and expires_on <= current_date + 30)::int as d30
            from (${COMPETENCE_EXPIRING(org)}) x`);
        return { withGaps: n(gaps.people), gaps: n(gaps.gaps), expired: n(exp.expired), expiring30: n(exp.d30), neverAssessed: n(people.never_assessed) };
      };

      return {
        asOf: String(can.today),
        nc: can.nc ? await nc() : null,
        capa: can.capa ? await capa() : null,
        calibration: can.calibration ? await calibration() : null,
        processControl: can.process_control ? await processControl() : null,
        audits: can.audits ? await audits() : null,
        documents: can.documents ? await documents() : null,
        supplier: can.supplier ? await supplier() : null,
        competence: can.competence ? await competence() : null,
        masterData: can.master_data ? { checks: await dataQualityChecks(many, org) } : null,
      };
    });
  }
}

@ApiTags('home')
@ApiBearerAuth()
@Controller('home-dashboard')
export class HomeDashboardController {
  constructor(private readonly service: HomeDashboardService) {}

  /** What needs attention, as of today, in every area the caller may read (areas they may not read are `null`). Any member may ask. */
  @Get()
  @OrganisationScoped()
  @ApiOkResponse({ schema: openApiSchema(HomeDashboard) })
  get(@Ctx() ctx: RequestContext) {
    return this.service.get(ctx);
  }
}
