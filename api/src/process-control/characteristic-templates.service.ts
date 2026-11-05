import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { assignments, insertParts, iso, num, Row } from '../calibration/calibration.service';
import { DatabaseService, Db } from '../database/database.service';
import { normaliseCharacteristic } from './control-plan-content.service';
import {
  CharacteristicTemplate,
  CharacteristicTemplateQuery,
  CreateCharacteristicTemplateBody,
  UpdateCharacteristicTemplateBody,
} from './process-control.schemas';
import { z } from 'zod';

const COLUMNS = {
  name: 'name', description: 'description', characteristicKey: 'characteristic_key', dataType: 'data_type', valueSource: 'value_source',
  nominal: 'nominal', lowerLimit: 'lower_limit', upperLimit: 'upper_limit', unitCode: 'unit_code', specKey: 'spec_key', method: 'method',
  gaugeTypeId: 'gauge_type_id', criticality: 'criticality', spcEligible: 'spc_eligible', chartType: 'chart_type',
  subgroupSize: 'subgroup_size', decimals: 'decimals', notes: 'notes', active: 'active',
};

const SELECT = `select t.*, g.name as gauge_type_name
  from public.characteristic_templates t
  left join public.gauge_types g on g.id = t.gauge_type_id`;

const toTemplate = (r: Row): CharacteristicTemplate => ({
  id: r.id as string,
  name: r.name as string,
  description: (r.description as string) ?? null,
  characteristicKey: r.characteristic_key as string,
  dataType: r.data_type as CharacteristicTemplate['dataType'],
  valueSource: r.value_source as CharacteristicTemplate['valueSource'],
  nominal: num(r.nominal),
  lowerLimit: num(r.lower_limit),
  upperLimit: num(r.upper_limit),
  unitCode: (r.unit_code as string) ?? null,
  specKey: (r.spec_key as string) ?? null,
  method: (r.method as string) ?? null,
  gaugeType: r.gauge_type_id ? { id: r.gauge_type_id as string, name: r.gauge_type_name as string } : null,
  criticality: r.criticality as CharacteristicTemplate['criticality'],
  spcEligible: r.spc_eligible as boolean,
  chartType: (r.chart_type as CharacteristicTemplate['chartType']) ?? null,
  subgroupSize: r.subgroup_size === null ? null : Number(r.subgroup_size),
  decimals: r.decimals === null ? null : Number(r.decimals),
  notes: (r.notes as string) ?? null,
  sampling: (r.sampling as CharacteristicTemplate['sampling']) ?? [],
  reactions: (r.reactions as CharacteristicTemplate['reactions']) ?? [],
  active: r.active as boolean,
  updatedAt: iso(r.updated_at)!,
});

/** Reusable control plan characteristics (Settings → Process control), copied into draft revisions by the client. */
@Injectable()
export class CharacteristicTemplatesService {
  constructor(private readonly database: DatabaseService) {}

  list(ctx: RequestContext, q: z.infer<typeof CharacteristicTemplateQuery>): Promise<CharacteristicTemplate[]> {
    return this.database.asUser(ctx, async (db) => {
      const result = await db.execute<Row>(sql`${sql.raw(SELECT)}
        where t.organisation_id = ${ctx.organisationId!}::uuid ${q.includeInactive ? sql`` : sql`and t.active`}
        order by lower(t.name)`);
      return result.rows.map(toTemplate);
    });
  }

