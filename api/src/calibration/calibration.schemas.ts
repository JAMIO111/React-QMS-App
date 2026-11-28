import { CustomValues, CustomValuesInput } from '../custom-fields/custom-fields.schemas';
import { z } from 'zod';

export const GaugeStatus = z.enum(['active', 'in_calibration', 'quarantined', 'out_of_service', 'retired', 'lost']);
export const IntervalUnit = z.enum(['days', 'weeks', 'months', 'years']);
export const CalibrationSource = z.enum(['internal', 'external']);
export const Outcome = z.enum(['pass', 'adjusted', 'fail']);
/** variable: a measured value against nominal ± tolerance; attribute: a pass/fail check (e.g. free from damage). */
export const CharacteristicKind = z.enum(['variable', 'attribute']);
/** Where a gauge stands against its due date. Only active and in-calibration gauges are "in use". */
export const DueState = z.enum(['overdue', 'due_soon', 'ok', 'not_set', 'not_in_use']);
export const DueFilter = z.enum(['overdue', 'due_30', 'due_90', 'not_set']);

const Ref = z.object({ id: z.string().uuid(), name: z.string() }).nullable();
/** A real calendar day, not just the right shape (2026-02-31 is refused rather than left for the database to reject). */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'That is not a real date');
const dateTime = z.string().datetime({ offset: true });

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();
const id = z.string().uuid().nullable().optional();
const csv = <T extends z.ZodTypeAny>(item: T) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : []))
    .pipe(z.array(item));
const deleted = z.enum(['exclude', 'include', 'only']).default('exclude');
const value = z.number().finite().min(-1e9).max(1e9);
const tolerance = z.number().finite().min(0).max(1e9);

// ---- gauge types and characteristics --------------------------------------------------------

export const NominalBasis = z.enum(['value', 'span_percent']);
export const ToleranceBasis = z.enum(['value', 'span_percent', 'reading_percent', 'value_plus_reading_percent']);
export const Characteristic = z.object({
  id: z.string().uuid(),
  sortOrder: z.number(),
  kind: CharacteristicKind,
  name: z.string(),
  /** Limits and unit of a variable characteristic (null for attributes). */
  nominal: z.number().nullable(),
  toleranceMinus: z.number().nullable(),
  tolerancePlus: z.number().nullable(),
  /** nominal − toleranceMinus and nominal + tolerancePlus. */
  lower: z.number().nullable(),
  upper: z.number().nullable(),
  unitCode: z.string().nullable(),
  method: z.string().nullable(),
  active: z.boolean(),
  /** Gauge characteristics copied from a gauge type's template keep a link to it. */
  templateId: z.string().uuid().nullable().optional(),
  /** Where the standard's tolerance comes from, in words (for example "ISO 3611"). */
  toleranceSource: z.string().nullable().optional(),
  /**
   * On a gauge type's check: how the point and the tolerance are given. A point of `span_percent` holds a percentage of the gauge's range in
   * `nominal` (0 is the range minimum, 100 the maximum) and has no unit; the tolerance is `value` (the two sides may differ), a percentage of the
   * `span_percent` or of the reading, or `value_plus_reading_percent` (a fixed part in the two sides plus `toleranceReadingPercent` of the reading).
   * For the percentage kinds `lower` and `upper` are null: they depend on the gauge.
   */
  nominalBasis: NominalBasis.optional(),
  toleranceBasis: ToleranceBasis.optional(),
  toleranceReadingPercent: z.number().nullable().optional(),
  /** On a gauge's check: it was worked out from the gauge type and the gauge's range, and `derivation` says how. */
  followsRange: z.boolean().optional(),
  derivation: z.string().nullable().optional(),
  /** On a gauge's check that follows the range: the range or the type changed since, so Recalculate would give other values. */
  staleFromRange: z.boolean().optional(),
  /** On a gauge's check that follows the range: why it cannot be worked out now (for example the gauge has no range). */
  rangeProblem: z.string().nullable().optional(),
});
export type Characteristic = z.infer<typeof Characteristic>;

