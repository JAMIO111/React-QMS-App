import { Injectable } from '@nestjs/common';
import { sql, SQL } from 'drizzle-orm';
import { iso, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { AddAttendeeBody, CreateSessionBody, RecordAttendeesBody, SessionAttachmentBody, SessionListQuery, UpdateSessionBody } from './competence.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
const day = (v: unknown) => (v ? String(v).slice(0, 10) : null);
const empName = (r: Row, prefix = '') => [r[`${prefix}first_name`], r[`${prefix}surname`]].filter(Boolean).join(' ') || 'Unnamed';

const SORT: Record<SessionListQuery['sort'], string> = { reference: 's.reference', title: 'lower(s.title)', startsOn: 's.starts_on', status: 's.status', attendees: 'attendee_count' };

const SESSION_SELECT = sql`
  select s.*, t.first_name as t_first_name, t.surname as t_surname,
         (select count(*)::int from public.competence_session_attendees a where a.session_id = s.id and a.status not in ('removed', 'voided')) as attendee_count,
         (select count(*)::int from public.competence_session_attendees a where a.session_id = s.id and a.status = 'enrolled') as enrolled_count,
         (select count(*)::int from public.competence_session_attendees a where a.session_id = s.id and a.status = 'completed') as completed_count,
         (select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'code', k.code, 'name', k.name) order by lower(k.name)), '[]'::jsonb)
            from public.competence_session_skills ss join public.competence_skills k on k.id = ss.skill_id where ss.session_id = s.id) as skills
    from public.competence_training_sessions s
    left join public."Employees" t on t.id = s.trainer_employee_id`;

const toSession = (r: Row) => ({
  id: r.id as string,
  reference: r.reference as string,
  title: r.title as string,
  kind: r.kind as string,
  providerType: r.provider_type as string,
  trainer: r.trainer_employee_id ? { id: r.trainer_employee_id as string, name: empName(r, 't_') } : null,
  providerName: (r.provider_name as string) ?? null,
  providerContact: (r.provider_contact as string) ?? null,
  startsOn: day(r.starts_on) as string,
  endsOn: day(r.ends_on),
  hours: r.hours === null || r.hours === undefined ? null : Number(r.hours),
  location: (r.location as string) ?? null,
  notes: (r.notes as string) ?? null,
  status: r.status as string,
  cancelReason: (r.cancel_reason as string) ?? null,
  reopenReason: (r.reopen_reason as string) ?? null,
  closedAt: r.closed_at ? (iso(r.closed_at) as string) : null,
  skills: r.skills as { id: string; code: string; name: string }[],
  attendeeCount: Number(r.attendee_count ?? 0),
  enrolledCount: Number(r.enrolled_count ?? 0),
  completedCount: Number(r.completed_count ?? 0),
  createdAt: iso(r.created_at) as string,
});

/** Training sessions with an attendee list; every command answers with the whole session. Reading is by RLS (competence.read, or being on the session). */
@Injectable()
export class CompetenceTrainingService {
  constructor(private readonly database: DatabaseService) {}

  list(ctx: RequestContext, q: SessionListQuery) {
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`s.organisation_id = ${orgOf(ctx)}::uuid`];
      const statuses = q.status === 'all' ? [] : q.status.split(',');
      if (statuses.length) where.push(sql`s.status = any(string_to_array(${statuses.join(',')}, ','))`);
      if (q.skillId) where.push(sql`exists (select 1 from public.competence_session_skills ss where ss.session_id = s.id and ss.skill_id = ${q.skillId}::uuid)`);
      if (q.employeeId) where.push(sql`exists (select 1 from public.competence_session_attendees a where a.session_id = s.id and a.employee_id = ${q.employeeId}::uuid and a.status not in ('removed', 'voided'))`);
      if (q.from) where.push(sql`s.starts_on >= ${q.from}::date`);
      if (q.to) where.push(sql`s.starts_on <= ${q.to}::date`);
      if (q.q) {
        const p = likePattern(q.q);
        where.push(sql`(s.reference ilike ${p} escape '\\' or s.title ilike ${p} escape '\\' or s.provider_name ilike ${p} escape '\\' or concat_ws(' ', s.t_first_name, s.t_surname) ilike ${p} escape '\\')`);
      }
      const cond = sql.join(where, sql` and `);
      const total = Number((await db.execute<Row>(sql`select count(*)::int as n from (${SESSION_SELECT}) s where ${cond}`)).rows[0].n);
      const rows = (
        await db.execute<Row>(sql`
          select * from (${SESSION_SELECT}) s where ${cond}
           order by ${sql.raw(SORT[q.sort])} ${sql.raw(q.order === 'asc' ? 'asc' : 'desc')}, s.reference desc
           limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`)
      ).rows;
      return { data: rows.map(toSession), page: q.page, pageSize: q.pageSize, total };
    });
  }

  private async detail(db: Db, ctx: RequestContext, id: string) {
    const org = orgOf(ctx);
    const found = (await db.execute<Row>(sql`select * from (${SESSION_SELECT}) s where s.id = ${id}::uuid and s.organisation_id = ${org}::uuid`)).rows;
    if (found.length === 0) throw ApiError.notFound('training_session_not_found', 'Training session not found');
    const attendees = (
      await db.execute<Row>(sql`
        select a.id, a.employee_id, a.status, a.completed_on::text as completed_on, a.note, a.reason, a.recorded_at, e.first_name, e.surname, e.employee_number,
               ${sql.raw(personName('pr'))} as recorded_by_name
          from public.competence_session_attendees a
          join public."Employees" e on e.id = a.employee_id
          left join public.profiles pr on pr.id = a.recorded_by
         where a.session_id = ${id}::uuid and a.organisation_id = ${org}::uuid
         order by (a.status in ('removed', 'voided')), lower(e.surname), lower(e.first_name), a.created_at`)
    ).rows;
    const files = (
      await db.execute<Row>(sql`
        select f.id, f.attendee_id, f.storage_path, f.file_name, f.content_type, f.size_bytes, f.description, f.deleted_at, f.delete_reason, f.created_at,
               ${sql.raw(personName('pr'))} as created_by_name
          from public.competence_attachments f left join public.profiles pr on pr.id = f.created_by
         where f.organisation_id = ${org}::uuid
           and (f.session_id = ${id}::uuid or f.attendee_id in (select a.id from public.competence_session_attendees a where a.session_id = ${id}::uuid))
         order by f.created_at`)
    ).rows;
    const toFile = (f: Row) => ({
      id: f.id as string,
      storagePath: f.storage_path as string,
      fileName: f.file_name as string,
      contentType: (f.content_type as string) ?? null,
      sizeBytes: Number(f.size_bytes),
      description: (f.description as string) ?? null,
      createdBy: f.created_by_name ? { name: f.created_by_name as string } : null,
      deletedAt: f.deleted_at ? (iso(f.deleted_at) as string) : null,
      deleteReason: (f.delete_reason as string) ?? null,
      createdAt: iso(f.created_at) as string,
    });
    return {
      ...toSession(found[0]),
      attendees: attendees.map((a) => ({
        id: a.id as string,
        employee: { id: a.employee_id as string, name: empName(a), employeeNumber: (a.employee_number as string) ?? null },
        status: a.status as string,
        completedOn: day(a.completed_on),
        note: (a.note as string) ?? null,
        reason: (a.reason as string) ?? null,
        recordedAt: a.recorded_at ? (iso(a.recorded_at) as string) : null,
        recordedBy: (a.recorded_by_name as string) ?? null,
        files: files.filter((f) => f.attendee_id === a.id).map(toFile),
      })),
      files: files.filter((f) => !f.attendee_id).map(toFile),
    };
  }

  get(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, (db) => this.detail(db, ctx, id));
  }

  private sessionData(body: Partial<CreateSessionBody>) {
    const { employeeIds: _employeeIds, ...rest } = body;
    void _employeeIds;
    return JSON.stringify(rest);
  }

  create(ctx: RequestContext, body: CreateSessionBody) {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ id: string }>(sql`
        select app.create_training_session(${orgOf(ctx)}::uuid, ${this.sessionData(body)}::jsonb, string_to_array(${(body.employeeIds ?? []).join(',')}, ',')::uuid[]) as id`);
      return this.detail(db, ctx, res.rows[0].id);
    });
  }

  update(ctx: RequestContext, id: string, body: UpdateSessionBody) {
    return this.database.asUser(ctx, async (db) => {
      await this.detail(db, ctx, id);
      await db.execute(sql`select app.update_training_session(${id}::uuid, ${this.sessionData(body)}::jsonb)`);
      return this.detail(db, ctx, id);
    });
  }

  addAttendee(ctx: RequestContext, id: string, body: AddAttendeeBody) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.add_session_attendee(${id}::uuid, ${body.employeeId}::uuid)`);
      return this.detail(db, ctx, id);
    });
  }

  record(ctx: RequestContext, id: string, body: RecordAttendeesBody) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`
        select app.record_session_attendees(${id}::uuid, string_to_array(${body.attendeeIds.join(',')}, ',')::uuid[], ${body.outcome}::text, ${body.completedOn ?? null}::date, ${body.note ?? null}::text)`);
      return this.detail(db, ctx, id);
    });
  }

  private async viaAttendee(ctx: RequestContext, attendeeId: string, run: (db: Db) => Promise<void>) {
    return this.database.asUser(ctx, async (db) => {
      const row = (await db.execute<Row>(sql`select session_id from public.competence_session_attendees where id = ${attendeeId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`)).rows;
      if (row.length === 0) throw ApiError.notFound('session_attendee_not_found', 'Attendee not found');
      await run(db);
      return this.detail(db, ctx, row[0].session_id as string);
    });
  }

  removeAttendee(ctx: RequestContext, attendeeId: string, reason: string) {
    return this.viaAttendee(ctx, attendeeId, async (db) => void (await db.execute(sql`select app.remove_session_attendee(${attendeeId}::uuid, ${reason})`)));
  }

  voidAttendee(ctx: RequestContext, attendeeId: string, reason: string) {
    return this.viaAttendee(ctx, attendeeId, async (db) => void (await db.execute(sql`select app.void_session_attendee(${attendeeId}::uuid, ${reason})`)));
  }

  private async command(ctx: RequestContext, id: string, run: (db: Db) => Promise<unknown>) {
    return this.database.asUser(ctx, async (db) => {
      await this.detail(db, ctx, id);
      await run(db);
      return this.detail(db, ctx, id);
    });
  }

  close(ctx: RequestContext, id: string) {
    return this.command(ctx, id, (db) => db.execute(sql`select app.close_training_session(${id}::uuid)`));
  }
  reopen(ctx: RequestContext, id: string, reason: string) {
    return this.command(ctx, id, (db) => db.execute(sql`select app.reopen_training_session(${id}::uuid, ${reason})`));
  }
  cancel(ctx: RequestContext, id: string, reason: string) {
    return this.command(ctx, id, (db) => db.execute(sql`select app.cancel_training_session(${id}::uuid, ${reason})`));
  }

  addAttachment(ctx: RequestContext, id: string, body: SessionAttachmentBody) {
    return this.command(ctx, id, (db) =>
      db.execute(sql`
        select app.add_competence_attachment(${body.attendeeId ? null : id}::uuid, ${body.attendeeId ?? null}::uuid, ${body.storagePath}, ${body.fileName}, ${body.contentType ?? null}, ${body.sizeBytes}::bigint, ${body.description ?? null})`),
    );
  }

  private async viaAttachment(ctx: RequestContext, fileId: string, run: (db: Db) => Promise<unknown>) {
    return this.database.asUser(ctx, async (db) => {
      const row = (
        await db.execute<Row>(sql`
          select coalesce(f.session_id, a.session_id) as session_id
            from public.competence_attachments f left join public.competence_session_attendees a on a.id = f.attendee_id
           where f.id = ${fileId}::uuid and f.organisation_id = ${orgOf(ctx)}::uuid`)
      ).rows;
      if (row.length === 0) throw ApiError.notFound('competence_file_not_found', 'File not found');
      await run(db);
      return this.detail(db, ctx, row[0].session_id as string);
    });
  }
  removeAttachment(ctx: RequestContext, fileId: string, reason: string) {
    return this.viaAttachment(ctx, fileId, (db) => db.execute(sql`select app.remove_competence_attachment(${fileId}::uuid, ${reason})`));
  }
  restoreAttachment(ctx: RequestContext, fileId: string) {
    return this.viaAttachment(ctx, fileId, (db) => db.execute(sql`select app.restore_competence_attachment(${fileId}::uuid)`));
  }
}
