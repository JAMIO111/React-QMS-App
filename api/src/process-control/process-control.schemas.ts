import { z } from 'zod';
import { ListQuery } from '../common/pagination';

const booleanFlag = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => v === 'true');
const Search = z.string().trim().max(100).optional();
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();
const Iso = z.string().datetime({ offset: true });
const NullableIso = Iso.nullable();
const Ref = z.object({ id: z.string().uuid(), name: z.string() });

/** Codes (machines, families, plans): upper-cased, 1–40 characters, no surrounding spaces. */
const Code = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/, 'Use letters, digits, spaces, ".", "_", "/" or "-"')
  .transform((v) => v.toUpperCase());
const OperationCode = z
  .string()
  .trim()
  .min(1)
  .max(30)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/, 'Use letters, digits, spaces, ".", "_", "/" or "-"')
  .transform((v) => v.toUpperCase());
const RevisionCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,9}$/, 'Use 1–10 letters, digits, ".", "-" or "_"');
/** Characteristic keys link plan characteristics to part values, e.g. LENGTH, GROOVE_POS. */
export const CharacteristicKey = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase().replace(/[\s-]+/g, '_'))
  .pipe(z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/, 'Start with a letter; use letters, digits and "_" (up to 40)'));
/** Decimal values are carried as JSON numbers and stored as NUMERIC (no rounding in the database). */
const Decimal = z.number().finite();

const updateOf = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object(shape)
    .strict()
    .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });

// ---- machines --------------------------------------------------------------------------------

export const Machine = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  site: Ref.nullable(),
  workCentre: z.string().nullable(),
  description: z.string().nullable(),
  active: z.boolean(),
});
export type Machine = z.infer<typeof Machine>;
const machineFields = {
  code: Code,
  name: z.string().trim().min(1).max(120),
  siteId: z.string().uuid().nullable().optional(),
  workCentre: optionalText(100),
  description: optionalText(1000),
};
export const CreateMachineBody = z.object(machineFields).strict();
export const UpdateMachineBody = updateOf({
  code: Code.optional(),
  name: machineFields.name.optional(),
  siteId: machineFields.siteId,
  workCentre: machineFields.workCentre,
  description: machineFields.description,
  active: z.boolean().optional(),
});
export const MachineListQuery = ListQuery.extend({ q: Search, siteId: z.string().uuid().optional(), includeInactive: booleanFlag });

// ---- part families ---------------------------------------------------------------------------

export const PartFamily = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  active: z.boolean(),
  partCount: z.number().int(),
  planCount: z.number().int(),
});
export type PartFamily = z.infer<typeof PartFamily>;
export const FamilyPart = z.object({
  id: z.string().uuid(),
  partNumber: z.string(),
  name: z.string(),
  active: z.boolean(),
  currentRevision: z.string().nullable(),
});
export const FamilyPlan = z.object({
  id: z.string().uuid(),
  planCode: z.string(),
  title: z.string(),
  active: z.boolean(),
  effectiveRevision: z.string().nullable(),
  scope: z.string(),
});
export const PartFamilyDetail = PartFamily.extend({ parts: z.array(FamilyPart), plans: z.array(FamilyPlan) });
export type PartFamilyDetail = z.infer<typeof PartFamilyDetail>;
const familyFields = { code: Code, name: z.string().trim().min(1).max(200), description: optionalText(2000) };
export const CreatePartFamilyBody = z.object(familyFields).strict();
export const UpdatePartFamilyBody = updateOf({
  code: Code.optional(),
  name: familyFields.name.optional(),
  description: familyFields.description,
  active: z.boolean().optional(),
});
export const PartFamilyListQuery = ListQuery.extend({ q: Search, includeInactive: booleanFlag });

// ---- part revision characteristic values -------------------------------------------------------

export const SpecValue = z.object({
  id: z.string().uuid(),
  partRevisionId: z.string().uuid(),
  characteristicKey: z.string(),
  description: z.string().nullable(),
  nominal: z.number().nullable(),
  lowerLimit: z.number().nullable(),
  upperLimit: z.number().nullable(),
  unitCode: z.string(),
  notes: z.string().nullable(),
});
export type SpecValue = z.infer<typeof SpecValue>;
const limitsInOrder = (b: { nominal?: number | null; lowerLimit?: number | null; upperLimit?: number | null }) =>
  (b.lowerLimit == null || b.upperLimit == null || b.lowerLimit <= b.upperLimit) &&
  (b.nominal == null || ((b.lowerLimit == null || b.nominal >= b.lowerLimit) && (b.upperLimit == null || b.nominal <= b.upperLimit)));
