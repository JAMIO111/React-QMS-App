import { z } from 'zod';

/** Optional text that is trimmed; empty means "clear it". */
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();
const nothingToChange = (b: object) => Object.keys(b).length > 0;

export const BANDS = ['low', 'medium', 'high', 'critical'] as const;
export const RISK_KINDS = ['risk', 'opportunity'] as const;
export const RISK_STATUSES = ['draft', 'open', 'treating', 'monitoring', 'closed', 'retired'] as const;
const Band = z.enum(BANDS);
const Level = z.number().int().min(1).max(5);

// ---- the matrix ----------------------------------------------------------------------------------
const LevelLabel = z.object({ label: z.string().trim().min(1).max(40), description: z.string().trim().max(300).optional() }).strict();
export const ModelConfig = z
  .object({
    /** Five levels, least likely first. */
    likelihood: z.array(LevelLabel).length(5),
    /** Five levels, least serious first. */
    consequence: z.array(LevelLabel).length(5),
    /** `bands[likelihood - 1][consequence - 1]`. */
    bands: z.array(z.array(Band).length(5)).length(5),
    /** The highest band a risk may sit in without an approved acceptance. */
    acceptanceBand: z.enum(['low', 'medium', 'high']),
    reviewMonths: z.object({ low: z.number().int().min(1).max(60), medium: z.number().int().min(1).max(60), high: z.number().int().min(1).max(60), critical: z.number().int().min(1).max(60) }).strict(),
  })
  .strict();
export type ModelConfig = z.infer<typeof ModelConfig>;

export const SaveModelBody = z.object({ config: ModelConfig, reason: z.string().trim().min(3).max(1000) }).strict();
export type SaveModelBody = z.infer<typeof SaveModelBody>;

export const ScoreQuery = z.object({ likelihood: z.coerce.number().int().min(1).max(5), consequence: z.coerce.number().int().min(1).max(5) });
export type ScoreQuery = z.infer<typeof ScoreQuery>;

// ---- categories ----------------------------------------------------------------------------------
export const AllQuery = z.object({ all: z.enum(['true', 'false']).default('false') });
export type AllQuery = z.infer<typeof AllQuery>;

export const CreateCategoryBody = z.object({ label: z.string().trim().min(1).max(60), description: text(300), sequence: z.number().int().min(0).max(10000).optional() }).strict();
export type CreateCategoryBody = z.infer<typeof CreateCategoryBody>;

export const UpdateCategoryBody = z
  .object({ label: z.string().trim().min(1).max(60).optional(), description: text(300), sequence: z.number().int().min(0).max(10000).optional(), active: z.boolean().optional() })
  .strict()
  .refine(nothingToChange, 'Nothing to change');
export type UpdateCategoryBody = z.infer<typeof UpdateCategoryBody>;

export const RiskCategory = z.object({
  id: z.string().uuid(),
  key: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  sequence: z.number().int(),
  active: z.boolean(),
  /** Risks (any status) in it. */
  risks: z.number().int(),
});
export type RiskCategory = z.infer<typeof RiskCategory>;

// ---- risks ---------------------------------------------------------------------------------------
const riskFields = {
  kind: z.enum(RISK_KINDS).optional(),
  categoryId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  description: text(4000),
  cause: text(2000),
  effect: text(2000),
  ownerId: z.string().uuid().optional(),
  siteId: z.string().uuid().nullable().optional(),
  departmentId: z.string().uuid().nullable().optional(),
};
export const CreateRiskBody = z.object(riskFields).strict();
export type CreateRiskBody = z.infer<typeof CreateRiskBody>;

export const UpdateRiskBody = z
  .object({ ...riskFields, categoryId: riskFields.categoryId.optional(), title: riskFields.title.optional() })
  .strict()
  .refine(nothingToChange, 'Nothing to change');
export type UpdateRiskBody = z.infer<typeof UpdateRiskBody>;

export const AssessBody = z.object({ likelihood: Level, consequence: Level, rationale: z.string().trim().min(3).max(2000) }).strict();
export type AssessBody = z.infer<typeof AssessBody>;

export const ReasonBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
export type ReasonBody = z.infer<typeof ReasonBody>;

const csv = (values: readonly string[]) =>
  z
    .string()
    .optional()
    .refine((v) => !v || v.split(',').every((x) => values.includes(x)), `One or more of ${values.join(', ')}`);

export const RiskListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  kind: z.enum(RISK_KINDS).optional(),
  /** Statuses separated by commas, or `live` (default: everything but retired) or `all`. */
  status: csv([...RISK_STATUSES, 'live', 'all']),
  /** Bands of the current assessment, and `unassessed`. */
  band: csv([...BANDS, 'unassessed']),
  categoryId: z.string().uuid().optional(),
  owner: z.enum(['me']).optional(),
  sort: z.enum(['reference', 'title', 'category', 'owner', 'status', 'score', 'assessedOn', 'createdAt']).default('reference'),
  order: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type RiskListQuery = z.infer<typeof RiskListQuery>;
