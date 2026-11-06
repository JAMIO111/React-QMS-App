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

export const ScopeInput = z
  .object({
    parts: z.array(PartScope).max(100),
    machines: z.array(z.string().uuid()).max(100),
    operations: z.array(text(40)).max(50),
    departments: z.array(z.string().uuid()).max(50),
    targets: z.array(Target).max(100),
  })
  .partial()
  .strict();
export type ScopeInput = z.infer<typeof ScopeInput>;

const Content = {
  title: text(200),
  category: Category,
  severity: Severity,
  description: z.string().trim().max(10000).nullable().optional(),
  requiredAction: z.string().trim().max(5000).nullable().optional(),
  effectiveDate: DateOnly.nullable().optional(),
  expiryDate: DateOnly.nullable().optional(),
  acknowledgeBy: DateOnly.nullable().optional(),
};

/** A new draft: only the title, category and severity are needed to start. */
export const CreateAlertBody = z.object({ ...Content, scope: ScopeInput.optional() }).strict();
export type CreateAlertBody = z.infer<typeof CreateAlertBody>;

export const UpdateAlertBody = z
  .object({ ...Content, revisionReason: z.string().trim().max(2000).nullable().optional(), scope: ScopeInput.optional() })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });
export type UpdateAlertBody = z.infer<typeof UpdateAlertBody>;

export const ReasonBody = z.object({ reason: z.string().trim().min(1, 'Give a reason').max(2000) }).strict();
export type ReasonBody = z.infer<typeof ReasonBody>;

export const ListQuery = z.object({
  /** Latest revisions only unless 'all'; status narrows by lifecycle. */
  status: z.enum([...STATUSES, 'all']).optional(),
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
});
export type AlertSummary = z.infer<typeof AlertSummary>;

export const AlertDetail = AlertSummary.extend({
  description: z.string().nullable(),
  requiredAction: z.string().nullable(),
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
  /** Every revision of this alert number, newest first. */
  revisions: z.array(z.object({ id: z.string().uuid(), revision: z.number().int(), revisionLetter: z.string(), status: Status, issuedAt: Iso.nullable(), revisionReason: z.string().nullable() })),
});
export type AlertDetail = z.infer<typeof AlertDetail>;

export const AlertList = z.object({ data: z.array(AlertSummary) });
