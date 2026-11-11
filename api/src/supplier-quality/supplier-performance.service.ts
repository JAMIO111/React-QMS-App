import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { iso, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { todayIn } from './expiry';
import { recommendInspection } from './inspection-recommendation';
import { InspectionRecommendation, Performance, PerformanceOverrides, PerformanceQuery, RecommendationQuery, SaveModelBody, SaveScorecardBody, Scorecard, ScorecardConfig, ScorecardModel, ScorecardSummary, SupplierSettings, SupplierSettingsBody, Watchlist, WatchlistQuery } from './supplier-performance.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const person = (id: unknown, name: unknown) => (id ? { id: id as string, name: (name as string) ?? 'Unknown user' } : null);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

type RawConfig = {
  otd_policy: ScorecardConfig['otdPolicy'];
  ppm_basis?: ScorecardConfig['ppmBasis'];
  ppm_nc_include_unlinked?: boolean;
  grace_days_before?: number | null;
  grace_days_after?: number;
  in_full_under_pct?: number;
  in_full_over_pct?: number;
  weights: { otd: number; in_full?: number; ppm: number; ncs: number; scar: number; certs: number };
  ppm_good: number;
  ppm_zero: number;
  nc_penalty: ScorecardConfig['ncPenalty'];
  good_from: number;
  watch_from: number;
  min_lines: number;
};
const fromRaw = (c: RawConfig): ScorecardConfig => ({
  otdPolicy: c.otd_policy,
  ppmBasis: c.ppm_basis ?? 'rejected',
  ppmNcIncludeUnlinked: c.ppm_nc_include_unlinked ?? false,
  graceDaysBefore: c.grace_days_before === undefined || c.grace_days_before === null ? null : Number(c.grace_days_before),
  graceDaysAfter: Number(c.grace_days_after ?? 0),
  inFullUnderPct: Number(c.in_full_under_pct ?? 0),
  inFullOverPct: Number(c.in_full_over_pct ?? 10),
  weights: { otd: c.weights.otd, inFull: Number(c.weights.in_full ?? 0), ppm: c.weights.ppm, ncs: c.weights.ncs, scar: c.weights.scar, certs: c.weights.certs },
  ppmGood: Number(c.ppm_good), ppmZero: Number(c.ppm_zero), ncPenalty: c.nc_penalty, goodFrom: Number(c.good_from), watchFrom: Number(c.watch_from), minLines: Number(c.min_lines),
});
const toRaw = (c: ScorecardConfig): RawConfig => ({
  otd_policy: c.otdPolicy, ppm_basis: c.ppmBasis, ppm_nc_include_unlinked: c.ppmNcIncludeUnlinked, grace_days_before: c.graceDaysBefore ?? undefined, grace_days_after: c.graceDaysAfter, in_full_under_pct: c.inFullUnderPct, in_full_over_pct: c.inFullOverPct,
  weights: { otd: c.weights.otd, in_full: c.weights.inFull, ppm: c.weights.ppm, ncs: c.weights.ncs, scar: c.weights.scar, certs: c.weights.certs },
  ppm_good: c.ppmGood, ppm_zero: c.ppmZero, nc_penalty: c.ncPenalty, good_from: c.goodFrom, watch_from: c.watchFrom, min_lines: c.minLines,
});

const overridesFromRaw = (o: Record<string, unknown> | null | undefined): PerformanceOverrides => {
  const out: PerformanceOverrides = {};
  if (o?.otd_policy) out.otdPolicy = o.otd_policy as 'agreed' | 'original';
  if (o?.grace_days_before !== undefined && o?.grace_days_before !== null) out.graceDaysBefore = Number(o.grace_days_before);
  if (o?.grace_days_after !== undefined && o?.grace_days_after !== null) out.graceDaysAfter = Number(o.grace_days_after);
  if (o?.in_full_under_pct !== undefined && o?.in_full_under_pct !== null) out.inFullUnderPct = Number(o.in_full_under_pct);
  if (o?.in_full_over_pct !== undefined && o?.in_full_over_pct !== null) out.inFullOverPct = Number(o.in_full_over_pct);
  return out;
};

type RawScoring = { score: number | null; band: Performance['band']; components: Performance['components']; warnings: Performance['warnings']; weightWithData: number | null; metrics: Record<string, unknown> };

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Supplier performance (SQ5). Every figure, the score, the band and the warnings are worked out by the database (app.supplier_performance), once, so the live view, a saved scorecard and the
 * watchlist cannot disagree. A scorecard freezes the model version, the figures and the records behind each warning. The service only reads, saves and reshapes.
 */
@Injectable()
export class SupplierPerformanceService {
  constructor(private readonly database: DatabaseService) {}

  private async assertSupplier(db: Db, ctx: RequestContext, id: string) {
    const res = await db.execute(sql`select 1 from public.suppliers where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
    if (res.rows.length === 0) throw ApiError.notFound('supplier_not_found', 'Supplier not found');
  }

  private async currentModel(db: Db, ctx: RequestContext): Promise<ScorecardModel> {
    const models = await db.execute<Row>(sql`
      select m.id, m.version, m.config, m.reason, m.created_at, m.created_by, ${sql.raw(personName('p'))} as created_by_name
      from public.supplier_scorecard_models m left join public.profiles p on p.id = m.created_by
      where m.organisation_id = ${orgOf(ctx)}::uuid order by m.version desc`);
    const cur = models.rows[0];
    if (!cur) throw ApiError.notFound('scorecard_model_not_found', 'This organisation has no scorecard model');
    return {
      id: cur.id as string,
      version: Number(cur.version),
      config: fromRaw(cur.config as RawConfig),
      reason: cur.reason as string,
      createdAt: iso(cur.created_at)!,
      createdBy: person(cur.created_by, cur.created_by_name),
      versions: models.rows.map((m) => ({ version: Number(m.version), reason: m.reason as string, createdAt: iso(m.created_at)!, createdBy: person(m.created_by, m.created_by_name) })),
    };
  }

  model(ctx: RequestContext): Promise<ScorecardModel> {
    return this.database.asUser(ctx, (db) => this.currentModel(db, ctx));
  }

  saveModel(ctx: RequestContext, b: SaveModelBody): Promise<ScorecardModel> {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.save_supplier_scorecard_model(${orgOf(ctx)}::uuid, ${JSON.stringify(toRaw(b.config))}::jsonb, ${b.reason})`);
      return this.currentModel(db, ctx);
    });
  }

  /** The live figures for a period (default: the last 90 days). */
  performance(ctx: RequestContext, supplierId: string, q: PerformanceQuery): Promise<Performance> {
    const to = q.to ?? todayIn(ctx.timeZone);
    const from = q.from ?? addDays(to, -89);
    return this.database.asUser(ctx, async (db) => {
      await this.assertSupplier(db, ctx, supplierId);
      const res = await db.execute<{ r: RawScoring & { model: { id: string; version: number; config: RawConfig }; overrides: Record<string, unknown> } }>(sql`select app.supplier_performance(${supplierId}::uuid, ${from}::date, ${to}::date) as r`);
      const r = res.rows[0].r;
      return { model: { id: r.model.id, version: Number(r.model.version), config: fromRaw(r.model.config) }, overrides: overridesFromRaw(r.overrides), metrics: r.metrics, score: num(r.score), band: r.band, components: r.components, warnings: r.warnings, weightWithData: num(r.weightWithData) };
    });
  }

  private toScorecard(r: Row): Scorecard {
    return {
      id: r.id as string,
      supplierId: r.supplier_id as string,
      periodFrom: r.period_from_t as string,
      periodTo: r.period_to_t as string,
      modelVersion: Number(r.model_version),
      config: fromRaw(r.config as RawConfig),
      metrics: r.metrics as Record<string, unknown>,
      components: r.components as Scorecard['components'],
      score: num(r.score),
      band: r.band as Scorecard['band'],
      warnings: r.warnings as Scorecard['warnings'],
      weightWithData: null,
      note: (r.note as string) ?? null,
      createdAt: iso(r.created_at)!,
      createdBy: person(r.created_by, r.created_by_name),
    };
  }

  private async loadOne(db: Db, ctx: RequestContext, id: string): Promise<Scorecard> {
    const rows = await db.execute<Row>(sql`
      select c.*, c.period_from::text as period_from_t, c.period_to::text as period_to_t, ${sql.raw(personName('p'))} as created_by_name
      from public.supplier_scorecards c left join public.profiles p on p.id = c.created_by
      where c.id = ${id}::uuid and c.organisation_id = ${orgOf(ctx)}::uuid`);
    if (!rows.rows[0]) throw ApiError.notFound('scorecard_not_found', 'Scorecard not found');
    return this.toScorecard(rows.rows[0]);
  }

  scorecard(ctx: RequestContext, id: string): Promise<Scorecard> {
    return this.database.asUser(ctx, (db) => this.loadOne(db, ctx, id));
  }

  /** Saved scorecards, newest first (for the trend). */
  scorecards(ctx: RequestContext, supplierId: string): Promise<{ data: ScorecardSummary[] }> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertSupplier(db, ctx, supplierId);
      const rows = await db.execute<Row>(sql`
        select c.id, c.period_from::text as period_from_t, c.period_to::text as period_to_t, c.model_version, c.score, c.band, jsonb_array_length(c.warnings) as warning_count, c.note, c.created_at, c.created_by,
               ${sql.raw(personName('p'))} as created_by_name
        from public.supplier_scorecards c left join public.profiles p on p.id = c.created_by
        where c.supplier_id = ${supplierId}::uuid and c.organisation_id = ${orgOf(ctx)}::uuid order by c.created_at desc, c.id`);
      return {
        data: rows.rows.map((r) => ({
          id: r.id as string, periodFrom: r.period_from_t as string, periodTo: r.period_to_t as string, modelVersion: Number(r.model_version), score: num(r.score), band: r.band as ScorecardSummary['band'],
          warningCount: Number(r.warning_count), note: (r.note as string) ?? null, createdAt: iso(r.created_at)!, createdBy: person(r.created_by, r.created_by_name),
        })),
      };
    });
  }

  save(ctx: RequestContext, supplierId: string, b: SaveScorecardBody): Promise<Scorecard> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertSupplier(db, ctx, supplierId);
      const res = await db.execute<{ id: string }>(sql`select app.save_supplier_scorecard(${supplierId}::uuid, ${b.from}::date, ${b.to}::date, ${b.note ?? null}) as id`);
      return this.loadOne(db, ctx, res.rows[0].id);
    });
  }

  /** A supplier's own overrides and what it is scored with now (the model's configuration with them on top). */
  private async loadSettings(db: Db, ctx: RequestContext, supplierId: string): Promise<SupplierSettings> {
    await this.assertSupplier(db, ctx, supplierId);
    const model = await this.currentModel(db, ctx);
    const row = await db.execute<Row>(sql`select otd_policy, grace_days_before, grace_days_after, in_full_under_pct, in_full_over_pct from public.supplier_performance_settings where supplier_id = ${supplierId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
    const o = row.rows[0];
    const overrides = {
      otdPolicy: (o?.otd_policy as ScorecardConfig['otdPolicy'] | null | undefined) ?? null,
      graceDaysBefore: num(o?.grace_days_before),
      graceDaysAfter: num(o?.grace_days_after),
      inFullUnderPct: num(o?.in_full_under_pct),
      inFullOverPct: num(o?.in_full_over_pct),
    };
    const c = model.config;
    return {
      overrides,
      effective: {
        otdPolicy: overrides.otdPolicy ?? c.otdPolicy,
        graceDaysBefore: overrides.graceDaysBefore ?? c.graceDaysBefore,
        graceDaysAfter: overrides.graceDaysAfter ?? c.graceDaysAfter,
        inFullUnderPct: overrides.inFullUnderPct ?? c.inFullUnderPct,
        inFullOverPct: overrides.inFullOverPct ?? c.inFullOverPct,
        ppmBasis: c.ppmBasis,
      },
      modelVersion: model.version,
    };
  }

  supplierSettings(ctx: RequestContext, supplierId: string): Promise<SupplierSettings> {
    return this.database.asUser(ctx, (db) => this.loadSettings(db, ctx, supplierId));
  }

  saveSupplierSettings(ctx: RequestContext, supplierId: string, b: SupplierSettingsBody): Promise<SupplierSettings> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertSupplier(db, ctx, supplierId);
      await db.execute(sql`select app.set_supplier_performance_settings(${supplierId}::uuid, ${JSON.stringify(b)}::jsonb)`);
      return this.loadSettings(db, ctx, supplierId);
    });
  }

  /**
   * What the rules in inspection-recommendation.ts would say about the level of incoming inspection for this supplier, from its risk rating, approval status and performance over the last N
   * days, set beside the level its supplier-wide approved requirement gives today. INFORMATION ONLY: nothing is written.
   */
  recommendation(ctx: RequestContext, supplierId: string, q: RecommendationQuery): Promise<InspectionRecommendation> {
    const to = todayIn(ctx.timeZone);
    const from = addDays(to, -(q.days - 1));
    return this.database.asUser(ctx, async (db) => {
      const sup = await db.execute<Row>(sql`select approval_status, risk_rating from public.suppliers where id = ${supplierId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (!sup.rows[0]) throw ApiError.notFound('supplier_not_found', 'Supplier not found');
      const perf = await db.execute<{ r: RawScoring & { model: { config: RawConfig } } }>(sql`select app.supplier_performance(${supplierId}::uuid, ${from}::date, ${to}::date) as r`);
      const r = perf.rows[0].r;
      const m = r.metrics as Record<string, Record<string, number>>;
      const rule = await db.execute<Row>(sql`
        select id, name, level from public.supplier_inspection_requirements
        where organisation_id = ${orgOf(ctx)}::uuid and supplier_id = ${supplierId}::uuid and part_id is null and part_family_id is null and classification_id is null and risk_rating is null and status = 'approved'
        order by approved_at desc limit 1`);
      const minLines = Number(r.model.config.min_lines);
      const rec = recommendInspection({
        approvalStatus: sup.rows[0].approval_status as string,
        riskRating: (sup.rows[0].risk_rating as 'low' | 'medium' | 'high' | 'critical' | null) ?? null,
        band: r.band,
        deliveredLines: Number(m.deliveries.lines),
        minLines,
        rejectedLines: Number(m.lotRejection.rejectedLines),
        criticalNcs: Number(m.ncs.critical),
        majorNcs: Number(m.ncs.major),
        overdueScars: Number(m.scars.overdue_now),
        expiredCerts: Number(m.certs.expired),
      });
      const rank = { reduced: 0, normal: 1, increased: 2 } as const;
      const currentLevel = (rule.rows[0]?.level as 'increased' | 'normal' | 'reduced' | undefined) ?? 'normal';
      return {
        level: rec.level,
        canReduce: rec.canReduce,
        current: { level: currentLevel, ruleId: (rule.rows[0]?.id as string) ?? null, ruleName: (rule.rows[0]?.name as string) ?? null, basis: rule.rows[0] ? ('supplier_rule' as const) : ('default' as const) },
        change: rank[rec.level] === rank[currentLevel] ? ('none' as const) : rank[rec.level] > rank[currentLevel] ? ('raise' as const) : ('lower' as const),
        reasons: rec.reasons,
        basis: {
          days: q.days, from, to, approvalStatus: sup.rows[0].approval_status as string, riskRating: (sup.rows[0].risk_rating as string) ?? null, band: r.band, score: num(r.score),
          deliveredLines: Number(m.deliveries.lines), rejectedLines: Number(m.lotRejection.rejectedLines), criticalNcs: Number(m.ncs.critical), majorNcs: Number(m.ncs.major), overdueScars: Number(m.scars.overdue_now), expiredCerts: Number(m.certs.expired), minLines,
        },
        generatedAt: new Date().toISOString(),
      };
    });
  }

  /** Active suppliers scored live over the last N days; only those with something to say, worst first. */
  watchlist(ctx: RequestContext, q: WatchlistQuery): Promise<z.infer<typeof Watchlist>> {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ r: Array<{ supplierId: string; code: string; name: string; score: number | null; band: Performance['band']; warnings: Performance['warnings'] }> }>(
        sql`select app.supplier_watchlist(${orgOf(ctx)}::uuid, ${q.days}::int) as r`);
      return { days: q.days, data: res.rows[0].r.map((x) => ({ ...x, score: num(x.score) })) };
    });
  }
}
