import { z } from 'zod';

const Iso = z.string().datetime({ offset: true });
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-30');

export const APPROVAL_STATUSES = ['pending_approval', 'approved', 'conditional', 'suspended', 'disqualified', 'archived'] as const;
export const SUPPLIER_TYPES = ['manufacturer', 'distributor', 'subcontractor', 'service_provider', 'calibration_provider', 'logistics_provider', 'other'] as const;
export const RISK_RATINGS = ['low', 'medium', 'high', 'critical'] as const;
export const CONTACT_ROLES = ['quality', 'purchasing', 'sales', 'technical', 'accounts', 'logistics', 'management', 'other'] as const;
export const PRODUCT_KINDS = ['part', 'material', 'service'] as const;

export const ApprovalStatus = z.enum(APPROVAL_STATUSES);
export const SupplierType = z.enum(SUPPLIER_TYPES);

/** Comma-separated list of known values. */
const csv = (allowed: readonly string[]) => z.string().refine((v) => v.split(',').every((x) => allowed.includes(x)), 'Use a comma-separated list of known values');
const csvUuids = z.string().refine((v) => v.split(',').every((x) => z.string().uuid().safeParse(x).success), 'Use a comma-separated list of ids');

/** Optional text that is trimmed; empty means "clear it". */
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

// ---- input ---------------------------------------------------------------------------------------

export const SUPPLIER_SORTS = ['code', 'name', 'supplierType', 'approvalStatus', 'riskRating', 'country', 'openNcs', 'createdAt'] as const;

export const SupplierListQuery = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  status: csv(APPROVAL_STATUSES).optional(),
  type: csv(SUPPLIER_TYPES).optional(),
  classificationId: csvUuids.optional(),
  risk: csv(RISK_RATINGS).optional(),
  /** Operational activity, separate from approval. */
  active: z.enum(['active', 'inactive', 'all']).default('active'),
  sort: z.enum(SUPPLIER_SORTS).default('code'),
  order: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type SupplierListQuery = z.infer<typeof SupplierListQuery>;

const supplierFields = {
  name: z.string().trim().min(1).max(200),
  displayName: text(100),
  companyNumber: text(40),
  vatNumber: text(40),
  notes: text(2000),
  supplierType: SupplierType.nullable().optional(),
  country: z.string().trim().regex(/^[A-Z]{2}$/, 'Use a two-letter country code, e.g. GB').nullable().optional(),
  addressLine1: text(120),
  addressLine2: text(120),
  city: text(80),
  region: text(80),
  postcode: text(20),
  website: text(200),
  email: text(200),
  phone: text(40),
  purchasingReference: text(60),
};

export const CreateSupplierBody = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/, 'Use 1–20 letters, digits, "-" or "_"')
      .transform((v) => v.toUpperCase()),
    ...supplierFields,
    classificationIds: z.array(z.string().uuid()).max(30).optional(),
  })
  .strict();
export type CreateSupplierBody = z.infer<typeof CreateSupplierBody>;

