import { HttpStatus, Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { iso, num, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { expiryOf, todayIn } from '../supplier-quality/expiry';
import { analyseStudy, dataHash, frozenResult, parsePaste, type CellRow, type PartRow, type StudyHeader, type StudyType } from './msa-data';
import { CancelBody, CompleteBody, CreateStudyBody, DesignBody, ListQuery, ParseBody, RecordBody } from './msa.schemas';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

/** A study with its gauge and part, the headline of its frozen result and how many readings are in. Read as the caller (RLS). */
const SUMMARY = sql`
  select s.*, g.asset_number, g.description as gauge_description, g.site_id as gauge_site_id, p.part_number, p.name as part_name,
         r.verdict as result_verdict, r.algorithm_version, r.criteria_id,
         (select (v ->> 'pctStudyVar')::float8 from jsonb_array_elements(r.result -> 'variation') v where v ->> 'name' = 'grr') as pct_grr,
         (r.result ->> 'cgk')::float8 as cgk,
         (r.result #>> '{overall,effectiveness}')::float8 as effectiveness,
         (select count(*)::int from public.msa_study_measurements m where m.study_id = s.id and (m.value is not null or m.decision is not null)) as filled,
         ${sql.raw(personName('pc'))} as completed_by_name, ${sql.raw(personName('pk'))} as created_by_name,
         s.valid_until::text as valid_until_text
    from public.msa_studies s
    join public.gauges g on g.id = s.gauge_id and g.organisation_id = s.organisation_id
    left join public.parts p on p.id = s.part_id and p.organisation_id = s.organisation_id
    left join public.msa_study_results r on r.study_id = s.id
    left join public.profiles pc on pc.id = s.completed_by
    left join public.profiles pk on pk.id = s.created_by`;

const SORT_SQL: Record<string, string> = {
  reference: 's.reference',
  type: 's.study_type',
  gauge: 's.asset_number',
  characteristic: 'lower(s.characteristic_name)',
  status: 's.status',
  verdict: `case s.result_verdict when 'acceptable' then 1 when 'marginal' then 2 when 'unacceptable' then 3 else 4 end`,
  validUntil: 's.valid_until',
  createdAt: 's.created_at',
  completedAt: 's.completed_at',
};

const VALIDITY_SQL = sql`case when s.status <> 'completed' or s.valid_until is null then null when s.valid_until < current_date then 'expired' when s.valid_until <= current_date + 60 then 'expiring' else 'valid' end`;

export const verdictOf = (v: unknown): 'acceptable' | 'marginal' | 'unacceptable' | 'not_judged' | null => (v ? (v as 'acceptable' | 'marginal' | 'unacceptable' | 'not_judged') : null);

@Injectable()
export class MsaService {
  constructor(private readonly database: DatabaseService) {}

  private summary(row: Row, today: string, canManage = false, canRecord = false) {
    const total = Number(row.part_count) * Number(row.appraiser_count) * Number(row.trial_count);
    const validity = row.status === 'completed' ? expiryOf(row.valid_until_text as string | null, today) : null;
    return {
      id: row.id as string,
      reference: row.reference as string,
      studyType: row.study_type as StudyType,
      status: row.status as 'draft' | 'collecting' | 'completed' | 'cancelled',
      gauge: { id: row.gauge_id as string, assetNumber: row.asset_number as string, description: row.gauge_description as string },
      part: row.part_id ? { id: row.part_id as string, partNumber: row.part_number as string, name: row.part_name as string } : null,
      characteristicKey: (row.characteristic_key as string) ?? null,
      operationCode: (row.operation_code as string) ?? null,
      characteristicName: row.characteristic_name as string,
      unitCode: (row.unit_code as string) ?? null,
      partCount: Number(row.part_count),
      appraiserCount: Number(row.appraiser_count),
      trialCount: Number(row.trial_count),
      progress: { filled: Number(row.filled), total },
      verdict: verdictOf(row.result_verdict),
      /** The headline figure of the frozen result: %study variation of the gauge R&R, Cgk, or the overall effectiveness (a fraction). */
      headline: { pctGrr: num(row.pct_grr), cgk: num(row.cgk), effectiveness: num(row.effectiveness) },
      conclusion: (row.conclusion as string) ?? null,
      validUntil: (row.valid_until_text as string) ?? null,
      validity: validity ? { state: validity.state, daysLeft: validity.daysLeft } : null,
      repeatOfId: (row.repeat_of_id as string) ?? null,
      startedAt: iso(row.started_at),
      completedAt: iso(row.completed_at),
      completedBy: (row.completed_by_name as string) ?? null,
      createdAt: iso(row.created_at) as string,
      createdBy: (row.created_by_name as string) ?? null,
      updatedAt: iso(row.updated_at) as string,
      canManage,
      canRecord,
    };
  }

  async list(ctx: RequestContext, q: ListQuery) {
    return this.database.asUser(ctx, async (db) => {
      const where: SQL[] = [sql`s.organisation_id = ${orgOf(ctx)}::uuid`];
      const statuses = q.status.split(',');
      if (!statuses.includes('all')) {
        const named = statuses.flatMap((x) => (x === 'open' ? ['draft', 'collecting'] : [x]));
        where.push(sql`s.status = any(string_to_array(${named.join(',')}, ','))`);
      } else {
        where.push(sql`s.status <> 'cancelled'`);
      }
      if (q.type) where.push(sql`s.study_type = any(string_to_array(${q.type}, ','))`);
      if (q.gaugeId) where.push(sql`s.gauge_id = ${q.gaugeId}::uuid`);
      if (q.partId) where.push(sql`s.part_id = ${q.partId}::uuid`);
      if (q.verdict) where.push(sql`coalesce(s.result_verdict, 'none') = any(string_to_array(${q.verdict}, ','))`);
      if (q.valid) where.push(sql`${VALIDITY_SQL} = any(string_to_array(${q.valid}, ','))`);
      if (q.q) {
        const like = likePattern(q.q);
        where.push(sql`(s.reference ilike ${like} or s.characteristic_name ilike ${like} or s.characteristic_key ilike ${like} or s.asset_number ilike ${like} or s.gauge_description ilike ${like}
          or s.part_number ilike ${like} or s.part_name ilike ${like})`);
      }
      const clause = sql.join(where, sql` and `);
      const order = sql.raw(`${SORT_SQL[q.sort]} ${q.order} nulls last, s.reference desc`);
      const rows = await db.execute<Row>(sql`select s.* from (${SUMMARY}) s where ${clause} order by ${order} limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`);
      const count = await db.execute<{ n: number }>(sql`select count(*)::int as n from (${SUMMARY}) s where ${clause}`);
      const today = todayIn(ctx.timeZone);
      return { data: rows.rows.map((r) => this.summary(r, today)), page: q.page, pageSize: q.pageSize, total: Number(count.rows[0].n) };
    });
  }

  // ---- one study ------------------------------------------------------------------------------

  /** An id of another organisation, or one the caller may not read, is 404 before any function runs. */
  private async mustExist(db: Db, ctx: RequestContext, id: string) {
    const found = await db.execute(sql`select 1 from public.msa_studies where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
    if (found.rows.length === 0) throw ApiError.notFound('study_not_found', 'Study not found');
  }

  private async header(db: Db, id: string): Promise<StudyHeader> {
    const r = (
      await db.execute<Row>(sql`
        select study_type, part_count, appraiser_count, trial_count, coalesce(nominal::text, '') as nominal, coalesce(lower_limit::text, '') as lower_limit,
               coalesce(upper_limit::text, '') as upper_limit, coalesce(gauge_resolution::text, '') as resolution, sigma_multiplier::text as sigma,
               interaction_alpha::text as alpha, coalesce(reference_value::text, '') as reference_value, k_percent::text as k, l_multiplier::text as l
          from public.msa_studies where id = ${id}::uuid`)
    ).rows[0];
    return {
      studyType: r.study_type as StudyType,
      partCount: Number(r.part_count),
      appraiserCount: Number(r.appraiser_count),
      trialCount: Number(r.trial_count),
      nominal: r.nominal as string,
      lowerLimit: r.lower_limit as string,
      upperLimit: r.upper_limit as string,
      resolution: r.resolution as string,
      sigma: r.sigma as string,
      alpha: r.alpha as string,
      referenceValue: r.reference_value as string,
      kPercent: r.k as string,
      lMultiplier: r.l as string,
    };
  }

  private async partRows(db: Db, id: string): Promise<(PartRow & { id: string })[]> {
    const rows = (await db.execute<Row>(sql`select id, position, label, reference_decision from public.msa_study_parts where study_id = ${id}::uuid order by position`)).rows;
    return rows.map((r) => ({ id: r.id as string, position: Number(r.position), label: r.label as string, referenceDecision: (r.reference_decision as boolean | null) ?? null }));
  }

  private async appraiserRows(db: Db, id: string) {
    const rows = (await db.execute<Row>(sql`select id, position, name, employee_id from public.msa_study_appraisers where study_id = ${id}::uuid order by position`)).rows;
    return rows.map((r) => ({ id: r.id as string, position: Number(r.position), name: r.name as string, employeeId: (r.employee_id as string) ?? null }));
  }

  private async cellRows(db: Db, id: string): Promise<CellRow[]> {
    const rows = (
      await db.execute<Row>(sql`
        select a.position as appraiser, p.position as part, m.trial, m.value::text as value, m.decision
          from public.msa_study_measurements m
          join public.msa_study_appraisers a on a.id = m.appraiser_id join public.msa_study_parts p on p.id = m.part_id
         where m.study_id = ${id}::uuid order by a.position, p.position, m.trial`)
    ).rows;
    return rows.map((r) => ({ appraiser: Number(r.appraiser), part: Number(r.part), trial: Number(r.trial), value: (r.value as string) ?? null, decision: (r.decision as boolean | null) ?? null }));
  }

  private async detailIn(db: Db, ctx: RequestContext, id: string) {
    const rows = (await db.execute<Row>(sql`select s.* from (${SUMMARY}) s where s.id = ${id}::uuid and s.organisation_id = ${orgOf(ctx)}::uuid`)).rows;
    if (rows.length === 0) throw ApiError.notFound('study_not_found', 'Study not found');
    const row = rows[0];
    const rights = (
      await db.execute<Row>(sql`
        select app.has_permission(${orgOf(ctx)}::uuid, 'calibration.manage', ${row.gauge_site_id as string | null}::uuid) as manage,
               app.has_permission(${orgOf(ctx)}::uuid, 'calibration.record', ${row.gauge_site_id as string | null}::uuid) as record`)
    ).rows[0];
    const today = todayIn(ctx.timeZone);
    const status = row.status as string;
    const canManage = Boolean(rights.manage);
    const cells = status === 'draft' ? [] : (await db.execute<Row>(sql`
      select a.position as appraiser, p.position as part, m.trial, m.run_order, m.value::text as value, m.decision, m.source, m.entered_at, ${sql.raw(personName('pe'))} as entered_by
        from public.msa_study_measurements m
        join public.msa_study_appraisers a on a.id = m.appraiser_id join public.msa_study_parts p on p.id = m.part_id
        left join public.profiles pe on pe.id = m.entered_by
       where m.study_id = ${id}::uuid order by a.position, p.position, m.trial`)).rows;
    return {
      ...this.summary(row, today, canManage && (status === 'draft' || status === 'collecting'), Boolean(rights.record) && status === 'collecting'),
      design: {
        nominal: num(row.nominal),
        lowerLimit: num(row.lower_limit),
        upperLimit: num(row.upper_limit),
        gaugeResolution: num(row.gauge_resolution),
        sigmaMultiplier: Number(row.sigma_multiplier),
        interactionAlpha: Number(row.interaction_alpha),
        referenceValue: num(row.reference_value),
        kPercent: Number(row.k_percent),
        lMultiplier: Number(row.l_multiplier),
      },
      conclusionNote: (row.conclusion_note as string) ?? null,
      cancelReason: (row.cancel_reason as string) ?? null,
      cancelledAt: iso(row.cancelled_at),
      algorithmVersion: (row.algorithm_version as string) ?? null,
      criteriaId: (row.criteria_id as string) ?? null,
      appraisers: await this.appraiserRows(db, id),
      parts: (await this.partRows(db, id)).map(({ id: partId, ...p }) => ({ id: partId, ...p })),
      cells: cells.map((c) => ({
        appraiser: Number(c.appraiser),
        part: Number(c.part),
        trial: Number(c.trial),
        runOrder: Number(c.run_order),
        value: (c.value as string) ?? null,
        decision: (c.decision as boolean | null) ?? null,
        source: (c.source as string) ?? null,
        enteredAt: iso(c.entered_at),
        enteredBy: (c.entered_by as string) ?? null,
      })),
    };
  }

  get(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, (db) => this.detailIn(db, ctx, id));
  }

  // ---- design ---------------------------------------------------------------------------------

  /** A characteristic of the part's released revision brings its name, unit and limits, for the keys the person did not give. */
  private async characteristicDefaults(db: Db, ctx: RequestContext, partId: string, key: string) {
    const r = (
      await db.execute<Row>(sql`
        select c.description, c.unit_code, c.nominal::text as nominal, c.lower_limit::text as lower_limit, c.upper_limit::text as upper_limit
          from public.part_revision_characteristics c join public.part_revisions v on v.id = c.part_revision_id and v.organisation_id = c.organisation_id
         where v.part_id = ${partId}::uuid and v.organisation_id = ${orgOf(ctx)}::uuid and v.status = 'released' and c.characteristic_key = ${key}`)
    ).rows[0];
    if (!r) throw new ApiError(HttpStatus.BAD_REQUEST, 'unknown_characteristic', `The part's released revision has no characteristic ${key}`);
    return r;
  }

  private async withDefaults<T extends { partId?: string | null; characteristicKey?: string | null; characteristicName?: string; unitCode?: string | null; nominal?: unknown; lowerLimit?: unknown; upperLimit?: unknown }>(db: Db, ctx: RequestContext, body: T): Promise<T> {
    if (!body.partId || !body.characteristicKey) return body;
    const key = body.characteristicKey.trim().toUpperCase();
    const d = await this.characteristicDefaults(db, ctx, body.partId, key);
    return {
      ...body,
      characteristicKey: key,
      characteristicName: body.characteristicName ?? ((d.description as string) || key),
      unitCode: body.unitCode === undefined ? (d.unit_code as string) : body.unitCode,
      nominal: body.nominal === undefined ? ((d.nominal as string) ?? null) : body.nominal,
      lowerLimit: body.lowerLimit === undefined ? ((d.lower_limit as string) ?? null) : body.lowerLimit,
      upperLimit: body.upperLimit === undefined ? ((d.upper_limit as string) ?? null) : body.upperLimit,
    };
  }

  create(ctx: RequestContext, body: CreateStudyBody) {
    return this.database.asUser(ctx, async (db) => {
      const filled = await this.withDefaults(db, ctx, body);
      const res = await db.execute<{ id: string }>(sql`select app.create_msa_study(${orgOf(ctx)}::uuid, ${JSON.stringify(filled)}::jsonb) as id`);
      return this.detailIn(db, ctx, res.rows[0].id);
    });
  }

  updateDesign(ctx: RequestContext, id: string, body: DesignBody) {
    return this.database.asUser(ctx, async (db) => {
      await this.mustExist(db, ctx, id);
      const filled = await this.withDefaults(db, ctx, body);
      await db.execute(sql`select app.update_msa_design(${id}::uuid, ${JSON.stringify(filled)}::jsonb)`);
      return this.detailIn(db, ctx, id);
    });
  }

  start(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.mustExist(db, ctx, id);
      await db.execute(sql`select app.start_msa_collection(${id}::uuid)`);
      return this.detailIn(db, ctx, id);
    });
  }

  cancel(ctx: RequestContext, id: string, body: CancelBody) {
    return this.database.asUser(ctx, async (db) => {
      await this.mustExist(db, ctx, id);
      await db.execute(sql`select app.cancel_msa_study(${id}::uuid, ${body.reason})`);
      return this.detailIn(db, ctx, id);
    });
  }

  repeat(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.mustExist(db, ctx, id);
      const res = await db.execute<{ id: string }>(sql`select app.repeat_msa_study(${id}::uuid) as id`);
      return this.detailIn(db, ctx, res.rows[0].id);
    });
  }

  // ---- readings -------------------------------------------------------------------------------

  async record(ctx: RequestContext, id: string, body: RecordBody) {
    return this.database.asUser(ctx, async (db) => {
      await this.mustExist(db, ctx, id);
      const res = await db.execute<{ n: number }>(sql`select app.record_msa_measurements(${id}::uuid, ${JSON.stringify(body.cells)}::jsonb, ${body.source}) as n`);
      const progress = (
        await db.execute<Row>(sql`
          select count(*) filter (where value is not null or decision is not null)::int as filled, count(*)::int as total from public.msa_study_measurements where study_id = ${id}::uuid`)
      ).rows[0];
      return { recorded: Number(res.rows[0].n), progress: { filled: Number(progress.filled), total: Number(progress.total) } };
    });
  }

  /** Pasted text turned into cells, nothing saved. The study must be collecting (a draft has no run sheet yet). */
  parse(ctx: RequestContext, id: string, body: ParseBody) {
    return this.database.asUser(ctx, async (db) => {
      await this.mustExist(db, ctx, id);
      const h = await this.header(db, id);
      const status = (await db.execute<Row>(sql`select status from public.msa_studies where id = ${id}::uuid`)).rows[0].status as string;
      if (status !== 'collecting') throw new ApiError(HttpStatus.CONFLICT, 'msa_rule', `The study is ${status}: readings are pasted while it is collecting`);
      const result = parsePaste(body.text, { studyType: h.studyType, appraisers: await this.appraiserRows(db, id), parts: await this.partRows(db, id), trialCount: h.trialCount });
      return result;
    });
  }

  // ---- analysis, completion, report -----------------------------------------------------------

  private async frozenOf(db: Db, id: string) {
    const r = (await db.execute<Row>(sql`select result, data_hash, algorithm_version, criteria_id, verdict from public.msa_study_results where study_id = ${id}::uuid`)).rows[0];
    return r ? { result: r.result as Record<string, unknown>, dataHash: r.data_hash as string, algorithmVersion: r.algorithm_version as string, criteriaId: r.criteria_id as string, verdict: r.verdict as string } : null;
  }

  /** The analysis of a study: the frozen result once it is completed, otherwise worked out from the readings stored now. */
  analysis(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.mustExist(db, ctx, id);
      const status = (await db.execute<Row>(sql`select status from public.msa_studies where id = ${id}::uuid`)).rows[0].status as string;
      const frozen = status === 'completed' ? await this.frozenOf(db, id) : null;
      if (frozen) return { frozen: true, complete: true, filled: null, total: null, problem: null, result: frozen.result, dataHash: frozen.dataHash };
      const out = analyseStudy(await this.header(db, id), await this.partRows(db, id), await this.cellRows(db, id));
      return { frozen: false, complete: out.complete, filled: out.filled, total: out.total, problem: out.problem, result: out.analysis ? frozenResult(out.analysis) : null, dataHash: null };
    });
  }

  /**
   * Completing: the result is worked out here from the readings the database holds (read as the person), then handed to the API login's function with the hash of
   * that data. The database re-checks the person's right, the state, every cell and the hash, and freezes the study.
   */
  async complete(ctx: RequestContext, id: string, body: CompleteBody) {
    const prepared = await this.database.asUser(ctx, async (db) => {
      await this.mustExist(db, ctx, id);
      const rows = (await db.execute<Row>(sql`select status, app.has_permission(organisation_id, 'calibration.manage', app.gauge_site(gauge_id)) as manage from public.msa_studies where id = ${id}::uuid`)).rows[0];
      if (!rows.manage) throw ApiError.forbidden('You are not allowed to complete studies for this gauge');
      if (rows.status !== 'collecting') throw new ApiError(HttpStatus.CONFLICT, 'msa_rule', `The study is ${rows.status as string} and cannot be completed`);
      const header = await this.header(db, id);
      const parts = await this.partRows(db, id);
      const cells = await this.cellRows(db, id);
      const out = analyseStudy(header, parts, cells);
      if (!out.complete) throw new ApiError(HttpStatus.CONFLICT, 'msa_rule', out.problem ?? 'The study cannot be completed yet');
      if (!out.analysis) throw new ApiError(HttpStatus.CONFLICT, 'msa_rule', out.problem ?? 'The readings cannot be analysed');
      return { result: frozenResult(out.analysis), hash: dataHash(header, parts, cells) };
    });
    await this.database.asApi(
      (c) =>
        c.query(`select app.system_complete_msa_study($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::date, $7::jsonb, $8)`, [
          orgOf(ctx), id, ctx.user.id, body.conclusion, body.note, body.validUntil ?? null, JSON.stringify(prepared.result), prepared.hash,
        ]),
      ctx.correlationId,
      'api',
    );
    return this.get(ctx, id);
  }

  /** A completed study as a document: its design, readings and frozen result, with whether the stored data still matches the hash the result was made from. */
  report(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.mustExist(db, ctx, id);
      const detail = await this.detailIn(db, ctx, id);
      if (detail.status !== 'completed') throw new ApiError(HttpStatus.CONFLICT, 'msa_rule', 'Only a completed study has a report');
      const frozen = await this.frozenOf(db, id);
      const header = await this.header(db, id);
      const stillMatches = frozen ? dataHash(header, await this.partRows(db, id), await this.cellRows(db, id)) === frozen.dataHash : false;
      return { study: detail, result: frozen?.result ?? null, dataHash: frozen?.dataHash ?? null, dataMatchesResult: stillMatches };
    });
  }

  // ---- the gauge page -------------------------------------------------------------------------

  /** Studies of one gauge: the current one per characteristic (the latest completed, with its validity) and those still being worked on. */
  gauge(ctx: RequestContext, gaugeId: string) {
    return this.database.asUser(ctx, async (db) => {
      const g = await db.execute(sql`select 1 from public.gauges where id = ${gaugeId}::uuid and organisation_id = ${orgOf(ctx)}::uuid and deleted_at is null`);
      if (g.rows.length === 0) throw ApiError.notFound('gauge_not_found', 'Gauge not found');
      const rows = (
        await db.execute<Row>(sql`
          select s.*, row_number() over (partition by s.study_type, coalesce(s.part_id::text, ''), lower(coalesce(s.characteristic_key, s.characteristic_name))
                                         order by s.completed_at desc nulls last) as rn
            from (${SUMMARY}) s where s.gauge_id = ${gaugeId}::uuid and s.organisation_id = ${orgOf(ctx)}::uuid and s.status in ('draft', 'collecting', 'completed')`)
      ).rows;
      const today = todayIn(ctx.timeZone);
      return {
        current: rows.filter((r) => r.status === 'completed' && Number(r.rn) === 1).map((r) => this.summary(r, today)),
        open: rows.filter((r) => r.status === 'draft' || r.status === 'collecting').map((r) => this.summary(r, today)),
        earlier: rows.filter((r) => r.status === 'completed' && Number(r.rn) > 1).map((r) => this.summary(r, today)),
      };
    });
  }
}
