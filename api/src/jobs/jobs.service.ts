import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { iso, num, personName, Row } from '../calibration/calibration.service';
import { DatabaseService, Db } from '../database/database.service';
import { InspectionService } from '../inspection/inspection.service';
import { JobDetailsBody, JobNcrs, JobPreview, JobQuery, JobRevisions, RecentQuery, StartJobBody, JobLinksBody } from './jobs.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;

interface ResolverRequirement {
  operationCode: string;
  applicable?: boolean;
  sampling?: { triggerType: string }[];
}
interface Resolver {
  status: 'ok' | 'blocked';
  problems: { code: string; message: string }[];
  partRevision: { id: string; revision: string } | null;
  planRevision: { id: string; revisionCode: string } | null;
  plan: { planCode: string } | null;
  requirements: ResolverRequirement[];
}

/** The trigger the job itself starts with: the plan's first-off, else its first sampling rule, else manual (as the Start inspection page does). */
export const startTrigger = (requirements: ResolverRequirement[]) => {
  const planned = requirements.filter((q) => q.applicable !== false).flatMap((q) => (q.sampling ?? []).map((s) => s.triggerType));
  return planned.includes('first_off') ? 'first_off' : (planned[0] ?? 'manual');
};
export const needsLotSize = (requirements: ResolverRequirement[]) =>
  requirements.some((q) => q.applicable !== false && (q.sampling ?? []).some((s) => s.triggerType === 'every_n_parts'));

/**
 * Operator jobs (docs/operator-hub-plan.md). A job is an in-progress inspection record: starting one runs the same database function as the Start
 * inspection page (resolver, frozen requirements, sampling, gauges, NC raising and SPC alerts all keep working). What is new is only what the operator
 * is asked (a machine and a part), what is worked out for them (site, operation, trigger), what can be filled in later (work order, lot, quantity) and
 * the read-only context for the hub: recent non-conformances and recent revisions.
 */