export const UpdateSupplierBody = z
  .object({ ...supplierFields, name: supplierFields.name.optional(), active: z.boolean().optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');
export type UpdateSupplierBody = z.infer<typeof UpdateSupplierBody>;

export const ChangeStatusBody = z
  .object({
    status: ApprovalStatus,
    reason: z.string().trim().min(3).max(1000),
    /** What a conditional approval depends on; needed for `conditional`. */
    conditions: text(2000),
    reviewOn: DateOnly.nullable().optional(),
  })
  .strict();
export type ChangeStatusBody = z.infer<typeof ChangeStatusBody>;

export const SetClassificationsBody = z.object({ classificationIds: z.array(z.string().uuid()).max(30) }).strict();
export type SetClassificationsBody = z.infer<typeof SetClassificationsBody>;

export const CreateClassificationBody = z
  .object({ label: z.string().trim().min(1).max(60), description: text(300), sequence: z.number().int().min(0).max(10000).optional() })
  .strict();
export type CreateClassificationBody = z.infer<typeof CreateClassificationBody>;

export const UpdateClassificationBody = z
  .object({ label: z.string().trim().min(1).max(60).optional(), description: text(300), sequence: z.number().int().min(0).max(10000).optional(), active: z.boolean().optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');
export type UpdateClassificationBody = z.infer<typeof UpdateClassificationBody>;

export const ClassificationsQuery = z.object({ all: z.enum(['true', 'false']).default('false') });

const contactFields = {
  name: z.string().trim().min(1).max(120),
  jobTitle: text(120),
  role: z.enum(CONTACT_ROLES),
  email: text(200),
  phone: text(40),
  isPrimary: z.boolean(),
  notes: text(1000),
};
export const CreateContactBody = z
  .object({ ...contactFields, role: contactFields.role.default('other'), isPrimary: contactFields.isPrimary.default(false) })
  .strict();
export type CreateContactBody = z.infer<typeof CreateContactBody>;
export const UpdateContactBody = z
  .object({ ...Object.fromEntries(Object.entries(contactFields).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])), active: z.boolean().optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');
export type UpdateContactBody = z.infer<typeof UpdateContactBody>;

export const CreateProductBody = z
  .object({
    kind: z.enum(PRODUCT_KINDS),
    partId: z.string().uuid().nullable().optional(),
    description: text(200),
    supplierPartNumber: text(60),
    notes: text(1000),
  })
  .strict()
  .refine((b) => (b.kind === 'part' ? !!b.partId : !b.partId && !!b.description), 'A part needs a part; a material or service needs a description and no part');
export type CreateProductBody = z.infer<typeof CreateProductBody>;
export const UpdateProductBody = z
  .object({ supplierPartNumber: text(60), notes: text(1000), active: z.boolean().optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');
export type UpdateProductBody = z.infer<typeof UpdateProductBody>;

// ---- output --------------------------------------------------------------------------------------

const Ref = z.object({ id: z.string().uuid(), label: z.string() });

export const SupplierRow = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  displayName: z.string().nullable(),
  supplierType: SupplierType.nullable(),
  country: z.string().nullable(),
  city: z.string().nullable(),
  approvalStatus: ApprovalStatus,
  approvalStatusChangedAt: Iso.nullable(),
  active: z.boolean(),
  riskRating: z.enum(RISK_RATINGS).nullable(),
  classifications: z.array(Ref),
  primaryContact: z.object({ name: z.string(), email: z.string().nullable(), phone: z.string().nullable() }).nullable(),
  /** Live non-conformances naming this supplier that are not closed or cancelled (those the caller may read). */
  openNcCount: z.number().int(),
  createdAt: Iso,
});
export type SupplierRow = z.infer<typeof SupplierRow>;

export const SupplierPage = z.object({ data: z.array(SupplierRow), page: z.number().int(), pageSize: z.number().int(), total: z.number().int() });

export const SupplierContact = z.object({
  id: z.string().uuid(),
  name: z.string(),
  jobTitle: z.string().nullable(),
  role: z.enum(CONTACT_ROLES),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  isPrimary: z.boolean(),
  active: z.boolean(),
  notes: z.string().nullable(),
});
export type SupplierContact = z.infer<typeof SupplierContact>;

export const SupplierProduct = z.object({
  id: z.string().uuid(),
  kind: z.enum(PRODUCT_KINDS),
  part: z.object({ id: z.string().uuid(), partNumber: z.string(), name: z.string() }).nullable(),
  description: z.string().nullable(),
  supplierPartNumber: z.string().nullable(),
  notes: z.string().nullable(),
  active: z.boolean(),
});
export type SupplierProduct = z.infer<typeof SupplierProduct>;

export const StatusHistoryItem = z.object({
  id: z.string().uuid(),
  fromStatus: ApprovalStatus.nullable(),
  toStatus: ApprovalStatus,
  reason: z.string().nullable(),
  conditions: z.string().nullable(),
  reviewOn: DateOnly.nullable(),
  changedAt: Iso,
  changedBy: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
});
export type StatusHistoryItem = z.infer<typeof StatusHistoryItem>;

export const SupplierDetail = SupplierRow.omit({ primaryContact: true }).extend({
  companyNumber: z.string().nullable(),
  vatNumber: z.string().nullable(),
  notes: z.string().nullable(),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  region: z.string().nullable(),
  postcode: z.string().nullable(),
  website: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  purchasingReference: z.string().nullable(),
  approvalStatusChangedBy: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
  /** The conditions and review date of the latest conditional approval, while the status is conditional. */
  conditions: z.string().nullable(),
  reviewOn: DateOnly.nullable(),
  contacts: z.array(SupplierContact),
  products: z.array(SupplierProduct),
  counts: z.object({
    openNcs: z.number().int(),
    totalNcs: z.number().int(),
    receivedLots: z.number().int(),
    lastReceivedOn: DateOnly.nullable(),
  }),
});
export type SupplierDetail = z.infer<typeof SupplierDetail>;

export const Classification = z.object({
  id: z.string().uuid(),
  key: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  sequence: z.number().int(),
  active: z.boolean(),
  /** How many suppliers hold it. */
  suppliers: z.number().int(),
});
export type Classification = z.infer<typeof Classification>;
