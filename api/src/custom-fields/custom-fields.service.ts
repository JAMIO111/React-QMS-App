import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { iso, num, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import {
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_ENTITY_LABELS,
  CUSTOM_FIELD_LIMIT,
  CUSTOM_FIELD_STAGES,
  CreateCustomFieldBody,
  CustomFieldDefinition,
  CustomFieldEntity,
  CustomValues,
  CustomValuesInput,
  UpdateCustomFieldBody,
} from './custom-fields.schemas';
import { readCustomValues } from './custom-values';

const toDefinition = (r: Row): CustomFieldDefinition => ({
  id: r.id as string,
  entityType: r.entity_type as CustomFieldEntity,
  key: r.key as string,
  label: r.label as string,
  fieldType: r.field_type as CustomFieldDefinition['fieldType'],
  helpText: (r.help_text as string) ?? null,
  section: (r.section as string) ?? null,
  position: Number(r.position),
  requiredAt: r.required_at as string,
  options: ((r.options as CustomFieldDefinition['options']) ?? []).map((o) => ({ key: o.key, label: o.label, active: o.active !== false })),
  decimals: num(r.number_decimals),
  unit: (r.number_unit as string) ?? null,
  min: num(r.number_min),
  max: num(r.number_max),
  active: Boolean(r.active),
  retiredAt: iso(r.retired_at),
  retireReason: (r.retire_reason as string) ?? null,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

/** Only the keys a person sent, in the database's names (absent = leave as it is). */
function fieldJson(body: Partial<CreateCustomFieldBody> & UpdateCustomFieldBody) {
  const out: Record<string, unknown> = { label: body.label };
  const copy: [keyof CreateCustomFieldBody, string][] = [
    ['fieldType', 'fieldType'], ['key', 'key'], ['helpText', 'helpText'], ['section', 'section'], ['requiredAt', 'requiredAt'],
    ['options', 'options'], ['decimals', 'decimals'], ['unit', 'unit'], ['min', 'min'], ['max', 'max'],
  ];
  for (const [from, to] of copy) if ((body as Record<string, unknown>)[from] !== undefined) out[to] = (body as Record<string, unknown>)[from];
  return out;
}

/**
 * Custom field definitions (every member reads them; custom_fields.manage changes them) and values (the record's own permissions).
 * Every write is a database function; the database checks types, limits, locks and required fields.
 */
@Injectable()
export class CustomFieldsService {
  constructor(private readonly database: DatabaseService) {}

  list(ctx: RequestContext, entityType?: CustomFieldEntity, includeRetired = false) {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<Row>(sql`
        select * from public.custom_field_definitions
        where organisation_id = ${ctx.organisationId}::uuid
          and (${entityType ?? null}::text is null or entity_type = ${entityType ?? null})
          and (${includeRetired} or active)
        order by entity_type, position, label`);
      const counts = await db.execute<{ entity_type: string; n: number }>(sql`
        select entity_type, count(*)::int as n from public.custom_field_definitions
        where organisation_id = ${ctx.organisationId}::uuid and active group by entity_type`);
      const byEntity = new Map(counts.rows.map((c) => [c.entity_type, Number(c.n)]));
      return {
        data: res.rows.map(toDefinition),
        limit: CUSTOM_FIELD_LIMIT,
        entities: CUSTOM_FIELD_ENTITIES.map((e) => ({
          entityType: e,
          label: CUSTOM_FIELD_ENTITY_LABELS[e],
          stages: CUSTOM_FIELD_STAGES[e] ?? [],
          activeCount: byEntity.get(e) ?? 0,
        })),
      };
    });
  }

  private async one(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<Row>(sql`select * from public.custom_field_definitions where id = ${id}::uuid and organisation_id = ${ctx.organisationId}::uuid`);
      if (res.rows.length === 0) throw ApiError.notFound();
      return toDefinition(res.rows[0]);
    });
  }

  async create(ctx: RequestContext, body: CreateCustomFieldBody) {
    const id = await this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ id: string }>(sql`
        select app.save_custom_field(${ctx.organisationId}::uuid, ${body.entityType}, ${JSON.stringify(fieldJson(body))}::jsonb) as id`);
      return res.rows[0].id;
    });
    return this.one(ctx, id);
  }

  async update(ctx: RequestContext, id: string, body: UpdateCustomFieldBody) {
    const current = await this.one(ctx, id);
    await this.database.asUser(ctx, (db) =>
      db.execute(sql`select app.save_custom_field(${ctx.organisationId}::uuid, ${current.entityType}, ${JSON.stringify(fieldJson(body))}::jsonb, ${id}::uuid)`));
    return this.one(ctx, id);
  }

  async retire(ctx: RequestContext, id: string, reason: string) {
    await this.one(ctx, id);
    await this.database.asUser(ctx, (db) => db.execute(sql`select app.retire_custom_field(${id}::uuid, ${reason})`));
    return this.one(ctx, id);
  }

  async reactivate(ctx: RequestContext, id: string) {
    await this.one(ctx, id);
    await this.database.asUser(ctx, (db) => db.execute(sql`select app.reactivate_custom_field(${id}::uuid)`));
    return this.one(ctx, id);
  }

  async reorder(ctx: RequestContext, entityType: CustomFieldEntity, ids: string[]) {
    await this.database.asUser(ctx, (db) =>
      db.execute(sql`select app.reorder_custom_fields(${ctx.organisationId}::uuid, ${entityType}, string_to_array(${ids.join(',')}, ',')::uuid[])`));
    return this.list(ctx, entityType, true);
  }

  values(ctx: RequestContext, entityType: CustomFieldEntity, recordId: string) {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ v: CustomValues }>(sql`select app.get_custom_values(${entityType}, ${recordId}::uuid) as v`);
      return { entityType, recordId, values: res.rows[0]?.v ?? {} };
    });
  }

  setValues(ctx: RequestContext, entityType: CustomFieldEntity, recordId: string, values: CustomValuesInput) {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ v: CustomValues }>(sql`select app.set_custom_values(${entityType}, ${recordId}::uuid, ${JSON.stringify(values)}::jsonb) as v`);
      return { entityType, recordId, values: res.rows[0]?.v ?? {} };
    });
  }

  batch(ctx: RequestContext, entityType: CustomFieldEntity, ids: string[]) {
    return this.database.asUser(ctx, async (db) => {
      const map = await readCustomValues(db, entityType, ids);
      return { entityType, data: Object.fromEntries(map) };
    });
  }
}
