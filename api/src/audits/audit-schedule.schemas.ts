import { z } from 'zod';
import { AUDIT_TYPES } from './audits.schemas';

const Id = z.string().uuid();
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const SCHEDULE_STATES = ['upcoming', 'overdue', 'missed', 'skipped'] as const;

const csv = <T extends z.ZodTypeAny>(item: T) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : []))
    .pipe(z.array(item).max(10));

/** The schedule for a window (default 30 days back to 30 days ahead), optionally for one audit, machine, operation or department. */
export const ScheduleQuery = z
  .object({
    from: DateOnly.optional(),
    to: DateOnly.optional(),
    state: csv(z.enum(SCHEDULE_STATES)),
    auditId: Id.optional(),
    machineId: Id.optional(),
    operationCode: z.string().trim().max(40).optional(),
    departmentId: Id.optional(),
  })
  .strict()
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'The start of the window is after its end' })
  .refine((q) => !q.from || !q.to || (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 400, { message: 'Ask for at most about a year at a time' });
export type ScheduleQuery = z.infer<typeof ScheduleQuery>;

export const ScheduleItem = z.object({
  id: Id,
  dueOn: DateOnly,
  state: z.enum(SCHEDULE_STATES),
  /** Whole days from today: negative once past due. */
  daysFromToday: z.number(),
  graceDays: z.number(),
  skippedReason: z.string().nullable(),
  audit: z.object({
    id: Id,
    reference: z.string(),
    title: z.string(),
    auditType: z.enum(AUDIT_TYPES),
    passMark: z.number(),
    auditor: z.object({ kind: z.enum(['none', 'person', 'role', 'department']), name: z.string().nullable() }),
    relevantTo: z.array(z.string()),
  }),
});
export type ScheduleItem = z.infer<typeof ScheduleItem>;

export const Schedule = z.object({
  today: DateOnly,
  window: z.object({ from: DateOnly, to: DateOnly }),
  counts: z.object({
    total: z.number(),
    upcoming: z.number(),
    dueNext7Days: z.number(),
    overdue: z.number(),
    missed: z.number(),
    skipped: z.number(),
  }),
  data: z.array(ScheduleItem),
  /** More slots than are shown (the list is cut at 500); narrow the window or the filters. */
  truncated: z.boolean(),
});
export type Schedule = z.infer<typeof Schedule>;
