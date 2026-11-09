import { z } from 'zod';

const Iso = z.string().datetime({ offset: true });
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-30');
const Person = z.object({ id: z.string().uuid(), name: z.string() }).nullable();

export const SCAR_STATUSES = ['draft', 'issued', 'acknowledged', 'response_received', 'under_review', 'revision_requested', 'accepted', 'verifying', 'closed', 'cancelled'] as const;
export const SCAR_SEVERITIES = ['minor', 'major', 'critical'] as const;
export const SCAR_SORTS = ['reference', 'title', 'supplier', 'status', 'severity', 'responseDueOn', 'ncrCount', 'createdAt', 'issuedAt'] as const;
/** Statuses in which the supplier's response is awaited (so a past due date means overdue). */
export const AWAITING_RESPONSE = ['issued', 'acknowledged', 'revision_requested'] as const;

const csv = (allowed: readonly string[]) => z.string().refine((v) => v.split(',').every((x) => allowed.includes(x)), 'Use a comma-separated list of known values');
const text = (max: number) => z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();
const required = (min: number, max: number, what: string) => z.string().trim().min(min, `${what} is needed`).max(max);

// ---- input ---------------------------------------------------------------------------------------

export const ScarListQuery = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  /** `running` = everything not closed or cancelled; `all`; or a list of statuses. Default: running. */
  status: z.string().refine((v) => v === 'running' || v === 'all' || v.split(',').every((x) => (SCAR_STATUSES as readonly string[]).includes(x)), 'Use running, all or known statuses').default('running'),
  severity: csv(SCAR_SEVERITIES).optional(),
  supplierId: z.string().uuid().optional(),
  ncrId: z.string().uuid().optional(),
  overdue: z.enum(['true']).optional(),
  sort: z.enum(SCAR_SORTS).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type ScarListQuery = z.infer<typeof ScarListQuery>;

/** One affected item: a part of ours, a material in words, a lot, a receipt reference (typed until receiving exists), with a quantity. A lot brings its part along. */
export const ScarItemInput = z
  .object({
    partId: z.string().uuid().nullable().optional(),
    material: text(200),
    lotId: z.string().uuid().nullable().optional(),
    receiptReference: text(100),
    quantity: z.number().min(0).max(999_999_999).nullable().optional(),
    notes: text(1000),
  })
  .strict()
  .refine((i) => !!(i.partId || i.lotId || i.material || i.receiptReference), { message: 'Name a part, a material, a lot or a receipt' });
export type ScarItemInput = z.infer<typeof ScarItemInput>;

export const ROOT_CAUSE_METHODS = ['five_whys', 'fishbone', 'other'] as const;

export const CreateScarBody = z
  .object({
    supplierId: z.string().uuid(),
    title: required(3, 200, 'A title'),
    problemDescription: text(4000),
    severity: z.enum(SCAR_SEVERITIES).default('minor'),
    responseDueOn: DateOnly.nullable().optional(),
    contactId: z.string().uuid().nullable().optional(),
    ncrIds: z.array(z.string().uuid()).max(50).default([]),
    capaId: z.string().uuid().nullable().optional(),
    requirementBreached: text(2000),
    objectiveEvidence: text(4000),
    containmentRequirements: text(4000),
    /** The internal owner: an active member. Defaults to whoever raises the SCAR. */
    ownerId: z.string().uuid().optional(),
    items: z.array(ScarItemInput).max(50).default([]),
    /** Sent by the client so that a retried request returns the same SCAR instead of making another. */
    clientKey: z.string().trim().min(8).max(100).optional(),
  })
  .strict();
export type CreateScarBody = z.infer<typeof CreateScarBody>;

export const UpdateScarBody = z
  .object({
    title: required(3, 200, 'A title'),
    problemDescription: text(4000),
    requirementBreached: text(2000),
    objectiveEvidence: text(4000),
    containmentRequirements: text(4000),
    severity: z.enum(SCAR_SEVERITIES),
    responseDueOn: DateOnly.nullable(),
    contactId: z.string().uuid().nullable(),
    capaId: z.string().uuid().nullable(),
    ownerId: z.string().uuid(),
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });
export type UpdateScarBody = z.infer<typeof UpdateScarBody>;

