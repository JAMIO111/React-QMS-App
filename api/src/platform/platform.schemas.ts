import { z } from 'zod';

const Iso = z.string();

export const PlatformMe = z.object({
  /** none: not an operator; needs_mfa: on the allow-list but this session has not passed MFA; ok: may use the platform area. */
  status: z.enum(['none', 'needs_mfa', 'ok']),
});

export const OverviewQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });
export type OverviewQuery = z.infer<typeof OverviewQuery>;

export const Funnel = z.object({
  days: z.number().int(),
  since: Iso,
  /** People who signed themselves up in the period, how many of them verified their email, and how many went on to start an organisation. */
  signedUp: z.number().int(),
  verified: z.number().int(),
  orgStarted: z.number().int(),
  totalAccounts: z.number().int(),
  totalOrganisations: z.number().int(),
});

export const RecentSignup = z.object({
  userId: z.string().uuid(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  signedUpAt: Iso,
  verifiedAt: Iso.nullable(),
  orgStartedAt: Iso.nullable(),
  organisationName: z.string().nullable(),
});

export const Overview = z.object({ funnel: Funnel, recentSignups: z.array(RecentSignup) });
export type Overview = z.infer<typeof Overview>;
