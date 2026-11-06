import { z } from 'zod';
import { ListQuery } from '../common/pagination';

const Iso = z.string().datetime({ offset: true });
const Ref = z.object({ id: z.string().uuid(), name: z.string() });
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();
export const Trigger = z.enum(['first_off', 'last_off', 'every_n_minutes', 'every_n_parts', 'start_of_shift', 'after_tool_change', 'after_setup', 'manual']);

/**
 * A measured value exactly as entered: a JSON number or a decimal string (e.g. "25.0500"). It is passed
 * to the database as text and stored as NUMERIC, so nothing is rounded on the way.
 */
export const DecimalInput = z
  .union([z.number().finite(), z.string().trim()])
  .transform((v) => String(v))
  .pipe(z.string().regex(/^-?\d{1,12}(\.\d{1,12})?$/, 'Enter a number, e.g. 25.05'));

export const InspectionListQuery = ListQuery.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['in_progress', 'completed', 'abandoned']).optional(),
  result: z.enum(['pass', 'fail']).optional(),
  partId: z.string().uuid().optional(),
});

export const InspectionSummary = z.object({
  id: z.string().uuid(),
  reference: z.string(),
  status: z.enum(['in_progress', 'completed', 'abandoned']),
  result: z.enum(['pass', 'fail']).nullable(),
  part: z.object({ id: z.string().uuid(), partNumber: z.string(), name: z.string() }),
  partRevision: z.string(),
  plan: z.object({ id: z.string().uuid(), planCode: z.string(), revisionCode: z.string() }),
  operationCode: z.string().nullable(),
  site: Ref,
  machine: z.object({ id: z.string().uuid(), code: z.string(), name: z.string() }).nullable(),
  workOrder: z.string().nullable(),
  lot: z.string().nullable(),
  lotSize: z.number().int().nullable(),
  serial: z.string().nullable(),
  triggerType: Trigger,
  startedAt: Iso,
  startedBy: Ref.nullable(),
  /** Current readings that failed (corrected readings excluded). */
  failures: z.number().int(),
});
export type InspectionSummary = z.infer<typeof InspectionSummary>;

export const NcrRef = z.object({
  id: z.string().uuid(),
  reference: z.string(),
  stage: z.string(),
  title: z.string(),
  /** Quantity affected as recorded on the NC (proposed, with the new samples, when readings are added). */
  quantityAffected: z.number().nullable().optional(),
  /** Deleted NCs no longer handle their readings (with cancelled ones). */
  deleted: z.boolean().optional(),
});
export type NcrRef = z.infer<typeof NcrRef>;

export const Requirement = z.object({
  id: z.string().uuid(),
  sequence: z.number().int(),
  characteristicKey: z.string(),
  charNumber: z.string().nullable(),
  name: z.string(),
  operationCode: z.string(),
  dataType: z.enum(['variable', 'attribute', 'count']),
  valueSource: z.enum(['plan', 'part_spec']),
  specKey: z.string().nullable(),
  applicable: z.boolean(),
  applicability: z.string(),
  nominal: z.number().nullable(),
  lowerLimit: z.number().nullable(),
  upperLimit: z.number().nullable(),
  unitCode: z.string().nullable(),
  method: z.string().nullable(),
  gaugeType: Ref.nullable(),
  criticality: z.enum(['critical', 'major', 'minor']),
  spcEligible: z.boolean(),
  chartType: z.enum(['imr', 'xbar_r', 'p', 'defects']).nullable(),
  subgroupSize: z.number().int().nullable(),
  decimals: z.number().int().nullable(),
  sampling: z.array(z.object({ triggerType: Trigger, intervalValue: z.number().int().nullable(), sampleSize: z.number().int() })),
  reactions: z.array(z.object({ triggerType: z.string(), action: z.string(), instruction: z.string() })),
});
export const Sample = z.object({
  id: z.string().uuid(),
  sampleNumber: z.number().int(),
  sampledAt: Iso,
  unitReference: z.string().nullable(),
  triggerType: Trigger,
  isRetest: z.boolean(),
  /** Samples taken at one check share a subgroup (X-bar/R); null for retests and older samples. */
  subgroupNumber: z.number().int().nullable(),
  notes: z.string().nullable(),
  takenBy: Ref.nullable(),
});
export const Measurement = z.object({
  id: z.string().uuid(),
  sampleId: z.string().uuid(),
  requirementId: z.string().uuid(),
  /** Exactly as stored (decimal string), never rounded. */
  valueNumeric: z.string().nullable(),
  valuePass: z.boolean().nullable(),
  valueCount: z.number().int().nullable(),
  unitCode: z.string().nullable(),
  result: z.enum(['pass', 'fail']),
  gauge: z
    .object({ id: z.string().uuid(), assetNumber: z.string(), status: z.string(), nextDueOn: z.string().nullable(), valid: z.boolean() })
    .nullable(),
  gaugeOverrideReason: z.string().nullable(),
  measuredAt: Iso,
  measuredBy: Ref.nullable(),
  supersedesId: z.string().uuid().nullable(),
  /** Set when a later correction replaced this reading. */
  supersededById: z.string().uuid().nullable(),
  correctionReason: z.string().nullable(),
  retestOfId: z.string().uuid().nullable(),
  notes: z.string().nullable(),
  /** A person has seen this failed reading and said what is being done (PC5). */
  acknowledgement: z.object({ note: z.string(), at: Iso, by: Ref.nullable() }).nullable(),
  /** Non-conformances raised from this reading (those the caller may see). */
  ncrs: z.array(NcrRef),
});
export const InspectionDetail = InspectionSummary.extend({
  notes: z.string().nullable(),
  completedAt: Iso.nullable(),
  completedBy: Ref.nullable(),
  abandonReason: z.string().nullable(),
  requirements: z.array(Requirement),
  /** The planned samples in the order they must be recorded, from the plan's sampling rules and the lot size. */
  schedule: z.array(z.object({ number: z.number().int(), position: z.number().int(), trigger: Trigger, requirementIds: z.array(z.string().uuid()) })),
  samples: z.array(Sample),
  measurements: z.array(Measurement),
  /** Every non-conformance raised from this inspection (readings or the inspection as a whole). */
  ncrs: z.array(NcrRef),
});
export type InspectionDetail = z.infer<typeof InspectionDetail>;

