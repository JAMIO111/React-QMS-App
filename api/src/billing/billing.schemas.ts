import { z } from 'zod';

export const AccessLevel = z.enum(['none', 'view', 'operational', 'full']);
export type AccessLevel = z.infer<typeof AccessLevel>;

export const PlanSlug = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);

export const SetSeatsBody = z.object({ planSlug: PlanSlug, quantity: z.number().int().min(0).max(10000) }).strict();
export type SetSeatsBody = z.infer<typeof SetSeatsBody>;

export const AssignPackageBody = z.object({ planSlug: PlanSlug }).strict();
export type AssignPackageBody = z.infer<typeof AssignPackageBody>;

export const EntitlementQuery = z.object({
  module: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  feature: z.string().regex(/^[a-z][a-z0-9_]{1,59}$/).optional(),
});

const Price = z.object({ unitAmount: z.number().int(), currency: z.string() });

export const PlanWithPrices = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  monthly: Price.nullable(),
  annual: Price.nullable(),
  /** Pence per user per month when billed annually (rounded). */
  annualMonthlyEquivalent: z.number().int().nullable(),
  /** Pence saved per user per year by billing annually. */
  annualSaving: z.number().int().nullable(),
  levels: z.record(AccessLevel),
});

export const PlanCatalogue = z.object({
  plans: z.array(PlanWithPrices),
  modules: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      status: z.string(),
      features: z.array(z.object({ slug: z.string(), name: z.string(), minLevel: AccessLevel, includedIn: z.array(z.string()) })),
    }),
  ),
});
export type PlanCatalogue = z.infer<typeof PlanCatalogue>;

export const SubscriptionOverview = z.object({
  subscription: z
    .object({
      status: z.string(),
      billingInterval: z.enum(['month', 'year']),
      currency: z.string(),
      billingProvider: z.string(),
      currentPeriodStart: z.string(),
      currentPeriodEnd: z.string().nullable(),
      cancelAtPeriodEnd: z.boolean(),
      pastDueSince: z.string().nullable(),
      entitlementsEnforced: z.boolean(),
      gracePeriodDays: z.number().int(),
    })
    .nullable(),
  items: z.array(
    z.object({
      planSlug: z.string(),
      planName: z.string(),
      purchased: z.number().int(),
      assigned: z.number().int(),
      available: z.number().int(),
      unitAmount: z.number().int(),
    }),
  ),
  totals: z.object({
    seatsPurchased: z.number().int(),
    seatsAssigned: z.number().int(),
    seatsAvailable: z.number().int(),
    /** Pence, excluding VAT. */
    monthlyEquivalent: z.number().int(),
    annual: z.number().int(),
    vatRate: z.number(),
  }),
});
export type SubscriptionOverview = z.infer<typeof SubscriptionOverview>;

export const SeatMember = z.object({
  membershipId: z.string().uuid(),
  email: z.string().nullable(),
  firstName: z.string().nullable(),
  surname: z.string().nullable(),
  status: z.string(),
  roles: z.array(z.string()),
  plan: z.object({ slug: z.string(), name: z.string() }).nullable(),
  assignedAt: z.string().nullable(),
  unitAmount: z.number().int().nullable(),
});
export type SeatMember = z.infer<typeof SeatMember>;

export const EntitlementCheck = z.object({
  allowed: z.boolean(),
  reason: z.string(),
  currentPlan: z.string().nullable(),
  requiredPlan: z.string().nullable(),
});

export const SubscriptionAccess = z.object({
  enforced: z.boolean(),
  reason: z.string().nullable(),
  plan: z.object({ slug: z.string(), name: z.string() }).nullable(),
  modules: z.record(AccessLevel),
});
export type SubscriptionAccess = z.infer<typeof SubscriptionAccess>;

export const Invoice = z.object({
  id: z.string().uuid(),
  invoiceNumber: z.string().nullable(),
  invoiceDate: z.string().nullable(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  currency: z.string(),
  subtotal: z.number().int(),
  taxAmount: z.number().int(),
  totalAmount: z.number().int(),
  status: z.string(),
  paidAt: z.string().nullable(),
  invoicePdfUrl: z.string().nullable(),
});
export type Invoice = z.infer<typeof Invoice>;

export const SubscriptionEvent = z.object({
  id: z.string().uuid(),
  eventType: z.string(),
  actorUserId: z.string().uuid().nullable(),
  membershipId: z.string().uuid().nullable(),
  details: z.record(z.unknown()),
  createdAt: z.string(),
});
export type SubscriptionEvent = z.infer<typeof SubscriptionEvent>;
