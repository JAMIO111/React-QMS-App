import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { controlCoverage, criticalitySuggestion, groupPlanCover, PlanCover } from './fmea-coverage';
import { CarryToPlanBody, PlanCharacteristicsQuery } from './fmea.schemas';
import { FmeaService, LINK_SELECT, toControlLink } from './fmea.service';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const json = (v: unknown) => JSON.stringify(v);
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

/**
 * FMEA (FM5a): carrying a cause's control to a control plan characteristic, the coverage report, and the other side (what an FMEA says about a plan characteristic). Every write
 * is a database function; the rest is read as the caller, so a revision or a plan they may not read is simply not there. Information only.
 */
@Injectable()
export class FmeaControlsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly fmea: FmeaService,
  ) {}

  private async revisionOf(db: Db, ctx: RequestContext, table: 'fmea_causes' | 'fmea_control_links', id: string): Promise<string> {
    const row = (await db.execute<Row>(sql`select revision_id from public.${sql.raw(table)} where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`)).rows[0];
    if (!row) throw ApiError.notFound('fmea_not_found', 'Not found');
    return row.revision_id as string;
  }

  /** Carries a control of a cause to a plan characteristic. Answers with the whole revision. */
  carry(ctx: RequestContext, causeId: string, body: CarryToPlanBody) {
    return this.database.asUser(ctx, async (db) => {
      const revisionId = await this.revisionOf(db, ctx, 'fmea_causes', causeId);
      await db.execute(sql`select app.carry_fmea_cause_to_plan(${causeId}::uuid, ${json(body)}::jsonb)`);
      return this.fmea.revision(db, ctx, revisionId);
    });
  }

  /** Ends a carried control, with the reason. Answers with the whole revision. */
  end(ctx: RequestContext, linkId: string, reason: string) {
    return this.database.asUser(ctx, async (db) => {
      const revisionId = await this.revisionOf(db, ctx, 'fmea_control_links', linkId);
      await db.execute(sql`select app.end_fmea_control_link(${linkId}::uuid, ${reason})`);
      return this.fmea.revision(db, ctx, revisionId);
    });
  }

  /**
   * The characteristics a control can be carried to: those of active control plans (the revision in force first, else the latest one on its way), searchable, each with the
   * criticality of the plan characteristic and, for a cause, what its failure mode's special class suggests (offered, never copied).
   */
  async planCharacteristics(ctx: RequestContext, q: PlanCharacteristicsQuery) {
    const org = orgOf(ctx);
    return this.database.asUser(ctx, async (db) => {
      const can = (await db.execute<Row>(sql`select app.has_permission(${org}::uuid, 'process_control.read') as plans`)).rows[0];
      if (!can.plans) return { available: false as const, reason: 'You need to be able to read control plans to carry a control to one.', data: [] };
      let special: 'critical' | 'significant' | null = null;
      if (q.causeId) {
        const m = (
          await db.execute<Row>(sql`select fm.special_class from public.fmea_causes c join public.fmea_failure_modes fm on fm.id = c.failure_mode_id
                                     where c.id = ${q.causeId}::uuid and c.organisation_id = ${org}::uuid`)
        ).rows[0];
        if (!m) throw ApiError.notFound('fmea_not_found', 'Not found');
        special = (m.special_class as 'critical' | 'significant' | null) ?? null;
      }
      const like = q.q ? likePattern(q.q) : null;
      const rows = (
        await db.execute<Row>(sql`
          select * from (
            select distinct on (p.id, upper(o.operation_code), ch.characteristic_key)
                   p.id as plan_id, p.plan_code, p.title as plan_title, o.operation_code, o.name as operation_name, ch.characteristic_key, ch.name, ch.criticality,
                   cr.status as revision_status, cr.revision_code
              from public.control_plans p
              join public.control_plan_revisions cr on cr.control_plan_id = p.id and cr.organisation_id = p.organisation_id and cr.status in ('effective', 'approved', 'pending_approval', 'draft')
              join public.control_plan_operations o on o.control_plan_revision_id = cr.id
              join public.control_plan_characteristics ch on ch.control_plan_revision_id = cr.id and ch.operation_id = o.id
             where p.organisation_id = ${org}::uuid and p.active
               and (${q.planId ?? null}::uuid is null or p.id = ${q.planId ?? null}::uuid)
               and (${like}::text is null or p.plan_code ilike ${like} or p.title ilike ${like} or o.operation_code ilike ${like} or o.name ilike ${like} or ch.characteristic_key ilike ${like} or ch.name ilike ${like})
             order by p.id, upper(o.operation_code), ch.characteristic_key, (cr.status = 'effective') desc, cr.created_at desc) x
           order by x.plan_code, x.operation_code, x.characteristic_key
           limit ${q.limit}`)
      ).rows;
      return {
        available: true as const,
        data: rows.map((r) => ({
          plan: { id: r.plan_id as string, code: r.plan_code as string, title: r.plan_title as string },
          operationCode: r.operation_code as string,
          operationName: r.operation_name as string,
          characteristicKey: r.characteristic_key as string,
          name: r.name as string,
          criticality: r.criticality as 'critical' | 'major' | 'minor',
          inForce: r.revision_status === 'effective',
          revisionStatus: r.revision_status as string,
          revisionCode: r.revision_code as string,
          suggestion: criticalitySuggestion(special, r.criticality as 'critical' | 'major' | 'minor'),
        })),
      };
    });
  }

  /** Which causes that need attention the control plan covers (see fmea-coverage.ts). A revision the caller may not read is not found. */
  coverage(ctx: RequestContext, revisionId: string) {
    const org = orgOf(ctx);
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.settle_fmeas(${org}::uuid)`);
      const rev = (
        await db.execute<Row>(sql`select v.id, v.status, v.letter, f.id as fmea_id, f.number, f.title from public.fmea_revisions v join public.fmeas f on f.id = v.fmea_id
                                   where v.id = ${revisionId}::uuid and v.organisation_id = ${org}::uuid`)
      ).rows[0];
      if (!rev) throw ApiError.notFound('fmea_revision_not_found', 'Revision not found');
      const can = (await db.execute<Row>(sql`select app.has_permission(${org}::uuid, 'process_control.read') as plans, app.has_permission(${org}::uuid, 'fmea.manage') as manage`)).rows[0];
      const [causes, links] = await Promise.all([
        db.execute<Row>(sql`
          select c.id, c.text, c.priority, c.severity_used, c.rpn, m.text as failure_mode, m.special_class, i.name as item_name
            from public.fmea_causes c
            join public.fmea_failure_modes m on m.id = c.failure_mode_id
            join public.fmea_functions fn on fn.id = m.function_id
            join public.fmea_items i on i.id = fn.item_id
           where c.revision_id = ${revisionId}::uuid and c.organisation_id = ${org}::uuid and c.needs_attention`),
        db.execute<Row>(sql`${LINK_SELECT} where l.revision_id = ${revisionId}::uuid and l.organisation_id = ${org}::uuid and l.ended_at is null`),
      ]);
      const result = controlCoverage(
        causes.rows.map((c) => ({
          id: c.id as string, text: c.text as string, failureMode: c.failure_mode as string, itemName: c.item_name as string,
          priority: (c.priority as 'high' | 'medium' | 'low' | null) ?? null,
          severity: c.severity_used == null ? null : Number(c.severity_used), rpn: c.rpn == null ? null : Number(c.rpn),
          specialClass: (c.special_class as 'critical' | 'significant' | null) ?? null,
        })),
        links.rows.map((l) => {
          const link = toControlLink(l, Boolean(can.plans), false);
          return { id: link.id, causeId: link.causeId, kind: link.kind, state: link.state, planCode: link.plan?.code ?? null, operationCode: link.operationCode, characteristicKey: link.characteristicKey };
        }),
      );
      return {
        revision: { id: rev.id as string, fmeaId: rev.fmea_id as string, number: rev.number as string, title: rev.title as string, letter: (rev.letter as string) ?? null, status: rev.status as string },
        canReadPlans: Boolean(can.plans),
        canCarry: Boolean(can.manage) && (rev.status === 'draft' || rev.status === 'effective'),
        ...result,
      };
    });
  }

  /**
   * For a control plan revision's page: for each characteristic, the FMEA causes (of FMEAs in force) that carry a control to it. Read as the caller: causes of FMEAs they may not
   * read are not there, and without `fmea.read` the answer says it is not available rather than showing nothing.
   */
  async planCover(ctx: RequestContext, planRevisionId: string): Promise<{ available: boolean; data: PlanCover[] }> {
    const org = orgOf(ctx);
    return this.database.asUser(ctx, async (db) => {
      const can = (await db.execute<Row>(sql`select app.has_permission(${org}::uuid, 'fmea.read') as fmea`)).rows[0];
      if (!can.fmea) return { available: false, data: [] };
      const rev = (await db.execute<Row>(sql`select control_plan_id from public.control_plan_revisions where id = ${planRevisionId}::uuid and organisation_id = ${org}::uuid`)).rows[0];
      if (!rev) throw ApiError.notFound('control_plan_revision_not_found', 'Revision not found');
      const rows = (
        await db.execute<Row>(sql`
          select l.operation_code, l.characteristic_key, l.control_kind, c.id as cause_id, c.text as cause, c.priority, c.needs_attention, m.text as failure_mode,
                 f.id as fmea_id, f.number, f.title, v.letter
            from public.fmea_control_links l
            join public.fmea_revisions v on v.id = l.revision_id and v.status = 'effective'
            join public.fmeas f on f.id = v.fmea_id
            join public.fmea_causes c on c.id = l.cause_id
            join public.fmea_failure_modes m on m.id = c.failure_mode_id
           where l.organisation_id = ${org}::uuid and l.control_plan_id = ${rev.control_plan_id as string}::uuid and l.ended_at is null
             and exists (select 1 from public.control_plan_operations o join public.control_plan_characteristics ch on ch.control_plan_revision_id = o.control_plan_revision_id and ch.operation_id = o.id
                          where o.control_plan_revision_id = ${planRevisionId}::uuid and upper(o.operation_code) = upper(l.operation_code) and ch.characteristic_key = l.characteristic_key)`)
      ).rows;
      return {
        available: true,
        data: groupPlanCover(
          rows.map((r) => ({
            operationCode: r.operation_code as string,
            characteristicKey: r.characteristic_key as string,
            cover: {
              causeId: r.cause_id as string, cause: r.cause as string, failureMode: r.failure_mode as string, priority: (r.priority as 'high' | 'medium' | 'low' | null) ?? null,
              needsAttention: Boolean(r.needs_attention), kind: r.control_kind as 'prevention' | 'detection', fmeaId: r.fmea_id as string, fmeaNumber: r.number as string,
              fmeaTitle: r.title as string, revisionLetter: (r.letter as string) ?? null,
            },
          })),
        ),
      };
    });
  }
}
