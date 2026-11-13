import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { TRIGGERS, triggerFor, workflowRecordPath } from './catalogue';
import { conditionHolds, conditionProblems, Conditions } from './conditions';
import type { Action, CreateRuleBody, InnerAction, TestBody, UpdateRuleBody } from './workflows.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const json = (v: unknown) => JSON.stringify(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every id a rule names: ref values in its conditions and the people, roles and departments in its actions. */
function namedIds(conditions: Conditions | undefined, actions: Action[] | undefined): string[] {
  const ids = new Set<string>();
  for (const c of [...(conditions?.all ?? []), ...(conditions?.any ?? [])]) {
    for (const v of Array.isArray(c.value) ? c.value : c.value ? [c.value] : []) if (UUID.test(v)) ids.add(v);
  }
  for (const a of actions ?? []) {
    if (a.type === 'later') {
      for (const id of namedIds(a.conditions, a.actions as Action[])) ids.add(id);
      continue;
    }
    for (const r of recipientsOf(a)) {
      const id = r.kind === 'person' ? r.userId : r.kind === 'role' ? r.roleId : r.kind === 'department' ? r.departmentId : null;
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

type Recipient = { kind: string; userId?: string; roleId?: string; departmentId?: string };
/** The people, roles and departments an action names (none for holding a lot or a timer itself). */
function recipientsOf(a: Action | InnerAction): Recipient[] {
  if (a.type === 'notify') return a.recipients as Recipient[];
  if (a.type === 'task') return [a.assignee as Recipient];
  return [];
}

/** The record kinds a lot can be found on: a non-conformance's lot, or the lot of the inspection a failed reading belongs to. */
const LOT_TRIGGERS = new Set(['nonconformance', 'inspection_measurement']);

/** Workflow rules and tasks (WF1). Rules are written by `app.save_workflow_rule`; what they test and do is checked here against the catalogue first. */
@Injectable()
export class WorkflowsService {
  constructor(private readonly database: DatabaseService) {}

  triggers() {
    return { data: TRIGGERS };
  }

  list(ctx: RequestContext) {
    return this.database.asUser(ctx, async (db) => {
      const rows = (
        await db.execute<Row>(sql`
          select r.id, r.reference, r.name, r.description, r.status, r.status_reason, r.current_version, v.trigger, r.updated_at,
                 (select count(*)::int from public.workflow_runs w where w.rule_id = r.id) as runs,
                 (select max(w.created_at) from public.workflow_runs w where w.rule_id = r.id) as last_run
            from public.workflow_rules r join public.workflow_rule_versions v on v.rule_id = r.id and v.version = r.current_version
           where r.organisation_id = ${orgOf(ctx)}::uuid
           order by (r.status = 'retired'), r.reference`)
      ).rows;
      return {
        data: rows.map((r) => ({
          id: r.id as string,
          reference: r.reference as string,
          name: r.name as string,
          description: (r.description as string) ?? null,
          status: r.status as string,
          statusReason: (r.status_reason as string) ?? null,
          version: Number(r.current_version),
          trigger: r.trigger as string,
          triggerLabel: triggerFor(r.trigger as string)?.label ?? (r.trigger as string),
          runs: Number(r.runs),
          lastRunAt: r.last_run ? new Date(r.last_run as string).toISOString() : null,
        })),
      };
    });
  }

  get(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, (db) => this.load(db, ctx, id));
  }

  async create(ctx: RequestContext, body: CreateRuleBody) {
    await this.check(ctx, body.trigger, body.conditions, body.actions);
    return this.database.asUser(ctx, async (db) => {
      const id = (await db.execute<{ id: string }>(sql`select app.save_workflow_rule(${orgOf(ctx)}::uuid, ${json(body)}::jsonb) as id`)).rows[0].id;
      return this.load(db, ctx, id);
    });
  }

  async update(ctx: RequestContext, id: string, body: UpdateRuleBody) {
    const current = await this.get(ctx, id);
    const trigger = body.trigger ?? current.trigger;
    await this.check(ctx, trigger, body.conditions ?? current.conditions, body.actions ?? current.actions);
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.save_workflow_rule(${orgOf(ctx)}::uuid, ${json(body)}::jsonb, ${id}::uuid)`);
      return this.load(db, ctx, id);
    });
  }

  setStatus(ctx: RequestContext, id: string, status: string, reason?: string) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.set_workflow_rule_status(${id}::uuid, ${status}, ${reason ?? null})`);
      return this.load(db, ctx, id);
    });
  }

  /** Names for ids a rule shows (parts, sites, people, roles …), read as the caller: an id they may not read has no name. */
  private async labels(db: Db, ctx: RequestContext, ids: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    if (!ids.length) return out;
    const list = ids.join(',');
    const rows = (
      await db.execute<Row>(sql`
        with wanted as (select unnest(string_to_array(${list}, ','))::uuid as id)
        select s.id, s.name as label from public.sites s join wanted w on w.id = s.id where s.organisation_id = ${orgOf(ctx)}::uuid
        union all select p.id, concat_ws(' · ', p.part_number, p.name) from public.parts p join wanted w on w.id = p.id
        union all select f.id, concat_ws(' · ', f.code, f.name) from public.part_families f join wanted w on w.id = f.id
        union all select x.id, x.name from public.suppliers x join wanted w on w.id = x.id
        union all select x.id, x.name from public.customers x join wanted w on w.id = x.id
        union all select m.id, concat_ws(' · ', m.code, m.name) from public.machines m join wanted w on w.id = m.id
        union all select g.id, g.name from public.gauge_types g join wanted w on w.id = g.id
        union all select r.id, r.name from public.roles r join wanted w on w.id = r.id where r.organisation_id = ${orgOf(ctx)}::uuid
        union all select d.id, d.name from public.departments d join wanted w on w.id = d.id
        union all select c.user_id, c.name from app.custom_field_people(${orgOf(ctx)}::uuid) c join wanted w on w.id = c.user_id`)
    ).rows;
    for (const r of rows) if (r.label) out[r.id as string] = r.label as string;
    return out;
  }

  /** The facts of a record in words, field by field, for the trigger's fields. */
  private describeFacts(triggerKey: string, facts: Record<string, unknown>, labels: Record<string, string>) {
    const trigger = triggerFor(triggerKey);
    return (trigger?.fields ?? []).map((f) => {
      const raw = facts[f.key];
      const value = raw === null || raw === undefined || raw === '' ? null : String(raw);
      const words = value === null ? null : f.options?.find((o) => o.value === value)?.label ?? (f.type === 'ref' ? labels[value] ?? null : value);
      return { field: f.key, label: f.label, value, words };
    });
  }

  /** The latest events a rule could have run on (90 days), whose record the caller may read, with the record and its facts in words. */
  testEvents(ctx: RequestContext, triggerKey: string) {
    if (!triggerFor(triggerKey)) throw new ApiError(409, 'workflow_rule', 'Choose what starts the rule');
    return this.database.asUser(ctx, async (db) => {
      const rows = (await db.execute<Row>(sql`select event_id::text as event_id, created_at, facts from app.workflow_recent_events(${orgOf(ctx)}::uuid, ${triggerKey}, 20)`)).rows;
      const ids = new Set<string>();
      for (const r of rows) for (const v of Object.values((r.facts as Record<string, unknown>) ?? {})) if (typeof v === 'string' && UUID.test(v)) ids.add(v);
      const labels = await this.labels(db, ctx, [...ids]);
      return {
        data: rows.map((r) => {
          const facts = r.facts as Record<string, unknown>;
          return {
            eventId: Number(r.event_id),
            at: new Date(r.created_at as string).toISOString(),
            record: { kind: facts.record_kind as string, id: facts.record_id as string, label: facts.label as string, path: workflowRecordPath(facts.record_kind, facts.record_id) },
            facts: this.describeFacts(triggerKey, facts, labels),
          };
        }),
      };
    });
  }

  /**
   * A dry run: whether the rule as written would match one recent event (each condition with its outcome) and, if so, whom each action would reach and whether
   * each may be told. The same evaluation and the same "may be told" check as the worker; nothing is saved or sent.
   */
  async test(ctx: RequestContext, body: TestBody) {
    const trigger = triggerFor(body.trigger);
    if (!trigger) throw new ApiError(409, 'workflow_rule', 'Choose what starts the rule');
    const problems = conditionProblems(body.conditions ?? {}, trigger);
    if (problems.length) throw new ApiError(409, 'workflow_rule', problems[0], { problems });
    return this.database.asUser(ctx, async (db) => {
      // Timers' inner actions are previewed too (who they would reach today); they follow the top-level ones in the list sent.
      const flat: (Action | InnerAction)[] = [...body.actions];
      const innerAt: number[][] = body.actions.map((a) => (a.type === 'later' ? a.actions.map((inner) => flat.push(inner) - 1) : []));
      const preview = (
        await db.execute<Row>(sql`select app.workflow_preview_people(${orgOf(ctx)}::uuid, ${body.eventId}::bigint, ${json(flat)}::jsonb) as p`)
      ).rows[0].p as { eventType: string; createdAt: string; facts: Record<string, unknown>; actions: { index: number; type: string; total: number; people: { userId: string; name: string; told: boolean }[] }[] };
      if (preview.eventType !== body.trigger) throw new ApiError(409, 'workflow_rule', 'That event is not one this rule starts from');
      const facts = preview.facts;
      const ids = new Set<string>(namedIds(body.conditions, body.actions));
      for (const v of Object.values(facts)) if (typeof v === 'string' && UUID.test(v)) ids.add(v);
      const labels = await this.labels(db, ctx, [...ids]);
      const check = (c: { field: string; op: string; value?: string | string[] }) => ({
        field: c.field,
        label: trigger.fields.find((f) => f.key === c.field)?.label ?? c.field,
        op: c.op,
        value: c.value ?? null,
        holds: conditionHolds(c as never, facts, trigger),
      });
      const all = (body.conditions.all ?? []).map(check);
      const any = (body.conditions.any ?? []).map(check);
      const matched = all.every((c) => c.holds) && (any.length === 0 || any.some((c) => c.holds));
      return {
        eventId: body.eventId,
        at: new Date(preview.createdAt).toISOString(),
        record: { kind: facts.record_kind as string, id: facts.record_id as string, label: facts.label as string, path: workflowRecordPath(facts.record_kind, facts.record_id) },
        facts: this.describeFacts(body.trigger, facts, labels),
        conditions: { all, any },
        matched,
        actions: body.actions.map((action, i) => {
          const a = preview.actions[i];
          const out = { index: i, type: action.type, total: a.total, people: a.people, wouldTell: matched ? a.people.filter((p) => p.told).length : 0 };
          if (action.type !== 'later') return out;
          // A timer reads the record again when it runs; today's answer is only a guide.
          const stillAll = (action.conditions.all ?? []).map(check);
          const stillAny = (action.conditions.any ?? []).map(check);
          return {
            ...out,
            afterDays: action.afterDays,
            stillNow: { all: stillAll, any: stillAny, holds: stillAll.every((c) => c.holds) && (stillAny.length === 0 || stillAny.some((c) => c.holds)) },
            inner: innerAt[i].map((at, j) => {
              const p = preview.actions[at];
              return { index: j, type: p.type, total: p.total, people: p.people };
            }),
          };
        }),
        labels,
      };
    });
  }

  /** The caller's own tasks (open by default); no workflow permission needed. */
  myTasks(ctx: RequestContext, status: 'open' | 'done' | 'all') {
    return this.database.asUser(ctx, async (db) => {
      const org = orgOf(ctx);
      const rows = (
        await db.execute<Row>(sql`
          select t.id, t.reference, t.title, t.detail, t.record_kind, t.record_id, t.record_label, t.due_on::text as due_on, t.status, t.done_note, t.done_at, t.created_at,
                 (t.status = 'open' and t.due_on < current_date) as overdue, t.rule_name
            from public.workflow_tasks t
           where t.organisation_id = ${org}::uuid and t.assignee_user_id = auth.uid()
             ${status === 'open' ? sql`and t.status = 'open'` : status === 'done' ? sql`and t.status = 'done'` : sql``}
           order by (t.status = 'open') desc, t.due_on nulls last, t.created_at desc limit 200`)
      ).rows;
      const counts = (
        await db.execute<Row>(sql`
          select count(*) filter (where status = 'open')::int as open, count(*) filter (where status = 'open' and due_on < current_date)::int as overdue
            from public.workflow_tasks where organisation_id = ${org}::uuid and assignee_user_id = auth.uid()`)
      ).rows[0];
      return { data: rows.map((t) => this.task(t)), openCount: Number(counts.open), overdueCount: Number(counts.overdue) };
    });
  }

  async taskCommand(ctx: RequestContext, id: string, command: 'complete' | 'reopen' | 'cancel', text?: string) {
    return this.database.asUser(ctx, async (db) => {
      if (command === 'complete') await db.execute(sql`select app.complete_workflow_task(${id}::uuid, ${text ?? null})`);
      else if (command === 'reopen') await db.execute(sql`select app.reopen_workflow_task(${id}::uuid)`);
      else await db.execute(sql`select app.cancel_workflow_task(${id}::uuid, ${text ?? null})`);
      const row = (
        await db.execute<Row>(sql`
          select t.id, t.reference, t.title, t.detail, t.record_kind, t.record_id, t.record_label, t.due_on::text as due_on, t.status, t.done_note, t.done_at, t.created_at,
                 (t.status = 'open' and t.due_on < current_date) as overdue, t.rule_name
            from public.workflow_tasks t where t.id = ${id}::uuid`)
      ).rows[0];
      if (!row) throw ApiError.notFound('task_not_found', 'Task not found');
      return this.task(row);
    });
  }

  private task(t: Row) {
    return {
      id: t.id as string,
      reference: t.reference as string,
      title: t.title as string,
      detail: (t.detail as string) ?? null,
      ruleName: (t.rule_name as string) ?? null,
      record: { kind: t.record_kind as string, id: t.record_id as string, label: t.record_label as string, path: workflowRecordPath(t.record_kind, t.record_id) },
      dueOn: (t.due_on as string) ?? null,
      overdue: Boolean(t.overdue),
      status: t.status as 'open' | 'done' | 'cancelled',
      doneNote: (t.done_note as string) ?? null,
      doneAt: t.done_at ? new Date(t.done_at as string).toISOString() : null,
      createdAt: new Date(t.created_at as string).toISOString(),
    };
  }

  /** Conditions and actions must fit the trigger; the people, roles and departments named must be this organisation's. */
  private async check(ctx: RequestContext, triggerKey: string, conditions: Conditions, actions: Action[]) {
    const trigger = triggerFor(triggerKey);
    if (!trigger) throw new ApiError(409, 'workflow_rule', 'Choose what starts the rule');
    const problems = conditionProblems(conditions ?? {}, trigger);
    const users = new Set<string>();
    const roles = new Set<string>();
    const departments = new Set<string>();
    const visit = (a: Action | InnerAction, where: string) => {
      if (a.type === 'hold_lot' && !LOT_TRIGGERS.has(trigger.entityType)) problems.push(`${where}"${trigger.label}" names no lot, so there is no lot to put on hold`);
      for (const r of recipientsOf(a)) {
        if (r.kind === 'person' && r.userId) users.add(r.userId);
        if (r.kind === 'role' && r.roleId) roles.add(r.roleId);
        if (r.kind === 'department' && r.departmentId) departments.add(r.departmentId);
      }
    };
    actions.forEach((a, i) => {
      if (a.type === 'later') {
        for (const p of conditionProblems(a.conditions ?? {}, trigger)) problems.push(`Action ${i + 1}, still true after ${a.afterDays} days: ${p}`);
        a.actions.forEach((inner) => visit(inner, `Action ${i + 1}: `));
      } else visit(a, '');
    });
    await this.database.asUser(ctx, async (db) => {
      const org = orgOf(ctx);
      if (users.size) {
        const found = (await db.execute<Row>(sql`select user_id from app.custom_field_people(${org}::uuid) where user_id = any(string_to_array(${[...users].join(',')}, ',')::uuid[])`)).rows;
        if (found.length < users.size) problems.push('Someone named is not an active member of this organisation');
      }
      if (roles.size) {
        const found = (await db.execute<Row>(sql`select id from public.roles where organisation_id = ${org}::uuid and id = any(string_to_array(${[...roles].join(',')}, ',')::uuid[])`)).rows;
        if (found.length < roles.size) problems.push('A role named is not one of this organisation\'s');
      }
      if (departments.size) {
        const found = (await db.execute<Row>(sql`select id from public.departments where organisation_id = ${org}::uuid and id = any(string_to_array(${[...departments].join(',')}, ',')::uuid[])`)).rows;
        if (found.length < departments.size) problems.push('A department named is not one of this organisation\'s');
      }
    });
    if (problems.length) throw new ApiError(409, 'workflow_rule', problems[0], { problems });
  }

  private async load(db: Db, ctx: RequestContext, id: string) {
    const r = (
      await db.execute<Row>(sql`select r.*, ${sql.raw(personName('p'))} as created_by_name from public.workflow_rules r left join public.profiles p on p.id = r.created_by
                                 where r.id = ${id}::uuid and r.organisation_id = ${orgOf(ctx)}::uuid`)
    ).rows[0];
    if (!r) throw ApiError.notFound('rule_not_found', 'Rule not found');
    const versions = (
      await db.execute<Row>(sql`select v.version, v.trigger, v.conditions, v.actions, v.reason, v.created_at, ${sql.raw(personName('p'))} as by
                                  from public.workflow_rule_versions v left join public.profiles p on p.id = v.created_by
                                 where v.rule_id = ${id}::uuid order by v.version desc`)
    ).rows;
    const runs = (
      await db.execute<Row>(sql`select w.id, w.event_type, w.status, w.results, w.facts ->> 'label' as label, w.facts ->> 'record_kind' as record_kind, w.facts ->> 'record_id' as record_id,
                                       w.created_at, v.version
                                  from public.workflow_runs w join public.workflow_rule_versions v on v.id = w.rule_version_id
                                 where w.rule_id = ${id}::uuid order by w.created_at desc limit 25`)
    ).rows;
    const current = versions[0];
    const ids = new Set<string>();
    for (const v of versions) for (const id of namedIds(v.conditions as Conditions, v.actions as Action[])) ids.add(id);
    const labels = await this.labels(db, ctx, [...ids]);
    return {
      id: r.id as string,
      reference: r.reference as string,
      name: r.name as string,
      description: (r.description as string) ?? null,
      status: r.status as string,
      statusReason: (r.status_reason as string) ?? null,
      version: Number(r.current_version),
      trigger: current.trigger as string,
      triggerLabel: triggerFor(current.trigger as string)?.label ?? (current.trigger as string),
      conditions: current.conditions as Conditions,
      actions: current.actions as Action[],
      createdBy: (r.created_by_name as string) ?? null,
      versions: versions.map((v) => ({
        version: Number(v.version),
        trigger: v.trigger as string,
        conditions: v.conditions as Conditions,
        actions: v.actions as Action[],
        reason: (v.reason as string) ?? null,
        by: (v.by as string) ?? null,
        at: new Date(v.created_at as string).toISOString(),
      })),
      runs: runs.map((w) => ({
        id: w.id as string,
        version: Number(w.version),
        status: w.status as string,
        results: w.results as Record<string, unknown>,
        record: { kind: w.record_kind as string, id: w.record_id as string, label: w.label as string, path: workflowRecordPath(w.record_kind, w.record_id) },
        at: new Date(w.created_at as string).toISOString(),
      })),
      labels,
    };
  }
}
