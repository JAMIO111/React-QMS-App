import { writeCustomValues } from '../custom-fields/custom-values';
import type { CustomValuesInput } from '../custom-fields/custom-fields.schemas';
import { Injectable } from '@nestjs/common';
import { SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService, Db } from '../database/database.service';
import {
  Attachment,
  CalibrationDetail,
  CalibrationSummary,
  CreateAttachmentBody,
  CreateCalibrationBody,
  DeletedQuery,
  RaisedNcr,
  Reading,
  UpdateCalibrationBody,
} from './calibration.schemas';
import { assignments, insertParts, iso, num, personName, ref, Row } from './calibration.service';

const CALIBRATION_COLUMNS: Record<string, string> = {
  calibratedOn: 'calibrated_on', performedBy: 'performed_by', technicianId: 'technician_id', supplierId: 'supplier_id',
  certificateNumber: 'certificate_number', procedureRef: 'procedure_ref', referenceStandards: 'reference_standards',
  temperatureC: 'temperature_c', humidityPct: 'humidity_pct', outcome: 'outcome', nextDueOn: 'next_due_on', notes: 'notes',
};

const deletedFilter = (alias: string, deleted: z.infer<typeof DeletedQuery>['deleted']): SQL =>
  deleted === 'exclude' ? sql.raw(`${alias}.deleted_at is null`) : deleted === 'only' ? sql.raw(`${alias}.deleted_at is not null`) : sql`true`;

const CALIBRATION_SELECT = `
  select c.*, to_char(c.calibrated_on, 'YYYY-MM-DD') as calibrated_on_text, to_char(c.next_due_on, 'YYYY-MM-DD') as next_due_on_text,
    ${personName('pt')} as technician_name, coalesce(sp.display_name, sp.name) as supplier_name,
    ${personName('pc')} as created_by_name, ${personName('pdl')} as deleted_by_name,
    n.reference as ncr_reference, n.source as ncr_source,
    coalesce(rc.n, 0) as reading_count, coalesce(rc.failed, 0) as failed_count, coalesce(ac.n, 0) as attachment_count
  from public.calibrations c
  left join public.profiles pt on pt.id = c.technician_id
  left join public.suppliers sp on sp.id = c.supplier_id
  left join public.profiles pc on pc.id = c.created_by
  left join public.profiles pdl on pdl.id = c.deleted_by
  left join public.nonconformances n on n.id = c.nonconformance_id
  left join lateral (
    select count(*) as n, count(*) filter (where not (r.as_found_ok or coalesce(r.as_left_ok, false))) as failed
    from public.calibration_readings r where r.calibration_id = c.id
  ) rc on true
  left join lateral (select count(*) as n from public.calibration_attachments a where a.calibration_id = c.id and a.deleted_at is null) ac on true`;

const toSummary = (r: Row): CalibrationSummary => ({
  id: r.id as string,
  reference: r.reference as string,
  gaugeId: r.gauge_id as string,
  calibratedOn: r.calibrated_on_text as string,
  performedBy: r.performed_by as CalibrationSummary['performedBy'],
  technician: ref(r.technician_id, r.technician_name, 'Unknown user'),
  supplier: ref(r.supplier_id, r.supplier_name),
  certificateNumber: (r.certificate_number as string) ?? null,
  outcome: r.outcome as CalibrationSummary['outcome'],
  nextDueOn: (r.next_due_on_text as string) ?? null,
  readingCount: Number(r.reading_count ?? 0),
  failedCount: Number(r.failed_count ?? 0),
  attachmentCount: Number(r.attachment_count ?? 0),
  // RLS hides an NCR the caller may not read; then only the link is known, not its reference.
  nonconformance: r.nonconformance_id && r.ncr_reference ? { id: r.nonconformance_id as string, reference: r.ncr_reference as string, source: r.ncr_source as string } : null,
  createdBy: ref(r.created_by, r.created_by_name, 'Unknown user'),
  createdAt: iso(r.created_at)!,
  deletedAt: iso(r.deleted_at),
});