export const CreateSpecValueBody = z
  .object({
    characteristicKey: CharacteristicKey,
    description: optionalText(200),
    nominal: Decimal.nullable().optional(),
    lowerLimit: Decimal.nullable().optional(),
    upperLimit: Decimal.nullable().optional(),
    unitCode: z.string().trim().min(1).max(20),
    notes: optionalText(1000),
  })
  .strict()
  .refine((b) => b.nominal != null || b.lowerLimit != null || b.upperLimit != null, { message: 'Give a nominal or at least one limit' })
  .refine(limitsInOrder, { message: 'Limits must be in order, with the nominal between them' });
export const UpdateSpecValueBody = updateOf({
  description: optionalText(200),
  nominal: Decimal.nullable().optional(),
  lowerLimit: Decimal.nullable().optional(),
  upperLimit: Decimal.nullable().optional(),
  unitCode: z.string().trim().min(1).max(20).optional(),
  notes: optionalText(1000),
});

// ---- control plans ---------------------------------------------------------------------------

export const PlanRevisionStatus = z.enum(['draft', 'pending_approval', 'approved', 'effective', 'superseded', 'obsolete']);
export const PlanRevision = z.object({
  id: z.string().uuid(),
  controlPlanId: z.string().uuid(),
  revisionCode: z.string(),
  status: PlanRevisionStatus,
  changeReason: z.string().nullable(),
  effectiveFrom: NullableIso,
  effectiveUntil: NullableIso,
  supersedesRevision: z.object({ id: z.string().uuid(), revisionCode: z.string() }).nullable(),
  createdAt: Iso,
  createdBy: Ref.nullable(),
  submittedAt: NullableIso,
  submittedBy: Ref.nullable(),
  approvedAt: NullableIso,
  approvedBy: Ref.nullable(),
  reviewComment: z.string().nullable(),
  obsoleteReason: z.string().nullable(),
});
export type PlanRevision = z.infer<typeof PlanRevision>;

export const Applicability = z.object({
  id: z.string().uuid(),
  partFamily: z.object({ id: z.string().uuid(), code: z.string(), name: z.string() }),
  part: z.object({ id: z.string().uuid(), partNumber: z.string() }).nullable(),
  site: Ref.nullable(),
  operationCode: z.string().nullable(),
});
export type Applicability = z.infer<typeof Applicability>;

export const ControlPlanSummary = z.object({
  id: z.string().uuid(),
  planCode: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  owner: Ref.nullable(),
  active: z.boolean(),
  families: z.array(z.string()),
  effectiveRevision: z.string().nullable(),
  /** The working copy (draft or under review), if any. */
  openRevision: z.object({ revisionCode: z.string(), status: PlanRevisionStatus }).nullable(),
  updatedAt: Iso,
});
export type ControlPlanSummary = z.infer<typeof ControlPlanSummary>;
export const ControlPlanDetail = ControlPlanSummary.extend({
  applicability: z.array(Applicability),
  revisions: z.array(PlanRevision),
});
export type ControlPlanDetail = z.infer<typeof ControlPlanDetail>;

export const ControlPlanListQuery = ListQuery.extend({
  q: Search,
  partFamilyId: z.string().uuid().optional(),
  status: z.enum(['effective', 'no_effective', 'pending_approval']).optional(),
  includeInactive: booleanFlag,
});
const planFields = {
  planCode: Code,
  title: z.string().trim().min(1).max(200),
  description: optionalText(2000),
  ownerId: z.string().uuid().nullable().optional(),
};
export const CreateControlPlanBody = z
  .object({
    ...planFields,
    /** First draft revision code (default "A"). */
    revisionCode: RevisionCode.optional(),
    /** Optional first scope entry. */
    partFamilyId: z.string().uuid().optional(),
  })
  .strict();
export const UpdateControlPlanBody = updateOf({
  planCode: Code.optional(),
  title: planFields.title.optional(),
  description: planFields.description,
  ownerId: planFields.ownerId,
  active: z.boolean().optional(),
});
export const CreateApplicabilityBody = z
  .object({
    partFamilyId: z.string().uuid(),
    partId: z.string().uuid().nullable().optional(),
    siteId: z.string().uuid().nullable().optional(),
    operationCode: OperationCode.nullable().optional(),
  })
  .strict();