const characteristicFields = {
  sortOrder: z.number().int().min(0).max(10000).optional(),
  kind: CharacteristicKind.optional(),
  name: z.string().trim().min(1).max(120),
  nominal: value.nullable().optional(),
  toleranceMinus: tolerance.nullable().optional(),
  tolerancePlus: tolerance.nullable().optional(),
  unitCode: z.string().trim().min(1).max(16).nullable().optional(),
  method: text(500),
  toleranceSource: z.string().trim().max(200).transform((v) => (v === '' ? null : v)).nullable().optional(),
};
const LIMITS = ['nominal', 'toleranceMinus', 'tolerancePlus', 'unitCode'] as const;
const NO_LIMITS = { nominal: null, toleranceMinus: null, tolerancePlus: null, unitCode: null } as const;
// On a gauge: ordinary values only (a gauge's own check never follows a rule).
export const CreateCharacteristicBody = z
  .object(characteristicFields)
  .strict()
  .transform((b) => (b.kind === 'attribute' ? { ...b, ...NO_LIMITS } : { ...b, kind: 'variable' as const }))
  .refine((b) => b.kind === 'attribute' || LIMITS.every((k) => b[k] !== null && b[k] !== undefined), {
    message: 'A measured characteristic needs a nominal, both tolerances and a unit',
    path: ['nominal'],
  });
