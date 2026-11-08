import { Injectable } from '@nestjs/common';
import { SQL, sql } from 'drizzle-orm';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { iso, num, personName, ref, Row } from '../calibration/calibration.service';
import { DatabaseService, Db } from '../database/database.service';
import {
  AbandonBody,
  AuditRecord,
  RaiseNcrBody,
  RecordListQuery,
  RecordSummary,
  ResponseBody,
  SetTargetsBody,
  StartAuditBody,
  UpdateRecordBody,
} from './audit-records.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

/** The person who did the audit: whoever completed it, else whoever started it. */
const AUDITOR = 'coalesce(r.completed_by, r.started_by)';

const SELECT = `
  select r.id, r.reference, r.status, r.result, r.score, r.pass_mark, r.passed_count, r.failed_count, r.na_count, r.critical_failed_count,
         r.audit_definition_id, r.audit_reference, r.audit_title, r.audit_type, r.procedure, r.notes, r.abandon_reason, r.completed_at, r.completed_by, r.started_at,
         to_char(r.performed_on, 'YYYY-MM-DD') as performed_on, to_char(o.due_on, 'YYYY-MM-DD') as scheduled_for,
         ${AUDITOR} as auditor_id, ${personName('ap')} as auditor_name, ${personName('cp')} as completed_name,
         (select coalesce(array_agg(t.label order by t.label), '{}') from public.audit_record_targets t where t.audit_record_id = r.id) as carried_out_on
    from public.audit_records r
    left join public.audit_occurrences o on o.id = r.occurrence_id
    left join public.profiles ap on ap.id = ${AUDITOR}
    left join public.profiles cp on cp.id = r.completed_by`;

const SORT_SQL: Record<RecordListQuery['sort'], string[]> = {
  reference: ['r.reference'],
  audit: ['lower(r.audit_title)'],
  performedOn: ['r.performed_on', 'r.started_at'],
  result: ['r.result'],
  score: ['r.score'],
  status: ['r.status'],
  startedAt: ['r.started_at'],
};

const toSummary = (r: Row): RecordSummary => ({
  id: r.id as string,
  reference: r.reference as string,
  status: r.status as RecordSummary['status'],
  result: (r.result as RecordSummary['result']) ?? null,
  score: num(r.score),
  passMark: Number(r.pass_mark),
  passedCount: num(r.passed_count),
  failedCount: num(r.failed_count),
  criticalFailedCount: num(r.critical_failed_count),
  audit: { id: r.audit_definition_id as string, reference: r.audit_reference as string, title: r.audit_title as string, auditType: r.audit_type as RecordSummary['audit']['auditType'] },
  carriedOutOn: (r.carried_out_on as string[]) ?? [],
  scheduledFor: (r.scheduled_for as string) ?? null,
  performedOn: r.performed_on as string,
  auditor: ref(r.auditor_id, r.auditor_name, 'Unnamed person'),
  completedAt: iso(r.completed_at),
  startedAt: iso(r.started_at)!,
});

/**
 * Audit records: one audit actually carried out. Started, answered, completed and abandoned only by database functions (audits.perform), which freeze a copy of the audit's
 * questions into the record, work out each answer's result and the record's score and result, and refuse changes once it is completed. Raising a non-conformance is on request.
 */
@Injectable()
export class AuditRecordsService {
  constructor(private readonly database: DatabaseService) {}

