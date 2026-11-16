import { z } from 'zod';

const name = z.string().trim().min(1).max(100);

export const UpdateMeBody = z
  .object({
    firstName: name.nullable().optional(),
    surname: name.nullable().optional(),
    jobTitle: z.string().trim().max(100).nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });
export type UpdateMeBody = z.infer<typeof UpdateMeBody>;

export const Profile = z.object({
  id: z.string().uuid(),
  email: z.string().nullable(),
  firstName: z.string().nullable(),
  surname: z.string().nullable(),
  jobTitle: z.string().nullable(),
  avatarPath: z.string().nullable(),
  /** When and which version of Fortress's terms the person accepted (null: not yet, e.g. after a first company sign-in). */
  termsAcceptedAt: z.string().nullable(),
  termsVersion: z.string().nullable(),
});

export const Membership = z.object({
  membershipId: z.string().uuid(),
  organisation: z.object({ id: z.string().uuid(), name: z.string(), slug: z.string() }),
  /** open | needs_subscription (nothing bought yet) | lapsed. Anything but open leaves only billing and set-up (see app.organisation_access_state). */
  accessState: z.enum(['open', 'needs_subscription', 'lapsed']),
  /** none | in_progress | complete: the owner's set-up wizard (only people who can set the organisation up see in_progress). */
  onboarding: z.enum(['none', 'in_progress', 'complete']),
  permissions: z.array(z.string()),
  /** The organisation's network rule for this request (docs/security-plan.md): open (no restriction), allowed, monitored (outside the approved
   *  networks, recorded but not blocked) or denied (blocked: the app shows why), with the address the API saw. */
  network: z.object({ state: z.enum(['open', 'allowed', 'monitored', 'denied']), address: z.string().nullable() }),
});

/** Two-factor state of this session and the organisations it cannot use until MFA is passed. */
export const MfaStatus = z.object({
  level: z.enum(['aal1', 'aal2']),
  requiredBy: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
});
/** Organisations that require their company sign-in, which this session did not use (docs/sso-plan.md SS6). */
export const SsoStatus = z.object({
  requiredBy: z.array(z.object({ id: z.string().uuid(), name: z.string(), providerId: z.string().uuid().nullable(), breakGlass: z.boolean() })),
  /** Organisations this company sign-in may join by itself (SS4). */
  joinable: z.array(z.object({ id: z.string().uuid(), name: z.string(), roleName: z.string() })),
  /** Organisations where the person's old password account can be moved onto this company account (SS5). */
  moveCandidates: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
});
export const MeResponse = z.object({ profile: Profile, memberships: z.array(Membership), mfa: MfaStatus, sso: SsoStatus });
export type MeResponse = z.infer<typeof MeResponse>;

export const AcceptTermsBody = z.object({ version: z.string().trim().regex(/^[A-Za-z0-9._-]{1,20}$/) }).strict();

export const SsoJoinBody = z.object({ organisationId: z.string().uuid() }).strict();
export const MoveOwnAccountBody = z.object({ organisationId: z.string().uuid(), password: z.string().min(1).max(200) }).strict();