export const StartInspectionBody = z
  .object({
    siteId: z.string().uuid(),
    partId: z.string().uuid(),
    operationCode: z.string().trim().max(30).optional(),
    machineId: z.string().uuid().nullable().optional(),
    workOrder: optionalText(60),
    lot: optionalText(60),
    lotSize: z.number().int().min(1).max(100000000).nullable().optional(),
    serial: optionalText(60),
    triggerType: Trigger.optional(),
    partRevisionId: z.string().uuid().optional(),
    notes: optionalText(2000),
  })
  .strict();

const ReadingInput = z
  .object({
    requirementId: z.string().uuid(),
    valueNumeric: DecimalInput.optional(),
    valuePass: z.boolean().optional(),
    /** Defects found on this unit (a defect count check). */
    valueCount: z.number().int().min(0).max(100000).optional(),
    gaugeId: z.string().uuid().nullable().optional(),
    gaugeOverrideReason: optionalText(1000),
    retestOfId: z.string().uuid().optional(),
    notes: optionalText(1000),
  })
  .strict()
  .refine((r) => [r.valueNumeric, r.valuePass, r.valueCount].filter((v) => v !== undefined).length === 1, { message: 'Give a measured value, pass/fail or a defect count' });
/** A sampling occasion with its readings, saved together. */
export const AddSampleBody = z
  .object({
    unitReference: optionalText(60),
    triggerType: Trigger.optional(),
    isRetest: z.boolean().optional(),
    /** Start a new subgroup now instead of joining the current one. */
    newSubgroup: z.boolean().optional(),
    notes: optionalText(1000),
    readings: z.array(ReadingInput).min(1).max(200),
  })
  .strict();
export const CorrectionBody = z
  .object({
    valueNumeric: DecimalInput.optional(),
    valuePass: z.boolean().optional(),
    valueCount: z.number().int().min(0).max(100000).optional(),
    gaugeId: z.string().uuid().nullable().optional(),
    gaugeOverrideReason: optionalText(1000),
    reason: z.string().trim().min(1, 'Say why the reading is corrected').max(1000),
  })
  .strict()
  .refine((r) => [r.valueNumeric, r.valuePass, r.valueCount].filter((v) => v !== undefined).length === 1, { message: 'Give the corrected value, pass/fail or defect count' });
export const AbandonBody = z.object({ reason: z.string().trim().min(1, 'Give a reason').max(2000) }).strict();

// ---- NC integration (PC5) -----------------------------------------------------------------------

