import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { assignments, insertParts, iso, num, personName, Row } from '../calibration/calibration.service';
import { DatabaseService, Db } from '../database/database.service';
import {
  CreateCharacteristicBody,
  CreateOperationBody,
  PlanCharacteristic,
  PlanOperation,
  PlanRevision,
  ReplaceReactionsBody,
  RevisionComparison,
  RevisionDetail,
  UpdateCharacteristicBody,
  UpdateOperationBody,
} from './process-control.schemas';
import { compareRevisions } from './revision-compare';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const person = (id: unknown, name: unknown) => (id ? { id: id as string, name: (name as string) || 'Unknown user' } : null);

const OPERATION_COLUMNS = { operationCode: 'operation_code', sequence: 'sequence', name: 'name', machineId: 'machine_id', workCentre: 'work_centre', notes: 'notes' };
const CHARACTERISTIC_COLUMNS = {
  operationId: 'operation_id', characteristicKey: 'characteristic_key', sequence: 'sequence', charNumber: 'char_number', name: 'name',
  dataType: 'data_type', valueSource: 'value_source', appliesTo: 'applies_to', nominal: 'nominal', lowerLimit: 'lower_limit',
  upperLimit: 'upper_limit', unitCode: 'unit_code', specKey: 'spec_key', method: 'method', gaugeTypeId: 'gauge_type_id',
  criticality: 'criticality', spcEligible: 'spc_eligible', chartType: 'chart_type', subgroupSize: 'subgroup_size', decimals: 'decimals', notes: 'notes',
};

type CharacteristicValues = {
  dataType: 'variable' | 'attribute';
  valueSource: 'plan' | 'part_spec';
  appliesTo: 'all' | 'selected';
  nominal: number | null;
  lowerLimit: number | null;
  upperLimit: number | null;
  unitCode: string | null;
  specKey: string | null;
  spcEligible: boolean;
  chartType: 'imr' | 'xbar_r' | null;
  subgroupSize: number | null;
};

/**
 * Makes a characteristic's values consistent with its type (pass/fail checks have no unit or limits,
 * part-specific ones take their limits from the part, SPC settings only when charted) and returns
 * what is still wrong, in words for the user.
 */
export function normaliseCharacteristic(v: CharacteristicValues): { values: CharacteristicValues; problems: string[] } {
  const out = { ...v };
  if (out.dataType === 'attribute') {
    Object.assign(out, { valueSource: 'plan', nominal: null, lowerLimit: null, upperLimit: null, unitCode: null, specKey: null, spcEligible: false });
  } else if (out.valueSource === 'part_spec') {
    Object.assign(out, { nominal: null, lowerLimit: null, upperLimit: null });
  } else {
    out.specKey = null;
  }
  if (!out.spcEligible) Object.assign(out, { chartType: null, subgroupSize: null });
  else if (out.chartType === 'imr') out.subgroupSize = 1;
  const problems: string[] = [];
  if (out.dataType === 'variable') {
    if (!out.unitCode) problems.push('Choose the unit of measure');
    if (out.valueSource === 'part_spec' && !out.specKey) problems.push('Name the specification key the value comes from');
    if (out.valueSource === 'plan') {
      if (out.lowerLimit === null && out.upperLimit === null) problems.push('Give at least one limit');
      if (out.lowerLimit !== null && out.upperLimit !== null && out.lowerLimit > out.upperLimit) problems.push('The lower limit must not be above the upper limit');
      if (out.nominal !== null && ((out.lowerLimit !== null && out.nominal < out.lowerLimit) || (out.upperLimit !== null && out.nominal > out.upperLimit))) {
        problems.push('The nominal must be within the limits');
      }
    }
  }
  if (out.spcEligible) {
    if (!out.chartType) problems.push('Choose the chart type for SPC');
    if (out.chartType === 'xbar_r' && (out.subgroupSize === null || out.subgroupSize < 2 || out.subgroupSize > 10)) {
      problems.push('X-bar/R charts need a subgroup size of 2 to 10');
    }
  }
  return { values: out, problems };
}

