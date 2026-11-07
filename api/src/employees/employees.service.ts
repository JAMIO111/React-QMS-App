import { Injectable } from '@nestjs/common';
import { SQL, sql } from 'drizzle-orm';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { iso, personName, Row } from '../calibration/calibration.service';
import { DatabaseService, Db } from '../database/database.service';
import { CreateEmployeeBody, Employee, EmployeeListQuery, LinkLoginBody, UpdateEmployeeBody } from './employees.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

const SELECT = `
  select e.id, e.first_name, e.surname, e.job_title, e.employee_number, e.email, coalesce(e.active, true) as active, e.auth_id,
         e.created_at, e.updated_at, ${personName('e')} as full_name,
         ${personName('lp')} as login_name,
         s.id as site_id, s.code as site_code, s.name as site_name, d.id as department_id, d.code as department_code, d.name as department_name
  from public."Employees" e
  left join public.sites s on s.id = e.site_id
  left join public.departments d on d.id = e.department_id
  left join public.profiles lp on lp.id = e.auth_id`;

/** Sort expressions (the direction applies to each). */
const SORT_SQL: Record<EmployeeListQuery['sort'], string[]> = {
  name: [`lower(coalesce(e.surname, ''))`, `lower(coalesce(e.first_name, ''))`],
  jobTitle: [`lower(e.job_title)`],
  employeeNumber: [`upper(e.employee_number)`],
  email: [`lower(e.email)`],
  site: [`lower(s.name)`],
  department: [`lower(d.name)`],
  status: [`coalesce(e.active, true)`],
  createdAt: [`e.created_at`],
};

