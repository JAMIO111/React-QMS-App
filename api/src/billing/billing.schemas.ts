import { z } from 'zod';

export const AccessLevel = z.enum(['none', 'view', 'operational', 'full']);
export type AccessLevel = z.infer<typeof AccessLevel>;

export const PlanSlug = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);

export const SetSeatsBody = z.object({ planSlug: PlanSlug, quantity: z.number().int().min(0).max(10000) }).strict();
export type SetSeatsBody = z.infer<typeof SetSeatsBody>;

const SeatQuantity = z.number().int().min(0).max(10000);

/** Seats per package, by package slug. */
export const SeatCounts = z.record(PlanSlug, SeatQuantity).refine((v) => Object.keys(v).length > 0, 'Choose at least one package');
export type SeatCounts = z.infer<typeof SeatCounts>;

export const CheckoutBody = z
  .object({
    interval: z.enum(['month', 'year']),
    seats: SeatCounts.refine((v) => (v.controller ?? 0) >= 1, 'At least one Controller seat is needed: an owner must hold one'),
    returnTo: z.enum(['setup', 'settings']).default('setup'),
  })
  .strict();
export type CheckoutBody = z.infer<typeof CheckoutBody>;

/** The company an invoice is for (docs/invoice-billing-plan.md §4.2): a legal name, a billing address and an address to send it to; VAT number and PO reference are optional. */
export const InvoiceCompany = z
  .object({
    legalName: z.string().trim().min(2).max(200),
    billingEmail: z.string().trim().email().max(254),
    addressLine1: z.string().trim().min(2).max(120),
    addressLine2: z.string().trim().max(120).optional(),
    city: z.string().trim().min(2).max(80),
    region: z.string().trim().max(80).optional(),
    postcode: z.string().trim().min(2).max(20),
    country: z.string().regex(/^[A-Z]{2}$/, 'Use the two-letter country code, in capitals'),
    vatNumber: z.string().trim().max(30).optional(),
    poReference: z.string().trim().max(100).optional(),
  })
  .strict();
export type InvoiceCompany = z.infer<typeof InvoiceCompany>;

export const InvoiceSubscriptionBody = z
  .object({
    interval: z.enum(['month', 'year']),
    seats: SeatCounts.refine((v) => (v.controller ?? 0) >= 1, 'At least one Controller seat is needed: an owner must hold one'),
    company: InvoiceCompany,
    /** Made once by the browser per attempt: a retry with the same key is the same subscription. */
    clientKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
  })
  .strict();
export type InvoiceSubscriptionBody = z.infer<typeof InvoiceSubscriptionBody>;

export const InvoiceCompanyCheckBody = z.object({ legalName: z.string().trim().max(200), vatNumber: z.string().trim().max(30).optional() }).strict();
export type InvoiceCompanyCheckBody = z.infer<typeof InvoiceCompanyCheckBody>;
export const InvoiceCompanyCheck = z.object({ problems: z.array(z.string()) });

export const ConfirmCheckoutBody = z.object({ sessionId: z.string().regex(/^cs_[A-Za-z0-9_]{4,200}$/) }).strict();
export type ConfirmCheckoutBody = z.infer<typeof ConfirmCheckoutBody>;

export const SeatChangeBody = z.object({ seats: SeatCounts }).strict();
export type SeatChangeBody = z.infer<typeof SeatChangeBody>;

export const CheckoutResponse = z.object({ url: z.string().url(), sessionId: z.string() });
export const PortalResponse = z.object({ url: z.string().url() });

export const SeatPreviewResponse = z.object({
  currency: z.string(),
  subtotal: z.number().int(),
  tax: z.number().int(),
  total: z.number().int(),
  amountDue: z.number().int(),
  timing: z.enum(['now', 'next_invoice']),
  payment: z.enum(['card', 'invoice']),
  lines: z.array(z.object({ description: z.string(), amount: z.number().int() })),
  changes: z.array(z.object({ planSlug: z.string(), from: z.number().int(), to: z.number().int() })),
});
export type SeatPreviewResponse = z.infer<typeof SeatPreviewResponse>;

export const AssignPackageBody = z.object({ planSlug: PlanSlug }).strict();
export type AssignPackageBody = z.infer<typeof AssignPackageBody>;

export const EntitlementQuery = z.object({
  module: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  feature: z.string().regex(/^[a-z][a-z0-9_]{1,59}$/).optional(),
});

const Price = z.object({ unitAmount: z.number().int(), currency: z.string() });

export const PlanKind = z.enum(['seat', 'fee']);

export const PlanWithPrices = z.object({
  slug: z.string(),
  name: z.string(),
  /** `seat` = given to a person; `fee` = the organisation fee, one per subscription, never given to anyone and holding no access. */
  kind: PlanKind,
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
      trialEnd: z.string().nullable(),
      entitlementsEnforced: z.boolean(),
      gracePeriodDays: z.number().int(),
      /** How it is paid: the card is charged, or an invoice is emailed. */
      paymentRoute: z.enum(['card', 'invoice']),
      /** Invoiced subscriptions only. */
      paymentTermsDays: z.number().int().nullable(),
      billing: z.object({ legalName: z.string().nullable(), email: z.string().nullable(), vatNumber: z.string().nullable(), purchaseOrder: z.string().nullable() }).nullable(),
      /** The oldest invoice still owed (invoiced subscriptions; for anyone who may read invoices). */
      openInvoice: z
        .object({ id: z.string().uuid(), number: z.string().nullable(), total: z.number().int(), currency: z.string(), dueOn: z.string().nullable(), overdueDays: z.number().int(), hostedUrl: z.string().nullable(), pdfUrl: z.string().nullable() })
        .nullable(),
      /** An invoiced organisation whose first invoice is not paid yet: seats cannot go up and reporting keys wait. */
      firstInvoicePending: z.boolean(),
    })
    .nullable(),
  /** Stripe can take a purchase on this server (keys and prices are set up). */
  checkoutAvailable: z.boolean(),
  /** Seats are bought and changed through the payment provider (Stripe-billed, or an organisation that must have a subscription). */
  providerManaged: z.boolean(),
  items: z.array(
    z.object({
      planSlug: z.string(),
      /** The organisation fee is an item too (quantity 1); it is never a seat and is left out of the seat totals. */
      kind: PlanKind,
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
  dueDate: z.string().nullable(),
  hostedInvoiceUrl: z.string().nullable(),
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
