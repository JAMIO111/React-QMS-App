import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse } from '../common/validation';
import { DatabaseService } from '../database/database.service';
import { OrganisationScoped } from '../tenancy/organisation.guard';

/**
 * Records the header palette can find. Each kind names the permission that decides whether it is searched at all (a kind the caller may not
 * read is left out of the answer, never shown as zero) and the screen the front end opens (`recordPath` in `src/lib/commandPalette.js`).
 * Row-level security still decides which rows come back, as for every read.
 */
export const SEARCH_KINDS = ['ncr', 'capa', 'part', 'supplier', 'gauge', 'inspection', 'document'] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export const SearchQuery = z.object({
  q: z.string().trim().min(2, 'Type at least two characters').max(100),
  /** One kind only (the palette's category chip); without it every kind the caller may read answers with its first few. */
  kind: z.enum(SEARCH_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(25).default(5),
});

const Item = z.object({ id: z.string().uuid(), title: z.string(), subtitle: z.string().nullable(), status: z.string().nullable() });
export const SearchResult = z.object({
  q: z.string(),
  groups: z.array(z.object({ kind: z.enum(SEARCH_KINDS), total: z.number().int(), items: z.array(Item) })),
});
export type SearchResult = z.infer<typeof SearchResult>;

const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
const startPattern = (term: string) => `${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

type Row = Record<string, unknown>;
type Finder = (org: string, like: string, start: string, limit: number) => ReturnType<typeof sql>;

/** One query per kind: `id`, `title` (the reference or number people type), `subtitle`, `status` and `total` (all matches, not just the page). */
const FINDERS: Record<SearchKind, Finder> = {
  ncr: (org, like, start, limit) => sql`
    select n.id, n.reference as title, n.title as subtitle, n.stage as status, count(*) over() as total
      from public.nonconformances n left join public.parts p on p.id = n.part_id
     where n.organisation_id = ${org}::uuid and n.deleted_at is null
       and (n.reference ilike ${like} or n.title ilike ${like} or n.serial_number ilike ${like} or p.part_number ilike ${like})
     order by (n.reference ilike ${start}) desc, n.updated_at desc limit ${limit}`,
  capa: (org, like, start, limit) => sql`
    select c.id, c.reference as title, c.title as subtitle, c.stage as status, count(*) over() as total
      from public.capas c
     where c.organisation_id = ${org}::uuid and (c.reference ilike ${like} or c.title ilike ${like} or c.problem_statement ilike ${like})
     order by (c.reference ilike ${start}) desc, c.updated_at desc limit ${limit}`,
  part: (org, like, start, limit) => sql`
    select p.id, p.part_number as title, p.name as subtitle, case when p.active then null else 'inactive' end as status, count(*) over() as total
      from public.parts p
     where p.organisation_id = ${org}::uuid and (p.part_number ilike ${like} or p.name ilike ${like})
     order by (p.part_number ilike ${start}) desc, p.part_number limit ${limit}`,
  supplier: (org, like, start, limit) => sql`
    select s.id, s.code as title, coalesce(s.display_name, s.name) as subtitle, s.approval_status as status, count(*) over() as total
      from public.suppliers s
     where s.organisation_id = ${org}::uuid and (s.code ilike ${like} or s.name ilike ${like} or s.display_name ilike ${like})
     order by (s.code ilike ${start}) desc, s.name limit ${limit}`,
  gauge: (org, like, start, limit) => sql`
    select g.id, g.asset_number as title, g.description as subtitle, g.status, count(*) over() as total
      from public.gauges g
     where g.organisation_id = ${org}::uuid and g.deleted_at is null
       and (g.asset_number ilike ${like} or g.description ilike ${like} or g.serial_number ilike ${like})
     order by (g.asset_number ilike ${start}) desc, g.asset_number limit ${limit}`,
  inspection: (org, like, start, limit) => sql`
    select i.id, i.reference as title, p.part_number as subtitle, i.status, count(*) over() as total
      from public.inspection_records i left join public.parts p on p.id = i.part_id
     where i.organisation_id = ${org}::uuid and (i.reference ilike ${like} or p.part_number ilike ${like})
     order by (i.reference ilike ${start}) desc, i.updated_at desc limit ${limit}`,
  document: (org, like, start, limit) => sql`
    select d.id, d.number as title, d.title as subtitle, d.status, count(*) over() as total
      from public.documents d
     where d.organisation_id = ${org}::uuid and d.status <> 'discarded' and (d.number ilike ${like} or d.title ilike ${like})
     order by (d.number ilike ${start}) desc, d.updated_at desc limit ${limit}`,
};

@Injectable()
export class SearchService {
  constructor(private readonly database: DatabaseService) {}

  find(ctx: RequestContext, q: { q: string; kind?: SearchKind; limit: number }): Promise<SearchResult> {
    const org = ctx.organisationId!;
    return this.database.asUser(ctx, async (db) => {
      // The same checks the areas' own routes make: any scope where a register admits any scope, organisation-wide otherwise.
      const can = (await db.execute<Row>(sql`
        select app.has_permission_somewhere(${org}::uuid, 'ncr.read') as ncr,
               app.has_permission(${org}::uuid, 'capa.read') as capa,
               app.has_permission(${org}::uuid, 'master_data.read') as part,
               app.has_permission(${org}::uuid, 'supplier_quality.read') as supplier,
               app.has_permission_somewhere(${org}::uuid, 'calibration.read') as gauge,
               app.has_permission_somewhere(${org}::uuid, 'inspection.read') as inspection,
               app.has_permission(${org}::uuid, 'documentation.read') as document`)).rows[0] ?? {};
      const like = likePattern(q.q);
      const start = startPattern(q.q);
      const kinds = SEARCH_KINDS.filter((k) => can[k] === true && (!q.kind || q.kind === k));
      const groups: SearchResult['groups'] = [];
      for (const kind of kinds) {
        const rows = (await db.execute<Row>(FINDERS[kind](org, like, start, q.limit))).rows;
        if (rows.length === 0) continue;
        groups.push({
          kind,
          total: Number(rows[0].total ?? rows.length),
          items: rows.map((r) => ({
            id: String(r.id),
            title: String(r.title ?? ''),
            subtitle: r.subtitle == null ? null : String(r.subtitle),
            status: r.status == null ? null : String(r.status),
          })),
        });
      }
      return { q: q.q, groups };
    });
  }
}

@ApiTags('search')
@ApiBearerAuth()
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  /** Finds records by reference, number, name or title for the header palette: only kinds the caller may read, rows limited by row-level security. */
  @Get()
  @OrganisationScoped()
  @ApiQuery({ name: 'q', description: 'At least two characters' })
  @ApiQuery({ name: 'kind', required: false, description: `One of ${SEARCH_KINDS.join(', ')}` })
  @ApiQuery({ name: 'limit', required: false, description: 'Rows per kind, 1 to 25, default 5' })
  @ApiOkResponse({ schema: openApiSchema(SearchResult) })
  find(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.search.find(ctx, parse(SearchQuery, query));
  }
}
