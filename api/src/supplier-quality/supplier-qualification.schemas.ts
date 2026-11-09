import { z } from 'zod';

const Iso = z.string().datetime({ offset: true });
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-30');
const text = (max: number) => z.string().trim().min(1).max(max);
/** Optional text; an empty string clears it. */
const optText = (max: number) =>
  z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();
const optDate = DateOnly.nullable().optional();

export const DOCUMENT_TYPES = ['certificate', 'quality_manual', 'questionnaire', 'agreement', 'insurance', 'audit_report', 'test_report', 'drawing_agreement', 'other'] as const;
export const CERTIFICATION_TYPES = ['iso_9001', 'iatf_16949', 'as9100', 'iso_13485', 'iso_14001', 'iso_45001', 'nadcap', 'rohs_reach', 'other'] as const;
export const DocumentType = z.enum(DOCUMENT_TYPES);
export const CertificationType = z.enum(CERTIFICATION_TYPES);

// ---- input ---------------------------------------------------------------------------------------

/** A stored file (already uploaded to the supplier's folder in the private bucket) with its details. `replacesId` makes it a new version of a current document. */
export const CreateDocumentBody = z
  .object({
    docType: DocumentType,
    title: text(200),
    revision: optText(40),
    documentDate: optDate,
    expiresOn: optDate,
    notes: optText(2000),
    storagePath: z.string().trim().min(1).max(600),
    fileName: text(255),
    contentType: z.string().trim().max(200).nullable().optional(),
    sizeBytes: z.number().int().min(0).max(26214400),
    replacesId: z.string().uuid().optional(),
  })
  .strict();
export type CreateDocumentBody = z.infer<typeof CreateDocumentBody>;

export const UpdateDocumentBody = z
  .object({ docType: DocumentType, title: text(200), revision: optText(40), documentDate: optDate, expiresOn: optDate, notes: optText(2000) })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });
export type UpdateDocumentBody = z.infer<typeof UpdateDocumentBody>;

export const VerifyBody = z.object({ note: optText(1000) }).strict();
export type VerifyBody = z.infer<typeof VerifyBody>;
export const ReasonBody = z.object({ reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(1000) }).strict();
export type ReasonBody = z.infer<typeof ReasonBody>;

const CertificationFields = {
  title: optText(200),
  certificateNumber: text(100),
  issuingBody: text(200),
  scope: optText(2000),
  issuedOn: optDate,
  expiresOn: optDate,
  documentId: z.string().uuid().nullable().optional(),
  notes: optText(2000),
};
export const CreateCertificationBody = z.object({ certType: CertificationType, ...CertificationFields }).strict();
export type CreateCertificationBody = z.infer<typeof CreateCertificationBody>;
export const UpdateCertificationBody = z
  .object({ certType: CertificationType, ...CertificationFields })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });
export type UpdateCertificationBody = z.infer<typeof UpdateCertificationBody>;
/** A renewal keeps the type; everything else is stated afresh. */
export const RenewCertificationBody = z.object(CertificationFields).strict();
export type RenewCertificationBody = z.infer<typeof RenewCertificationBody>;

export const WatchlistQuery = z.object({
  /** Warn this many days ahead (expired ones are always listed). */
  days: z.coerce.number().int().min(1).max(365).default(60),
  kind: z.enum(['certification', 'document']).optional(),
});
export type WatchlistQuery = z.infer<typeof WatchlistQuery>;

// ---- output --------------------------------------------------------------------------------------

const Person = z.object({ id: z.string().uuid(), name: z.string() }).nullable();
const Expiry = z.object({ state: z.enum(['no_expiry', 'valid', 'expiring', 'expired']), daysLeft: z.number().int().nullable() });
const Verification = z.object({ at: Iso, by: Person, note: z.string().nullable() }).nullable();

export const SupplierDocument = z.object({
  id: z.string().uuid(),
  supplierId: z.string().uuid(),
  docType: DocumentType,
  title: z.string(),
  revision: z.string().nullable(),
  documentDate: DateOnly.nullable(),
  expiresOn: DateOnly.nullable(),
  notes: z.string().nullable(),
  storagePath: z.string(),
  fileName: z.string(),
  contentType: z.string().nullable(),
  sizeBytes: z.number().int(),
  status: z.enum(['current', 'superseded', 'removed']),
  replacesId: z.string().uuid().nullable(),
  /** Of a current document only (a superseded or removed one is no longer in force). */
  expiry: Expiry,
  verification: Verification,
  removal: z.object({ at: Iso, by: Person, reason: z.string() }).nullable(),
  createdAt: Iso,
  createdBy: Person,
});
export type SupplierDocument = z.infer<typeof SupplierDocument>;

export const SupplierCertification = z.object({
  id: z.string().uuid(),
  supplierId: z.string().uuid(),
  certType: CertificationType,
  title: z.string().nullable(),
  certificateNumber: z.string(),
  issuingBody: z.string(),
  scope: z.string().nullable(),
  issuedOn: DateOnly.nullable(),
  expiresOn: DateOnly.nullable(),
  /** The evidence file, when one is attached (its label is null when the caller cannot read it). */
  document: z.object({ id: z.string().uuid(), title: z.string(), fileName: z.string(), storagePath: z.string() }).nullable(),
  notes: z.string().nullable(),
  status: z.enum(['current', 'superseded', 'withdrawn']),
  replacesId: z.string().uuid().nullable(),
  expiry: Expiry,
  verification: Verification,
  withdrawal: z.object({ at: Iso, by: Person, reason: z.string() }).nullable(),
  createdAt: Iso,
  createdBy: Person,
});
export type SupplierCertification = z.infer<typeof SupplierCertification>;

export const WatchlistItem = z.object({
  kind: z.enum(['certification', 'document']),
  id: z.string().uuid(),
  supplier: z.object({ id: z.string().uuid(), code: z.string(), name: z.string() }),
  title: z.string(),
  detail: z.string().nullable(),
  expiresOn: DateOnly,
  state: z.enum(['expiring', 'expired']),
  daysLeft: z.number().int(),
  verified: z.boolean(),
});
export const Watchlist = z.object({
  data: z.array(WatchlistItem),
  counts: z.object({ expired: z.number().int(), expiring: z.number().int() }),
  days: z.number().int(),
});
export type Watchlist = z.infer<typeof Watchlist>;