export const Severity = z.enum(['critical', 'major', 'minor']);
export const DraftQuery = z.object({
  /**
   * Comma-separated failed readings. Absent: the current failed readings that have no NC yet.
   * Present but empty (`measurementIds=`): none — the suggestion for a manual NC.
   */
  measurementIds: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v.split(',').map((x) => x.trim()).filter(Boolean)))
    .pipe(z.array(z.string().uuid()).max(200).optional()),
});
export const NcDraft = z.object({
  title: z.string(),
  description: z.string(),
  severity: Severity.nullable(),
  quantityAffected: z.number().nullable(),
  requirement: z.string(),
  actualResult: z.string(),
  /** The readings the NC would cover (empty: a manual NC for the inspection as a whole). */
  readings: z.array(
    z.object({
      id: z.string().uuid(),
      requirementName: z.string(),
      sampleNumber: z.number().int(),
      value: z.string(),
      limits: z.string(),
      measuredAt: Iso,
      alreadyLinked: z.array(NcrRef),
    }),
  ),
  /** Per check: the last good reading before the first selected failure (null: none in this inspection). */
  containment: z.array(
    z.object({
      name: z.string(),
      lastGood: z.object({ sampleNumber: z.number().int(), measuredAt: Iso, value: z.string() }).nullable(),
      firstFailure: z.object({ sampleNumber: z.number().int(), measuredAt: Iso, value: z.string() }),
    }),
  ),
});
export type NcDraft = z.infer<typeof NcDraft>;

export const RaiseNcrBody = z
  .object({
    /** Failed readings the NC covers; empty for a defect no measurement caught. */
    measurementIds: z.array(z.string().uuid()).max(200).default([]),
    title: z.string().trim().min(1, 'Give the non-conformance a title').max(200),
    description: optionalText(10000),
    severity: Severity.nullable().optional(),
    quantityAffected: z.number().min(0).max(1_000_000_000).nullable().optional(),
    requirement: optionalText(4000),
    actualResult: optionalText(4000),
    /** Create straight into "open" (needs severity and quantity). */
    open: z.boolean().optional(),
  })
  .strict();
/** Add failed readings of this inspection to an NC already raised from it (not closed or cancelled). */
export const AddToNcrBody = z
  .object({
    ncrId: z.string().uuid(),
    measurementIds: z.array(z.string().uuid()).min(1).max(200),
    /** New quantity affected; omit to leave the NC's figure alone. */
    quantityAffected: z.number().min(0).max(1_000_000_000).nullable().optional(),
  })
  .strict();
export const RaisedNcr = z.object({
  ncr: z.object({ id: z.string().uuid(), reference: z.string(), stage: z.string(), source: z.string() }),
  inspection: InspectionDetail,
});
export const AcknowledgeBody = z.object({ note: z.string().trim().min(1, 'Say what is being done').max(1000) }).strict();

export const NcrInspectionSource = z.object({
  inspections: z.array(
    z.object({
      id: z.string().uuid(),
      reference: z.string(),
      status: z.enum(['in_progress', 'completed', 'abandoned']),
      result: z.enum(['pass', 'fail']).nullable(),
      part: z.object({ id: z.string().uuid(), partNumber: z.string(), name: z.string() }),
      plan: z.object({ id: z.string().uuid(), planCode: z.string(), revisionCode: z.string() }),
      operationCode: z.string().nullable(),
      startedAt: Iso,
      /** True when the NC covers the inspection as a whole (no reading linked). */
      wholeInspection: z.boolean(),
      readings: z.array(
        z.object({
          id: z.string().uuid(),
          requirementName: z.string(),
          sampleNumber: z.number().int(),
          valueNumeric: z.string().nullable(),
          valuePass: z.boolean().nullable(),
          valueCount: z.number().int().nullable(),
          unitCode: z.string().nullable(),
          limits: z.string(),
          result: z.enum(['pass', 'fail']),
          measuredAt: Iso,
          gaugeAssetNumber: z.string().nullable(),
          /** The latest reading that replaced this one, if it was corrected afterwards. */
          correctedTo: z.object({ valueNumeric: z.string().nullable(), valuePass: z.boolean().nullable(), valueCount: z.number().int().nullable(), result: z.enum(['pass', 'fail']), reason: z.string().nullable() }).nullable(),
        }),
      ),
    }),
  ),
});

export const GaugeUsage = z.object({
  calibration: z.object({ id: z.string().uuid(), reference: z.string(), calibratedOn: z.string(), outcome: z.string() }),
  gauge: z.object({ id: z.string().uuid(), assetNumber: z.string() }),
  /** The calibration before this one; the period starts on its date (null: from the start). */
  previous: z.object({ reference: z.string(), calibratedOn: z.string() }).nullable(),
  inspections: z.array(
    z.object({
      id: z.string().uuid(),
      reference: z.string(),
      status: z.string(),
      partNumber: z.string(),
      readings: z.number().int(),
      failedReadings: z.number().int(),
      overrides: z.number().int(),
      firstUsed: Iso,
      lastUsed: Iso,
    }),
  ),
  totals: z.object({ inspections: z.number().int(), readings: z.number().int(), failedReadings: z.number().int() }),
});
