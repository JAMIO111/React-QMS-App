import { z } from 'zod';

const Iso = z.string().datetime({ offset: true });
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-30');
const Person = z.object({ id: z.string().uuid(), name: z.string() }).nullable();
const text = (max: number) => z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();
const reason = z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(1000);

export const PO_STATUSES = ['open', 'closed', 'cancelled'] as const;
export const PO_SORTS = ['poNumber', 'supplier', 'orderedOn', 'status', 'lines', 'nextDue'] as const;
export const RECEIPT_SORTS = ['reference', 'supplier', 'receivedOn', 'purchaseOrder', 'createdAt'] as const;

// ---- input ---------------------------------------------------------------------------------------

export const PurchaseOrderListQuery = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  supplierId: z.string().uuid().optional(),
  /** open (default), closed, cancelled, a list of them, or all. */
  status: z.string().refine((v) => v === 'all' || v.split(',').every((x) => (PO_STATUSES as readonly string[]).includes(x)), 'Use all or known statuses').default('open'),
  /** Only orders with a line that is past its agreed (or requested) date and not fully received. */
  late: z.enum(['true']).optional(),
  sort: z.enum(PO_SORTS).default('orderedOn'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type PurchaseOrderListQuery = z.infer<typeof PurchaseOrderListQuery>;

export const PoLookupQuery = z.object({ supplierId: z.string().uuid().optional(), q: z.string().trim().min(1).max(100).optional() });
export type PoLookupQuery = z.infer<typeof PoLookupQuery>;

export const PoLineInput = z
  .object({
    partId: z.string().uuid().nullable().optional(),
    material: text(200),
    quantity: z.number().gt(0).max(999_999_999),
    unit: text(20),
    /** The date it was originally requested for. It never changes. */
    requestedOn: DateOnly,
    agreedOn: DateOnly.nullable().optional(),
  })
  .strict()
  .refine((l) => !!(l.partId || l.material), { message: 'Name a part or a material' });
export type PoLineInput = z.infer<typeof PoLineInput>;

export const CreatePurchaseOrderBody = z
  .object({
    supplierId: z.string().uuid(),
    poNumber: z.string().trim().min(1, 'Give the order a number').max(40),
    orderedOn: DateOnly.optional(),
    notes: text(2000),
    lines: z.array(PoLineInput).min(1).max(100),
  })
  .strict();
export type CreatePurchaseOrderBody = z.infer<typeof CreatePurchaseOrderBody>;

export const AgreedDateBody = z.object({ agreedOn: DateOnly.nullable() }).strict();
export type AgreedDateBody = z.infer<typeof AgreedDateBody>;
export const ReasonBody = z.object({ reason }).strict();
export type ReasonBody = z.infer<typeof ReasonBody>;

export const ReceiptListQuery = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  supplierId: z.string().uuid().optional(),
  purchaseOrderId: z.string().uuid().optional(),
  lotId: z.string().uuid().optional(),
  status: z.enum(['received', 'cancelled', 'all']).default('received'),
  from: DateOnly.optional(),
  to: DateOnly.optional(),
  sort: z.enum(RECEIPT_SORTS).default('receivedOn'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type ReceiptListQuery = z.infer<typeof ReceiptListQuery>;

export const ReceiptLineInput = z
  .object({
    poLineId: z.string().uuid().nullable().optional(),
    partId: z.string().uuid().nullable().optional(),
    material: text(200),
    quantity: z.number().gt(0).max(999_999_999),
    /** Names the lot this line became. It is made as a received lot from the supplier (it needs a part). */
    lotNumber: text(60),
    notes: text(1000),
  })
  .strict()
  .refine((l) => !!(l.poLineId || l.partId || l.material), { message: 'Name an order line, a part or a material' });
export type ReceiptLineInput = z.infer<typeof ReceiptLineInput>;

export const RecordReceiptBody = z
  .object({
    supplierId: z.string().uuid(),
    purchaseOrderId: z.string().uuid().nullable().optional(),
    siteId: z.string().uuid().nullable().optional(),
    receivedOn: DateOnly,
    deliveryNote: text(100),
    notes: text(2000),
    lines: z.array(ReceiptLineInput).min(1).max(100),
    /** Sent by the client so that a retried request returns the same receipt instead of making another. */
    clientKey: z.string().trim().min(8).max(100).optional(),
  })
  .strict();
export type RecordReceiptBody = z.infer<typeof RecordReceiptBody>;

export const DispositionBody = z
  .object({ decision: z.enum(['held', 'accepted', 'rejected', 'conditional']), reason: text(1000), conditions: text(2000), quantity: z.number().gt(0).nullable().optional() })
  .strict();
export type DispositionBody = z.infer<typeof DispositionBody>;
export const RaiseNcrBody = z
  .object({ title: text(200), description: text(4000), severity: z.enum(['minor', 'major', 'critical']).optional(), categoryId: z.string().uuid().nullable().optional(), quantity: z.number().gt(0).nullable().optional() })
  .strict();
export type RaiseNcrBody = z.infer<typeof RaiseNcrBody>;

// ---- output --------------------------------------------------------------------------------------

const SupplierRef = z.object({ id: z.string().uuid(), code: z.string(), name: z.string() });
const PartRef = z.object({ id: z.string().uuid(), partNumber: z.string(), name: z.string() });

export const PurchaseOrderRow = z.object({
  id: z.string().uuid(),
  poNumber: z.string(),
  supplier: SupplierRef,
  status: z.enum(PO_STATUSES),
  orderedOn: DateOnly,
  lineCount: z.number().int(),
  /** Open lines that still expect goods, and how many of those are past their agreed (else requested) date. */
  outstandingLines: z.number().int(),
  lateLines: z.number().int(),
  nextDueOn: DateOnly.nullable(),
  createdAt: Iso,
});
export type PurchaseOrderRow = z.infer<typeof PurchaseOrderRow>;
export const PurchaseOrderPage = z.object({ data: z.array(PurchaseOrderRow), page: z.number().int(), pageSize: z.number().int(), total: z.number().int() });

const PoLine = z.object({
  id: z.string().uuid(),
  lineNumber: z.number().int(),
  part: PartRef.nullable(),
  material: z.string().nullable(),
  quantityOrdered: z.number(),
  unit: z.string().nullable(),
  requestedOn: DateOnly,
  agreedOn: DateOnly.nullable(),
  /** The date that counts for "late" today: the latest agreed date, else the requested one. */
  dueOn: DateOnly,
  status: z.enum(PO_STATUSES),
  quantityReceived: z.number(),
  quantityOutstanding: z.number(),
  late: z.boolean(),
  daysLate: z.number().int(),
  firstReceivedOn: DateOnly.nullable(),
  lastReceivedOn: DateOnly.nullable(),
});
const ReceiptRef = z.object({ id: z.string().uuid(), reference: z.string(), receivedOn: DateOnly, deliveryNote: z.string().nullable(), status: z.enum(['received', 'cancelled']), lineCount: z.number().int() });
export const PurchaseOrderDetail = PurchaseOrderRow.extend({
  notes: z.string().nullable(),
  cancelReason: z.string().nullable(),
  closedAt: Iso.nullable(),
  createdBy: Person,
  lines: z.array(PoLine),
  receipts: z.array(ReceiptRef),
});
export type PurchaseOrderDetail = z.infer<typeof PurchaseOrderDetail>;
export const PoLookup = z.object({ data: z.array(z.object({ id: z.string().uuid(), poNumber: z.string(), supplier: SupplierRef })) });

export const ReceiptRow = z.object({
  id: z.string().uuid(),
  reference: z.string(),
  supplier: SupplierRef,
  purchaseOrder: z.object({ id: z.string().uuid(), poNumber: z.string() }).nullable(),
  site: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
  receivedOn: DateOnly,
  deliveryNote: z.string().nullable(),
  status: z.enum(['received', 'cancelled']),
  lineCount: z.number().int(),
  createdAt: Iso,
});
export type ReceiptRow = z.infer<typeof ReceiptRow>;
export const ReceiptPage = z.object({ data: z.array(ReceiptRow), page: z.number().int(), pageSize: z.number().int(), total: z.number().int() });

export const DISPOSITIONS = ['held', 'accepted', 'rejected', 'conditional'] as const;
const Disposition = z.object({ decision: z.enum(DISPOSITIONS), reason: z.string().nullable(), conditions: z.string().nullable(), quantityRejected: z.number().nullable(), decidedAt: Iso, decidedBy: Person });
const Determination = z.object({
  required: z.boolean(),
  ruleId: z.string().uuid().nullable(),
  ruleName: z.string().nullable(),
  strategy: z.string(),
  level: z.string(),
  sampleSize: z.number().int().nullable(),
  acceptNumber: z.number().int(),
  operationCode: z.string().nullable(),
  basis: z.string(),
  /** A rule that would reduce inspection was not applied (a critical or unresolved part), or a plan had no band for the lot. */
  overridden: z.boolean(),
});
const Assessment = z.object({
  state: z.enum(['not_required', 'not_started', 'in_progress', 'completed', 'abandoned']),
  samples: z.number().int(),
  failedSamples: z.number().int(),
  requiredSamples: z.number().int().nullable(),
  acceptNumber: z.number().int(),
  /** Whether the inspection evidence supports accepting the line: acceptable, not_acceptable, or incomplete. */
  outcome: z.enum(['acceptable', 'not_acceptable', 'incomplete']),
  inspectionId: z.string().uuid().nullable(),
  inspectionReference: z.string().nullable(),
});
/** Where a line stands: not required, pending inspection, or the latest decision. */
export const LINE_STATUSES = ['not_required', 'pending', 'held', 'accepted', 'rejected', 'conditional'] as const;
const ReceiptLine = z.object({
  id: z.string().uuid(),
  status: z.enum(LINE_STATUSES),
  determination: Determination.nullable(),
  assessment: Assessment.nullable(),
  disposition: Disposition.nullable(),
  dispositions: z.array(Disposition),
  lotStatus: z.string().nullable(),
  ncrs: z.array(z.object({ id: z.string().uuid(), reference: z.string(), stage: z.string() })),
  /** Live material certificates on file for this line (or its lot); information only. */
  certificates: z.object({ received: z.number().int(), accepted: z.number().int(), rejected: z.number().int() }),
  poLine: z.object({ id: z.string().uuid(), lineNumber: z.number().int() }).nullable(),
  part: PartRef.nullable(),
  material: z.string().nullable(),
  quantityReceived: z.number(),
  lot: z.object({ id: z.string().uuid(), lotNumber: z.string() }).nullable(),
  notes: z.string().nullable(),
});
export const ReceiptDetail = ReceiptRow.extend({
  notes: z.string().nullable(),
  cancelledAt: Iso.nullable(),
  cancelledBy: Person,
  cancelReason: z.string().nullable(),
  createdBy: Person,
  lines: z.array(ReceiptLine),
});
export type ReceiptDetail = z.infer<typeof ReceiptDetail>;
