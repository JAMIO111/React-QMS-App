import { z } from 'zod';

const Iso = z.string().datetime({ offset: true });
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-30');
const text = (max: number) => z.string().trim().min(1).max(max);

export const CATEGORIES = ['product', 'process', 'supplier', 'equipment', 'safety'] as const;
export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export const STATUSES = ['draft', 'active', 'expired', 'withdrawn', 'superseded'] as const;
export const Category = z.enum(CATEGORIES);
export const Severity = z.enum(SEVERITIES);
export const Status = z.enum(STATUSES);

/** Revision 1 is A, 2 is B … (27 is AA). */
export const revisionLetter = (n: number): string => {
  let out = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) out = String.fromCharCode(65 + ((x - 1) % 26)) + out;
  return out;
};

// ---- input ---------------------------------------------------------------------------------------

const PartScope = z
  .object({ partId: z.string().uuid().optional(), partFamilyId: z.string().uuid().optional() })
  .strict()
  .refine((p) => (p.partId === undefined) !== (p.partFamilyId === undefined), { message: 'Name a part or a part family' });
const Target = z
  .object({ departmentId: z.string().uuid().optional(), roleId: z.string().uuid().optional(), membershipId: z.string().uuid().optional() })
  .strict()
  .refine((t) => [t.departmentId, t.roleId, t.membershipId].filter((x) => x !== undefined).length === 1, { message: 'Name one department, role or person' });

const Link = z
  .object({ nonconformanceId: z.string().uuid().optional(), supplierId: z.string().uuid().optional(), gaugeId: z.string().uuid().optional(), calibrationId: z.string().uuid().optional() })
  .strict()
  .refine((l) => Object.values(l).filter((x) => x !== undefined).length === 1, { message: 'Name one nonconformance, supplier, gauge or calibration' });

export const ScopeInput = z
  .object({
    links: z.array(Link).max(50),
    parts: z.array(PartScope).max(100),
    machines: z.array(z.string().uuid()).max(100),
    operations: z.array(text(40)).max(50),
    departments: z.array(z.string().uuid()).max(50),
    targets: z.array(Target).max(100),
  })
  .partial()
  .strict();
export type ScopeInput = z.infer<typeof ScopeInput>;

/** One thing people must do, optionally for a department and/or a machine. The list replaces the draft's actions as a whole, in the order given. */
export const ActionInput = z
  .object({ description: text(2000), departmentId: z.string().uuid().nullable().optional(), machineId: z.string().uuid().nullable().optional() })
  .strict();
export type ActionInput = z.infer<typeof ActionInput>;
const ActionsInput = z.array(ActionInput).max(50);

const Content = {
  title: text(200),
  category: Category,
  severity: Severity,
  description: z.string().trim().max(10000).nullable().optional(),
  effectiveDate: DateOnly.nullable().optional(),
  expiryDate: DateOnly.nullable().optional(),
  acknowledgeBy: DateOnly.nullable().optional(),
};

/** A new draft: only the title, category and severity are needed to start. */
export const CreateAlertBody = z.object({ ...Content, actions: ActionsInput.optional(), scope: ScopeInput.optional() }).strict();
export type CreateAlertBody = z.infer<typeof CreateAlertBody>;

export const UpdateAlertBody = z
  .object({ ...Content, revisionReason: z.string().trim().max(2000).nullable().optional(), actions: ActionsInput.optional(), scope: ScopeInput.optional() })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });
export type UpdateAlertBody = z.infer<typeof UpdateAlertBody>;

/** Reopening an expired alert: the new expiry date and why. */
export const ReopenBody = z.object({ expiryDate: DateOnly, reason: z.string().trim().min(1, 'Give a reason').max(2000) }).strict();
export type ReopenBody = z.infer<typeof ReopenBody>;

export const ReasonBody = z.object({ reason: z.string().trim().min(1, 'Give a reason').max(2000) }).strict();
export type ReasonBody = z.infer<typeof ReasonBody>;