  create(ctx: RequestContext, body: CreateCharacteristicTemplateBody): Promise<CharacteristicTemplate> {
    return this.database.asUser(ctx, async (db) => {
      const { sampling, reactions, ...fields } = body;
      const { values, problems } = normaliseCharacteristic({
        dataType: fields.dataType ?? 'variable',
        valueSource: fields.valueSource ?? 'plan',
        appliesTo: 'all',
        nominal: fields.nominal ?? null,
        lowerLimit: fields.lowerLimit ?? null,
        upperLimit: fields.upperLimit ?? null,
        unitCode: fields.unitCode ?? null,
        specKey: fields.specKey ?? null,
        spcEligible: fields.spcEligible ?? false,
        chartType: fields.chartType ?? null,
        subgroupSize: fields.subgroupSize ?? null,
      });
      this.check(problems);
      const { appliesTo: _applies, ...normalised } = values;
      const { columns, values: vals } = insertParts({ ...fields, ...normalised }, COLUMNS, { organisation_id: ctx.organisationId! });
      const created = await db.execute<{ id: string }>(sql`insert into public.characteristic_templates (${columns}) values (${vals}) returning id`);
      const id = created.rows[0].id;
      await this.saveRules(db, id, { sampling, reactions });
      return this.load(db, ctx, id);
    });
  }

  update(ctx: RequestContext, id: string, body: UpdateCharacteristicTemplateBody): Promise<CharacteristicTemplate> {
    return this.database.asUser(ctx, async (db) => {
      const current = await db.execute<Row>(sql`select * from public.characteristic_templates where id = ${id}::uuid and organisation_id = ${ctx.organisationId!}::uuid`);
      if (!current.rows.length) throw ApiError.notFound('characteristic_template_not_found', 'Characteristic template not found');
      const c = current.rows[0];
      const { sampling, reactions, ...fields } = body;
      const pick = <T>(key: keyof typeof fields, fallback: T): T => (fields[key] !== undefined ? (fields[key] as T) : fallback);
      const { values, problems } = normaliseCharacteristic({
        dataType: pick('dataType', c.data_type as CharacteristicTemplate['dataType']),
        valueSource: pick('valueSource', c.value_source as CharacteristicTemplate['valueSource']),
        appliesTo: 'all',
        nominal: pick('nominal', num(c.nominal)),
        lowerLimit: pick('lowerLimit', num(c.lower_limit)),
        upperLimit: pick('upperLimit', num(c.upper_limit)),
        unitCode: pick('unitCode', (c.unit_code as string) ?? null),
        specKey: pick('specKey', (c.spec_key as string) ?? null),
        spcEligible: pick('spcEligible', c.spc_eligible as boolean),
        chartType: pick('chartType', (c.chart_type as CharacteristicTemplate['chartType']) ?? null),
        subgroupSize: pick('subgroupSize', c.subgroup_size === null ? null : Number(c.subgroup_size)),
      });
      this.check(problems);
      const { appliesTo: _applies, ...normalised } = values;
      await db.execute(sql`update public.characteristic_templates set ${sql.join(assignments({ ...fields, ...normalised }, COLUMNS), sql`, `)}
        where id = ${id}::uuid`);
      await this.saveRules(db, id, { sampling, reactions });
      return this.load(db, ctx, id);
    });
  }

  private check(problems: string[]) {
    if (problems.length) {
      throw ApiError.badRequest('validation_failed', problems.join('. '), problems.map((message) => ({ path: '', message })));
    }
  }

  private async saveRules(db: Db, id: string, rules: { sampling?: unknown[]; reactions?: unknown[] }) {
    if (rules.sampling) {
      await db.execute(sql`update public.characteristic_templates set sampling = ${JSON.stringify(rules.sampling)}::jsonb where id = ${id}::uuid`);
    }
    if (rules.reactions) {
      await db.execute(sql`update public.characteristic_templates set reactions = ${JSON.stringify(rules.reactions)}::jsonb where id = ${id}::uuid`);
    }
  }

  private async load(db: Db, ctx: RequestContext, id: string): Promise<CharacteristicTemplate> {
    const result = await db.execute<Row>(sql`${sql.raw(SELECT)} where t.id = ${id}::uuid and t.organisation_id = ${ctx.organisationId!}::uuid`);
    if (!result.rows.length) throw ApiError.notFound('characteristic_template_not_found', 'Characteristic template not found');
    return toTemplate(result.rows[0]);
  }
}
