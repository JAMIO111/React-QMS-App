import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { iso, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { IntegrationsService } from './integrations.service';
import { DatabaseService, Db } from '../database/database.service';
import { CatalogueService } from './core/catalogue.service';
import { applyFilter, describeFilter, describeRule, filterProblems, isActive, normaliseFilter, RecordFilter } from './core/filters';
import { checkFormula, runFormula } from './core/formula';
import { applyMapping, cell, fieldColumns, mappingProblems, rawValue } from './core/mapping';
import { referenceProblem } from './core/references';
import { catalogueForSettings, REF_KIND_WORDS } from './core/catalogue';
import {
  CheckFormulaBody,
  CreateTemplateBody,
  FormulaCheckResult,
  PreviewTemplateBody,
  ReferenceValues,
  ReferenceValuesQuery,
  SaveTemplateVersionBody,
  Template,
  TemplateBody,
  TemplateDetail,
  TemplateList,
  TemplateListQuery,
  TemplatePreview,
  FilterPreview,
  PreviewFilterBody,
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
    settings: {
      writeMode: (s.writeMode as string) ?? 'add_only',
      matchExisting: !!s.matchExisting,
      ...('costsOnClosed' in s ? { costsOnClosed: !!s.costsOnClosed, missingDate: s.missingDate === 'nc_detected' ? ('nc_detected' as const) : ('reject' as const) } : {}),
      ...(s.filters ? { filters: s.filters as TemplateVersion['settings']['filters'] } : {}),
    },
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
    private readonly integrations: IntegrationsService,
  ) {}

  private async check(ctx: RequestContext, entityType: string, b: TemplateBody): Promise<string> {
    const full = await this.catalogues.get(entityType as never, orgOf(ctx));
    if (!full) throw new ApiError(409, 'integration_rule', 'There are no Fortress fields to map this kind of record to yet');
    // A cost template that gives a line with no date the date its non-conformance was detected does not need the date mapped.
    const catalogue = catalogueForSettings(full, b.settings);
    const columns = b.expectedColumns?.length ? b.expectedColumns : undefined;
    const problems = mappingProblems(catalogue, { keyField: b.keyField, fields: b.fields }, columns);
    // A record filter is tidied (empty rules dropped; no rules and no formula means no filter) and checked against the source's columns and the formula language.
    const filter = b.settings?.filters ? normaliseFilter(b.settings.filters as RecordFilter) : null;
    if (filter) problems.push(...filterProblems(filter, columns));
    if (problems.length) throw new ApiError(409, 'integration_rule', problems[0], { problems });
    const settings = b.settings ? { ...b.settings, filters: filter ?? undefined } : undefined;
    return JSON.stringify(
      clean({
        keyField: b.keyField,
        fields: b.fields.map((f) => clean(f as Record<string, unknown>)),
        sourceSettings: b.sourceSettings ? clean(b.sourceSettings) : undefined,
        expectedColumns: b.expectedColumns,
        settings: settings ? clean(settings) : undefined,
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

  /**
   * How the first rows of a file come out with an unsaved template: per field the value taken, the value after each step, the imported value and the error;
   * plus the column check. Writes nothing. Links to other records are shown as written (they are matched when the import runs).
   */
  private async sampleOf(ctx: RequestContext, connectionId: string, entityType: string, wanted?: number[]) {
    const sample = await this.integrations.sample(ctx, connectionId, entityType);
    return { headers: sample.columns, rows: wanted?.length ? sample.rows.filter((r) => wanted.includes(r.r)) : sample.rows };
  }

  async preview(ctx: RequestContext, b: PreviewTemplateBody): Promise<TemplatePreview> {
    const full = await this.catalogues.get(b.entityType, orgOf(ctx));
    if (!full) throw new ApiError(409, 'integration_rule', 'There are no Fortress fields to map this kind of record to yet');
    // The preview treats a cost line's date as the template does: optional when a line with no date takes the date its non-conformance was detected.
    const catalogue = catalogueForSettings(full, b.settings);
    let connectionId: string | null = b.connectionId ?? null;
    const { headers, rows } = b.connectionId
      ? await this.sampleOf(ctx, b.connectionId, b.entityType, b.rows)
      : await this.database.asUser(ctx, async (db) => {
      const f = await db.execute<Row>(sql`select headers, status, connection_id from public.integration_files where id = ${b.fileId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (f.rows[0]) connectionId = f.rows[0].connection_id as string;
      if (!f.rows[0]) throw ApiError.notFound('file_not_found', 'File not found');
      if (f.rows[0].status !== 'parsed') throw new ApiError(409, 'integration_rule', 'That file could not be read, or its rows have been cleared');
      const wanted = b.rows?.length ? b.rows : null;
      const found = await db.execute<{ v: { r: number; v: Record<string, string> } }>(sql`
        select x.v from public.integration_file_chunks c cross join lateral jsonb_array_elements(c.rows) as x(v)
         where c.file_id = ${b.fileId}::uuid
           and (${wanted === null} or (x.v ->> 'r')::int = any(string_to_array(${(wanted ?? []).join(',')}, ',')::int[]))
         order by c.seq, (x.v ->> 'r')::int limit 20`);
      return { headers: (f.rows[0].headers as string[]) ?? [], rows: found.rows.map((r) => r.v) };
    });
    const byKey = new Map(catalogue.fields.map((f) => [f.key, f]));
    const spec = { keyField: b.keyField, fields: b.fields };
    const headerSet = new Set(headers);
    const used = new Map<string, { fields: string[]; blocking: boolean }>();
    const use = (column: string, label: string, blocking: boolean) => {
      const u = used.get(column) ?? { fields: [], blocking: false };
      if (!u.fields.includes(label)) u.fields.push(label);
      u.blocking ||= blocking;
      used.set(column, u);
    };
    if (b.keyField) use(b.keyField, 'Key column', true);
    for (const m of b.fields) {
      const f = byKey.get(m.target);
      for (const c of fieldColumns(m)) use(c, f?.label ?? m.target, !!f?.required);
    }
    // What each row makes of the mapping, once: the shown rows get their errors from it, and so do the link checks below.
    const outs = rows.map((r) => applyMapping(catalogue, spec, r.v));
    // The template's record filter: a row it leaves out would not be imported, so it says why instead of showing the mapping's errors for it.
    const filter = b.settings?.filters ? normaliseFilter(b.settings.filters as RecordFilter) : null;
    const verdicts = rows.map((r) => (filter ? applyFilter(filter, r.v) : null));
    const references = await this.checkReferences(ctx, catalogue, b, byKey, connectionId, rows, outs);
    return {
      references,
      columns: headers,
      columnCheck: {
        missing: [...used].filter(([c]) => !headerSet.has(c)).map(([column, u]) => ({ column, fields: u.fields, blocking: u.blocking })),
        unused: headers.filter((h) => !used.has(h)),
      },
      problems: mappingProblems(catalogue, spec, headers),
      rows: rows.map((r, i) => {
        const out = outs[i];
        return {
          row: r.r,
          externalId: out.externalId,
          filteredOut: verdicts[i] && !verdicts[i]!.keep ? (verdicts[i]!.error ?? verdicts[i]!.reason ?? null) : null,
          errors: verdicts[i] && !verdicts[i]!.keep && !verdicts[i]!.error ? [] : out.errors,
          fields: b.fields.filter((m) => byKey.has(m.target)).map((m) => {
            const trail: string[] = [];
            const taken = rawValue(m, r.v, trail);
            const err = 'error' in taken ? taken.error : out.errors.find((e) => e.field === m.target)?.message ?? null;
            return {
              target: m.target,
              label: byKey.get(m.target)!.label,
              taken: trail.length ? trail[0] : null,
              steps: trail.slice(1),
              value: err ? null : (out.canonical[m.target] ?? null),
              error: err,
            };
          }),
        };
      }),
    };
  }

  /** The rows of a file that links are checked over (the first 1,000), as {row, values}. */
  private async fileRows(ctx: RequestContext, fileId: string): Promise<Array<{ r: number; v: Record<string, string> }>> {
    return this.database.asUser(ctx, async (db) => {
      const found = await db.execute<{ v: { r: number; v: Record<string, string> } }>(sql`
        select x.v from public.integration_file_chunks c cross join lateral jsonb_array_elements(c.rows) as x(v)
         where c.file_id = ${fileId}::uuid and c.organisation_id = ${orgOf(ctx)}::uuid order by c.seq, (x.v ->> 'r')::int limit 1000`);
      return found.rows.map((r) => r.v);
    });
  }

  /**
   * What a record filter does to the source (docs/import-filters-plan.md, F1): how many records it keeps and how many each rule matches, with a few records of each
   * kind. A file is read in full (every parsed row); an API or a database gives only the sample it gives for mapping, and the answer says so. Writes nothing.
   */
  async previewFilter(ctx: RequestContext, b: PreviewFilterBody): Promise<FilterPreview> {
    let headers: string[];
    let rows: Array<{ r: number; v: Record<string, string> }>;
    let complete: boolean;
    if (b.connectionId) {
      const sample = await this.sampleOf(ctx, b.connectionId, b.entityType);
      headers = sample.headers;
      rows = sample.rows;
      complete = false;
    } else {
      const read = await this.database.asUser(ctx, async (db) => {
        const f = await db.execute<Row>(sql`select headers, status from public.integration_files where id = ${b.fileId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
        if (!f.rows[0]) throw ApiError.notFound('file_not_found', 'File not found');
        if (f.rows[0].status !== 'parsed') throw new ApiError(409, 'integration_rule', 'That file could not be read, or its rows have been cleared');
        const chunks = await db.execute<{ rows: Array<{ r: number; v: Record<string, string> }> }>(sql`select c.rows from public.integration_file_chunks c where c.file_id = ${b.fileId}::uuid order by c.seq`);
        return { headers: (f.rows[0].headers as string[]) ?? [], rows: chunks.rows.flatMap((c) => c.rows) };
      });
      headers = read.headers;
      rows = read.rows;
      complete = true;
    }
    const filter = normaliseFilter(b.filter as RecordFilter);
    const problems = filter ? filterProblems(filter, headers) : [];
    const empty: FilterPreview = {
      columns: headers, scanned: rows.length, complete, kept: rows.length, leftOut: 0, rules: [], words: 'No filter: every record is read', problems, errors: { count: 0, first: null }, samples: { kept: [], leftOut: [] },
    };
    if (!filter || problems.length) return { ...empty, kept: problems.length ? 0 : rows.length };
    const counts = filter.rules.map(() => 0);
    const looksAt = new Set(filter.rules.map((r) => r.column));
    const show = (r: { r: number; v: Record<string, string> }) => {
      const cols = [...new Set([...looksAt, ...headers])].filter((c) => headers.includes(c)).slice(0, 12);
      return { row: r.r, values: Object.fromEntries(cols.map((c) => [c, String(r.v[c] ?? '').slice(0, 100)])) };
    };
    let kept = 0;
    let left = 0;
    let errorCount = 0;
    let firstError: string | null = null;
    const sample = { kept: [] as ReturnType<typeof show>[], leftOut: [] as ReturnType<typeof show>[] };
    for (const r of rows) {
      const out = applyFilter(filter, r.v);
      out.matched.forEach((m, i) => { if (m) counts[i] += 1; });
      if (out.error) {
        errorCount += 1;
        firstError ??= out.error;
        left += 1;
        if (sample.leftOut.length < 5) sample.leftOut.push(show(r));
      } else if (out.keep) {
        kept += 1;
        if (sample.kept.length < 5) sample.kept.push(show(r));
      } else {
        left += 1;
        if (sample.leftOut.length < 5) sample.leftOut.push(show(r));
      }
    }
    return {
      columns: headers,
      scanned: rows.length,
      complete,
      kept,
      leftOut: left,
      rules: filter.rules.map((rule, i) => ({ column: rule.column, words: describeRule(rule), matched: counts[i] })),
      words: describeFilter(filter),
      problems,
      errors: { count: errorCount, first: firstError },
      samples: sample,
    };
  }

  /**
   * Check the link fields of a mapping against what exists in Fortress while it is being built: over up to 1,000 rows of the file (the rows shown, or the
   * sample of an API), by the same rules the import uses. A value with no record puts the reason on the shown rows too. Never stops the preview: when the
   * check cannot be made (no right to read integrations) the preview simply has no link results.
   */
  private async checkReferences(
    ctx: RequestContext,
    catalogue: NonNullable<Awaited<ReturnType<CatalogueService['get']>>>,
    b: PreviewTemplateBody,
    byKey: Map<string, (typeof catalogue.fields)[number]>,
    connectionId: string | null,
    shown: Array<{ r: number; v: Record<string, string> }>,
    shownOuts: Array<ReturnType<typeof applyMapping>>,
  ): Promise<TemplatePreview['references']> {
    const linked = b.fields.filter((m) => byKey.get(m.target)?.ref);
    if (!linked.length) return [];
    const spec = { keyField: b.keyField, fields: b.fields };
    const wide = b.fileId ? await this.fileRows(ctx, b.fileId).catch(() => shown) : shown;
    const outs = wide === shown ? shownOuts : wide.map((r) => applyMapping(catalogue, spec, r.v));
    const text = (v: unknown): string | null => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
    const result: TemplatePreview['references'] = [];
    for (const m of linked) {
      const f = byKey.get(m.target)!;
      const mode: 'code' | 'source' = m.match === 'source' && f.ref!.source && connectionId ? 'source' : 'code';
      const counts = new Map<string, number>();
      for (const o of outs) {
        const v = text(o.canonical[f.key]);
        if (v && !o.errors.some((e) => e.field === f.key)) counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      for (const o of shownOuts) {
        const v = text(o.canonical[f.key]);
        if (v && !counts.has(v)) counts.set(v, 1);
      }
      const values = [...counts.keys()];
      const checked = values.slice(0, 2000);
      let found: Record<string, string> = {};
      if (checked.length) {
        try {
          found = await this.database.asUser(ctx, async (_db, client) =>
            (await client.query('select app.integration_reference_check($1::uuid, $2, $3, $4::uuid, $5::text[]) as r', [orgOf(ctx), f.ref!.kind, mode, connectionId, checked])).rows[0].r as Record<string, string>,
          );
        } catch {
          continue;
        }
      }
      const bad = checked.filter((v) => !found[v] || found[v] === 'ambiguous');
      for (const o of shownOuts) {
        const v = text(o.canonical[f.key]);
        if (v && checked.includes(v) && (!found[v] || found[v] === 'ambiguous') && !o.errors.some((e) => e.field === f.key)) {
          o.errors.push({ field: f.key, message: referenceProblem(f, mode, v, found[v] === 'ambiguous') });
        }
      }
      result.push({
        target: f.key,
        label: f.label,
        kind: f.ref!.kind,
        word: REF_KIND_WORDS[f.ref!.kind],
        mode,
        checked: outs.length,
        distinct: values.length,
        missing: bad.filter((v) => !found[v]).length,
        ambiguous: bad.filter((v) => found[v] === 'ambiguous').length,
        examples: bad
          .sort((x, y) => (counts.get(y) ?? 0) - (counts.get(x) ?? 0) || x.localeCompare(y))
          .slice(0, 10)
          .map((v) => ({ value: v, reason: found[v] === 'ambiguous' ? ('ambiguous' as const) : ('missing' as const), rows: counts.get(v) ?? 0 })),
        truncated: values.length > checked.length,
      });
    }
    return result;
  }

  /** The values a link field can take, to choose from: the codes that exist in Fortress with their names (search and paging). */
  async referenceValues(ctx: RequestContext, q: ReferenceValuesQuery): Promise<z.infer<typeof ReferenceValues>> {
    const r = await this.database.asUser(ctx, async (_db, client) =>
      (await client.query('select app.integration_reference_values($1::uuid, $2, $3, $4::int, $5::int) as r', [orgOf(ctx), q.kind, q.q ?? null, q.limit, q.offset])).rows[0].r as { total: number; data: z.infer<typeof ReferenceValues>['data'] },
    );
    return { kind: q.kind, word: REF_KIND_WORDS[q.kind], total: r.total, data: r.data };
  }

  /** Read a formula (and check its columns when the file's are given); work it out on a sample row when one is given. */
  checkFormula(b: CheckFormulaBody): z.infer<typeof FormulaCheckResult> {
    const { tree: _tree, ...check } = checkFormula(b.formula, b.columns ?? null);
    let result: z.infer<typeof FormulaCheckResult>['result'] = null;
    if (b.sample && !check.error?.position) {
      const sample = b.sample;
      const r = runFormula(b.formula, (c) => cell(sample, c));
      result = 'error' in r ? { value: null, error: r.error } : { value: r.value, error: null };
    }
    return { ...check, result };
  }
}
