import { z } from 'zod';

export const MembershipStatus = z.enum(['invited', 'active', 'suspended', 'removed']);
export type MembershipStatus = z.infer<typeof MembershipStatus>;

export const RoleAssignment = z.object({
  assignmentId: z.string().uuid(),
  roleId: z.string().uuid(),
  roleKey: z.string(),
  roleName: z.string(),
  siteId: z.string().uuid().nullable(),
  departmentId: z.string().uuid().nullable(),
});

export const Member = z.object({
  membershipId: z.string().uuid(),
  userId: z.string().uuid().nullable(),
  email: z.string().nullable(),
  firstName: z.string().nullable(),
  surname: z.string().nullable(),
  jobTitle: z.string().nullable(),
  status: MembershipStatus,
  invitedAt: z.string().nullable(),
  joinedAt: z.string().nullable(),
  roles: z.array(RoleAssignment),
});
export type Member = z.infer<typeof Member>;

export const InviteBody = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    roleId: z.string().uuid(),
    siteId: z.string().uuid().optional(),
    departmentId: z.string().uuid().optional(),
  })
  .strict();
export type InviteBody = z.infer<typeof InviteBody>;

export const InviteResponse = z.object({
  member: Member,
  email: z.object({ sent: z.boolean(), reason: z.string().optional() }),
});

export const UpdateMemberBody = z.object({ status: z.enum(['active', 'suspended', 'removed']) }).strict();
export type UpdateMemberBody = z.infer<typeof UpdateMemberBody>;

/** Allowed status changes; anything else is rejected with 409 invalid_transition. */
export const TRANSITIONS: Record<MembershipStatus, MembershipStatus[]> = {
  invited: ['removed'],
  active: ['suspended', 'removed'],
  suspended: ['active', 'removed'],
  removed: [],
};

export const AssignRoleBody = z
  .object({ roleId: z.string().uuid(), siteId: z.string().uuid().optional(), departmentId: z.string().uuid().optional() })
  .strict();
export type AssignRoleBody = z.infer<typeof AssignRoleBody>;

export const Role = z.object({
  id: z.string().uuid(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isSystem: z.boolean(),
  permissions: z.array(z.string()),
});

export const Permission = z.object({ code: z.string(), description: z.string() });

export const Invitation = z.object({
  membershipId: z.string().uuid(),
  organisationId: z.string().uuid(),
  organisationName: z.string(),
  invitedAt: z.string().nullable(),
  invitedByName: z.string().nullable(),
});
