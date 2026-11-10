import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { iso, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { CatalogueService } from './core/catalogue.service';
import { mappingProblems } from './core/mapping';
import {
  CreateTemplateBody,
  SaveTemplateVersionBody,
  Template,
  TemplateBody,
  TemplateDetail,
  TemplateList,
  TemplateListQuery,
  TemplateVersion,
  TemplateVersionList,
  UpdateTemplateBody,
} from './integration-templates.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const person = (id: unknown, name: unknown) => (id ? { id: id as string, name: (name as string) ?? 'Unknown user' } : null);

const TEMPLATE_SELECT = `
  select t.*, ${personName('c')} as created_by_name, ${personName('a')} as archived_by_name,
         (select count(*) from public.integration_sync_runs r join public.integration_template_versions v on v.id = r.template_version_id where v.template_id = t.id) as run_count,
         (select max(r.requested_at) from public.integration_sync_runs r join public.integration_template_versions v on v.id = r.template_version_id where v.template_id = t.id) as last_used_at
    from public.integration_templates t
    left join public.profiles c on c.id = t.created_by
    left join public.profiles a on a.id = t.archived_by`;

const VERSION_SELECT = `
  select v.*, t.current_version, ${personName('p')} as created_by_name,
         (select count(*) from public.integration_sync_runs r where r.template_version_id = v.id) as run_count
    from public.integration_template_versions v
    join public.integration_templates t on t.id = v.template_id
    left join public.profiles p on p.id = v.created_by`;

const toTemplate = (r: Row): Template => ({
  id: r.id as string,
  entityType: r.entity_type as Template['entityType'],
  name: r.name as string,
  description: (r.description as string) ?? null,
  currentVersion: Number(r.current_version),
  archived: r.archived_at ? { at: iso(r.archived_at)!, by: person(r.archived_by, r.archived_by_name), reason: r.archive_reason as string } : null,
  createdBy: person(r.created_by, r.created_by_name),
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
  runCount: Number(r.run_count ?? 0),
  lastUsedAt: iso(r.last_used_at),
});

const toVersion = (r: Row): TemplateVersion => {
  const s = (r.settings as Record<string, unknown>) ?? {};
  return {
    version: Number(r.version),
    keyField: r.key_field as string,
    fields: (r.fields as Record<string, unknown>[]) ?? [],
    sourceSettings: (r.source_settings as Record<string, unknown>) ?? {},
    expectedColumns: (r.expected_columns as string[]) ?? [],
    settings: { writeMode: (s.writeMode as string) ?? 'add_only', matchExisting: !!s.matchExisting },
    reason: (r.reason as string) ?? null,
    current: Number(r.version) === Number(r.current_version),
    createdBy: person(r.created_by, r.created_by_name),
    createdAt: iso(r.created_at)!,
    runCount: Number(r.run_count ?? 0),
  };
};

/** Drop undefined keys so an unchanged body is recognised as unchanged by the database. */
const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/**
 * Organisation-wide import templates (UI2a, decisions T1 and T4). A template is a named, versioned mapping for one kind of record; every saved version is
 * frozen, and a run that uses a template is pinned to the version it used. The content is checked here against the field catalogue (including the
 * organisation's custom fields) before the database saves it; the database checks the shape, the reason and that something changed.
 */
@Injectable()
export class IntegrationTemplatesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly catalogues: CatalogueService,
  ) {}

  private async check(ctx: RequestContext, entityType: string, b: TemplateBody): Promise<string> {
    const catalogue = await this.catalogues.get(entityType as never, orgOf(ctx));
    if (!catalogue) throw new ApiError(409, 'integration_rule', 'There are no Fortress fields to map this kind of record to yet');
    const columns = b.expectedColumns?.length ? b.expectedColumns : undefined;
    const problems = mappingProblems(catalogue, { keyField: b.keyField, fields: b.fields }, columns);
    if (problems.length) throw new ApiError(409, 'integration_rule', problems[0], { problems });
    return JSON.stringify(
      clean({
        keyField: b.keyField,
        fields: b.fields.map((f) => clean(f as Record<string, unknown>)),
        sourceSettings: b.sourceSettings ? clean(b.sourceSettings) : undefined,
        expectedColumns: b.expectedColumns,
        settings: b.settings ? clean(b.settings) : undefined,
      }),
    );
  }

  private async load(db: Db, ctx: RequestContext, id: string): Promise<TemplateDetail> {
    const rows = await db.execute<Row>(sql`${sql.raw(TEMPLATE_SELECT)} where t.id = ${id}::uuid and t.organisation_id = ${orgOf(ctx)}::uuid`);
    if (!rows.rows[0]) throw ApiError.notFound('template_not_found', 'Template not found');
    const t = rows.rows[0];
    const v = await db.execute<Row>(sql`${sql.raw(VERSION_SELECT)} where v.template_id = ${id}::uuid and v.version = ${Number(t.current_version)}`);
    const manage = await db.execute<{ ok: boolean }>(sql`select app.has_permission(${orgOf(ctx)}::uuid, 'integrations.manage') as ok`);
    return { ...toTemplate(t), current: v.rows[0] ? toVersion(v.rows[0]) : null, canManage: !!manage.rows[0]?.ok };
  }

  list(ctx: RequestContext, q: TemplateListQuery): Promise<z.infer<typeof TemplateList>> {
    return this.database.asUser(ctx, async (db) => {
      const archived = q.archived === 'include' ? sql`` : q.archived === 'only' ? sql` and t.archived_at is not null` : sql` and t.archived_at is null`;
      const rows = await db.execute<Row>(sql`${sql.raw(TEMPLATE_SELECT)} where t.organisation_id = ${orgOf(ctx)}::uuid
        and (${q.entityType ?? null}::text is null or t.entity_type = ${q.entityType ?? null}) ${archived}
        order by t.entity_type, lower(t.name)`);
      return { data: rows.rows.map(toTemplate) };
    });
  }

  get(ctx: RequestContext, id: string): Promise<TemplateDetail> {
    return this.database.asUser(ctx, (db) => this.load(db, ctx, id));
  }

  async create(ctx: RequestContext, b: CreateTemplateBody): Promise<TemplateDetail> {
    const { entityType, name, description, ...body } = b;
    const json = await this.check(ctx, entityType, body);
    return this.database.asUser(ctx, async (db, client) => {
      const id = (await client.query('select app.create_integration_template($1::uuid, $2, $3, $4, $5::jsonb) as id', [orgOf(ctx), entityType, name, description ?? null, json])).rows[0].id as string;
      return this.load(db, ctx, id);
    });
  }

  update(ctx: RequestContext, id: string, b: UpdateTemplateBody): Promise<TemplateDetail> {
    return this.database.asUser(ctx, async (db, client) => {
      const cur = await this.load(db, ctx, id);
      const description = b.description === undefined ? cur.description : b.description;
      await client.query('select app.update_integration_template($1::uuid, $2, $3)', [id, b.name ?? cur.name, description ?? null]);
      return this.load(db, ctx, id);
    });
  }

  async saveVersion(ctx: RequestContext, id: string, b: SaveTemplateVersionBody): Promise<TemplateDetail> {
    const entityType = await this.database.asUser(ctx, async (db) => (await this.load(db, ctx, id)).entityType);
    const { reason, ...body } = b;
    const json = await this.check(ctx, entityType, body);
    return this.database.asUser(ctx, async (db, client) => {
      await client.query('select app.save_integration_template_version($1::uuid, $2::jsonb, $3)', [id, json, reason]);
      return this.load(db, ctx, id);
    });
  }

  versions(ctx: RequestContext, id: string): Promise<z.infer<typeof TemplateVersionList>> {
    return this.database.asUser(ctx, async (db) => {
      await this.load(db, ctx, id);
      const rows = await db.execute<Row>(sql`${sql.raw(VERSION_SELECT)} where v.template_id = ${id}::uuid order by v.version desc`);
      return {
        data: rows.rows.map((r) => {
          const { fields, sourceSettings: _s, expectedColumns: _e, ...v } = toVersion(r);
          return { ...v, fieldCount: fields.length };
        }),
      };
    });
  }

  version(ctx: RequestContext, id: string, n: number): Promise<TemplateVersion> {
    return this.database.asUser(ctx, async (db) => {
      await this.load(db, ctx, id);
      const rows = await db.execute<Row>(sql`${sql.raw(VERSION_SELECT)} where v.template_id = ${id}::uuid and v.version = ${n}`);
      if (!rows.rows[0]) throw ApiError.notFound('template_version_not_found', 'Template version not found');
      return toVersion(rows.rows[0]);
    });
  }

  /** Run one of the simple lifecycle functions, then answer with the template. */
  private command(ctx: RequestContext, id: string, text: string, params: unknown[]): Promise<TemplateDetail> {
    return this.database.asUser(ctx, async (db, client) => {
      await client.query(text, [id, ...params]);
      return this.load(db, ctx, id);
    });
  }

  archive(ctx: RequestContext, id: string, reason: string) {
    return this.command(ctx, id, 'select app.archive_integration_template($1::uuid, $2)', [reason]);
  }

  restore(ctx: RequestContext, id: string) {
    return this.command(ctx, id, 'select app.restore_integration_template($1::uuid)', []);
  }

  restoreVersion(ctx: RequestContext, id: string, version: number, reason: string) {
    return this.command(ctx, id, 'select app.restore_integration_template_version($1::uuid, $2::int, $3)', [version, reason]);
  }

  duplicate(ctx: RequestContext, id: string, name?: string): Promise<TemplateDetail> {
    return this.database.asUser(ctx, async (db, client) => {
      const copy = (await client.query('select app.duplicate_integration_template($1::uuid, $2) as id', [id, name ?? null])).rows[0].id as string;
      return this.load(db, ctx, copy);
    });
  }
}
