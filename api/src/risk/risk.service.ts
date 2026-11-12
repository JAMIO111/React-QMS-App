import { Injectable } from '@nestjs/common';
import { sql, SQL } from 'drizzle-orm';
import { assignments, iso, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import {
  AllQuery, AssessBody, CreateCategoryBody, CreateRiskBody, ModelConfig, RiskCategory, RiskListQuery, SaveModelBody, ScoreQuery, UpdateCategoryBody, UpdateRiskBody,
} from './risk.schemas';

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
         a.model_version as a_model_version
    from public.risks r
    join public.risk_categories c on c.id = r.category_id
    left join public.sites s on s.id = r.site_id
    left join public.departments d on d.id = r.department_id
    left join public.profiles po on po.id = r.owner_user_id
    left join public.risk_assessments a on a.risk_id = r.id and a.phase = 'inherent' and a.status = 'current'`;

const SORT: Record<RiskListQuery['sort'], string> = {
  reference: 'r.reference',
  title: 'lower(r.title)',
  category: 'lower(r.category_label)',
  owner: 'lower(r.owner_name)',
  status: 'r.status',
  score: 'r.a_score',
  assessedOn: 'r.a_assessed_on',
  createdAt: 'r.created_at',
};

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
  inherent: r.a_id
    ? {
        id: r.a_id as string,
        likelihood: Number(r.a_likelihood),
        consequence: Number(r.a_consequence),
        score: Number(r.a_score),
        band: r.a_band as string,
        assessedOn: r.a_assessed_on as string,
        modelVersion: Number(r.a_model_version),
      }
    : null,
  retiredReason: (r.retired_reason as string) ?? null,
  retiredAt: r.retired_at ? (iso(r.retired_at) as string) : null,
  createdAt: iso(r.created_at) as string,
  updatedAt: iso(r.updated_at) as string,
});

/** Risk register (RK1): the scoring matrix, categories, risks and their assessments. Every write to a risk is a database function; reading is by RLS. */
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
        where.push(sql`(r.a_band = any(string_to_array(${bands.filter((b) => b !== 'unassessed').join(',')}, ',')) ${bands.includes('unassessed') ? sql`or r.a_id is null` : sql``})`);
      }
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
    const can = (await db.execute<Row>(sql`select app.has_permission(${org}::uuid, 'risk.manage') as manage`)).rows[0];
    const base = toRisk(rows[0]);
    const manage = Boolean(can.manage);
    return {
      ...base,
      assessments,
      canManage: manage,
      canEdit: manage && !['closed', 'retired'].includes(base.status),
    };
  }

  get(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, (db) => this.risk(db, ctx, id));
  }

  create(ctx: RequestContext, body: CreateRiskBody) {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ id: string }>(sql`select app.create_risk(${orgOf(ctx)}::uuid, ${json(body)}::jsonb) as id`);
      return this.risk(db, ctx, res.rows[0].id);
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
    return this.onRisk(ctx, id, (db) => db.execute(sql`select app.assess_risk(${id}::uuid, ${body.likelihood}::int, ${body.consequence}::int, ${body.rationale})`));
  }

  retire(ctx: RequestContext, id: string, reason: string) {
    return this.onRisk(ctx, id, (db) => db.execute(sql`select app.retire_risk(${id}::uuid, ${reason})`));
  }

  reactivate(ctx: RequestContext, id: string) {
    return this.onRisk(ctx, id, (db) => db.execute(sql`select app.reactivate_risk(${id}::uuid)`));
  }
}