export const CreatePlanRevisionBody = z
  .object({ revisionCode: RevisionCode, changeReason: optionalText(2000), effectiveFrom: NullableIso.optional() })
  .strict();
export const UpdatePlanRevisionBody = updateOf({
  revisionCode: RevisionCode.optional(),
  changeReason: optionalText(2000),
  effectiveFrom: NullableIso.optional(),
});
/**
 * Lifecycle commands. `approve` also makes the revision effective straight away when its effective
 * date is not in the future (unless `makeEffective: false`).
 */
export const PlanRevisionTransitionBody = z
  .object({
    action: z.enum(['submit', 'withdraw', 'send_back', 'approve', 'make_effective', 'obsolete']),
    comment: optionalText(2000),
    reason: optionalText(2000),
    makeEffective: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.action !== 'obsolete' || !!b.reason, { message: 'Give a reason for making this revision obsolete', path: ['reason'] })
  .refine((b) => b.action !== 'send_back' || !!b.comment, { message: 'Say what needs changing', path: ['comment'] });
export type PlanRevisionTransitionBody = z.infer<typeof PlanRevisionTransitionBody>;

/** Same shape as the gauge history, so the frontend timeline is shared. */
export { HistoryEntry } from '../calibration/calibration.schemas';

// ---- plan content (PC2) ------------------------------------------------------------------------

export const SamplingTrigger = z.enum(['first_off', 'last_off', 'every_n_minutes', 'every_n_parts', 'start_of_shift', 'after_tool_change', 'after_setup', 'manual']);
export const ReactionTrigger = z.enum(['out_of_spec', 'spc_signal', 'gauge_invalid', 'missed_check']);
export const ReactionAction = z.enum(['warn', 'hold', 'stop', 'notify', 'raise_ncr']);

export const SamplingRule = z.object({
  id: z.string().uuid(),
  triggerType: SamplingTrigger,
  intervalValue: z.number().int().nullable(),
  sampleSize: z.number().int(),
});
export const Reaction = z.object({
  id: z.string().uuid(),
  triggerType: ReactionTrigger,
  action: ReactionAction,
  instruction: z.string(),
});
export const PlanCharacteristic = z.object({
  id: z.string().uuid(),
  operationId: z.string().uuid(),
  characteristicKey: z.string(),
  sequence: z.number().int(),
  charNumber: z.string().nullable(),
  name: z.string(),
  dataType: z.enum(['variable', 'attribute']),
  valueSource: z.enum(['plan', 'part_spec']),
  appliesTo: z.enum(['all', 'selected']),
  nominal: z.number().nullable(),
  lowerLimit: z.number().nullable(),
  upperLimit: z.number().nullable(),
  unitCode: z.string().nullable(),
  specKey: z.string().nullable(),
  method: z.string().nullable(),
  gaugeType: Ref.nullable(),
  criticality: z.enum(['critical', 'major', 'minor']),
  spcEligible: z.boolean(),
  chartType: z.enum(['imr', 'xbar_r']).nullable(),
  subgroupSize: z.number().int().nullable(),
  decimals: z.number().int().nullable(),
  notes: z.string().nullable(),
  parts: z.array(z.object({ id: z.string().uuid(), partNumber: z.string() })),
  sampling: z.array(SamplingRule),
  reactions: z.array(Reaction),
});
export type PlanCharacteristic = z.infer<typeof PlanCharacteristic>;
export const PlanOperation = z.object({
  id: z.string().uuid(),
  operationCode: z.string(),
  sequence: z.number().int(),
  name: z.string(),
  machine: z.object({ id: z.string().uuid(), code: z.string(), name: z.string() }).nullable(),
  workCentre: z.string().nullable(),
  notes: z.string().nullable(),
  characteristics: z.array(PlanCharacteristic),
});
export type PlanOperation = z.infer<typeof PlanOperation>;
export const RevisionDetail = PlanRevision.extend({
  plan: z.object({ id: z.string().uuid(), planCode: z.string(), title: z.string(), active: z.boolean() }),
  operations: z.array(PlanOperation),
  /** Reactions that apply to every characteristic of the revision. */
  reactions: z.array(Reaction),
  /** Parts covered by the plan's scope (for conditional characteristics). */
  scopeParts: z.array(z.object({ id: z.string().uuid(), partNumber: z.string(), name: z.string() })),
});
export type RevisionDetail = z.infer<typeof RevisionDetail>;

const operationFields = {
  operationCode: OperationCode,
  sequence: z.number().int().min(0).max(100000).optional(),
  name: z.string().trim().min(1).max(200),
  machineId: z.string().uuid().nullable().optional(),
  workCentre: optionalText(100),
  notes: optionalText(2000),
};
export const CreateOperationBody = z.object(operationFields).strict();
export const UpdateOperationBody = updateOf({
  operationCode: OperationCode.optional(),
  sequence: operationFields.sequence,
  name: operationFields.name.optional(),
  machineId: operationFields.machineId,
  workCentre: operationFields.workCentre,
  notes: operationFields.notes,
});

const SamplingInput = z
  .object({ triggerType: SamplingTrigger, intervalValue: z.number().int().min(1).max(100000).nullable().optional(), sampleSize: z.number().int().min(1).max(100) })
  .strict();
const ReactionInput = z.object({ triggerType: ReactionTrigger, action: ReactionAction, instruction: z.string().trim().min(1).max(2000) }).strict();
const characteristicFields = {
  operationId: z.string().uuid(),
  sequence: z.number().int().min(0).max(100000).optional(),
  charNumber: optionalText(20),
  name: z.string().trim().min(1).max(200),
  dataType: z.enum(['variable', 'attribute']).optional(),
  valueSource: z.enum(['plan', 'part_spec']).optional(),
  appliesTo: z.enum(['all', 'selected']).optional(),
  nominal: Decimal.nullable().optional(),
  lowerLimit: Decimal.nullable().optional(),
  upperLimit: Decimal.nullable().optional(),
  unitCode: z.string().trim().min(1).max(20).nullable().optional(),
  specKey: CharacteristicKey.nullable().optional(),
  method: optionalText(500),
  gaugeTypeId: z.string().uuid().nullable().optional(),
  criticality: z.enum(['critical', 'major', 'minor']).optional(),
  spcEligible: z.boolean().optional(),
  chartType: z.enum(['imr', 'xbar_r']).nullable().optional(),
  subgroupSize: z.number().int().min(1).max(10).nullable().optional(),
  decimals: z.number().int().min(0).max(6).nullable().optional(),
  notes: optionalText(2000),
  /** Replace the part list (conditional characteristics). */
  partIds: z.array(z.string().uuid()).max(500).optional(),
  /** Replace the sampling rules. */
  sampling: z.array(SamplingInput).max(8).optional(),
  /** Replace the characteristic's reactions. */
  reactions: z.array(ReactionInput).max(20).optional(),
};
export const CreateCharacteristicBody = z.object({ ...characteristicFields, characteristicKey: CharacteristicKey }).strict();
export type CreateCharacteristicBody = z.infer<typeof CreateCharacteristicBody>;
export const UpdateCharacteristicBody = updateOf({
  ...characteristicFields,
  operationId: characteristicFields.operationId.optional(),
  name: characteristicFields.name.optional(),
});
export type UpdateCharacteristicBody = z.infer<typeof UpdateCharacteristicBody>;
export const ReplaceReactionsBody = z.object({ reactions: z.array(ReactionInput).max(20) }).strict();

// ---- revision comparison --------------------------------------------------------------------------

export const FieldChange = z.object({ field: z.string(), label: z.string(), from: z.string().nullable(), to: z.string().nullable() });
export const RevisionComparison = z.object({
  base: z.object({ id: z.string().uuid(), revisionCode: z.string() }).nullable(),
  target: z.object({ id: z.string().uuid(), revisionCode: z.string() }),
  operations: z.array(z.object({ operationCode: z.string(), change: z.enum(['added', 'removed', 'changed']), fields: z.array(FieldChange) })),
  characteristics: z.array(
    z.object({
      characteristicKey: z.string(),
      name: z.string(),
      change: z.enum(['added', 'removed', 'changed']),
      /** For measured characteristics whose limits changed. */
      tolerance: z.enum(['tightened', 'loosened', 'shifted']).nullable(),
      fields: z.array(FieldChange),
    }),
  ),
  reactions: z.array(z.object({ change: z.enum(['added', 'removed']), description: z.string() })),
  summary: z.object({ added: z.number().int(), removed: z.number().int(), changed: z.number().int() }),
});
export type RevisionComparison = z.infer<typeof RevisionComparison>;
