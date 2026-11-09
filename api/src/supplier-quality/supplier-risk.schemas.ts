import { z } from 'zod';

const Iso = z.string().datetime({ offset: true });
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-30');

export const RISK_BANDS = ['low', 'medium', 'high', 'critical'] as const;
export const RiskBand = z.enum(RISK_BANDS);

// ---- input ---------------------------------------------------------------------------------------

/** One factor of the model. `key` is stable (assessments refer to it); `escalates` means a score of 4 raises the rating to at least high. */
export const RiskFactorInput = z
  .object({
    key: z.string().regex(/^[a-z0-9_]{2,40}$/, 'Use 2 to 40 lower-case letters, digits or underscores'),
    label: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).optional().default(''),
    weight: z.number().int().min(1).max(10),
    escalates: z.boolean(),
  })
  .strict();

/** A new version of the organisation's risk model; the reason is kept with it. */
export const SaveRiskModelBody = z
  .object({
    factors: z.array(RiskFactorInput).min(1).max(20),
    thresholds: z.object({ mediumFrom: z.number().gt(1).max(4), highFrom: z.number().gt(1).max(4), criticalFrom: z.number().gt(1).max(4) }).strict(),
    reviewIntervalMonths: z.number().int().min(1).max(60),
    reason: z.string().trim().min(3, 'Say why the model is changing').max(1000),
  })
  .strict();
export type SaveRiskModelBody = z.infer<typeof SaveRiskModelBody>;

/** A score for every factor of the current model: 1 low, 2 medium, 3 high, 4 critical. The index, band and rating are worked out by the database. */
export const RiskScoresBody = z
  .object({
    scores: z.array(z.object({ key: z.string().min(1).max(40), score: z.number().int().min(1).max(4), note: z.string().trim().max(1000).nullable().optional() }).strict()).max(20),
  })
  .strict();
export type RiskScoresBody = z.infer<typeof RiskScoresBody>;

export const RecordRiskAssessmentBody = RiskScoresBody.extend({
  rationale: z.string().trim().min(3, 'Give the rationale for this rating').max(2000),
  /** When the next review is due; defaults to the model's review interval from today. */
  reviewOn: DateOnly.optional(),
}).strict();
export type RecordRiskAssessmentBody = z.infer<typeof RecordRiskAssessmentBody>;

// ---- output --------------------------------------------------------------------------------------

const Person = z.object({ id: z.string().uuid(), name: z.string() }).nullable();

export const RiskModel = z.object({
  id: z.string().uuid(),
  version: z.number().int(),
  factors: z.array(z.object({ key: z.string(), label: z.string(), description: z.string(), weight: z.number().int(), escalates: z.boolean() })),
  thresholds: z.object({ mediumFrom: z.number(), highFrom: z.number(), criticalFrom: z.number() }),
  reviewIntervalMonths: z.number().int(),
  reason: z.string(),
  createdAt: Iso,
  createdBy: Person,
  /** Every version, newest first. */
  versions: z.array(z.object({ version: z.number().int(), createdAt: Iso, createdBy: Person, reason: z.string() })),
});
export type RiskModel = z.infer<typeof RiskModel>;

export const RiskScoring = z.object({
  modelVersion: z.number().int(),
  index: z.number(),
  band: RiskBand,
  rating: RiskBand,
  escalatedBy: z.array(z.string()),
  factors: z.array(z.object({ key: z.string(), label: z.string(), weight: z.number().int(), escalates: z.boolean(), score: z.number().int(), note: z.string().nullable() })),
});
export type RiskScoring = z.infer<typeof RiskScoring>;

export const RiskAssessment = RiskScoring.extend({
  id: z.string().uuid(),
  supplierId: z.string().uuid(),
  rationale: z.string(),
  previousRating: RiskBand.nullable(),
  reviewOn: DateOnly,
  status: z.enum(['current', 'superseded']),
  /** A current assessment whose review date has passed. */
  reviewOverdue: z.boolean(),
  assessedAt: Iso,
  assessedBy: Person,
});
export type RiskAssessment = z.infer<typeof RiskAssessment>;
