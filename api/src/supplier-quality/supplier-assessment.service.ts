import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { iso, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import {
  ApprovalDecision, AssessmentDetail, AssessmentSummary, CompleteAssessmentBody, CreateTemplateBody, DecideApprovalBody, ProposeApprovalBody, ReasonBody, ResponseBody, SaveTemplateVersionBody,
  StartAssessmentBody, Template, UpdateTemplateBody,
} from './supplier-assessment.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const person = (id: unknown, name: unknown) => (id ? { id: id as string, name: (name as string) ?? 'Unknown user' } : null);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

type RawQuestion = { key: string; section?: string; text: string; answerType: 'yes_no' | 'rating' | 'text'; weight: number; critical: boolean; evidenceRequired: boolean; passRating?: number };
const toQuestion = (q: RawQuestion) => ({ key: q.key, section: q.section ?? '', text: q.text, answerType: q.answerType, weight: Number(q.weight), critical: !!q.critical, evidenceRequired: !!q.evidenceRequired, passRating: q.passRating ?? null });

/**
 * Supplier qualification (SQ2c): assessment templates (versioned), assessments scored by the database and frozen when completed, and approval decisions (proposed by one person,
 * decided by another). Every write is a database function; this service shapes what the screens need.
 */
@Injectable()
export class SupplierAssessmentService {
  constructor(private readonly database: DatabaseService) {}

  private async assertSupplier(db: Db, ctx: RequestContext, id: string) {
    const res = await db.execute(sql`select 1 from public.suppliers where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
    if (res.rows.length === 0) throw ApiError.notFound('supplier_not_found', 'Supplier not found');
  }

  // ---- templates -----------------------------------------------------------------------------------

  templates(ctx: RequestContext): Promise<{ data: Template[] }> {
    return this.database.asUser(ctx, async (db) => ({ data: await this.listTemplates(db, ctx) }));
  }

  private async listTemplates(db: Db, ctx: RequestContext, onlyId?: string): Promise<Template[]> {
    const rows = await db.execute<Row>(sql`
      select t.id, t.name, t.description, t.active, v.id as version_id, v.version, v.pass_mark, v.questions,
             (select jsonb_agg(jsonb_build_object('version', x.version, 'createdAt', x.created_at, 'createdBy', x.created_by, 'createdByName', ${sql.raw(personName('px'))}, 'reason', x.reason,
                               'passMark', x.pass_mark, 'questions', jsonb_array_length(x.questions)) order by x.version desc)
                from public.supplier_assessment_template_versions x left join public.profiles px on px.id = x.created_by where x.template_id = t.id) as versions
      from public.supplier_assessment_templates t
      join public.supplier_assessment_template_versions v on v.template_id = t.id and v.version = (select max(version) from public.supplier_assessment_template_versions where template_id = t.id)
      where t.organisation_id = ${orgOf(ctx)}::uuid ${onlyId ? sql`and t.id = ${onlyId}::uuid` : sql``}
      order by t.active desc, lower(t.name)`);
    return rows.rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      description: (r.description as string) ?? null,
      active: !!r.active,
      versionId: r.version_id as string,
      version: Number(r.version),
      passMark: Number(r.pass_mark),
      questions: (r.questions as RawQuestion[]).map(toQuestion),
      versions: (r.versions as Array<{ version: number; createdAt: string; createdBy: string | null; createdByName: string | null; reason: string; passMark: number; questions: number }>).map((v) => ({
        version: v.version, createdAt: new Date(v.createdAt).toISOString(), createdBy: person(v.createdBy, v.createdByName), reason: v.reason, passMark: v.passMark, questions: v.questions,
      })),
    }));
  }

  private async oneTemplate(db: Db, ctx: RequestContext, id: string): Promise<Template> {
    const t = (await this.listTemplates(db, ctx, id))[0];
    if (!t) throw ApiError.notFound('assessment_template_not_found', 'Template not found');
    return t;
  }

  createTemplate(ctx: RequestContext, b: CreateTemplateBody): Promise<Template> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ id: string }>(sql`select app.create_supplier_assessment_template(${orgOf(ctx)}::uuid, ${b.name}, ${b.description || null}, ${JSON.stringify(b.questions)}::jsonb, ${b.passMark}::int) as id`);
      return this.oneTemplate(db, ctx, res.rows[0].id);
    });
  }

  updateTemplate(ctx: RequestContext, id: string, b: UpdateTemplateBody): Promise<Template> {
    return this.database.asUser(ctx, async (db) => {
      await this.oneTemplate(db, ctx, id);
      await db.execute(sql`select app.update_supplier_assessment_template(${id}::uuid, ${JSON.stringify(b)}::jsonb)`);
      return this.oneTemplate(db, ctx, id);
    });
  }

  saveTemplateVersion(ctx: RequestContext, id: string, b: SaveTemplateVersionBody): Promise<Template> {
    return this.database.asUser(ctx, async (db) => {
      await this.oneTemplate(db, ctx, id);
      await db.execute(sql`select app.save_supplier_assessment_template_version(${id}::uuid, ${JSON.stringify(b.questions)}::jsonb, ${b.passMark}::int, ${b.reason})`);
      return this.oneTemplate(db, ctx, id);
    });
  }

  // ---- assessments ---------------------------------------------------------------------------------

  private summaryOf = (r: Row): AssessmentSummary => ({
    id: r.id as string,
    reference: r.reference as string,
    supplierId: r.supplier_id as string,
    templateName: r.template_name as string,
    templateVersion: Number(r.template_version),
    passMark: Number(r.pass_mark),
    status: r.status as AssessmentSummary['status'],
    startedAt: iso(r.started_at)!,
    startedBy: person(r.started_by, r.started_by_name),
    completedAt: iso(r.completed_at),
    score: num(r.score),
    result: (r.result as AssessmentSummary['result']) ?? null,
    criticalFailures: num(r.critical_failures),
  });

  assessments(ctx: RequestContext, supplierId: string): Promise<{ data: AssessmentSummary[] }> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertSupplier(db, ctx, supplierId);
      const rows = await db.execute<Row>(sql`
        select a.*, ${sql.raw(personName('p'))} as started_by_name from public.supplier_assessments a left join public.profiles p on p.id = a.started_by
        where a.supplier_id = ${supplierId}::uuid and a.organisation_id = ${orgOf(ctx)}::uuid order by (a.status = 'in_progress') desc, a.started_at desc`);
      return { data: rows.rows.map(this.summaryOf) };
    });
  }

  private async loadAssessment(db: Db, ctx: RequestContext, id: string): Promise<AssessmentDetail> {
    const rows = await db.execute<Row>(sql`
      select a.*, ${sql.raw(personName('p'))} as started_by_name, ${sql.raw(personName('pc'))} as completed_by_name, s.code as supplier_code, s.name as supplier_name
      from public.supplier_assessments a join public.suppliers s on s.id = a.supplier_id
      left join public.profiles p on p.id = a.started_by left join public.profiles pc on pc.id = a.completed_by
      where a.id = ${id}::uuid and a.organisation_id = ${orgOf(ctx)}::uuid`);
    const a = rows.rows[0];
    if (!a) throw ApiError.notFound('supplier_assessment_not_found', 'Assessment not found');
    const responses = await db.execute<Row>(sql`
      select r.*, d.title as doc_title, d.file_name as doc_file from public.supplier_assessment_responses r left join public.supplier_documents d on d.id = r.document_id where r.assessment_id = ${id}::uuid`);
    const by = new Map(responses.rows.map((r) => [r.question_key as string, r]));
    const progress = (await db.execute<{ p: Record<string, unknown> }>(sql`select app.supplier_assessment_progress(${id}::uuid) as p`)).rows[0].p;
    return {
      ...this.summaryOf(a),
      supplier: { id: a.supplier_id as string, code: a.supplier_code as string, name: a.supplier_name as string },
      completedBy: person(a.completed_by, a.completed_by_name),
      summary: (a.summary as string) ?? null,
      abandonReason: (a.abandon_reason as string) ?? null,
      questions: (a.questions as RawQuestion[]).map((q) => {
        const r = by.get(q.key);
        return {
          ...toQuestion(q),
          response: r
            ? {
                answer: (r.answer as 'yes' | 'no' | 'na') ?? null,
                rating: num(r.rating),
                note: (r.note as string) ?? null,
                document: r.document_id ? { id: r.document_id as string, title: (r.doc_title as string) ?? 'Document', fileName: (r.doc_file as string) ?? '' } : null,
                result: r.result as 'pass' | 'fail' | 'na' | 'unscored',
                answeredAt: iso(r.answered_at)!,
              }
            : null,
        };
      }),
      progress: {
        scored: Number(progress.scored),
        answered: Number(progress.answered),
        problems: progress.problems as string[],
        score: num(progress.score),
        criticalFailures: Number(progress.criticalFailures),
        passMark: Number(progress.passMark),
        result: (progress.result as 'pass' | 'fail' | null) ?? null,
      },
    };
  }

  assessment(ctx: RequestContext, id: string): Promise<AssessmentDetail> {
    return this.database.asUser(ctx, (db) => this.loadAssessment(db, ctx, id));
  }

  startAssessment(ctx: RequestContext, supplierId: string, b: StartAssessmentBody): Promise<AssessmentDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertSupplier(db, ctx, supplierId);
      const res = await db.execute<{ id: string }>(sql`select app.start_supplier_assessment(${supplierId}::uuid, ${b.templateVersionId}::uuid) as id`);
      return this.loadAssessment(db, ctx, res.rows[0].id);
    });
  }

  respond(ctx: RequestContext, id: string, b: ResponseBody): Promise<AssessmentDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadAssessment(db, ctx, id);
      await db.execute(sql`select app.record_supplier_assessment_response(${id}::uuid, ${b.questionKey}, ${b.answer ?? null}, ${b.rating ?? null}::int, ${b.note ?? null}, ${b.documentId ?? null}::uuid)`);
      return this.loadAssessment(db, ctx, id);
    });
  }

  complete(ctx: RequestContext, id: string, b: CompleteAssessmentBody): Promise<AssessmentDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadAssessment(db, ctx, id);
      await db.execute(sql`select app.complete_supplier_assessment(${id}::uuid, ${b.summary ?? null})`);
      return this.loadAssessment(db, ctx, id);
    });
  }

  abandon(ctx: RequestContext, id: string, b: ReasonBody): Promise<AssessmentDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadAssessment(db, ctx, id);
      await db.execute(sql`select app.abandon_supplier_assessment(${id}::uuid, ${b.reason})`);
      return this.loadAssessment(db, ctx, id);
    });
  }

  // ---- approval decisions --------------------------------------------------------------------------

  private async listDecisions(ctx: RequestContext, db: Db, where: ReturnType<typeof sql>): Promise<ApprovalDecision[]> {
    const rows = await db.execute<Row>(sql`
      select d.*, d.review_on::text as review_on_t, ${sql.raw(personName('pp'))} as proposed_by_name, ${sql.raw(personName('pd'))} as decided_by_name,
             a.reference as assessment_reference, a.result as assessment_result, a.score as assessment_score,
             (d.status = 'proposed' and d.proposed_by <> auth.uid() and app.has_permission(d.organisation_id, 'supplier_quality.approve')) as can_decide
      from public.supplier_approval_decisions d left join public.supplier_assessments a on a.id = d.assessment_id
      left join public.profiles pp on pp.id = d.proposed_by left join public.profiles pd on pd.id = d.decided_by
      where d.organisation_id = ${orgOf(ctx)}::uuid and ${where} order by d.proposed_at desc, d.id`);
    return rows.rows.map((d) => ({
      id: d.id as string,
      supplierId: d.supplier_id as string,
      fromStatus: d.from_status as string,
      target: d.target_status as ApprovalDecision['target'],
      rationale: d.rationale as string,
      conditions: (d.conditions as string) ?? null,
      reviewOn: (d.review_on_t as string) ?? null,
      exceptionReason: (d.exception_reason as string) ?? null,
      assessment: d.assessment_id ? { id: d.assessment_id as string, reference: d.assessment_reference as string, result: (d.assessment_result as 'pass' | 'fail') ?? null, score: num(d.assessment_score) } : null,
      status: d.status as ApprovalDecision['status'],
      proposedBy: person(d.proposed_by, d.proposed_by_name),
      proposedAt: iso(d.proposed_at)!,
      decidedBy: person(d.decided_by, d.decided_by_name),
      decidedAt: iso(d.decided_at),
      decisionNote: (d.decision_note as string) ?? null,
      canDecide: !!d.can_decide,
    }));
  }

  decisions(ctx: RequestContext, supplierId: string): Promise<{ data: ApprovalDecision[] }> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertSupplier(db, ctx, supplierId);
      return { data: await this.listDecisions(ctx, db, sql`d.supplier_id = ${supplierId}::uuid`) };
    });
  }

  private async oneDecision(ctx: RequestContext, db: Db, id: string): Promise<ApprovalDecision> {
    const d = (await this.listDecisions(ctx, db, sql`d.id = ${id}::uuid`))[0];
    if (!d) throw ApiError.notFound('approval_decision_not_found', 'Approval decision not found');
    return d;
  }

  propose(ctx: RequestContext, supplierId: string, b: ProposeApprovalBody): Promise<ApprovalDecision> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertSupplier(db, ctx, supplierId);
      const res = await db.execute<{ id: string }>(sql`
        select app.propose_supplier_approval(${supplierId}::uuid, ${b.target}, ${b.rationale}, ${b.assessmentId ?? null}::uuid, ${b.conditions ?? null}, ${b.reviewOn ?? null}::date, ${b.exceptionReason ?? null}) as id`);
      return this.oneDecision(ctx, db, res.rows[0].id);
    });
  }

  decide(ctx: RequestContext, id: string, b: DecideApprovalBody): Promise<ApprovalDecision> {
    return this.database.asUser(ctx, async (db) => {
      await this.oneDecision(ctx, db, id);
      await db.execute(sql`select app.decide_supplier_approval(${id}::uuid, ${b.approve}, ${b.note})`);
      return this.oneDecision(ctx, db, id);
    });
  }

  withdraw(ctx: RequestContext, id: string, b: ReasonBody): Promise<ApprovalDecision> {
    return this.database.asUser(ctx, async (db) => {
      await this.oneDecision(ctx, db, id);
      await db.execute(sql`select app.withdraw_supplier_approval(${id}::uuid, ${b.reason})`);
      return this.oneDecision(ctx, db, id);
    });
  }
}
