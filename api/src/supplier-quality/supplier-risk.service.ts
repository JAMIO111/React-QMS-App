import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { iso, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { todayUtc } from './expiry';
import { RecordRiskAssessmentBody, RiskAssessment, RiskModel, RiskScoresBody, RiskScoring, SaveRiskModelBody } from './supplier-risk.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const person = (id: unknown, name: unknown) => (id ? { id: id as string, name: (name as string) ?? 'Unknown user' } : null);

const toScoring = (r: Record<string, unknown>): RiskScoring => ({
  modelVersion: Number(r.modelVersion),
  index: Number(r.index),
  band: r.band as RiskScoring['band'],
  rating: r.rating as RiskScoring['rating'],
  escalatedBy: (r.escalatedBy as string[]) ?? [],
  factors: r.factors as RiskScoring['factors'],
});

/**
 * Supplier risk (SQ2b). The model (factors, weights, bands, review interval) is versioned per organisation; an assessment freezes the version it used and every score. The
 * index, band and rating are worked out by the database (app.score_supplier_risk) so the screen's preview and the saved record can never disagree.
 */
@Injectable()
export class SupplierRiskService {
  constructor(private readonly database: DatabaseService) {}

  private async assertSupplier(db: Db, ctx: RequestContext, id: string) {
    const res = await db.execute(sql`select 1 from public.suppliers where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
    if (res.rows.length === 0) throw ApiError.notFound('supplier_not_found', 'Supplier not found');
  }

  private async currentModel(db: Db, ctx: RequestContext): Promise<RiskModel> {
    const models = await db.execute<Row>(sql`
      select m.id, m.version, m.factors, m.thresholds, m.review_interval_months, m.reason, m.created_at, m.created_by, ${sql.raw(personName('p'))} as created_by_name
      from public.supplier_risk_models m left join public.profiles p on p.id = m.created_by
      where m.organisation_id = ${orgOf(ctx)}::uuid order by m.version desc`);
    const cur = models.rows[0];
    if (!cur) throw ApiError.notFound('risk_model_not_found', 'This organisation has no risk model');
    const t = cur.thresholds as { medium_from: number; high_from: number; critical_from: number };
    return {
      id: cur.id as string,
      version: Number(cur.version),
      factors: (cur.factors as Array<{ key: string; label: string; description?: string; weight: number; escalates: boolean }>).map((f) => ({ ...f, description: f.description ?? '' })),
      thresholds: { mediumFrom: Number(t.medium_from), highFrom: Number(t.high_from), criticalFrom: Number(t.critical_from) },
      reviewIntervalMonths: Number(cur.review_interval_months),
      reason: cur.reason as string,
      createdAt: iso(cur.created_at)!,
      createdBy: person(cur.created_by, cur.created_by_name),
      versions: models.rows.map((m) => ({ version: Number(m.version), createdAt: iso(m.created_at)!, createdBy: person(m.created_by, m.created_by_name), reason: m.reason as string })),
    };
  }

  model(ctx: RequestContext): Promise<RiskModel> {
    return this.database.asUser(ctx, (db) => this.currentModel(db, ctx));
  }

  saveModel(ctx: RequestContext, b: SaveRiskModelBody): Promise<RiskModel> {
    return this.database.asUser(ctx, async (db) => {
      const thresholds = { medium_from: b.thresholds.mediumFrom, high_from: b.thresholds.highFrom, critical_from: b.thresholds.criticalFrom };
      await db.execute(sql`select app.save_supplier_risk_model(${orgOf(ctx)}::uuid, ${JSON.stringify(b.factors)}::jsonb, ${JSON.stringify(thresholds)}::jsonb, ${b.reviewIntervalMonths}::int, ${b.reason})`);
      return this.currentModel(db, ctx);
    });
  }

  private scoresJson(b: RiskScoresBody) {
    return JSON.stringify(b.scores.map((s) => ({ key: s.key, score: s.score, note: s.note ?? null })));
  }

  /** What the scores would give, without saving anything. */
  preview(ctx: RequestContext, supplierId: string, b: RiskScoresBody): Promise<RiskScoring> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertSupplier(db, ctx, supplierId);
      const model = await this.currentModel(db, ctx);
      const res = await db.execute<{ r: Record<string, unknown> }>(sql`select app.score_supplier_risk(${model.id}::uuid, ${this.scoresJson(b)}::jsonb) as r`);
      return toScoring(res.rows[0].r);
    });
  }

  assessments(ctx: RequestContext, supplierId: string): Promise<{ data: RiskAssessment[] }> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertSupplier(db, ctx, supplierId);
      return { data: await this.list(db, ctx, supplierId) };
    });
  }

  private async list(db: Db, ctx: RequestContext, supplierId: string, onlyId?: string): Promise<RiskAssessment[]> {
    const rows = await db.execute<Row>(sql`
      select a.*, a.review_on::text as review_on_t, ${sql.raw(personName('p'))} as assessed_by_name
      from public.supplier_risk_assessments a left join public.profiles p on p.id = a.assessed_by
      where a.supplier_id = ${supplierId}::uuid and a.organisation_id = ${orgOf(ctx)}::uuid ${onlyId ? sql`and a.id = ${onlyId}::uuid` : sql``}
      order by (a.status = 'current') desc, a.assessed_at desc, a.id`);
    const today = todayUtc();
    return rows.rows.map((a) => ({
      ...toScoring({ modelVersion: a.model_version, index: a.risk_index, band: a.band, rating: a.rating, escalatedBy: a.escalated_by, factors: a.factors }),
      id: a.id as string,
      supplierId: a.supplier_id as string,
      rationale: a.rationale as string,
      previousRating: (a.previous_rating as RiskAssessment['previousRating']) ?? null,
      reviewOn: a.review_on_t as string,
      status: a.status as RiskAssessment['status'],
      reviewOverdue: a.status === 'current' && (a.review_on_t as string) < today,
      assessedAt: iso(a.assessed_at)!,
      assessedBy: person(a.assessed_by, a.assessed_by_name),
    }));
  }

  record(ctx: RequestContext, supplierId: string, b: RecordRiskAssessmentBody): Promise<RiskAssessment> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertSupplier(db, ctx, supplierId);
      const res = await db.execute<{ id: string }>(sql`
        select app.record_supplier_risk_assessment(${supplierId}::uuid, ${this.scoresJson(b)}::jsonb, ${b.rationale}, ${b.reviewOn ?? null}::date) as id`);
      return (await this.list(db, ctx, supplierId, res.rows[0].id))[0];
    });
  }
}
