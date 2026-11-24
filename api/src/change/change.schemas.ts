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

export const CHANGE_STAGES = ['draft', 'assessment', 'approval', 'approved', 'implementing', 'verifying', 'closed', 'rejected', 'cancelled'] as const;
export const OPEN_STAGES = ['draft', 'assessment', 'approval', 'approved', 'implementing', 'verifying'] as const;
export const URGENCIES = ['normal', 'expedited'] as const;
export const ORIGIN_KINDS = ['ncr', 'capa', 'audit_finding', 'risk', 'document_change_request'] as const;
export const LINK_KINDS = ['part', 'part_family', 'machine', 'supplier', 'customer', 'production_order', 'operation_code'] as const;

// ---- the lists --------------------------------------------------------------------------------------
export const AllQuery = z.object({ all: z.enum(['true', 'false']).default('false') });
export type AllQuery = z.infer<typeof AllQuery>;

const listFields = {
  label: z.string().trim().min(1).max(60),
  description: text(300),
  sequence: z.number().int().min(0).max(10000).optional(),
};
export const CreateTypeBody = z.object({ ...listFields, needsCustomerApproval: z.boolean().optional() }).strict();
export type CreateTypeBody = z.infer<typeof CreateTypeBody>;
export const UpdateTypeBody = z
  .object({ ...listFields, label: listFields.label.optional(), needsCustomerApproval: z.boolean().optional(), active: z.boolean().optional() })
  .strict()
  .refine(nothingToChange, 'Nothing to change');
export type UpdateTypeBody = z.infer<typeof UpdateTypeBody>;

export const CreateFunctionBody = z.object(listFields).strict();
export type CreateFunctionBody = z.infer<typeof CreateFunctionBody>;
export const UpdateFunctionBody = z
  .object({ ...listFields, label: listFields.label.optional(), active: z.boolean().optional() })
  .strict()
  .refine(nothingToChange, 'Nothing to change');
export type UpdateFunctionBody = z.infer<typeof UpdateFunctionBody>;

/** The impact areas are a fixed list: an organisation can switch one off, nothing else. */
export const UpdateAreaBody = z.object({ active: z.boolean() }).strict();
export type UpdateAreaBody = z.infer<typeof UpdateAreaBody>;

export const ListItem = z.object({
  id: z.string().uuid(),
  key: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  sequence: z.number().int(),
  active: z.boolean(),
  /** Types only. */
  needsCustomerApproval: z.boolean().optional(),
  /** Changes (any stage) that use it; types only. */
  changes: z.number().int().optional(),
});
export type ListItem = z.infer<typeof ListItem>;

// ---- changes ----------------------------------------------------------------------------------------
/** A thing a change covers: `{ kind, id }`, or `{ kind: 'operation_code', code }`. */
export const LinkItem = z.union([
  z.object({ kind: z.enum(LINK_KINDS).exclude(['operation_code']), id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('operation_code'), code: z.string().trim().min(1).max(40) }).strict(),
]);
export type LinkItem = z.infer<typeof LinkItem>;
export const LinksBody = z.object({ links: z.array(LinkItem).max(100) }).strict();
export type LinksBody = z.infer<typeof LinksBody>;

export const OriginRef = z.object({ kind: z.enum(ORIGIN_KINDS), id: z.string().uuid() }).strict();

const changeFields = {
  title: z.string().trim().min(1).max(200),
  description: text(4000),
  reason: text(4000),
  typeId: z.string().uuid(),
  urgency: z.enum(URGENCIES).optional(),
};
export const CreateChangeBody = z.object({ ...changeFields, origin: OriginRef.optional(), links: z.array(LinkItem).max(100).optional() }).strict();
export type CreateChangeBody = z.infer<typeof CreateChangeBody>;
export const UpdateChangeBody = z
  .object({ ...changeFields, title: changeFields.title.optional(), typeId: changeFields.typeId.optional() })
  .strict()
  .refine(nothingToChange, 'Nothing to change');
export type UpdateChangeBody = z.infer<typeof UpdateChangeBody>;

export const ReasonBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
export type ReasonBody = z.infer<typeof ReasonBody>;

const csv = (values: readonly string[]) =>
  z
    .string()
    .optional()
    .refine((v) => !v || v.split(',').every((x) => values.includes(x)), `One or more of ${values.join(', ')}`);

export const ChangeListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  /** Stages separated by commas, or `open` (default: everything still going), or `all`. */
  stage: csv([...CHANGE_STAGES, 'open', 'all']),
  typeId: z.string().uuid().optional(),
  urgency: z.enum(URGENCIES).optional(),
  /** Only changes the caller raised. */
  owner: z.enum(['me']).optional(),
  /** Only changes with a sign-off waiting for the caller. */
  signer: z.enum(['me']).optional(),
  originKind: csv(ORIGIN_KINDS),
  partId: z.string().uuid().optional(),
  partFamilyId: z.string().uuid().optional(),
  machineId: z.string().uuid().optional(),
  supplierId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  sort: z.enum(['reference', 'title', 'type', 'stage', 'urgency', 'raisedBy', 'createdAt', 'updatedAt']).default('reference'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ChangeListQuery = z.infer<typeof ChangeListQuery>;

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date as yyyy-MM-dd');
export const IMPACT_STATUSES = ['not_assessed', 'affected', 'not_affected'] as const;
export const CUSTOMER_APPROVALS = ['not_needed', 'required', 'requested', 'approved', 'rejected', 'waived'] as const;
export const CUT_IN_KINDS = ['none', 'date', 'order', 'lot', 'serial'] as const;
export const STOCK_ACTIONS = ['use_up', 'rework', 'scrap', 'return'] as const;

/** One impact area answered: affected (a note says how), not affected, or put back to not assessed. */
export const ImpactBody = z.object({ areaId: z.string().uuid(), status: z.enum(IMPACT_STATUSES), note: text(1000) }).strict();
export type ImpactBody = z.infer<typeof ImpactBody>;

/** The board: which functions must sign and who signs for each. Replaces the whole board. */
export const BoardBody = z.object({ board: z.array(z.object({ functionId: z.string().uuid(), signerId: z.string().uuid() }).strict()).max(30) }).strict();
export type BoardBody = z.infer<typeof BoardBody>;

export const DecideBody = z.object({ approve: z.boolean(), comment: text(1000) }).strict();
export type DecideBody = z.infer<typeof DecideBody>;

/** Keys present are set; null clears (the cut-in point, and what happens to existing stock). */
export const CutInBody = z
  .object({
    kind: z.enum(CUT_IN_KINDS).optional(),
    date: isoDay.nullable().optional(),
    orderId: z.string().uuid().nullable().optional(),
    lotId: z.string().uuid().nullable().optional(),
    serialId: z.string().uuid().nullable().optional(),
    stockAction: z.enum(STOCK_ACTIONS).nullable().optional(),
    stockNote: text(1000),
  })
  .strict()
  .refine(nothingToChange, 'Nothing to change');
export type CutInBody = z.infer<typeof CutInBody>;

export const CustomerApprovalBody = z
  .object({ status: z.enum(CUSTOMER_APPROVALS), reference: text(200), on: isoDay.nullable().optional(), waivedReason: text(500) })
  .strict();
export type CustomerApprovalBody = z.infer<typeof CustomerApprovalBody>;

export { Attachment, CreateAttachmentBody, DeleteBody, DeletedQuery } from '../calibration/calibration.schemas';