export const AcknowledgeScarBody = z.object({ note: text(1000) }).strict();
export type AcknowledgeScarBody = z.infer<typeof AcknowledgeScarBody>;

export const RecordResponseBody = z
  .object({
    rootCause: required(3, 4000, 'A root cause'),
    containment: text(4000),
    correctiveAction: required(3, 4000, 'A corrective action'),
    preventiveAction: text(4000),
    plannedCompletionOn: DateOnly.nullable().optional(),
    respondedOn: DateOnly,
    respondedByName: text(200),
    contactId: z.string().uuid().nullable().optional(),
    /** How far the problem reaches (other lots, parts, customers), the escape point (why it was not caught), who is responsible, and how the root cause was found. */
    extentOfCondition: text(4000),
    escapePoint: text(4000),
    responsibleName: text(200),
    rootCauseMethod: z.enum(ROOT_CAUSE_METHODS).nullable().optional(),
  })
  .strict();
export type RecordResponseBody = z.infer<typeof RecordResponseBody>;

export const ReviewBody = z.object({ decision: z.enum(['accepted', 'revision_requested']), note: required(3, 2000, 'A note') }).strict();
export type ReviewBody = z.infer<typeof ReviewBody>;

export const ImplementationBody = z.object({ description: required(3, 4000, 'A description'), implementedOn: DateOnly, evidenceNote: text(2000) }).strict();
export type ImplementationBody = z.infer<typeof ImplementationBody>;

export const VerificationBody = z.object({ result: z.enum(['effective', 'not_effective']), method: required(3, 1000, 'The method'), note: required(3, 2000, 'What was found') }).strict();
export type VerificationBody = z.infer<typeof VerificationBody>;

/** Asks for more time. The due date moves only when someone else with approval rights approves. */
export const ExtendBody = z.object({ newDueOn: DateOnly, reason: required(3, 1000, 'A reason') }).strict();
export type ExtendBody = z.infer<typeof ExtendBody>;
export const DecideExtensionBody = z.object({ approve: z.boolean(), note: required(3, 1000, 'A reason for the decision') }).strict();
export type DecideExtensionBody = z.infer<typeof DecideExtensionBody>;

export const ScarReasonBody = z.object({ reason: required(3, 1000, 'A reason') }).strict();
export type ScarReasonBody = z.infer<typeof ScarReasonBody>;

export const LinkNcrBody = z.object({ ncrId: z.string().uuid() }).strict();
export type LinkNcrBody = z.infer<typeof LinkNcrBody>;

// ---- output --------------------------------------------------------------------------------------

const Status = z.enum(SCAR_STATUSES);
const Severity = z.enum(SCAR_SEVERITIES);

export const ScarRow = z.object({
  id: z.string().uuid(),
  reference: z.string(),
  title: z.string(),
  supplier: z.object({ id: z.string().uuid(), code: z.string(), name: z.string() }),
  severity: Severity,
  status: Status,
  owner: Person,
  responseDueOn: DateOnly.nullable(),
  /** The supplier's response is awaited and its due date has passed (worked out when read). */
  overdue: z.boolean(),
  daysOverdue: z.number().int(),
  ncrCount: z.number().int(),
  responseCount: z.number().int(),
  issuedAt: Iso.nullable(),
  closedAt: Iso.nullable(),
  createdAt: Iso,
});
export type ScarRow = z.infer<typeof ScarRow>;
export const ScarPage = z.object({ data: z.array(ScarRow), page: z.number().int(), pageSize: z.number().int(), total: z.number().int() });

