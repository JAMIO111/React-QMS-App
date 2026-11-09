import { z } from 'zod';

const Iso = z.string().datetime({ offset: true });
const Person = z.object({ id: z.string().uuid(), name: z.string() }).nullable();
const text = (max: number) => z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date as YYYY-MM-DD');

export const CERT_KINDS = ['mill_test_report', 'certificate_of_conformance', 'certificate_of_analysis', 'test_report', 'other'] as const;
export const CERT_STATUSES = ['received', 'accepted', 'rejected', 'withdrawn'] as const;

const Fields = {
  certificateNumber: z.string().trim().min(1, 'Give the certificate number').max(100),
  kind: z.enum(CERT_KINDS),
  /** What it covers: a part of ours or a material in words. Filled in from the receipt line or lot when they name a part. */
  partId: z.string().uuid().nullable().optional(),
  material: text(200),
  specification: text(200),
  heatNumber: text(100),
  /** Traceability: at least one of receiptLineId, lotId or heatNumber. A receipt line brings its lot and part. */
  receiptLineId: z.string().uuid().nullable().optional(),
  lotId: z.string().uuid().nullable().optional(),
  issuedOn: day.nullable().optional(),
  /** The certificate file: a current document of the same supplier (upload it under the supplier's documents first). */
  documentId: z.string().uuid().nullable().optional(),
  notes: text(2000),
};

export const RecordCertificateBody = z.object({ supplierId: z.string().uuid(), ...Fields }).strict();
export type RecordCertificateBody = z.infer<typeof RecordCertificateBody>;
export const UpdateCertificateBody = z.object(Object.fromEntries(Object.entries(Fields).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()]))).partial().strict().refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });
export type UpdateCertificateBody = z.infer<typeof UpdateCertificateBody>;
export const ReviewCertificateBody = z.object({ accept: z.boolean(), note: text(1000) }).strict();
export type ReviewCertificateBody = z.infer<typeof ReviewCertificateBody>;
export const WithdrawCertificateBody = z.object({ reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(1000) }).strict();
export type WithdrawCertificateBody = z.infer<typeof WithdrawCertificateBody>;

export const CertificateListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  supplierId: z.string().uuid().optional(),
  lotId: z.string().uuid().optional(),
  receiptLineId: z.string().uuid().optional(),
  partId: z.string().uuid().optional(),
  /** `live` = received and accepted (the default), `review` = waiting for review, `all`, or a list of statuses. */
  status: z.string().refine((v) => ['live', 'review', 'all'].includes(v) || v.split(',').every((x) => (CERT_STATUSES as readonly string[]).includes(x)), 'Use live, review, all or known statuses').default('live'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type CertificateListQuery = z.infer<typeof CertificateListQuery>;

export const Certificate = z.object({
  id: z.string().uuid(),
  supplier: z.object({ id: z.string().uuid(), code: z.string(), name: z.string() }),
  certificateNumber: z.string(),
  kind: z.enum(CERT_KINDS),
  part: z.object({ id: z.string().uuid(), partNumber: z.string(), name: z.string() }).nullable(),
  material: z.string().nullable(),
  specification: z.string().nullable(),
  heatNumber: z.string().nullable(),
  receiptLine: z.object({ id: z.string().uuid(), lineNumber: z.number().int(), receiptId: z.string().uuid(), receiptReference: z.string() }).nullable(),
  lot: z.object({ id: z.string().uuid(), lotNumber: z.string() }).nullable(),
  issuedOn: z.string().nullable(),
  document: z.object({ id: z.string().uuid(), title: z.string(), fileName: z.string(), storagePath: z.string() }).nullable(),
  notes: z.string().nullable(),
  status: z.enum(CERT_STATUSES),
  reviewedBy: Person,
  reviewedAt: Iso.nullable(),
  reviewNote: z.string().nullable(),
  withdrawnAt: Iso.nullable(),
  withdrawalReason: z.string().nullable(),
  createdBy: Person,
  createdAt: Iso,
});
export type Certificate = z.infer<typeof Certificate>;
export const CertificateList = z.object({ data: z.array(Certificate), page: z.number().int(), pageSize: z.number().int(), total: z.number().int(), reviewCount: z.number().int() });
