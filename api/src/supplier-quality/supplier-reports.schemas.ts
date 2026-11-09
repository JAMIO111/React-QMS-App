import { z } from 'zod';

const Iso = z.string().datetime({ offset: true });
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-30');

export const ReportQuery = z.object({ from: DateOnly.optional(), to: DateOnly.optional() }).refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'The period must start on or before it ends' });
export type ReportQuery = z.infer<typeof ReportQuery>;

/** Everything a person needs to read an exported report later: what it is, the period, the rules used, when it was worked out and how many rows. */
export const ReportMeta = z.object({
  title: z.string(),
  from: DateOnly,
  to: DateOnly,
  generatedAt: Iso,
  /** Plain statements of what each column means and how it was worked out. */
  definitions: z.array(z.string()),
  /** What the figures were worked out with (the scoring model, for the performance report). */
  basis: z.array(z.object({ label: z.string(), value: z.string() })),
  rowCount: z.number().int(),
});
export const Report = z.object({ meta: ReportMeta, columns: z.array(z.object({ key: z.string(), label: z.string() })), rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))) });
export type Report = z.infer<typeof Report>;
