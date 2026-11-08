import { Injectable } from '@nestjs/common';
import { SQL, sql } from 'drizzle-orm';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { iso, personName, ref, Row } from '../calibration/calibration.service';
import { DatabaseService, Db } from '../database/database.service';
import {
  AUDIT_FILES_BUCKET,
  Classification,
  CreateClassificationBody,
  CreateFindingAttachmentBody,
  CreateFindingBody,
  CreateNcrBody,
  Finding,
  FindingAttachment,
  FindingAttachmentListQuery,
  FindingListQuery,
  NcrAuditSource,
  UpdateClassificationBody,
  UpdateFindingBody,
} from './audit-findings.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

const SELECT = `
  select f.id, f.reference, f.status, f.title, f.description, f.requirement, to_char(f.due_on, 'YYYY-MM-DD') as due_on,
         (f.status = 'open' and f.due_on is not null and f.due_on < current_date) as overdue,
         f.owner_employee_id, ${personName('e')} as owner_name,
         c.id as class_id, c.key as class_key, c.label as class_label, c.kind as class_kind,
         r.id as record_id, r.reference as record_reference, r.status as record_status, to_char(r.performed_on, 'YYYY-MM-DD') as performed_on,
         r.audit_definition_id, r.audit_reference, r.audit_title,
         f.response_id, q.sequence as question_sequence, q.question as question_text,
         (select json_build_object('id', n.id, 'reference', n.reference, 'stage', n.stage)
            from public.audit_ncr_links l join public.nonconformances n on n.id = l.nonconformance_id
           where l.finding_id = f.id and n.deleted_at is null and n.stage <> 'cancelled' order by l.created_at desc limit 1) as ncr,
         (select count(*) from public.audit_finding_attachments a where a.finding_id = f.id and a.deleted_at is null) as file_count,
         f.closed_note, f.closed_at, f.closed_by, ${personName('cb')} as closed_name, f.reopen_reason, f.withdraw_reason, f.withdrawn_at,
         f.created_at, f.created_by, ${personName('cp')} as created_name
    from public.audit_findings f
    join public.audit_records r on r.id = f.audit_record_id
    join public.audit_finding_classifications c on c.id = f.classification_id
    left join public."Employees" e on e.id = f.owner_employee_id
    left join public.audit_responses s on s.id = f.response_id
    left join public.audit_record_questions q on q.id = s.record_question_id
    left join public.profiles cb on cb.id = f.closed_by
    left join public.profiles cp on cp.id = f.created_by`;

const SORT_SQL: Record<FindingListQuery['sort'], string[]> = {
  reference: ['f.reference'],
  title: ['lower(f.title)'],
  classification: ['c.sequence', 'c.label'],
  status: ['f.status'],
  dueOn: ['f.due_on'],
  owner: ['lower(e.surname)', 'lower(e.first_name)'],
  record: ['r.reference'],
  createdAt: ['f.created_at'],
};

const toFinding = (r: Row): Finding => ({
  id: r.id as string,
  reference: r.reference as string,
  status: r.status as Finding['status'],
  title: r.title as string,
  description: r.description as string,
  requirement: (r.requirement as string) ?? null,
  classification: { id: r.class_id as string, key: r.class_key as string, label: r.class_label as string, kind: r.class_kind as Finding['classification']['kind'] },
  owner: ref(r.owner_employee_id, r.owner_name, 'Unnamed employee'),
  dueOn: (r.due_on as string) ?? null,
  overdue: Boolean(r.overdue),
  record: {
    id: r.record_id as string,
    reference: r.record_reference as string,
    status: r.record_status as Finding['record']['status'],
    performedOn: r.performed_on as string,
    audit: { id: r.audit_definition_id as string, reference: r.audit_reference as string, title: r.audit_title as string },
  },
  answer: r.response_id ? { id: r.response_id as string, sequence: Number(r.question_sequence), question: r.question_text as string } : null,
  ncr: (r.ncr as Finding['ncr']) ?? null,
  fileCount: Number(r.file_count),
  closedNote: (r.closed_note as string) ?? null,
  closedAt: iso(r.closed_at),
  closedBy: ref(r.closed_by, r.closed_name, 'Unnamed person'),
  reopenReason: (r.reopen_reason as string) ?? null,
  withdrawReason: (r.withdraw_reason as string) ?? null,
  withdrawnAt: iso(r.withdrawn_at),
  createdAt: iso(r.created_at)!,
  createdBy: ref(r.created_by, r.created_name, 'Unknown user'),
});

