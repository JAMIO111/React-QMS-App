import { Controller, Get, Injectable } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { Row, personName } from '../calibration/calibration.service';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema } from '../common/validation';
import { DatabaseService } from '../database/database.service';
import { OrganisationScoped } from '../tenancy/organisation.guard';

const n = (v: unknown) => Number(v ?? 0);
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

export const KINDS = ['parts', 'partFamilies', 'machines', 'customers', 'suppliers', 'employees'] as const;
const Kind = z.enum(KINDS);
const Count = z.object({ key: z.string(), label: z.string(), count: z.number() });

export const MasterDataDashboard = z.object({
  asOf: z.string(),
  entities: z.array(z.object({ kind: Kind, total: z.number(), active: z.number(), added30Days: z.number() })),
  /** Data-quality checks: how many records fail each. Zero means healthy; none are hidden. */
  attention: z.array(z.object({ key: z.string(), label: z.string(), kind: Kind, count: z.number(), of: z.number() })),
  growth: z.array(z.object({ start: z.string() }).catchall(z.number())),
  partsByFamily: z.array(Count),
  machinesBySite: z.array(Count),
  employeesByDepartment: z.array(Count),
  revisionsByStatus: z.array(Count),
  recent: z.array(z.object({ kind: Kind, id: z.string().uuid(), label: z.string(), action: z.enum(['added', 'changed']), at: z.string(), by: z.string().nullable() })),
  /** The transactional outbox every module writes to, for connectors to consume. Only for people with audit.read. */
  events: z.object({
    available: z.boolean(),
    last24Hours: z.number(),
    waiting: z.number(),
    oldestWaitingAt: z.string().nullable(),
    byType: z.array(Count),
    recent: z.array(z.object({ id: z.string().uuid(), type: z.string(), entityType: z.string(), at: z.string(), processedAt: z.string().nullable(), by: z.string().nullable() })),
  }),
});
export type MasterDataDashboard = z.infer<typeof MasterDataDashboard>;

/** Grouped counts, biggest first, the tail folded into "Other" so a long list stays readable. */
const top = (rows: Row[], limit: number, other: string): z.infer<typeof Count>[] => {
  const all = rows.map((r) => ({ key: (r.key as string) ?? 'none', label: r.label as string, count: n(r.count) })).filter((r) => r.count > 0);
  const named = all.filter((r) => r.key !== 'none').sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const none = all.find((r) => r.key === 'none');
  const shown = named.slice(0, limit);
  const rest = named.slice(limit).reduce((s, r) => s + r.count, 0);
  return [...shown, ...(rest ? [{ key: 'other', label: other, count: rest }] : []), ...(none ? [none] : [])];
};

/**
 * The data-quality checks over active records: how many fail each one. Shared with the home page (`GET /home-dashboard`), so the two cannot disagree.
 * `run` executes a query and returns its rows (inside the caller's transaction, under RLS).
 */
export const dataQualityChecks = async (run: (query: ReturnType<typeof sql>) => Promise<Row[]>, org: string) => {
  const [att] = await run(sql`
    select
      (select count(*) from public.parts p where p.organisation_id = ${org}::uuid and p.active
         and not exists (select 1 from public.part_revisions r where r.part_id = p.id and r.status = 'released'))::int as no_release,
      (select count(*) from public.parts p where p.organisation_id = ${org}::uuid and p.active and p.part_family_id is null)::int as no_family,
      (select count(*) from public.parts p where p.organisation_id = ${org}::uuid and p.active
         and not exists (select 1 from public.part_customers c where c.part_id = p.id))::int as no_customer,
      (select count(*) from public.machines m where m.organisation_id = ${org}::uuid and m.active and m.site_id is null)::int as no_site,
      (select count(*) from public."Employees" e where e.organisation_id = ${org}::uuid and e.active and e.department_id is null)::int as no_department`);
  return [
    { key: 'parts_without_release', label: 'Active parts with no released revision', kind: 'parts' as const, count: n(att.no_release) },
    { key: 'parts_without_family', label: 'Active parts with no part family', kind: 'parts' as const, count: n(att.no_family) },
    { key: 'parts_without_customer', label: 'Active parts with no customer', kind: 'parts' as const, count: n(att.no_customer) },
    { key: 'machines_without_site', label: 'Active machines with no site', kind: 'machines' as const, count: n(att.no_site) },
    { key: 'employees_without_department', label: 'Active employees with no department', kind: 'employees' as const, count: n(att.no_department) },
  ];
};

@Injectable()
export class MasterDataDashboardService {
  constructor(private readonly database: DatabaseService) {}

  get(ctx: RequestContext): Promise<MasterDataDashboard> {
    const org = ctx.organisationId!;
    return this.database.asUser(ctx, async (db) => {
      const q = async (query: ReturnType<typeof sql>) => (await db.execute<Row>(query)).rows;
      const entities = await q(sql`
        select 'parts' as kind, count(*)::int total, count(*) filter (where active)::int active, count(*) filter (where created_at >= now() - interval '30 days')::int added from public.parts where organisation_id = ${org}::uuid
        union all select 'partFamilies', count(*)::int, count(*) filter (where active)::int, count(*) filter (where created_at >= now() - interval '30 days')::int from public.part_families where organisation_id = ${org}::uuid
        union all select 'machines', count(*)::int, count(*) filter (where active)::int, count(*) filter (where created_at >= now() - interval '30 days')::int from public.machines where organisation_id = ${org}::uuid
        union all select 'customers', count(*)::int, count(*) filter (where active)::int, count(*) filter (where created_at >= now() - interval '30 days')::int from public.customers where organisation_id = ${org}::uuid
        union all select 'suppliers', count(*)::int, count(*) filter (where active)::int, count(*) filter (where created_at >= now() - interval '30 days')::int from public.suppliers where organisation_id = ${org}::uuid
        union all select 'employees', count(*)::int, count(*) filter (where active)::int, count(*) filter (where created_at >= now() - interval '30 days')::int from public."Employees" where organisation_id = ${org}::uuid`);
      const byKind = Object.fromEntries(entities.map((r) => [r.kind as string, r]));
      const activeOf = (k: string) => n(byKind[k]?.active);

      const attention = (await dataQualityChecks(q, org)).map((c) => ({ ...c, of: activeOf(c.kind) }));

      // Twelve weeks (Monday starts), every week present even when nothing was added.
      const growthRows = await q(sql`
        with weeks as (select generate_series(date_trunc('week', now()) - interval '11 weeks', date_trunc('week', now()), interval '1 week')::date as start),
        made as (
          select 'parts' as kind, created_at from public.parts where organisation_id = ${org}::uuid
          union all select 'partFamilies', created_at from public.part_families where organisation_id = ${org}::uuid
          union all select 'machines', created_at from public.machines where organisation_id = ${org}::uuid
          union all select 'customers', created_at from public.customers where organisation_id = ${org}::uuid
          union all select 'suppliers', created_at from public.suppliers where organisation_id = ${org}::uuid
          union all select 'employees', created_at from public."Employees" where organisation_id = ${org}::uuid
        )
        select to_char(w.start, 'YYYY-MM-DD') as start, m.kind, count(m.kind)::int as count
          from weeks w left join made m on date_trunc('week', m.created_at)::date = w.start
         group by w.start, m.kind order by w.start`);
      const growth: Record<string, string | number>[] = [];
      for (const r of growthRows) {
        let week = growth.find((g) => g.start === r.start);
        if (!week) {
          week = { start: r.start as string, ...Object.fromEntries(KINDS.map((k) => [k, 0])) };
          growth.push(week);
        }
        if (r.kind) week[r.kind as string] = n(r.count);
      }

      const partsByFamily = top(
        await q(sql`select coalesce(f.id::text, 'none') as key, coalesce(f.code || ' · ' || f.name, 'No family') as label, count(*)::int as count
                      from public.parts p left join public.part_families f on f.id = p.part_family_id where p.organisation_id = ${org}::uuid and p.active group by 1, 2`),
        8,
        'Other families',
      );
      const machinesBySite = top(
        await q(sql`select coalesce(s.id::text, 'none') as key, coalesce(s.name, 'No site') as label, count(*)::int as count
                      from public.machines m left join public.sites s on s.id = m.site_id where m.organisation_id = ${org}::uuid and m.active group by 1, 2`),
        8,
        'Other sites',
      );
      const employeesByDepartment = top(
        await q(sql`select coalesce(d.id::text, 'none') as key, coalesce(d.name, 'No department') as label, count(*)::int as count
                      from public."Employees" e left join public.departments d on d.id = e.department_id where e.organisation_id = ${org}::uuid and e.active group by 1, 2`),
        8,
        'Other departments',
      );
      const revisionsByStatus = (await q(sql`select status as key, status as label, count(*)::int as count from public.part_revisions where organisation_id = ${org}::uuid group by status`)).map((r) => ({
        key: r.key as string,
        label: r.label as string,
        count: n(r.count),
      }));

      const recent = (
        await q(sql`
          select * from (
            select 'parts' as kind, x.id, x.part_number as label, greatest(x.created_at, x.updated_at) as at, (x.updated_at > x.created_at + interval '2 seconds') as changed,
                   ${sql.raw(personName('pr'))} as by_name from public.parts x left join public.profiles pr on pr.id = coalesce(x.updated_by, x.created_by) where x.organisation_id = ${org}::uuid
            union all select 'partFamilies', x.id, x.code || ' · ' || x.name, greatest(x.created_at, x.updated_at), (x.updated_at > x.created_at + interval '2 seconds'), ${sql.raw(personName('pr'))}
                   from public.part_families x left join public.profiles pr on pr.id = coalesce(x.updated_by, x.created_by) where x.organisation_id = ${org}::uuid
            union all select 'machines', x.id, x.code || ' · ' || x.name, greatest(x.created_at, x.updated_at), (x.updated_at > x.created_at + interval '2 seconds'), ${sql.raw(personName('pr'))}
                   from public.machines x left join public.profiles pr on pr.id = coalesce(x.updated_by, x.created_by) where x.organisation_id = ${org}::uuid
            union all select 'customers', x.id, x.code || ' · ' || x.name, greatest(x.created_at, x.updated_at), (x.updated_at > x.created_at + interval '2 seconds'), ${sql.raw(personName('pr'))}
                   from public.customers x left join public.profiles pr on pr.id = coalesce(x.updated_by, x.created_by) where x.organisation_id = ${org}::uuid
            union all select 'suppliers', x.id, x.code || ' · ' || x.name, greatest(x.created_at, x.updated_at), (x.updated_at > x.created_at + interval '2 seconds'), ${sql.raw(personName('pr'))}
                   from public.suppliers x left join public.profiles pr on pr.id = coalesce(x.updated_by, x.created_by) where x.organisation_id = ${org}::uuid
            union all select 'employees', x.id, x.first_name || ' ' || x.surname, greatest(x.created_at, x.updated_at), (x.updated_at > x.created_at + interval '2 seconds'), ${sql.raw(personName('pr'))}
                   from public."Employees" x left join public.profiles pr on pr.id = coalesce(x.updated_by, x.created_by) where x.organisation_id = ${org}::uuid
          ) u order by at desc limit 10`)
      ).map((r) => ({
        kind: r.kind as z.infer<typeof Kind>,
        id: r.id as string,
        label: (r.label as string) ?? '',
        action: (r.changed ? 'changed' : 'added') as 'added' | 'changed',
        at: iso(r.at)!,
        by: (r.by_name as string) ?? null,
      }));

      // The outbox is readable with audit.read; without it the rest of the page is unaffected.
      const [can] = await q(sql`select app.has_permission(${org}::uuid, 'audit.read') as ok`);
      let events: MasterDataDashboard['events'] = { available: false, last24Hours: 0, waiting: 0, oldestWaitingAt: null, byType: [], recent: [] };
      if (can.ok) {
        const [totals] = await q(sql`select count(*) filter (where created_at >= now() - interval '24 hours')::int as last24, count(*) filter (where processed_at is null)::int as waiting,
                                            min(created_at) filter (where processed_at is null) as oldest from public.outbox_events where organisation_id = ${org}::uuid`);
        const types = await q(sql`select event_type as key, event_type as label, count(*)::int as count from public.outbox_events
                                   where organisation_id = ${org}::uuid and created_at >= now() - interval '30 days' group by event_type order by count(*) desc, event_type limit 8`);
        const latest = await q(sql`select o.id, o.event_type, o.entity_type, o.created_at, o.processed_at, ${sql.raw(personName('pr'))} as by_name
                                     from public.outbox_events o left join public.profiles pr on pr.id = o.actor_user_id where o.organisation_id = ${org}::uuid order by o.created_at desc limit 8`);
        events = {
          available: true,
          last24Hours: n(totals.last24),
          waiting: n(totals.waiting),
          oldestWaitingAt: iso(totals.oldest),
          byType: types.map((r) => ({ key: r.key as string, label: r.label as string, count: n(r.count) })),
          recent: latest.map((r) => ({ id: r.id as string, type: r.event_type as string, entityType: r.entity_type as string, at: iso(r.created_at)!, processedAt: iso(r.processed_at), by: (r.by_name as string) ?? null })),
        };
      }

      return {
        asOf: new Date().toISOString(),
        entities: KINDS.map((k) => ({ kind: k, total: n(byKind[k]?.total), active: n(byKind[k]?.active), added30Days: n(byKind[k]?.added) })),
        attention,
        growth: growth as MasterDataDashboard['growth'],
        partsByFamily,
        machinesBySite,
        employeesByDepartment,
        revisionsByStatus,
        recent,
        events,
      };
    });
  }
}

@ApiTags('master-data')
@ApiBearerAuth()
@Controller('master-data-dashboard')
export class MasterDataDashboardController {
  constructor(private readonly service: MasterDataDashboardService) {}

  /** Totals, data-quality checks, growth, shape, recent changes and the change-event stream for the master data overview. */
  @Get()
  @OrganisationScoped('master_data.read')
  @ApiOkResponse({ schema: openApiSchema(MasterDataDashboard) })
  get(@Ctx() ctx: RequestContext) {
    return this.service.get(ctx);
  }
}