  list(ctx: RequestContext, q: RecordListQuery): Promise<{ data: RecordSummary[]; page: number; pageSize: number; total: number }> {
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`r.organisation_id = ${orgOf(ctx)}::uuid`];
      if (q.auditId) where.push(sql`r.audit_definition_id = ${q.auditId}::uuid`);
      if (q.status.length) where.push(sql`r.status = any (string_to_array(${q.status.join(',')}, ','))`);
      if (q.result.length) where.push(sql`r.result = any (string_to_array(${q.result.join(',')}, ','))`);
      if (q.type.length) where.push(sql`r.audit_type = any (string_to_array(${q.type.join(',')}, ','))`);
      if (q.machineId) where.push(sql`exists (select 1 from public.audit_record_targets t where t.audit_record_id = r.id and t.machine_id = ${q.machineId}::uuid)`);
      if (q.operationCode) where.push(sql`exists (select 1 from public.audit_record_targets t where t.audit_record_id = r.id and upper(t.operation_code) = upper(${q.operationCode}))`);
      if (q.departmentId) where.push(sql`exists (select 1 from public.audit_record_targets t where t.audit_record_id = r.id and t.department_id = ${q.departmentId}::uuid)`);
      if (q.performedBy) where.push(sql`${sql.raw(AUDITOR)} = ${q.performedBy}::uuid`);
      if (q.mine === 'true') where.push(sql`${sql.raw(AUDITOR)} = ${ctx.user.id}::uuid`);
      if (q.from) where.push(sql`r.performed_on >= ${q.from}::date`);
      if (q.to) where.push(sql`r.performed_on <= ${q.to}::date`);
      if (q.q) {
        const like = likePattern(q.q);
        where.push(sql`(r.reference ilike ${like} or r.audit_title ilike ${like} or r.audit_reference ilike ${like})`);
      }
      const order = sql.raw(`${SORT_SQL[q.sort].map((x) => `${x} ${q.order} nulls last`).join(', ')}, r.reference desc`);
      const result = await db.execute<Row>(sql`${sql.raw(SELECT)} where ${sql.join(where, sql` and `)} order by ${order} limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`);
      const count = await db.execute<{ n: string }>(sql`select count(*) as n from public.audit_records r where ${sql.join(where, sql` and `)}`);
      return { data: result.rows.map(toSummary), page: q.page, pageSize: q.pageSize, total: Number(count.rows[0].n) };
    });
  }

  get(ctx: RequestContext, id: string): Promise<AuditRecord> {
    return this.database.asUser(ctx, (db) => this.load(db, ctx, id));
  }

  start(ctx: RequestContext, body: StartAuditBody): Promise<AuditRecord> {
    return this.database.asUser(ctx, async (db) => {
      const r = await db.execute<{ id: string }>(
        sql`select app.start_audit(${body.auditId}::uuid, ${body.occurrenceId ?? null}::uuid, ${JSON.stringify(body.targets)}::jsonb) as id`,
      );
      return this.load(db, ctx, r.rows[0].id);
    });
  }

  setTargets(ctx: RequestContext, id: string, body: SetTargetsBody): Promise<AuditRecord> {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.set_audit_record_targets(${id}::uuid, ${JSON.stringify(body.targets)}::jsonb)`);
      return this.load(db, ctx, id);
    });
  }

  respond(ctx: RequestContext, id: string, body: ResponseBody): Promise<AuditRecord> {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(
        sql`select app.record_audit_response(${id}::uuid, ${body.questionId}::uuid, ${body.answer ?? null}::text, ${body.value ?? null}::numeric, ${body.note ?? null}::text)`,
      );
      return this.load(db, ctx, id);
    });
  }

  update(ctx: RequestContext, id: string, body: UpdateRecordBody): Promise<AuditRecord> {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(
        sql`select app.update_audit_record(${id}::uuid, ${body.notes ?? null}::text, ${body.performedOn ?? null}::date, ${body.notes !== undefined})`,
      );
      return this.load(db, ctx, id);
    });
  }

  complete(ctx: RequestContext, id: string): Promise<AuditRecord> {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.complete_audit(${id}::uuid)`);
      return this.load(db, ctx, id);
    });
  }

  abandon(ctx: RequestContext, id: string, body: AbandonBody): Promise<AuditRecord> {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.abandon_audit(${id}::uuid, ${body.reason})`);
      return this.load(db, ctx, id);
    });
  }

  raiseNcr(ctx: RequestContext, id: string, body: RaiseNcrBody): Promise<{ nonconformanceId: string; record: AuditRecord }> {
    return this.database.asUser(ctx, async (db) => {
      const ids = `{${body.responseIds.join(',')}}`;
      const r = await db.execute<{ id: string }>(
        sql`select app.raise_ncr_from_audit(${id}::uuid, ${ids}::uuid[], ${body.title}, ${body.description ?? null}::text, ${body.severity ?? null}::text) as id`,
      );
      return { nonconformanceId: r.rows[0].id, record: await this.load(db, ctx, id) };
    });
  }

  // ---- internals -----------------------------------------------------------------------------
  private async load(db: Db, ctx: RequestContext, id: string): Promise<AuditRecord> {
    const head = await db.execute<Row>(sql`${sql.raw(SELECT)} where r.id = ${id}::uuid and r.organisation_id = ${orgOf(ctx)}::uuid`);
    if (!head.rows.length) throw ApiError.notFound('audit_record_not_found', 'Audit record not found');
    const r = head.rows[0];
    const inProgress = r.status === 'in_progress';

    const questions = await db.execute<Row>(sql`
      select q.id, q.sequence, q.question, q.guidance, q.answer_type, q.pass_answer, q.unit, q.lower_limit, q.upper_limit, q.critical,
             s.id as response_id, s.answer, s.value_number, s.note, s.result,
             (select coalesce(json_agg(json_build_object('id', n.id, 'reference', n.reference, 'stage', n.stage) order by n.created_at), '[]'::json)
                from public.audit_ncr_links l join public.nonconformances n on n.id = l.nonconformance_id
               where l.response_id = s.id and n.deleted_at is null and n.stage <> 'cancelled') as ncrs
        from public.audit_record_questions q
        left join public.audit_responses s on s.record_question_id = q.id
       where q.audit_record_id = ${id}::uuid
       order by q.sequence`);
    const targets = await db.execute<Row>(sql`
      select kind, case kind when 'machine' then machine_id::text when 'operation' then operation_code when 'department' then department_id::text end as id, label
        from public.audit_record_targets where audit_record_id = ${id}::uuid order by label`);
    // What can be chosen: what the audit lists today (the labels are the ones the database keeps).
    const available = inProgress
      ? await db.execute<Row>(sql`
          select t.kind, case t.kind when 'machine' then t.machine_id::text when 'operation' then t.operation_code when 'department' then t.department_id::text end as id,
                 coalesce(m.code || ' · ' || m.name, t.operation_code, dp.code || ' · ' || dp.name) as label
            from public.audit_targets t
            left join public.machines m on m.id = t.machine_id
            left join public.departments dp on dp.id = t.department_id
           where t.audit_definition_id = ${r.audit_definition_id as string}::uuid
           order by t.kind, label`)
      : { rows: [] as Row[] };
    const targetsRequired = inProgress
      ? (await db.execute<{ n: string }>(sql`select count(*) as n from public.audit_targets where audit_definition_id = ${r.audit_definition_id as string}::uuid`)).rows[0].n !== '0'
      : false;
    const problems = inProgress ? ((await db.execute<{ p: string[] }>(sql`select app.audit_record_problems(${id}::uuid) as p`)).rows[0].p ?? []) : [];

    return {
      ...toSummary(r),
      procedure: (r.procedure as string) ?? null,
      notes: (r.notes as string) ?? null,
      abandonReason: (r.abandon_reason as string) ?? null,
      naCount: num(r.na_count),
      completedBy: ref(r.completed_by, r.completed_name, 'Unnamed person'),
      availableTargets: available.rows.map((t) => ({ kind: t.kind as 'machine' | 'operation' | 'department', id: t.id as string, label: t.label as string })),
      targetsRequired,
      problems,
      targets: targets.rows.map((t) => ({ kind: t.kind as 'machine' | 'operation' | 'department', id: t.id as string, label: t.label as string })),
      questions: questions.rows.map((q) => ({
        id: q.id as string,
        sequence: Number(q.sequence),
        question: q.question as string,
        guidance: (q.guidance as string) ?? null,
        answerType: q.answer_type as AuditRecord['questions'][number]['answerType'],
        passAnswer: (q.pass_answer as 'yes' | 'no') ?? null,
        unit: (q.unit as string) ?? null,
        lowerLimit: num(q.lower_limit),
        upperLimit: num(q.upper_limit),
        critical: q.critical as boolean,
        response: q.response_id
          ? {
              id: q.response_id as string,
              answer: (q.answer as 'pass' | 'fail' | 'yes' | 'no' | 'na' | null) ?? null,
              value: num(q.value_number),
              note: (q.note as string) ?? null,
              result: (q.result as 'pass' | 'fail' | 'na') ?? null,
              ncrs: (q.ncrs as { id: string; reference: string; stage: string }[]) ?? [],
            }
          : null,
      })),
    };
  }
}