const toReading = (r: Row): z.infer<typeof Reading> => ({
  id: r.id as string,
  characteristicId: (r.characteristic_id as string) ?? null,
  sortOrder: Number(r.sort_order),
  kind: r.kind as z.infer<typeof Reading>['kind'],
  name: r.name as string,
  nominal: num(r.nominal),
  toleranceMinus: num(r.tolerance_minus),
  tolerancePlus: num(r.tolerance_plus),
  lower: r.nominal == null ? null : Number(r.nominal) - Number(r.tolerance_minus),
  upper: r.nominal == null ? null : Number(r.nominal) + Number(r.tolerance_plus),
  unitCode: (r.unit_code as string) ?? null,
  asFound: num(r.as_found),
  asLeft: num(r.as_left),
  asFoundPass: (r.as_found_pass as boolean) ?? null,
  asLeftPass: (r.as_left_pass as boolean) ?? null,
  asFoundOk: r.as_found_ok as boolean,
  asLeftOk: (r.as_left_ok as boolean) ?? null,
  notes: (r.notes as string) ?? null,
});

const ATTACHMENT_SELECT = `
  select a.*, ${personName('pc')} as created_by_name
  from public.calibration_attachments a left join public.profiles pc on pc.id = a.created_by`;

const toAttachment = (r: Row): z.infer<typeof Attachment> => ({
  id: r.id as string,
  fileName: r.file_name as string,
  contentType: (r.content_type as string) ?? null,
  sizeBytes: Number(r.size_bytes),
  description: (r.description as string) ?? null,
  storagePath: r.storage_path as string,
  createdAt: iso(r.created_at)!,
  createdBy: ref(r.created_by, r.created_by_name, 'Unknown user'),
  deletedAt: iso(r.deleted_at),
  deleteReason: (r.delete_reason as string) ?? null,
});

const fmt = (v: number) => String(Number(v.toPrecision(12)));

/**
 * Calibration records of a gauge, with readings and certificates. The database judges readings,
 * works out the outcome and updates the gauge (dates, quarantine); this service saves a record and
 * its readings in one transaction, then flushes that deferred gauge update before reading back.
 */
@Injectable()
export class CalibrationRecordsService {
  constructor(private readonly database: DatabaseService) {}

