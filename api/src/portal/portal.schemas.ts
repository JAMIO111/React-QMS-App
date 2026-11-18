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

export const ShareBody = z.object({ kind: z.enum(['ncr', 'capa']), recordId: z.string().uuid(), partyId: z.string().uuid() }).strict();
export const SharesQuery = z.object({ kind: z.enum(['ncr', 'capa']), recordId: z.string().uuid() });
export const CommentBody = z.object({ body: z.string().trim().min(1).max(4000) }).strict();
