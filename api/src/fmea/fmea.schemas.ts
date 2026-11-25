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
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date as yyyy-MM-dd');
const csv = (values: readonly string[]) =>
  z
    .string()
    .optional()
    .refine((v) => !v || v.split(',').every((x) => values.includes(x)), `One or more of ${values.join(', ')}`);

export const FMEA_KINDS = ['design', 'process'] as const;
export const FMEA_STATUSES = ['draft', 'active', 'withdrawn', 'discarded'] as const;
export const REVISION_STATUSES = ['draft', 'pending_approval', 'approved', 'effective', 'superseded', 'withdrawn', 'discarded'] as const;
export const TEAM_ROLES = ['lead', 'design', 'process', 'quality', 'manufacturing', 'purchasing', 'supplier', 'customer', 'other'] as const;
export const LINK_KINDS = ['part', 'part_family', 'control_plan', 'machine', 'supplier', 'customer', 'operation_code'] as const;

/** A thing an FMEA covers: `{ kind, id }`, or `{ kind: 'operation_code', code }`. */
export const LinkItem = z.union([
  z.object({ kind: z.enum(LINK_KINDS).exclude(['operation_code']), id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('operation_code'), code: z.string().trim().min(1).max(40) }).strict(),
]);
export type LinkItem = z.infer<typeof LinkItem>;
export const LinksBody = z.object({ links: z.array(LinkItem).max(100) }).strict();
export type LinksBody = z.infer<typeof LinksBody>;

/** A person on the team: an employee from the register or a member, with a role. */
export const TeamItem = z
  .object({ employeeId: z.string().uuid().optional(), userId: z.string().uuid().optional(), role: z.enum(TEAM_ROLES) })
  .strict()
  .refine((t) => (t.employeeId ? 1 : 0) + (t.userId ? 1 : 0) === 1, 'Name an employee or a member');
export type TeamItem = z.infer<typeof TeamItem>;
export const TeamBody = z.object({ team: z.array(TeamItem).max(50) }).strict();
export type TeamBody = z.infer<typeof TeamBody>;

const fmeaFields = {
  title: z.string().trim().min(1).max(200),
  scopeText: text(2000),
  customerId: z.string().uuid().nullable().optional(),
  ownerId: z.string().uuid().optional(),
  reviewMonths: z.number().int().min(1).max(120).nullable().optional(),
};
export const CreateFmeaBody = z
  .object({
    kind: z.enum(FMEA_KINDS),
    ...fmeaFields,
    team: z.array(TeamItem).max(50).optional(),
    links: z.array(LinkItem).max(100).optional(),
    /** Start from an FMEA in force of the same kind: its analysis is copied (with provenance), never linked. */
    baseFmeaId: z.string().uuid().optional(),
  })
  .strict();
export type CreateFmeaBody = z.infer<typeof CreateFmeaBody>;
export const UpdateFmeaBody = z
  .object({ ...fmeaFields, title: fmeaFields.title.optional() })
  .strict()
  .refine(nothingToChange, 'Nothing to change');
export type UpdateFmeaBody = z.infer<typeof UpdateFmeaBody>;

export const UpdateRevisionBody = z.object({ changeSummary: text(4000) }).strict().refine(nothingToChange, 'Nothing to change');
export type UpdateRevisionBody = z.infer<typeof UpdateRevisionBody>;

export const ApproverBody = z.object({ approverId: z.string().uuid().nullable() }).strict();
export type ApproverBody = z.infer<typeof ApproverBody>;
export const ApproveBody = z.object({ effectiveFrom: isoDay, comment: text(2000) }).strict();
export type ApproveBody = z.infer<typeof ApproveBody>;
export const CommentBody = z.object({ comment: z.string().trim().min(3).max(2000) }).strict();
export type CommentBody = z.infer<typeof CommentBody>;
export const ReasonBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
export type ReasonBody = z.infer<typeof ReasonBody>;