const toCharacteristic = (r: Row, parts: Row[], sampling: Row[], reactions: Row[]): PlanCharacteristic => ({
  id: r.id as string,
  operationId: r.operation_id as string,
  characteristicKey: r.characteristic_key as string,
  sequence: Number(r.sequence),
  charNumber: (r.char_number as string) ?? null,
  name: r.name as string,
  dataType: r.data_type as PlanCharacteristic['dataType'],
  valueSource: r.value_source as PlanCharacteristic['valueSource'],
  appliesTo: r.applies_to as PlanCharacteristic['appliesTo'],
  nominal: num(r.nominal),
  lowerLimit: num(r.lower_limit),
  upperLimit: num(r.upper_limit),
  unitCode: (r.unit_code as string) ?? null,
  specKey: (r.spec_key as string) ?? null,
  method: (r.method as string) ?? null,
  gaugeType: r.gauge_type_id ? { id: r.gauge_type_id as string, name: r.gauge_type_name as string } : null,
  criticality: r.criticality as PlanCharacteristic['criticality'],
  spcEligible: r.spc_eligible as boolean,
  chartType: (r.chart_type as PlanCharacteristic['chartType']) ?? null,
  subgroupSize: r.subgroup_size === null ? null : Number(r.subgroup_size),
  decimals: r.decimals === null ? null : Number(r.decimals),
  notes: (r.notes as string) ?? null,
  parts: parts.filter((p) => p.plan_characteristic_id === r.id).map((p) => ({ id: p.part_id as string, partNumber: p.part_number as string })),
  sampling: sampling
    .filter((s) => s.plan_characteristic_id === r.id)
    .map((s) => ({ id: s.id as string, triggerType: s.trigger_type as never, intervalValue: s.interval_value === null ? null : Number(s.interval_value), sampleSize: Number(s.sample_size) })),
  reactions: reactions
    .filter((x) => x.plan_characteristic_id === r.id)
    .map((x) => ({ id: x.id as string, triggerType: x.trigger_type as never, action: x.action as never, instruction: x.instruction as string })),
});

const SAMPLING_ORDER = `array_position(array['first_off','start_of_shift','after_setup','after_tool_change','every_n_minutes','every_n_parts','last_off','manual'], trigger_type)`;

/**
 * Content of control plan revisions (PC2): operations, characteristics with their part lists,
 * sampling rules and reactions, and comparison with the revision being replaced. The database only
 * allows changes while the revision is a draft and owns the value rules; this service also checks
 * them first so the user gets specific messages.
 */
@Injectable()
export class ControlPlanContentService {
  constructor(private readonly database: DatabaseService) {}

  getRevision(ctx: RequestContext, id: string): Promise<RevisionDetail> {
    return this.database.asUser(ctx, (db) => this.load(db, ctx, id));
  }

  compare(ctx: RequestContext, id: string, withId?: string): Promise<RevisionComparison> {
    return this.database.asUser(ctx, async (db) => {
      const target = await this.load(db, ctx, id);
      const baseId = withId ?? target.supersedesRevision?.id ?? null;
      if (baseId === id) throw ApiError.badRequest('invalid_comparison', 'Compare with a different revision');
      const base = baseId ? await this.load(db, ctx, baseId) : null;
      if (base && base.controlPlanId !== target.controlPlanId) throw ApiError.badRequest('invalid_comparison', 'Both revisions must belong to the same plan');
      return compareRevisions(base, target);
    });
  }

  // ---- operations ----------------------------------------------------------------------------

