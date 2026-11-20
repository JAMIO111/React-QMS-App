import { z } from 'zod';

/** Cost categories (keep in step with the CHECK on public.ncr_costs.cost_type). */
export const COST_TYPES = [
  'material', 'labour', 'scrap', 'rework', 'transport', 'inspection', 'sorting', 'customer_charge',
  'supplier_recovery', 'admin', 'tools_equipment', 'consultancy', 'packaging', 'waste_disposal', 'other',
] as const;
export const CostType = z.enum(COST_TYPES);
export const VatTreatment = z.enum(['none', 'inclusive', 'exclusive']);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const dateTime = z.string().datetime({ offset: true });
const Ref = z.object({ id: z.string().uuid(), name: z.string() }).nullable();
const text = (max: number) => z.string().trim().max(max).transform((v) => (v === '' ? null : v));

export const Cost = z.object({
  id: z.string().uuid(),
  costType: CostType,
  description: z.string().nullable(),
  incurredOn: isoDate,
  currency: z.string(),
  vatTreatment: VatTreatment,
  vatRate: z.number(),
  /** How many (pieces, hours, kilograms…). */
  quantity: z.number(),
  /** Cost of one, in the line's currency and VAT treatment. */
  unitCost: z.number(),
  /** Quantity × unit cost, rounded to pennies (worked out by the database). */
  amount: z.number(),
  netAmount: z.number(),
  vatAmount: z.number(),
  grossAmount: z.number(),
  /** -1 for recoveries and charges (credits), +1 otherwise; totals add net × sign. */
  costSign: z.number(),
  /** The line's currency of record: the currency of its site (the organisation's when the NC has no site). */
  baseCurrency: z.string(),
  /** Line currency to base currency; null while the rate is needed. */
  exchangeRate: z.number().nullable(),
  /** Net and gross in the base currency; null while the rate is needed (the line then adds nothing to totals). */
  netBase: z.number().nullable(),
  grossBase: z.number().nullable(),
  /** The same in the organisation's currency, for totals across sites. */
  orgCurrency: z.string(),
  orgRate: z.number().nullable(),
  netOrg: z.number().nullable(),
  grossOrg: z.number().nullable(),
  /** base = same currency, estimated = the published rate, actual = a rate or amount a person stated, needed = no rate yet. */
  rateStatus: z.enum(['base', 'estimated', 'actual', 'needed']),
  rateSource: z.enum(['none', 'frankfurter', 'manual']),
  /** The business day the published rate is for (null for a stated rate). */
  rateDate: isoDate.nullable(),
  /** The published rate, kept beside a stated one for comparison. */
  estimatedRate: z.number().nullable(),
  overrideKind: z.enum(['rate', 'amount']).nullable(),
  overrideNote: z.string().nullable(),
  overriddenAt: dateTime.nullable(),
  overriddenBy: Ref,
  createdAt: dateTime,
  createdBy: Ref,
  deletedAt: dateTime.nullable(),
  deleteReason: z.string().nullable(),
});
export type Cost = z.infer<typeof Cost>;

/**
 * Totals of the costs that are not deleted, net of credits. `net` / `gross` are in the currency of the NC's site (`baseCurrency`), `netOrg` / `grossOrg` in the
 * organisation's (`orgCurrency`). Lines still waiting for a rate add nothing and are counted in `needed`. `byCurrency` is what was actually spent, in each
 * line's own currency.
 */
export const CostTotals = z.object({
  baseCurrency: z.string(),
  orgCurrency: z.string(),
  net: z.number(),
  gross: z.number(),
  netOrg: z.number(),
  grossOrg: z.number(),
  count: z.number(),
  byCurrency: z.array(z.object({ currency: z.string(), net: z.number(), gross: z.number(), lines: z.number() })),
  rates: z.object({ base: z.number(), estimated: z.number(), actual: z.number(), needed: z.number() }),
});
export type CostTotals = z.infer<typeof CostTotals>;
export const CostList = z.object({ data: z.array(Cost), totals: CostTotals });

export const RateBody = z
  .object({
    /** rate: 1 unit of the line's currency = value in the base currency. amount: the converted value of the amount that was entered. */
    kind: z.enum(['rate', 'amount']),
    value: z.number().positive().lt(1e12),
    note: text(500).nullable().optional(),
  })
  .strict();

const costFields = {
  costType: CostType,
  description: text(500).nullable().optional(),
  incurredOn: isoDate.optional(),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/, 'Use a 3-letter ISO currency code').transform((v) => v.toUpperCase()),
  vatTreatment: VatTreatment.default('none'),
  vatRate: z.number().min(0).lt(1).default(0),
  quantity: z.number().gt(0).lt(1e9).default(1),
  unitCost: z.number().min(0).lt(1e12),
  /** Ignored: rates are looked up, or stated through POST /ncr-costs/{id}/rate. Still accepted while older screens send it. */
  exchangeRate: z.number().positive().optional(),
};
export const CreateCostBody = z.object(costFields).strict();
export const UpdateCostBody = z
  .object({
    costType: costFields.costType.optional(),
    description: costFields.description,
    incurredOn: costFields.incurredOn,
    currency: costFields.currency.optional(),
    vatTreatment: VatTreatment.optional(),
    vatRate: z.number().min(0).lt(1).optional(),
    quantity: z.number().gt(0).lt(1e9).optional(),
    unitCost: costFields.unitCost.optional(),
    exchangeRate: z.number().positive().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');

export const Attachment = z.object({
  id: z.string().uuid(),
  fileName: z.string(),
  contentType: z.string().nullable(),
  sizeBytes: z.number(),
  description: z.string().nullable(),
  storagePath: z.string(),
  createdAt: dateTime,
  createdBy: Ref,
  deletedAt: dateTime.nullable(),
  deleteReason: z.string().nullable(),
});
export type Attachment = z.infer<typeof Attachment>;

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const CreateAttachmentBody = z
  .object({
    storagePath: z.string().min(1).max(1024),
    fileName: z.string().trim().min(1).max(255),
    contentType: z.string().trim().max(255).nullable().optional(),
    sizeBytes: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES),
    description: text(500).nullable().optional(),
  })
  .strict();

export const DeletedQuery = z.object({ deleted: z.enum(['exclude', 'include', 'only']).default('exclude') });
