import { z } from 'zod';

const Iso = z.string().datetime({ offset: true });
const Person = z.object({ id: z.string().uuid(), name: z.string() }).nullable();
const text = (max: number) => z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();

export const STRATEGIES = ['full', 'first_article', 'fixed', 'percentage', 'plan', 'skip_lot', 'none'] as const;
export const LEVELS = ['increased', 'normal', 'reduced', 'skip'] as const;
export const RISKS = ['low', 'medium', 'high', 'critical'] as const;
export const REQUIREMENT_STATUSES = ['draft', 'approved', 'superseded', 'retired'] as const;

const PlanBand = z.object({ fromQuantity: z.number().int().min(1), toQuantity: z.number().int().min(1), sampleSize: z.number().int().min(1), acceptNumber: z.number().int().min(0) }).strict();

const Fields = {
  name: z.string().trim().min(1, 'Give the requirement a name').max(120),
  supplierId: z.string().uuid().nullable().optional(),
  partId: z.string().uuid().nullable().optional(),
  partFamilyId: z.string().uuid().nullable().optional(),
  classificationId: z.string().uuid().nullable().optional(),
  riskRating: z.enum(RISKS).nullable().optional(),
  strategy: z.enum(STRATEGIES),
  level: z.enum(LEVELS).default('normal'),
  sampleSize: z.number().int().min(1).max(100000).nullable().optional(),
  percentage: z.number().gt(0).max(100).nullable().optional(),
  skipEvery: z.number().int().min(2).max(1000).nullable().optional(),
  acceptNumber: z.number().int().min(0).max(100000).default(0),
  plan: z.array(PlanBand).min(1).max(20).nullable().optional(),
  /** The control plan operation the incoming inspection is made at. */
  operationCode: z.string().trim().min(1).max(40).default('INCOMING'),
  rationale: text(1000),
  /** The approved requirement this one replaces. Approving it supersedes the old one. */
  supersedesId: z.string().uuid().nullable().optional(),
};

/** Each strategy takes only its own settings, exactly as the database insists. */
const checkStrategy = (b: { strategy: string; sampleSize?: number | null; percentage?: number | null; skipEvery?: number | null; plan?: unknown[] | null }, ctx: z.RefinementCtx) => {
  const has = { s: b.sampleSize != null, p: b.percentage != null, k: b.skipEvery != null, l: b.plan != null };
  const bad = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (b.strategy === 'full' || b.strategy === 'none') { if (has.s || has.p || has.k || has.l) bad('This strategy takes no sample settings'); }
  else if (b.strategy === 'fixed' || b.strategy === 'first_article') { if (!has.s) bad('Give the sample size'); if (has.p || has.k || has.l) bad('This strategy only takes a sample size'); }
  else if (b.strategy === 'percentage') { if (!has.p) bad('Give the percentage'); if (has.s || has.k || has.l) bad('This strategy only takes a percentage'); }
  else if (b.strategy === 'plan') { if (!has.l) bad('Give the sampling plan'); if (has.s || has.p || has.k) bad('This strategy only takes a sampling plan'); }
  else if (b.strategy === 'skip_lot') { if (!has.s || !has.k) bad('Give the sample size and how often a delivery is inspected'); if (has.p || has.l) bad('This strategy takes a sample size and a skip interval only'); }
};

export const CreateRequirementBody = z.object(Fields).strict().superRefine(checkStrategy);
export type CreateRequirementBody = z.infer<typeof CreateRequirementBody>;
/** Editing a draft: any of the fields; the result is checked as a whole by the database. */
export const UpdateRequirementBody = z.object(Object.fromEntries(Object.entries(Fields).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()]))).partial().strict().refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });
export type UpdateRequirementBody = z.infer<typeof UpdateRequirementBody>;
export const ApproveRequirementBody = z.object({ note: text(1000) }).strict();
export type ApproveRequirementBody = z.infer<typeof ApproveRequirementBody>;
export const RetireRequirementBody = z.object({ reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(1000) }).strict();
export type RetireRequirementBody = z.infer<typeof RetireRequirementBody>;

