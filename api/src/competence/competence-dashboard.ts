import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { Row } from '../calibration/calibration.service';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse } from '../common/validation';
import { DatabaseService } from '../database/database.service';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { EXPIRY_WARNING_DAYS } from './competence-state';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const n = (v: unknown) => Number(v ?? 0);
const day = (v: unknown) => (v ? String(v).slice(0, 10) : null);

export const CompetenceDashboardQuery = z
  .object({ from: isoDate, to: isoDate })
  .refine((q) => q.from <= q.to, { message: '"from" must be on or before "to"', path: ['from'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 3 * 366, { message: 'At most three years', path: ['from'] });

const Id = z.string().uuid();
export const CompetenceDashboard = z.object({
  period: z.object({ from: isoDate, to: isoDate, bucket: z.enum(['week', 'month']) }),
  kpis: z.object({
    /** Active employees. */
    people: z.number(),
    /** Active employees holding at least one position that requires something. */
    withRequirements: z.number(),
    /** Of those, people short of a required level, or not assessed on a required skill. */
    withGaps: z.number(),
    /** Required skill and person pairs short of the level (or not assessed). */
    gaps: z.number(),
    /** Current assessments past their expiry / expiring within 30, 60 and 90 days (active people and skills, level 1 or more). */
    expired: z.number(),
    expiring30: z.number(),
    expiring60: z.number(),
    expiring90: z.number(),
    /** Active employees with no assessment at all. */
    neverAssessed: z.number(),
    /** Training in the period: sessions that started, results recorded as completed, and failures. */
    sessions: z.number(),
    completions: z.number(),
    failures: z.number(),
  }),
  gapsBySkill: z.array(z.object({ skillId: Id, code: z.string(), name: z.string(), people: z.number(), required: z.number() })),
  levels: z.array(z.object({ level: z.number(), label: z.string(), count: z.number() })),
  training: z.array(z.object({ start: isoDate, completed: z.number(), failed: z.number() })),
  worstGaps: z.array(z.object({ employeeId: Id, name: z.string(), gapSkills: z.number(), totalGap: z.number(), skills: z.array(z.string()) })),
  nextExpiries: z.array(z.object({ employeeId: Id, name: z.string(), skillId: Id, skill: z.string(), level: z.number(), expiresOn: isoDate, days: z.number() })),
  neverAssessedPeople: z.array(z.object({ employeeId: Id, name: z.string(), positions: z.array(z.string()) })),
  recentTraining: z.array(z.object({ id: Id, reference: z.string(), title: z.string(), startsOn: isoDate, status: z.string(), completed: z.number(), attendees: z.number() })),
});
export type CompetenceDashboard = z.infer<typeof CompetenceDashboard>;

const LEVEL_LABELS = ['None', 'Learning', 'Supervised', 'Competent', 'Can train others'];

/** Required skill and person pairs (active people and skills, positions held now) with the current level and what is short. */
export const CELLS = (org: string) => sql`
  select h.employee_id, h.skill_id, h.required, coalesce(a.level, 0) as level, (a.id is null) as unassessed, greatest(h.required - coalesce(a.level, 0), 0) as gap
    from (select x.employee_id, ps.skill_id, max(ps.required_level)::int as required
            from public.competence_employee_positions x
            join public.competence_position_skills ps on ps.position_id = x.position_id
           where x.organisation_id = ${org}::uuid and x.ended_on is null
           group by x.employee_id, ps.skill_id) h
    join public."Employees" e on e.id = h.employee_id and e.active
    join public.competence_skills k on k.id = h.skill_id and k.active
    left join public.competence_assessments a on a.employee_id = h.employee_id and a.skill_id = h.skill_id and a.status = 'current'`;

/** Current assessments that can expire: level 1 or more, active person and skill. */
export const EXPIRING = (org: string) => sql`
  select a.employee_id, a.skill_id, a.level, a.expires_on
    from public.competence_assessments a
    join public."Employees" e on e.id = a.employee_id and e.active
    join public.competence_skills k on k.id = a.skill_id and k.active
   where a.organisation_id = ${org}::uuid and a.status = 'current' and a.level >= 1 and a.expires_on is not null`;

@Injectable()
export class CompetenceDashboardService {
  constructor(private readonly database: DatabaseService) {}

  get(ctx: RequestContext, q: z.infer<typeof CompetenceDashboardQuery>): Promise<CompetenceDashboard> {
    const org = ctx.organisationId!;
    const bucket: 'week' | 'month' = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 92 ? 'week' : 'month';
    return this.database.asUser(ctx, async (db) => {
      const one = async (query: ReturnType<typeof sql>) => (await db.execute<Row>(query)).rows[0] ?? {};
      const many = async (query: ReturnType<typeof sql>) => (await db.execute<Row>(query)).rows;

      const people = await one(sql`
        select count(*)::int as people,
               count(*) filter (where exists (select 1 from public.competence_employee_positions x join public.competence_position_skills ps on ps.position_id = x.position_id
                                                where x.employee_id = e.id and x.ended_on is null))::int as with_requirements,
               count(*) filter (where not exists (select 1 from public.competence_assessments a where a.employee_id = e.id))::int as never_assessed
          from public."Employees" e where e.organisation_id = ${org}::uuid and e.active`);
      const gaps = await one(sql`select count(*) filter (where gap > 0)::int as gaps, count(distinct employee_id) filter (where gap > 0)::int as people from (${CELLS(org)}) c`);
      const exp = await one(sql`
        select count(*) filter (where expires_on < current_date)::int as expired,
               count(*) filter (where expires_on >= current_date and expires_on <= current_date + 30)::int as d30,
               count(*) filter (where expires_on >= current_date and expires_on <= current_date + 60)::int as d60,
               count(*) filter (where expires_on >= current_date and expires_on <= current_date + 90)::int as d90
          from (${EXPIRING(org)}) x`);
      const training = await one(sql`
        select (select count(*)::int from public.competence_training_sessions s where s.organisation_id = ${org}::uuid and s.status <> 'cancelled' and s.starts_on between ${q.from}::date and ${q.to}::date) as sessions,
               count(*) filter (where a.status = 'completed')::int as completions,
               count(*) filter (where a.status = 'failed')::int as failures
          from public.competence_session_attendees a
         where a.organisation_id = ${org}::uuid and a.status in ('completed', 'failed') and a.completed_on between ${q.from}::date and ${q.to}::date`);

      const gapsBySkill = await many(sql`
        select k.id, k.code, k.name, count(*) filter (where c.gap > 0)::int as people, count(*)::int as required
          from (${CELLS(org)}) c join public.competence_skills k on k.id = c.skill_id
         group by k.id, k.code, k.name having count(*) filter (where c.gap > 0) > 0
         order by people desc, lower(k.name) limit 10`);
      const levels = await many(sql`
        select a.level, count(*)::int as n
          from public.competence_assessments a
          join public."Employees" e on e.id = a.employee_id and e.active
          join public.competence_skills k on k.id = a.skill_id and k.active
         where a.organisation_id = ${org}::uuid and a.status = 'current' group by a.level`);
      const buckets = await many(sql`
        select to_char(date_trunc(${bucket}, a.completed_on), 'YYYY-MM-DD') as start,
               count(*) filter (where a.status = 'completed')::int as completed, count(*) filter (where a.status = 'failed')::int as failed
          from public.competence_session_attendees a
         where a.organisation_id = ${org}::uuid and a.status in ('completed', 'failed') and a.completed_on between ${q.from}::date and ${q.to}::date
         group by 1 order by 1`);
      const worst = await many(sql`
        select e.id, concat_ws(' ', e.first_name, e.surname) as name, count(*)::int as gap_skills, sum(c.gap)::int as total_gap,
               (array_agg(k.name order by c.gap desc, lower(k.name)))[1:3] as skills
          from (${CELLS(org)}) c
          join public."Employees" e on e.id = c.employee_id join public.competence_skills k on k.id = c.skill_id
         where c.gap > 0 group by e.id, e.first_name, e.surname
         order by total_gap desc, gap_skills desc, lower(e.surname) limit 10`);
      const next = await many(sql`
        select e.id as employee_id, concat_ws(' ', e.first_name, e.surname) as name, k.id as skill_id, k.name as skill, x.level, x.expires_on::text as expires_on,
               (x.expires_on - current_date)::int as days
          from (${EXPIRING(org)}) x
          join public."Employees" e on e.id = x.employee_id join public.competence_skills k on k.id = x.skill_id
         where x.expires_on <= current_date + 90 order by x.expires_on, lower(e.surname) limit 15`);
      const never = await many(sql`
        select e.id, concat_ws(' ', e.first_name, e.surname) as name,
               coalesce((select array_agg(p.name order by p.name) from public.competence_employee_positions x join public.competence_positions p on p.id = x.position_id
                          where x.employee_id = e.id and x.ended_on is null), '{}') as positions
          from public."Employees" e
         where e.organisation_id = ${org}::uuid and e.active and not exists (select 1 from public.competence_assessments a where a.employee_id = e.id)
         order by lower(e.surname), lower(e.first_name) limit 10`);
      const recent = await many(sql`
        select s.id, s.reference, s.title, s.starts_on::text as starts_on, s.status,
               (select count(*)::int from public.competence_session_attendees a where a.session_id = s.id and a.status = 'completed') as completed,
               (select count(*)::int from public.competence_session_attendees a where a.session_id = s.id and a.status not in ('removed', 'voided')) as attendees
          from public.competence_training_sessions s where s.organisation_id = ${org}::uuid order by s.starts_on desc, s.reference desc limit 8`);

      const byLevel = new Map(levels.map((r) => [n(r.level), n(r.n)]));
      return {
        period: { from: q.from, to: q.to, bucket },
        kpis: {
          people: n(people.people),
          withRequirements: n(people.with_requirements),
          withGaps: n(gaps.people),
          gaps: n(gaps.gaps),
          expired: n(exp.expired),
          expiring30: n(exp.d30),
          expiring60: n(exp.d60),
          expiring90: n(exp.d90),
          neverAssessed: n(people.never_assessed),
          sessions: n(training.sessions),
          completions: n(training.completions),
          failures: n(training.failures),
        },
        gapsBySkill: gapsBySkill.map((r) => ({ skillId: r.id as string, code: r.code as string, name: r.name as string, people: n(r.people), required: n(r.required) })),
        levels: LEVEL_LABELS.map((label, level) => ({ level, label, count: byLevel.get(level) ?? 0 })),
        training: buckets.map((r) => ({ start: r.start as string, completed: n(r.completed), failed: n(r.failed) })),
        worstGaps: worst.map((r) => ({ employeeId: r.id as string, name: (r.name as string) || 'Unnamed', gapSkills: n(r.gap_skills), totalGap: n(r.total_gap), skills: (r.skills as string[]) ?? [] })),
        nextExpiries: next.map((r) => ({
          employeeId: r.employee_id as string, name: (r.name as string) || 'Unnamed', skillId: r.skill_id as string, skill: r.skill as string, level: n(r.level),
          expiresOn: day(r.expires_on) as string, days: n(r.days),
        })),
        neverAssessedPeople: never.map((r) => ({ employeeId: r.id as string, name: (r.name as string) || 'Unnamed', positions: (r.positions as string[]) ?? [] })),
        recentTraining: recent.map((r) => ({
          id: r.id as string, reference: r.reference as string, title: r.title as string, startsOn: day(r.starts_on) as string, status: r.status as string,
          completed: n(r.completed), attendees: n(r.attendees),
        })),
      };
    });
  }
}

/** Competence dashboard: gaps against positions, assessments expiring or expired, people never assessed, and training recorded in the period. Read as the caller (competence.read). */
@ApiTags('competence')
@ApiBearerAuth()
@Controller('competence-dashboard')
export class CompetenceDashboardController {
  constructor(private readonly service: CompetenceDashboardService) {}

  @Get()
  @OrganisationScoped('competence.read')
  @ApiQuery({ name: 'from', required: true, description: 'From (YYYY-MM-DD)' })
  @ApiQuery({ name: 'to', required: true, description: 'To (YYYY-MM-DD)' })
  @ApiOkResponse({ description: `Figures as of today (gaps, expiry within ${EXPIRY_WARNING_DAYS}/90 days) and training for the period`, schema: openApiSchema(CompetenceDashboard) })
  get(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.get(ctx, parse(CompetenceDashboardQuery, query));
  }
}