@Injectable()
export class JobsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly inspections: InspectionService,
  ) {}

  preview(ctx: RequestContext, q: JobQuery): Promise<JobPreview> {
    return this.database.asUser(ctx, async (db) => (await this.work(db, ctx, q)).preview);
  }

  /** Starts the job; refuses with the resolver's own reasons when the part cannot be inspected on this machine. */
  start(ctx: RequestContext, body: StartJobBody) {
    return this.database.asUser(ctx, async (db) => {
      const w = await this.work(db, ctx, body);
      const p = w.preview;
      if (!p.site) throw ApiError.badRequest('site_required', p.siteProblem ?? 'This machine has no site');
      if (p.needsOperation) throw ApiError.badRequest('operation_required', 'Choose the operation');
      if (body.operationCode && !p.operations.some((o) => o.code.toLowerCase() === body.operationCode!.toLowerCase())) {
        throw ApiError.badRequest('invalid_operation', 'That operation is not in the plan for this part');
      }
      if (p.needsLotSize && !body.lotSize) throw ApiError.badRequest('lot_size_required', 'Enter the quantity: some checks are sampled every N parts');
      const result = await db.execute<{ id: string }>(sql`select app.start_inspection(
        ${p.site.id}::uuid, ${body.partId}::uuid, ${p.operationCode}, ${body.machineId}::uuid, NULL, NULL, NULL, ${startTrigger(w.resolver.requirements)},
        NULL, NULL, ${body.lotSize ?? null}::integer) as id`);
      if (body.productionOrderId) await db.execute(sql`select app.set_job_links(${result.rows[0].id}::uuid, ${JSON.stringify({ productionOrderId: body.productionOrderId })}::jsonb)`);
      return result.rows[0].id;
    }).then((id) => this.inspections.get(ctx, id));
  }

  /** The caller's running jobs, newest first. */
  mine(ctx: RequestContext) {
    return this.inspections.list(ctx, { status: ['in_progress'], result: [], trigger: [], mine: true, sort: 'startedAt', order: 'desc', page: 1, pageSize: 20 });
  }

  /** Work order, lot, quantity and serial, while the job runs. */
  async details(ctx: RequestContext, id: string, body: JobDetailsBody) {
    await this.database.asUser(ctx, async (db) => {
      await this.job(db, ctx, id);
      await db.execute(sql`select app.set_job_details(${id}::uuid, ${body.workOrder === undefined ? null : (body.workOrder ?? '')}, ${body.lot === undefined ? null : (body.lot ?? '')},
        ${body.lotSize ?? null}::integer, ${body.serial === undefined ? null : (body.serial ?? '')})`);
    });
    return this.inspections.get(ctx, id);
  }

  /** The production order, lot and serial number of a running job (needs production.read for what is linked). */
  async links(ctx: RequestContext, id: string, body: JobLinksBody) {
    await this.database.asUser(ctx, async (db) => {
      await this.job(db, ctx, id);
      await db.execute(sql`select app.set_job_links(${id}::uuid, ${JSON.stringify(body)}::jsonb)`);
    });
    return this.inspections.get(ctx, id);
  }

  recentNcrs(ctx: RequestContext, id: string, q: RecentQuery): Promise<JobNcrs> {
    return this.database.asUser(ctx, async (db) => {
      const job = await this.job(db, ctx, id);
      const can = await db.execute<{ ok: boolean }>(sql`select app.has_permission(${orgOf(ctx)}::uuid, 'ncr.read', ${job.site_id}::uuid) as ok`);
      if (!can.rows[0].ok) return { canRead: false, days: q.days, data: [] };
      const rows = await db.execute<Row>(sql`
        select n.id, n.reference, n.stage, n.source, n.severity, n.title, to_char(n.detected_at, 'YYYY-MM-DD') as detected_at, n.quantity_affected, n.part_id, p.part_number,
               (n.part_id = ${job.part_id}::uuid) as m_part,
               (n.part_id <> ${job.part_id}::uuid and p.part_family_id is not null and p.part_family_id = (select part_family_id from public.parts where id = ${job.part_id}::uuid)) as m_family,
               exists (select 1 from public.inspection_ncr_links l join public.inspection_records i on i.id = l.inspection_record_id
                        where l.nonconformance_id = n.id and ${job.machine_id}::uuid is not null and i.machine_id = ${job.machine_id}::uuid) as m_machine,
               exists (select 1 from public.inspection_ncr_links l join public.inspection_records i on i.id = l.inspection_record_id
                        where l.nonconformance_id = n.id and ${job.operation_code}::text is not null and i.operation_code = ${job.operation_code}::text) as m_operation,
               (n.stage not in ('closed', 'cancelled')) as is_open,
               (select string_agg(distinct q.name, ', ') from public.inspection_ncr_links l
                  join public.inspection_measurements m on m.id = l.measurement_id join public.resolved_inspection_requirements q on q.id = m.requirement_id
                 where l.nonconformance_id = n.id) as characteristics
          from public.nonconformances n
          left join public.parts p on p.id = n.part_id
         where n.organisation_id = ${orgOf(ctx)}::uuid and n.deleted_at is null and n.stage not in ('draft', 'cancelled')
           and (n.stage <> 'closed' or n.detected_at >= current_date - ${q.days}::integer)
           and (n.detected_at >= current_date - ${q.days}::integer or n.stage <> 'closed')
         order by (n.stage in ('closed')) asc, n.detected_at desc, n.reference desc`);
      const data = rows.rows
        .map((r) => {
          const matched = [r.m_part && 'part', r.m_family && 'family', r.m_machine && 'machine', r.m_operation && 'operation'].filter(Boolean) as JobNcrs['data'][number]['matched'];
          return { r, matched };
        })
        .filter((x) => x.matched.length > 0)
        .slice(0, 20)
        .map(({ r, matched }) => ({
          id: r.id as string,
          reference: r.reference as string,
          stage: r.stage as string,
          source: r.source as string,
          severity: (r.severity as JobNcrs['data'][number]['severity']) ?? null,
          title: r.title as string,
          detectedAt: r.detected_at as string,
          quantityAffected: num(r.quantity_affected),
          part: r.part_id ? { id: r.part_id as string, partNumber: r.part_number as string } : null,
          matched,
          open: r.is_open as boolean,
          characteristics: r.characteristics ? (r.characteristics as string).split(', ') : [],
        }));
      return { canRead: true, days: q.days, data };
    });
  }

  revisions(ctx: RequestContext, id: string, q: RecentQuery): Promise<JobRevisions> {
    return this.database.asUser(ctx, async (db) => {
      const job = await this.job(db, ctx, id);
      const prev = await db.execute<{ at: string | null }>(sql`select max(started_at) as at from public.inspection_records
        where organisation_id = ${orgOf(ctx)}::uuid and part_id = ${job.part_id}::uuid and created_by = ${ctx.user.id}::uuid and id <> ${id}::uuid and started_at < ${job.started_at}::timestamptz`);
      const previous = prev.rows[0].at ? new Date(prev.rows[0].at).getTime() : null;
      const weekAgo = Date.now() - 7 * 86400_000;
      const isNew = (at: string) => (previous === null ? new Date(at).getTime() >= weekAgo : new Date(at).getTime() > previous);

      const parts = await db.execute<Row>(sql`
        select r.id, r.revision, r.version, r.corrects_id, r.correction_reason, r.change_summary, r.released_at as at, r.status, ${sql.raw(personName('pr'))} as by_name, p.part_number
          from public.part_revisions r join public.parts p on p.id = r.part_id left join public.profiles pr on pr.id = r.released_by
         where r.organisation_id = ${orgOf(ctx)}::uuid and r.part_id = ${job.part_id}::uuid and r.status in ('released', 'superseded')
           and (r.status = 'released' or r.released_at >= now() - make_interval(days => ${q.days}::integer))
         order by r.released_at desc`);
      const plans = await db.execute<Row>(sql`
        select r.id, r.revision_code, r.change_reason, r.effective_from as at, r.status, ${sql.raw(personName('pr'))} as by_name, c.plan_code
          from public.control_plan_revisions r join public.control_plans c on c.id = r.control_plan_id left join public.profiles pr on pr.id = r.approved_by
         where r.organisation_id = ${orgOf(ctx)}::uuid and r.control_plan_id = ${job.control_plan_id}::uuid and r.status in ('effective', 'superseded') and r.effective_from is not null
           and (r.status = 'effective' or r.effective_from >= now() - make_interval(days => ${q.days}::integer))
         order by r.effective_from desc`);
      const data = [
        ...parts.rows.map((r) => ({
          kind: 'part_revision' as const,
          id: r.id as string,
          revision: r.revision as string,
          version: Number(r.version),
          subject: r.part_number as string,
          changeSummary: r.corrects_id ? `Correction: ${r.correction_reason as string}` : ((r.change_summary as string) ?? null),
          at: iso(r.at)!,
          by: (r.by_name as string) ?? null,
          isNew: isNew(iso(r.at)!),
          current: r.status === 'released',
          runningOnIt: r.id === job.part_revision_id,
        })),
        ...plans.rows.map((r) => ({
          kind: 'plan_revision' as const,
          id: r.id as string,
          revision: r.revision_code as string,
          version: 1,
          subject: r.plan_code as string,
          changeSummary: (r.change_reason as string) ?? null,
          at: iso(r.at)!,
          by: (r.by_name as string) ?? null,
          isNew: isNew(iso(r.at)!),
          current: r.status === 'effective',
          runningOnIt: r.id === job.control_plan_revision_id,
        })),
      ].sort((a, b) => b.at.localeCompare(a.at));
      return {
        days: q.days,
        partRevisionSuperseded: parts.rows.some((r) => r.status === 'released' && r.id !== job.part_revision_id),
        planRevisionSuperseded: plans.rows.some((r) => r.status === 'effective' && r.id !== job.control_plan_revision_id),
        data,
      };
    });
  }

  // ---- internals ---------------------------------------------------------------------------

  private async job(db: Db, ctx: RequestContext, id: string): Promise<Row> {
    const r = await db.execute<Row>(sql`select id, site_id, part_id, machine_id, operation_code, part_revision_id, control_plan_id, control_plan_revision_id, started_at, status
      from public.inspection_records where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
    if (!r.rows.length) throw ApiError.notFound('inspection_not_found', 'Job not found');
    return r.rows[0];
  }

  /** The machine, the part, the site and operation that would be used, and the resolver's verdict. */
  private async work(db: Db, ctx: RequestContext, q: JobQuery): Promise<{ preview: JobPreview; resolver: Resolver }> {
    const machine = q.machineId
      ? (await db.execute<Row>(sql`select id, code, name, site_id from public.machines where id = ${q.machineId}::uuid and organisation_id = ${orgOf(ctx)}::uuid and active`)).rows[0]
      : null;
    if (q.machineId && !machine) throw ApiError.notFound('machine_not_found', 'Machine not found');
    const part = (await db.execute<Row>(sql`select id, part_number, name from public.parts where id = ${q.partId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`)).rows[0];
    if (!part) throw ApiError.notFound('part_not_found', 'Part not found');

    let site: { id: string; name: string } | null = null;
    let siteProblem: string | null = null;
    if (machine?.site_id) {
      const s = (await db.execute<Row>(sql`select id, name from public.sites where id = ${machine.site_id as string}::uuid and organisation_id = ${orgOf(ctx)}::uuid`)).rows[0];
      site = s ? { id: s.id as string, name: s.name as string } : null;
    } else {
      const only = (await db.execute<Row>(sql`select id, name from public.sites where organisation_id = ${orgOf(ctx)}::uuid and active`)).rows;
      if (only.length === 1) site = { id: only[0].id as string, name: only[0].name as string };
      else if (machine) siteProblem = `${machine.code} has no site. Ask a manager to set the machine's site.`;
    }

    const resolve = async (op: string | null) =>
      (await db.execute<{ r: Resolver }>(sql`select app.resolve_inspection_requirements(${q.partId}::uuid, ${op}, ${site?.id ?? null}::uuid, NULL) as r`)).rows[0].r;
    let resolver = await resolve(q.operationCode ?? null);
    const codes = [...new Set(resolver.requirements.filter((r) => r.applicable !== false).map((r) => r.operationCode))];
    const names = resolver.planRevision
      ? (await db.execute<Row>(sql`select operation_code, name from public.control_plan_operations where control_plan_revision_id = ${resolver.planRevision.id}::uuid order by sequence`)).rows
      : [];
    const operations = codes.map((c) => ({ code: c, name: (names.find((n) => (n.operation_code as string).toLowerCase() === c.toLowerCase())?.name as string) ?? c }));
    let operationCode = q.operationCode ?? (operations.length === 1 ? operations[0].code : null);
    if (operationCode && !q.operationCode) resolver = await resolve(operationCode);
    const needsOperation = operations.length > 1 && !q.operationCode;
    if (needsOperation) operationCode = null;

    return {
      resolver,
      preview: {
        machine: machine ? { id: machine.id as string, code: machine.code as string, name: machine.name as string } : null,
        part: { id: part.id as string, partNumber: part.part_number as string, name: part.name as string },
        site,
        siteProblem,
        status: resolver.status,
        problems: resolver.problems.map((p) => ({ code: p.code, message: p.message })),
        operations,
        needsOperation,
        operationCode,
        needsLotSize: needsLotSize(resolver.requirements),
        partRevision: resolver.partRevision?.revision ?? null,
        plan: resolver.plan && resolver.planRevision ? { planCode: resolver.plan.planCode, revisionCode: resolver.planRevision.revisionCode } : null,
        requirementCount: resolver.requirements.filter((r) => r.applicable !== false).length,
      },
    };
  }
}
