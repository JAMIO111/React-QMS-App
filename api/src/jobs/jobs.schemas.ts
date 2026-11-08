import { z } from 'zod';

const Iso = z.string().datetime({ offset: true });
const code = z.string().trim().min(1).max(30);
const lotSize = z.number().int().min(1).max(100_000_000);
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

/** What the operator chooses to start a job. */
export const JobQuery = z
  .object({ machineId: z.string().uuid().optional(), partId: z.string().uuid(), operationCode: code.optional() })
  .strict();
export type JobQuery = z.infer<typeof JobQuery>;

/** `productionOrderId` links the job to its production order as it starts (optional; an organisation may require one before the job is completed). */
export const StartJobBody = z.object({ machineId: z.string().uuid(), partId: z.string().uuid(), operationCode: code.optional(), lotSize: lotSize.optional(), productionOrderId: z.string().uuid().optional() }).strict();
export type StartJobBody = z.infer<typeof StartJobBody>;

/** Filled in (or corrected) while the job runs. A missing field is kept; an empty text clears it. */
export const JobDetailsBody = z
  .object({ workOrder: text(60), lot: text(60), lotSize: lotSize.optional(), serial: text(60) })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });
export type JobDetailsBody = z.infer<typeof JobDetailsBody>;

/** Link a running job to its production order, lot and serial number. A field left out is kept; `null` clears it. Picking a serial number fills its lot and order, a lot its order. */
export const JobLinksBody = z
  .object({ productionOrderId: z.string().uuid().nullable().optional(), lotId: z.string().uuid().nullable().optional(), serialId: z.string().uuid().nullable().optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one link' });
export type JobLinksBody = z.infer<typeof JobLinksBody>;

/** What starting a job with this machine and part would do: the site and operation that would be used, and whether anything blocks it. */
export const JobPreview = z.object({
  /** Null while only the part is known (the control plan can be resolved before a machine is chosen). */
  machine: z.object({ id: z.string().uuid(), code: z.string(), name: z.string() }).nullable(),
  part: z.object({ id: z.string().uuid(), partNumber: z.string(), name: z.string() }),
  /** The machine's site (else the organisation's only site). */
  site: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
  siteProblem: z.string().nullable(),
  status: z.enum(['ok', 'blocked']),
  problems: z.array(z.object({ code: z.string(), message: z.string() })),
  /** The plan's operations; the operator is asked to choose only when there is more than one. */
  operations: z.array(z.object({ code: z.string(), name: z.string() })),
  needsOperation: z.boolean(),
  operationCode: z.string().nullable(),
  /** A check is sampled every N parts, so the quantity is needed at the start. */
  needsLotSize: z.boolean(),
  partRevision: z.string().nullable(),
  plan: z.object({ planCode: z.string(), revisionCode: z.string() }).nullable(),
  requirementCount: z.number().int(),
});
export type JobPreview = z.infer<typeof JobPreview>;

export const RecentQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(90) });
export type RecentQuery = z.infer<typeof RecentQuery>;

/** Non-conformances relevant to the job: same part, same part family, or raised from an inspection on the same machine or operation. */
export const JobNcr = z.object({
  id: z.string().uuid(),
  reference: z.string(),
  stage: z.string(),
  /** internal | customer | supplier (for the link to the NC page). */
  source: z.string(),
  severity: z.enum(['critical', 'major', 'minor']).nullable(),
  title: z.string(),
  detectedAt: z.string(),
  quantityAffected: z.number().nullable(),
  part: z.object({ id: z.string().uuid(), partNumber: z.string() }).nullable(),
  /** Why it is shown. */
  matched: z.array(z.enum(['part', 'family', 'machine', 'operation'])),
  /** Still being worked on (not closed or cancelled). */
  open: z.boolean(),
  /** The failing characteristic(s) it was raised for, where it came from an inspection. */
  characteristics: z.array(z.string()),
});
export const JobNcrs = z.object({ canRead: z.boolean(), days: z.number().int(), data: z.array(JobNcr) });
export type JobNcrs = z.infer<typeof JobNcrs>;

export const JobRevision = z.object({
  kind: z.enum(['part_revision', 'plan_revision']),
  id: z.string().uuid(),
  /** "Rev B" of a part, or of a control plan. */
  revision: z.string(),
  /** 2 or more for a part revision that has been corrected (Rev B v2); 1 otherwise. */
  version: z.number().int(),
  subject: z.string(),
  changeSummary: z.string().nullable(),
  at: Iso,
  by: z.string().nullable(),
  /** Released or effective after the operator's previous job on this part (or in the last 7 days when there is none). */
  isNew: z.boolean(),
  /** The one in force now. */
  current: z.boolean(),
  /** This job is running on it. */
  runningOnIt: z.boolean(),
});
export const JobRevisions = z.object({
  days: z.number().int(),
  /** A newer part revision has been released since this job started. */
  partRevisionSuperseded: z.boolean(),
  /** A newer control plan revision has become effective since this job started. */
  planRevisionSuperseded: z.boolean(),
  data: z.array(JobRevision),
});
export type JobRevisions = z.infer<typeof JobRevisions>;
