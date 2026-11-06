import { Injectable } from '@nestjs/common';
import { sql, SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { iso, personName, Row } from '../calibration/calibration.service';
import { DatabaseService, Db } from '../database/database.service';
import { AlertDetail, AlertSummary, CreateAlertBody, ListQuery, ReasonBody, revisionLetter, ScopeInput, UpdateAlertBody } from './documentation.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const person = (id: unknown, name: unknown) => (id ? { id: id as string, name: (name as string) ?? 'Unknown' } : null);

const SELECT = sql`
  select a.id, a.alert_number, a.reference, a.revision, a.title, a.category, a.severity, a.description, a.required_action, a.status,
         a.effective_date::text as effective_date, a.expiry_date::text as expiry_date, a.acknowledge_by::text as acknowledge_by,
         a.revision_reason, a.supersedes_id, a.issued_at, a.issued_by, a.withdrawn_at, a.withdrawn_by, a.withdrawn_reason, a.created_by, a.updated_at,
         (a.status = 'active' and a.effective_date <= current_date) as in_force,
         ${sql.raw(personName('pi'))} as issued_by_name, ${sql.raw(personName('pw'))} as withdrawn_by_name, ${sql.raw(personName('pc'))} as created_by_name
  from public.quality_alerts a
  left join public.profiles pi on pi.id = a.issued_by
  left join public.profiles pw on pw.id = a.withdrawn_by
  left join public.profiles pc on pc.id = a.created_by`;

const toSummary = (r: Row): AlertSummary => ({
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
      const where: SQL[] = [sql`a.organisation_id = ${orgOf(ctx)}::uuid`, sql`a.deleted_at is null`];
      // The newest revision of each alert number, unless a lifecycle state was asked for.
      if (!q.status || q.status === 'all') {
        where.push(sql`a.revision = (select max(l.revision) from public.quality_alerts l where l.organisation_id = a.organisation_id and l.alert_number = a.alert_number and l.deleted_at is null)`);
      } else {
        where.push(sql`a.status = ${q.status}`);
      }
      if (q.category) where.push(sql`a.category = ${q.category}`);
      if (q.severity) where.push(sql`a.severity = ${q.severity}`);
      if (q.q) {
        const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        where.push(sql`(a.title ilike ${like} or a.reference ilike ${like})`);
      }
      const rows = await db.execute<Row>(sql`${SELECT} where ${sql.join(where, sql` and `)} order by a.alert_number desc, a.revision desc limit ${q.limit}`);
      return { data: rows.rows.map(toSummary) };
    });
  }

  get(ctx: RequestContext, id: string): Promise<AlertDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.expire(db, ctx);
      return this.load(db, ctx, id);
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

  // ---- helpers ------------------------------------------------------------------------------

  private async expire(db: Db, ctx: RequestContext) {
    await db.execute(sql`select app.expire_quality_alerts(${orgOf(ctx)}::uuid)`);
  }

  private async setScope(db: Db, id: string, scope: z.infer<typeof ScopeInput>) {
    await db.execute(sql`select app.set_quality_alert_scope(${id}::uuid, ${JSON.stringify(scope)}::jsonb)`);
  }

  private async load(db: Db, ctx: RequestContext, id: string): Promise<AlertDetail> {
    const rows = await db.execute<Row>(sql`${SELECT} where a.id = ${id}::uuid and a.organisation_id = ${orgOf(ctx)}::uuid and a.deleted_at is null`);
    if (!rows.rows.length) throw ApiError.notFound('quality_alert_not_found', 'Quality alert not found');
    const r = rows.rows[0];
    const [parts, machines, operations, departments, targets, revisions] = await Promise.all([
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
    ]);
    return {
      ...toSummary(r),
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
