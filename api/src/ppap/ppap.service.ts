import { Injectable } from '@nestjs/common';
import { sql, SQL } from 'drizzle-orm';
import { iso, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import {
  AddFileBody, CreatePpapBody, CustomerRulesBody, ELEMENT_LABEL, ELEMENT_ORDINAL, PpapListQuery, SaveRequirementsBody, UpdateElementBody, UpdatePpapBody,
} from './ppap.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
const person = (id: unknown, name: unknown) => (id ? { id: id as string, name: (name as string) ?? 'Unknown' } : null);
const json = (v: unknown) => JSON.stringify(v);
const num = (v: unknown) => (v == null ? null : Number(v));

/**
 * The register's row: a submission with its part revision, customer, owner and how far the required elements have got. Names are read as the caller, so a part
 * or customer they may not read has no name (the screen says so) rather than hiding the submission.
 */
const PPAP_SELECT = sql`
  select s.*, p.part_number, p.name as part_name, pr.revision as rev_letter, pr.version as rev_version, pr.status as rev_status,
         c.name as customer_name, c.code as customer_code, st.name as site_name, ${sql.raw(personName('po'))} as owner_name,
         (select count(*)::int from public.ppap_elements e where e.submission_id = s.id and e.requirement = 'required') as required_count,
         (select count(*)::int from public.ppap_elements e where e.submission_id = s.id and e.requirement = 'required' and e.status in ('ready', 'waived')) as done_count
    from public.ppap_submissions s
    left join public.parts p on p.id = s.part_id
    left join public.part_revisions pr on pr.id = s.part_revision_id
    left join public.customers c on c.id = s.customer_id
    left join public.sites st on st.id = s.site_id
    left join public.profiles po on po.id = s.owner_user_id`;

const SORT: Record<PpapListQuery['sort'], string> = {
  reference: 'x.reference',
  part: 'lower(x.part_number)',
  customer: 'lower(x.customer_name)',
  level: 'x.level',
  status: 'x.status',
  owner: 'lower(x.owner_name)',
  progress: '(case when x.required_count = 0 then 1 else x.done_count::numeric / x.required_count end)',
  updatedAt: 'x.updated_at',
  createdAt: 'x.created_at',
};

const revisionLabel = (letter: unknown, version: unknown) => (letter ? `${letter as string}${Number(version) > 1 ? ` v${Number(version)}` : ''}` : null);

const toSummary = (r: Row) => ({
  id: r.id as string,
  reference: r.reference as string,
  direction: r.direction as 'submitted' | 'received',
  status: r.status as string,
  level: Number(r.level),
  reason: r.reason as string,
  notes: (r.notes as string) ?? null,
  part: { id: r.part_id as string, partNumber: (r.part_number as string) ?? null, name: (r.part_name as string) ?? null },
  partRevision: { id: r.part_revision_id as string, label: revisionLabel(r.rev_letter, r.rev_version), status: (r.rev_status as string) ?? null },
  customer: r.customer_id ? { id: r.customer_id as string, name: (r.customer_name as string) ?? null, code: (r.customer_code as string) ?? null } : null,
  site: r.site_id ? { id: r.site_id as string, name: (r.site_name as string) ?? null } : null,
  owner: person(r.owner_user_id, r.owner_name),
  requirementSetId: r.requirement_set_id as string,
  replacesId: (r.replaces_id as string) ?? null,
  /** How many elements are required, and how many of those are ready or waived. */
  progress: { required: Number(r.required_count ?? 0), done: Number(r.done_count ?? 0) },
  readyAt: r.ready_at ? iso(r.ready_at) : null,
  submittedAt: r.submitted_at ? iso(r.submitted_at) : null,
  withdrawReason: (r.withdraw_reason as string) ?? null,
  createdAt: iso(r.created_at) as string,
  updatedAt: iso(r.updated_at) as string,
});

const toEvidence = (r: Row) => ({
  id: r.id as string,
  kind: r.kind as 'file',
  fileName: r.file_name as string,
  storagePath: r.storage_path as string,
  contentType: (r.content_type as string) ?? null,
  sizeBytes: Number(r.size_bytes),
  description: (r.description as string) ?? null,
  addedBy: person(r.created_by, r.added_by_name),
  addedAt: iso(r.created_at) as string,
  removedAt: r.removed_at ? iso(r.removed_at) : null,
  removeReason: (r.remove_reason as string) ?? null,
});

const toRules = (r: Row) => ({
  customerId: r.customer_id as string,
  customerName: (r.customer_name as string) ?? null,
  customerCode: (r.customer_code as string) ?? null,
  defaultLevel: num(r.default_level),
  extraElements: (r.extra_elements as string[]) ?? [],
  minCpkInitial: num(r.min_cpk_initial),
  minCpkOngoing: num(r.min_cpk_ongoing),
  minReadings: num(r.min_readings),
  maxGrrPercent: num(r.max_grr_percent),
  note: (r.note as string) ?? null,
  updatedAt: iso(r.updated_at) as string,
});

/** PPAP (PP1): submissions with their 18 elements and file evidence, and the organisation's requirements. Every write is a database function; reading is by RLS. */
@Injectable()
export class PpapService {
  constructor(private readonly database: DatabaseService) {}

  // ---- the register ---------------------------------------------------------------------------------

  list(ctx: RequestContext, q: PpapListQuery) {
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`x.organisation_id = ${orgOf(ctx)}::uuid`];
      const statuses = (q.status ?? 'live').split(',');
      if (!statuses.includes('all')) {
        const named = statuses.filter((s) => s !== 'live');
        where.push(
          statuses.includes('live')
            ? sql`(x.status not in ('withdrawn', 'rejected') or x.status = any(string_to_array(${named.join(',')}, ',')))`
            : sql`x.status = any(string_to_array(${named.join(',')}, ','))`,
        );
      }
      if (q.direction) where.push(sql`x.direction = any(string_to_array(${q.direction}, ','))`);
      if (q.level) where.push(sql`x.level::text = any(string_to_array(${q.level}, ','))`);
      if (q.reason) where.push(sql`x.reason = any(string_to_array(${q.reason}, ','))`);
      if (q.owner === 'me') where.push(sql`x.owner_user_id = auth.uid()`);
      if (q.customerId) where.push(sql`x.customer_id = ${q.customerId}::uuid`);
      if (q.partId) where.push(sql`x.part_id = ${q.partId}::uuid`);
      if (q.q) {
        const p = likePattern(q.q);
        where.push(sql`(x.reference ilike ${p} escape '\\' or x.part_number ilike ${p} escape '\\' or x.part_name ilike ${p} escape '\\'
                        or x.customer_name ilike ${p} escape '\\' or x.owner_name ilike ${p} escape '\\')`);
      }
      const filter = sql.join(where, sql` and `);
      const total = (await db.execute<Row>(sql`select count(*)::int as n from (${PPAP_SELECT}) x where ${filter}`)).rows[0];
      const rows = (
        await db.execute<Row>(sql`
          select * from (${PPAP_SELECT}) x where ${filter}
           order by ${sql.raw(SORT[q.sort])} ${sql.raw(q.order === 'desc' ? 'desc nulls last' : 'asc nulls last')}, x.reference
           limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`)
      ).rows;
      return { data: rows.map(toSummary), page: q.page, pageSize: q.pageSize, total: Number(total.n) };
    });
  }

  // ---- one submission --------------------------------------------------------------------------------

  private async ppap(db: Db, ctx: RequestContext, id: string) {
    const org = orgOf(ctx);
    const found = (await db.execute<Row>(sql`select * from (${PPAP_SELECT}) x where x.id = ${id}::uuid and x.organisation_id = ${org}::uuid`)).rows[0];
    if (!found) throw ApiError.notFound('ppap_not_found', 'PPAP submission not found');
    const can = (
      await db.execute<Row>(sql`select app.has_permission(${org}::uuid, 'ppap.manage') as manage, app.has_permission(${org}::uuid, 'ppap.approve') as approve`)
    ).rows[0];
    const elementRows = (
      await db.execute<Row>(sql`
        select e.*, ${sql.raw(personName('pw'))} as waived_by_name from public.ppap_elements e left join public.profiles pw on pw.id = e.waived_by
         where e.submission_id = ${id}::uuid and e.organisation_id = ${org}::uuid`)
    ).rows;
    const evidenceRows = (
      await db.execute<Row>(sql`
        select v.*, ${sql.raw(personName('pc'))} as added_by_name from public.ppap_evidence v left join public.profiles pc on pc.id = v.created_by
         where v.submission_id = ${id}::uuid and v.organisation_id = ${org}::uuid order by v.created_at`)
    ).rows;
    const byElement = new Map<string, ReturnType<typeof toEvidence>[]>();
    for (const v of evidenceRows) {
      const list = byElement.get(v.element_id as string) ?? [];
      list.push(toEvidence(v));
      byElement.set(v.element_id as string, list);
    }
    const elements = elementRows
      .map((e) => {
        const evidence = byElement.get(e.id as string) ?? [];
        return {
          id: e.id as string,
          key: e.element_key as string,
          ordinal: ELEMENT_ORDINAL[e.element_key as string] ?? 99,
          label: ELEMENT_LABEL[e.element_key as string] ?? (e.element_key as string),
          requirement: e.requirement as 'required' | 'retain' | 'not_required' | 'n_a',
          requirementEdited: !!e.requirement_edited,
          status: e.status as 'not_started' | 'in_progress' | 'ready' | 'waived',
          note: (e.note as string) ?? null,
          waiver: e.waiver_reason ? { reason: e.waiver_reason as string, by: person(e.waived_by, e.waived_by_name), at: iso(e.waived_at) as string } : null,
          evidence,
          liveEvidence: evidence.filter((v) => !v.removedAt).length,
        };
      })
      .sort((a, b) => a.ordinal - b.ordinal);
    const problems = (await db.execute<Row>(sql`select app.ppap_problems(${id}::uuid) as p`)).rows[0].p as string[];
    const set = (
      await db.execute<Row>(sql`select id, version, config from public.ppap_requirement_sets where id = ${found.requirement_set_id as string}::uuid and organisation_id = ${org}::uuid`)
    ).rows[0];
    const status = found.status as string;
    const editing = ['draft', 'in_preparation'].includes(status);
    return {
      ...toSummary(found),
      elements,
      problems,
      requirementSet: set ? { id: set.id as string, version: Number(set.version), config: set.config } : null,
      /** Whether the elements and the wording can still change (draft or in preparation). */
      editable: Boolean(can.manage) && editing,
      canManage: Boolean(can.manage),
      canApprove: Boolean(can.approve),
      canMarkReady: Boolean(can.manage) && editing && problems.length === 0,
      canReopen: Boolean(can.manage) && status === 'ready',
      canWithdraw: Boolean(can.manage) && ['draft', 'in_preparation', 'ready'].includes(status),
    };
  }

  get(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, (db) => this.ppap(db, ctx, id));
  }

  create(ctx: RequestContext, body: CreatePpapBody) {
    return this.database.asUser(ctx, async (db) => {
      const made = (await db.execute<Row>(sql`select app.create_ppap(${orgOf(ctx)}::uuid, ${json(body)}::jsonb) as r`)).rows[0].r as { id: string; created: boolean };
      return { ...(await this.ppap(db, ctx, made.id)), created: made.created };
    });
  }

  update(ctx: RequestContext, id: string, body: UpdatePpapBody) {
    return this.command(ctx, id, sql`select app.update_ppap(${id}::uuid, ${json(body)}::jsonb)`);
  }

  setLevel(ctx: RequestContext, id: string, level: number) {
    return this.command(ctx, id, sql`select app.set_ppap_level(${id}::uuid, ${level})`);
  }

  markReady(ctx: RequestContext, id: string) {
    return this.command(ctx, id, sql`select app.mark_ppap_ready(${id}::uuid)`);
  }

  reopen(ctx: RequestContext, id: string) {
    return this.command(ctx, id, sql`select app.reopen_ppap(${id}::uuid)`);
  }

  withdraw(ctx: RequestContext, id: string, reason: string) {
    return this.command(ctx, id, sql`select app.withdraw_ppap(${id}::uuid, ${reason})`);
  }

  private command(ctx: RequestContext, id: string, statement: SQL) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(statement);
      return this.ppap(db, ctx, id);
    });
  }

  // ---- elements and evidence -------------------------------------------------------------------------

  /** Runs a command on an element and answers with the whole submission it belongs to. */
  private elementCommand(ctx: RequestContext, elementId: string, statement: SQL) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(statement);
      const e = (await db.execute<Row>(sql`select submission_id from public.ppap_elements where id = ${elementId}::uuid`)).rows[0];
      if (!e) throw ApiError.notFound('ppap_not_found', 'PPAP element not found');
      return this.ppap(db, ctx, e.submission_id as string);
    });
  }

  updateElement(ctx: RequestContext, id: string, body: UpdateElementBody) {
    return this.elementCommand(ctx, id, sql`select app.set_ppap_element(${id}::uuid, ${json(body)}::jsonb)`);
  }

  addFile(ctx: RequestContext, id: string, body: AddFileBody) {
    return this.elementCommand(
      ctx,
      id,
      sql`select app.add_ppap_file(${id}::uuid, ${body.storagePath}, ${body.fileName}, ${body.contentType ?? null}, ${body.sizeBytes}, ${body.description ?? null})`,
    );
  }

  waive(ctx: RequestContext, id: string, reason: string) {
    return this.elementCommand(ctx, id, sql`select app.waive_ppap_element(${id}::uuid, ${reason})`);
  }

  unwaive(ctx: RequestContext, id: string) {
    return this.elementCommand(ctx, id, sql`select app.unwaive_ppap_element(${id}::uuid)`);
  }

  removeEvidence(ctx: RequestContext, id: string, reason: string) {
    return this.database.asUser(ctx, async (db) => {
      const v = (await db.execute<Row>(sql`select submission_id from public.ppap_evidence where id = ${id}::uuid`)).rows[0];
      await db.execute(sql`select app.remove_ppap_evidence(${id}::uuid, ${reason})`);
      if (!v) throw ApiError.notFound('ppap_not_found', 'Evidence not found');
      return this.ppap(db, ctx, v.submission_id as string);
    });
  }

  // ---- the requirements ------------------------------------------------------------------------------

  async requirements(ctx: RequestContext) {
    return this.database.asUser(ctx, (db) => this.requirementsOf(db, ctx));
  }

  private async requirementsOf(db: Db, ctx: RequestContext) {
    const org = orgOf(ctx);
    const rows = (
      await db.execute<Row>(sql`
        select r.*, ${sql.raw(personName('pc'))} as by_name from public.ppap_requirement_sets r left join public.profiles pc on pc.id = r.created_by
         where r.organisation_id = ${org}::uuid order by r.version desc`)
    ).rows;
    const can = (await db.execute<Row>(sql`select app.has_permission(${org}::uuid, 'ppap.approve') as approve`)).rows[0];
    const current = rows.find((r) => r.current);
    return {
      current: current ? { id: current.id as string, version: Number(current.version), config: current.config, reason: (current.reason as string) ?? null } : null,
      versions: rows.map((r) => ({
        id: r.id as string,
        version: Number(r.version),
        current: !!r.current,
        reason: (r.reason as string) ?? null,
        by: person(r.created_by, r.by_name),
        at: iso(r.created_at) as string,
      })),
      canChange: Boolean(can.approve),
    };
  }

  saveRequirements(ctx: RequestContext, body: SaveRequirementsBody) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.save_ppap_requirement_set(${orgOf(ctx)}::uuid, ${json(body.config)}::jsonb, ${body.reason})`);
      return this.requirementsOf(db, ctx);
    });
  }

  // ---- customer rules --------------------------------------------------------------------------------

  private async rulesOf(db: Db, ctx: RequestContext) {
    const org = orgOf(ctx);
    const rows = (
      await db.execute<Row>(sql`
        select r.*, c.name as customer_name, c.code as customer_code from public.ppap_customer_rules r left join public.customers c on c.id = r.customer_id
         where r.organisation_id = ${org}::uuid order by lower(c.name)`)
    ).rows;
    const can = (await db.execute<Row>(sql`select app.has_permission(${org}::uuid, 'ppap.approve') as approve`)).rows[0];
    return { data: rows.map(toRules), canChange: Boolean(can.approve) };
  }

  customerRules(ctx: RequestContext) {
    return this.database.asUser(ctx, (db) => this.rulesOf(db, ctx));
  }

  setCustomerRules(ctx: RequestContext, customerId: string, body: CustomerRulesBody) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.set_ppap_customer_rules(${customerId}::uuid, ${json(body)}::jsonb)`);
      return this.rulesOf(db, ctx);
    });
  }
}