export const RequirementListQuery = z.object({
  /** active = drafts and approved (default), all, or a list of statuses. */
  status: z.string().refine((v) => v === 'active' || v === 'all' || v.split(',').every((x) => (REQUIREMENT_STATUSES as readonly string[]).includes(x)), 'Use active, all or known statuses').default('active'),
  supplierId: z.string().uuid().optional(),
  partId: z.string().uuid().optional(),
});
export type RequirementListQuery = z.infer<typeof RequirementListQuery>;

export const PreviewQuery = z.object({
  supplierId: z.string().uuid(),
  partId: z.string().uuid().optional(),
  quantity: z.coerce.number().gt(0).max(999_999_999),
  siteId: z.string().uuid().optional(),
});
export type PreviewQuery = z.infer<typeof PreviewQuery>;

export const Requirement = z.object({
  id: z.string().uuid(),
  name: z.string(),
  supplier: z.object({ id: z.string().uuid(), code: z.string(), name: z.string() }).nullable(),
  part: z.object({ id: z.string().uuid(), partNumber: z.string(), name: z.string() }).nullable(),
  partFamily: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
  classification: z.object({ id: z.string().uuid(), label: z.string() }).nullable(),
  riskRating: z.enum(RISKS).nullable(),
  strategy: z.enum(STRATEGIES),
  level: z.enum(LEVELS),
  sampleSize: z.number().int().nullable(),
  percentage: z.number().nullable(),
  skipEvery: z.number().int().nullable(),
  acceptNumber: z.number().int(),
  plan: z.array(PlanBand).nullable(),
  operationCode: z.string(),
  rationale: z.string().nullable(),
  status: z.enum(REQUIREMENT_STATUSES),
  /** Reduces inspection (reduced / skip level, skip-lot or none): never applied to a part with a critical characteristic. */
  reducesControls: z.boolean(),
  supersedesId: z.string().uuid().nullable(),
  createdBy: Person,
  createdAt: Iso,
  approvedBy: Person,
  approvedAt: Iso.nullable(),
  approvalNote: z.string().nullable(),
  retiredAt: Iso.nullable(),
  retireReason: z.string().nullable(),
});
export type Requirement = z.infer<typeof Requirement>;
export const RequirementList = z.object({ data: z.array(Requirement) });

export const IncomingPreview = z.object({
  required: z.boolean(),
  ruleId: z.string().uuid().nullable(),
  ruleName: z.string().nullable(),
  strategy: z.string(),
  level: z.string(),
  sampleSize: z.number().int().nullable(),
  acceptNumber: z.number().int(),
  operationCode: z.string().nullable(),
  basis: z.string(),
  overridden: z.boolean(),
  controlled: z.boolean(),
});
export type IncomingPreview = z.infer<typeof IncomingPreview>;

export const ReceiptSource = z.object({
  available: z.boolean(),
  items: z.array(z.object({ linkId: z.string().uuid(), linkedAt: z.string(), receiptId: z.string().uuid(), reference: z.string(), lineNumber: z.number().int(), receivedOn: z.string(), deliveryNote: z.string().nullable(), lotNumber: z.string().nullable(), quantityReceived: z.number() })),
});

/** Received lines of a supplier to link a non-conformance to (newest first). */
export const ReceiptLineLookupQuery = z.object({
  supplierId: z.string().uuid(),
  q: z.string().trim().max(100).optional(),
  partId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
export type ReceiptLineLookupQuery = z.infer<typeof ReceiptLineLookupQuery>;
export const ReceiptLineLookup = z.object({
  data: z.array(z.object({
    id: z.string().uuid(), receiptId: z.string().uuid(), reference: z.string(), lineNumber: z.number().int(), receivedOn: z.string(), deliveryNote: z.string().nullable(),
    part: z.object({ id: z.string().uuid(), partNumber: z.string(), name: z.string() }).nullable(), material: z.string().nullable(), lotNumber: z.string().nullable(),
    quantityReceived: z.number(), poNumber: z.string().nullable(),
  })),
});

export const LinkNcrBody = z.object({ receiptLineId: z.string().uuid() }).strict();
export type LinkNcrBody = z.infer<typeof LinkNcrBody>;
export const UnlinkNcrBody = z.object({ reason: z.string().trim().min(3, 'Say why the link is ending').max(1000) }).strict();
export type UnlinkNcrBody = z.infer<typeof UnlinkNcrBody>;
