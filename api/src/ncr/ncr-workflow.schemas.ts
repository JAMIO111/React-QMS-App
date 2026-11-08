import { z } from 'zod';

const dateTime = z.string().datetime({ offset: true });
const Ref = z.object({ id: z.string().uuid(), name: z.string() }).nullable();
/** The affected lot a containment action or disposition names (null = the non-conformance as a whole). */
const LotRef = z.object({ id: z.string().uuid(), lotNumber: z.string() }).nullable();
const money = z.number().min(0).max(1e9);

export const CONTAINMENT_KINDS = ['quarantine', 'sort', 'stop_ship', 'notify_customer', 'notify_supplier', 'recall', 'other'] as const;
export const DISPOSITION_DECISIONS = ['rework', 'repair', 'scrap', 'use_as_is', 'return_to_supplier', 'concession'] as const;

export const ContainmentAction = z.object({
  id: z.string().uuid(),
  nonconformanceId: z.string().uuid(),
  kind: z.enum(CONTAINMENT_KINDS),
  description: z.string(),
  owner: Ref,
  dueDate: z.string().nullable(),
  quantityContained: z.number().nullable(),
  lot: LotRef,
  status: z.enum(['open', 'done', 'cancelled']),
  doneNote: z.string().nullable(),
  doneAt: dateTime.nullable(),
  doneBy: Ref,
  cancelReason: z.string().nullable(),
  createdAt: dateTime,
  createdBy: Ref,
});
export type ContainmentAction = z.infer<typeof ContainmentAction>;

/** Containment of a non-conformance: its actions, why none was needed (if said so) and what is still to do before it counts as resolved. */
export const Containment = z.object({
  actions: z.array(ContainmentAction),
  notNeededReason: z.string().nullable(),
  /** Every action is done or cancelled and at least one is done, or a reason says none was needed. */
  resolved: z.boolean(),
  problems: z.array(z.string()),
});
export type Containment = z.infer<typeof Containment>;

export const Disposition = z.object({
  id: z.string().uuid(),
  nonconformanceId: z.string().uuid(),
  decision: z.enum(DISPOSITION_DECISIONS),
  quantity: z.number(),
  instructions: z.string(),
  reference: z.string().nullable(),
  lot: LotRef,
  status: z.enum(['proposed', 'approved', 'cancelled']),
  approvedAt: dateTime.nullable(),
  approvedBy: Ref,
  approvalNote: z.string().nullable(),
  cancelledAt: dateTime.nullable(),
  cancelledBy: Ref,
  cancelReason: z.string().nullable(),
  createdAt: dateTime,
  createdBy: Ref,
});
export type Disposition = z.infer<typeof Disposition>;

export const Dispositions = z.object({
  data: z.array(Disposition),
  /** The quantity affected, what approved and proposed dispositions cover, and what is left to decide. */
  affected: z.number().nullable(),
  approvedQuantity: z.number(),
  proposedQuantity: z.number(),
  remaining: z.number(),
  /** The caller may approve and cancel approved dispositions. */
  canApprove: z.boolean(),
  settled: z.boolean(),
  problems: z.array(z.string()),
});
export type Dispositions = z.infer<typeof Dispositions>;

/** What is still needed to reach each later stage (empty = nothing). */
export const Gates = z.object({
  contained: z.array(z.string()),
  investigating: z.array(z.string()),
  dispositioned: z.array(z.string()),
  awaitingClosure: z.array(z.string()),
  closed: z.array(z.string()),
});
export type Gates = z.infer<typeof Gates>;

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z.union([z.string().trim().max(max), z.null()]).optional().transform((v) => (v === '' || v === undefined ? (v === '' ? null : undefined) : v));

export const CreateContainmentBody = z
  .object({
    kind: z.enum(CONTAINMENT_KINDS),
    description: text(1000),
    ownerEmployeeId: z.string().uuid().nullable().optional(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    quantityContained: money.nullable().optional(),
    lotId: z.string().uuid().nullable().optional(),
  })
  .strict();
export const UpdateContainmentBody = CreateContainmentBody.partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });
export const CompleteContainmentBody = z.object({ note: text(2000), quantityContained: money.nullable().optional() }).strict();
export const ReasonBody = z.object({ reason: text(1000) }).strict();

export const CreateDispositionBody = z
  .object({ decision: z.enum(DISPOSITION_DECISIONS), quantity: z.number().gt(0).max(1e9), instructions: text(2000), reference: optionalText(200), lotId: z.string().uuid().nullable().optional() })
  .strict();
export const UpdateDispositionBody = CreateDispositionBody.partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });
export const ApproveBody = z.object({ note: z.string().trim().max(1000).optional() }).strict();
export const ContainmentReasonBody = z.object({ reason: z.union([z.string().trim().min(1).max(500), z.null()]) }).strict();

/** A lot (and optionally some of its serial numbers) a non-conformance touches, with how many items. Removed rows stay, with the reason. */
export const AffectedLot = z.object({
  id: z.string().uuid(),
  nonconformanceId: z.string().uuid(),
  lot: z.object({ id: z.string().uuid(), lotNumber: z.string(), status: z.string(), statusReason: z.string().nullable() }),
  quantity: z.number(),
  serials: z.array(z.object({ id: z.string().uuid(), serialNumber: z.string() })),
  note: z.string().nullable(),
  /** Approved dispositions and live (proposed or approved) dispositions naming this lot. */
  approvedQuantity: z.number(),
  proposedQuantity: z.number(),
  removedAt: dateTime.nullable(),
  removedBy: Ref,
  removedReason: z.string().nullable(),
  createdAt: dateTime,
  createdBy: Ref,
});
export type AffectedLot = z.infer<typeof AffectedLot>;

export const AffectedLots = z.object({
  data: z.array(AffectedLot),
  /** The NC's quantity affected, what its live lots add up to, and what is not yet placed in a lot. */
  affected: z.number().nullable(),
  assigned: z.number(),
  remaining: z.number(),
  /** The lot the NC itself is linked to (for example one it was raised on) when it is not among the live affected lots; offered, never added silently. */
  suggestedLot: z.object({ id: z.string().uuid(), lotNumber: z.string() }).nullable(),
  /** Lot problems from the stage gate: a lot whose approved dispositions do not yet cover it. */
  problems: z.array(z.string()),
});
export type AffectedLots = z.infer<typeof AffectedLots>;

export const AddAffectedLotBody = z
  .object({
    lotId: z.string().uuid(),
    quantity: z.number().gt(0).max(1e9),
    serialIds: z.array(z.string().uuid()).max(500).optional(),
    note: optionalText(1000),
  })
  .strict();
export const UpdateAffectedLotBody = z
  .object({ quantity: z.number().gt(0).max(1e9), serialIds: z.array(z.string().uuid()).max(500), note: optionalText(1000) })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });
