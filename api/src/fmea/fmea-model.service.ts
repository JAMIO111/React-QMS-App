import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { iso, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { parseApCsv } from './ap-import';
import type { ApImportBody, FmeaModelConfig, PreviewBody, SaveFmeaModelBody } from './fmea-model.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const json = (v: unknown) => JSON.stringify(v);

const toModel = (r: Row) => ({
  id: r.id as string,
  version: Number(r.version),
  config: r.config as FmeaModelConfig,
  reason: (r.reason as string) ?? null,
  current: !!r.current,
  createdBy: (r.created_by_name as string) ?? null,
  createdAt: iso(r.created_at) as string,
});

/** The organisation's FMEA rating model (versions), what S, O and D come to on it, and reading an action priority grid from a CSV. */
@Injectable()
export class FmeaModelService {
  constructor(private readonly database: DatabaseService) {}

  private async modelIn(db: Db, ctx: RequestContext) {
    const org = orgOf(ctx);
    const rows = (
      await db.execute<Row>(sql`
        select m.*, ${sql.raw(personName('pc'))} as created_by_name
          from public.fmea_models m left join public.profiles pc on pc.id = m.created_by
         where m.organisation_id = ${org}::uuid order by m.version desc`)
    ).rows.map(toModel);
    const current = rows.find((m) => m.current);
    if (!current) throw ApiError.notFound('fmea_model_not_found', 'This organisation has no FMEA rating model');
    const can = (await db.execute<Row>(sql`select app.has_permission(${org}::uuid, 'fmea.approve') as approve`)).rows[0];
    return { ...current, versions: rows.map(({ config: _c, ...v }) => v), canChange: Boolean(can.approve) };
  }

  model(ctx: RequestContext) {
    return this.database.asUser(ctx, (db) => this.modelIn(db, ctx));
  }

  saveModel(ctx: RequestContext, body: SaveFmeaModelBody) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.save_fmea_model(${orgOf(ctx)}::uuid, ${json(body.config)}::jsonb, ${body.reason})`);
      return this.modelIn(db, ctx);
    });
  }

  /** What S, O and D come to on a saved version of the model (the current one when none is named). Nothing is saved. */
  preview(ctx: RequestContext, body: PreviewBody) {
    return this.database.asUser(ctx, async (db) => {
      const m = (
        await db.execute<Row>(sql`
          select id from public.fmea_models
           where organisation_id = ${orgOf(ctx)}::uuid and ${body.version == null ? sql`current` : sql`version = ${body.version}::int`}`)
      ).rows[0];
      if (!m) throw ApiError.notFound('fmea_model_not_found', 'That version of the model does not exist');
      const s = (
        await db.execute<{ s: Record<string, unknown> }>(
          sql`select app.score_fmea(${m.id as string}::uuid, ${body.kind}, ${body.severity}::int, ${body.occurrence}::int, ${body.detection}::int) as s`,
        )
      ).rows[0].s;
      return {
        kind: body.kind,
        severity: Number(s.severity),
        occurrence: Number(s.occurrence),
        detection: Number(s.detection),
        rpn: Number(s.rpn),
        priority: s.priority as 'high' | 'medium' | 'low',
        method: s.method as 'rpn' | 'ap',
        needsAttention: Boolean(s.needsAttention),
        severityLabel: s.severityLabel as string,
        occurrenceLabel: s.occurrenceLabel as string,
        detectionLabel: s.detectionLabel as string,
        modelVersion: Number(s.modelVersion),
      };
    });
  }

  /**
   * Reads a grid from a CSV the organisation holds. Nothing is saved: the answer is the ranges, the lines that could not be read and, when
   * there are ranges, what the database says about them (whether every combination of S, O and D is covered exactly once).
   */
  importGrid(ctx: RequestContext, body: ApImportBody) {
    return this.database.asUser(ctx, async (db) => {
      const { rules, errors } = parseApCsv(body.csv);
      let problem: string | null = null;
      if (rules.length > 0 && errors.length === 0) {
        const current = await this.modelIn(db, ctx);
        const candidate = { ...current.config, method: 'ap' as const, apRules: rules };
        problem = (await db.execute<{ p: string | null }>(sql`select app.fmea_model_problem(${json(candidate)}::jsonb) as p`)).rows[0].p;
      }
      return { rules, errors, problem, covered: rules.length > 0 && errors.length === 0 && problem === null };
    });
  }
}
