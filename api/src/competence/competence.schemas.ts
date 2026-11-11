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

const Iso = z.string().datetime({ offset: true });
const nothingToChange = (b: object) => Object.keys(b).length > 0;

export const COMPETENCE_LEVELS = [0, 1, 2, 3, 4] as const;

// ---- categories ----------------------------------------------------------------------------------
export const CreateCategoryBody = z
  .object({ label: z.string().trim().min(1).max(60), description: text(300), sequence: z.number().int().min(0).max(10000).optional() })
  .strict();
export type CreateCategoryBody = z.infer<typeof CreateCategoryBody>;

export const UpdateCategoryBody = z
  .object({ label: z.string().trim().min(1).max(60).optional(), description: text(300), sequence: z.number().int().min(0).max(10000).optional(), active: z.boolean().optional() })
  .strict()
  .refine(nothingToChange, 'Nothing to change');
export type UpdateCategoryBody = z.infer<typeof UpdateCategoryBody>;

export const AllQuery = z.object({ all: z.enum(['true', 'false']).default('false') });
export type AllQuery = z.infer<typeof AllQuery>;

export const Category = z.object({
  id: z.string().uuid(),
  key: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  sequence: z.number().int(),
  active: z.boolean(),
  /** How many skills (any status) sit in it. */
  skills: z.number().int(),
});
export type Category = z.infer<typeof Category>;

// ---- skills --------------------------------------------------------------------------------------
const Code = z.string().trim().min(1).max(40);

export const CreateSkillBody = z
  .object({
    code: Code,
    name: z.string().trim().min(1).max(120),
    categoryId: z.string().uuid(),
    description: text(1000),
    refreshMonths: z.number().int().min(1).max(120).nullable().optional(),
  })
  .strict();
export type CreateSkillBody = z.infer<typeof CreateSkillBody>;

export const UpdateSkillBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    categoryId: z.string().uuid().optional(),
    description: text(1000),
    refreshMonths: z.number().int().min(1).max(120).nullable().optional(),
  })
  .strict()
  .refine(nothingToChange, 'Nothing to change');
export type UpdateSkillBody = z.infer<typeof UpdateSkillBody>;

export const SkillListQuery = z.object({
  all: z.enum(['true', 'false']).default('false'),
  categoryId: z.string().uuid().optional(),
  q: z.string().trim().max(100).optional(),
});
export type SkillListQuery = z.infer<typeof SkillListQuery>;

export const ReasonBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
export type ReasonBody = z.infer<typeof ReasonBody>;

export const Skill = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  category: z.object({ id: z.string().uuid(), label: z.string() }),
  description: z.string().nullable(),
  refreshMonths: z.number().int().nullable(),
  active: z.boolean(),
  retiredReason: z.string().nullable(),
  retiredAt: Iso.nullable(),
  /** Active positions that require this skill. */
  positions: z.number().int(),
  createdAt: Iso,
});
export type Skill = z.infer<typeof Skill>;

// ---- positions -----------------------------------------------------------------------------------
export const CreatePositionBody = z
  .object({ code: Code, name: z.string().trim().min(1).max(120), description: text(1000) })
  .strict();
export type CreatePositionBody = z.infer<typeof CreatePositionBody>;

export const UpdatePositionBody = z
  .object({ name: z.string().trim().min(1).max(120).optional(), description: text(1000) })
  .strict()
  .refine(nothingToChange, 'Nothing to change');
export type UpdatePositionBody = z.infer<typeof UpdatePositionBody>;

export const SetPositionSkillsBody = z
  .object({ skills: z.array(z.object({ skillId: z.string().uuid(), requiredLevel: z.number().int().min(1).max(4) }).strict()).max(200) })
  .strict();
export type SetPositionSkillsBody = z.infer<typeof SetPositionSkillsBody>;

export const PositionSkill = z.object({
  skillId: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  category: z.string(),
  requiredLevel: z.number().int().min(1).max(4),
  skillActive: z.boolean(),
});
export type PositionSkill = z.infer<typeof PositionSkill>;

export const Position = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  active: z.boolean(),
  retiredReason: z.string().nullable(),
  retiredAt: Iso.nullable(),
  skills: z.array(PositionSkill),
  createdAt: Iso,
});
export type Position = z.infer<typeof Position>;

// ---- people: positions held, assessments, the matrix (CO2) -----------------------------------------
const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use yyyy-MM-dd');

export const AssignPositionBody = z.object({ positionId: z.string().uuid(), startedOn: IsoDay }).strict();
export type AssignPositionBody = z.infer<typeof AssignPositionBody>;

export const EndPositionBody = z.object({ endedOn: IsoDay.optional() }).strict();
export type EndPositionBody = z.infer<typeof EndPositionBody>;

export const AssessBody = z
  .object({
    skillId: z.string().uuid(),
    level: z.number().int().min(0).max(4),
    assessedOn: IsoDay.optional(),
    expiresOn: IsoDay.nullable().optional(),
    note: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();
export type AssessBody = z.infer<typeof AssessBody>;

export const MatrixQuery = z.object({
  positionId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  skillId: z.string().uuid().optional(),
  status: z.enum(['all', 'gap', 'expiring', 'expired', 'attention']).default('all'),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type MatrixQuery = z.infer<typeof MatrixQuery>;
