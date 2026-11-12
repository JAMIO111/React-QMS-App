import { attachCustomValues, customFilterSql, customValuesOf, writeCustomValues } from '../custom-fields/custom-values';
import { Injectable } from '@nestjs/common';
import { sql, SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { iso, personName, Row } from '../calibration/calibration.service';
import { DatabaseService, Db } from '../database/database.service';
import { Attachment, CreateAttachmentBody, DeletedQuery } from '../calibration/calibration.schemas';
import { AddTeamBody, ANALYSIS_DATA, CapaDetail, CapaSummary, CloseCapaBody, CompleteActionBody, CompleteStepBody, CreateActionBody, CreateAnalysisBody, CreateCapaBody, CreateRootCauseBody, CreateVerificationBody, LinkNcrBody, ListQuery, NcrCapaList, PeopleList, PeopleQuery, ReasonBody, ReopenStepBody, STEPS, MyActionList, MyActionsQuery, UpdateActionBody, UpdateAnalysisBody, UpdateCapaBody, UpdateRootCauseBody, UpdateTeamBody } from './capa.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const person = (id: unknown, name: unknown) => (id ? { id: id as string, name: (name as string) ?? 'Unknown' } : null);
export const RUNNING = sql`c.stage not in ('closed', 'cancelled')`;
/** Sort fields of the register, as SQL (owner and progress use the SELECT's own columns). */
const SORT_SQL: Record<ListQuery['sort'], string> = {
  reference: 'c.reference', title: 'lower(c.title)', stage: 'c.stage', owner: `lower(${personName('po')})`, dueDate: 'c.due_date', ncrCount: 'ncr_count',
  progress: 'steps_done', severity: 'c.severity', source: 'c.source', createdAt: 'c.created_at', closedAt: 'c.closed_at',
};

const SELECT = sql`
  select c.id, c.reference, c.method, c.title, c.problem_statement, c.stage, c.stage_reason, c.source, c.severity, c.external_reference,
         c.owner_membership_id, c.due_date::text as due_date, c.closed_at, c.created_at, c.updated_at, c.created_by,
         c.d2_who, c.d2_what, c.d2_where, c.d2_when, c.d2_why, c.d2_how, c.d2_how_many, c.d3_no_containment_reason, c.d7_lessons_learned, c.d7_no_preventive_reason, c.d8_recognition, c.closed_by,
         (c.due_date is not null and c.due_date < current_date and ${RUNNING}) as overdue,
         (select count(*) from public.capa_steps s where s.capa_id = c.id and s.completed_at is not null)::int as steps_done,
         (select min(s.step) from public.capa_steps s where s.capa_id = c.id and s.completed_at is null) as next_step,
         (select count(*) from public.capa_ncr_links l where l.capa_id = c.id and l.ended_at is null)::int as ncr_count,
         ${sql.raw(personName('po'))} as owner_name, ${sql.raw(personName('pc'))} as created_by_name, ${sql.raw(personName('pcb'))} as closed_by_name
  from public.capas c
  left join public.organisation_users om on om.id = c.owner_membership_id
  left join public.profiles po on po.id = om.user_id
  left join public.profiles pc on pc.id = c.created_by
  left join public.profiles pcb on pcb.id = c.closed_by`;

const toSummary = (r: Row): CapaSummary => ({
  id: r.id as string,
  reference: r.reference as string,
  method: '8d',
  title: r.title as string,
  stage: r.stage as CapaSummary['stage'],
  stageReason: (r.stage_reason as string) ?? null,
  source: r.source as CapaSummary['source'],
  severity: (r.severity as CapaSummary['severity']) ?? null,
  externalReference: (r.external_reference as string) ?? null,
  owner: r.owner_membership_id ? { membershipId: r.owner_membership_id as string, name: (r.owner_name as string) ?? 'Unknown' } : null,
  dueDate: (r.due_date as string) ?? null,
  overdue: !!r.overdue,
  currentStep: ((r.next_step as string) ?? 'd8') as CapaSummary['currentStep'],
  stepsDone: Number(r.steps_done),
  ncrCount: Number(r.ncr_count),
  createdAt: iso(r.created_at)!,
  closedAt: iso(r.closed_at),
});

const ATTACHMENT_SELECT = sql`
  select a.*, ${sql.raw(personName('pc'))} as created_by_name
  from public.capa_attachments a left join public.profiles pc on pc.id = a.created_by`;

const toAttachment = (r: Row): z.infer<typeof Attachment> => ({
  id: r.id as string,
  fileName: r.file_name as string,
  contentType: (r.content_type as string) ?? null,
  sizeBytes: Number(r.size_bytes),
  description: (r.description as string) ?? null,
  storagePath: r.storage_path as string,
  createdAt: iso(r.created_at)!,
  createdBy: r.created_by ? { id: r.created_by as string, name: (r.created_by_name as string) ?? 'Unknown user' } : null,
  deletedAt: iso(r.deleted_at),
  deleteReason: (r.delete_reason as string) ?? null,
});

/** The step each analysis kind belongs to. */
const STEP_OF_KIND = { is_is_not: 'd2', ishikawa: 'd4', five_whys: 'd4' } as const;
/** An analysis's data checked against its kind's shape (400 with the reason when it does not fit). */
const parseData = (kind: keyof typeof ANALYSIS_DATA, data: Record<string, unknown>) => {
  const parsed = ANALYSIS_DATA[kind].safeParse(data);
  if (!parsed.success) throw ApiError.badRequest('invalid_analysis', parsed.error.issues.map((i) => `${i.path.join('.') || 'data'}: ${i.message}`).join('; '));
  return parsed.data;
};

const HEADER_COLUMNS: Record<string, string> = {
  title: 'title', problemStatement: 'problem_statement', source: 'source', severity: 'severity', externalReference: 'external_reference',
  ownerMembershipId: 'owner_membership_id', dueDate: 'due_date',
  d2Who: 'd2_who', d2What: 'd2_what', d2Where: 'd2_where', d2When: 'd2_when', d2Why: 'd2_why', d2How: 'd2_how', d2HowMany: 'd2_how_many',
  d3NoContainmentReason: 'd3_no_containment_reason', d7LessonsLearned: 'd7_lessons_learned', d7NoPreventiveReason: 'd7_no_preventive_reason',
};

/**
 * Corrective actions (CAPA, method 8D), slice CAPA1: the record, its nine steps, the team and the non-conformances it addresses
 * (docs/capa-8d-plan.md). Starting, step completion, NC links and cancelling are database functions; the header and the team are edited under
 * row-level security. Commands answer with the whole 8D (it is small), as for quality alerts.
 */
@Injectable()
export class CapaService {
  constructor(private readonly database: DatabaseService) {}

  list(ctx: RequestContext, q: ListQuery, custom: Record<string, string> = {}): Promise<{ data: CapaSummary[]; page: number; pageSize: number; total: number }> {
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`c.organisation_id = ${orgOf(ctx)}::uuid`];
      const stages = q.stage.split(',');
      if (!stages.includes('all')) {
        const parts: SQL[] = [];
        if (stages.includes('running')) parts.push(RUNNING);
        const named = stages.filter((x) => x !== 'running');
        if (named.length) parts.push(sql`c.stage = any(string_to_array(${named.join(',')}, ','))`);
        where.push(sql`(${sql.join(parts, sql` or `)})`);
      }
      if (q.source) where.push(sql`c.source = any(string_to_array(${q.source}, ','))`);
      if (q.severity) where.push(sql`c.severity = any(string_to_array(${q.severity}, ','))`);
      if (q.ncrId) where.push(sql`exists (select 1 from public.capa_ncr_links l where l.capa_id = c.id and l.nonconformance_id = ${q.ncrId}::uuid and l.ended_at is null)`);
      if (q.owner === 'me') where.push(sql`om.user_id = auth.uid()`);
      if (q.overdue) where.push(sql`c.due_date is not null and c.due_date < current_date and ${RUNNING}`);
      if (q.from) where.push(sql`c.created_at::date >= ${q.from}::date`);
      if (q.to) where.push(sql`c.created_at::date <= ${q.to}::date`);
      if (q.q) {
        const like = `%${q.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
        where.push(sql`(c.title ilike ${like} or c.reference ilike ${like} or c.problem_statement ilike ${like} or c.external_reference ilike ${like}
          or ${sql.raw(personName('po'))} ilike ${like} or c.d2_who ilike ${like} or c.d2_what ilike ${like} or c.d2_where ilike ${like}
          or exists (select 1 from public.capa_ncr_links l join public.nonconformances n on n.id = l.nonconformance_id
                      where l.capa_id = c.id and l.ended_at is null and (n.reference ilike ${like} or n.title ilike ${like})))`);
      }
      const cf = await customFilterSql(db, orgOf(ctx), 'capa', sql`c.id`, custom);
      if (cf) where.push(cf);
      const pageSize = q.pageSize ?? q.limit;
      const order = sql.raw(`${SORT_SQL[q.sort]} ${q.order} nulls last, c.reference desc`);
      const clause = sql.join(where, sql` and `);
      const rows = await db.execute<Row>(sql`${SELECT} where ${clause} order by ${order} limit ${pageSize} offset ${(q.page - 1) * pageSize}`);
      const count = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from public.capas c
        left join public.organisation_users om on om.id = c.owner_membership_id
        left join public.profiles po on po.id = om.user_id
        where ${clause}`);
      return { data: await attachCustomValues(db, 'capa', rows.rows.map(toSummary)), page: q.page, pageSize, total: Number(count.rows[0].n) };
    });
  }

  get(ctx: RequestContext, id: string): Promise<CapaDetail> {
    return this.database.asUser(ctx, (db) => this.load(db, ctx, id));
  }

  create(ctx: RequestContext, body: CreateCapaBody): Promise<CapaDetail> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ id: string }>(sql`
        select app.start_capa(${orgOf(ctx)}::uuid, ${body.title ?? null}, ${body.problemStatement ?? null}, ${body.source ?? null}, ${body.severity ?? null}, ${body.fromNcrId ?? null}::uuid) as id`);
      await writeCustomValues(db, 'capa', res.rows[0].id, body.customValues);
      return this.load(db, ctx, res.rows[0].id);
    });
  }

  update(ctx: RequestContext, id: string, body: UpdateCapaBody): Promise<CapaDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.load(db, ctx, id);
      const sets: SQL[] = [];
      for (const [key, column] of Object.entries(HEADER_COLUMNS)) {
        const value = (body as Record<string, unknown>)[key];
        if (value === undefined) continue;
        const cast = key === 'dueDate' ? sql`::date` : key === 'ownerMembershipId' ? sql`::uuid` : sql``;
        sets.push(sql`${sql.raw(column)} = ${(value as string | null) === '' ? null : (value as string | null)}${cast}`);
      }
      const updated = await db.execute(sql`update public.capas set ${sql.join(sets, sql`, `)} where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid returning id`);
      if (updated.rows.length === 0) throw ApiError.forbidden('You are not allowed to edit this 8D');
      return this.load(db, ctx, id);
    });
  }

  completeStep(ctx: RequestContext, id: string, body: CompleteStepBody): Promise<CapaDetail> {
    return this.command(ctx, id, sql`select app.capa_complete_step(${id}::uuid, ${body.step}, ${body.note ?? null})`);
  }

  reopenStep(ctx: RequestContext, id: string, body: ReopenStepBody): Promise<CapaDetail> {
    return this.command(ctx, id, sql`select app.capa_reopen_step(${id}::uuid, ${body.step}, ${body.reason})`);
  }

  cancel(ctx: RequestContext, id: string, body: ReasonBody): Promise<CapaDetail> {
    return this.command(ctx, id, sql`select app.cancel_capa(${id}::uuid, ${body.reason})`);
  }

  reopen(ctx: RequestContext, id: string, body: ReasonBody): Promise<CapaDetail> {
    return this.command(ctx, id, sql`select app.reopen_capa(${id}::uuid, ${body.reason})`);
  }

  /** Closes the 8D (D8): needs capa.verify, everything done and verified effective. */
  close(ctx: RequestContext, id: string, body: CloseCapaBody): Promise<CapaDetail> {
    return this.command(ctx, id, sql`select app.close_capa(${id}::uuid, ${body.recognition ?? null})`);
  }

  // ---- evidence files (D8 and any step) ------------------------------------------------------

  listAttachments(ctx: RequestContext, id: string, q: z.infer<typeof DeletedQuery>): Promise<z.infer<typeof Attachment>[]> {
    return this.database.asUser(ctx, async (db) => {
      await this.load(db, ctx, id);
      const filter = q.deleted === 'exclude' ? sql`a.deleted_at is null` : q.deleted === 'only' ? sql`a.deleted_at is not null` : sql`true`;
      const rows = await db.execute<Row>(sql`${ATTACHMENT_SELECT} where a.capa_id = ${id}::uuid and ${filter} order by a.created_at desc`);
      return rows.rows.map(toAttachment);
    });
  }

  /** Records a file the client has already uploaded to storage at <org>/capa/<id>/<name>. */
  createAttachment(ctx: RequestContext, id: string, body: z.infer<typeof CreateAttachmentBody>): Promise<z.infer<typeof Attachment>> {
    return this.database.asUser(ctx, async (db) => {
      await this.load(db, ctx, id);
      const folder = `${orgOf(ctx)}/capa/${id}/`;
      if (!body.storagePath.startsWith(folder) || body.storagePath.includes('..') || body.storagePath.length === folder.length) {
        throw ApiError.badRequest('invalid_path', `Files for this 8D must be uploaded to ${folder}`);
      }
      const stored = await db.execute(sql`select 1 from storage.objects where bucket_id = 'capa-files' and name = ${body.storagePath}`);
      if (!stored.rows.length) throw ApiError.badRequest('file_not_uploaded', 'Upload the file before attaching it');
      const res = await db.execute<{ id: string }>(sql`select app.add_capa_attachment(${id}::uuid, ${body.storagePath}, ${body.fileName}, ${body.contentType ?? null}, ${body.sizeBytes}::bigint, ${body.description ?? null}) as id`);
      return this.loadAttachment(db, ctx, res.rows[0].id);
    });
  }

  removeAttachment(ctx: RequestContext, attachmentId: string, reason: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.loadAttachment(db, ctx, attachmentId);
      await db.execute(sql`select app.remove_capa_attachment(${attachmentId}::uuid, ${reason})`);
      return this.loadAttachment(db, ctx, attachmentId);
    });
  }

  restoreAttachment(ctx: RequestContext, attachmentId: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.loadAttachment(db, ctx, attachmentId);
      await db.execute(sql`select app.restore_capa_attachment(${attachmentId}::uuid)`);
      return this.loadAttachment(db, ctx, attachmentId);
    });
  }

  private async loadAttachment(db: Db, ctx: RequestContext, id: string) {
    const res = await db.execute<Row>(sql`${ATTACHMENT_SELECT} where a.id = ${id}::uuid and a.organisation_id = ${orgOf(ctx)}::uuid`);
    if (!res.rows.length) throw ApiError.notFound('attachment_not_found', 'File not found');
    return toAttachment(res.rows[0]);
  }

  // ---- team ----------------------------------------------------------------------------------

  addTeamMember(ctx: RequestContext, id: string, body: AddTeamBody): Promise<CapaDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.load(db, ctx, id);
      await db.execute(sql`
        insert into public.capa_team_members (organisation_id, capa_id, membership_id, external_name, external_company, external_email, role)
        values (${orgOf(ctx)}::uuid, ${id}::uuid, ${body.membershipId ?? null}::uuid, ${body.externalName ?? null}, ${body.externalCompany || null}, ${body.externalEmail || null}, ${body.role})`);
      return this.load(db, ctx, id);
    });
  }

  updateTeamMember(ctx: RequestContext, teamId: string, body: UpdateTeamBody): Promise<CapaDetail> {
    return this.database.asUser(ctx, async (db) => {
      const found = await db.execute<{ capa_id: string }>(sql`select capa_id from public.capa_team_members where id = ${teamId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (!found.rows.length) throw ApiError.notFound('team_member_not_found', 'Team member not found');
      const sets: SQL[] = [];
      if (body.role !== undefined) sets.push(sql`role = ${body.role}`);
      if (body.externalName !== undefined) sets.push(sql`external_name = ${body.externalName}`);
      if (body.externalCompany !== undefined) sets.push(sql`external_company = ${body.externalCompany || null}`);
      if (body.externalEmail !== undefined) sets.push(sql`external_email = ${body.externalEmail || null}`);
      if (body.ended) sets.push(sql`ended_at = now()`);
      const updated = await db.execute(sql`update public.capa_team_members set ${sql.join(sets, sql`, `)} where id = ${teamId}::uuid and organisation_id = ${orgOf(ctx)}::uuid returning id`);
      if (updated.rows.length === 0) throw ApiError.forbidden('You are not allowed to change this team');
      return this.load(db, ctx, found.rows[0].capa_id);
    });
  }

  // ---- analyses (D2 and D4 tools) ------------------------------------------------------------

  addAnalysis(ctx: RequestContext, id: string, body: CreateAnalysisBody): Promise<CapaDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.load(db, ctx, id);
      const data = parseData(body.kind, body.data);
      await db.execute(sql`
        insert into public.capa_analyses (organisation_id, capa_id, kind, title, step, data)
        values (${orgOf(ctx)}::uuid, ${id}::uuid, ${body.kind}, ${body.title}, ${STEP_OF_KIND[body.kind]}, ${JSON.stringify(data)}::jsonb)`);
      return this.load(db, ctx, id);
    });
  }

  updateAnalysis(ctx: RequestContext, analysisId: string, body: UpdateAnalysisBody): Promise<CapaDetail> {
    return this.database.asUser(ctx, async (db) => {
      const found = await db.execute<{ capa_id: string; kind: keyof typeof ANALYSIS_DATA }>(sql`select capa_id, kind from public.capa_analyses where id = ${analysisId}::uuid and organisation_id = ${orgOf(ctx)}::uuid and deleted_at is null`);
      if (!found.rows.length) throw ApiError.notFound('analysis_not_found', 'Analysis not found');
      const sets: SQL[] = [];
      if (body.title !== undefined) sets.push(sql`title = ${body.title}`);
      if (body.data !== undefined) sets.push(sql`data = ${JSON.stringify(parseData(found.rows[0].kind, body.data))}::jsonb`);
      const updated = await db.execute(sql`update public.capa_analyses set ${sql.join(sets, sql`, `)} where id = ${analysisId}::uuid and organisation_id = ${orgOf(ctx)}::uuid returning id`);
      if (updated.rows.length === 0) throw ApiError.forbidden('You are not allowed to change this analysis');
      return this.load(db, ctx, found.rows[0].capa_id);
    });
  }

  removeAnalysis(ctx: RequestContext, analysisId: string): Promise<CapaDetail> {
    return this.database.asUser(ctx, async (db) => {
      const found = await db.execute<{ capa_id: string }>(sql`select capa_id from public.capa_analyses where id = ${analysisId}::uuid and organisation_id = ${orgOf(ctx)}::uuid and deleted_at is null`);
      if (!found.rows.length) throw ApiError.notFound('analysis_not_found', 'Analysis not found');
      const updated = await db.execute(sql`update public.capa_analyses set deleted_at = now() where id = ${analysisId}::uuid and organisation_id = ${orgOf(ctx)}::uuid returning id`);
      if (updated.rows.length === 0) throw ApiError.forbidden('You are not allowed to remove this analysis');
      return this.load(db, ctx, found.rows[0].capa_id);
    });
  }

  // ---- root causes (D4) ----------------------------------------------------------------------

  addRootCause(ctx: RequestContext, id: string, body: CreateRootCauseBody): Promise<CapaDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.load(db, ctx, id);
      await db.execute(sql`
        insert into public.capa_root_causes (organisation_id, capa_id, kind, description, source_analysis_id)
        values (${orgOf(ctx)}::uuid, ${id}::uuid, ${body.kind}, ${body.description}, ${body.sourceAnalysisId ?? null}::uuid)`);
      return this.load(db, ctx, id);
    });
  }

  updateRootCause(ctx: RequestContext, causeId: string, body: UpdateRootCauseBody): Promise<CapaDetail> {
    const sets: SQL[] = [];
    if (body.kind !== undefined) sets.push(sql`kind = ${body.kind}`);
    if (body.description !== undefined) sets.push(sql`description = ${body.description}`);
    if (body.verificationMethod !== undefined) sets.push(sql`verification_method = ${body.verificationMethod || null}`);
    if (body.verificationNote !== undefined) sets.push(sql`verification_note = ${body.verificationNote || null}`);
    if (body.verified !== undefined) sets.push(sql`verified = ${body.verified}`);
    return this.changeRootCause(ctx, causeId, sets);
  }

  removeRootCause(ctx: RequestContext, causeId: string): Promise<CapaDetail> {
    return this.changeRootCause(ctx, causeId, [sql`deleted_at = now()`]);
  }

  private changeRootCause(ctx: RequestContext, causeId: string, sets: SQL[]): Promise<CapaDetail> {
    return this.database.asUser(ctx, async (db) => {
      const found = await db.execute<{ capa_id: string }>(sql`select capa_id from public.capa_root_causes where id = ${causeId}::uuid and organisation_id = ${orgOf(ctx)}::uuid and deleted_at is null`);
      if (!found.rows.length) throw ApiError.notFound('root_cause_not_found', 'Root cause not found');
      const updated = await db.execute(sql`update public.capa_root_causes set ${sql.join(sets, sql`, `)} where id = ${causeId}::uuid and organisation_id = ${orgOf(ctx)}::uuid returning id`);
      if (updated.rows.length === 0) throw ApiError.forbidden('You are not allowed to change this root cause');
      return this.load(db, ctx, found.rows[0].capa_id);
    });
  }

  // ---- verification (D6) ---------------------------------------------------------------------

  /** Records whether the corrective actions worked (capa.verify). A failed one reopens D5 and D6. */
  addVerification(ctx: RequestContext, id: string, body: CreateVerificationBody): Promise<CapaDetail> {
    return this.command(ctx, id, sql`select app.record_capa_verification(${id}::uuid, ${body.effective}, ${body.method}, ${body.notes ?? null})`);
  }

  // ---- actions (interim containment, corrective, preventive) ---------------------------------

  addAction(ctx: RequestContext, id: string, body: CreateActionBody): Promise<CapaDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.load(db, ctx, id);
      await db.execute(sql`
        insert into public.capa_actions (organisation_id, capa_id, phase, description, root_cause_id, owner_team_member_id, due_date)
        values (${orgOf(ctx)}::uuid, ${id}::uuid, ${body.phase}, ${body.description}, ${body.rootCauseId ?? null}::uuid, ${body.ownerTeamMemberId ?? null}::uuid, ${body.dueDate ?? null}::date)`);
      return this.load(db, ctx, id);
    });
  }

  /** The caller's own actions in running 8Ds (assigned to them as a team member), newest first, with whether the step they are worked in is complete. */
  myActions(ctx: RequestContext, q: z.infer<typeof MyActionsQuery>): Promise<z.infer<typeof MyActionList>> {
    return this.database.asUser(ctx, async (db) => {
      const filter = q.status === 'all' ? sql`true` : q.status === 'done' ? sql`x.status = 'done'` : sql`x.status = 'open'`;
      const rows = await db.execute<Row>(sql`
        select x.id, x.capa_id, c.reference, c.title, x.phase, x.description, x.due_date::text as due_date, x.status, x.evidence_note, x.done_at, x.created_at,
               (x.status = 'open' and x.due_date is not null and x.due_date < current_date) as overdue,
               exists (select 1 from public.capa_steps s where s.capa_id = x.capa_id and s.completed_at is not null and s.step = case x.phase when 'interim' then 'd3' when 'corrective' then 'd6' else 'd7' end) as locked
          from public.capa_actions x
          join public.capas c on c.id = x.capa_id
          join public.capa_team_members t on t.id = x.owner_team_member_id and t.ended_at is null
          join public.organisation_users m on m.id = t.membership_id
         where x.organisation_id = ${orgOf(ctx)}::uuid and m.user_id = auth.uid() and x.status <> 'cancelled'
           and c.stage not in ('closed', 'cancelled') and ${filter}
         order by (x.status = 'open') desc, x.due_date nulls last, x.created_at desc`);
      const open = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from public.capa_actions x
          join public.capas c on c.id = x.capa_id
          join public.capa_team_members t on t.id = x.owner_team_member_id and t.ended_at is null
          join public.organisation_users m on m.id = t.membership_id
         where x.organisation_id = ${orgOf(ctx)}::uuid and m.user_id = auth.uid() and x.status = 'open' and c.stage not in ('closed', 'cancelled')`);
      return {
        data: rows.rows.map((r) => ({
          id: r.id as string,
          capaId: r.capa_id as string,
          capaReference: r.reference as string,
          capaTitle: r.title as string,
          phase: r.phase as 'interim' | 'corrective' | 'preventive',
          description: r.description as string,
          dueDate: (r.due_date as string) ?? null,
          overdue: !!r.overdue,
          status: r.status as 'open' | 'done' | 'cancelled',
          evidenceNote: (r.evidence_note as string) ?? null,
          doneAt: iso(r.done_at),
          locked: !!r.locked,
          assignedAt: iso(r.created_at)!,
        })),
        openCount: open.rows[0]?.n ?? 0,
      };
    });
  }

  updateAction(ctx: RequestContext, actionId: string, body: UpdateActionBody): Promise<CapaDetail> {
    const sets: SQL[] = [];
    if (body.description !== undefined) sets.push(sql`description = ${body.description}`);
    if (body.rootCauseId !== undefined) sets.push(sql`root_cause_id = ${body.rootCauseId}::uuid`);
    if (body.ownerTeamMemberId !== undefined) sets.push(sql`owner_team_member_id = ${body.ownerTeamMemberId}::uuid`);
    if (body.dueDate !== undefined) sets.push(sql`due_date = ${body.dueDate}::date`);
    if (body.evidenceNote !== undefined) sets.push(sql`evidence_note = ${body.evidenceNote || null}`);
    return this.changeAction(ctx, actionId, sets);
  }

  completeAction(ctx: RequestContext, actionId: string, body: CompleteActionBody): Promise<CapaDetail> {
    return this.changeAction(ctx, actionId, [sql`status = 'done'`, sql`evidence_note = coalesce(${body.evidenceNote || null}, evidence_note)`]);
  }

  cancelAction(ctx: RequestContext, actionId: string, body: ReasonBody): Promise<CapaDetail> {
    return this.changeAction(ctx, actionId, [sql`status = 'cancelled'`, sql`cancel_reason = ${body.reason}`]);
  }

  reopenAction(ctx: RequestContext, actionId: string): Promise<CapaDetail> {
    return this.changeAction(ctx, actionId, [sql`status = 'open'`]);
  }

  private changeAction(ctx: RequestContext, actionId: string, sets: SQL[]): Promise<CapaDetail> {
    return this.database.asUser(ctx, async (db) => {
      const found = await db.execute<{ capa_id: string }>(sql`select capa_id from public.capa_actions where id = ${actionId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (!found.rows.length) throw ApiError.notFound('action_not_found', 'Action not found');
      const updated = await db.execute(sql`update public.capa_actions set ${sql.join(sets, sql`, `)} where id = ${actionId}::uuid and organisation_id = ${orgOf(ctx)}::uuid returning id`);
      if (updated.rows.length === 0) throw ApiError.forbidden('You are not allowed to change this action');
      return this.load(db, ctx, found.rows[0].capa_id);
    });
  }

  // ---- non-conformance links ---------------------------------------------------------------

  linkNcr(ctx: RequestContext, id: string, body: LinkNcrBody): Promise<CapaDetail> {
    return this.command(ctx, id, sql`select app.link_capa_ncr(${id}::uuid, ${body.ncrId}::uuid)`);
  }

  unlinkNcr(ctx: RequestContext, linkId: string, body: ReasonBody): Promise<CapaDetail> {
    return this.database.asUser(ctx, async (db) => {
      const found = await db.execute<{ capa_id: string }>(sql`select capa_id from public.capa_ncr_links where id = ${linkId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (!found.rows.length) throw ApiError.notFound('link_not_found', 'Link not found');
      await db.execute(sql`select app.unlink_capa_ncr(${linkId}::uuid, ${body.reason})`);
      return this.load(db, ctx, found.rows[0].capa_id);
    });
  }

  /** The running and finished 8Ds a non-conformance is linked to (those the caller may read). */
  forNcr(ctx: RequestContext, ncrId: string): Promise<z.infer<typeof NcrCapaList>> {
    return this.database.asUser(ctx, async (db) => {
      const known = await db.execute(sql`select 1 from public.nonconformances where id = ${ncrId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (!known.rows.length) throw ApiError.notFound('ncr_not_found', 'Non-conformance not found');
      const res = await db.execute<Row>(sql`
        select l.id as link_id, l.created_at as linked_at, c.id, c.reference, c.title, c.stage,
               (select count(*) from public.capa_steps s where s.capa_id = c.id and s.completed_at is not null)::int as steps_done,
               (select min(s.step) from public.capa_steps s where s.capa_id = c.id and s.completed_at is null) as next_step
        from public.capa_ncr_links l join public.capas c on c.id = l.capa_id
        where l.organisation_id = ${orgOf(ctx)}::uuid and l.nonconformance_id = ${ncrId}::uuid and l.ended_at is null
        order by c.created_at desc`);
      return {
        data: res.rows.map((r) => ({
          linkId: r.link_id as string,
          capaId: r.id as string,
          reference: r.reference as string,
          title: r.title as string,
          stage: r.stage as CapaSummary['stage'],
          currentStep: ((r.next_step as string) ?? 'd8') as CapaSummary['currentStep'],
          stepsDone: Number(r.steps_done),
          linkedAt: iso(r.linked_at)!,
        })),
      };
    });
  }

  /** Active members for the team and owner pickers (the members list itself needs members.read). */
  people(ctx: RequestContext, q: PeopleQuery): Promise<z.infer<typeof PeopleList>> {
    return this.database.asUser(ctx, async (db) => {
      const like = q.q ? `%${q.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
      const res = await db.execute<Row>(sql`
        select m.id as membership_id, m.user_id, coalesce(${sql.raw(personName('p'))}, m.invited_email, 'Unknown') as name
        from public.organisation_users m
        left join public.profiles p on p.id = m.user_id
        where m.organisation_id = ${orgOf(ctx)}::uuid and m.status = 'active' and m.user_id is not null
          and (${like}::text is null or ${sql.raw(personName('p'))} ilike ${like} or m.invited_email ilike ${like})
        order by name limit 100`);
      return { data: res.rows.map((r) => ({ membershipId: r.membership_id as string, userId: r.user_id as string, name: r.name as string })) };
    });
  }

  // ---- helpers ------------------------------------------------------------------------------

  /** Runs a database command on an 8D the caller can see, then answers with the 8D. */
  private command(ctx: RequestContext, id: string, statement: SQL): Promise<CapaDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.load(db, ctx, id);
      await db.execute(statement);
      return this.load(db, ctx, id);
    });
  }

  private async load(db: Db, ctx: RequestContext, id: string): Promise<CapaDetail> {
    const rows = await db.execute<Row>(sql`${SELECT} where c.id = ${id}::uuid and c.organisation_id = ${orgOf(ctx)}::uuid`);
    if (!rows.rows.length) throw ApiError.notFound('capa_not_found', '8D not found');
    const r = rows.rows[0];
    const [steps, team, ncrs, analyses, actions, causes, verifications, vstate] = await Promise.all([
      db.execute<Row>(sql`select s.step, s.completed_at, s.completed_by, s.note, s.reopened_at, s.reopen_reason, ${sql.raw(personName('p'))} as completed_by_name
        from public.capa_steps s left join public.profiles p on p.id = s.completed_by where s.capa_id = ${id}::uuid order by s.step`),
      db.execute<Row>(sql`select t.id, t.membership_id, m.user_id, t.external_name, t.external_company, t.external_email, t.role, t.ended_at,
          coalesce(${sql.raw(personName('p'))}, t.external_name, m.invited_email, 'Unknown') as name
        from public.capa_team_members t
        left join public.organisation_users m on m.id = t.membership_id
        left join public.profiles p on p.id = m.user_id
        where t.capa_id = ${id}::uuid
        order by t.ended_at is not null, case t.role when 'leader' then 0 when 'champion' then 1 else 2 end, t.created_at`),
      // Labels come from joins that run as the caller, so an NC they cannot read has no label.
      db.execute<Row>(sql`select l.id, l.nonconformance_id, l.created_at, l.created_by, l.ended_at, l.end_reason,
          n.reference, n.title, n.stage, n.source, n.severity, ${sql.raw(personName('pl'))} as linked_by_name
        from public.capa_ncr_links l
        left join public.nonconformances n on n.id = l.nonconformance_id
        left join public.profiles pl on pl.id = l.created_by
        where l.capa_id = ${id}::uuid order by l.ended_at is not null, l.created_at`),
      db.execute<Row>(sql`select a.id, a.kind, a.title, a.step, a.data, a.created_at, a.updated_at, a.created_by, ${sql.raw(personName('p'))} as created_by_name
        from public.capa_analyses a left join public.profiles p on p.id = a.created_by
        where a.capa_id = ${id}::uuid and a.deleted_at is null order by a.created_at`),
      db.execute<Row>(sql`select x.id, x.phase, x.description, x.root_cause_id, x.owner_team_member_id, x.due_date::text as due_date, x.status, x.done_at, x.done_by,
          x.evidence_note, x.cancel_reason, x.created_at, ${sql.raw(personName('pd'))} as done_by_name,
          coalesce(${sql.raw(personName('po'))}, t.external_name, om.invited_email) as owner_name,
          (x.status = 'open' and x.due_date is not null and x.due_date < current_date) as overdue,
          app.is_capa_action_assignee(x.id) as is_assignee
        from public.capa_actions x
        left join public.capa_team_members t on t.id = x.owner_team_member_id
        left join public.organisation_users om on om.id = t.membership_id
        left join public.profiles po on po.id = om.user_id
        left join public.profiles pd on pd.id = x.done_by
        where x.capa_id = ${id}::uuid order by x.created_at`),
      db.execute<Row>(sql`select r.id, r.kind, r.description, r.source_analysis_id, r.verified, r.verified_at, r.verified_by, r.verification_method, r.verification_note, r.created_at,
          ${sql.raw(personName('pv'))} as verified_by_name
        from public.capa_root_causes r left join public.profiles pv on pv.id = r.verified_by
        where r.capa_id = ${id}::uuid and r.deleted_at is null order by case r.kind when 'occurrence' then 0 when 'escape' then 1 else 2 end, r.created_at`),
      db.execute<Row>(sql`select v.id, v.effective, v.method, v.notes, v.verified_by, v.created_at, ${sql.raw(personName('pv'))} as verified_by_name
        from public.capa_verifications v left join public.profiles pv on pv.id = v.verified_by
        where v.capa_id = ${id}::uuid order by v.seq desc`),
      db.execute<{ s: string }>(sql`select app.capa_verification_status(${id}::uuid) as s`),
    ]);
    const incomplete = steps.rows.filter((s) => !s.completed_at).map((s) => s.step as string);
    const problems = new Map<string, string[]>();
    await Promise.all(
      incomplete.map(async (step) => {
        const res = await db.execute<{ p: string[] }>(sql`select app.capa_step_problems(${id}::uuid, ${step}) as p`);
        problems.set(step, res.rows[0].p ?? []);
      }),
    );
    return {
      customValues: await customValuesOf(db, 'capa', id),
      ...toSummary(r),
      problemStatement: (r.problem_statement as string) ?? null,
      problem: { who: (r.d2_who as string) ?? null, what: (r.d2_what as string) ?? null, where: (r.d2_where as string) ?? null, when: (r.d2_when as string) ?? null, why: (r.d2_why as string) ?? null, how: (r.d2_how as string) ?? null, howMany: (r.d2_how_many as string) ?? null },
      d3NoContainmentReason: (r.d3_no_containment_reason as string) ?? null,
      analyses: analyses.rows.map((a) => ({
        id: a.id as string,
        kind: a.kind as CapaDetail['analyses'][number]['kind'],
        title: a.title as string,
        step: a.step as CapaDetail['analyses'][number]['step'],
        data: a.data as Record<string, unknown>,
        createdBy: person(a.created_by, a.created_by_name),
        createdAt: iso(a.created_at)!,
        updatedAt: iso(a.updated_at)!,
      })),
      rootCauses: causes.rows.map((x) => ({
        id: x.id as string,
        kind: x.kind as CapaDetail['rootCauses'][number]['kind'],
        description: x.description as string,
        sourceAnalysisId: (x.source_analysis_id as string) ?? null,
        verified: !!x.verified,
        verifiedAt: iso(x.verified_at),
        verifiedBy: person(x.verified_by, x.verified_by_name),
        verificationMethod: (x.verification_method as string) ?? null,
        verificationNote: (x.verification_note as string) ?? null,
        createdAt: iso(x.created_at)!,
      })),
      verifications: verifications.rows.map((v) => ({
        id: v.id as string,
        effective: !!v.effective,
        method: v.method as string,
        notes: (v.notes as string) ?? null,
        verifiedBy: person(v.verified_by, v.verified_by_name),
        verifiedAt: iso(v.created_at)!,
      })),
      verificationState: vstate.rows[0].s as CapaDetail['verificationState'],
      d7LessonsLearned: (r.d7_lessons_learned as string) ?? null,
      d8Recognition: (r.d8_recognition as string) ?? null,
      closedBy: person(r.closed_by, r.closed_by_name),
      d7NoPreventiveReason: (r.d7_no_preventive_reason as string) ?? null,
      actions: actions.rows.map((x) => ({
        id: x.id as string,
        phase: x.phase as CapaDetail['actions'][number]['phase'],
        description: x.description as string,
        rootCauseId: (x.root_cause_id as string) ?? null,
        owner: x.owner_team_member_id ? { teamMemberId: x.owner_team_member_id as string, name: (x.owner_name as string) ?? 'Unknown' } : null,
        dueDate: (x.due_date as string) ?? null,
        overdue: !!x.overdue,
        status: x.status as 'open' | 'done' | 'cancelled',
        doneAt: iso(x.done_at),
        doneBy: person(x.done_by, x.done_by_name),
        evidenceNote: (x.evidence_note as string) ?? null,
        cancelReason: (x.cancel_reason as string) ?? null,
        isAssignee: !!x.is_assignee,
        createdAt: iso(x.created_at)!,
      })),
      createdBy: person(r.created_by, r.created_by_name),
      updatedAt: iso(r.updated_at)!,
      steps: STEPS.map((step) => {
        const s = steps.rows.find((x) => x.step === step)!;
        return {
          step,
          completed: !!s.completed_at,
          completedAt: iso(s.completed_at),
          completedBy: person(s.completed_by, s.completed_by_name),
          note: (s.note as string) ?? null,
          reopenedAt: iso(s.reopened_at),
          reopenReason: (s.reopen_reason as string) ?? null,
          problems: problems.get(step) ?? [],
        };
      }),
      team: team.rows.map((t) => ({
        id: t.id as string,
        membershipId: (t.membership_id as string) ?? null,
        userId: (t.user_id as string) ?? null,
        name: t.name as string,
        company: (t.external_company as string) ?? null,
        email: (t.external_email as string) ?? null,
        role: t.role as CapaDetail['team'][number]['role'],
        external: !t.membership_id,
        endedAt: iso(t.ended_at),
      })),
      ncrs: ncrs.rows.map((n) => ({
        id: n.id as string,
        nonconformanceId: n.nonconformance_id as string,
        reference: (n.reference as string) ?? null,
        title: (n.title as string) ?? null,
        stage: (n.stage as string) ?? null,
        source: (n.source as string) ?? null,
        severity: (n.severity as string) ?? null,
        linkedAt: iso(n.created_at)!,
        linkedBy: person(n.created_by, n.linked_by_name),
        endedAt: iso(n.ended_at),
        endReason: (n.end_reason as string) ?? null,
      })),
    };
  }
}