export const ListQuery = z.object({
  /** Latest revisions only unless 'all'; status narrows by lifecycle. */
  status: z.enum([...STATUSES, 'all']).optional(),
  /** Active alerts past their acknowledge-by date with people who have not acknowledged (documentation.manage). */
  overdue: z.enum(['true', 'false']).optional(),
  category: Category.optional(),
  severity: Severity.optional(),
  q: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type ListQuery = z.infer<typeof ListQuery>;

// ---- output --------------------------------------------------------------------------------------

const Person = z.object({ id: z.string().uuid(), name: z.string() }).nullable();

export const AlertSummary = z.object({
  id: z.string().uuid(),
  number: z.number().int(),
  reference: z.string(),
  revision: z.number().int(),
  revisionLetter: z.string(),
  title: z.string(),
  category: Category,
  severity: Severity,
  status: Status,
  /** Issued, past its effective date and not expired, withdrawn or superseded. */
  inForce: z.boolean(),
  effectiveDate: DateOnly.nullable(),
  expiryDate: DateOnly.nullable(),
  acknowledgeBy: DateOnly.nullable(),
  issuedAt: Iso.nullable(),
  issuedBy: Person,
  createdBy: Person,
  updatedAt: Iso,
  /** Acknowledgement progress, for people who manage documentation (null for others). */
  progress: z.object({ total: z.number().int(), viewed: z.number().int(), acknowledged: z.number().int(), overdue: z.number().int() }).nullable(),
});
export type AlertSummary = z.infer<typeof AlertSummary>;

export const AlertDetail = AlertSummary.extend({
  description: z.string().nullable(),
  /** What people must do, in order; each may be for a department and/or a machine (labels are null when the caller cannot see the record). */
  actions: z.array(
    z.object({
      id: z.string().uuid(),
      position: z.number().int(),
      description: z.string(),
      departmentId: z.string().uuid().nullable(),
      machineId: z.string().uuid().nullable(),
      departmentLabel: z.string().nullable(),
      machineLabel: z.string().nullable(),
    }),
  ),
  /** Expiries and reopenings, oldest first (an expiry made by the system has no person). */
  history: z.array(z.object({ id: z.string().uuid(), kind: z.enum(['expired', 'reopened']), at: Iso, by: Person, previousExpiry: DateOnly.nullable(), newExpiry: DateOnly.nullable(), reason: z.string().nullable() })),
  revisionReason: z.string().nullable(),
  supersedesId: z.string().uuid().nullable(),
  withdrawn: z.object({ at: Iso, by: Person, reason: z.string() }).nullable(),
  scope: z.object({
    parts: z.array(z.object({ id: z.string().uuid(), kind: z.enum(['part', 'family']), partId: z.string().uuid().nullable(), partFamilyId: z.string().uuid().nullable(), label: z.string() })),
    machines: z.array(z.object({ id: z.string().uuid(), machineId: z.string().uuid(), label: z.string() })),
    operations: z.array(z.string()),
    departments: z.array(z.object({ id: z.string().uuid(), departmentId: z.string().uuid(), label: z.string() })),
    targets: z.array(
      z.object({
        id: z.string().uuid(),
        kind: z.enum(['department', 'role', 'person']),
        departmentId: z.string().uuid().nullable(),
        roleId: z.string().uuid().nullable(),
        membershipId: z.string().uuid().nullable(),
        label: z.string(),
      }),
    ),
  }),
  /** Records this alert refers to. `label` is null when the caller cannot read the record; `source` (of a nonconformance) and `gaugeId` (of a calibration) are for building the link. */
  links: z.array(z.object({ id: z.string().uuid(), kind: z.enum(['nonconformance', 'supplier', 'gauge', 'calibration']), recordId: z.string().uuid(), label: z.string().nullable(), source: z.string().nullable(), gaugeId: z.string().uuid().nullable() })),
  /** The caller's own place in it, when it is addressed to them. */
  me: z.object({ firstViewedAt: Iso.nullable(), acknowledgedAt: Iso.nullable(), note: z.string().nullable(), reachedVia: z.array(z.string()), overdue: z.boolean() }).nullable(),
  /** Every revision of this alert number, newest first. */
  revisions: z.array(z.object({ id: z.string().uuid(), revision: z.number().int(), revisionLetter: z.string(), status: Status, issuedAt: Iso.nullable(), revisionReason: z.string().nullable() })),
});
export type AlertDetail = z.infer<typeof AlertDetail>;

export const AlertList = z.object({ data: z.array(AlertSummary) });

export const AcknowledgeBody = z.object({ note: z.string().trim().max(2000).optional() }).strict();
export type AcknowledgeBody = z.infer<typeof AcknowledgeBody>;
export const AddRecipientBody = z.object({ membershipId: z.string().uuid() }).strict();
export type AddRecipientBody = z.infer<typeof AddRecipientBody>;

export const RecipientsPreview = z.object({
  total: z.number().int(),
  targets: z.array(z.object({ id: z.string().uuid(), kind: z.enum(['department', 'role', 'person']), label: z.string(), count: z.number().int() })),
});

export const Recipient = z.object({
  id: z.string().uuid(),
  membershipId: z.string().uuid(),
  name: z.string(),
  reachedVia: z.array(z.string()),
  firstViewedAt: Iso.nullable(),
  acknowledgedAt: Iso.nullable(),
  note: z.string().nullable(),
  /** Past the acknowledge-by date without acknowledging. */
  overdue: z.boolean(),
});
export const RecipientList = z.object({
  data: z.array(Recipient),
  totals: z.object({ total: z.number().int(), viewed: z.number().int(), acknowledged: z.number().int(), overdue: z.number().int() }),
});

export const MineItem = AlertSummary.extend({
  me: z.object({ firstViewedAt: Iso.nullable(), acknowledgedAt: Iso.nullable(), note: z.string().nullable(), reachedVia: z.array(z.string()), overdue: z.boolean() }),
  /** open: asked and not yet acknowledged; acknowledged; closed: no longer in force. */
  state: z.enum(['open', 'acknowledged', 'closed']),
});
export const MineList = z.object({ data: z.array(MineItem), unacknowledged: z.number().int(), overdue: z.number().int() });
export const MineCount = z.object({ unacknowledged: z.number().int(), overdue: z.number().int() });

// ---- where work happens (DOC3) -------------------------------------------------------------------

/** What is being worked on; at least one is needed. A part family is found from the part, or given for a family page. */
export const ActiveQuery = z
  .object({
    partId: z.string().uuid().optional(),
    partFamilyId: z.string().uuid().optional(),
    machineId: z.string().uuid().optional(),
    operationCode: z.string().trim().min(1).max(40).optional(),
  })
  .refine((q) => Object.values(q).some((x) => x !== undefined), { message: 'Say which part, family, machine or operation' });
export type ActiveQuery = z.infer<typeof ActiveQuery>;

export const ActiveAlert = z.object({
  id: z.string().uuid(),
  reference: z.string(),
  revisionLetter: z.string(),
  title: z.string(),
  category: Category,
  severity: Severity,
  actions: z.array(z.object({ description: z.string(), department: z.string().nullable(), machine: z.string().nullable() })),
  effectiveDate: DateOnly,
  acknowledgeBy: DateOnly.nullable(),
  /** What matched: the part, its family, the machine or the operation. */
  matched: z.array(z.enum(['part', 'family', 'machine', 'operation'])),
  /** True/false when the alert is addressed to the caller, null when it is not. */
  acknowledged: z.boolean().nullable(),
});
export const ActiveList = z.object({ data: z.array(ActiveAlert) });
