import { z } from 'zod';

export const CreateReportKeyBody = z.object({
  name: z.string().trim().min(1).max(80),
  /** How many days the key lasts (1 to 730). */
  days: z.number().int().min(1).max(730).default(365),
}).strict();
export type CreateReportKeyBody = z.infer<typeof CreateReportKeyBody>;

export const RevokeReportKeyBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
export type RevokeReportKeyBody = z.infer<typeof RevokeReportKeyBody>;

export const ISO_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

export const DatasetQuery = z.object({
  limit: z.coerce.number().int().min(1).max(5000).default(2000),
  /** The `nextCursor` of the previous page. */
  after: z.string().max(300).optional(),
  /** Only rows changed at or after this time (ISO 8601 UTC, e.g. 2026-11-01T00:00:00Z). */
  updatedSince: z.string().regex(ISO_MICROS, 'Use an ISO 8601 UTC time such as 2026-11-01T00:00:00Z').optional(),
}).strict();
export type DatasetQuery = z.infer<typeof DatasetQuery>;

export const ReportKey = z.object({
  id: z.string().uuid(),
  name: z.string(),
  keyPrefix: z.string(),
  status: z.enum(['active', 'expired', 'revoked']),
  expiresAt: z.string(),
  lastUsedAt: z.string().nullable(),
  lastUsedAddress: z.string().nullable(),
  revokedAt: z.string().nullable(),
  revokedReason: z.string().nullable(),
  createdAt: z.string(),
  /** True for a key that stands for the caller. */
  mine: z.boolean(),
});
export type ReportKey = z.infer<typeof ReportKey>;

export const CreatedReportKey = z.object({
  /** The key itself. Shown once; Fortress keeps only a hash of it. */
  secret: z.string(),
  key: ReportKey,
});

export const DatasetInfo = z.object({
  key: z.string(),
  title: z.string(),
  description: z.string(),
  path: z.string(),
  columns: z.array(z.object({ name: z.string(), type: z.string(), description: z.string() })),
});
