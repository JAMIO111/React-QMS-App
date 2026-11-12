import { Injectable } from '@nestjs/common';
import { sql, SQL } from 'drizzle-orm';
import { assignments, iso, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import {
  AllQuery, AssessBody, CloseBody, CreateActionBody, CreateCategoryBody, CreateRiskBody, DecideBody, DraftQuery, LinkedQuery, LinkItem, ModelConfig, ReviewBody, RiskCategory,
  RiskListQuery, SaveModelBody, ScoreQuery, TreatmentBody, UpdateActionBody, UpdateCategoryBody, UpdateRiskBody,
} from './risk.schemas';

const LINK_COLUMN: Record<string, string> = {
  ncr: 'ncr_id', capa: 'capa_id', audit_finding: 'audit_finding_id', supplier: 'supplier_id', part: 'part_id', part_family: 'part_family_id', machine: 'machine_id', document: 'document_id',
};

/**
 * The records named by links, each read under the caller's own rules (RLS of that record's table), so a record they may not read has no label.
 * `src` is a query giving `kind`, `target_id`, `operation_code` (plus anything else to pass through).
 */
const labelled = (src: SQL) => sql`
  select x.*,
         coalesce(n.reference, c.reference, f.reference, s.code, p.part_number, pf.code, m.code, d.number) as t_reference,
         coalesce(n.title, c.title, f.title, s.name, p.name, pf.name, m.name, d.title) as t_name
    from (${src}) x
    left join public.nonconformances n on x.kind = 'ncr' and n.id = x.target_id
    left join public.capas c on x.kind = 'capa' and c.id = x.target_id
    left join public.audit_findings f on x.kind = 'audit_finding' and f.id = x.target_id
    left join public.suppliers s on x.kind = 'supplier' and s.id = x.target_id
    left join public.parts p on x.kind = 'part' and p.id = x.target_id
    left join public.part_families pf on x.kind = 'part_family' and pf.id = x.target_id
    left join public.machines m on x.kind = 'machine' and m.id = x.target_id
    left join public.documents d on x.kind = 'document' and d.id = x.target_id`;

const toLink = (r: Row) => ({
  kind: r.kind as string,
  /** The record's id (null for an operation code). */
  id: (r.target_id as string) ?? null,
  code: (r.operation_code as string) ?? null,
  /** Number and name; null when the caller may not read the record. */
  reference: r.kind === 'operation_code' ? (r.operation_code as string) : ((r.t_reference as string) ?? null),
  name: (r.t_name as string) ?? null,
  readable: r.kind === 'operation_code' || r.t_reference != null,
});
const TARGET = sql.raw(`coalesce(${Object.values(LINK_COLUMN).map((c) => `l.${c}`).join(', ')})`);
const linkJson = (links: LinkItem[]) => JSON.stringify(links);

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
const person = (id: unknown, name: unknown) => (id ? { id: id as string, name: (name as string) ?? 'Unknown' } : null);
const json = (v: unknown) => JSON.stringify(v);
const CATEGORY_COLUMNS: Record<string, string> = { label: 'label', description: 'description', sequence: 'sequence', active: 'active' };

const toCategory = (r: Row): RiskCategory => ({
  id: r.id as string,
  key: r.key as string,
  label: r.label as string,
  description: (r.description as string) ?? null,
  sequence: Number(r.sequence),
  active: !!r.active,
  risks: Number(r.risk_count ?? 0),
});

const toModel = (r: Row) => ({
  id: r.id as string,
  version: Number(r.version),
  config: r.config as ModelConfig,
  reason: (r.reason as string) ?? null,
  current: !!r.current,
  createdBy: (r.created_by_name as string) ?? null,
  createdAt: iso(r.created_at) as string,
});

/** A risk with its category, owner, where it sits and its current assessment before treatment. */
const RISK_SELECT = sql`
  select r.*, c.label as category_label, s.name as site_name, d.name as department_name, ${sql.raw(personName('po'))} as owner_name,
         a.id as a_id, a.likelihood as a_likelihood, a.consequence as a_consequence, a.score as a_score, a.band as a_band, a.assessed_on::text as a_assessed_on,
         a.model_version as a_model_version,
         b.id as b_id, b.likelihood as b_likelihood, b.consequence as b_consequence, b.score as b_score, b.band as b_band, b.assessed_on::text as b_assessed_on,
         b.model_version as b_model_version, coalesce(b.band, a.band) as e_band, coalesce(b.score, a.score) as e_score,
         r.next_review_on::text as next_review, (r.next_review_on < current_date and r.status in ('open', 'treating', 'monitoring')) as review_overdue,
         (select count(*)::int from public.risk_actions x where x.risk_id = r.id and x.status = 'open') as open_actions,
         ${sql.raw(personName('pcl'))} as closed_by_name
    from public.risks r
    join public.risk_categories c on c.id = r.category_id
    left join public.sites s on s.id = r.site_id
    left join public.departments d on d.id = r.department_id
    left join public.profiles po on po.id = r.owner_user_id
    left join public.profiles pcl on pcl.id = r.closed_by
    left join public.risk_assessments a on a.risk_id = r.id and a.phase = 'inherent' and a.status = 'current'
    left join public.risk_assessments b on b.risk_id = r.id and b.phase = 'residual' and b.status = 'current'`;

const SORT: Record<RiskListQuery['sort'], string> = {
  reference: 'r.reference',
  title: 'lower(r.title)',
  category: 'lower(r.category_label)',
  owner: 'lower(r.owner_name)',
  status: 'r.status',
  score: 'r.a_score',
  residual: 'r.b_score',
  nextReview: 'r.next_review_on',
  assessedOn: 'r.a_assessed_on',
  createdAt: 'r.created_at',
};

const current = (r: Row, p: 'a' | 'b') =>
  r[`${p}_id`]
    ? {
        id: r[`${p}_id`] as string,
        likelihood: Number(r[`${p}_likelihood`]),
        consequence: Number(r[`${p}_consequence`]),
        score: Number(r[`${p}_score`]),
        band: r[`${p}_band`] as string,
        assessedOn: r[`${p}_assessed_on`] as string,
        modelVersion: Number(r[`${p}_model_version`]),
      }
    : null;

const toRisk = (r: Row) => ({
  id: r.id as string,
  reference: r.reference as string,
  kind: r.kind as 'risk' | 'opportunity',
  title: r.title as string,
  category: { id: r.category_id as string, label: r.category_label as string },
  description: (r.description as string) ?? null,
  cause: (r.cause as string) ?? null,
  effect: (r.effect as string) ?? null,
  owner: person(r.owner_user_id, r.owner_name),
  site: r.site_id ? { id: r.site_id as string, name: (r.site_name as string) ?? 'Unknown' } : null,
  department: r.department_id ? { id: r.department_id as string, name: (r.department_name as string) ?? 'Unknown' } : null,
  status: r.status as string,
  /** The current assessment before treatment (null until it is assessed). */
  inherent: current(r, 'a'),
  /** What is left after treatment (null until that is assessed). */
  residual: current(r, 'b'),
  /** The band in force: the residual one when there is one, else the inherent one. */
  band: (r.e_band as string) ?? null,
  strategy: (r.strategy as string) ?? null,
  treatmentPlan: (r.treatment_plan as string) ?? null,
  openActions: Number(r.open_actions ?? 0),
  nextReviewOn: (r.next_review as string) ?? null,
  /** Worked out on read: the review date has passed and the risk is still live. */
  reviewOverdue: Boolean(r.review_overdue),
  outcome: (r.outcome as string) ?? null,
  closeNote: (r.close_note as string) ?? null,
  closedAt: r.closed_at ? (iso(r.closed_at) as string) : null,
  closedBy: (r.closed_by_name as string) ?? null,
  reopenReason: (r.reopen_reason as string) ?? null,
  retiredReason: (r.retired_reason as string) ?? null,
  retiredAt: r.retired_at ? (iso(r.retired_at) as string) : null,
  createdAt: iso(r.created_at) as string,
  updatedAt: iso(r.updated_at) as string,
});

/** Risk register (RK1, RK2): the scoring matrix, categories, risks, their assessments, treatment, actions, acceptance, reviews and closing. Every write to a risk is a database function; reading is by RLS. */
@Injectable()
export class RiskService {
  constructor(private readonly database: DatabaseService) {}

  // ---- the matrix ----------------------------------------------------------------------------------

  private async modelIn(db: Db, ctx: RequestContext) {
    const org = orgOf(ctx);
    const rows = (
      await db.execute<Row>(sql`
        select m.*, ${sql.raw(personName('pc'))} as created_by_name
          from public.risk_models m left join public.profiles pc on pc.id = m.created_by
         where m.organisation_id = ${org}::uuid order by m.version desc`)
    ).rows.map(toModel);
    const current = rows.find((m) => m.current);
    if (!current) throw ApiError.notFound('risk_model_not_found', 'This organisation has no risk matrix');
    const can = (await db.execute<Row>(sql`select app.has_permission(${org}::uuid, 'risk.approve') as approve`)).rows[0];
    return { ...current, versions: rows.map(({ config: _c, ...v }) => v), canChange: Boolean(can.approve) };
  }

  model(ctx: RequestContext) {
    return this.database.asUser(ctx, (db) => this.modelIn(db, ctx));
  }

  saveModel(ctx: RequestContext, body: SaveModelBody) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.save_risk_model(${orgOf(ctx)}::uuid, ${json(body.config)}::jsonb, ${body.reason})`);
      return this.modelIn(db, ctx);
    });
  }

  /** What a likelihood and a consequence come to on the current matrix (nothing is saved). */
  score(ctx: RequestContext, q: ScoreQuery) {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ s: Record<string, unknown> }>(sql`select app.score_risk(${orgOf(ctx)}::uuid, ${q.likelihood}::int, ${q.consequence}::int) as s`);
      const s = res.rows[0].s;
      return { likelihood: q.likelihood, consequence: q.consequence, score: Number(s.score), band: s.band as string, acceptable: Boolean(s.acceptable), likelihoodLabel: s.likelihood as string, consequenceLabel: s.consequence as string, modelVersion: Number(s.modelVersion) };
    });
  }

  // ---- categories ----------------------------------------------------------------------------------

  categories(ctx: RequestContext, q: AllQuery): Promise<{ data: RiskCategory[] }> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<Row>(sql`
        select c.*, (select count(*)::int from public.risks r where r.category_id = c.id) as risk_count
          from public.risk_categories c
         where c.organisation_id = ${orgOf(ctx)}::uuid ${q.all === 'true' ? sql`` : sql`and c.active`}
         order by c.sequence, lower(c.label)`);
      return { data: res.rows.map(toCategory) };
    });
  }

  createCategory(ctx: RequestContext, body: CreateCategoryBody): Promise<RiskCategory> {
    return this.database.asUser(ctx, async (db) => {
      // The key is made from the label and kept: renaming later never changes it.
      const base = body.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 36) || 'category';
      const start = /^[a-z]/.test(base) && base.length >= 2 ? base : `c_${base}`;
      let key = start;
      for (let i = 2; ; i++) {
        const taken = await db.execute(sql`select 1 from public.risk_categories where organisation_id = ${orgOf(ctx)}::uuid and key = ${key}`);
        if (taken.rows.length === 0) break;
        key = `${start.slice(0, 34)}_${i}`;
      }
      const res = await db.execute<Row>(sql`
        insert into public.risk_categories (organisation_id, key, label, description, sequence)
        values (${orgOf(ctx)}::uuid, ${key}, ${body.label}, ${body.description ?? null},
                ${body.sequence ?? sql`(select coalesce(max(sequence), 0) + 1 from public.risk_categories where organisation_id = ${orgOf(ctx)}::uuid)`})
        returning *, 0 as risk_count`);
      return toCategory(res.rows[0]);
    });
  }

  updateCategory(ctx: RequestContext, id: string, body: UpdateCategoryBody): Promise<RiskCategory> {
    return this.database.asUser(ctx, async (db) => {
      const sets = assignments(body, CATEGORY_COLUMNS);
      const res = await db.execute<Row>(sql`
        update public.risk_categories set ${sql.join(sets, sql`, `)} where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid
        returning *, (select count(*)::int from public.risks r where r.category_id = public.risk_categories.id) as risk_count`);
      if (res.rows.length === 0) throw ApiError.notFound('risk_category_not_found', 'Category not found');
      return toCategory(res.rows[0]);
    });
  }

  // ---- risks ---------------------------------------------------------------------------------------

  list(ctx: RequestContext, q: RiskListQuery) {
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`r.organisation_id = ${orgOf(ctx)}::uuid`];
      const statuses = (q.status ?? 'live').split(',');
      if (!statuses.includes('all')) {
        const named = statuses.filter((s) => s !== 'live');
        where.push(
          statuses.includes('live')
            ? sql`(r.status <> 'retired' or r.status = any(string_to_array(${named.join(',')}, ',')))`
            : sql`r.status = any(string_to_array(${named.join(',')}, ','))`,
        );
      }
      if (q.kind) where.push(sql`r.kind = ${q.kind}`);
      if (q.categoryId) where.push(sql`r.category_id = ${q.categoryId}::uuid`);
      if (q.owner === 'me') where.push(sql`r.owner_user_id = auth.uid()`);
      if (q.band) {
        const bands = q.band.split(',');
        where.push(sql`(r.e_band = any(string_to_array(${bands.filter((b) => b !== 'unassessed').join(',')}, ',')) ${bands.includes('unassessed') ? sql`or r.a_id is null` : sql``})`);
      }
      if (q.strategy) {
        const chosen = q.strategy.split(',');
        where.push(sql`(r.strategy = any(string_to_array(${chosen.filter((x) => x !== 'none').join(',')}, ',')) ${chosen.includes('none') ? sql`or r.strategy is null` : sql``})`);
      }
      if (q.reviewOverdue) where.push(sql`r.review_overdue`);
      if (q.q) {
        const p = likePattern(q.q);
        where.push(sql`(r.reference ilike ${p} escape '\\' or r.title ilike ${p} escape '\\' or r.description ilike ${p} escape '\\' or r.cause ilike ${p} escape '\\'
                        or r.effect ilike ${p} escape '\\' or r.owner_name ilike ${p} escape '\\' or r.category_label ilike ${p} escape '\\')`);
      }
      const filter = sql.join(where, sql` and `);
      const total = (await db.execute<Row>(sql`select count(*)::int as n from (${RISK_SELECT}) r where ${filter}`)).rows[0];
      const rows = (
        await db.execute<Row>(sql`
          select * from (${RISK_SELECT}) r where ${filter}
           order by ${sql.raw(SORT[q.sort])} ${sql.raw(q.order === 'desc' ? 'desc nulls last' : 'asc nulls last')}, r.reference
           limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`)
      ).rows;
      return { data: rows.map(toRisk), page: q.page, pageSize: q.pageSize, total: Number(total.n) };
    });
  }

  private async risk(db: Db, ctx: RequestContext, id: string) {
    const org = orgOf(ctx);
    const rows = (await db.execute<Row>(sql`select * from (${RISK_SELECT}) r where r.id = ${id}::uuid and r.organisation_id = ${org}::uuid`)).rows;
    if (rows.length === 0) throw ApiError.notFound('risk_not_found', 'Risk not found');
    const assessments = (
      await db.execute<Row>(sql`
        select a.id, a.phase, a.likelihood, a.consequence, a.score, a.band, a.rationale, a.assessed_on::text as assessed_on, a.status, a.model_version, a.created_at,
               m.config -> 'likelihood' -> (a.likelihood - 1) ->> 'label' as likelihood_label, m.config -> 'consequence' -> (a.consequence - 1) ->> 'label' as consequence_label,
               ${sql.raw(personName('pa'))} as by_name
          from public.risk_assessments a join public.risk_models m on m.id = a.model_id left join public.profiles pa on pa.id = a.assessed_by
         where a.risk_id = ${id}::uuid and a.organisation_id = ${org}::uuid
         order by a.created_at desc, a.id`)
    ).rows.map((a) => ({
      id: a.id as string,
      phase: a.phase as 'inherent' | 'residual',
      likelihood: Number(a.likelihood),
      consequence: Number(a.consequence),
      likelihoodLabel: (a.likelihood_label as string) ?? null,
      consequenceLabel: (a.consequence_label as string) ?? null,
      score: Number(a.score),
      band: a.band as string,
      rationale: a.rationale as string,
      assessedOn: a.assessed_on as string,
      assessedBy: (a.by_name as string) ?? null,
      current: a.status === 'current',
      modelVersion: Number(a.model_version),
      createdAt: iso(a.created_at) as string,
    }));
    const can = (
      await db.execute<Row>(sql`
        select app.has_permission(${org}::uuid, 'risk.manage') as manage, app.has_permission(${org}::uuid, 'risk.approve') as approve, auth.uid() as me,
               app.risk_treatment_problems(${id}::uuid) as problems, app.risk_acceptance_state(${id}::uuid) as acceptance`)
    ).rows[0];
    const base = toRisk(rows[0]);
    const manage = Boolean(can.manage);
    const live = !['closed', 'retired'].includes(base.status);
    const actions = (
      await db.execute<Row>(sql`
        select x.*, x.due_date::text as due, ${sql.raw(personName('po'))} as owner_name, ${sql.raw(personName('pd'))} as done_by_name, ${sql.raw(personName('pc'))} as cancelled_by_name
          from public.risk_actions x
          left join public.profiles po on po.id = x.owner_user_id left join public.profiles pd on pd.id = x.done_by left join public.profiles pc on pc.id = x.cancelled_by
         where x.risk_id = ${id}::uuid and x.organisation_id = ${org}::uuid
         order by (x.status = 'open') desc, x.due_date nulls last, x.created_at, x.id`)
    ).rows.map((x) => ({
      id: x.id as string,
      description: x.description as string,
      owner: person(x.owner_user_id, x.owner_name),
      dueDate: (x.due as string) ?? null,
      status: x.status as 'open' | 'done' | 'cancelled',
      doneNote: (x.done_note as string) ?? null,
      doneAt: x.done_at ? (iso(x.done_at) as string) : null,
      doneBy: (x.done_by_name as string) ?? null,
      cancelReason: (x.cancel_reason as string) ?? null,
      cancelledAt: x.cancelled_at ? (iso(x.cancelled_at) as string) : null,
      cancelledBy: (x.cancelled_by_name as string) ?? null,
      /** The caller is the person it was given to (they may close it without managing risks). */
      mine: x.owner_user_id === can.me,
      createdAt: iso(x.created_at) as string,
    }));
    const reviews = (
      await db.execute<Row>(sql`
        select v.id, v.outcome, v.note, v.was_due_on::text as was_due_on, v.next_review_on::text as next_review_on, v.reviewed_on::text as reviewed_on, v.created_at,
               ${sql.raw(personName('pv'))} as by_name
          from public.risk_reviews v left join public.profiles pv on pv.id = v.reviewed_by
         where v.risk_id = ${id}::uuid and v.organisation_id = ${org}::uuid order by v.created_at desc, v.id`)
    ).rows.map((v) => ({
      id: v.id as string,
      outcome: v.outcome as 'no_change' | 'reassessed',
      note: v.note as string,
      wasDueOn: (v.was_due_on as string) ?? null,
      nextReviewOn: (v.next_review_on as string) ?? null,
      reviewedOn: v.reviewed_on as string,
      reviewedBy: (v.by_name as string) ?? null,
    }));
    const acceptances = (
      await db.execute<Row>(sql`
        select x.*, ${sql.raw(personName('pp'))} as proposed_by_name, ${sql.raw(personName('pd'))} as decided_by_name
          from public.risk_acceptances x left join public.profiles pp on pp.id = x.proposed_by left join public.profiles pd on pd.id = x.decided_by
         where x.risk_id = ${id}::uuid and x.organisation_id = ${org}::uuid order by x.created_at desc, x.id`)
    ).rows.map((x) => ({
      id: x.id as string,
      status: x.status as 'proposed' | 'approved' | 'rejected' | 'withdrawn',
      band: x.band as string,
      rationale: x.rationale as string,
      proposedBy: (x.proposed_by_name as string) ?? null,
      proposedAt: iso(x.created_at) as string,
      decidedBy: (x.decided_by_name as string) ?? null,
      decidedAt: x.decided_at ? (iso(x.decided_at) as string) : null,
      decisionNote: (x.decision_note as string) ?? null,
      /** It covers the assessment in force (an approved one for an earlier assessment no longer counts). */
      inForce: x.assessment_id === (can.acceptance as Record<string, unknown>).assessmentId,
      /** An approver other than the person who proposed it. */
      canDecide: x.status === 'proposed' && Boolean(can.approve) && x.proposed_by !== can.me,
      canWithdraw: x.status === 'proposed' && (Boolean(can.approve) || (manage && x.proposed_by === can.me)),
    }));
    const acceptance = can.acceptance as Record<string, unknown>;
    const links = (
      await db.execute<Row>(
        labelled(sql`select l.kind, ${TARGET} as target_id, l.operation_code, l.created_at from public.risk_links l
                      where l.risk_id = ${id}::uuid and l.organisation_id = ${org}::uuid`),
      )
    ).rows
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.kind).localeCompare(String(b.kind)))
      .map(toLink);
    const originRow = rows[0];
    const origin = originRow.origin_kind ? links.find((l) => l.kind === originRow.origin_kind && l.id === originRow.origin_id) ?? { kind: originRow.origin_kind as string, id: originRow.origin_id as string, code: null, reference: null, name: null, readable: false } : null;
    return {
      ...base,
      links,
      /** The record it was raised from (always one of its links), or null. */
      origin,
      assessments,
      actions,
      reviews,
      acceptances,
      /** What still stands between this risk and "monitoring" (empty once closed or retired). */
      problems: live ? ((can.problems as string[]) ?? []) : [],
      acceptance: {
        acceptanceBand: (acceptance.acceptanceBand as string) ?? null,
        /** The band in force is above the level the organisation accepts. */
        above: Boolean(acceptance.above),
        accepted: Boolean(acceptance.accepted),
        waiting: Boolean(acceptance.waiting),
      },
      canManage: manage,
      canApprove: Boolean(can.approve),
      canEdit: manage && live,
    };
  }

  get(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, (db) => this.risk(db, ctx, id));
  }

  create(ctx: RequestContext, body: CreateRiskBody) {
    const { raisedFrom, links, ...fields } = body;
    return this.database.asUser(ctx, async (db) => {
      let id: string;
      if (raisedFrom) {
        id = (await db.execute<{ id: string }>(sql`select app.raise_risk_from(${raisedFrom.kind}, ${raisedFrom.id}::uuid, ${json(fields)}::jsonb, ${linkJson(links ?? [])}::jsonb) as id`)).rows[0].id;
      } else {
        id = (await db.execute<{ id: string }>(sql`select app.create_risk(${orgOf(ctx)}::uuid, ${json(fields)}::jsonb) as id`)).rows[0].id;
        if (links?.length) await db.execute(sql`select app.set_risk_links(${id}::uuid, ${linkJson(links)}::jsonb)`);
      }
      return this.risk(db, ctx, id);
    });
  }

  // ---- links and raising from a record (RK3) -----------------------------------------------------------

  setLinks(ctx: RequestContext, id: string, links: LinkItem[]) {
    return this.onRisk(ctx, id, (db) => db.execute(sql`select app.set_risk_links(${id}::uuid, ${linkJson(links)}::jsonb)`));
  }

  /** What a risk raised from a non-conformance, an 8D or an audit finding would start with (nothing is saved). */
  draft(ctx: RequestContext, q: DraftQuery) {
    return this.database.asUser(ctx, async (db) => {
      const d = (await db.execute<{ d: Record<string, unknown> }>(sql`select app.risk_draft_from(${q.kind}, ${q.id}::uuid) as d`)).rows[0].d;
      const items = (d.links as { kind: string; id?: string; code?: string }[]) ?? [];
      const rows = items.length
        ? (
            await db.execute<Row>(
              labelled(sql`select (e ->> 'kind') as kind, nullif(e ->> 'id', '')::uuid as target_id, (e ->> 'code') as operation_code, o as position
                             from jsonb_array_elements(${JSON.stringify(items)}::jsonb) with ordinality t(e, o)`),
            )
          ).rows.sort((a, b) => Number(a.position) - Number(b.position))
        : [];
      return {
        kind: d.kind as string,
        categoryId: (d.categoryId as string) ?? null,
        title: (d.title as string) ?? '',
        description: (d.description as string) ?? null,
        cause: (d.cause as string) ?? null,
        effect: (d.effect as string) ?? null,
        source: d.source as { kind: string; id: string; reference: string; title: string },
        links: rows.map(toLink),
      };
    });
  }

  /** Risks linked to one record (for its page): the register rows, live ones first. */
  linked(ctx: RequestContext, q: LinkedQuery) {
    return this.database.asUser(ctx, async (db) => {
      const col = sql.raw(LINK_COLUMN[q.kind]);
      const rows = (
        await db.execute<Row>(sql`
          select * from (${RISK_SELECT}) r
           where r.organisation_id = ${orgOf(ctx)}::uuid and r.status <> 'retired'
             and exists (select 1 from public.risk_links l where l.risk_id = r.id and l.kind = ${q.kind} and l.${col} = ${q.id}::uuid)
           order by (r.status = 'closed'), r.e_score desc nulls last, r.reference`)
      ).rows;
      const can = (await db.execute<Row>(sql`select app.has_permission(${orgOf(ctx)}::uuid, 'risk.manage') as manage`)).rows[0];
      return { data: rows.map(toRisk), canRaise: Boolean(can.manage) };
    });
  }

  private onRisk(ctx: RequestContext, id: string, run: (db: Db) => Promise<unknown>) {
    return this.database.asUser(ctx, async (db) => {
      await this.risk(db, ctx, id);
      await run(db);
      return this.risk(db, ctx, id);
    });
  }

  update(ctx: RequestContext, id: string, body: UpdateRiskBody) {
    return this.onRisk(ctx, id, (db) => db.execute(sql`select app.update_risk(${id}::uuid, ${json(body)}::jsonb)`));
  }

  assess(ctx: RequestContext, id: string, body: AssessBody) {
    return this.onRisk(ctx, id, (db) =>
      db.execute(sql`select app.assess_risk(${id}::uuid, ${body.likelihood}::int, ${body.consequence}::int, ${body.rationale}, ${body.phase ?? 'inherent'})`),
    );
  }

  // ---- treatment, actions, acceptance, reviews, closing (RK2) ----------------------------------------

  setTreatment(ctx: RequestContext, id: string, body: TreatmentBody) {
    return this.onRisk(ctx, id, (db) => db.execute(sql`select app.set_risk_treatment(${id}::uuid, ${body.strategy}, ${body.plan ?? null})`));
  }

  addAction(ctx: RequestContext, id: string, body: CreateActionBody) {
    return this.onRisk(ctx, id, (db) => db.execute(sql`select app.add_risk_action(${id}::uuid, ${json(body)}::jsonb)`));
  }

  /** A command on an action or an acceptance: found under RLS (404 otherwise), run, and answered with the whole risk. */
  private onChild(ctx: RequestContext, table: 'risk_actions' | 'risk_acceptances', id: string, run: (db: Db) => Promise<unknown>) {
    return this.database.asUser(ctx, async (db) => {
      const found = (await db.execute<Row>(sql`select risk_id from public.${sql.raw(table)} where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`)).rows;
      if (found.length === 0) throw ApiError.notFound(table === 'risk_actions' ? 'risk_action_not_found' : 'risk_acceptance_not_found', table === 'risk_actions' ? 'Action not found' : 'Acceptance not found');
      await run(db);
      return this.risk(db, ctx, found[0].risk_id as string);
    });
  }

  updateAction(ctx: RequestContext, id: string, body: UpdateActionBody) {
    return this.onChild(ctx, 'risk_actions', id, (db) => db.execute(sql`select app.update_risk_action(${id}::uuid, ${json(body)}::jsonb)`));
  }

  completeAction(ctx: RequestContext, id: string, note: string) {
    return this.onChild(ctx, 'risk_actions', id, (db) => db.execute(sql`select app.complete_risk_action(${id}::uuid, ${note})`));
  }

  cancelAction(ctx: RequestContext, id: string, reason: string) {
    return this.onChild(ctx, 'risk_actions', id, (db) => db.execute(sql`select app.cancel_risk_action(${id}::uuid, ${reason})`));
  }

  reopenAction(ctx: RequestContext, id: string) {
    return this.onChild(ctx, 'risk_actions', id, (db) => db.execute(sql`select app.reopen_risk_action(${id}::uuid)`));
  }

  proposeAcceptance(ctx: RequestContext, id: string, rationale: string) {
    return this.onRisk(ctx, id, (db) => db.execute(sql`select app.propose_risk_acceptance(${id}::uuid, ${rationale})`));
  }

  decideAcceptance(ctx: RequestContext, id: string, body: DecideBody) {
    return this.onChild(ctx, 'risk_acceptances', id, (db) => db.execute(sql`select app.decide_risk_acceptance(${id}::uuid, ${body.approve}, ${body.note})`));
  }

  withdrawAcceptance(ctx: RequestContext, id: string, reason: string) {
    return this.onChild(ctx, 'risk_acceptances', id, (db) => db.execute(sql`select app.withdraw_risk_acceptance(${id}::uuid, ${reason})`));
  }

  review(ctx: RequestContext, id: string, body: ReviewBody) {
    return this.onRisk(ctx, id, (db) => db.execute(sql`select app.record_risk_review(${id}::uuid, ${body.note}, ${body.nextReviewOn ?? null}::date)`));
  }

  close(ctx: RequestContext, id: string, body: CloseBody) {
    return this.onRisk(ctx, id, (db) => db.execute(sql`select app.close_risk(${id}::uuid, ${body.outcome}, ${body.note})`));
  }

  reopen(ctx: RequestContext, id: string, reason: string) {
    return this.onRisk(ctx, id, (db) => db.execute(sql`select app.reopen_risk(${id}::uuid, ${reason})`));
  }

  retire(ctx: RequestContext, id: string, reason: string) {
    return this.onRisk(ctx, id, (db) => db.execute(sql`select app.retire_risk(${id}::uuid, ${reason})`));
  }

  reactivate(ctx: RequestContext, id: string) {
    return this.onRisk(ctx, id, (db) => db.execute(sql`select app.reactivate_risk(${id}::uuid)`));
  }
}