  addOperation(ctx: RequestContext, revisionId: string, body: z.infer<typeof CreateOperationBody>): Promise<RevisionDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.requireRevision(db, ctx, revisionId);
      const { columns, values } = insertParts(body, OPERATION_COLUMNS, { organisation_id: orgOf(ctx), control_plan_revision_id: revisionId });
      await db.execute(sql`insert into public.control_plan_operations (${columns}) values (${values})`);
      return this.load(db, ctx, revisionId);
    });
  }

  updateOperation(ctx: RequestContext, id: string, body: z.infer<typeof UpdateOperationBody>): Promise<RevisionDetail> {
    return this.database.asUser(ctx, async (db) => {
      const result = await db.execute<{ control_plan_revision_id: string }>(sql`update public.control_plan_operations
        set ${sql.join(assignments(body, OPERATION_COLUMNS), sql`, `)}
        where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid returning control_plan_revision_id`);
      if (!result.rows.length) throw ApiError.notFound('operation_not_found', 'Operation not found');
      return this.load(db, ctx, result.rows[0].control_plan_revision_id);
    });
  }

  removeOperation(ctx: RequestContext, id: string): Promise<RevisionDetail> {
    return this.database.asUser(ctx, async (db) => {
      const result = await db.execute<{ control_plan_revision_id: string }>(sql`delete from public.control_plan_operations
        where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid returning control_plan_revision_id`);
      if (!result.rows.length) throw ApiError.notFound('operation_not_found', 'Operation not found');
      return this.load(db, ctx, result.rows[0].control_plan_revision_id);
    });
  }

  // ---- characteristics -----------------------------------------------------------------------

  addCharacteristic(ctx: RequestContext, revisionId: string, body: CreateCharacteristicBody): Promise<RevisionDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.requireRevision(db, ctx, revisionId);
      const { partIds, sampling, reactions, ...fields } = body;
      const { values, problems } = normaliseCharacteristic({
        dataType: fields.dataType ?? 'variable',
        valueSource: fields.valueSource ?? 'plan',
        appliesTo: fields.appliesTo ?? 'all',
        nominal: fields.nominal ?? null,
        lowerLimit: fields.lowerLimit ?? null,
        upperLimit: fields.upperLimit ?? null,
        unitCode: fields.unitCode ?? null,
        specKey: fields.specKey ?? null,
        spcEligible: fields.spcEligible ?? false,
        chartType: fields.chartType ?? null,
        subgroupSize: fields.subgroupSize ?? null,
      });
      this.check(problems, values.appliesTo, partIds);
      const { columns, values: vals } = insertParts({ ...fields, ...values }, CHARACTERISTIC_COLUMNS, {
        organisation_id: orgOf(ctx),
        control_plan_revision_id: revisionId,
      });
      const created = await db.execute<{ id: string }>(sql`insert into public.control_plan_characteristics (${columns}) values (${vals}) returning id`);
      await this.replaceChildren(db, ctx, revisionId, created.rows[0].id, { partIds, sampling, reactions });
      return this.load(db, ctx, revisionId);
    });
  }

  updateCharacteristic(ctx: RequestContext, id: string, body: UpdateCharacteristicBody): Promise<RevisionDetail> {
    return this.database.asUser(ctx, async (db) => {
      const current = await db.execute<Row>(sql`select * from public.control_plan_characteristics where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (!current.rows.length) throw ApiError.notFound('characteristic_not_found', 'Characteristic not found');
      const c = current.rows[0];
      const { partIds, sampling, reactions, ...fields } = body;
      const pick = <T>(key: keyof typeof fields, fallback: T): T => (fields[key] !== undefined ? (fields[key] as T) : fallback);
      const { values, problems } = normaliseCharacteristic({
        dataType: pick('dataType', c.data_type as CharacteristicValues['dataType']),
        valueSource: pick('valueSource', c.value_source as CharacteristicValues['valueSource']),
        appliesTo: pick('appliesTo', c.applies_to as CharacteristicValues['appliesTo']),
        nominal: pick('nominal', num(c.nominal)),
        lowerLimit: pick('lowerLimit', num(c.lower_limit)),
        upperLimit: pick('upperLimit', num(c.upper_limit)),
        unitCode: pick('unitCode', (c.unit_code as string) ?? null),
        specKey: pick('specKey', (c.spec_key as string) ?? null),
        spcEligible: pick('spcEligible', c.spc_eligible as boolean),
        chartType: pick('chartType', (c.chart_type as CharacteristicValues['chartType']) ?? null),
        subgroupSize: pick('subgroupSize', c.subgroup_size === null ? null : Number(c.subgroup_size)),
      });
      this.check(problems, values.appliesTo, partIds);
      const set = assignments({ ...fields, ...values }, CHARACTERISTIC_COLUMNS);
      await db.execute(sql`update public.control_plan_characteristics set ${sql.join(set, sql`, `)} where id = ${id}::uuid`);
      const revisionId = c.control_plan_revision_id as string;
      await this.replaceChildren(db, ctx, revisionId, id, { partIds, sampling, reactions });
      return this.load(db, ctx, revisionId);
    });
  }

  removeCharacteristic(ctx: RequestContext, id: string): Promise<RevisionDetail> {
    return this.database.asUser(ctx, async (db) => {
      const result = await db.execute<{ control_plan_revision_id: string }>(sql`delete from public.control_plan_characteristics
        where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid returning control_plan_revision_id`);
      if (!result.rows.length) throw ApiError.notFound('characteristic_not_found', 'Characteristic not found');
      return this.load(db, ctx, result.rows[0].control_plan_revision_id);
    });
  }

  /** Replace the reactions that apply to the whole revision. */
  replaceRevisionReactions(ctx: RequestContext, revisionId: string, body: z.infer<typeof ReplaceReactionsBody>): Promise<RevisionDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.requireRevision(db, ctx, revisionId);
      await db.execute(sql`delete from public.reaction_plans where control_plan_revision_id = ${revisionId}::uuid and plan_characteristic_id is null`);
      for (const r of body.reactions) {
        await db.execute(sql`insert into public.reaction_plans (organisation_id, control_plan_revision_id, trigger_type, action, instruction)
          values (${orgOf(ctx)}::uuid, ${revisionId}::uuid, ${r.triggerType}, ${r.action}, ${r.instruction})`);
      }
      return this.load(db, ctx, revisionId);
    });
  }

  // ---- helpers -------------------------------------------------------------------------------

  private check(problems: string[], appliesTo: string, partIds?: string[]) {
    if (appliesTo === 'all' && partIds?.length) problems.push('Parts are only listed when the characteristic applies to selected parts');
    if (problems.length) {
      throw ApiError.badRequest('validation_failed', problems.join('. '), problems.map((message) => ({ path: '', message })));
    }
  }

  private async replaceChildren(
    db: Db,
    ctx: RequestContext,
    revisionId: string,
    characteristicId: string,
    children: Pick<CreateCharacteristicBody, 'partIds' | 'sampling' | 'reactions'>,
  ) {
    const org = orgOf(ctx);
    if (children.partIds) {
      await db.execute(sql`delete from public.characteristic_applicability where plan_characteristic_id = ${characteristicId}::uuid`);
      for (const partId of new Set(children.partIds)) {
        await db.execute(sql`insert into public.characteristic_applicability (organisation_id, control_plan_revision_id, plan_characteristic_id, part_id)
          values (${org}::uuid, ${revisionId}::uuid, ${characteristicId}::uuid, ${partId}::uuid)`);
      }
    }
    if (children.sampling) {
      await db.execute(sql`delete from public.sampling_rules where plan_characteristic_id = ${characteristicId}::uuid`);
      for (const s of children.sampling) {
        const interval = s.triggerType === 'every_n_minutes' || s.triggerType === 'every_n_parts' ? (s.intervalValue ?? null) : null;
        if ((s.triggerType === 'every_n_minutes' || s.triggerType === 'every_n_parts') && interval === null) {
          throw ApiError.badRequest('validation_failed', `Give the interval for “${s.triggerType === 'every_n_minutes' ? 'every N minutes' : 'every N parts'}”`);
        }
        await db.execute(sql`insert into public.sampling_rules (organisation_id, control_plan_revision_id, plan_characteristic_id, trigger_type, interval_value, sample_size)
          values (${org}::uuid, ${revisionId}::uuid, ${characteristicId}::uuid, ${s.triggerType}, ${interval}, ${s.sampleSize})`);
      }
    }
    if (children.reactions) {
      await db.execute(sql`delete from public.reaction_plans where plan_characteristic_id = ${characteristicId}::uuid`);
      for (const r of children.reactions) {
        await db.execute(sql`insert into public.reaction_plans (organisation_id, control_plan_revision_id, plan_characteristic_id, trigger_type, action, instruction)
          values (${org}::uuid, ${revisionId}::uuid, ${characteristicId}::uuid, ${r.triggerType}, ${r.action}, ${r.instruction})`);
      }
    }
  }

  private async requireRevision(db: Db, ctx: RequestContext, id: string) {
    const result = await db.execute(sql`select 1 from public.control_plan_revisions where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
    if (!result.rows.length) throw ApiError.notFound('revision_not_found', 'Revision not found');
  }

  private async load(db: Db, ctx: RequestContext, id: string): Promise<RevisionDetail> {
    const rev = await db.execute<Row>(sql`
      select r.*, s.revision_code as supersedes_code, p.plan_code, p.title as plan_title, p.active as plan_active,
             ${sql.raw(personName('pc'))} as created_by_name, ${sql.raw(personName('ps'))} as submitted_by_name, ${sql.raw(personName('pa'))} as approved_by_name
      from public.control_plan_revisions r
      join public.control_plans p on p.id = r.control_plan_id
      left join public.control_plan_revisions s on s.id = r.supersedes_revision_id
      left join public.profiles pc on pc.id = r.created_by
      left join public.profiles ps on ps.id = r.submitted_by
      left join public.profiles pa on pa.id = r.approved_by
      where r.id = ${id}::uuid and r.organisation_id = ${orgOf(ctx)}::uuid`);
    if (!rev.rows.length) throw ApiError.notFound('revision_not_found', 'Revision not found');
    const r = rev.rows[0];
    // One connection per request: run the queries one after another.
    const ops = await db.execute<Row>(sql`select o.*, m.code as machine_code, m.name as machine_name from public.control_plan_operations o
        left join public.machines m on m.id = o.machine_id where o.control_plan_revision_id = ${id}::uuid order by o.sequence, upper(o.operation_code)`);
    const chars = await db.execute<Row>(sql`select c.*, g.name as gauge_type_name from public.control_plan_characteristics c
        left join public.gauge_types g on g.id = c.gauge_type_id where c.control_plan_revision_id = ${id}::uuid order by c.sequence, c.characteristic_key`);
    const parts = await db.execute<Row>(sql`select a.plan_characteristic_id, a.part_id, p.part_number from public.characteristic_applicability a
        join public.parts p on p.id = a.part_id where a.control_plan_revision_id = ${id}::uuid order by upper(p.part_number)`);
    const sampling = await db.execute<Row>(sql`select * from public.sampling_rules where control_plan_revision_id = ${id}::uuid order by ${sql.raw(SAMPLING_ORDER)}`);
    const reactions = await db.execute<Row>(sql`select * from public.reaction_plans where control_plan_revision_id = ${id}::uuid order by trigger_type, created_at, id`);
    const scope = await db.execute<Row>(sql`select distinct p.id, p.part_number, p.name from public.control_plan_applicability a
        join public.parts p on p.part_family_id = a.part_family_id and (a.part_id is null or a.part_id = p.id)
        where a.control_plan_id = ${r.control_plan_id as string}::uuid and p.active order by p.part_number`);
    const characteristics = chars.rows.map((c) => toCharacteristic(c, parts.rows, sampling.rows, reactions.rows));
    const operations: PlanOperation[] = ops.rows.map((o) => ({
      id: o.id as string,
      operationCode: o.operation_code as string,
      sequence: Number(o.sequence),
      name: o.name as string,
      machine: o.machine_id ? { id: o.machine_id as string, code: o.machine_code as string, name: o.machine_name as string } : null,
      workCentre: (o.work_centre as string) ?? null,
      notes: (o.notes as string) ?? null,
      characteristics: characteristics.filter((c) => c.operationId === o.id),
    }));
    const revision: PlanRevision = {
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
    };
    return {
      ...revision,
      plan: { id: r.control_plan_id as string, planCode: r.plan_code as string, title: r.plan_title as string, active: r.plan_active as boolean },
      operations,
      reactions: reactions.rows
        .filter((x) => x.plan_characteristic_id === null)
        .map((x) => ({ id: x.id as string, triggerType: x.trigger_type as never, action: x.action as never, instruction: x.instruction as string })),
      scopeParts: scope.rows.map((p) => ({ id: p.id as string, partNumber: p.part_number as string, name: p.name as string })),
    };
  }
}
