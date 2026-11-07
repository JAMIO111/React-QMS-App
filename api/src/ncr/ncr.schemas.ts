import { z } from 'zod';

export const NcrSource = z.enum(['internal', 'customer', 'supplier']);
export const NcrStage = z.enum(['draft', 'open', 'contained', 'investigating', 'dispositioned', 'awaiting_closure', 'closed', 'cancelled']);
export const Severity = z.enum(['critical', 'major', 'minor']);
export const ClassificationKind = z.enum(['failure_mode', 'sub_failure_mode', 'process']);

const Ref = z.object({ id: z.string().uuid(), name: z.string() }).nullable();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const dateTime = z.string().datetime({ offset: true });

export const NcrSummary = z.object({
  id: z.string().uuid(),
  reference: z.string(),
  source: z.string(),
  stage: NcrStage,
  severity: Severity.nullable(),
  title: z.string(),
  detectedAt: isoDate,
  quantityAffected: z.number().nullable(),
  part: z.object({ id: z.string().uuid(), partNumber: z.string(), name: z.string(), revision: z.string().nullable() }).nullable(),
  customer: Ref,
  supplier: Ref,
  workOrder: z.string().nullable(),
  purchaseOrder: z.string().nullable(),
  customerReference: z.string().nullable(),
  failureMode: Ref,
  subFailureMode: Ref,
  causalProcess: Ref,
  /** Gross total of the NCR's costs (deleted lines excluded) in the organisation's base currency. */
  totalCost: z.number(),
  costCurrency: z.string(),
  deletedAt: dateTime.nullable(),
  createdAt: dateTime,
});
export type NcrSummary = z.infer<typeof NcrSummary>;

export const NcrDetail = NcrSummary.extend({
  stageReason: z.string().nullable(),
  description: z.string().nullable(),
  requirement: z.string().nullable(),
  actualResult: z.string().nullable(),
  site: z.object({ id: z.string().uuid(), code: z.string(), name: z.string() }).nullable(),
  partRevisionId: z.string().uuid().nullable(),
  lotNumber: z.string().nullable(),
  serialNumber: z.string().nullable(),
  quantityInspected: z.number().nullable(),
  detectionProcess: Ref,
  responsibleEmployee: Ref,
  owner: Ref,
  detectedBy: Ref,
  createdBy: Ref,
  closedAt: dateTime.nullable(),
  closedBy: Ref,
  deletedBy: Ref,
  deleteReason: z.string().nullable(),
  updatedAt: dateTime,
});
export type NcrDetail = z.infer<typeof NcrDetail>;

export const NcrPage = z.object({ data: z.array(NcrSummary), page: z.number(), pageSize: z.number(), total: z.number() });

export const SORTABLE = ['reference', 'detectedAt', 'title', 'stage', 'severity', 'quantityAffected', 'partNumber', 'customer', 'supplier', 'failureMode', 'createdAt', 'totalCost'] as const;

export const NcrListQuery = z.object({
  source: NcrSource.optional(),
  stage: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : []))
    .pipe(z.array(NcrStage)),
  q: z.string().trim().max(100).optional(),
  deleted: z.enum(['exclude', 'include', 'only']).default('exclude'),
  failureModeId: z.string().uuid().optional(),
  subFailureModeId: z.string().uuid().optional(),
  partId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  supplierId: z.string().uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  severity: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : []))
    .pipe(z.array(Severity)),
  /** Total cost (gross, base currency) between these, inclusive. */
  costMin: z.coerce.number().min(0).optional(),
  costMax: z.coerce.number().min(0).optional(),
  /** Quantity affected between these, inclusive. */
  qtyMin: z.coerce.number().min(0).optional(),
  qtyMax: z.coerce.number().min(0).optional(),
  sort: z.enum(SORTABLE).default('reference'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type NcrListQuery = z.infer<typeof NcrListQuery>;

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();
const id = z.string().uuid().nullable().optional();
const quantity = z.number().min(0).max(1e9).nullable().optional();

/** Editable fields (create and update). */
const fields = {
  title: z.string().trim().min(1).max(200),
  severity: Severity.nullable().optional(),
  description: text(5000),
  requirement: text(2000),
  actualResult: text(2000),
  siteId: id,
  partId: id,
  partRevisionId: id,
  customerId: id,
  supplierId: id,
  workOrder: text(60),
  purchaseOrder: text(60),
  customerReference: text(60),
  lotNumber: text(60),
  serialNumber: text(60),
  quantityAffected: quantity,
  quantityInspected: quantity,
  detectedAt: isoDate.optional(),
  detectionProcessId: id,
  causalProcessId: id,
  failureModeId: id,
  subFailureModeId: id,
  responsibleEmployeeId: id,
  ownerId: id,
};

export const CreateNcrBody = z
  .object({ source: NcrSource, ...fields, /** Create straight into "open" (needs the minimum content). */ open: z.boolean().optional() })
  .strict();
export type CreateNcrBody = z.infer<typeof CreateNcrBody>;

export const UpdateNcrBody = z
  .object({ ...fields, title: fields.title.optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });
export type UpdateNcrBody = z.infer<typeof UpdateNcrBody>;

export const TransitionBody = z.object({ to: NcrStage.exclude(['draft']), reason: z.string().trim().max(1000).optional() }).strict();
export const DeleteBody = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();

export const HistoryEntry = z.object({
  id: z.string().uuid(),
  at: dateTime,
  actor: Ref,
  action: z.string(),
  changedFields: z.array(z.string()),
  previous: z.record(z.unknown()).nullable(),
  current: z.record(z.unknown()).nullable(),
  reason: z.string().nullable(),
  source: z.string(),
  /** Display names for the ids of linked records in previous/current (part, customer, failure mode…). */
  names: z.record(z.string()),
  /**
   * Set on entries made from inspection links (action "readings_linked"): the readings put on this NC. "raised" when the
   * NC was created from the inspection, "added" when readings were added later.
   */
  linked: z
    .object({
      kind: z.enum(['raised', 'added']),
      inspection: z.object({ id: z.string().uuid(), reference: z.string() }).nullable(),
      readings: z.array(z.object({ id: z.string().uuid(), characteristic: z.string(), sampleNumber: z.number(), value: z.string() })),
      /** Readings of inspections the reader may not see. */
      hidden: z.number(),
      wholeInspection: z.boolean(),
    })
    .nullable()
    .optional(),
});

export const Classification = z.object({
  id: z.string().uuid(),
  kind: ClassificationKind,
  parentId: z.string().uuid().nullable(),
  code: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  active: z.boolean(),
});
export const ClassificationQuery = z.object({
  kind: ClassificationKind.optional(),
  includeInactive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
export const CreateClassificationBody = z
  .object({
    kind: ClassificationKind,
    parentId: z.string().uuid().nullable().optional(),
    code: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/, 'Use 1–20 letters, digits, "-" or "_"')
      .transform((v) => v.toUpperCase())
      .nullable()
      .optional(),
    name: z.string().trim().min(1).max(100),
    description: text(500),
  })
  .strict();
export const UpdateClassificationBody = z
  .object({
    parentId: z.string().uuid().nullable().optional(),
    code: CreateClassificationBody.shape.code,
    name: z.string().trim().min(1).max(100).optional(),
    description: text(500),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });

export const NcrRangesQuery = z.object({ source: NcrSource.optional() });
/** Highest values in the register, to size the cost and quantity sliders. */
export const NcrRanges = z.object({
  cost: z.object({ max: z.number() }),
  quantity: z.object({ max: z.number() }),
  baseCurrency: z.string(),
});
