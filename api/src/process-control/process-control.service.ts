import { Injectable } from '@nestjs/common';
import { SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import { decodeCursor, Page, toPage } from '../common/pagination';
import type { RequestContext } from '../common/request-context';
import { assignments, insertParts, iso, num, personName, Row } from '../calibration/calibration.service';
import { DatabaseService, Db } from '../database/database.service';
import {
  Applicability,
  ControlPlanDetail,
  ControlPlanListQuery,
  ControlPlanSummary,
  CreateApplicabilityBody,
  CreateControlPlanBody,
  CreateMachineBody,
  CreatePartFamilyBody,
  CreatePlanRevisionBody,
  CreateSpecValueBody,
  FamilyMembershipBody,
  HistoryEntry,
  Machine,
  MachineListQuery,
  PartFamily,
  PartFamilyDetail,
  PartFamilyListQuery,
  PlanRevision,
  PlanRevisionTransitionBody,
  SpecValue,
  UpdateControlPlanBody,
  UpdateMachineBody,
  UpdatePartFamilyBody,
  UpdatePlanRevisionBody,
  UpdateSpecValueBody,
} from './process-control.schemas';

const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const person = (id: unknown, name: unknown) => (id ? { id: id as string, name: (name as string) || 'Unknown user' } : null);
const orgOf = (ctx: RequestContext) => ctx.organisationId!;

const MACHINE_COLUMNS = { code: 'code', name: 'name', siteId: 'site_id', workCentre: 'work_centre', description: 'description', active: 'active' };
const FAMILY_COLUMNS = { code: 'code', name: 'name', description: 'description', active: 'active' };
const SPEC_COLUMNS = {
  characteristicKey: 'characteristic_key', description: 'description', nominal: 'nominal', lowerLimit: 'lower_limit',
  upperLimit: 'upper_limit', unitCode: 'unit_code', notes: 'notes',
};
const PLAN_COLUMNS = { planCode: 'plan_code', title: 'title', description: 'description', ownerId: 'owner_id', active: 'active' };
const REVISION_COLUMNS = { revisionCode: 'revision_code', changeReason: 'change_reason', effectiveFrom: 'effective_from' };

/** Ids in history values that are named for the reader. */
const HISTORY_ID_FIELDS = ['owner_id', 'part_family_id', 'part_id', 'site_id', 'submitted_by', 'approved_by', 'supersedes_revision_id'] as const;

const toMachine = (r: Row): Machine => ({
  id: r.id as string,
  code: r.code as string,
  name: r.name as string,
  site: r.site_id ? { id: r.site_id as string, name: r.site_name as string } : null,
  workCentre: (r.work_centre as string) ?? null,
  description: (r.description as string) ?? null,
  active: r.active as boolean,
});
const toFamily = (r: Row): PartFamily => ({
  id: r.id as string,
  code: r.code as string,
  name: r.name as string,
  description: (r.description as string) ?? null,
  active: r.active as boolean,
  partCount: Number(r.part_count ?? 0),
  planCount: Number(r.plan_count ?? 0),
});
const toSpec = (r: Row): SpecValue => ({
  id: r.id as string,
  partRevisionId: r.part_revision_id as string,
  characteristicKey: r.characteristic_key as string,
  description: (r.description as string) ?? null,
  nominal: num(r.nominal),
  lowerLimit: num(r.lower_limit),
  upperLimit: num(r.upper_limit),
  unitCode: r.unit_code as string,
  notes: (r.notes as string) ?? null,
});
const toRevision = (r: Row): PlanRevision => ({
  id: r.id as string,
  controlPlanId: r.control_plan_id as string,
  revisionCode: r.revision_code as string,
  status: r.status as PlanRevision['status'],
  changeReason: (r.change_reason as string) ?? null,
  effectiveFrom: iso(r.effective_from),
  effectiveUntil: iso(r.effective_until),
  supersedesRevision: r.supersedes_revision_id ? { id: r.supersedes_revision_id as string, revisionCode: r.supersedes_code as string } : null,
  createdAt: iso(r.created_at)!,
  createdBy: person(r.created_by, r.created_by_name),
  submittedAt: iso(r.submitted_at),
  submittedBy: person(r.submitted_by, r.submitted_by_name),
  approvedAt: iso(r.approved_at),
  approvedBy: person(r.approved_by, r.approved_by_name),
  reviewComment: (r.review_comment as string) ?? null,
  obsoleteReason: (r.obsolete_reason as string) ?? null,
});
const toApplicability = (r: Row): Applicability => ({
  id: r.id as string,
  partFamily: r.part_family_id ? { id: r.part_family_id as string, code: r.family_code as string, name: r.family_name as string } : null,
  part: r.part_id ? { id: r.part_id as string, partNumber: r.part_number as string } : null,
  site: r.site_id ? { id: r.site_id as string, name: r.site_name as string } : null,
  operationCode: (r.operation_code as string) ?? null,
});
const toPlanSummary = (r: Row): ControlPlanSummary => ({
  id: r.id as string,
  planCode: r.plan_code as string,
  title: r.title as string,
  description: (r.description as string) ?? null,
  owner: person(r.owner_id, r.owner_name),
  active: r.active as boolean,
  families: (r.families as string[]) ?? [],
  parts: (r.parts as string[]) ?? [],
  effectiveRevision: (r.effective_revision as string) ?? null,
  openRevision: r.open_code ? { revisionCode: r.open_code as string, status: r.open_status as PlanRevision['status'] } : null,
  updatedAt: iso(r.updated_at)!,
});

const PLAN_SELECT = `
  select p.id, p.plan_code, p.title, p.description, p.owner_id, ${personName('po')} as owner_name, p.active,
         greatest(p.updated_at, (select max(r.updated_at) from public.control_plan_revisions r where r.control_plan_id = p.id)) as updated_at,
         (select array_agg(distinct f.code order by f.code) from public.control_plan_applicability a
            join public.part_families f on f.id = a.part_family_id where a.control_plan_id = p.id) as families,
         (select array_agg(distinct pt.part_number order by pt.part_number) from public.control_plan_applicability a
            join public.parts pt on pt.id = a.part_id where a.control_plan_id = p.id and a.part_family_id is null) as parts,
         (select r.revision_code from public.control_plan_revisions r where r.control_plan_id = p.id and r.status = 'effective') as effective_revision,
         o.revision_code as open_code, o.status as open_status
  from public.control_plans p
  left join public.profiles po on po.id = p.owner_id
  left join public.control_plan_revisions o on o.control_plan_id = p.id and o.status in ('draft', 'pending_approval')`;

const REVISION_SELECT = `
  select r.*, s.revision_code as supersedes_code,
         ${personName('pc')} as created_by_name, ${personName('ps')} as submitted_by_name, ${personName('pa')} as approved_by_name
  from public.control_plan_revisions r
  left join public.control_plan_revisions s on s.id = r.supersedes_revision_id
  left join public.profiles pc on pc.id = r.created_by
  left join public.profiles ps on ps.id = r.submitted_by
  left join public.profiles pa on pa.id = r.approved_by`;

/**
 * Process control foundations (PC1): machines and part families (master data), part-specific
 * characteristic values on part revisions, and control plans with applicability and revisions.
 * RLS applies the permissions; the database owns the rules (only drafts editable, revision
 * lifecycle, one working copy and one effective revision per plan) and its messages come back as
 * 409 control_plan_rule.
 */
@Injectable()
export class ProcessControlService {
  constructor(private readonly database: DatabaseService) {}

  // ---- machines --------------------------------------------------------------------------------

  listMachines(ctx: RequestContext, q: z.infer<typeof MachineListQuery>): Promise<Page<Machine>> {
    const cursor = decodeCursor(q.cursor);
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`m.organisation_id = ${orgOf(ctx)}::uuid`];
      if (!q.includeInactive) where.push(sql`m.active`);
      if (q.siteId) where.push(sql`m.site_id = ${q.siteId}::uuid`);
      if (q.q) where.push(sql`(m.code ilike ${likePattern(q.q)} or m.name ilike ${likePattern(q.q)} or m.work_centre ilike ${likePattern(q.q)})`);
      if (cursor) where.push(sql`(upper(m.code), m.id) > (${cursor.k}, ${cursor.id}::uuid)`);
      const result = await db.execute<Row>(sql`
        select m.*, s.name as site_name from public.machines m left join public.sites s on s.id = m.site_id
        where ${sql.join(where, sql` and `)} order by upper(m.code), m.id limit ${q.limit + 1}`);
      return toPage(result.rows.map(toMachine), q.limit, (r) => ({ k: r.code.toUpperCase(), id: r.id }));
    });
  }

  createMachine(ctx: RequestContext, body: z.infer<typeof CreateMachineBody>): Promise<Machine> {
    return this.database.asUser(ctx, async (db) => {
      const { columns, values } = insertParts(body, MACHINE_COLUMNS, { organisation_id: orgOf(ctx) });
      const result = await db.execute<{ id: string }>(sql`insert into public.machines (${columns}) values (${values}) returning id`);
      return this.loadMachine(db, result.rows[0].id);
    });
  }

  updateMachine(ctx: RequestContext, id: string, body: z.infer<typeof UpdateMachineBody>): Promise<Machine> {
    return this.database.asUser(ctx, async (db) => {
      const result = await db.execute(sql`update public.machines set ${sql.join(assignments(body, MACHINE_COLUMNS), sql`, `)}
        where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid returning id`);
      if (!result.rows.length) throw ApiError.notFound('machine_not_found', 'Machine not found');
      return this.loadMachine(db, id);
    });
  }

  private async loadMachine(db: Db, id: string): Promise<Machine> {
    const result = await db.execute<Row>(sql`select m.*, s.name as site_name from public.machines m
      left join public.sites s on s.id = m.site_id where m.id = ${id}::uuid`);
    if (!result.rows.length) throw ApiError.notFound('machine_not_found', 'Machine not found');
    return toMachine(result.rows[0]);
  }

  // ---- part families ---------------------------------------------------------------------------

  listFamilies(ctx: RequestContext, q: z.infer<typeof PartFamilyListQuery>): Promise<Page<PartFamily>> {
    const cursor = decodeCursor(q.cursor);
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`f.organisation_id = ${orgOf(ctx)}::uuid`];
      if (!q.includeInactive) where.push(sql`f.active`);
      if (q.q) where.push(sql`(f.code ilike ${likePattern(q.q)} or f.name ilike ${likePattern(q.q)})`);
      if (cursor) where.push(sql`(upper(f.code), f.id) > (${cursor.k}, ${cursor.id}::uuid)`);
      const result = await db.execute<Row>(sql`${sql.raw(FAMILY_SELECT)} where ${sql.join(where, sql` and `)}
        order by upper(f.code), f.id limit ${q.limit + 1}`);
      return toPage(result.rows.map(toFamily), q.limit, (r) => ({ k: r.code.toUpperCase(), id: r.id }));
    });
  }

  getFamily(ctx: RequestContext, id: string): Promise<PartFamilyDetail> {
    return this.database.asUser(ctx, (db) => this.loadFamily(db, ctx, id));
  }

  createFamily(ctx: RequestContext, body: z.infer<typeof CreatePartFamilyBody>): Promise<PartFamilyDetail> {
    return this.database.asUser(ctx, async (db) => {
      const { columns, values } = insertParts(body, FAMILY_COLUMNS, { organisation_id: orgOf(ctx) });
      const result = await db.execute<{ id: string }>(sql`insert into public.part_families (${columns}) values (${values}) returning id`);
      return this.loadFamily(db, ctx, result.rows[0].id);
    });
  }

  updateFamily(ctx: RequestContext, id: string, body: z.infer<typeof UpdatePartFamilyBody>): Promise<PartFamilyDetail> {
    return this.database.asUser(ctx, async (db) => {
      const result = await db.execute(sql`update public.part_families set ${sql.join(assignments(body, FAMILY_COLUMNS), sql`, `)}
        where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid returning id`);
      if (!result.rows.length) throw ApiError.notFound('part_family_not_found', 'Part family not found');
      return this.loadFamily(db, ctx, id);
    });
  }

  /**
   * Bulk family membership: `add` moves the parts into this family (from none or another family),
   * `remove` takes them out. The database refuses a part a control plan names with its family.
   */
  changeFamilyMembers(ctx: RequestContext, id: string, body: z.infer<typeof FamilyMembershipBody>): Promise<PartFamilyDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadFamily(db, ctx, id); // 404 when not visible
      const org = orgOf(ctx);
      if (body.add?.length) {
        const known = await db.execute<{ n: string }>(sql`select count(*) as n from public.parts
          where organisation_id = ${org}::uuid and id = any(string_to_array(${body.add.join(',')}, ',')::uuid[])`);
        if (Number(known.rows[0].n) !== new Set(body.add).size) throw ApiError.badRequest('invalid_reference', 'A part to add was not found');
        await db.execute(sql`update public.parts set part_family_id = ${id}::uuid
          where organisation_id = ${org}::uuid and id = any(string_to_array(${body.add.join(',')}, ',')::uuid[])
            and part_family_id is distinct from ${id}::uuid`);
      }
      if (body.remove?.length) {
        await db.execute(sql`update public.parts set part_family_id = null
          where organisation_id = ${org}::uuid and part_family_id = ${id}::uuid and id = any(string_to_array(${body.remove.join(',')}, ',')::uuid[])`);
      }
      return this.loadFamily(db, ctx, id);
    });
  }

  private async loadFamily(db: Db, ctx: RequestContext, id: string): Promise<PartFamilyDetail> {
    const result = await db.execute<Row>(sql`${sql.raw(FAMILY_SELECT)} where f.organisation_id = ${orgOf(ctx)}::uuid and f.id = ${id}::uuid`);
    if (!result.rows.length) throw ApiError.notFound('part_family_not_found', 'Part family not found');
    const parts = await db.execute<Row>(sql`
      select p.id, p.part_number, p.name, p.active,
             (select r.revision from public.part_revisions r where r.part_id = p.id and r.status = 'released') as current_revision
      from public.parts p where p.part_family_id = ${id}::uuid order by upper(p.part_number)`);
    // Plans are only listed for readers of control plans (RLS hides them otherwise).
    const plans = await db.execute<Row>(sql`
      select p.id, p.plan_code, p.title, p.active,
             (select r.revision_code from public.control_plan_revisions r where r.control_plan_id = p.id and r.status = 'effective') as effective_revision,
             string_agg(concat_ws(' · ', coalesce(pt.part_number, 'All parts'), s.name, a.operation_code), '; ' order by pt.part_number nulls first) as scope
      from public.control_plan_applicability a
      join public.control_plans p on p.id = a.control_plan_id
      left join public.parts pt on pt.id = a.part_id
      left join public.sites s on s.id = a.site_id
      where a.part_family_id = ${id}::uuid
      group by p.id order by upper(p.plan_code)`);
    return {
      ...toFamily(result.rows[0]),
      parts: parts.rows.map((r) => ({
        id: r.id as string,
        partNumber: r.part_number as string,
        name: r.name as string,
        active: r.active as boolean,
        currentRevision: (r.current_revision as string) ?? null,
      })),
      plans: plans.rows.map((r) => ({
        id: r.id as string,
        planCode: r.plan_code as string,
        title: r.title as string,
        active: r.active as boolean,
        effectiveRevision: (r.effective_revision as string) ?? null,
        scope: (r.scope as string) ?? '',
      })),
    };
  }

  // ---- part revision characteristic values -------------------------------------------------------

  listSpecValues(ctx: RequestContext, revisionId: string): Promise<SpecValue[]> {
    return this.database.asUser(ctx, async (db) => {
      await this.requirePartRevision(db, ctx, revisionId);
      const result = await db.execute<Row>(sql`select * from public.part_revision_characteristics
        where part_revision_id = ${revisionId}::uuid order by characteristic_key`);
      return result.rows.map(toSpec);
    });
  }

  createSpecValue(ctx: RequestContext, revisionId: string, body: z.infer<typeof CreateSpecValueBody>): Promise<SpecValue> {
    return this.database.asUser(ctx, async (db) => {
      await this.requirePartRevision(db, ctx, revisionId);
      const { columns, values } = insertParts(body, SPEC_COLUMNS, { organisation_id: orgOf(ctx), part_revision_id: revisionId });
      const result = await db.execute<Row>(sql`insert into public.part_revision_characteristics (${columns}) values (${values}) returning *`);
      return toSpec(result.rows[0]);
    });
  }

  updateSpecValue(ctx: RequestContext, id: string, body: z.infer<typeof UpdateSpecValueBody>): Promise<SpecValue> {
    return this.database.asUser(ctx, async (db) => {
      const result = await db.execute<Row>(sql`update public.part_revision_characteristics set ${sql.join(assignments(body, SPEC_COLUMNS), sql`, `)}
        where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid returning *`);
      if (!result.rows.length) throw ApiError.notFound('spec_value_not_found', 'Specification value not found');
      return toSpec(result.rows[0]);
    });
  }

  deleteSpecValue(ctx: RequestContext, id: string): Promise<void> {
    return this.database.asUser(ctx, async (db) => {
      const result = await db.execute(sql`delete from public.part_revision_characteristics
        where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid returning id`);
      if (!result.rows.length) throw ApiError.notFound('spec_value_not_found', 'Specification value not found');
    });
  }

  private async requirePartRevision(db: Db, ctx: RequestContext, id: string): Promise<void> {
    const result = await db.execute(sql`select 1 from public.part_revisions where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
    if (!result.rows.length) throw ApiError.notFound('revision_not_found', 'Revision not found');
  }

  // ---- control plans ---------------------------------------------------------------------------

  listPlans(ctx: RequestContext, q: z.infer<typeof ControlPlanListQuery>): Promise<Page<ControlPlanSummary>> {
    const cursor = decodeCursor(q.cursor);
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`p.organisation_id = ${orgOf(ctx)}::uuid`];
      if (!q.includeInactive) where.push(sql`p.active`);
      if (q.q) where.push(sql`(p.plan_code ilike ${likePattern(q.q)} or p.title ilike ${likePattern(q.q)})`);
      if (q.partFamilyId) {
        where.push(sql`exists (select 1 from public.control_plan_applicability a where a.control_plan_id = p.id and a.part_family_id = ${q.partFamilyId}::uuid)`);
      }
      if (q.status === 'effective') where.push(sql`exists (select 1 from public.control_plan_revisions r where r.control_plan_id = p.id and r.status = 'effective')`);
      if (q.status === 'no_effective') where.push(sql`not exists (select 1 from public.control_plan_revisions r where r.control_plan_id = p.id and r.status = 'effective')`);
      if (q.status === 'pending_approval') where.push(sql`o.status = 'pending_approval'`);
      if (cursor) where.push(sql`(upper(p.plan_code), p.id) > (${cursor.k}, ${cursor.id}::uuid)`);
      const result = await db.execute<Row>(sql`${sql.raw(PLAN_SELECT)} where ${sql.join(where, sql` and `)}
        order by upper(p.plan_code), p.id limit ${q.limit + 1}`);
      return toPage(result.rows.map(toPlanSummary), q.limit, (r) => ({ k: r.planCode.toUpperCase(), id: r.id }));
    });
  }

  getPlan(ctx: RequestContext, id: string): Promise<ControlPlanDetail> {
    return this.database.asUser(ctx, (db) => this.loadPlan(db, ctx, id));
  }

  createPlan(ctx: RequestContext, body: z.infer<typeof CreateControlPlanBody>): Promise<ControlPlanDetail> {
    return this.database.asUser(ctx, async (db) => {
      const { revisionCode, partFamilyId, ...fields } = body;
      const { columns, values } = insertParts(fields, PLAN_COLUMNS, { organisation_id: orgOf(ctx) });
      const plan = await db.execute<{ id: string }>(sql`insert into public.control_plans (${columns}) values (${values}) returning id`);
      const id = plan.rows[0].id;
      await db.execute(sql`insert into public.control_plan_revisions (organisation_id, control_plan_id, revision_code)
        values (${orgOf(ctx)}::uuid, ${id}::uuid, ${revisionCode ?? 'A'})`);
      if (partFamilyId) {
        await db.execute(sql`insert into public.control_plan_applicability (organisation_id, control_plan_id, part_family_id)
          values (${orgOf(ctx)}::uuid, ${id}::uuid, ${partFamilyId}::uuid)`);
      }
      return this.loadPlan(db, ctx, id);
    });
  }

  updatePlan(ctx: RequestContext, id: string, body: z.infer<typeof UpdateControlPlanBody>): Promise<ControlPlanDetail> {
    return this.database.asUser(ctx, async (db) => {
      const result = await db.execute(sql`update public.control_plans set ${sql.join(assignments(body, PLAN_COLUMNS), sql`, `)}
        where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid returning id`);
      if (!result.rows.length) throw ApiError.notFound('control_plan_not_found', 'Control plan not found');
      return this.loadPlan(db, ctx, id);
    });
  }

  addApplicability(ctx: RequestContext, planId: string, body: z.infer<typeof CreateApplicabilityBody>): Promise<ControlPlanDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadPlan(db, ctx, planId);
      await db.execute(sql`insert into public.control_plan_applicability (organisation_id, control_plan_id, part_family_id, part_id, site_id, operation_code)
        values (${orgOf(ctx)}::uuid, ${planId}::uuid, ${body.partFamilyId ?? null}::uuid, ${body.partId ?? null}::uuid, ${body.siteId ?? null}::uuid, ${body.operationCode ?? null})`);
      return this.loadPlan(db, ctx, planId);
    });
  }

  removeApplicability(ctx: RequestContext, id: string): Promise<ControlPlanDetail> {
    return this.database.asUser(ctx, async (db) => {
      const result = await db.execute<{ control_plan_id: string }>(sql`delete from public.control_plan_applicability
        where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid returning control_plan_id`);
      if (!result.rows.length) throw ApiError.notFound('applicability_not_found', 'Scope entry not found');
      return this.loadPlan(db, ctx, result.rows[0].control_plan_id);
    });
  }

  createRevision(ctx: RequestContext, planId: string, body: z.infer<typeof CreatePlanRevisionBody>): Promise<PlanRevision> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadPlan(db, ctx, planId);
      const { columns, values } = insertParts(body, REVISION_COLUMNS, { organisation_id: orgOf(ctx), control_plan_id: planId });
      const result = await db.execute<{ id: string }>(sql`insert into public.control_plan_revisions (${columns}) values (${values}) returning id`);
      return this.loadRevision(db, ctx, result.rows[0].id);
    });
  }

  updateRevision(ctx: RequestContext, id: string, body: z.infer<typeof UpdatePlanRevisionBody>): Promise<PlanRevision> {
    return this.database.asUser(ctx, async (db) => {
      const result = await db.execute(sql`update public.control_plan_revisions set ${sql.join(assignments(body, REVISION_COLUMNS), sql`, `)}
        where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid returning id`);
      if (!result.rows.length) throw ApiError.notFound('revision_not_found', 'Revision not found');
      return this.loadRevision(db, ctx, id);
    });
  }

  /** Lifecycle commands; the database decides whether the caller may make each change. */
  transitionRevision(ctx: RequestContext, id: string, body: PlanRevisionTransitionBody): Promise<PlanRevision> {
    return this.database.asUser(ctx, async (db) => {
      const current = await this.loadRevision(db, ctx, id);
      const set = async (to: string, extra: SQL = sql``) => {
        const result = await db.execute(sql`update public.control_plan_revisions set status = ${to} ${extra} where id = ${id}::uuid returning id`);
        // Visible but not updatable (row level security): the caller may only read.
        if (!result.rows.length) throw ApiError.forbidden();
      };
      switch (body.action) {
        case 'submit':
          await set('pending_approval');
          break;
        case 'withdraw':
          await set('draft', sql`, review_comment = null`);
          break;
        case 'send_back':
          await set('draft', sql`, review_comment = ${body.comment ?? null}`);
          break;
        case 'approve': {
          await set('approved', sql`, review_comment = ${body.comment ?? null}`);
          const due = !current.effectiveFrom || new Date(current.effectiveFrom) <= new Date();
          if (body.makeEffective !== false && due) await set('effective');
          break;
        }
        case 'make_effective':
          await set('effective');
          break;
        case 'obsolete':
          await set('obsolete', sql`, obsolete_reason = ${body.reason ?? null}`);
          break;
      }
      return this.loadRevision(db, ctx, id);
    });
  }

  history(ctx: RequestContext, id: string): Promise<z.infer<typeof HistoryEntry>[]> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadPlan(db, ctx, id); // 404 when not visible
      const result = await db.execute<Row>(sql`
        select h.id, h.created_at, h.entity_type, h.entity_id, h.action, h.changed_fields, h.previous_values, h.new_values,
               h.reason, h.source, h.actor_user_id, ${sql.raw(personName('pr'))} as actor_name
        from app.control_plan_history(${id}::uuid) h
        left join public.profiles pr on pr.id = h.actor_user_id`);
      const entries = result.rows.map((r) => ({
        id: r.id as string,
        at: iso(r.created_at)!,
        actor: r.actor_user_id ? { id: r.actor_user_id as string, name: (r.actor_name as string) ?? 'Unknown user' } : null,
        entityType: r.entity_type as string,
        entityId: r.entity_id as string,
        action: r.action as string,
        changedFields: (r.changed_fields as string[]) ?? [],
        previous: (r.previous_values as Record<string, unknown>) ?? null,
        current: (r.new_values as Record<string, unknown>) ?? null,
        reason: (r.reason as string) || null,
        source: r.source as string,
        names: {} as Record<string, string>,
      }));
      const ids = new Set<string>();
      for (const e of entries) {
        // Updates carry only the changed fields, so revisions and scope entries are named by id.
        if (e.entityType !== 'control_plans' && UUID.test(e.entityId)) ids.add(e.entityId);
        for (const values of [e.previous, e.current]) {
          for (const f of HISTORY_ID_FIELDS) {
            const v = values?.[f];
            if (typeof v === 'string' && UUID.test(v)) ids.add(v);
          }
        }
      }
      if (ids.size === 0) return entries;
      const named = await db.execute<Row>(sql`
        with ids as (select unnest(string_to_array(${[...ids].join(',')}, ',')::uuid[]) as id)
        select f.id, f.code || ' – ' || f.name as name from public.part_families f join ids using (id)
        union all select p.id, p.part_number from public.parts p join ids using (id)
        union all select s.id, s.name from public.sites s join ids using (id)
        union all select r.id, 'revision ' || r.revision_code from public.control_plan_revisions r join ids using (id)
        union all select a.id, concat_ws(' · ', f.code, pt.part_number, st.name, a.operation_code)
          from public.control_plan_applicability a join ids using (id)
          join public.part_families f on f.id = a.part_family_id
          left join public.parts pt on pt.id = a.part_id left join public.sites st on st.id = a.site_id
        union all select u.id, ${sql.raw(personName('u'))} from public.profiles u join ids using (id)`);
      const names = new Map(named.rows.filter((r) => r.name).map((r) => [r.id as string, r.name as string]));
      for (const e of entries) {
        if (names.has(e.entityId)) e.names[e.entityId] = names.get(e.entityId)!;
        for (const values of [e.previous, e.current]) {
          for (const f of HISTORY_ID_FIELDS) {
            const v = values?.[f];
            if (typeof v === 'string' && names.has(v)) e.names[v] = names.get(v)!;
          }
        }
      }
      return entries;
    });
  }

  private async loadPlan(db: Db, ctx: RequestContext, id: string): Promise<ControlPlanDetail> {
    const result = await db.execute<Row>(sql`${sql.raw(PLAN_SELECT)} where p.organisation_id = ${orgOf(ctx)}::uuid and p.id = ${id}::uuid`);
    if (!result.rows.length) throw ApiError.notFound('control_plan_not_found', 'Control plan not found');
    const applicability = await db.execute<Row>(sql`
      select a.*, f.code as family_code, f.name as family_name, pt.part_number, s.name as site_name
      from public.control_plan_applicability a
      left join public.part_families f on f.id = a.part_family_id
      left join public.parts pt on pt.id = a.part_id
      left join public.sites s on s.id = a.site_id
      where a.control_plan_id = ${id}::uuid
      order by upper(f.code) nulls last, pt.part_number nulls first, s.name nulls first, a.operation_code nulls first`);
    const revisions = await db.execute<Row>(sql`${sql.raw(REVISION_SELECT)} where r.control_plan_id = ${id}::uuid
      order by r.created_at desc, r.revision_code desc`);
    const scope = await db.execute<Row>(sql`select distinct p.id, p.part_number, p.name from public.control_plan_applicability a
      join public.parts p on p.id = a.part_id or (a.part_id is null and p.part_family_id = a.part_family_id)
      where a.control_plan_id = ${id}::uuid and p.active order by p.part_number`);
    return {
      ...toPlanSummary(result.rows[0]),
      applicability: applicability.rows.map(toApplicability),
      revisions: revisions.rows.map(toRevision),
      scopeParts: scope.rows.map((p) => ({ id: p.id as string, partNumber: p.part_number as string, name: p.name as string })),
    };
  }

  private async loadRevision(db: Db, ctx: RequestContext, id: string): Promise<PlanRevision> {
    const result = await db.execute<Row>(sql`${sql.raw(REVISION_SELECT)} where r.id = ${id}::uuid and r.organisation_id = ${orgOf(ctx)}::uuid`);
    if (!result.rows.length) throw ApiError.notFound('revision_not_found', 'Revision not found');
    return toRevision(result.rows[0]);
  }
}

const FAMILY_SELECT = `
  select f.*,
         (select count(*) from public.parts p where p.part_family_id = f.id) as part_count,
         (select count(distinct a.control_plan_id) from public.control_plan_applicability a where a.part_family_id = f.id) as plan_count
  from public.part_families f`;
