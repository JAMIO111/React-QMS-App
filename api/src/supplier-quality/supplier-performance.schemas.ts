import { z } from 'zod';

const Iso = z.string().datetime({ offset: true });
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-30');
const Person = z.object({ id: z.string().uuid(), name: z.string() }).nullable();

export const OTD_POLICIES = ['agreed', 'original'] as const;
export const BANDS = ['good', 'watch', 'poor', 'insufficient'] as const;
export const METRIC_KEYS = ['otd', 'in_full', 'ppm', 'ncs', 'scar', 'certs'] as const;
export const PPM_BASES = ['rejected', 'ncs'] as const;

const Weight = z.number().int().min(0).max(100);
const Penalty = z.number().int().min(0).max(100);

/** The scoring configuration: the date policy for on-time delivery, the metric weights, the PPM targets, NC penalties, the bands and the minimum amount of data. */
export const ScorecardConfig = z
  .object({
    otdPolicy: z.enum(OTD_POLICIES),
    /** Which PPM scores: units rejected at receiving, or units on non-conformances linked to received lines. Both are always worked out and shown. */
    ppmBasis: z.enum(PPM_BASES).default('rejected'),
    /** In the NC-based PPM, also count the pieces on supplier NCs that are linked to no received line (they cannot be matched to a delivery). */
    ppmNcIncludeUnlinked: z.boolean().default(false),
    /** Days early that still count as on time; empty = no limit (early is never late). */
    graceDaysBefore: z.number().int().min(0).max(60).nullable().default(null),
    /** Days late that still count as on time, and the allowance for in full to be reached. */
    graceDaysAfter: z.number().int().min(0).max(60).default(0),
    /** In full: the share (%) below the ordered quantity, and above it, that still counts as in full. */
    inFullUnderPct: z.number().min(0).max(100).default(0),
    inFullOverPct: z.number().min(0).max(100).default(10),
    weights: z.object({ otd: Weight, inFull: Weight.default(0), ppm: Weight, ncs: Weight, scar: Weight, certs: Weight }).strict(),
    /** PPM at or below this scores 100. */
    ppmGood: z.number().min(0).max(1_000_000),
    /** PPM at or above this scores 0. */
    ppmZero: z.number().gt(0).max(1_000_000),
    ncPenalty: z.object({ critical: Penalty, major: Penalty, minor: Penalty }).strict(),
    goodFrom: z.number().gt(0).max(100),
    watchFrom: z.number().gt(0).max(100),
    /** Delivered lines needed before on-time delivery and PPM are scored. */
    minLines: z.number().int().min(1).max(100),
  })
  .strict();
export type ScorecardConfig = z.infer<typeof ScorecardConfig>;

export const SaveModelBody = z.object({ config: ScorecardConfig, reason: z.string().trim().min(3, 'Say why the model is changing').max(1000) }).strict();
export type SaveModelBody = z.infer<typeof SaveModelBody>;

/** A supplier's own settings; a key that is present sets it, null clears it (it follows the model again). */
export const SupplierSettingsBody = z
  .object({
    otdPolicy: z.enum(OTD_POLICIES).nullable().optional(),
    graceDaysBefore: z.number().int().min(0).max(60).nullable().optional(),
    graceDaysAfter: z.number().int().min(0).max(60).nullable().optional(),
    inFullUnderPct: z.number().min(0).max(100).nullable().optional(),
    inFullOverPct: z.number().min(0).max(100).nullable().optional(),
  })
  .strict();
export type SupplierSettingsBody = z.infer<typeof SupplierSettingsBody>;

export const SupplierSettings = z.object({
  /** null = follows the organisation's model */
  overrides: z.object({ otdPolicy: z.enum(OTD_POLICIES).nullable(), graceDaysBefore: z.number().int().nullable(), graceDaysAfter: z.number().int().nullable(), inFullUnderPct: z.number().nullable(), inFullOverPct: z.number().nullable() }),
  /** what the supplier is scored with now */
  effective: z.object({ otdPolicy: z.enum(OTD_POLICIES), graceDaysBefore: z.number().int().nullable(), graceDaysAfter: z.number().int(), inFullUnderPct: z.number(), inFullOverPct: z.number(), ppmBasis: z.enum(PPM_BASES) }),
  modelVersion: z.number().int(),
});
export type SupplierSettings = z.infer<typeof SupplierSettings>;

export const PerformanceQuery = z.object({ from: DateOnly.optional(), to: DateOnly.optional() });
export type PerformanceQuery = z.infer<typeof PerformanceQuery>;

export const SaveScorecardBody = z.object({ from: DateOnly, to: DateOnly, note: z.string().trim().max(1000).nullable().optional() }).strict();
export type SaveScorecardBody = z.infer<typeof SaveScorecardBody>;