const ATTACHMENT_SELECT = sql.raw(`
  select a.*, ${personName('pc')} as created_by_name
    from public.audit_finding_attachments a left join public.profiles pc on pc.id = a.created_by`);

const toAttachment = (r: Row): FindingAttachment => ({
  id: r.id as string,
  findingId: r.finding_id as string,
  fileName: r.file_name as string,
  contentType: (r.content_type as string) ?? null,
  sizeBytes: Number(r.size_bytes),
  storagePath: r.storage_path as string,
  createdAt: iso(r.created_at)!,
  createdBy: ref(r.created_by, r.created_by_name, 'Unknown user'),
  deletedAt: iso(r.deleted_at),
  deleteReason: (r.delete_reason as string) ?? null,
});

const toClassification = (r: Row): Classification => ({
  id: r.id as string,
  key: r.key as string,
  label: r.label as string,
  kind: r.kind as Classification['kind'],
  defaultSeverity: (r.default_severity as Classification['defaultSeverity']) ?? null,
  sequence: Number(r.sequence),
  active: Boolean(r.active),
  findingCount: Number(r.finding_count),
});

const CLASSIFICATION_SELECT = `
  select c.*, (select count(*) from public.audit_findings f where f.classification_id = c.id and f.status <> 'withdrawn') as finding_count
    from public.audit_finding_classifications c`;

/**
 * Audit findings: what an audit found, classified, owned and evidenced. Created, edited, withdrawn, closed and reopened only by database functions; a finding classified as a
 * non-conformity can be raised as a draft internal non-conformance, once (asking again returns the same one). Classifications are the organisation's own list.
 */
@Injectable()
export class AuditFindingsService {
  constructor(private readonly database: DatabaseService) {}

  // ---- classifications -----------------------------------------------------------------------
  listClassifications(ctx: RequestContext, all: boolean): Promise<Classification[]> {
    return this.database.asUser(ctx, async (db) => {
      const rows = await db.execute<Row>(
        sql`${sql.raw(CLASSIFICATION_SELECT)} where c.organisation_id = ${orgOf(ctx)}::uuid ${all ? sql`` : sql`and c.active`} order by c.sequence, c.label`,
      );
      return rows.rows.map(toClassification);
    });
  }

  createClassification(ctx: RequestContext, body: CreateClassificationBody): Promise<Classification> {
    if (body.defaultSeverity && body.kind !== 'nonconformity') {
      throw ApiError.badRequest('invalid_severity', 'Only a non-conformity has a default severity');
    }
    return this.database.asUser(ctx, async (db) => {
      const next = await db.execute<{ n: number }>(sql`select coalesce(max(sequence), 0) + 1 as n from public.audit_finding_classifications where organisation_id = ${orgOf(ctx)}::uuid`);
      const r = await db.execute<{ id: string }>(
        sql`insert into public.audit_finding_classifications (organisation_id, key, label, kind, default_severity, sequence)
            values (${orgOf(ctx)}::uuid, ${body.key}, ${body.label}, ${body.kind}, ${body.defaultSeverity ?? null}, ${body.sequence ?? Number(next.rows[0].n)}) returning id`,
      );
      return this.loadClassification(db, ctx, r.rows[0].id);
    });
  }

