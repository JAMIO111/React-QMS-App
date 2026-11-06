import { Injectable } from '@nestjs/common';
import { sql, SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { iso, personName, Row } from '../calibration/calibration.service';
import type { Attachment, CreateAttachmentBody, DeletedQuery } from '../calibration/calibration.schemas';
import { DatabaseService, Db } from '../database/database.service';
import { ActiveAlert, ActiveList, ActiveQuery, AcknowledgeBody, AddRecipientBody, AlertDetail, MineCount, MineList, RecipientList, RecipientsPreview, AlertSummary, CreateAlertBody, ListQuery, ReasonBody, revisionLetter, ScopeInput, UpdateAlertBody } from './documentation.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const person = (id: unknown, name: unknown) => (id ? { id: id as string, name: (name as string) ?? 'Unknown' } : null);

const SELECT = sql`
  select a.id, a.alert_number, a.reference, a.revision, a.title, a.category, a.severity, a.description, a.required_action, a.status,
         a.effective_date::text as effective_date, a.expiry_date::text as expiry_date, a.acknowledge_by::text as acknowledge_by,
         a.revision_reason, a.supersedes_id, a.issued_at, a.issued_by, a.withdrawn_at, a.withdrawn_by, a.withdrawn_reason, a.created_by, a.updated_at,
         (a.status = 'active' and a.effective_date <= current_date) as in_force,
         (select count(*) from public.quality_alert_recipients r where r.alert_id = a.id)::int as r_total,
         (select count(*) from public.quality_alert_recipients r where r.alert_id = a.id and r.first_viewed_at is not null)::int as r_viewed,
         (select count(*) from public.quality_alert_recipients r where r.alert_id = a.id and r.acknowledged_at is not null)::int as r_ack,
         (select count(*) from public.quality_alert_recipients r where r.alert_id = a.id and r.acknowledged_at is null and a.status = 'active' and a.acknowledge_by < current_date)::int as r_overdue,
         ${sql.raw(personName('pi'))} as issued_by_name, ${sql.raw(personName('pw'))} as withdrawn_by_name, ${sql.raw(personName('pc'))} as created_by_name
  from public.quality_alerts a
  left join public.profiles pi on pi.id = a.issued_by
  left join public.profiles pw on pw.id = a.withdrawn_by
  left join public.profiles pc on pc.id = a.created_by`;

const toSummary = (r: Row, manager = false): AlertSummary => ({
  id: r.id as string,
  number: Number(r.alert_number),
  reference: r.reference as string,
  revision: Number(r.revision),
  revisionLetter: revisionLetter(Number(r.revision)),
  title: r.title as string,
  category: r.category as AlertSummary['category'],
  severity: r.severity as AlertSummary['severity'],
  status: r.status as AlertSummary['status'],
  inForce: !!r.in_force,
  effectiveDate: (r.effective_date as string) ?? null,
  expiryDate: (r.expiry_date as string) ?? null,
  acknowledgeBy: (r.acknowledge_by as string) ?? null,
  issuedAt: iso(r.issued_at),
  issuedBy: person(r.issued_by, r.issued_by_name),
  createdBy: person(r.created_by, r.created_by_name),
  updatedAt: iso(r.updated_at)!,
  progress: manager ? { total: Number(r.r_total), viewed: Number(r.r_viewed), acknowledged: Number(r.r_ack), overdue: Number(r.r_overdue) } : null,
});

const ATTACHMENT_SELECT = sql`
  select a.*, ${sql.raw(personName('pc'))} as created_by_name
  from public.quality_alert_attachments a left join public.profiles pc on pc.id = a.created_by`;

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

const COLUMNS: Record<string, string> = {
  title: 'title', category: 'category', severity: 'severity', description: 'description', requiredAction: 'required_action',
  effectiveDate: 'effective_date', expiryDate: 'expiry_date', acknowledgeBy: 'acknowledge_by', revisionReason: 'revision_reason',
};
const DATE_COLUMNS = new Set(['effectiveDate', 'expiryDate', 'acknowledgeBy']);

/**
 * Quality alerts (DOC1): controlled communications that something needs immediate attention. Drafts are written under row-level
 * security; issuing, revising, withdrawing and discarding are database functions (docs/documentation-plan.md). There is no worker,
 * so expiry is applied when alerts are read or written.
 */
@Injectable()
export class DocumentationService {
  constructor(private readonly database: DatabaseService) {}

  list(ctx: RequestContext, q: ListQuery): Promise<{ data: AlertSummary[] }> {
    return this.database.asUser(ctx, async (db) => {
      await this.expire(db, ctx);
      const manager = await this.isManager(db, ctx);
      const where: SQL[] = [sql`a.organisation_id = ${orgOf(ctx)}::uuid`, sql`a.deleted_at is null`];
      // The newest revision of each alert number, unless a lifecycle state was asked for.
      if (!q.status || q.status === 'all') {
        where.push(sql`a.revision = (select max(l.revision) from public.quality_alerts l where l.organisation_id = a.organisation_id and l.alert_number = a.alert_number and l.deleted_at is null)`);
      } else {
        where.push(sql`a.status = ${q.status}`);
      }
      if (q.overdue === 'true' && manager) {
        where.push(sql`a.status = 'active' and a.acknowledge_by < current_date and exists (select 1 from public.quality_alert_recipients r where r.alert_id = a.id and r.acknowledged_at is null)`);
      }
      if (q.category) where.push(sql`a.category = ${q.category}`);
      if (q.severity) where.push(sql`a.severity = ${q.severity}`);
      if (q.q) {
        const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        where.push(sql`(a.title ilike ${like} or a.reference ilike ${like})`);
      }
      const rows = await db.execute<Row>(sql`${SELECT} where ${sql.join(where, sql` and `)} order by a.alert_number desc, a.revision desc limit ${q.limit}`);
      return { data: rows.rows.map((r) => toSummary(r, manager)) };
    });
  }

  get(ctx: RequestContext, id: string): Promise<AlertDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.expire(db, ctx);
      const alert = await this.load(db, ctx, id);
      if (alert.status !== 'draft' && alert.me && !alert.me.firstViewedAt) {
        // The first time an addressed person opens an issued alert is recorded.
        await db.execute(sql`select app.mark_quality_alert_viewed(${id}::uuid)`);
        return this.load(db, ctx, id);
      }
      return alert;
    });
  }

  create(ctx: RequestContext, body: CreateAlertBody): Promise<AlertDetail> {
    return this.database.asUser(ctx, async (db) => {
      const row = await db.execute<{ id: string }>(sql`
        insert into public.quality_alerts (organisation_id, title, category, severity, description, required_action, effective_date, expiry_date, acknowledge_by)
        values (${orgOf(ctx)}::uuid, ${body.title}, ${body.category}, ${body.severity}, ${body.description ?? null}, ${body.requiredAction ?? null},
                ${body.effectiveDate ?? null}::date, ${body.expiryDate ?? null}::date, ${body.acknowledgeBy ?? null}::date)
        returning id`);
      const id = row.rows[0].id;
      if (body.scope) await this.setScope(db, id, body.scope);
      return this.load(db, ctx, id);
    });
  }

  update(ctx: RequestContext, id: string, body: UpdateAlertBody): Promise<AlertDetail> {
    return this.database.asUser(ctx, async (db) => {
      const current = await this.load(db, ctx, id);
      if (current.status !== 'draft') {
        throw new ApiError(409, 'documentation_rule', 'An issued quality alert cannot be edited; issue a revision instead');
      }
      const { scope, ...fields } = body;
      const sets: SQL[] = [];
      for (const [key, column] of Object.entries(COLUMNS)) {
        const value = (fields as Record<string, unknown>)[key];
        if (value === undefined) continue;
        sets.push(DATE_COLUMNS.has(key) ? sql`${sql.raw(column)} = ${value as string | null}::date` : sql`${sql.raw(column)} = ${value as string | null}`);
      }
      if (sets.length) {
        const updated = await db.execute(sql`update public.quality_alerts set ${sql.join(sets, sql`, `)} where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid returning id`);
        if (updated.rows.length === 0) throw ApiError.forbidden('You are not allowed to edit this quality alert');
      }
      if (scope) await this.setScope(db, id, scope);
      return this.load(db, ctx, id);
    });
  }

  discard(ctx: RequestContext, id: string): Promise<void> {
    return this.database.asUser(ctx, async (db) => {
      await this.load(db, ctx, id);
      await db.execute(sql`select app.discard_quality_alert_draft(${id}::uuid)`);
    });
  }

  issue(ctx: RequestContext, id: string): Promise<AlertDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.load(db, ctx, id);
      await db.execute(sql`select app.issue_quality_alert(${id}::uuid)`);
      return this.load(db, ctx, id);
    });
  }

  withdraw(ctx: RequestContext, id: string, body: ReasonBody): Promise<AlertDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.load(db, ctx, id);
      await db.execute(sql`select app.withdraw_quality_alert(${id}::uuid, ${body.reason})`);
      return this.load(db, ctx, id);
    });
  }

  /** A draft revision copied from the current issued alert. */
  revise(ctx: RequestContext, id: string, body: ReasonBody): Promise<AlertDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.load(db, ctx, id);
      const res = await db.execute<{ id: string }>(sql`select app.revise_quality_alert(${id}::uuid, ${body.reason}) as id`);
      return this.load(db, ctx, res.rows[0].id);
    });
  }

  // ---- recipients and acknowledgement (DOC2) -------------------------------------------------

  /** How many people each target reaches, before issuing (documentation.manage). */
  preview(ctx: RequestContext, id: string): Promise<z.infer<typeof RecipientsPreview>> {
    return this.database.asUser(ctx, async (db) => {
      await this.load(db, ctx, id);
      const res = await db.execute<Row>(sql`select app.preview_quality_alert_recipients(${id}::uuid) as p`);
      return res.rows[0].p as z.infer<typeof RecipientsPreview>;
    });
  }

  /** Who was asked to acknowledge, and who has seen and acknowledged it (documentation.manage). */
  recipients(ctx: RequestContext, id: string): Promise<z.infer<typeof RecipientList>> {
    return this.database.asUser(ctx, async (db) => {
      const alert = await this.load(db, ctx, id);
      const rows = await db.execute<Row>(sql`
        select r.id, r.membership_id, r.reached_via, r.first_viewed_at, r.acknowledged_at, r.acknowledgement_note,
               coalesce(${sql.raw(personName('p'))}, m.invited_email, 'Unknown') as name
        from public.quality_alert_recipients r
        join public.organisation_users m on m.id = r.membership_id
        left join public.profiles p on p.id = r.user_id
        where r.alert_id = ${id}::uuid and r.organisation_id = ${orgOf(ctx)}::uuid
        order by (r.acknowledged_at is not null), name`);
      const overdueOn = alert.status === 'active' && !!alert.acknowledgeBy && alert.acknowledgeBy < new Date().toISOString().slice(0, 10);
      const data = rows.rows.map((r) => ({
        id: r.id as string,
        membershipId: r.membership_id as string,
        name: r.name as string,
        reachedVia: r.reached_via as string[],
        firstViewedAt: iso(r.first_viewed_at),
        acknowledgedAt: iso(r.acknowledged_at),
        note: (r.acknowledgement_note as string) ?? null,
        overdue: overdueOn && !r.acknowledged_at,
      }));
      return {
        data,
        totals: { total: data.length, viewed: data.filter((x) => x.firstViewedAt).length, acknowledged: data.filter((x) => x.acknowledgedAt).length, overdue: data.filter((x) => x.overdue).length },
      };
    });
  }

  /** "I have read and understood", by the person it is addressed to. */
  acknowledge(ctx: RequestContext, id: string, body: AcknowledgeBody): Promise<AlertDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.load(db, ctx, id);
      await db.execute(sql`select app.acknowledge_quality_alert(${id}::uuid, ${body.note ?? null})`);
      return this.load(db, ctx, id);
    });
  }

  addRecipient(ctx: RequestContext, id: string, body: AddRecipientBody): Promise<AlertDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.load(db, ctx, id);
      await db.execute(sql`select app.add_quality_alert_recipient(${id}::uuid, ${body.membershipId}::uuid)`);
      return this.load(db, ctx, id);
    });
  }

  /** Alerts addressed to the caller: open ones first, overdue before the rest; ended ones stay for 30 days. */
  mine(ctx: RequestContext): Promise<z.infer<typeof MineList>> {
    return this.database.asUser(ctx, async (db) => {
      await this.expire(db, ctx);
      const mine = await db.execute<Row>(sql`
        select r.alert_id, r.first_viewed_at, r.acknowledged_at, r.acknowledgement_note, r.reached_via
        from public.quality_alert_recipients r join public.quality_alerts a on a.id = r.alert_id
        where r.organisation_id = ${orgOf(ctx)}::uuid and r.user_id = auth.uid() and a.deleted_at is null
          and (a.status = 'active' or a.updated_at > now() - interval '30 days')`);
      if (!mine.rows.length) return { data: [], unacknowledged: 0, overdue: 0 };
      const ids = mine.rows.map((x) => x.alert_id as string);
      const alerts = await db.execute<Row>(sql`${SELECT} where a.id = any (string_to_array(${ids.join(',')}, ',')::uuid[])`);
      const by = new Map(alerts.rows.map((r) => [r.id as string, r]));
      const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
      const data = mine.rows
        .flatMap((m) => {
          const a = by.get(m.alert_id as string);
          if (!a) return [];
          const summary = toSummary(a);
          const acknowledged = !!m.acknowledged_at;
          const overdue = !acknowledged && summary.status === 'active' && !!summary.acknowledgeBy && summary.acknowledgeBy < new Date().toISOString().slice(0, 10);
          const state: 'open' | 'acknowledged' | 'closed' = summary.status !== 'active' ? 'closed' : acknowledged ? 'acknowledged' : 'open';
          return [{ ...summary, state, me: { firstViewedAt: iso(m.first_viewed_at), acknowledgedAt: iso(m.acknowledged_at), note: (m.acknowledgement_note as string) ?? null, reachedVia: m.reached_via as string[], overdue } }];
        })
        .sort((x, y) => {
          const order = { open: 0, acknowledged: 1, closed: 2 } as const;
          return order[x.state] - order[y.state] || Number(y.me.overdue) - Number(x.me.overdue) || rank[x.severity] - rank[y.severity] || (y.issuedAt ?? '').localeCompare(x.issuedAt ?? '');
        });
      return { data, unacknowledged: data.filter((d) => d.state === 'open').length, overdue: data.filter((d) => d.me.overdue).length };
    });
  }

  /** Just the numbers, for the menu badge. */
  mineCount(ctx: RequestContext): Promise<z.infer<typeof MineCount>> {
    return this.database.asUser(ctx, async (db) => {
      await this.expire(db, ctx);
      const res = await db.execute<Row>(sql`
        select count(*) filter (where a.status = 'active' and r.acknowledged_at is null)::int as unacknowledged,
               count(*) filter (where a.status = 'active' and r.acknowledged_at is null and a.acknowledge_by < current_date)::int as overdue
        from public.quality_alert_recipients r join public.quality_alerts a on a.id = r.alert_id
        where r.organisation_id = ${orgOf(ctx)}::uuid and r.user_id = auth.uid() and a.deleted_at is null`);
      return { unacknowledged: Number(res.rows[0].unacknowledged), overdue: Number(res.rows[0].overdue) };
    });
  }

  // ---- where work happens (DOC3) --------------------------------------------------------------

  /**
   * Alerts in force that affect what is being worked on (a part, its family, a machine, an operation): shown above inspection
   * starts and on part, family and machine pages. Read-only; nothing is ever blocked.
   */
  active(ctx: RequestContext, q: ActiveQuery): Promise<z.infer<typeof ActiveList>> {
    return this.database.asUser(ctx, async (db) => {
      await this.expire(db, ctx);
      const rows = await db.execute<Row>(sql`
        with ctx as (
          select ${q.partId ?? null}::uuid as part_id,
                 coalesce(${q.partFamilyId ?? null}::uuid, (select p.part_family_id from public.parts p where p.id = ${q.partId ?? null}::uuid)) as family_id,
                 ${q.machineId ?? null}::uuid as machine_id, ${q.operationCode ?? null}::text as operation_code)
        select a.id, a.reference, a.revision, a.title, a.category, a.severity, a.required_action, a.effective_date::text as effective_date, a.acknowledge_by::text as acknowledge_by,
               exists (select 1 from public.quality_alert_parts x, ctx where x.alert_id = a.id and x.part_id = ctx.part_id) as m_part,
               exists (select 1 from public.quality_alert_parts x, ctx where x.alert_id = a.id and x.part_family_id = ctx.family_id) as m_family,
               exists (select 1 from public.quality_alert_machines x, ctx where x.alert_id = a.id and x.machine_id = ctx.machine_id) as m_machine,
               exists (select 1 from public.quality_alert_operations x, ctx where x.alert_id = a.id and x.operation_code = ctx.operation_code) as m_operation,
               (select (r.acknowledged_at is not null) from public.quality_alert_recipients r where r.alert_id = a.id and r.user_id = auth.uid()) as acknowledged
        from public.quality_alerts a
        where a.organisation_id = ${orgOf(ctx)}::uuid and a.deleted_at is null and a.status = 'active' and a.effective_date <= current_date
        order by case a.severity when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end, a.issued_at desc`);
      const data = rows.rows
        .map((r) => {
          const matched = (['part', 'family', 'machine', 'operation'] as const).filter((k) => r[`m_${k}`]);
          return {
            id: r.id as string,
            reference: r.reference as string,
            revisionLetter: revisionLetter(Number(r.revision)),
            title: r.title as string,
            category: r.category as AlertSummary['category'],
            severity: r.severity as AlertSummary['severity'],
            requiredAction: (r.required_action as string) ?? null,
            effectiveDate: r.effective_date as string,
            acknowledgeBy: (r.acknowledge_by as string) ?? null,
            matched: [...matched],
            acknowledged: r.acknowledged === null || r.acknowledged === undefined ? null : !!r.acknowledged,
          };
        })
        .filter((a) => a.matched.length > 0);
      return { data } satisfies z.infer<typeof ActiveList>;
    });
  }

  // ---- attachments (DOC3): files on a draft, kept when removed ---------------------------------

  listAttachments(ctx: RequestContext, id: string, q: z.infer<typeof DeletedQuery>): Promise<z.infer<typeof Attachment>[]> {
    return this.database.asUser(ctx, async (db) => {
      await this.load(db, ctx, id);
      const filter = q.deleted === 'exclude' ? sql`a.deleted_at is null` : q.deleted === 'only' ? sql`a.deleted_at is not null` : sql`true`;
      const rows = await db.execute<Row>(sql`${ATTACHMENT_SELECT} where a.alert_id = ${id}::uuid and ${filter} order by a.created_at desc`);
      return rows.rows.map(toAttachment);
    });
  }

  /** Records a file the client has already uploaded to storage at <org>/quality-alerts/<id>/<name>. */
  createAttachment(ctx: RequestContext, id: string, body: z.infer<typeof CreateAttachmentBody>): Promise<z.infer<typeof Attachment>> {
    return this.database.asUser(ctx, async (db) => {
      await this.load(db, ctx, id);
      const folder = `${orgOf(ctx)}/quality-alerts/${id}/`;
      if (!body.storagePath.startsWith(folder) || body.storagePath.includes('..') || body.storagePath.length === folder.length) {
        throw ApiError.badRequest('invalid_path', `Files for this alert must be uploaded to ${folder}`);
      }
      const stored = await db.execute(sql`select 1 from storage.objects where bucket_id = 'quality-alert-files' and name = ${body.storagePath}`);
      if (!stored.rows.length) throw ApiError.badRequest('file_not_uploaded', 'Upload the file before attaching it');
      const res = await db.execute<{ id: string }>(sql`select app.add_quality_alert_attachment(${id}::uuid, ${body.storagePath}, ${body.fileName}, ${body.contentType ?? null}, ${body.sizeBytes}::bigint, ${body.description ?? null}) as id`);
      return this.loadAttachment(db, ctx, res.rows[0].id);
    });
  }

  removeAttachment(ctx: RequestContext, attachmentId: string, reason: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.assertAttachment(db, ctx, attachmentId);
      await db.execute(sql`select app.remove_quality_alert_attachment(${attachmentId}::uuid, ${reason})`);
      return this.loadAttachment(db, ctx, attachmentId);
    });
  }

  restoreAttachment(ctx: RequestContext, attachmentId: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.assertAttachment(db, ctx, attachmentId);
      await db.execute(sql`select app.restore_quality_alert_attachment(${attachmentId}::uuid)`);
      return this.loadAttachment(db, ctx, attachmentId);
    });
  }

  private async assertAttachment(db: Db, ctx: RequestContext, id: string) {
    const res = await db.execute(sql`select 1 from public.quality_alert_attachments where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
    if (!res.rows.length) throw ApiError.notFound('attachment_not_found', 'File not found');
  }

  private async loadAttachment(db: Db, ctx: RequestContext, id: string) {
    const res = await db.execute<Row>(sql`${ATTACHMENT_SELECT} where a.id = ${id}::uuid and a.organisation_id = ${orgOf(ctx)}::uuid`);
    if (!res.rows.length) throw ApiError.notFound('attachment_not_found', 'File not found');
    return toAttachment(res.rows[0]);
  }

  // ---- helpers ------------------------------------------------------------------------------

  private async isManager(db: Db, ctx: RequestContext): Promise<boolean> {
    const r = await db.execute<Row>(sql`select app.has_permission(${orgOf(ctx)}::uuid, 'documentation.manage') as ok`);
    return !!r.rows[0]?.ok;
  }

  private async expire(db: Db, ctx: RequestContext) {
    await db.execute(sql`select app.expire_quality_alerts(${orgOf(ctx)}::uuid)`);
  }

  private async setScope(db: Db, id: string, scope: z.infer<typeof ScopeInput>) {
    const { links, ...rest } = scope;
    if (Object.keys(rest).length) await db.execute(sql`select app.set_quality_alert_scope(${id}::uuid, ${JSON.stringify(rest)}::jsonb)`);
    if (links !== undefined) await db.execute(sql`select app.set_quality_alert_links(${id}::uuid, ${JSON.stringify(links)}::jsonb)`);
  }

  private async load(db: Db, ctx: RequestContext, id: string): Promise<AlertDetail> {
    const rows = await db.execute<Row>(sql`${SELECT} where a.id = ${id}::uuid and a.organisation_id = ${orgOf(ctx)}::uuid and a.deleted_at is null`);
    if (!rows.rows.length) throw ApiError.notFound('quality_alert_not_found', 'Quality alert not found');
    const r = rows.rows[0];
    const manager = await this.isManager(db, ctx);
    const mineRow = await db.execute<Row>(sql`select first_viewed_at, acknowledged_at, acknowledgement_note, reached_via from public.quality_alert_recipients where alert_id = ${id}::uuid and user_id = auth.uid()`);
    const [parts, machines, operations, departments, targets, revisions, links] = await Promise.all([
      db.execute<Row>(sql`select qp.id, qp.part_id, qp.part_family_id, coalesce(p.part_number || ' · ' || p.name, f.code || ' · ' || f.name) as label
        from public.quality_alert_parts qp left join public.parts p on p.id = qp.part_id left join public.part_families f on f.id = qp.part_family_id
        where qp.alert_id = ${id}::uuid order by label`),
      db.execute<Row>(sql`select qm.id, qm.machine_id, m.code || ' · ' || m.name as label from public.quality_alert_machines qm join public.machines m on m.id = qm.machine_id where qm.alert_id = ${id}::uuid order by label`),
      db.execute<Row>(sql`select operation_code from public.quality_alert_operations where alert_id = ${id}::uuid order by operation_code`),
      db.execute<Row>(sql`select qd.id, qd.department_id, d.code || ' · ' || d.name || ' (' || s.name || ')' as label from public.quality_alert_departments qd
        join public.departments d on d.id = qd.department_id join public.sites s on s.id = d.site_id where qd.alert_id = ${id}::uuid order by label`),
      db.execute<Row>(sql`select t.id, t.department_id, t.role_id, t.membership_id,
          case when t.department_id is not null then 'department' when t.role_id is not null then 'role' else 'person' end as kind,
          coalesce(d.code || ' · ' || d.name || ' (' || s.name || ')', ro.name, ${sql.raw(personName('pp'))}, m.invited_email, 'Unknown') as label
        from public.quality_alert_targets t
        left join public.departments d on d.id = t.department_id left join public.sites s on s.id = d.site_id
        left join public.roles ro on ro.id = t.role_id
        left join public.organisation_users m on m.id = t.membership_id left join public.profiles pp on pp.id = m.user_id
        where t.alert_id = ${id}::uuid order by kind, label`),
      db.execute<Row>(sql`select id, revision, status, issued_at, revision_reason from public.quality_alerts
        where organisation_id = ${orgOf(ctx)}::uuid and alert_number = ${r.alert_number as number} and deleted_at is null order by revision desc`),
      // The labels come from joins that run as the caller, so a record they cannot read has no label.
      db.execute<Row>(sql`select l.id, l.nonconformance_id, l.supplier_id, l.gauge_id, l.calibration_id,
          n.reference || ' · ' || n.title as nc, s.name as supplier, g.asset_number || coalesce(' · ' || g.description, '') as gauge, c.reference as calibration, n.source as nc_source, c.gauge_id as cal_gauge_id
        from public.quality_alert_links l
        left join public.nonconformances n on n.id = l.nonconformance_id
        left join public.suppliers s on s.id = l.supplier_id
        left join public.gauges g on g.id = l.gauge_id
        left join public.calibrations c on c.id = l.calibration_id
        where l.alert_id = ${id}::uuid order by l.created_at`),
    ]);
    const summary = toSummary(r, manager);
    const m = mineRow.rows[0];
    return {
      ...summary,
      me: m
        ? {
            firstViewedAt: iso(m.first_viewed_at),
            acknowledgedAt: iso(m.acknowledged_at),
            note: (m.acknowledgement_note as string) ?? null,
            reachedVia: m.reached_via as string[],
            overdue: !m.acknowledged_at && summary.status === 'active' && !!summary.acknowledgeBy && summary.acknowledgeBy < new Date().toISOString().slice(0, 10),
          }
        : null,
      description: (r.description as string) ?? null,
      requiredAction: (r.required_action as string) ?? null,
      revisionReason: (r.revision_reason as string) ?? null,
      supersedesId: (r.supersedes_id as string) ?? null,
      withdrawn: r.withdrawn_at ? { at: iso(r.withdrawn_at)!, by: person(r.withdrawn_by, r.withdrawn_by_name), reason: r.withdrawn_reason as string } : null,
      scope: {
        parts: parts.rows.map((x) => ({ id: x.id as string, kind: x.part_id ? ('part' as const) : ('family' as const), partId: (x.part_id as string) ?? null, partFamilyId: (x.part_family_id as string) ?? null, label: x.label as string })),
        machines: machines.rows.map((x) => ({ id: x.id as string, machineId: x.machine_id as string, label: x.label as string })),
        operations: operations.rows.map((x) => x.operation_code as string),
        departments: departments.rows.map((x) => ({ id: x.id as string, departmentId: x.department_id as string, label: x.label as string })),
        targets: targets.rows.map((x) => ({
          id: x.id as string,
          kind: x.kind as 'department' | 'role' | 'person',
          departmentId: (x.department_id as string) ?? null,
          roleId: (x.role_id as string) ?? null,
          membershipId: (x.membership_id as string) ?? null,
          label: x.label as string,
        })),
      },
      links: links.rows.map((x) => {
        const kind = x.nonconformance_id ? ('nonconformance' as const) : x.supplier_id ? ('supplier' as const) : x.gauge_id ? ('gauge' as const) : ('calibration' as const);
        const recordId = (x.nonconformance_id ?? x.supplier_id ?? x.gauge_id ?? x.calibration_id) as string;
        const label = (kind === 'nonconformance' ? x.nc : kind === 'supplier' ? x.supplier : kind === 'gauge' ? x.gauge : x.calibration) as string | null;
        return { id: x.id as string, kind, recordId, label: label ?? null, source: kind === 'nonconformance' ? ((x.nc_source as string) ?? null) : null, gaugeId: kind === 'calibration' ? ((x.cal_gauge_id as string) ?? null) : null };
      }),
      revisions: revisions.rows.map((x) => ({
        id: x.id as string,
        revision: Number(x.revision),
        revisionLetter: revisionLetter(Number(x.revision)),
        status: x.status as AlertSummary['status'],
        issuedAt: iso(x.issued_at),
        revisionReason: (x.revision_reason as string) ?? null,
      })),
    };
  }
}
