import { z } from 'zod';
import { ListQuery } from '../common/pagination';

const booleanFlag = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => v === 'true');
const Search = z.string().trim().max(100).optional();
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

/** Customer / supplier codes: upper-cased, 1–20 letters, digits, "-" or "_". */
export const PartyCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/, 'Use 1–20 letters, digits, "-" or "_"')
  .transform((v) => v.toUpperCase());

export const Unit = z.object({ code: z.string(), name: z.string(), quantityKind: z.string() });
export type Unit = z.infer<typeof Unit>;

export const Party = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  displayName: z.string().nullable(),
  companyNumber: z.string().nullable(),
  vatNumber: z.string().nullable(),
  notes: z.string().nullable(),
  active: z.boolean(),
});
export type Party = z.infer<typeof Party>;

const partyFields = {
  code: PartyCode,
  name: z.string().trim().min(1).max(200),
  displayName: optionalText(100),
  companyNumber: optionalText(40),
  vatNumber: optionalText(40),
  notes: optionalText(2000),
};
export const CreatePartyBody = z.object(partyFields).strict();
export const UpdatePartyBody = z
  .object({ ...Object.fromEntries(Object.entries(partyFields).map(([k, v]) => [k, v.optional()])), active: z.boolean().optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });
export const PartyListQuery = ListQuery.extend({ q: Search, includeInactive: booleanFlag });

export const RevisionStatus = z.enum(['draft', 'released', 'superseded', 'obsolete']);
export const PartRevision = z.object({
  id: z.string().uuid(),
  partId: z.string().uuid(),
  revision: z.string(),
  drawingRef: z.string().nullable(),
  changeSummary: z.string().nullable(),
  status: RevisionStatus,
  releasedAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type PartRevision = z.infer<typeof PartRevision>;

export const PartSummary = z.object({
  id: z.string().uuid(),
  partNumber: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  customer: z.object({ id: z.string().uuid(), code: z.string(), name: z.string() }).nullable(),
  partFamily: z.object({ id: z.string().uuid(), code: z.string(), name: z.string() }).nullable(),
  active: z.boolean(),
  /** The released revision, if any. */
  currentRevision: z.string().nullable(),
});
export type PartSummary = z.infer<typeof PartSummary>;
export const PartDetail = PartSummary.extend({ revisions: z.array(PartRevision) });
export type PartDetail = z.infer<typeof PartDetail>;

const PartNumber = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^\S(.*\S)?$/, 'No leading or trailing spaces');
const RevisionCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,9}$/, 'Use 1–10 letters, digits, ".", "-" or "_"');

export const CreatePartBody = z
  .object({
    partNumber: PartNumber,
    name: z.string().trim().min(1).max(200),
    description: optionalText(2000),
    customerId: z.string().uuid().nullable().optional(),
    partFamilyId: z.string().uuid().nullable().optional(),
    /** Optional first revision, created as a draft. */
    initialRevision: z.object({ revision: RevisionCode, drawingRef: optionalText(100) }).strict().optional(),
  })
  .strict();
export const UpdatePartBody = z
  .object({
    partNumber: PartNumber.optional(),
    name: z.string().trim().min(1).max(200).optional(),
    description: optionalText(2000),
    customerId: z.string().uuid().nullable().optional(),
    partFamilyId: z.string().uuid().nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });
export const PartListQuery = ListQuery.extend({ q: Search, customerId: z.string().uuid().optional(), partFamilyId: z.string().uuid().optional(), includeInactive: booleanFlag });

export const CreateRevisionBody = z
  .object({ revision: RevisionCode, drawingRef: optionalText(100), changeSummary: optionalText(2000) })
  .strict();
export const UpdateRevisionBody = z
  .object({ revision: RevisionCode.optional(), drawingRef: optionalText(100), changeSummary: optionalText(2000) })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });
