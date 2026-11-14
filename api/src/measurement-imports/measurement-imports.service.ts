import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { iso, num, personName, Row } from '../calibration/calibration.service';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import { FileParseError } from '../integrations/core/file-parsers';
import { InspectionFileStore } from './file-store';
import { matchReport, MatchFeatureMap, MatchRequirement } from './match';
import {
  CreateImportBody,
  DiscardBody,
  FeatureMap,
  FeatureMapBody,
  ImportDetail,
  ImportSummary,
  MatchBody,
  Profile,
  ProfileBody,
  ProfilePatchBody,
  TryBody,
  TryResult,
} from './measurement-imports.schemas';
import { parseReport } from './parse-report';
import { PROFILE_TEMPLATES, TableSettings } from './profile-settings';

const orgOf = (ctx: RequestContext) => ctx.organisationId!;
const MAX_FILE = 26_214_400;
const MAX_TRY = 2_097_152;

type ProfileT = z.infer<typeof Profile>;
type DetailT = z.infer<typeof ImportDetail>;
type SummaryT = z.infer<typeof ImportSummary>;

const PROFILE_SELECT = `select p.id, p.name, p.description, p.format, p.current_version, p.active, p.retired_reason, p.updated_at, v.settings,
    g.id as gauge_id, g.asset_number as gauge_asset_number
  from public.measurement_import_profiles p
  join public.measurement_import_profile_versions v on v.profile_id = p.id and v.version = p.current_version
  left join public.gauges g on g.id = p.default_gauge_id`;

const toProfile = (r: Row): ProfileT => ({
  id: r.id as string,
  name: r.name as string,
  description: (r.description as string) ?? null,
  format: r.format as ProfileT['format'],
  currentVersion: Number(r.current_version),
  settings: r.settings as Record<string, unknown>,
  defaultGauge: r.gauge_id ? { id: r.gauge_id as string, assetNumber: r.gauge_asset_number as string } : null,
  active: r.active as boolean,
  retiredReason: (r.retired_reason as string) ?? null,
  updatedAt: iso(r.updated_at)!,
});

/** Turn a file the person cannot use into a 400 with the reader's own message. */
function readable<T>(work: () => T): T {
  try {
    return work();
  } catch (e) {
    if (e instanceof FileParseError) throw ApiError.badRequest('file_unreadable', e.message);
    throw e;
  }
}

@Injectable()
export class MeasurementImportsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly store: InspectionFileStore,
  ) {}

  // ---- profiles ----

  listProfiles(ctx: RequestContext, all: boolean) {
    return this.database.asUser(ctx, async (db) => {
      const rows = await db.execute<Row>(sql`${sql.raw(PROFILE_SELECT)} where p.organisation_id = ${orgOf(ctx)}::uuid ${all ? sql`` : sql`and p.active`}
        order by p.active desc, lower(p.name)`);
      const can = await db.execute<{ ok: boolean }>(sql`select app.has_permission(${orgOf(ctx)}::uuid, 'process_control.manage') as ok`);
      return { data: rows.rows.map(toProfile), canManage: can.rows[0].ok };
    });
  }

  templates() {
    return { data: PROFILE_TEMPLATES.map((t) => ({ ...t, settings: t.settings as unknown as Record<string, unknown> })) };
  }

  getProfile(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, (db) => this.loadProfile(db, ctx, id, true));
  }

  private async loadProfile(db: Db, ctx: RequestContext, id: string, withVersions = false): Promise<ProfileT> {
    const rows = await db.execute<Row>(sql`${sql.raw(PROFILE_SELECT)} where p.id = ${id}::uuid and p.organisation_id = ${orgOf(ctx)}::uuid`);
    if (!rows.rows[0]) throw ApiError.notFound('profile_not_found', 'Profile not found');
    const profile = toProfile(rows.rows[0]);
    if (withVersions) {
      const versions = await db.execute<Row>(sql`select v.version, v.reason, v.created_at, ${sql.raw(personName('pr'))} as created_by
        from public.measurement_import_profile_versions v left join public.profiles pr on pr.id = v.created_by
        where v.profile_id = ${id}::uuid order by v.version desc`);
      profile.versions = versions.rows.map((v) => ({ version: Number(v.version), reason: (v.reason as string) ?? null, createdAt: iso(v.created_at)!, createdBy: (v.created_by as string) ?? null }));
    }
    return profile;
  }

  createProfile(ctx: RequestContext, body: z.infer<typeof ProfileBody>) {
    return this.database.asUser(ctx, async (db) => {
      const res = await db.execute<{ id: string }>(sql`select app.save_measurement_profile(${orgOf(ctx)}::uuid, ${JSON.stringify(body)}::jsonb) as id`);
      return this.loadProfile(db, ctx, res.rows[0].id, true);
    });
  }

  updateProfile(ctx: RequestContext, id: string, body: z.infer<typeof ProfilePatchBody>) {
    return this.database.asUser(ctx, async (db) => {
      const current = await this.loadProfile(db, ctx, id);
      const patch: Record<string, unknown> = { name: body.name ?? current.name };
      if (body.description !== undefined) patch.description = body.description;
      if (body.defaultGaugeId !== undefined) patch.defaultGaugeId = body.defaultGaugeId;
      if (body.settings !== undefined) patch.settings = body.settings;
      if (body.reason !== undefined) patch.reason = body.reason;
      await db.execute(sql`select app.save_measurement_profile(${orgOf(ctx)}::uuid, ${JSON.stringify(patch)}::jsonb, ${id}::uuid)`);
      return this.loadProfile(db, ctx, id, true);
    });
  }

  retireProfile(ctx: RequestContext, id: string, reason: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.loadProfile(db, ctx, id);
      await db.execute(sql`select app.retire_measurement_profile(${id}::uuid, ${reason})`);
      return this.loadProfile(db, ctx, id, true);
    });
  }

  reactivateProfile(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.loadProfile(db, ctx, id);
      await db.execute(sql`select app.reactivate_measurement_profile(${id}::uuid)`);
      return this.loadProfile(db, ctx, id, true);
    });
  }

  /** Read a file with settings and show what was found. Nothing is saved; a file that cannot be read answers ok: false with the reason. */
  tryFile(body: z.infer<typeof TryBody>): z.infer<typeof TryResult> {
    const buf = Buffer.from(body.contentBase64, 'base64');
    if (buf.length > MAX_TRY) throw ApiError.badRequest('file_too_large', 'A file to try can be at most 2 MB');
    try {
      const r = parseReport(body.fileName, new Uint8Array(buf), body.settings);
      return {
        ok: true,
        error: null,
        header: r.header as Record<string, string>,
        headings: r.headings,
        headingRow: r.headingRow,
        featureCount: r.featureCount,
        warnings: r.warnings,
        units: r.units.map((u) => ({
          position: u.position,
          reference: u.reference,
          featureCount: u.features.length,
          features: u.features.slice(0, 200).map(({ raw: _raw, ...f }) => f),
        })),
      };
    } catch (e) {
      if (!(e instanceof FileParseError)) throw e;
      return { ok: false, error: e.message, header: {}, headings: [], headingRow: null, featureCount: 0, warnings: [], units: [] };
    }
  }

  // ---- feature maps ----

  listFeatureMaps(ctx: RequestContext, partId: string) {
    return this.database.asUser(ctx, async (db) => {
      const part = await db.execute(sql`select 1 from public.parts where id = ${partId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (!part.rows[0]) throw ApiError.notFound('part_not_found', 'Part not found');
      return { data: await this.loadMaps(db, ctx, partId) };
    });
  }

  private async loadMaps(db: Db, ctx: RequestContext, partId: string): Promise<z.infer<typeof FeatureMap>[]> {
    const rows = await db.execute<Row>(sql`select m.id, m.feature_name, m.characteristic_key, m.created_at, p.id as profile_id, p.name as profile_name,
        ${sql.raw(personName('pr'))} as created_by
      from public.measurement_feature_maps m left join public.measurement_import_profiles p on p.id = m.profile_id
      left join public.profiles pr on pr.id = m.created_by
      where m.part_id = ${partId}::uuid and m.organisation_id = ${orgOf(ctx)}::uuid and m.ended_at is null
      order by lower(m.feature_name), p.name nulls first`);
    return rows.rows.map((r) => ({
      id: r.id as string,
      featureName: r.feature_name as string,
      characteristicKey: r.characteristic_key as string,
      profile: r.profile_id ? { id: r.profile_id as string, name: r.profile_name as string } : null,
      createdAt: iso(r.created_at)!,
      createdBy: (r.created_by as string) ?? null,
    }));
  }

  saveFeatureMap(ctx: RequestContext, partId: string, body: z.infer<typeof FeatureMapBody>) {
    return this.database.asUser(ctx, async (db) => {
      await db.execute(sql`select app.save_feature_map(${partId}::uuid, ${body.profileId ?? null}::uuid, ${body.featureName}, ${body.characteristicKey})`);
      return { data: await this.loadMaps(db, ctx, partId) };
    });
  }

  endFeatureMap(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, async (db) => {
      const found = await db.execute<{ part_id: string }>(sql`select part_id from public.measurement_feature_maps where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (!found.rows[0]) throw ApiError.notFound('feature_map_not_found', 'Feature match not found');
      await db.execute(sql`select app.end_feature_map(${id}::uuid)`);
      return { data: await this.loadMaps(db, ctx, found.rows[0].part_id) };
    });
  }

  // ---- imports ----

  /** Read an uploaded report with a profile, match its features and store it as a preview (C10). Nothing becomes a reading here. */
  createImport(ctx: RequestContext, inspectionId: string, body: z.infer<typeof CreateImportBody>): Promise<DetailT> {
    return this.database.asUser(ctx, async (db) => {
      const rec = await db.execute<Row>(sql`select r.id, r.part_id from public.inspection_records r
        where r.id = ${inspectionId}::uuid and r.organisation_id = ${orgOf(ctx)}::uuid`);
      if (!rec.rows[0]) throw ApiError.notFound('inspection_not_found', 'Inspection not found');
      if (!body.path.startsWith(`${orgOf(ctx)}/inspection/${inspectionId}/`) || body.path.includes('..')) {
        throw ApiError.badRequest('invalid_path', 'The file must be uploaded to this inspection’s folder');
      }
      const profile = await this.loadProfile(db, ctx, body.profileId);
      if (!profile.active) throw new ApiError(409, 'inspection_rule', `Profile ${profile.name} is retired`);
      const settings = TableSettings.safeParse(profile.settings);
      if (!settings.success) throw new ApiError(409, 'inspection_rule', `Profile ${profile.name} cannot read files any more; check its settings`);

      if (!this.store.enabled) throw new ApiError(503, 'file_storage_unavailable', 'Measurement file imports are not set up on this server yet');
      const bytes = await this.store.download(body.path);
      if (!bytes) throw ApiError.badRequest('file_not_found', 'The uploaded file was not found; upload it again');
      if (bytes.length > MAX_FILE) throw ApiError.badRequest('file_too_large', 'A measurement file can be at most 25 MB');

      const report = readable(() => parseReport(body.fileName, bytes, settings.data));
      const reqs = await db.execute<Row>(sql`select id, characteristic_key, char_number, name, data_type, applicable
        from public.resolved_inspection_requirements where inspection_record_id = ${inspectionId}::uuid order by sequence`);
      const maps = await db.execute<Row>(sql`select feature_name, characteristic_key, profile_id from public.measurement_feature_maps
        where part_id = ${rec.rows[0].part_id as string}::uuid and ended_at is null`);
      const matched = matchReport(
        report,
        reqs.rows.map((q): MatchRequirement => ({
          id: q.id as string,
          characteristicKey: q.characteristic_key as string,
          charNumber: (q.char_number as string) ?? null,
          name: q.name as string,
          dataType: q.data_type as MatchRequirement['dataType'],
          applicable: q.applicable as boolean,
        })),
        maps.rows.map((m): MatchFeatureMap => ({ featureName: m.feature_name as string, characteristicKey: m.characteristic_key as string, profileId: (m.profile_id as string) ?? null })),
        profile.id,
      );
      const payload = {
        filePath: body.path,
        fileName: body.fileName,
        fileSha256: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.length,
        format: 'table',
        profileId: profile.id,
        gaugeId: body.gaugeId ?? null,
        header: report.header,
        warnings: [...report.warnings, ...matched.warnings].map((message) => ({ kind: 'file', message })),
        units: matched.units,
      };
      const created = await db.execute<{ id: string }>(sql`select app.create_inspection_import(${inspectionId}::uuid, ${JSON.stringify(payload)}::jsonb) as id`);
      return this.loadImport(db, ctx, created.rows[0].id);
    });
  }

  listImports(ctx: RequestContext, inspectionId: string) {
    return this.database.asUser(ctx, async (db) => {
      const rec = await db.execute(sql`select 1 from public.inspection_records where id = ${inspectionId}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
      if (!rec.rows[0]) throw ApiError.notFound('inspection_not_found', 'Inspection not found');
      const rows = await db.execute<Row>(sql`${sql.raw(IMPORT_SELECT)} where i.inspection_record_id = ${inspectionId}::uuid order by i.created_at desc`);
      return { data: rows.rows.map(toSummary) };
    });
  }

  getImport(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, (db) => this.loadImport(db, ctx, id));
  }

  setMatch(ctx: RequestContext, rowId: string, body: z.infer<typeof MatchBody>) {
    return this.database.asUser(ctx, async (db) => {
      const found = await db.execute<Row>(sql`select w.import_id, w.feature_name, i.profile_id, r.part_id
        from public.inspection_import_rows w join public.inspection_imports i on i.id = w.import_id join public.inspection_records r on r.id = i.inspection_record_id
        where w.id = ${rowId}::uuid and w.organisation_id = ${orgOf(ctx)}::uuid`);
      const row = found.rows[0];
      if (!row) throw ApiError.notFound('import_row_not_found', 'Feature not found');
      await db.execute(sql`select app.set_inspection_import_match(${rowId}::uuid, ${body.requirementId}::uuid)`);
      if (body.remember && body.requirementId) {
        const key = await db.execute<{ characteristic_key: string }>(sql`select characteristic_key from public.resolved_inspection_requirements where id = ${body.requirementId}::uuid`);
        await db.execute(sql`select app.save_feature_map(${row.part_id as string}::uuid, ${(row.profile_id as string) ?? null}::uuid, ${row.feature_name as string}, ${key.rows[0].characteristic_key})`);
      }
      return this.loadImport(db, ctx, row.import_id as string);
    });
  }

  confirmMismatches(ctx: RequestContext, id: string) {
    return this.database.asUser(ctx, async (db) => {
      await this.requireImport(db, ctx, id);
      await db.execute(sql`select app.confirm_inspection_import_mismatches(${id}::uuid)`);
      return this.loadImport(db, ctx, id);
    });
  }

  discard(ctx: RequestContext, id: string, body: z.infer<typeof DiscardBody>) {
    return this.database.asUser(ctx, async (db) => {
      await this.requireImport(db, ctx, id);
      await db.execute(sql`select app.discard_inspection_import(${id}::uuid, ${body.reason ?? null})`);
      return this.loadImport(db, ctx, id);
    });
  }

  private async requireImport(db: Db, ctx: RequestContext, id: string) {
    const found = await db.execute(sql`select 1 from public.inspection_imports where id = ${id}::uuid and organisation_id = ${orgOf(ctx)}::uuid`);
    if (!found.rows[0]) throw ApiError.notFound('import_not_found', 'Import not found');
  }

  async loadImport(db: Db, ctx: RequestContext, id: string): Promise<DetailT> {
    const head = await db.execute<Row>(sql`${sql.raw(IMPORT_SELECT)} where i.id = ${id}::uuid and i.organisation_id = ${orgOf(ctx)}::uuid`);
    const h = head.rows[0];
    if (!h) throw ApiError.notFound('import_not_found', 'Import not found');
    const detail = await db.execute<Row>(sql`select i.file_path, i.file_sha256, i.size_bytes, i.format, i.header, i.warnings, i.mismatches_confirmed_at,
        ${sql.raw(personName('cp'))} as confirmed_by, i.apply_mode, i.apply_reason, i.discard_reason, i.created_at < now() - interval '1 day' as expired,
        r.reference as inspection_reference, r.status as inspection_status, r.part_id, p.part_number,
        app.has_permission(i.organisation_id, 'inspection.record', r.site_id) as can_record
      from public.inspection_imports i join public.inspection_records r on r.id = i.inspection_record_id join public.parts p on p.id = r.part_id
      left join public.profiles cp on cp.id = i.mismatches_confirmed_by where i.id = ${id}::uuid`);
    const d = detail.rows[0];
    const checks = await db.execute<Row>(sql`select id, characteristic_key, char_number, name, data_type, unit_code, nominal, lower_limit, upper_limit, applicable
      from public.resolved_inspection_requirements where inspection_record_id = ${h.inspection_record_id as string}::uuid order by sequence, char_number nulls last, characteristic_key`);
    const units = await db.execute<Row>(sql`select id, position, unit_reference, sample_id from public.inspection_import_units where import_id = ${id}::uuid order by position`);
    const rows = await db.execute<Row>(sql`select * from public.inspection_import_rows where import_id = ${id}::uuid order by position`);
    const byUnit = new Map<string, Row[]>();
    for (const r of rows.rows) byUnit.set(r.unit_id as string, [...(byUnit.get(r.unit_id as string) ?? []), r]);
    return {
      ...toSummary(h),
      filePath: d.file_path as string,
      fileSha256: d.file_sha256 as string,
      sizeBytes: Number(d.size_bytes),
      format: d.format as DetailT['format'],
      header: (d.header as Record<string, unknown>) ?? {},
      warnings: (d.warnings as DetailT['warnings']) ?? [],
      mismatchesConfirmedAt: iso(d.mismatches_confirmed_at),
      mismatchesConfirmedBy: (d.confirmed_by as string) ?? null,
      applyMode: (d.apply_mode as string) ?? null,
      applyReason: (d.apply_reason as string) ?? null,
      discardReason: (d.discard_reason as string) ?? null,
      expired: h.status === 'previewed' && Boolean(d.expired),
      canRecord: Boolean(d.can_record),
      inspection: { id: h.inspection_record_id as string, reference: d.inspection_reference as string, status: d.inspection_status as string, partId: d.part_id as string, partNumber: d.part_number as string },
      checks: checks.rows.map((q) => ({
        id: q.id as string,
        characteristicKey: q.characteristic_key as string,
        charNumber: (q.char_number as string) ?? null,
        name: q.name as string,
        dataType: q.data_type as string,
        unit: (q.unit_code as string) ?? null,
        nominal: num(q.nominal),
        lowerLimit: num(q.lower_limit),
        upperLimit: num(q.upper_limit),
        applicable: q.applicable as boolean,
      })),
      units: units.rows.map((u) => ({
        id: u.id as string,
        position: Number(u.position),
        unitReference: (u.unit_reference as string) ?? null,
        sampleId: (u.sample_id as string) ?? null,
        rows: (byUnit.get(u.id as string) ?? []).map((r) => ({
          id: r.id as string,
          position: Number(r.position),
          featureName: r.feature_name as string,
          charNumber: (r.char_number as string) ?? null,
          raw: (r.raw as Record<string, string>) ?? {},
          valueText: (r.value_text as string) ?? null,
          unitRead: (r.unit_read as string) ?? null,
          readValue: num(r.read_value),
          valueNumeric: num(r.value_numeric),
          valuePass: (r.value_pass as boolean) ?? null,
          valueCount: num(r.value_count),
          fileNominal: num(r.file_nominal),
          fileLower: num(r.file_lower),
          fileUpper: num(r.file_upper),
          requirementId: (r.requirement_id as string) ?? null,
          matchKind: r.match_kind as DetailT['units'][number]['rows'][number]['matchKind'],
          problem: (r.problem as string) ?? null,
          expectedResult: (r.expected_result as 'pass' | 'fail') ?? null,
          mismatch: Boolean(r.mismatch),
          measurementId: (r.measurement_id as string) ?? null,
        })),
      })),
    };
  }
}

const IMPORT_SELECT = `select i.id, i.reference, i.inspection_record_id, i.status, i.file_name, i.created_at, i.applied_at, i.discarded_at,
    pf.id as profile_id, pf.name as profile_name, i.profile_version, g.id as gauge_id, g.asset_number as gauge_asset_number,
    ${personName('cb')} as created_by,
    (select count(*) from public.inspection_import_units n where n.import_id = i.id) as parts,
    c.features, c.matched, c.to_record, c.problems, c.failures, c.mismatches
  from public.inspection_imports i
  left join public.measurement_import_profiles pf on pf.id = i.profile_id
  left join public.gauges g on g.id = i.gauge_id
  left join public.profiles cb on cb.id = i.created_by
  cross join lateral (select count(*) as features, count(*) filter (where w.requirement_id is not null) as matched,
      count(*) filter (where w.requirement_id is not null and w.problem is null) as to_record, count(*) filter (where w.problem is not null) as problems,
      count(*) filter (where w.expected_result = 'fail') as failures, count(*) filter (where w.mismatch) as mismatches
    from public.inspection_import_rows w where w.import_id = i.id) c`;

const toSummary = (r: Row): SummaryT => ({
  id: r.id as string,
  reference: r.reference as string,
  inspectionId: r.inspection_record_id as string,
  status: r.status as SummaryT['status'],
  fileName: r.file_name as string,
  profile: r.profile_id ? { id: r.profile_id as string, name: r.profile_name as string, version: Number(r.profile_version) } : null,
  gauge: r.gauge_id ? { id: r.gauge_id as string, assetNumber: r.gauge_asset_number as string } : null,
  createdAt: iso(r.created_at)!,
  createdBy: (r.created_by as string) ?? null,
  appliedAt: iso(r.applied_at),
  discardedAt: iso(r.discarded_at),
  counts: {
    parts: Number(r.parts),
    features: Number(r.features),
    matched: Number(r.matched),
    toRecord: Number(r.to_record),
    unmatched: Number(r.features) - Number(r.matched),
    problems: Number(r.problems),
    failures: Number(r.failures),
    mismatches: Number(r.mismatches),
  },
});
