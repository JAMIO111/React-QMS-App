import { z } from 'zod';
import { Trigger } from '../inspection/inspection.schemas';
import { TableSettings } from './profile-settings';

const Reason = z.string().trim().min(3).max(1000);

export const ProfileBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).nullish(),
    format: z.literal('table').default('table'),
    defaultGaugeId: z.string().uuid().nullish(),
    settings: TableSettings,
  })
  .strict();

export const ProfilePatchBody = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).nullish(),
    defaultGaugeId: z.string().uuid().nullish(),
    settings: TableSettings.optional(),
    /** Needed when the settings change (a new version). */
    reason: Reason.optional(),
  })
  .strict();

export const RetireBody = z.object({ reason: Reason }).strict();

export const ProfileListQuery = z.object({ all: z.enum(['true', 'false']).optional() });

/** Try a file against settings: nothing is saved. The file comes in the body (at most 2 MB). */
export const TryBody = z
  .object({
    settings: TableSettings,
    fileName: z.string().trim().min(1).max(255),
    contentBase64: z.string().min(1).max(2_800_000),
  })
  .strict();

export const CreateImportBody = z
  .object({
    path: z.string().min(1).max(500),
    fileName: z.string().trim().min(1).max(255),
    profileId: z.string().uuid(),
    gaugeId: z.string().uuid().nullish(),
  })
  .strict();

export const MatchBody = z
  .object({
    requirementId: z.string().uuid().nullable(),
    /** Also save it as the part's feature map, so later files of the part match the same way. */
    remember: z.boolean().default(false),
  })
  .strict();

/** Apply a preview: new readings (default), a retest of the failed readings, or a correction of a part already measured (needs a reason). */
export const ApplyBody = z
  .object({
    mode: z.enum(['new', 'retest', 'correct']).default('new'),
    reason: z.string().trim().min(3).max(1000).nullish(),
    /** The gauge the readings were taken with; left out = the one on the preview (the profile's default). */
    gaugeId: z.string().uuid().nullish(),
    gaugeOverrideReason: z.string().trim().min(1).max(1000).nullish(),
    /** Start a new SPC subgroup with the first part. */
    newSubgroup: z.boolean().optional(),
    /** Why the sample was taken, as on the typed path: left out = the next sample of the plan; an event (manual, after tool change …) for an extra one. */
    triggerType: Trigger.optional(),
  })
  .strict();

export const DiscardBody = z.object({ reason: z.string().trim().max(1000).nullish() }).strict();

export const FeatureMapBody = z
  .object({
    profileId: z.string().uuid().nullish(),
    featureName: z.string().trim().min(1).max(200),
    characteristicKey: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/),
  })
  .strict();

// ---- responses ----

const Gauge = z.object({ id: z.string().uuid(), assetNumber: z.string() }).nullable();

export const ProfileVersion = z.object({ version: z.number(), reason: z.string().nullable(), createdAt: z.string(), createdBy: z.string().nullable() });
export const Profile = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  format: z.enum(['table', 'qif']),
  currentVersion: z.number(),
  settings: z.record(z.unknown()),
  defaultGauge: Gauge,
  active: z.boolean(),
  retiredReason: z.string().nullable(),
  updatedAt: z.string(),
  versions: z.array(ProfileVersion).optional(),
});
export const ProfileList = z.object({ data: z.array(Profile), canManage: z.boolean() });
export const TemplateList = z.object({ data: z.array(z.object({ key: z.string(), name: z.string(), description: z.string(), format: z.literal('table'), settings: z.record(z.unknown()) })) });

const ParsedFeature = z.object({
  position: z.number(),
  line: z.number(),
  featureName: z.string(),
  balloon: z.string().nullable(),
  actualText: z.string().nullable(),
  actual: z.number().nullable(),
  pass: z.boolean().nullable(),
  unit: z.string().nullable(),
  nominal: z.number().nullable(),
  lower: z.number().nullable(),
  upper: z.number().nullable(),
});
export const TryResult = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  header: z.record(z.string()),
  headings: z.array(z.string()),
  headingRow: z.number().nullable(),
  featureCount: z.number(),
  warnings: z.array(z.string()),
  units: z.array(z.object({ position: z.number(), reference: z.string().nullable(), featureCount: z.number(), features: z.array(ParsedFeature) })),
});

export const FeatureMap = z.object({
  id: z.string().uuid(),
  featureName: z.string(),
  characteristicKey: z.string(),
  profile: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
});
export const FeatureMapList = z.object({ data: z.array(FeatureMap) });

const Check = z.object({
  id: z.string().uuid(),
  characteristicKey: z.string(),
  charNumber: z.string().nullable(),
  name: z.string(),
  dataType: z.string(),
  unit: z.string().nullable(),
  nominal: z.number().nullable(),
  lowerLimit: z.number().nullable(),
  upperLimit: z.number().nullable(),
  applicable: z.boolean(),
});
const ImportRow = z.object({
  id: z.string().uuid(),
  position: z.number(),
  featureName: z.string(),
  charNumber: z.string().nullable(),
  raw: z.record(z.string()),
  valueText: z.string().nullable(),
  unitRead: z.string().nullable(),
  readValue: z.number().nullable(),
  valueNumeric: z.number().nullable(),
  valuePass: z.boolean().nullable(),
  valueCount: z.number().nullable(),
  fileNominal: z.number().nullable(),
  fileLower: z.number().nullable(),
  fileUpper: z.number().nullable(),
  requirementId: z.string().uuid().nullable(),
  matchKind: z.enum(['balloon', 'map', 'manual', 'none']),
  problem: z.string().nullable(),
  expectedResult: z.enum(['pass', 'fail']).nullable(),
  mismatch: z.boolean(),
  measurementId: z.string().uuid().nullable(),
});
export const ImportSummary = z.object({
  id: z.string().uuid(),
  reference: z.string(),
  inspectionId: z.string().uuid(),
  status: z.enum(['previewed', 'applying', 'applied', 'discarded']),
  fileName: z.string(),
  profile: z.object({ id: z.string().uuid(), name: z.string(), version: z.number() }).nullable(),
  gauge: Gauge,
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  appliedAt: z.string().nullable(),
  discardedAt: z.string().nullable(),
  counts: z.object({ parts: z.number(), features: z.number(), matched: z.number(), toRecord: z.number(), unmatched: z.number(), problems: z.number(), failures: z.number(), mismatches: z.number() }),
});
export const ImportDetail = ImportSummary.extend({
  filePath: z.string(),
  fileSha256: z.string(),
  sizeBytes: z.number(),
  format: z.enum(['table', 'qif']),
  header: z.record(z.unknown()),
  warnings: z.array(z.object({ kind: z.string().optional(), message: z.string() })),
  mismatchesConfirmedAt: z.string().nullable(),
  mismatchesConfirmedBy: z.string().nullable(),
  applyMode: z.string().nullable(),
  applyReason: z.string().nullable(),
  discardReason: z.string().nullable(),
  /** A preview older than a day can no longer be applied. */
  expired: z.boolean(),
  canRecord: z.boolean(),
  inspection: z.object({ id: z.string().uuid(), reference: z.string(), status: z.string(), partId: z.string().uuid(), partNumber: z.string() }),
  checks: z.array(Check),
  units: z.array(z.object({ id: z.string().uuid(), position: z.number(), unitReference: z.string().nullable(), sampleId: z.string().uuid().nullable(), rows: z.array(ImportRow) })),
});
export const ImportList = z.object({ data: z.array(ImportSummary) });