export const UpdateCharacteristicBody = z
  .object({
    ...characteristicFields,
    name: characteristicFields.name.optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' })
  // Switching to a pass/fail check drops the limits; switching to measured needs them all.
  .transform((b) => (b.kind === 'attribute' ? { ...b, ...NO_LIMITS } : b))
  .refine((b) => b.kind !== 'variable' || LIMITS.every((k) => b[k] !== null && b[k] !== undefined), {
    message: 'A measured characteristic needs a nominal, both tolerances and a unit',
    path: ['nominal'],
  });

// On a gauge type: the point may be a percentage of the gauge's range and the tolerance may be worked out four ways (the database holds the same rules).
const typeFields = {
  ...characteristicFields,
  nominalBasis: NominalBasis.optional(),
  toleranceBasis: ToleranceBasis.optional(),
  toleranceReadingPercent: z.number().finite().gt(0).max(100).nullable().optional(),
};
const MESSAGE = { path: ['nominal'] as (string | number)[] };
const decimals = (n: number, places: number) => Math.abs(n * 10 ** places - Math.round(n * 10 ** places)) < 1e-7;
/** The shape rules of a measured check on a type, given everything the check will hold (`b` after defaults). Returns the first problem or null. */
export function typeCheckProblem(b: {
  kind?: 'variable' | 'attribute';
  nominal?: number | null;
  toleranceMinus?: number | null;
  tolerancePlus?: number | null;
  unitCode?: string | null;
  nominalBasis?: 'value' | 'span_percent';
  toleranceBasis?: 'value' | 'span_percent' | 'reading_percent' | 'value_plus_reading_percent';
  toleranceReadingPercent?: number | null;
}): string | null {
  if (b.kind === 'attribute') return null;
  const nb = b.nominalBasis ?? 'value';
  const tb = b.toleranceBasis ?? 'value';
  if (b.nominal == null || b.toleranceMinus == null || b.tolerancePlus == null) return 'A measured characteristic needs a nominal, both tolerances and a unit';
  if (nb === 'value' && !b.unitCode) return 'A measured characteristic needs a nominal, both tolerances and a unit';
  if (nb === 'span_percent') {
    if (b.unitCode) return "A point given as a percentage of the gauge's range uses the gauge's unit: leave the unit out";
    if (b.nominal < 0 || b.nominal > 100) return "The point is a percentage of the gauge's range: between 0 and 100";
    if (!decimals(b.nominal, 3)) return 'The point may have at most three decimals';
  }
  if (tb === 'value') {
    if (b.toleranceReadingPercent != null) return 'The percentage of the reading belongs only to a tolerance of a fixed part plus a percentage of the reading';
  } else if (tb === 'span_percent' || tb === 'reading_percent') {
    if (b.toleranceReadingPercent != null) return 'The percentage of the reading belongs only to a tolerance of a fixed part plus a percentage of the reading';
    if (b.toleranceMinus !== b.tolerancePlus) return 'A tolerance given as a percentage is the same on both sides';
    if (b.toleranceMinus <= 0 || b.toleranceMinus > 100) return 'A tolerance given as a percentage is more than 0 and at most 100';
  } else {
    if (b.toleranceMinus !== b.tolerancePlus) return 'A tolerance with a percentage of the reading is the same on both sides';
    if (b.toleranceReadingPercent == null) return 'Give the percentage of the reading';
  }
  return null;
}
export const CreateTypeCharacteristicBody = z
  .object(typeFields)
  .strict()
  .transform((b) => (b.kind === 'attribute' ? { ...b, ...NO_LIMITS, nominalBasis: 'value' as const, toleranceBasis: 'value' as const, toleranceReadingPercent: null } : { ...b, kind: 'variable' as const }))
  .superRefine((b, ctx) => {
    const problem = typeCheckProblem({ ...b, kind: b.kind });
    if (problem) ctx.addIssue({ code: 'custom', message: problem, ...MESSAGE });
  });
export const UpdateTypeCharacteristicBody = z
  .object({ ...typeFields, name: typeFields.name.optional(), active: z.boolean().optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' })
  .transform((b) =>
    b.kind === 'attribute' ? { ...b, ...NO_LIMITS, nominalBasis: 'value' as const, toleranceBasis: 'value' as const, toleranceReadingPercent: null } : b,
  );

/** A gauge type's code: what identifies it in the app and in imports (unique per organisation, any case). */
const GaugeTypeCode = z.string().trim().min(1).max(40);
export const GaugeType = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** The controlled document that is the calibration procedure for gauges of this type; a new calibration starts with its number. */
  procedureDocumentId: z.string().uuid().nullable(),
  /** The document in words; null when there is none, or when the caller may not read it. */
  procedureDocument: z.object({ id: z.string().uuid(), number: z.string(), title: z.string(), status: z.string() }).nullable(),
  intervalValue: z.number(),
  intervalUnit: IntervalUnit,
  active: z.boolean(),
  characteristicCount: z.number(),
  gaugeCount: z.number(),
  /** Gauges of this type in use (not deleted, retired or lost) missing at least one of its active checks. */
  gaugesMissingChecks: z.number(),
  /** Active checks whose point or tolerance depends on the gauge's range: a gauge of this type needs a range and a unit. */
  rangeCheckCount: z.number(),
  customValues: CustomValues.optional(),
});
/** What applying a type's checks to its gauges did. */
export const ApplyTypeCharacteristicsResult = z.object({
  gaugesUpdated: z.number(),
  characteristicsAdded: z.number(),
  /** Gauges missing checks at sites where the caller does not manage calibration (left as they are). */
  gaugesSkipped: z.number(),
  /** Gauges that could not be given a check that depends on their range (no range or unit, or the tolerance works out to nothing), and why (first 20). */
  gaugesWithProblems: z.number(),
  problems: z.array(z.object({ gaugeId: z.string().uuid(), assetNumber: z.string(), checkId: z.string().uuid().nullable(), name: z.string().nullable(), problem: z.string() })),
  type: GaugeType,
});

/** "What would this type's checks become for a gauge with this range?" Nothing is saved. */
export const PreviewPointsBody = z
  .object({
    rangeMin: z.number().finite().min(-1e9).max(1e9),
    rangeMax: z.number().finite().min(-1e9).max(1e9),
    unitCode: z.string().trim().min(1).max(16),
    resolution: z.number().finite().gt(0).max(1e9).nullable().optional(),
  })
  .strict()
  .refine((b) => b.rangeMax > b.rangeMin, { message: 'The range maximum must be above the minimum', path: ['rangeMax'] });
export const PreviewedCheck = z.object({
  checkId: z.string().uuid(),
  name: z.string(),
  method: z.string().nullable(),
  sortOrder: z.number(),
  kind: CharacteristicKind,
  nominal: z.number().nullable(),
  toleranceMinus: z.number().nullable(),
  tolerancePlus: z.number().nullable(),
  lower: z.number().nullable(),
  upper: z.number().nullable(),
  unit: z.string().nullable(),
  derivation: z.string().nullable(),
  followsRange: z.boolean(),
  toleranceSource: z.string().nullable(),
  problem: z.string().nullable(),
});
export const PreviewPointsResult = z.object({ needsRange: z.boolean(), hasRange: z.boolean(), checks: z.array(PreviewedCheck) });
/** What Recalculate did on a gauge: checks changed, checks that already matched, checks that could not be worked out. */
export const RecalculateResult = z.object({
  updated: z.number(),
  unchanged: z.number(),
  problems: z.array(z.object({ checkId: z.string().uuid(), name: z.string(), problem: z.string() })),
});
export const GaugeTypeQuery = z.object({
  includeInactive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
export const CreateGaugeTypeBody = z
  .object({
    code: GaugeTypeCode,
    name: z.string().trim().min(1).max(100),
    description: text(1000),
    procedureDocumentId: z.string().uuid().nullable().optional(),
    intervalValue: z.number().int().min(1).max(3650).optional(),
    intervalUnit: IntervalUnit.optional(),
    customValues: CustomValuesInput.optional(),
  })
  .strict();
export const UpdateGaugeTypeBody = z
  .object({
    code: GaugeTypeCode.optional(),
    name: z.string().trim().min(1).max(100).optional(),
    description: text(1000),
    procedureDocumentId: z.string().uuid().nullable().optional(),
    intervalValue: z.number().int().min(1).max(3650).optional(),
    intervalUnit: IntervalUnit.optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });
export const CharacteristicQuery = z.object({
  includeInactive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

// ---- gauges ---------------------------------------------------------------------------------

export const GaugeSummary = z.object({
  id: z.string().uuid(),
  assetNumber: z.string(),
  description: z.string(),
  type: Ref,
  manufacturer: z.string().nullable(),
  model: z.string().nullable(),
  serialNumber: z.string().nullable(),
  site: z.object({ id: z.string().uuid(), code: z.string(), name: z.string() }).nullable(),
  department: Ref,
  /** The machine the gauge is fixed to (optional), beside the typed location. */
  machine: z.object({ id: z.string().uuid(), code: z.string(), name: z.string(), siteId: z.string().uuid().nullable() }).nullable(),
  location: z.string().nullable(),
  custodian: Ref,
  rangeMin: z.number().nullable(),
  rangeMax: z.number().nullable(),
  unitCode: z.string().nullable(),
  resolution: z.number().nullable(),
  calibrationSource: CalibrationSource,
  supplier: Ref,
  intervalValue: z.number(),
  intervalUnit: IntervalUnit,
  status: GaugeStatus,
  statusReason: z.string().nullable(),
  lastCalibratedOn: isoDate.nullable(),
  nextDueOn: isoDate.nullable(),
  /** Days from today to the due date (negative when overdue). */
  daysUntilDue: z.number().nullable(),
  dueState: DueState,
  lastOutcome: Outcome.nullable(),
  calibrationCount: z.number(),
  deletedAt: dateTime.nullable(),
  createdAt: dateTime,
  customValues: CustomValues.optional(),
});
export type GaugeSummary = z.infer<typeof GaugeSummary>;

export const GaugeDetail = GaugeSummary.extend({
  commissionedOn: isoDate.nullable(),
  notes: z.string().nullable(),
  statusChangedAt: dateTime.nullable(),
  createdBy: Ref,
  deletedBy: Ref,
  deleteReason: z.string().nullable(),
  updatedAt: dateTime,
});
export type GaugeDetail = z.infer<typeof GaugeDetail>;

export const GaugePage = z.object({ data: z.array(GaugeSummary), page: z.number(), pageSize: z.number(), total: z.number() });

export const GAUGE_SORTABLE = [
  'assetNumber', 'description', 'type', 'status', 'nextDueOn', 'lastCalibratedOn', 'site', 'location', 'manufacturer',
  'serialNumber', 'lastOutcome', 'interval', 'machine', 'createdAt',
] as const;

export const GaugeListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: csv(GaugeStatus),
  due: csv(DueFilter),
  typeId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  machineId: z.string().uuid().optional(),
  supplierId: z.string().uuid().optional(),
  source: CalibrationSource.optional(),
  outcome: csv(Outcome),
  /** Next due on or after / before (YYYY-MM-DD). */
  from: isoDate.optional(),
  to: isoDate.optional(),
  deleted,
  sort: z.enum(GAUGE_SORTABLE).default('nextDueOn'),
  order: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type GaugeListQuery = z.infer<typeof GaugeListQuery>;

const gaugeFields = {
  assetNumber: z.string().trim().min(1).max(40),
  description: z.string().trim().min(1).max(200),
  gaugeTypeId: id,
  manufacturer: text(100),
  model: text(100),
  serialNumber: text(100),
  siteId: id,
  departmentId: id,
  machineId: id,
  location: text(200),
  custodianId: id,
  rangeMin: value.nullable().optional(),
  rangeMax: value.nullable().optional(),
  unitCode: z.string().trim().min(1).max(16).nullable().optional(),
  resolution: z.number().finite().positive().max(1e9).nullable().optional(),
  calibrationSource: CalibrationSource.optional(),
  supplierId: id,
  intervalValue: z.number().int().min(1).max(3650).nullable().optional(),
  intervalUnit: IntervalUnit.nullable().optional(),
  status: GaugeStatus.optional(),
  statusReason: text(500),
  lastCalibratedOn: isoDate.nullable().optional(),
  nextDueOn: isoDate.nullable().optional(),
  commissionedOn: isoDate.nullable().optional(),
  notes: text(5000),
};
export const CreateGaugeBody = z
  .object({ ...gaugeFields, gaugeTypeId: z.string({ required_error: 'Choose a gauge type', invalid_type_error: 'Choose a gauge type' }).uuid({ message: 'Choose a gauge type' }), customValues: CustomValuesInput.optional() })
  .strict();
export type CreateGaugeBody = z.infer<typeof CreateGaugeBody>;
export const UpdateGaugeBody = z
  .object({
    ...gaugeFields,
    assetNumber: gaugeFields.assetNumber.optional(),
    description: gaugeFields.description.optional(),
    // A gauge type, once chosen, can be changed but not cleared (the database holds the same rule).
    gaugeTypeId: z.string().uuid().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });
export type UpdateGaugeBody = z.infer<typeof UpdateGaugeBody>;

export const DeleteBody = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();
export const DeletedQuery = z.object({ deleted });

export const HistoryEntry = z.object({
  id: z.string().uuid(),
  at: dateTime,
  actor: Ref,
  /** gauges or gauge_characteristics */
  entityType: z.string(),
  entityId: z.string(),
  action: z.string(),
  changedFields: z.array(z.string()),
  previous: z.record(z.unknown()).nullable(),
  current: z.record(z.unknown()).nullable(),
  reason: z.string().nullable(),
  source: z.string(),
  names: z.record(z.string()),
});

// ---- calibrations ---------------------------------------------------------------------------

export const Reading = z.object({
  id: z.string().uuid(),
  characteristicId: z.string().uuid().nullable(),
  sortOrder: z.number(),
  kind: CharacteristicKind,
  name: z.string(),
  nominal: z.number().nullable(),
  toleranceMinus: z.number().nullable(),
  tolerancePlus: z.number().nullable(),
  lower: z.number().nullable(),
  upper: z.number().nullable(),
  unitCode: z.string().nullable(),
  /** Measured values (variable characteristics). */
  asFound: z.number().nullable(),
  asLeft: z.number().nullable(),
  /** Pass/fail (attribute characteristics). */
  asFoundPass: z.boolean().nullable(),
  asLeftPass: z.boolean().nullable(),
  asFoundOk: z.boolean(),
  asLeftOk: z.boolean().nullable(),
  notes: z.string().nullable(),
  /** How the limits were worked out when the check was given as a percentage of the gauge's range or of the reading (kept with the reading). */
  derivation: z.string().nullable(),
  /** Where the tolerance comes from, in words (for example "ISO 3611"). */
  toleranceSource: z.string().nullable(),
});

export const CalibrationSummary = z.object({
  id: z.string().uuid(),
  reference: z.string(),
  gaugeId: z.string().uuid(),
  calibratedOn: isoDate,
  performedBy: CalibrationSource,
  technician: Ref,
  supplier: Ref,
  certificateNumber: z.string().nullable(),
  /** A record imported from an old system: the outcome it concluded, no readings. */
  legacy: z.boolean(),
  importedFrom: z.string().nullable(),
  importedTechnician: z.string().nullable(),
  outcome: Outcome,
  nextDueOn: isoDate.nullable(),
  readingCount: z.number(),
  failedCount: z.number(),
  attachmentCount: z.number(),
  nonconformance: z.object({ id: z.string().uuid(), reference: z.string(), source: z.string() }).nullable(),
  createdBy: Ref,
  createdAt: dateTime,
  deletedAt: dateTime.nullable(),
});
export type CalibrationSummary = z.infer<typeof CalibrationSummary>;

export const CalibrationDetail = CalibrationSummary.extend({
  gauge: z.object({ id: z.string().uuid(), assetNumber: z.string(), description: z.string(), status: GaugeStatus, deleted: z.boolean() }),
  procedureRef: z.string().nullable(),
  referenceStandards: z.string().nullable(),
  temperatureC: z.number().nullable(),
  humidityPct: z.number().nullable(),
  notes: z.string().nullable(),
  readings: z.array(Reading),
  deletedBy: Ref,
  deleteReason: z.string().nullable(),
  updatedAt: dateTime,
});
export type CalibrationDetail = z.infer<typeof CalibrationDetail>;

/** A value for a measured characteristic, or pass/fail for a check. */
const ReadingInput = z
  .object({
    characteristicId: z.string().uuid(),
    asFound: value.nullable().optional(),
    asLeft: value.nullable().optional(),
    asFoundPass: z.boolean().nullable().optional(),
    asLeftPass: z.boolean().nullable().optional(),
    notes: text(500),
  })
  .strict()
  .refine((r) => (r.asFound !== undefined && r.asFound !== null) !== (r.asFoundPass !== undefined && r.asFoundPass !== null), {
    message: 'Give either an as-found value or pass/fail',
    path: ['asFound'],
  });

const calibrationFields = {
  calibratedOn: isoDate.optional(),
  performedBy: CalibrationSource.optional(),
  technicianId: id,
  supplierId: id,
  certificateNumber: text(100),
  procedureRef: text(200),
  referenceStandards: text(1000),
  temperatureC: z.number().finite().min(-50).max(100).nullable().optional(),
  humidityPct: z.number().finite().min(0).max(100).nullable().optional(),
  /** Required when there are no readings; worked out from the readings otherwise. */
  outcome: Outcome.optional(),
  nextDueOn: isoDate.nullable().optional(),
  notes: text(5000),
  readings: z.array(ReadingInput).max(200).optional(),
};
export const CreateCalibrationBody = z
  .object(calibrationFields)
  .strict()
  .refine((b) => (b.readings?.length ?? 0) > 0 || b.outcome !== undefined, {
    message: 'Enter readings or choose an outcome',
    path: ['outcome'],
  })
  .refine((b) => new Set((b.readings ?? []).map((r) => r.characteristicId)).size === (b.readings?.length ?? 0), {
    message: 'One reading per characteristic',
    path: ['readings'],
  });
export type CreateCalibrationBody = z.infer<typeof CreateCalibrationBody>;
export const UpdateCalibrationBody = z
  .object(calibrationFields)
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' })
  .refine((b) => new Set((b.readings ?? []).map((r) => r.characteristicId)).size === (b.readings?.length ?? 0), {
    message: 'One reading per characteristic',
    path: ['readings'],
  });
export type UpdateCalibrationBody = z.infer<typeof UpdateCalibrationBody>;

export const RaisedNcr = z.object({ id: z.string().uuid(), reference: z.string(), source: z.string() });

export const Attachment = z.object({
  id: z.string().uuid(),
  fileName: z.string(),
  contentType: z.string().nullable(),
  sizeBytes: z.number(),
  description: z.string().nullable(),
  storagePath: z.string(),
  createdAt: dateTime,
  createdBy: Ref,
  deletedAt: dateTime.nullable(),
  deleteReason: z.string().nullable(),
});
export const CreateAttachmentBody = z
  .object({
    storagePath: z.string().trim().min(1).max(500),
    fileName: z.string().trim().min(1).max(255),
    contentType: z.string().trim().max(200).nullable().optional(),
    sizeBytes: z.number().int().min(0).max(26214400),
    description: text(500),
  })
  .strict();

// ---- dashboard ------------------------------------------------------------------------------

export const DashboardQuery = z
  .object({ from: isoDate, to: isoDate })
  .refine((q) => q.from <= q.to, { message: '"from" must be on or before "to"', path: ['from'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 3 * 366, { message: 'At most three years', path: ['from'] });

const Count = z.object({ key: z.string(), label: z.string(), count: z.number() });
export const Dashboard = z.object({
  period: z.object({ from: isoDate, to: isoDate, previousFrom: isoDate, previousTo: isoDate, bucket: z.enum(['week', 'month']) }),
  today: isoDate,
  kpis: z.object({
    gauges: z.number(),
    inUse: z.number(),
    overdue: z.number(),
    dueNext30: z.number(),
    quarantined: z.number(),
    calibrated: z.number(),
    calibratedPrevious: z.number(),
    failed: z.number(),
    /** Share of calibrations in the period that passed as found (0–100), null without any. */
    firstTimePassRate: z.number().nullable(),
    /** Share of in-use gauges that are not overdue (0–100), null without any. */
    compliance: z.number().nullable(),
  }),
  /** Imported history: whether the period figures count it, and how many legacy records fall in the period. */
  legacy: z.object({ included: z.boolean(), inPeriod: z.number() }),
  dueSchedule: z.array(z.object({ start: isoDate, count: z.number() })),
  outcomes: z.array(z.object({ start: isoDate, pass: z.number(), adjusted: z.number(), fail: z.number() })),
  byStatus: z.array(Count),
  byType: z.array(Count),
  attention: z.array(
    z.object({
      id: z.string().uuid(),
      assetNumber: z.string(),
      description: z.string(),
      status: GaugeStatus,
      nextDueOn: isoDate.nullable(),
      daysUntilDue: z.number().nullable(),
      site: z.string().nullable(),
    }),
  ),
});
export type Dashboard = z.infer<typeof Dashboard>;
