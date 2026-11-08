import { Injectable } from '@nestjs/common';
import { SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { iso, personName, Row } from '../calibration/calibration.service';
import { DatabaseService, Db } from '../database/database.service';
import { Audit, AuditListQuery, AuditSummary, CreateAuditBody, UpdateAuditBody } from './audits.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
const num = (v: unknown) => (v == null ? null : Number(v));

const SELECT = `
  select d.id, d.reference, d.title, d.audit_type, d.purpose, d.procedure, d.frequency_kind, d.frequency_interval, to_char(d.first_due_on, 'YYYY-MM-DD') as first_due_on,
         d.grace_days, d.weekdays_only, d.auditor_kind, d.pass_mark, d.status, d.retired_at, d.retired_by, d.retired_reason, d.created_at, d.updated_at, d.created_by,
         case d.auditor_kind when 'person' then d.auditor_user_id when 'role' then d.auditor_role_id when 'department' then d.auditor_department_id end as auditor_id,
         case d.auditor_kind when 'person' then coalesce(${personName('ap')}, 'Unnamed person') when 'role' then ar.name when 'department' then ad.name end as auditor_name,
         ${personName('cp')} as created_name, ${personName('rp')} as retired_name,
         (select count(*) from public.audit_questions q where q.audit_definition_id = d.id) as question_count,
         (select count(*) from public.audit_questions q where q.audit_definition_id = d.id and q.critical) as critical_count,
         (select count(*) from public.audit_targets t where t.audit_definition_id = d.id and t.kind = 'machine') as machine_count,
         (select count(*) from public.audit_targets t where t.audit_definition_id = d.id and t.kind = 'operation') as operation_count,
         (select count(*) from public.audit_targets t where t.audit_definition_id = d.id and t.kind = 'department') as department_count,
         (select coalesce(array_agg(x.label order by x.label), '{}') from (
             select coalesce(m.code, t.operation_code, dp.code) as label
               from public.audit_targets t left join public.machines m on m.id = t.machine_id left join public.departments dp on dp.id = t.department_id
              where t.audit_definition_id = d.id order by 1 limit 4) x) as target_preview
    from public.audit_definitions d
    left join public.profiles ap on ap.id = d.auditor_user_id
    left join public.roles ar on ar.id = d.auditor_role_id
    left join public.departments ad on ad.id = d.auditor_department_id
    left join public.profiles cp on cp.id = d.created_by
    left join public.profiles rp on rp.id = d.retired_by`;

const SORT_SQL: Record<AuditListQuery['sort'], string[]> = {
  reference: ['d.audit_number'],
  title: ['lower(d.title)'],
  type: ['d.audit_type'],
  frequency: [`array_position(array['daily','weekly','monthly','quarterly','six_monthly','yearly','every_n_days','on_demand'], d.frequency_kind)`, 'd.frequency_interval'],
  status: ['d.status'],
  createdAt: ['d.created_at'],
};

const toBase = (r: Row) => ({
  id: r.id as string,
  reference: r.reference as string,
  title: r.title as string,
  auditType: r.audit_type as AuditSummary['auditType'],
  frequency: { kind: r.frequency_kind as AuditSummary['frequency']['kind'], interval: num(r.frequency_interval), firstDueOn: (r.first_due_on as string) ?? null },
  auditor: { kind: r.auditor_kind as AuditSummary['auditor']['kind'], id: (r.auditor_id as string) ?? null, name: (r.auditor_name as string) ?? null },
  passMark: Number(r.pass_mark),
  status: r.status as AuditSummary['status'],
  questionCount: Number(r.question_count),
  criticalCount: Number(r.critical_count),
  createdAt: iso(r.created_at)!,
});
const toSummary = (r: Row): AuditSummary => ({
  ...toBase(r),
  targets: { machines: Number(r.machine_count), operations: Number(r.operation_count), departments: Number(r.department_count), preview: (r.target_preview as string[]) ?? [] },
});

/**
 * Audit definitions (Documentation → Audits). The header is written under RLS (audits.manage); the checklist and the list of what the audit is relevant to are replaced
 * as a whole by database functions, and retiring is a function too. The database answers every rule in words (409 audit_rule).
 */
@Injectable()
export class AuditsService {
  constructor(private readonly database: DatabaseService) {}

  list(ctx: RequestContext, q: AuditListQuery): Promise<{ data: AuditSummary[]; page: number; pageSize: number; total: number }> {
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`d.organisation_id = ${orgOf(ctx)}::uuid`];
      if (q.status.length) where.push(sql`d.status = any (string_to_array(${q.status.join(',')}, ','))`);
      if (q.type.length) where.push(sql`d.audit_type = any (string_to_array(${q.type.join(',')}, ','))`);
      if (q.machineId) where.push(sql`exists (select 1 from public.audit_targets t where t.audit_definition_id = d.id and t.machine_id = ${q.machineId}::uuid)`);
      if (q.operationCode) where.push(sql`exists (select 1 from public.audit_targets t where t.audit_definition_id = d.id and upper(t.operation_code) = upper(${q.operationCode}))`);
      if (q.departmentId) where.push(sql`exists (select 1 from public.audit_targets t where t.audit_definition_id = d.id and t.department_id = ${q.departmentId}::uuid)`);
      if (q.q) {
        const like = likePattern(q.q);
        where.push(sql`(d.title ilike ${like} or d.reference ilike ${like} or d.purpose ilike ${like})`);
      }
      const order = sql.raw(`${SORT_SQL[q.sort].map((x) => `${x} ${q.order} nulls last`).join(', ')}, d.audit_number asc`);
      const result = await db.execute<Row>(sql`${sql.raw(SELECT)} where ${sql.join(where, sql` and `)} order by ${order} limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`);
      const count = await db.execute<{ n: string }>(sql`select count(*) as n from public.audit_definitions d where ${sql.join(where, sql` and `)}`);
      return { data: result.rows.map(toSummary), page: q.page, pageSize: q.pageSize, total: Number(count.rows[0].n) };
    });
  }

  get(ctx: RequestContext, id: string): Promise<Audit> {
    return this.database.asUser(ctx, (db) => this.load(db, ctx, id));
  }

  create(ctx: RequestContext, body: CreateAuditBody): Promise<Audit> {
    return this.database.asUser(ctx, async (db) => {
      const a = this.auditorColumns(body.auditor);
      const result = await db.execute<{ id: string }>(sql`
        insert into public.audit_definitions (organisation_id, title, audit_type, purpose, procedure, frequency_kind, frequency_interval, first_due_on, grace_days, weekdays_only,
                                              auditor_kind, auditor_user_id, auditor_role_id, auditor_department_id, pass_mark)
        values (${orgOf(ctx)}::uuid, ${body.title}, ${body.auditType}, ${body.purpose ?? null}, ${body.procedure ?? null}, ${body.frequency.kind}, ${body.frequency.interval ?? null},
                ${body.frequency.firstDueOn ?? null}::date, ${body.graceDays}, ${body.weekdaysOnly}, ${a.kind}, ${a.userId}::uuid, ${a.roleId}::uuid, ${a.departmentId}::uuid, ${body.passMark})
        returning id`);
      const id = result.rows[0].id;
      await this.replaceLists(db, id, body.questions, body.targets);
      return this.load(db, ctx, id);
    });
  }

  update(ctx: RequestContext, id: string, body: UpdateAuditBody): Promise<Audit> {
    return this.database.asUser(ctx, async (db) => {
      await this.load(db, ctx, id);
      const sets: SQL[] = [];
      const set = (column: string, value: unknown) => sets.push(sql`${sql.raw(column)} = ${value}`);
      if (body.title !== undefined) set('title', body.title);
      if (body.auditType !== undefined) set('audit_type', body.auditType);
      if (body.purpose !== undefined) set('purpose', body.purpose);
      if (body.procedure !== undefined) set('procedure', body.procedure);
      if (body.graceDays !== undefined) set('grace_days', body.graceDays);
      if (body.weekdaysOnly !== undefined) set('weekdays_only', body.weekdaysOnly);
      if (body.passMark !== undefined) set('pass_mark', body.passMark);
      if (body.frequency !== undefined) {
        set('frequency_kind', body.frequency.kind);
        set('frequency_interval', body.frequency.interval ?? null);
        sets.push(sql`first_due_on = ${body.frequency.firstDueOn ?? null}::date`);
      }
      if (body.auditor !== undefined) {
        const a = this.auditorColumns(body.auditor);
        set('auditor_kind', a.kind);
        sets.push(sql`auditor_user_id = ${a.userId}::uuid`, sql`auditor_role_id = ${a.roleId}::uuid`, sql`auditor_department_id = ${a.departmentId}::uuid`);
      }
      if (sets.length) {
        const r = await db.execute(sql`update public.audit_definitions set ${sql.join(sets, sql`, `)} where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid returning id`);
        // Row-level security answers "no rows" to someone who may read but not manage.
        if (!r.rows.length) throw ApiError.forbidden('Changing audits needs the audits.manage permission');
      }
      await this.replaceLists(db, id, body.questions, body.targets);
      return this.load(db, ctx, id);
    });
  }

  retire(ctx: RequestContext, id: string, reason: string): Promise<Audit> {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.retire_audit_definition(${id}::uuid, ${reason})`);
      return this.load(db, ctx, id);
    });
  }

  reactivate(ctx: RequestContext, id: string): Promise<Audit> {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.reactivate_audit_definition(${id}::uuid)`);
      return this.load(db, ctx, id);
    });
  }

  // ---- internals -----------------------------------------------------------------------------

  private auditorColumns(a: CreateAuditBody['auditor']) {
    return {
      kind: a.kind,
      userId: a.kind === 'person' ? a.userId : null,
      roleId: a.kind === 'role' ? a.roleId : null,
      departmentId: a.kind === 'department' ? a.departmentId : null,
    };
  }

  private async replaceLists(db: Db, id: string, questions?: z.infer<typeof CreateAuditBody>['questions'], targets?: z.infer<typeof CreateAuditBody>['targets']) {
    if (questions !== undefined) await db.execute(sql`select app.set_audit_checklist(${id}::uuid, ${JSON.stringify(questions)}::jsonb)`);
    if (targets !== undefined) await db.execute(sql`select app.set_audit_targets(${id}::uuid, ${JSON.stringify(targets)}::jsonb)`);
  }

  private async load(db: Db, ctx: RequestContext, id: string): Promise<Audit> {
    const r = await db.execute<Row>(sql`${sql.raw(SELECT)} where d.id = ${id}::uuid and d.organisation_id = ${orgOf(ctx)}::uuid`);
    if (!r.rows.length) throw ApiError.notFound('audit_not_found', 'Audit not found');
    const x = r.rows[0];
    const questions = await db.execute<Row>(sql`select id, sequence, question, guidance, answer_type, pass_answer, unit, lower_limit, upper_limit, critical
      from public.audit_questions where audit_definition_id = ${id}::uuid order by sequence`);
    const targets = await db.execute<Row>(sql`
      select t.kind, coalesce(t.machine_id::text, t.operation_code, t.department_id::text) as ref,
             case t.kind when 'machine' then m.code || ' · ' || m.name when 'operation' then t.operation_code else dp.code || ' · ' || dp.name end as label
        from public.audit_targets t left join public.machines m on m.id = t.machine_id left join public.departments dp on dp.id = t.department_id
       where t.audit_definition_id = ${id}::uuid order by t.kind, label`);
    const { targets: _omit, ...base } = toSummary(x);
    void _omit;
    return {
      ...base,
      purpose: (x.purpose as string) ?? null,
      procedure: (x.procedure as string) ?? null,
      graceDays: Number(x.grace_days),
      weekdaysOnly: x.weekdays_only as boolean,
      retired: x.retired_at ? { at: iso(x.retired_at)!, by: x.retired_by ? { id: x.retired_by as string, name: (x.retired_name as string) ?? 'Unknown user' } : null, reason: x.retired_reason as string } : null,
      questions: questions.rows.map((q) => ({
        id: q.id as string,
        sequence: Number(q.sequence),
        question: q.question as string,
        guidance: (q.guidance as string) ?? null,
        answerType: q.answer_type as Audit['questions'][number]['answerType'],
        passAnswer: (q.pass_answer as 'yes' | 'no') ?? null,
        unit: (q.unit as string) ?? null,
        lowerLimit: num(q.lower_limit),
        upperLimit: num(q.upper_limit),
        critical: q.critical as boolean,
      })),
      targets: targets.rows.map((t) => ({ kind: t.kind as 'machine' | 'operation' | 'department', id: t.ref as string, label: t.label as string })),
      createdBy: x.created_by ? { id: x.created_by as string, name: (x.created_name as string) ?? 'Unknown user' } : null,
      updatedAt: iso(x.updated_at)!,
    };
  }
}
