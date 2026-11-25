import { z } from 'zod';

const Tiles = z.record(z.string().max(40), z.boolean()).refine((t) => Object.keys(t).length <= 20, { message: 'Too many tiles' });

export const SettingsBody = z
  .object({ enabled: z.boolean().optional(), rankingEnabled: z.boolean().optional(), requireMfa: z.boolean().optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });

export const PartyBody = z
  .object({
    kind: z.enum(['supplier', 'customer']),
    partyId: z.string().uuid(),
    enabled: z.boolean().optional(),
    contactName: z.string().trim().max(120).nullable().optional(),
    tiles: Tiles.optional(),
  })
  .strict();

export const InviteBody = z
  .object({
    partyId: z.string().uuid(),
    email: z.string().trim().toLowerCase().email().max(254),
    role: z.enum(['admin', 'member']).default('member'),
    message: z.string().trim().max(500).optional(),
  })
  .strict();

/** A party admin's own invitation: the party is theirs by the access row, never a field. */
export const OwnPartyInviteBody = z
  .object({ email: z.string().trim().toLowerCase().email().max(254), message: z.string().trim().max(500).optional() })
  .strict();

export const ReasonBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
export const PeopleQuery = z.object({ partyId: z.string().uuid().optional() });

export const ShareBody = z.object({ kind: z.enum(['ncr', 'capa', 'document', 'quality_alert']), recordId: z.string().uuid(), partyId: z.string().uuid() }).strict();
export const SharesQuery = z.object({ kind: z.enum(['ncr', 'capa', 'document', 'quality_alert']), recordId: z.string().uuid() });
export const CommentBody = z.object({ body: z.string().trim().min(1).max(4000) }).strict();

const Text = (max: number) => z.string().trim().min(3).max(max);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date as yyyy-mm-dd');
export const ScarAcknowledgeBody = z.object({ note: z.string().trim().max(1000).optional() }).strict();
export const ScarRespondBody = z
  .object({
    rootCause: Text(4000),
    containment: z.string().trim().max(4000).optional(),
    correctiveAction: Text(4000),
    preventiveAction: z.string().trim().max(4000).optional(),
    plannedCompletionOn: day.nullable().optional(),
    extentOfCondition: z.string().trim().max(4000).optional(),
    escapePoint: z.string().trim().max(4000).optional(),
    responsibleName: z.string().trim().max(200).optional(),
    rootCauseMethod: z.enum(['five_whys', 'fishbone', 'other']).nullable().optional(),
  })
  .strict();
export const ScarExtensionBody = z.object({ newDueOn: day, reason: z.string().trim().min(3).max(1000) }).strict();
export const ScarExtensionWithdrawBody = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();

export const ScarUploadBody = z.object({ fileName: z.string().trim().min(1).max(255) }).strict();
export const ScarFileBody = z
  .object({ path: z.string().min(1).max(1024), fileName: z.string().trim().min(1).max(255), contentType: z.string().max(150).optional(), sizeBytes: z.number().int().min(0).max(26_214_400) })
  .strict();

export const AcknowledgeBody = z.object({ note: z.string().trim().max(1000).optional() }).strict();
export const ShareFileBody = z.object({ fileId: z.string().uuid() }).strict();
export const ScarActionCompleteBody = z.object({ note: z.string().trim().min(3, 'Say what was done').max(2000) }).strict();

export const ComplaintBody = z
  .object({
    title: z.string().trim().min(3).max(200),
    description: z.string().trim().min(10).max(4000),
    partId: z.string().uuid().nullish(),
    quantity: z.number().min(0).max(100_000_000).nullish(),
    lot: z.string().trim().max(100).nullish(),
    customerReference: z.string().trim().max(100).nullish(),
    detectedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    clientKey: z.string().min(8).max(80).nullish(),
  })
  .strict();

export const ChangeRequestBody = z
  .object({
    title: z.string().trim().min(3).max(200),
    description: z.string().trim().min(10).max(4000),
    reason: z.string().trim().max(2000).nullish(),
    partId: z.string().uuid().nullish(),
    wantedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    clientKey: z.string().min(8).max(80).nullish(),
  })
  .strict();

export const ClosureRequestBody = z.object({ note: z.string().trim().max(500).nullish() }).strict();
export const ClosureDecisionBody = z.object({ confirm: z.boolean(), note: z.string().trim().max(2000).nullish() }).strict();

export const LotEvidenceBody = z
  .object({
    customerId: z.string().uuid(),
    kind: z.enum(['certificate_of_conformance', 'inspection_report', 'other']),
    description: z.string().trim().max(300).nullish(),
    path: z.string().min(1).max(500),
    fileName: z.string().trim().min(1).max(255),
    contentType: z.string().max(200).nullish(),
    sizeBytes: z.number().int().min(0).max(26_214_400),
  })
  .strict();

export const ChangeApprovalDecisionBody = z
  .object({ approve: z.boolean(), note: z.string().trim().max(2000).nullish(), reference: z.string().trim().max(200).nullish() })
  .strict();