  list(ctx: RequestContext, gaugeId: string, q: z.infer<typeof DeletedQuery>): Promise<CalibrationSummary[]> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertGaugeVisible(db, ctx, gaugeId);
      const result = await db.execute<Row>(sql`
        ${sql.raw(CALIBRATION_SELECT)} where c.gauge_id = ${gaugeId}::uuid and ${deletedFilter('c', q.deleted)}
        order by c.calibrated_on desc, c.created_at desc`);
      return result.rows.map(toSummary);
    });
  }

  get(ctx: RequestContext, id: string): Promise<CalibrationDetail> {
    return this.database.asUser(ctx, (db) => this.load(db, ctx, id));
  }

  create(ctx: RequestContext, gaugeId: string, body: CreateCalibrationBody): Promise<CalibrationDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertGaugeVisible(db, ctx, gaugeId);
      const { readings, ...fields } = body;
      // With readings the outcome is worked out by the database; "pass" is only a placeholder.
      const { columns, values } = insertParts({ ...fields, outcome: fields.outcome ?? 'pass' }, CALIBRATION_COLUMNS, {
        organisation_id: ctx.organisationId!,
        gauge_id: gaugeId,
        reference: 'pending',
      });
      const result = await db.execute<{ id: string }>(sql`insert into public.calibrations (${columns}) values (${values}) returning id`);
      const id = result.rows[0].id;
      await this.saveReadings(db, ctx, id, readings ?? []);
      await db.execute(sql`set constraints calibrations_after immediate`);
      return this.load(db, ctx, id);
    });
  }

  update(ctx: RequestContext, id: string, body: z.infer<typeof UpdateCalibrationBody>): Promise<CalibrationDetail> {
    return this.database.asUser(ctx, async (db) => {
      const { readings, ...fields } = body;
      const sets = assignments(fields, CALIBRATION_COLUMNS);
      // Readings-only edits leave the record row alone (RLS on the readings still applies).
      if (sets.length) await this.update1(db, ctx, id, sql.join(sets, sql`, `));
      else await this.assertVisible(db, ctx, id);
      await this.saveReadings(db, ctx, id, readings ?? []);
      await db.execute(sql`set constraints calibrations_after immediate`);
      return this.load(db, ctx, id);
    });
  }

  remove(ctx: RequestContext, id: string, reason: string): Promise<CalibrationDetail> {
    return this.change(ctx, id, sql`deleted_at = now(), delete_reason = ${reason}`);
  }

  restore(ctx: RequestContext, id: string): Promise<CalibrationDetail> {
    return this.change(ctx, id, sql`deleted_at = null`);
  }

  /**
   * Raises a draft NC for a calibration found out of tolerance and links it to the record: source Calibration, and the organisation's Calibration category when it has one
   * (a person can change either). The NC's site and detection date come from the gauge and the calibration.
   */
  raiseNcr(ctx: RequestContext, id: string, customValues?: CustomValuesInput): Promise<z.infer<typeof RaisedNcr>> {
    return this.database.asUser(ctx, async (db) => {
      const cal = await this.load(db, ctx, id);
      if (cal.deletedAt) throw new ApiError(409, 'calibration_rule', 'This calibration record is deleted; restore it first');
      if (cal.outcome === 'pass') throw new ApiError(409, 'calibration_rule', 'Only a calibration found out of tolerance can raise an NC');
      const linked = await db.execute<Row>(sql`select nonconformance_id from public.calibrations where id = ${id}::uuid`);
      if (linked.rows[0]?.nonconformance_id) throw new ApiError(409, 'calibration_rule', 'An NC has already been raised for this calibration');
      const gauge = await db.execute<Row>(sql`select site_id from public.gauges where id = ${cal.gauge.id}::uuid`);

      const out = cal.readings.filter((r) => !r.asFoundOk);
      const lines = out.map((r) =>
        r.kind === 'attribute'
          ? `- ${r.name}: failed as found${r.asLeftPass !== null ? `, ${r.asLeftPass ? 'passed' : 'failed'} as left` : ''}`
          : `- ${r.name}: as found ${fmt(r.asFound!)} ${r.unitCode} (limits ${fmt(r.lower!)} to ${fmt(r.upper!)})${r.asLeft !== null ? `, as left ${fmt(r.asLeft)}` : ''}`,
      );
      const title = `Calibration ${cal.outcome === 'fail' ? 'failure' : 'out of tolerance'}: ${cal.gauge.assetNumber} ${cal.gauge.description}`.slice(0, 200);
      const description = [
        `Calibration ${cal.reference} of gauge ${cal.gauge.assetNumber} (${cal.gauge.description}) on ${cal.calibratedOn} was ${cal.outcome === 'fail' ? 'failed' : 'out of tolerance as found and adjusted'}.`,
        cal.certificateNumber ? `Certificate: ${cal.certificateNumber}.` : '',
        lines.length ? `Out of tolerance as found:\n${lines.join('\n')}` : '',
        'Review measurements taken with this gauge since its previous calibration.',
      ]
        .filter(Boolean)
        .join('\n\n');
      const created = await db.execute<Row>(sql`
        insert into public.nonconformances (organisation_id, reference, source, title, description, site_id, detected_at, detected_by, category_id)
        values (${ctx.organisationId!}::uuid, 'pending', 'calibration', ${title}, ${description}, ${(gauge.rows[0]?.site_id as string) ?? null}::uuid,
                ${cal.calibratedOn}::date, ${ctx.user.id}::uuid,
                (select id from public.ncr_classifications where organisation_id = ${ctx.organisationId!}::uuid and kind = 'category' and code = 'CALIBRATION' and active))
        returning id, reference, source`);
      const ncr = created.rows[0];
      await writeCustomValues(db, 'nonconformance', ncr.id as string, customValues);
      await this.update1(db, ctx, id, sql`nonconformance_id = ${ncr.id as string}::uuid`);
      return { id: ncr.id as string, reference: ncr.reference as string, source: ncr.source as string };
    });
  }

  // ---- attachments ---------------------------------------------------------------------------

  listAttachments(ctx: RequestContext, id: string, q: z.infer<typeof DeletedQuery>): Promise<z.infer<typeof Attachment>[]> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertVisible(db, ctx, id);
      const result = await db.execute<Row>(sql`
        ${sql.raw(ATTACHMENT_SELECT)} where a.calibration_id = ${id}::uuid and ${deletedFilter('a', q.deleted)} order by a.created_at desc`);
      return result.rows.map(toAttachment);
    });
  }

  /** Records a file the client has already uploaded to storage at <org>/calibration/<id>/<name>. */
  createAttachment(ctx: RequestContext, id: string, body: z.infer<typeof CreateAttachmentBody>): Promise<z.infer<typeof Attachment>> {
    return this.database.asUser(ctx, async (db) => {
      await this.assertVisible(db, ctx, id);
      const folder = `${ctx.organisationId}/calibration/${id}/`;
      if (!body.storagePath.startsWith(folder) || body.storagePath.includes('..') || body.storagePath.length === folder.length) {
        throw ApiError.badRequest('invalid_path', `Files for this calibration must be uploaded to ${folder}`);
      }
      const stored = await db.execute(sql`select 1 from storage.objects where bucket_id = 'calibration-files' and name = ${body.storagePath}`);
      if (!stored.rows.length) throw ApiError.badRequest('file_not_uploaded', 'Upload the file before attaching it');
      const result = await db.execute<{ id: string }>(sql`
        insert into public.calibration_attachments (organisation_id, calibration_id, storage_path, file_name, content_type, size_bytes, description)
        values (${ctx.organisationId!}::uuid, ${id}::uuid, ${body.storagePath}, ${body.fileName}, ${body.contentType ?? null}, ${body.sizeBytes}, ${body.description ?? null})
        returning id`);
      return this.loadAttachment(db, ctx, result.rows[0].id);
    });
  }

  removeAttachment(ctx: RequestContext, id: string, reason: string) {
    return this.changeAttachment(ctx, id, sql`deleted_at = now(), delete_reason = ${reason}`);
  }

  restoreAttachment(ctx: RequestContext, id: string) {
    return this.changeAttachment(ctx, id, sql`deleted_at = null`);
  }

  // ---- internals -----------------------------------------------------------------------------

  /** Adds or updates one reading per characteristic (readings are never removed, only corrected). */
  private async saveReadings(db: Db, ctx: RequestContext, id: string, readings: NonNullable<CreateCalibrationBody['readings']>) {
    for (const r of readings) {
      const [found, left, foundPass, leftPass, notes] = [r.asFound ?? null, r.asLeft ?? null, r.asFoundPass ?? null, r.asLeftPass ?? null, r.notes ?? null];
      const updated = await db.execute(sql`
        update public.calibration_readings
        set as_found = ${found}, as_left = ${left}, as_found_pass = ${foundPass}, as_left_pass = ${leftPass}, notes = ${notes}
        where calibration_id = ${id}::uuid and characteristic_id = ${r.characteristicId}::uuid returning id`);
      if (updated.rows.length) continue;
      await db.execute(sql`
        insert into public.calibration_readings (organisation_id, calibration_id, characteristic_id, as_found, as_left, as_found_pass, as_left_pass, notes)
        values (${ctx.organisationId!}::uuid, ${id}::uuid, ${r.characteristicId}::uuid, ${found}, ${left}, ${foundPass}, ${leftPass}, ${notes})`);
    }
  }

  private async assertGaugeVisible(db: Db, ctx: RequestContext, gaugeId: string) {
    const found = await db.execute(sql`select 1 from public.gauges where id = ${gaugeId}::uuid and organisation_id = ${ctx.organisationId!}::uuid`);
    if (!found.rows.length) throw ApiError.notFound('gauge_not_found', 'Gauge not found');
  }

  private async assertVisible(db: Db, ctx: RequestContext, id: string) {
    const found = await db.execute(sql`select 1 from public.calibrations where id = ${id}::uuid and organisation_id = ${ctx.organisationId!}::uuid`);
    if (!found.rows.length) throw ApiError.notFound('calibration_not_found', 'Calibration record not found');
  }

  private async update1(db: Db, ctx: RequestContext, id: string, set: SQL) {
    const result = await db.execute(sql`
      update public.calibrations set ${set} where id = ${id}::uuid and organisation_id = ${ctx.organisationId!}::uuid returning id`);
    if (!result.rows.length) {
      await this.assertVisible(db, ctx, id);
      throw ApiError.forbidden();
    }
  }

  private change(ctx: RequestContext, id: string, set: SQL): Promise<CalibrationDetail> {
    return this.database.asUser(ctx, async (db) => {
      await this.update1(db, ctx, id, set);
      await db.execute(sql`set constraints calibrations_after immediate`);
      return this.load(db, ctx, id);
    });
  }

  private changeAttachment(ctx: RequestContext, id: string, set: SQL) {
    return this.database.asUser(ctx, async (db) => {
      const result = await db.execute(sql`
        update public.calibration_attachments set ${set} where id = ${id}::uuid and organisation_id = ${ctx.organisationId!}::uuid returning id`);
      if (!result.rows.length) throw ApiError.notFound('attachment_not_found', 'File not found');
      return this.loadAttachment(db, ctx, id);
    });
  }

  private async loadAttachment(db: Db, ctx: RequestContext, id: string) {
    const result = await db.execute<Row>(sql`${sql.raw(ATTACHMENT_SELECT)} where a.id = ${id}::uuid and a.organisation_id = ${ctx.organisationId!}::uuid`);
    if (!result.rows.length) throw ApiError.notFound('attachment_not_found', 'File not found');
    return toAttachment(result.rows[0]);
  }

  private async load(db: Db, ctx: RequestContext, id: string): Promise<CalibrationDetail> {
    const result = await db.execute<Row>(sql`
      ${sql.raw(CALIBRATION_SELECT)}
      where c.id = ${id}::uuid and c.organisation_id = ${ctx.organisationId!}::uuid`);
    const r = result.rows[0];
    if (!r) throw ApiError.notFound('calibration_not_found', 'Calibration record not found');
    const gauge = await db.execute<Row>(sql`select id, asset_number, description, status, deleted_at from public.gauges where id = ${r.gauge_id as string}::uuid`);
    const readings = await db.execute<Row>(sql`
      select * from public.calibration_readings where calibration_id = ${id}::uuid order by sort_order, name`);
    const g = gauge.rows[0];
    return {
      ...toSummary(r),
      gauge: { id: g.id as string, assetNumber: g.asset_number as string, description: g.description as string, status: g.status as CalibrationDetail['gauge']['status'], deleted: !!g.deleted_at },
      procedureRef: (r.procedure_ref as string) ?? null,
      referenceStandards: (r.reference_standards as string) ?? null,
      temperatureC: num(r.temperature_c),
      humidityPct: num(r.humidity_pct),
      notes: (r.notes as string) ?? null,
      readings: readings.rows.map(toReading),
      deletedBy: ref(r.deleted_by, r.deleted_by_name, 'Unknown user'),
      deleteReason: (r.delete_reason as string) ?? null,
      updatedAt: iso(r.updated_at)!,
    };
  }
}
