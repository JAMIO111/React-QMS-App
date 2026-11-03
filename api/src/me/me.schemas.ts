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
});

export const Membership = z.object({
  membershipId: z.string().uuid(),
  organisation: z.object({ id: z.string().uuid(), name: z.string(), slug: z.string() }),
  permissions: z.array(z.string()),
});

/** Two-factor state of this session and the organisations it cannot use until MFA is passed. */
export const MfaStatus = z.object({
  level: z.enum(['aal1', 'aal2']),
  requiredBy: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
});
export const MeResponse = z.object({ profile: Profile, memberships: z.array(Membership), mfa: MfaStatus });
export type MeResponse = z.infer<typeof MeResponse>;
