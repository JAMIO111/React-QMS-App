import { Injectable } from '@nestjs/common';
import { sql, SQL } from 'drizzle-orm';
import { personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { todayIn } from '../supplier-quality/expiry';
import { AssessBody, AssignPositionBody, EndPositionBody, MatrixQuery } from './competence.schemas';
import { CellStatus, cellStatus, ExpiryState } from './competence-state';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
/** A list of ids as one text value (never a JS array, which the driver would spread). */
const uuidList = (ids: string[]) => sql`string_to_array(${ids.join(',')}, ',')::uuid[]`;
const day = (v: unknown) => (v ? String(v).slice(0, 10) : null);
/** Columns shown at most in the matrix; more skills than this say so and ask for a category filter. */
export const MATRIX_MAX_SKILLS = 40;
/** Employees considered for the matrix (the figures are worked out in code, so this is bounded). */
const MATRIX_MAX_EMPLOYEES = 1000;

export interface Cell {
  level: number | null;
  required: number | null;
  gap: number;
  status: CellStatus;
  expiry: ExpiryState;
  expiresOn: string | null;
  assessedOn: string | null;
}

const EMPLOYEE_SELECT = sql`
  select e.id, e.first_name, e.surname, e.employee_number, e.job_title, e.active, e.auth_id, e.site_id, e.department_id,
         s.name as site_name, d.name as department_name
    from public."Employees" e
    left join public.sites s on s.id = e.site_id
    left join public.departments d on d.id = e.department_id`;

const toEmployee = (r: Row) => ({
  id: r.id as string,
  name: [r.first_name, r.surname].filter(Boolean).join(' ') || 'Unnamed',
  employeeNumber: (r.employee_number as string) ?? null,
  jobTitle: (r.job_title as string) ?? null,
  active: !!r.active,
  hasLogin: !!r.auth_id,
  site: r.site_id ? { id: r.site_id as string, name: r.site_name as string } : null,
  department: r.department_id ? { id: r.department_id as string, name: r.department_name as string } : null,
});

@Injectable()
export class CompetencePeopleService {
  constructor(private readonly database: DatabaseService) {}

  private today(ctx: RequestContext) {
    return todayIn(ctx.timeZone);
  }

  // ---- the matrix ----------------------------------------------------------------------------------

  matrix(ctx: RequestContext, q: MatrixQuery) {
    return this.database.asUser(ctx, async (db) => {
      const org = orgOf(ctx);
      const today = this.today(ctx);

      // Columns: active skills, narrowed by category or one skill.
      const skillRows = (
        await db.execute<Row>(sql`
          select k.id, k.code, k.name, k.category_id, c.label as category_label, k.refresh_months
            from public.competence_skills k join public.competence_categories c on c.id = k.category_id
           where k.organisation_id = ${org}::uuid and k.active
             ${q.categoryId ? sql`and k.category_id = ${q.categoryId}::uuid` : sql``}
             ${q.skillId ? sql`and k.id = ${q.skillId}::uuid` : sql``}
           order by c.sequence, lower(c.label), lower(k.name)`)
      ).rows;
      const skills = skillRows.slice(0, MATRIX_MAX_SKILLS);
      const skillIds = skills.map((s) => s.id as string);

      const where: SQL[] = [sql`e.organisation_id = ${org}::uuid`, sql`e.active`];
      if (q.departmentId) where.push(sql`e.department_id = ${q.departmentId}::uuid`);
      if (q.siteId) where.push(sql`e.site_id = ${q.siteId}::uuid`);
      if (q.positionId) {
        where.push(sql`exists (select 1 from public.competence_employee_positions x where x.employee_id = e.id and x.position_id = ${q.positionId}::uuid and x.ended_on is null)`);
      }
      if (q.q) {
        const p = likePattern(q.q);
        where.push(sql`(concat_ws(' ', e.first_name, e.surname) ilike ${p} escape '\\' or e.employee_number ilike ${p} escape '\\' or e.job_title ilike ${p} escape '\\')`);
      }
      const employees = (
        await db.execute<Row>(sql`${EMPLOYEE_SELECT} where ${sql.join(where, sql` and `)} order by lower(e.surname), lower(e.first_name) limit ${MATRIX_MAX_EMPLOYEES + 1}`)
      ).rows;
      const truncatedEmployees = employees.length > MATRIX_MAX_EMPLOYEES;
      const people = employees.slice(0, MATRIX_MAX_EMPLOYEES);
      const ids = people.map((e) => e.id as string);

      const held = ids.length
        ? (
            await db.execute<Row>(sql`
              select x.employee_id, p.id as position_id, p.name as position_name
                from public.competence_employee_positions x join public.competence_positions p on p.id = x.position_id
               where x.organisation_id = ${org}::uuid and x.ended_on is null and x.employee_id = any(${uuidList(ids)})`)
          ).rows
        : [];
      const required = skillIds.length && ids.length
        ? (
            await db.execute<Row>(sql`
              select x.employee_id, ps.skill_id, max(ps.required_level)::int as required
                from public.competence_employee_positions x
                join public.competence_position_skills ps on ps.position_id = x.position_id
               where x.organisation_id = ${org}::uuid and x.ended_on is null
                 and x.employee_id = any(${uuidList(ids)})
                 and ps.skill_id = any(${uuidList(skillIds)})
               group by x.employee_id, ps.skill_id`)
          ).rows
        : [];
      const levels = skillIds.length && ids.length
        ? (
            await db.execute<Row>(sql`
              select a.employee_id, a.skill_id, a.level, a.assessed_on::text as assessed_on, a.expires_on::text as expires_on
                from public.competence_assessments a
               where a.organisation_id = ${org}::uuid and a.status = 'current'
                 and a.employee_id = any(${uuidList(ids)})
                 and a.skill_id = any(${uuidList(skillIds)})`)
          ).rows
        : [];

      const heldBy = new Map<string, { id: string; name: string }[]>();
      for (const h of held) heldBy.set(h.employee_id as string, [...(heldBy.get(h.employee_id as string) ?? []), { id: h.position_id as string, name: h.position_name as string }]);
      const reqBy = new Map(required.map((r) => [`${r.employee_id}:${r.skill_id}`, Number(r.required)]));
      const lvlBy = new Map(levels.map((r) => [`${r.employee_id}:${r.skill_id}`, r]));

      let rows = people.map((e) => {
        const cells: Record<string, Cell> = {};
        for (const sid of skillIds) {
          const key = `${e.id}:${sid}`;
          const a = lvlBy.get(key);
          const req = reqBy.get(key) ?? null;
          const level = a ? Number(a.level) : null;
          const expiresOn = a ? day(a.expires_on) : null;
          const st = cellStatus({ level, required: req, expiresOn }, today);
          cells[sid] = { level, required: req, gap: st.gap, status: st.status, expiry: st.expiry, expiresOn, assessedOn: a ? day(a.assessed_on) : null };
        }
        return { employee: toEmployee(e), positions: heldBy.get(e.id as string) ?? [], cells };
      });

      const has = (r: (typeof rows)[number], f: (c: Cell) => boolean) => Object.values(r.cells).some(f);
      if (q.status === 'gap') rows = rows.filter((r) => has(r, (c) => c.status === 'gap' || (c.status === 'not_assessed' && c.required !== null)));
      else if (q.status === 'expired') rows = rows.filter((r) => has(r, (c) => c.status === 'expired'));
      else if (q.status === 'expiring') rows = rows.filter((r) => has(r, (c) => c.status === 'expiring'));
      else if (q.status === 'attention') rows = rows.filter((r) => has(r, (c) => ['gap', 'expired', 'expiring'].includes(c.status) || (c.status === 'not_assessed' && c.required !== null)));

      const total = rows.length;
      const start = (q.page - 1) * q.pageSize;
      return {
        skills: skills.map((s) => ({
          id: s.id as string,
          code: s.code as string,
          name: s.name as string,
          category: { id: s.category_id as string, label: s.category_label as string },
          refreshMonths: s.refresh_months === null ? null : Number(s.refresh_months),
        })),
        skillsTruncated: skillRows.length > MATRIX_MAX_SKILLS,
        employeesTruncated: truncatedEmployees,
        data: rows.slice(start, start + q.pageSize),
        page: q.page,
        pageSize: q.pageSize,
        total,
        today,
      };
    });
  }

  // ---- a person ------------------------------------------------------------------------------------

  /** One person's whole standing: positions (with dates), every skill that is required of them or assessed, and the history behind each. */
  private async profile(db: Db, ctx: RequestContext, employeeId: string) {
    const org = orgOf(ctx);
    const today = this.today(ctx);
    const emp = (await db.execute<Row>(sql`${EMPLOYEE_SELECT} where e.id = ${employeeId}::uuid and e.organisation_id = ${org}::uuid`)).rows;
    if (emp.length === 0) throw ApiError.notFound('employee_not_found', 'Employee not found');

    const positions = (
      await db.execute<Row>(sql`
        select x.id, x.started_on::text as started_on, x.ended_on::text as ended_on, p.id as position_id, p.code, p.name, p.active
          from public.competence_employee_positions x join public.competence_positions p on p.id = x.position_id
         where x.employee_id = ${employeeId}::uuid and x.organisation_id = ${org}::uuid
         order by (x.ended_on is not null), x.started_on desc`)
    ).rows;
    const required = (
      await db.execute<Row>(sql`
        select ps.skill_id, max(ps.required_level)::int as required,
               jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'level', ps.required_level) order by p.name) as via
          from public.competence_employee_positions x
          join public.competence_position_skills ps on ps.position_id = x.position_id
          join public.competence_positions p on p.id = x.position_id
         where x.employee_id = ${employeeId}::uuid and x.organisation_id = ${org}::uuid and x.ended_on is null
         group by ps.skill_id`)
    ).rows;
    const history = (
      await db.execute<Row>(sql`
        select a.id, a.skill_id, a.level, a.assessed_on::text as assessed_on, a.expires_on::text as expires_on, a.note, a.status, a.created_at,
               ${sql.raw(personName('pr'))} as assessor_name
          from public.competence_assessments a left join public.profiles pr on pr.id = a.assessor_user_id
         where a.employee_id = ${employeeId}::uuid and a.organisation_id = ${org}::uuid
         order by a.assessed_on desc, a.created_at desc`)
    ).rows;
    const skillIds = [...new Set([...required.map((r) => r.skill_id as string), ...history.map((h) => h.skill_id as string)])];
    const skills = skillIds.length
      ? (
          await db.execute<Row>(sql`
            select k.id, k.code, k.name, k.active, k.refresh_months, c.id as category_id, c.label as category_label
              from public.competence_skills k join public.competence_categories c on c.id = k.category_id
             where k.organisation_id = ${org}::uuid and k.id = any(${uuidList(skillIds)})
             order by c.sequence, lower(k.name)`)
        ).rows
      : [];

    const reqBy = new Map(required.map((r) => [r.skill_id as string, r]));
    const rows = skills.map((k) => {
      const mine = history.filter((h) => h.skill_id === k.id);
      const current = mine.find((h) => h.status === 'current');
      const req = reqBy.get(k.id as string);
      const level = current ? Number(current.level) : null;
      const st = cellStatus({ level, required: req ? Number(req.required) : null, expiresOn: current ? day(current.expires_on) : null }, today);
      return {
        skill: { id: k.id as string, code: k.code as string, name: k.name as string, active: !!k.active, refreshMonths: k.refresh_months === null ? null : Number(k.refresh_months), category: { id: k.category_id as string, label: k.category_label as string } },
        level,
        required: req ? Number(req.required) : null,
        requiredBy: req ? (req.via as { id: string; name: string; level: number }[]) : [],
        gap: st.gap,
        status: st.status,
        expiry: st.expiry,
        assessedOn: current ? day(current.assessed_on) : null,
        expiresOn: current ? day(current.expires_on) : null,
        assessor: current ? ((current.assessor_name as string) ?? null) : null,
        note: current ? ((current.note as string) ?? null) : null,
        history: mine.map((h) => ({
          id: h.id as string,
          level: Number(h.level),
          assessedOn: day(h.assessed_on) as string,
          expiresOn: day(h.expires_on),
          assessor: (h.assessor_name as string) ?? null,
          note: (h.note as string) ?? null,
          current: h.status === 'current',
        })),
      };
    });
    // What needs attention first: gaps (largest first), expired, expiring, then the rest by category and name.
    const rank: Record<CellStatus, number> = { gap: 0, not_assessed: 1, expired: 2, expiring: 3, ok: 4, extra: 5 };
    rows.sort((a, b) => rank[a.status] - rank[b.status] || b.gap - a.gap);
    const count = (s: CellStatus) => rows.filter((r) => r.status === s && (s !== 'not_assessed' || r.required !== null)).length;

    return {
      employee: toEmployee(emp[0]),
      positions: positions.map((p) => ({
        id: p.id as string,
        position: { id: p.position_id as string, code: p.code as string, name: p.name as string, active: !!p.active },
        startedOn: day(p.started_on) as string,
        endedOn: day(p.ended_on),
      })),
      skills: rows,
      summary: { required: rows.filter((r) => r.required !== null).length, gaps: count('gap') + count('not_assessed'), expired: count('expired'), expiring: count('expiring'), ok: count('ok') },
      today,
    };
  }

  person(ctx: RequestContext, employeeId: string) {
    return this.database.asUser(ctx, (db) => this.profile(db, ctx, employeeId));
  }

  /** The caller's own record, by their linked employee. `employee: null` when the sign-in is not linked to anyone. */
  me(ctx: RequestContext) {
    return this.database.asUser(ctx, async (db) => {
      const found = (
        await db.execute<Row>(sql`select e.id from public."Employees" e where e.organisation_id = ${orgOf(ctx)}::uuid and e.auth_id = ${ctx.user.id}::uuid and e.active limit 1`)
      ).rows;
      if (found.length === 0) return { linked: false as const };
      return { linked: true as const, ...(await this.profile(db, ctx, found[0].id as string)) };
    });
  }

  // ---- commands (each answers with the whole profile) ----------------------------------------------

  assignPosition(ctx: RequestContext, employeeId: string, body: AssignPositionBody) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.assign_employee_position(${employeeId}::uuid, ${body.positionId}::uuid, ${body.startedOn}::date)`);
      return this.profile(db, ctx, employeeId);
    });
  }

  endPosition(ctx: RequestContext, id: string, body: EndPositionBody) {
    return this.database.asUser(ctx, async (db) => {
      const row = (await db.execute<Row>(sql`select employee_id from public.competence_employee_positions where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`)).rows;
      if (row.length === 0) throw ApiError.notFound('competence_position_held_not_found', 'That position held was not found');
      await db.execute(sql`select app.end_employee_position(${id}::uuid, ${body.endedOn ?? null}::date)`);
      return this.profile(db, ctx, row[0].employee_id as string);
    });
  }

  assess(ctx: RequestContext, employeeId: string, body: AssessBody) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`
        select app.record_competence_assessment(${employeeId}::uuid, ${body.skillId}::uuid, ${body.level}::int, ${body.assessedOn ?? this.today(ctx)}::date,
                                                ${body.expiresOn ?? null}::date, ${body.note ?? null}::text)`);
      return this.profile(db, ctx, employeeId);
    });
  }
}
