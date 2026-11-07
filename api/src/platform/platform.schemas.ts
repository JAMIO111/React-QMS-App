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

export const OrganisationsQuery = z.object({
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type OrganisationsQuery = z.infer<typeof OrganisationsQuery>;

export const LimitQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
export type LimitQuery = z.infer<typeof LimitQuery>;

export const HoursQuery = z.object({ hours: z.coerce.number().int().min(1).max(720).default(24) });
export type HoursQuery = z.infer<typeof HoursQuery>;

export const PlatformOrganisation = z.object({
  organisationId: z.string().uuid(),
  name: z.string(),
  /** active | suspended | archived */
  status: z.string(),
  createdAt: Iso,
  country: z.string().nullable(),
  billingRequired: z.boolean(),
  setupFinishedAt: Iso.nullable(),
  ownerEmails: z.array(z.string()),
  members: z.number().int(),
  subscriptionStatus: z.string().nullable(),
  billingProvider: z.string().nullable(),
  billingInterval: z.string().nullable(),
  trialEnd: Iso.nullable(),
  currentPeriodEnd: Iso.nullable(),
  cancelAtPeriodEnd: z.boolean().nullable(),
  pastDueSince: Iso.nullable(),
  seatsPurchased: z.number().int(),
  seatsAssigned: z.number().int(),
  /** Monthly equivalent in pence, excluding VAT. */
  mrrPence: z.number().int(),
  lastSyncedAt: Iso.nullable(),
});
export const PlatformOrganisations = z.object({ data: z.array(PlatformOrganisation), total: z.number().int() });
export type PlatformOrganisations = z.infer<typeof PlatformOrganisations>;

/** Shapes below are passed through from the database functions as they are (they are already the public contract). */
export const PlatformRevenue = z.record(z.unknown());
export const PlatformPayments = z.record(z.unknown());
export const PlatformWebhooks = z.record(z.unknown());
export const PlatformActivity = z.object({
  data: z.array(z.object({ at: Iso, kind: z.string(), event: z.string(), organisationId: z.string().uuid(), organisation: z.string(), details: z.record(z.unknown()) })),
});
export type PlatformActivity = z.infer<typeof PlatformActivity>;
