import { Injectable } from '@nestjs/common';
import { sql, SQL } from 'drizzle-orm';
import { iso, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import {
  CreateDocumentBody, CreateTypeBody, DocumentFileBody, DocumentListQuery, TypeListQuery, UpdateDocumentBody, UpdateRevisionBody, UpdateTypeBody,
} from './documents.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
const person = (id: unknown, name: unknown) => (id ? { id: id as string, name: (name as string) ?? 'Unknown' } : null);
const json = (v: unknown) => JSON.stringify(v);

const toType = (r: Row) => ({
  id: r.id as string,
  name: r.name as string,
  prefix: r.prefix as string,
  description: (r.description as string) ?? null,
  reviewMonths: Number(r.review_months),
  contentHint: r.content_hint as 'file' | 'text',
  sequence: Number(r.sequence),
  active: r.active as boolean,
  documents: Number(r.document_count ?? 0),
});

/** Every document the caller may read (RLS), with its type, owner and the revision in progress, if any. */
const DOCUMENT_SELECT = sql`
  select d.*, t.name as type_name, t.prefix as type_prefix,
         ${sql.raw(personName('po'))} as owner_name,
         ip.id as ip_id, ip.status as ip_status, ip.sequence as ip_sequence,
         (select count(*)::int from public.document_revisions x where x.document_id = d.id and x.status <> 'discarded') as revision_count
    from public.documents d
    join public.document_types t on t.id = d.type_id
    left join public.profiles po on po.id = d.owner_user_id
    left join public.document_revisions ip on ip.document_id = d.id and ip.status in ('draft', 'in_review', 'awaiting_approval', 'approved')`;

const SORT: Record<DocumentListQuery['sort'], string> = {
  number: 'upper(d.number)',
  title: 'lower(d.title)',
  type: 'lower(d.type_name)',
  status: 'd.status',
  owner: 'lower(d.owner_name)',
  updatedAt: 'd.updated_at',
};

const toDocument = (r: Row) => ({
  id: r.id as string,
  number: r.number as string,
  title: r.title as string,
  type: { id: r.type_id as string, name: r.type_name as string, prefix: r.type_prefix as string },
  contentKind: r.content_kind as 'file' | 'text',
  description: (r.description as string) ?? null,
  owner: person(r.owner_user_id, r.owner_name),
  status: r.status as string,
  startLetter: r.start_letter as string,
  lastLetter: (r.last_letter as string) ?? null,
  numberTyped: r.number_typed as boolean,
  /** The revision being written or reviewed (null when none, or when the caller may not see it). */
  inProgress: r.ip_id ? { id: r.ip_id as string, status: r.ip_status as string, sequence: Number(r.ip_sequence) } : null,
  revisionCount: Number(r.revision_count ?? 0),
  createdAt: iso(r.created_at) as string,
  updatedAt: iso(r.updated_at) as string,
});

const toFile = (f: Row) => ({
  id: f.id as string,
  role: f.role as 'main' | 'attachment',
  storagePath: f.storage_path as string,
  fileName: f.file_name as string,
  contentType: (f.content_type as string) ?? null,
  sizeBytes: Number(f.size_bytes),
  createdBy: f.created_by_name ? { name: f.created_by_name as string } : null,
  deletedAt: f.deleted_at ? (iso(f.deleted_at) as string) : null,
  deleteReason: (f.delete_reason as string) ?? null,
  createdAt: iso(f.created_at) as string,
});

/** Document control (DC1): types, documents and their draft revisions. Every write is a database function; reading is by RLS. */
@Injectable()
export class DocumentsService {
  constructor(private readonly database: DatabaseService) {}

  // ---- types ---------------------------------------------------------------------------------------

  private async type(db: Db, ctx: RequestContext, id: string) {
    const rows = (
      await db.execute<Row>(sql`
        select t.*, (select count(*)::int from public.documents d where d.type_id = t.id) as document_count
          from public.document_types t where t.id = ${id}::uuid and t.organisation_id = ${orgOf(ctx)}::uuid`)
    ).rows;
    if (rows.length === 0) throw ApiError.notFound('document_type_not_found', 'Document type not found');
    return toType(rows[0]);
  }

  types(ctx: RequestContext, q: TypeListQuery) {
    return this.database.asUser(ctx, async (db) => {
      const rows = (
        await db.execute<Row>(sql`
          select t.*, (select count(*)::int from public.documents d where d.type_id = t.id) as document_count
            from public.document_types t
           where t.organisation_id = ${orgOf(ctx)}::uuid and (${q.all === 'true'} or t.active)
           order by t.active desc, t.sequence, lower(t.name)`)
      ).rows;
      return { data: rows.map(toType) };
    });
  }

  createType(ctx: RequestContext, body: CreateTypeBody) {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ id: string }>(sql`select app.save_document_type(${orgOf(ctx)}::uuid, ${json(body)}::jsonb) as id`);
      return this.type(db, ctx, res.rows[0].id);
    });
  }

  updateType(ctx: RequestContext, id: string, body: UpdateTypeBody) {
    return this.database.asUser(ctx, async (db) => {
      await this.type(db, ctx, id);
      await db.execute(sql`select app.save_document_type(${orgOf(ctx)}::uuid, ${json(body)}::jsonb, ${id}::uuid)`);
      return this.type(db, ctx, id);
    });
  }

  // ---- documents -----------------------------------------------------------------------------------

  list(ctx: RequestContext, q: DocumentListQuery) {
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`d.organisation_id = ${orgOf(ctx)}::uuid`];
      if (q.type) where.push(sql`d.type_id = any(string_to_array(${q.type}, ',')::uuid[])`);
      // Discarded documents only when asked for.
      where.push(q.status ? sql`d.status = any(string_to_array(${q.status}, ','))` : sql`d.status <> 'discarded'`);
      if (q.kind) where.push(sql`d.content_kind = ${q.kind}`);
      if (q.owner === 'me') where.push(sql`d.owner_user_id = auth.uid()`);
      if (q.q) {
        const p = likePattern(q.q);
        where.push(sql`(d.number ilike ${p} escape '\\' or d.title ilike ${p} escape '\\' or d.description ilike ${p} escape '\\'
          or exists (select 1 from public.document_revisions r where r.document_id = d.id and r.status <> 'discarded' and r.body_text ilike ${p} escape '\\')
          or exists (select 1 from public.document_revision_files f join public.document_revisions r on r.id = f.revision_id
                      where r.document_id = d.id and f.deleted_at is null and f.file_name ilike ${p} escape '\\'))`);
      }
      const cond = sql.join(where, sql` and `);
      const total = Number((await db.execute<Row>(sql`select count(*)::int as n from (${DOCUMENT_SELECT}) d where ${cond}`)).rows[0].n);
      const rows = (
        await db.execute<Row>(sql`
          select * from (${DOCUMENT_SELECT}) d where ${cond}
           order by ${sql.raw(SORT[q.sort])} ${sql.raw(q.order === 'desc' ? 'desc nulls last' : 'asc nulls last')}, upper(d.number)
           limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`)
      ).rows;
      return { data: rows.map(toDocument), page: q.page, pageSize: q.pageSize, total };
    });
  }

  private async document(db: Db, ctx: RequestContext, id: string) {
    const org = orgOf(ctx);
    const found = (await db.execute<Row>(sql`select * from (${DOCUMENT_SELECT}) d where d.id = ${id}::uuid and d.organisation_id = ${org}::uuid`)).rows;
    if (found.length === 0) throw ApiError.notFound('document_not_found', 'Document not found');
    const revisions = (
      await db.execute<Row>(sql`
        select r.id, r.sequence, r.letter, r.status, r.change_summary, r.discard_reason, r.discarded_at, r.created_at, r.updated_at,
               r.author_id, ${sql.raw(personName('pa'))} as author_name
          from public.document_revisions r left join public.profiles pa on pa.id = r.author_id
         where r.document_id = ${id}::uuid and r.organisation_id = ${org}::uuid
         order by r.sequence desc`)
    ).rows;
    const can = (
      await db.execute<Row>(sql`select app.has_permission(${org}::uuid, 'documentation.manage') as manage, app.document_letter_after(${found[0].last_letter ?? null}::text) as after`)
    ).rows[0];
    const doc = toDocument(found[0]);
    return {
      ...doc,
      /** The letter the next submitted revision will get. */
      nextLetter: doc.lastLetter ? (can.after as string) : doc.startLetter,
      revisions: revisions.map((r) => ({
        id: r.id as string,
        sequence: Number(r.sequence),
        letter: (r.letter as string) ?? null,
        status: r.status as string,
        author: person(r.author_id, r.author_name),
        changeSummary: (r.change_summary as string) ?? null,
        discardReason: (r.discard_reason as string) ?? null,
        discardedAt: r.discarded_at ? (iso(r.discarded_at) as string) : null,
        createdAt: iso(r.created_at) as string,
        updatedAt: iso(r.updated_at) as string,
      })),
      canManage: Boolean(can.manage) && doc.status !== 'discarded',
    };
  }

  get(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, (db) => this.document(db, ctx, id));
  }

  create(ctx: RequestContext, body: CreateDocumentBody) {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ id: string }>(sql`select app.create_document(${orgOf(ctx)}::uuid, ${json(body)}::jsonb) as id`);
      return this.document(db, ctx, res.rows[0].id);
    });
  }

  update(ctx: RequestContext, id: string, body: UpdateDocumentBody) {
    return this.database.asUser(ctx, async (db) => {
      await this.document(db, ctx, id);
      await db.execute(sql`select app.update_document(${id}::uuid, ${json(body)}::jsonb)`);
      return this.document(db, ctx, id);
    });
  }

  // ---- revisions -----------------------------------------------------------------------------------

  private async revision(db: Db, ctx: RequestContext, id: string) {
    const org = orgOf(ctx);
    const rows = (
      await db.execute<Row>(sql`
        select r.*, ${sql.raw(personName('pa'))} as author_name, ${sql.raw(personName('pd'))} as discarded_by_name
          from public.document_revisions r
          left join public.profiles pa on pa.id = r.author_id
          left join public.profiles pd on pd.id = r.discarded_by
         where r.id = ${id}::uuid and r.organisation_id = ${org}::uuid`)
    ).rows;
    if (rows.length === 0) throw ApiError.notFound('document_revision_not_found', 'Revision not found');
    const r = rows[0];
    const document = await this.document(db, ctx, r.document_id as string);
    const files = (
      await db.execute<Row>(sql`
        select f.*, ${sql.raw(personName('pc'))} as created_by_name
          from public.document_revision_files f left join public.profiles pc on pc.id = f.created_by
         where f.revision_id = ${id}::uuid and f.organisation_id = ${org}::uuid
         order by (f.role = 'main') desc, f.created_at`)
    ).rows.map(toFile);
    const status = r.status as string;
    const { revisions: _revisions, ...header } = document;
    void _revisions;
    return {
      id: r.id as string,
      document: header,
      sequence: Number(r.sequence),
      letter: (r.letter as string) ?? null,
      /** The letter it will get when submitted (drafts only). */
      plannedLetter: status === 'draft' ? document.nextLetter : null,
      status,
      author: person(r.author_id, r.author_name),
      changeSummary: (r.change_summary as string) ?? null,
      body: (r.body as Record<string, unknown>) ?? null,
      files,
      discardReason: (r.discard_reason as string) ?? null,
      discardedAt: r.discarded_at ? (iso(r.discarded_at) as string) : null,
      discardedBy: (r.discarded_by_name as string) ?? null,
      canEdit: status === 'draft' && document.canManage,
      createdAt: iso(r.created_at) as string,
      updatedAt: iso(r.updated_at) as string,
    };
  }

  getRevision(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, (db) => this.revision(db, ctx, id));
  }

  private async onRevision(ctx: RequestContext, id: string, run: (db: Db) => Promise<unknown>) {
    return this.database.asUser(ctx, async (db) => {
      await this.revision(db, ctx, id);
      await run(db);
      return this.revision(db, ctx, id);
    });
  }

  updateRevision(ctx: RequestContext, id: string, body: UpdateRevisionBody) {
    return this.onRevision(ctx, id, (db) => db.execute(sql`select app.update_document_revision(${id}::uuid, ${json(body)}::jsonb)`));
  }

  discardRevision(ctx: RequestContext, id: string, reason: string) {
    return this.onRevision(ctx, id, (db) => db.execute(sql`select app.discard_document_revision(${id}::uuid, ${reason})`));
  }

  files(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, async (db) => ({ data: (await this.revision(db, ctx, id)).files }));
  }

  addFile(ctx: RequestContext, id: string, body: DocumentFileBody) {
    return this.onRevision(ctx, id, (db) =>
      db.execute(sql`
        select app.add_document_file(${id}::uuid, ${body.role}, ${body.storagePath}, ${body.fileName}, ${body.contentType ?? null}, ${body.sizeBytes}::bigint)`),
    );
  }

  private async onFile(ctx: RequestContext, fileId: string, run: (db: Db) => Promise<unknown>) {
    return this.database.asUser(ctx, async (db) => {
      const row = (await db.execute<Row>(sql`select revision_id from public.document_revision_files where id = ${fileId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`)).rows;
      if (row.length === 0) throw ApiError.notFound('document_file_not_found', 'File not found');
      await run(db);
      return this.revision(db, ctx, row[0].revision_id as string);
    });
  }

  removeFile(ctx: RequestContext, fileId: string, reason: string) {
    return this.onFile(ctx, fileId, (db) => db.execute(sql`select app.remove_document_file(${fileId}::uuid, ${reason})`));
  }

  restoreFile(ctx: RequestContext, fileId: string) {
    return this.onFile(ctx, fileId, (db) => db.execute(sql`select app.restore_document_file(${fileId}::uuid)`));
  }
}
