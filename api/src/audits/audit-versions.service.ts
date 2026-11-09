import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { iso, num, personName, Row } from '../calibration/calibration.service';
import { DatabaseService, Db } from '../database/database.service';
import { AuditVersion, VersionSummary } from './audits.schemas';
import { diffVersions, VContent, VQuestion, VTarget } from './audit-versions';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;

type Loaded = {
  version: number;
  row: Row;
  content: VContent;
  targetLabels: { kind: VTarget['kind']; label: string }[];
};

const toQuestion = (q: Row): VQuestion => ({
  sequence: Number(q.sequence),
  question: q.question as string,
  guidance: (q.guidance as string) ?? null,
  answerType: q.answer_type as string,
  passAnswer: (q.pass_answer as string) ?? null,
  unit: (q.unit as string) ?? null,
  lowerLimit: num(q.lower_limit),
  upperLimit: num(q.upper_limit),
  nominal: num(q.nominal),
  options: (q.options as { label: string; passes: boolean }[] | null) ?? null,
  ratingMax: num(q.rating_max),
  passRating: num(q.pass_rating),
  critical: q.critical as boolean,
});

/**
 * The history of an audit: every version with the reason it was made, what changed from the one before, and the records done against it. Read-only (audits.read); versions are
 * written by the database function that saves a change (see AuditsService).
 */
@Injectable()
export class AuditVersionsService {
  constructor(private readonly database: DatabaseService) {}

  list(ctx: RequestContext, auditId: string): Promise<{ data: VersionSummary[] }> {
    return this.database.asUser(ctx, async (db) => {
      const loaded = await this.loadAll(db, ctx, auditId);
      const counts = await db.execute<Row>(sql`select audit_version as version, count(*) as n from public.audit_records where audit_definition_id = ${auditId}::uuid and audit_version is not null group by 1`);
      const records = new Map(counts.rows.map((r) => [Number(r.version), Number(r.n)]));
      const latest = loaded.length ? loaded[loaded.length - 1].version : 0;
      const data = loaded.map((v, i) => this.summary(v, i === 0 ? null : loaded[i - 1], latest, records.get(v.version) ?? 0));
      return { data: data.reverse() };
    });
  }

  get(ctx: RequestContext, auditId: string, version: number): Promise<AuditVersion> {
    return this.database.asUser(ctx, async (db) => {
      const loaded = await this.loadAll(db, ctx, auditId);
      const i = loaded.findIndex((v) => v.version === version);
      if (i < 0) throw ApiError.notFound('audit_version_not_found', 'That version of the audit does not exist');
      const v = loaded[i];
      const previous = i === 0 ? null : loaded[i - 1];
      const latest = loaded[loaded.length - 1].version;
      const records = await db.execute<Row>(sql`
        select r.id, r.reference, r.status, r.result, to_char(r.performed_on, 'YYYY-MM-DD') as performed_on
          from public.audit_records r where r.audit_definition_id = ${auditId}::uuid and r.audit_version = ${version}
         order by r.started_at desc limit 25`);
      const count = await db.execute<Row>(sql`select count(*) as n from public.audit_records where audit_definition_id = ${auditId}::uuid and audit_version = ${version}`);
      const changes = previous ? diffVersions(previous.content, v.content) : null;
      const toTarget = (t: VTarget) => ({ kind: t.kind, label: t.label });
      return {
        ...this.summary(v, previous, latest, Number(count.rows[0].n)),
        auditType: v.row.audit_type as AuditVersion['auditType'],
        purpose: (v.row.purpose as string) ?? null,
        procedure: (v.row.procedure as string) ?? null,
        questions: v.content.questions as AuditVersion['questions'],
        targets: v.targetLabels,
        records: records.rows.map((r) => ({
          id: r.id as string,
          reference: r.reference as string,
          status: r.status as 'in_progress' | 'completed' | 'abandoned',
          result: (r.result as 'pass' | 'fail') ?? null,
          performedOn: r.performed_on as string,
        })),
        changes: changes
          ? {
              header: changes.header,
              questions: changes.questions as NonNullable<AuditVersion['changes']>['questions'],
              targets: { added: changes.targets.added.map(toTarget), removed: changes.targets.removed.map(toTarget) },
            }
          : null,
      };
    });
  }

  // ---- internals -----------------------------------------------------------------------------

  private summary(v: Loaded, previous: Loaded | null, latest: number, recordCount: number): VersionSummary {
    return {
      version: v.version,
      reason: v.row.reason as string,
      createdAt: iso(v.row.created_at)!,
      createdBy: v.row.created_by ? { id: v.row.created_by as string, name: (v.row.created_name as string) ?? 'Unknown user' } : null,
      current: v.version === latest,
      title: v.content.title,
      passMark: v.content.passMark,
      questionCount: v.content.questions.length,
      criticalCount: v.content.questions.filter((q) => q.critical).length,
      targetCount: v.content.targets.length,
      recordCount,
      summary: previous ? diffVersions(previous.content, v.content).summary : [],
    };
  }

  /** Every version of the audit, oldest first, with its questions and what it is relevant to. */
  private async loadAll(db: Db, ctx: RequestContext, auditId: string): Promise<Loaded[]> {
    const exists = await db.execute(sql`select 1 from public.audit_definitions where id = ${auditId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
    if (!exists.rows.length) throw ApiError.notFound('audit_not_found', 'Audit not found');
    const versions = await db.execute<Row>(sql`
      select v.id, v.version, v.reason, v.created_at, v.created_by, ${sql.raw(personName('cp'))} as created_name, v.title, v.audit_type, v.purpose, v.procedure, v.pass_mark
        from public.audit_versions v left join public.profiles cp on cp.id = v.created_by
       where v.audit_definition_id = ${auditId}::uuid order by v.version`);
    if (!versions.rows.length) return [];
    const questions = await db.execute<Row>(sql`
      select q.audit_version_id, q.sequence, q.question, q.guidance, q.answer_type, q.pass_answer, q.unit, q.lower_limit, q.upper_limit, q.nominal, q.options, q.rating_max, q.pass_rating, q.critical
        from public.audit_version_questions q join public.audit_versions v on v.id = q.audit_version_id
       where v.audit_definition_id = ${auditId}::uuid order by q.audit_version_id, q.sequence`);
    const targets = await db.execute<Row>(sql`
      select t.audit_version_id, t.kind, coalesce(t.machine_id::text, t.operation_code, t.department_id::text, t.supplier_id::text) as ref, t.label
        from public.audit_version_targets t join public.audit_versions v on v.id = t.audit_version_id
       where v.audit_definition_id = ${auditId}::uuid order by t.audit_version_id, t.kind, t.label`);
    return versions.rows.map((row) => {
      const qs = questions.rows.filter((q) => q.audit_version_id === row.id).map(toQuestion);
      const ts = targets.rows.filter((t) => t.audit_version_id === row.id).map((t) => ({ kind: t.kind as VTarget['kind'], ref: t.ref as string, label: t.label as string }));
      return {
        version: Number(row.version),
        row,
        content: { title: row.title as string, auditType: row.audit_type as string, purpose: (row.purpose as string) ?? null, procedure: (row.procedure as string) ?? null, passMark: Number(row.pass_mark), questions: qs, targets: ts },
        targetLabels: ts.map((t) => ({ kind: t.kind, label: t.label })),
      };
    });
  }
}