export const FmeaListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  kind: csv(FMEA_KINDS),
  /** Statuses separated by commas, `live` (default: draft and active), or `all`. */
  status: csv([...FMEA_STATUSES, 'live', 'all']),
  owner: z.enum(['me']).optional(),
  /** Only FMEAs with a revision waiting for the caller's approval. */
  waiting: z.enum(['me']).optional(),
  reviewOverdue: z.enum(['true']).optional(),
  customerId: z.string().uuid().optional(),
  partId: z.string().uuid().optional(),
  partFamilyId: z.string().uuid().optional(),
  controlPlanId: z.string().uuid().optional(),
  machineId: z.string().uuid().optional(),
  sort: z.enum(['number', 'title', 'kind', 'status', 'owner', 'customer', 'effective', 'nextReview', 'updatedAt']).default('number'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type FmeaListQuery = z.infer<typeof FmeaListQuery>;

// ---- the analysis net (FM3) ---------------------------------------------------------------------------
const note = (max: number) => z.string().trim().max(max).nullable().optional();
const position = z.number().int().min(0).max(100000).optional();
const level = z.number().int().min(1).max(10).nullable().optional();
export const ITEM_KINDS = ['system', 'subsystem', 'component', 'item', 'step', 'element'] as const;
export const ELEMENT_TYPES = ['man', 'machine', 'material', 'method', 'measurement', 'environment'] as const;
export const EFFECT_LEVELS = ['own_plant', 'next_plant', 'end_user'] as const;
export const SPECIAL_CLASSES = ['critical', 'significant'] as const;

const itemFields = {
  name: z.string().trim().min(1).max(200),
  elementType: z.enum(ELEMENT_TYPES).nullable().optional(),
  description: note(1000),
  operationCode: note(40),
  machineId: z.string().uuid().nullable().optional(),
  partId: z.string().uuid().nullable().optional(),
  position,
  parentId: z.string().uuid().nullable().optional(),
};
export const CreateItemBody = z.object({ kind: z.enum(ITEM_KINDS), ...itemFields }).strict();
export type CreateItemBody = z.infer<typeof CreateItemBody>;
export const UpdateItemBody = z.object({ ...itemFields, name: itemFields.name.optional() }).strict().refine(nothingToChange, 'Nothing to change');
export type UpdateItemBody = z.infer<typeof UpdateItemBody>;

const functionFields = { text: z.string().trim().min(1).max(1000), requirement: note(1000), characteristicKey: note(80), position };
export const CreateFunctionBody = z.object(functionFields).strict();
export const UpdateFunctionBody = z.object({ ...functionFields, text: functionFields.text.optional() }).strict().refine(nothingToChange, 'Nothing to change');

const modeFields = { text: z.string().trim().min(1).max(500), specialClass: z.enum(SPECIAL_CLASSES).nullable().optional(), position };
export const CreateFailureModeBody = z.object(modeFields).strict();
export const UpdateFailureModeBody = z.object({ ...modeFields, text: modeFields.text.optional() }).strict().refine(nothingToChange, 'Nothing to change');

const effectFields = { level: z.enum(EFFECT_LEVELS), text: z.string().trim().min(1).max(500), severity: level, position };
export const CreateEffectBody = z.object(effectFields).strict();
export const UpdateEffectBody = z.object({ ...effectFields, level: effectFields.level.optional(), text: effectFields.text.optional() }).strict().refine(nothingToChange, 'Nothing to change');

const causeFields = {
  text: z.string().trim().min(1).max(500),
  preventionControls: note(1000),
  detectionControls: note(1000),
  occurrence: level,
  detection: level,
  noActionReason: note(500),
  position,
};
export const CreateCauseBody = z.object(causeFields).strict();
export const UpdateCauseBody = z.object({ ...causeFields, text: causeFields.text.optional() }).strict().refine(nothingToChange, 'Nothing to change');
