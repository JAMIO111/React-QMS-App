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
  exchangeRate: z.number(),
  netAmount: z.number(),
  vatAmount: z.number(),
  grossAmount: z.number(),
  baseCurrency: z.string(),
  netBase: z.number(),
  grossBase: z.number(),
  createdAt: dateTime,
  createdBy: Ref,
  deletedAt: dateTime.nullable(),
  deleteReason: z.string().nullable(),
});
export type Cost = z.infer<typeof Cost>;

export const CostList = z.object({
  data: z.array(Cost),
  /** Totals of the costs that are not deleted, in the organisation's base currency. */
  totals: z.object({ baseCurrency: z.string(), net: z.number(), gross: z.number(), count: z.number() }),
});

const costFields = {
  costType: CostType,
  description: text(500).nullable().optional(),
  incurredOn: isoDate.optional(),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/, 'Use a 3-letter ISO currency code').transform((v) => v.toUpperCase()),
  vatTreatment: VatTreatment.default('none'),
  vatRate: z.number().min(0).lt(1).default(0),
  quantity: z.number().gt(0).lt(1e9).default(1),
  unitCost: z.number().min(0).lt(1e12),
  exchangeRate: z.number().positive().default(1),
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