const toEmployee = (r: Row): Employee => ({
  id: r.id as string,
  name: (r.full_name as string) ?? 'Unnamed',
  firstName: (r.first_name as string) ?? null,
  surname: (r.surname as string) ?? null,
  jobTitle: (r.job_title as string) ?? null,
  employeeNumber: (r.employee_number as string) ?? null,
  email: (r.email as string) ?? null,
  site: r.site_id ? { id: r.site_id as string, code: r.site_code as string, name: r.site_name as string } : null,
  department: r.department_id ? { id: r.department_id as string, code: r.department_code as string, name: r.department_name as string } : null,
  active: r.active as boolean,
  hasLogin: !!r.auth_id,
  login: r.auth_id ? { userId: r.auth_id as string, name: (r.login_name as string) ?? 'Unknown user' } : null,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

/** The employees register (master data): personnel, not necessarily system users. Written under RLS (master_data.manage); nobody is deleted, they are deactivated. */
@Injectable()
export class EmployeesService {
  constructor(private readonly database: DatabaseService) {}

  list(ctx: RequestContext, q: EmployeeListQuery): Promise<{ data: Employee[]; page: number; pageSize: number; total: number }> {
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`e.organisation_id = ${orgOf(ctx)}::uuid`];
      // The status filter lists the states wanted: both (or neither) means everyone.
      if (q.status.length === 1) where.push(q.status[0] === 'active' ? sql`coalesce(e.active, true)` : sql`not coalesce(e.active, true)`);
      if (q.siteId) where.push(sql`e.site_id = ${q.siteId}::uuid`);
      if (q.departmentId) where.push(sql`e.department_id = ${q.departmentId}::uuid`);
      if (q.q) {
        const like = likePattern(q.q);
        where.push(sql`(e.first_name ilike ${like} or e.surname ilike ${like} or concat_ws(' ', e.first_name, e.surname) ilike ${like}
          or e.job_title ilike ${like} or e.employee_number ilike ${like} or e.email ilike ${like})`);
      }
      const order = sql.raw(`${SORT_SQL[q.sort].map((x) => `${x} ${q.order} nulls last`).join(', ')}, lower(e.surname) asc, e.id asc`);
      const result = await db.execute<Row>(sql`${sql.raw(SELECT)} where ${sql.join(where, sql` and `)} order by ${order}
        limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`);
      const count = await db.execute<{ n: string }>(sql`select count(*) as n from public."Employees" e where ${sql.join(where, sql` and `)}`);
      return { data: result.rows.map(toEmployee), page: q.page, pageSize: q.pageSize, total: Number(count.rows[0].n) };
    });
  }

  /** Everyone (active or not), for pickers. */
  lookup(ctx: RequestContext) {
    return this.database.asUser(ctx, async (db) => {
      const result = await db.execute<Row>(sql`
        select id, ${sql.raw(personName('e'))} as name, job_title, coalesce(active, true) as active
        from public."Employees" e where e.organisation_id = ${orgOf(ctx)}::uuid
        order by lower(e.surname), lower(e.first_name)`);
      return result.rows.map((r) => ({ id: r.id as string, name: (r.name as string) ?? 'Unnamed', jobTitle: (r.job_title as string) ?? null, active: r.active as boolean }));
    });
  }

  get(ctx: RequestContext, id: string): Promise<Employee> {
    return this.database.asUser(ctx, (db) => this.load(db, ctx, id));
  }

  create(ctx: RequestContext, body: CreateEmployeeBody): Promise<Employee> {
    return this.database.asUser(ctx, async (db) => {
      const result = await db.execute<{ id: string }>(sql`insert into public."Employees"
        (organisation_id, first_name, surname, job_title, employee_number, email, site_id, department_id, active)
        values (${orgOf(ctx)}::uuid, ${body.firstName}, ${body.surname}, ${body.jobTitle ?? null}, ${body.employeeNumber ?? null}, ${body.email ?? null},
                ${body.siteId ?? null}::uuid, ${body.departmentId ?? null}::uuid, true) returning id`);
      return this.load(db, ctx, result.rows[0].id);
    });
  }

  update(ctx: RequestContext, id: string, body: UpdateEmployeeBody): Promise<Employee> {
    return this.database.asUser(ctx, async (db) => {
      await this.load(db, ctx, id); // 404 outside this organisation
      const set: SQL[] = [];
      const add = (column: string, value: unknown, cast = '') => set.push(sql.raw(`${column} = `).append(sql`${value}`).append(sql.raw(cast)));
      if (body.firstName !== undefined) add('first_name', body.firstName);
      if (body.surname !== undefined) add('surname', body.surname);
      if (body.jobTitle !== undefined) add('job_title', body.jobTitle);
      if (body.employeeNumber !== undefined) add('employee_number', body.employeeNumber);
      if (body.email !== undefined) add('email', body.email);
      if (body.active !== undefined) add('active', body.active);
      // Moving to another site clears a department that is not there, unless a new department is named with it.
      if (body.siteId !== undefined) {
        add('site_id', body.siteId, '::uuid');
        if (body.departmentId === undefined) set.push(sql`department_id = case when department_id in (select d.id from public.departments d where d.site_id = ${body.siteId}::uuid) then department_id else null end`);
      }
      if (body.departmentId !== undefined) add('department_id', body.departmentId, '::uuid');
      const result = await db.execute(sql`update public."Employees" set ${sql.join(set, sql`, `)} where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid returning id`);
      if (!result.rows.length) throw ApiError.forbidden();
      return this.load(db, ctx, id);
    });
  }

  /** Members that could be linked to an employee; `canLink` is whether the caller holds a Controller seat (the database enforces it again). */
  loginCandidates(ctx: RequestContext) {
    return this.database.asUser(ctx, async (db) => {
      const seat = await db.execute<{ ok: boolean }>(sql`select app.holds_controller_seat(${orgOf(ctx)}::uuid) as ok`);
      const rows = await db.execute<Row>(sql`select user_id, first_name, surname, email, employee_id from app.employee_login_candidates(${orgOf(ctx)}::uuid)`);
      return {
        canLink: seat.rows[0].ok,
        data: rows.rows.map((r) => ({
          userId: r.user_id as string,
          name: ([r.first_name, r.surname].filter(Boolean).join(' ') as string) || (r.email as string) || 'Unknown user',
          email: (r.email as string) ?? null,
          employeeId: (r.employee_id as string) ?? null,
        })),
      };
    });
  }

  linkLogin(ctx: RequestContext, id: string, body: LinkLoginBody): Promise<Employee> {
    return this.database.asUser(ctx, async (db) => {
      await this.load(db, ctx, id); // 404 outside this organisation
      await db.execute(sql`select app.link_employee_login(${id}::uuid, ${body.userId}::uuid)`);
      return this.load(db, ctx, id);
    });
  }

  private async load(db: Db, ctx: RequestContext, id: string): Promise<Employee> {
    const result = await db.execute<Row>(sql`${sql.raw(SELECT)} where e.id = ${id}::uuid and e.organisation_id = ${orgOf(ctx)}::uuid`);
    if (!result.rows.length) throw ApiError.notFound('employee_not_found', 'Employee not found');
    return toEmployee(result.rows[0]);
  }
}