const Review = z.object({ id: z.string().uuid(), decision: z.enum(['accepted', 'revision_requested']), note: z.string(), reviewedAt: Iso, reviewedBy: Person });
const ResponseItem = z.object({
  id: z.string().uuid(),
  seq: z.number().int(),
  rootCause: z.string(),
  containment: z.string().nullable(),
  correctiveAction: z.string(),
  preventiveAction: z.string().nullable(),
  plannedCompletionOn: DateOnly.nullable(),
  respondedOn: DateOnly,
  respondedByName: z.string().nullable(),
  extentOfCondition: z.string().nullable(),
  escapePoint: z.string().nullable(),
  responsibleName: z.string().nullable(),
  rootCauseMethod: z.enum(ROOT_CAUSE_METHODS).nullable(),
  contact: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
  receivedAt: Iso,
  receivedBy: Person,
  review: Review.nullable(),
});
const Implementation = z.object({ id: z.string().uuid(), description: z.string(), implementedOn: DateOnly, evidenceNote: z.string().nullable(), recordedAt: Iso, recordedBy: Person });
const Verification = z.object({ id: z.string().uuid(), result: z.enum(['effective', 'not_effective']), method: z.string(), note: z.string(), verifiedAt: Iso, verifiedBy: Person });
const Extension = z.object({
  id: z.string().uuid(),
  previousDueOn: DateOnly,
  newDueOn: DateOnly,
  reason: z.string(),
  /** Requested by (the person who recorded the supplier's request) and when. */
  extendedAt: Iso,
  extendedBy: Person,
  status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']),
  decidedAt: Iso.nullable(),
  decidedBy: Person,
  decisionNote: z.string().nullable(),
  /** The caller may approve or reject it: it waits, they hold supplier_quality.approve and did not ask for it. */
  canDecide: z.boolean(),
});
const Item = z.object({
  id: z.string().uuid(),
  part: z.object({ id: z.string().uuid(), partNumber: z.string(), name: z.string() }).nullable(),
  material: z.string().nullable(),
  lot: z.object({ id: z.string().uuid(), lotNumber: z.string() }).nullable(),
  receiptReference: z.string().nullable(),
  quantity: z.number().nullable(),
  notes: z.string().nullable(),
  addedAt: Iso,
  endedAt: Iso.nullable(),
  endReason: z.string().nullable(),
});
const NcrLink = z.object({
  linkId: z.string().uuid(),
  ncr: z.object({ id: z.string().uuid(), reference: z.string(), title: z.string(), stage: z.string(), severity: z.string().nullable() }),
  linkedAt: Iso,
  endedAt: Iso.nullable(),
  endReason: z.string().nullable(),
});
const HistoryItem = z.object({ id: z.string().uuid(), fromStatus: Status.nullable(), toStatus: Status, reason: z.string().nullable(), changedAt: Iso, changedBy: Person });

export const ScarDetail = ScarRow.extend({
  problemDescription: z.string().nullable(),
  requirementBreached: z.string().nullable(),
  objectiveEvidence: z.string().nullable(),
  containmentRequirements: z.string().nullable(),
  items: z.array(Item),
  originalResponseDueOn: DateOnly.nullable(),
  contact: z.object({ id: z.string().uuid(), name: z.string(), email: z.string().nullable() }).nullable(),
  capa: z.object({ id: z.string().uuid(), reference: z.string(), title: z.string().nullable() }).nullable(),
  issuedBy: Person,
  acknowledgedAt: Iso.nullable(),
  acknowledgedBy: Person,
  acknowledgedNote: z.string().nullable(),
  closedBy: Person,
  cancelledAt: Iso.nullable(),
  cancelledBy: Person,
  cancelReason: z.string().nullable(),
  createdBy: Person,
  ncrs: z.array(NcrLink),
  responses: z.array(ResponseItem),
  implementations: z.array(Implementation),
  verifications: z.array(Verification),
  extensions: z.array(Extension),
  history: z.array(HistoryItem),
});
export type ScarDetail = z.infer<typeof ScarDetail>;

export const ScarPeople = z.object({ data: z.array(z.object({ userId: z.string().uuid(), name: z.string() })) });
export const ScarPeopleQuery = z.object({ q: z.string().trim().min(1).max(100).optional() });
export type ScarPeopleQuery = z.infer<typeof ScarPeopleQuery>;