export const RecommendationQuery = z.object({ days: z.coerce.number().int().min(7).max(366).default(90) });
export type RecommendationQuery = z.infer<typeof RecommendationQuery>;

export const InspectionRecommendation = z.object({
  /** Information only: nothing is changed by this. */
  level: z.enum(['increased', 'normal', 'reduced']),
  canReduce: z.boolean(),
  current: z.object({ level: z.enum(['increased', 'normal', 'reduced']), ruleId: z.string().uuid().nullable(), ruleName: z.string().nullable(), basis: z.enum(['supplier_rule', 'default']) }),
  change: z.enum(['none', 'raise', 'lower']),
  reasons: z.array(z.object({ code: z.string(), message: z.string(), kind: z.enum(['raises', 'blocks_reduction', 'supports']) })),
  basis: z.object({
    days: z.number().int(), from: DateOnly, to: DateOnly, approvalStatus: z.string(), riskRating: z.string().nullable(), band: z.enum(BANDS), score: z.number().nullable(),
    deliveredLines: z.number().int(), rejectedLines: z.number().int(), criticalNcs: z.number().int(), majorNcs: z.number().int(), overdueScars: z.number().int(), expiredCerts: z.number().int(), minLines: z.number().int(),
  }),
  generatedAt: Iso,
});
export type InspectionRecommendation = z.infer<typeof InspectionRecommendation>;

export const WatchlistQuery = z.object({ days: z.coerce.number().int().min(7).max(366).default(90) });
export type WatchlistQuery = z.infer<typeof WatchlistQuery>;

// ---- output --------------------------------------------------------------------------------------

export const ScorecardModel = z.object({
  id: z.string().uuid(),
  version: z.number().int(),
  config: ScorecardConfig,
  reason: z.string(),
  createdAt: Iso,
  createdBy: Person,
  versions: z.array(z.object({ version: z.number().int(), reason: z.string(), createdAt: Iso, createdBy: Person })),
});
export type ScorecardModel = z.infer<typeof ScorecardModel>;

const Component = z.object({ key: z.enum(METRIC_KEYS), weight: z.number().int(), sufficient: z.boolean(), score: z.number().nullable(), detail: z.string().nullable() });
/** A warning says why, and names the records behind it (`sources` are small objects with ids and references the screen links to). */
const Warning = z.object({ code: z.string(), level: z.enum(['info', 'warning', 'critical']), message: z.string(), sourceType: z.string(), sources: z.array(z.record(z.string(), z.unknown())) });

/** What a supplier overrides of the organisation's model (only the keys it sets). */
export const PerformanceOverrides = z.object({
  otdPolicy: z.enum(OTD_POLICIES).optional(),
  graceDaysBefore: z.number().int().optional(),
  graceDaysAfter: z.number().int().optional(),
  inFullUnderPct: z.number().optional(),
  inFullOverPct: z.number().optional(),
});
export type PerformanceOverrides = z.infer<typeof PerformanceOverrides>;

export const Performance = z.object({
  model: z.object({ id: z.string().uuid(), version: z.number().int(), config: ScorecardConfig }),
  overrides: PerformanceOverrides,
  metrics: z.record(z.string(), z.unknown()),
  score: z.number().nullable(),
  band: z.enum(BANDS),
  components: z.array(Component),
  warnings: z.array(Warning),
  weightWithData: z.number().nullable(),
});
export type Performance = z.infer<typeof Performance>;

export const Scorecard = Performance.omit({ model: true, overrides: true }).extend({
  id: z.string().uuid(),
  supplierId: z.string().uuid(),
  periodFrom: DateOnly,
  periodTo: DateOnly,
  modelVersion: z.number().int(),
  config: ScorecardConfig,
  note: z.string().nullable(),
  createdAt: Iso,
  createdBy: Person,
});
export type Scorecard = z.infer<typeof Scorecard>;
export const ScorecardSummary = z.object({
  id: z.string().uuid(),
  periodFrom: DateOnly,
  periodTo: DateOnly,
  modelVersion: z.number().int(),
  score: z.number().nullable(),
  band: z.enum(BANDS),
  warningCount: z.number().int(),
  note: z.string().nullable(),
  createdAt: Iso,
  createdBy: Person,
});
export type ScorecardSummary = z.infer<typeof ScorecardSummary>;

export const WatchlistRow = z.object({
  supplierId: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  score: z.number().nullable(),
  band: z.enum(BANDS),
  warnings: z.array(Warning),
});
export const Watchlist = z.object({ days: z.number().int(), data: z.array(WatchlistRow) });