  updateClassification(ctx: RequestContext, id: string, body: UpdateClassificationBody): Promise<Classification> {
    return this.database.asUser(ctx, async (db) => {
      const current = await this.loadClassification(db, ctx, id);
      if (body.defaultSeverity && current.kind !== 'nonconformity') {
        throw ApiError.badRequest('invalid_severity', 'Only a non-conformity has a default severity');
      }
      const set: SQL[] = [];
      if (body.label !== undefined) set.push(sql`label = ${body.label}`);
      if (body.defaultSeverity !== undefined) set.push(sql`default_severity = ${body.defaultSeverity}`);
      if (body.sequence !== undefined) set.push(sql`sequence = ${body.sequence}`);
      if (body.active !== undefined) set.push(sql`active = ${body.active}`);
      await db.execute(sql`update public.audit_finding_classifications set ${sql.join(set, sql`, `)} where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      return this.loadClassification(db, ctx, id);
    });
  }

  private async loadClassification(db: Db, ctx: RequestContext, id: string): Promise<Classification> {
    const r = await db.execute<Row>(sql`${sql.raw(CLASSIFICATION_SELECT)} where c.id = ${id}::uuid and c.organisation_id = ${orgOf(ctx)}::uuid`);
    if (!r.rows.length) throw ApiError.notFound('classification_not_found', 'Classification not found');
    return toClassification(r.rows[0]);
  }

  // ---- findings ------------------------------------------------------------------------------
  list(ctx: RequestContext, q: FindingListQuery): Promise<{ data: Finding[]; page: number; pageSize: number; total: number }> {
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`f.organisation_id = ${orgOf(ctx)}::uuid`];
      if (q.recordId) where.push(sql`f.audit_record_id = ${q.recordId}::uuid`);
      if (q.auditId) where.push(sql`r.audit_definition_id = ${q.auditId}::uuid`);
      if (q.classificationId) where.push(sql`f.classification_id = ${q.classificationId}::uuid`);
      if (q.kind.length) where.push(sql`c.kind = any (string_to_array(${q.kind.join(',')}, ','))`);
      if (q.status.length) where.push(sql`f.status = any (string_to_array(${q.status.join(',')}, ','))`);
      if (q.ownerId) where.push(sql`f.owner_employee_id = ${q.ownerId}::uuid`);
      if (q.overdue === 'true') where.push(sql`f.status = 'open' and f.due_on < current_date`);
      if (q.from) where.push(sql`r.performed_on >= ${q.from}::date`);
      if (q.to) where.push(sql`r.performed_on <= ${q.to}::date`);
      if (q.q) {
        const like = likePattern(q.q);
        where.push(sql`(f.reference ilike ${like} or f.title ilike ${like} or f.description ilike ${like} or r.reference ilike ${like} or r.audit_title ilike ${like})`);
      }
      const order = sql.raw(`${SORT_SQL[q.sort].map((x) => `${x} ${q.order} nulls last`).join(', ')}, f.reference desc`);
      const result = await db.execute<Row>(sql`${sql.raw(SELECT)} where ${sql.join(where, sql` and `)} order by ${order} limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`);
      const count = await db.execute<{ n: string }>(
        sql`select count(*) as n from public.audit_findings f join public.audit_records r on r.id = f.audit_record_id join public.audit_finding_classifications c on c.id = f.classification_id
            where ${sql.join(where, sql` and `)}`,
      );
      return { data: result.rows.map(toFinding), page: q.page, pageSize: q.pageSize, total: Number(count.rows[0].n) };
    });
  }

  listForRecord(ctx: RequestContext, recordId: string): Promise<Finding[]> {
    return this.database.asUser(ctx, async (db) => {
      const known = await db.execute(sql`select 1 from public.audit_records where id = ${recordId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (!known.rows.length) throw ApiError.notFound('audit_record_not_found', 'Audit record not found');
      const rows = await db.execute<Row>(sql`${sql.raw(SELECT)} where f.audit_record_id = ${recordId}::uuid and f.organisation_id = ${orgOf(ctx)}::uuid order by f.reference`);
      return rows.rows.map(toFinding);
    });
  }

  get(ctx: RequestContext, id: string): Promise<Finding> {
    return this.database.asUser(ctx, (db) => this.load(db, ctx, id));
  }

  create(ctx: RequestContext, recordId: string, body: CreateFindingBody): Promise<Finding> {
    return this.database.asUser(ctx, async (db) => {
      const r = await db.execute<{ id: string }>(
        sql`select app.create_audit_finding(${recordId}::uuid, ${body.responseId ?? null}::uuid, ${body.classificationId}::uuid, ${body.title}, ${body.description},
              ${body.requirement ?? null}::text, ${body.ownerId ?? null}::uuid, ${body.dueOn ?? null}::date) as id`,
      );
      return this.load(db, ctx, r.rows[0].id);
    });
  }

  update(ctx: RequestContext, id: string, body: UpdateFindingBody): Promise<Finding> {
    return this.database.asUser(ctx, async (db) => {
      await this.load(db, ctx, id);
      await db.execute(sql`select app.update_audit_finding(${id}::uuid, ${JSON.stringify(body)}::jsonb)`);
      return this.load(db, ctx, id);
    });
  }

  withdraw(ctx: RequestContext, id: string, reason: string): Promise<Finding> {
    return this.database.asUser(ctx, async (db) => {
      await this.load(db, ctx, id);
      await db.execute(sql`select app.withdraw_audit_finding(${id}::uuid, ${reason})`);
      return this.load(db, ctx, id);
    });
  }

  close(ctx: RequestContext, id: string, note: string): Promise<Finding> {
    return this.database.asUser(ctx, async (db) => {
      await this.load(db, ctx, id);
      await db.execute(sql`select app.close_audit_finding(${id}::uuid, ${note})`);
      return this.load(db, ctx, id);
    });
  }

  reopen(ctx: RequestContext, id: string, reason: string): Promise<Finding> {
    return this.database.asUser(ctx, async (db) => {
      await this.load(db, ctx, id);
      await db.execute(sql`select app.reopen_audit_finding(${id}::uuid, ${reason})`);
      return this.load(db, ctx, id);
    });
  }

  createNcr(ctx: RequestContext, id: string, body: CreateNcrBody): Promise<{ nonconformanceId: string; created: boolean; finding: Finding }> {
    return this.database.asUser(ctx, async (db) => {
      await this.load(db, ctx, id);
      const r = await db.execute<{ j: { nonconformanceId: string; created: boolean } }>(
        sql`select app.create_ncr_from_audit_finding(${id}::uuid, ${body.title ?? null}::text, ${body.description ?? null}::text, ${body.severity ?? null}::text) as j`,
      );
      return { ...r.rows[0].j, finding: await this.load(db, ctx, id) };
    });
  }

  // ---- evidence files ------------------------------------------------------------------------
  listAttachments(ctx: RequestContext, id: string, q: FindingAttachmentListQuery): Promise<FindingAttachment[]> {
    return this.database.asUser(ctx, async (db) => {
      await this.load(db, ctx, id);
      const filter = q.deleted === 'exclude' ? sql`a.deleted_at is null` : q.deleted === 'only' ? sql`a.deleted_at is not null` : sql`true`;
      const rows = await db.execute<Row>(sql`${ATTACHMENT_SELECT} where a.finding_id = ${id}::uuid and ${filter} order by a.created_at desc`);
      return rows.rows.map(toAttachment);
    });
  }

  /** Records a file the client has already uploaded to storage at <org>/audit/<record id>/findings/<finding id>/<name>. */
  createAttachment(ctx: RequestContext, id: string, body: CreateFindingAttachmentBody): Promise<FindingAttachment> {
    return this.database.asUser(ctx, async (db) => {
      const finding = await this.load(db, ctx, id);
      const folder = `${orgOf(ctx)}/audit/${finding.record.id}/findings/${id}/`;
      if (!body.storagePath.startsWith(folder) || body.storagePath.includes('..') || body.storagePath.length === folder.length) {
        throw ApiError.badRequest('invalid_path', `Files for this finding must be uploaded to ${folder}`);
      }
      const stored = await db.execute(sql`select 1 from storage.objects where bucket_id = ${AUDIT_FILES_BUCKET} and name = ${body.storagePath}`);
      if (!stored.rows.length) throw ApiError.badRequest('file_not_uploaded', 'Upload the file before attaching it');
      const res = await db.execute<{ id: string }>(
        sql`select app.add_audit_finding_attachment(${id}::uuid, ${body.storagePath}, ${body.fileName}, ${body.contentType ?? null}, ${body.sizeBytes}::bigint) as id`,
      );
      return this.loadAttachment(db, ctx, res.rows[0].id);
    });
  }

  removeAttachment(ctx: RequestContext, attachmentId: string, reason: string): Promise<FindingAttachment> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadAttachment(db, ctx, attachmentId);
      await db.execute(sql`select app.remove_audit_finding_attachment(${attachmentId}::uuid, ${reason})`);
      return this.loadAttachment(db, ctx, attachmentId);
    });
  }

  restoreAttachment(ctx: RequestContext, attachmentId: string): Promise<FindingAttachment> {
    return this.database.asUser(ctx, async (db) => {
      await this.loadAttachment(db, ctx, attachmentId);
      await db.execute(sql`select app.restore_audit_finding_attachment(${attachmentId}::uuid)`);
      return this.loadAttachment(db, ctx, attachmentId);
    });
  }

  // ---- the audit behind a non-conformance ----------------------------------------------------
  ncrSource(ctx: RequestContext, ncrId: string): Promise<NcrAuditSource> {
    return this.database.asUser(ctx, async (db) => {
      const ncr = await db.execute(sql`select 1 from public.nonconformances where id = ${ncrId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (!ncr.rows.length) throw ApiError.notFound('ncr_not_found', 'Non-conformance not found');
      const allowed = await db.execute<{ ok: boolean }>(sql`select app.has_permission(${orgOf(ctx)}::uuid, 'audits.read') as ok`);
      if (!allowed.rows[0].ok) return { available: false, items: [] };

      const links = await db.execute<Row>(sql`
        select l.audit_record_id, l.finding_id, l.response_id,
               r.reference as record_reference, r.status as record_status, to_char(r.performed_on, 'YYYY-MM-DD') as performed_on, r.audit_definition_id, r.audit_reference, r.audit_title,
               f.reference as finding_reference, f.title as finding_title, f.status as finding_status, c.label as class_label, c.kind as class_kind,
               q.sequence as question_sequence, q.question as question_text, s.result as answer_result, s.note as answer_note
          from public.audit_ncr_links l
          join public.audit_records r on r.id = l.audit_record_id
          left join public.audit_findings f on f.id = l.finding_id
          left join public.audit_finding_classifications c on c.id = f.classification_id
          left join public.audit_responses s on s.id = l.response_id
          left join public.audit_record_questions q on q.id = s.record_question_id
         where l.nonconformance_id = ${ncrId}::uuid and l.organisation_id = ${orgOf(ctx)}::uuid
         order by l.created_at, l.id`);

      const items = new Map<string, NcrAuditSource['items'][number]>();
      for (const l of links.rows) {
        // A finding is one item; answers raised straight from a record (before findings) are one item per record.
        const key = l.finding_id ? `f:${l.finding_id}` : `r:${l.audit_record_id}`;
        let item = items.get(key);
        if (!item) {
          item = {
            record: {
              id: l.audit_record_id as string,
              reference: l.record_reference as string,
              status: l.record_status as NcrAuditSource['items'][number]['record']['status'],
              performedOn: l.performed_on as string,
              audit: { id: l.audit_definition_id as string, reference: l.audit_reference as string, title: l.audit_title as string },
            },
            finding: l.finding_id
              ? {
                  id: l.finding_id as string,
                  reference: l.finding_reference as string,
                  title: l.finding_title as string,
                  status: l.finding_status as 'open' | 'closed' | 'withdrawn',
                  classification: { label: l.class_label as string, kind: l.class_kind as 'nonconformity' | 'observation' | 'opportunity' },
                }
              : null,
            answers: [],
            files: [],
          };
          items.set(key, item);
        }
        if (l.response_id) {
          item.answers.push({ sequence: Number(l.question_sequence), question: l.question_text as string, result: (l.answer_result as string) ?? null, note: (l.answer_note as string) ?? null });
        }
      }
      for (const item of items.values()) {
        if (!item.finding) continue;
        const files = await db.execute<Row>(
          sql`select id, file_name, content_type, size_bytes, storage_path from public.audit_finding_attachments where finding_id = ${item.finding.id}::uuid and deleted_at is null order by created_at`,
        );
        item.files = files.rows.map((f) => ({ id: f.id as string, fileName: f.file_name as string, contentType: (f.content_type as string) ?? null, sizeBytes: Number(f.size_bytes), storagePath: f.storage_path as string }));
      }
      return { available: true, items: [...items.values()] };
    });
  }

  // ---- internals -----------------------------------------------------------------------------
  private async load(db: Db, ctx: RequestContext, id: string): Promise<Finding> {
    const r = await db.execute<Row>(sql`${sql.raw(SELECT)} where f.id = ${id}::uuid and f.organisation_id = ${orgOf(ctx)}::uuid`);
    if (!r.rows.length) throw ApiError.notFound('audit_finding_not_found', 'Finding not found');
    return toFinding(r.rows[0]);
  }

  private async loadAttachment(db: Db, ctx: RequestContext, id: string): Promise<FindingAttachment> {
    const r = await db.execute<Row>(sql`${ATTACHMENT_SELECT} where a.id = ${id}::uuid and a.organisation_id = ${orgOf(ctx)}::uuid`);
    if (!r.rows.length) throw ApiError.notFound('audit_file_not_found', 'File not found');
    return toAttachment(r.rows[0]);
  }
}
