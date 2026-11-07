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

export const DepartmentMembership = z.object({
  id: z.string().uuid(),
  departmentId: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  siteId: z.string().uuid(),
  siteName: z.string(),
  isPrimary: z.boolean(),
  joinedAt: z.string(),
});

/** Roles that cover the whole organisation: a person who only holds these needs no department (docs/documentation-plan.md D7). */
export const ORGANISATION_WIDE_ROLE_KEYS = ['owner', 'admin', 'quality_manager'];

export const InviteDetail = z.object({
  message: z.string().nullable(),
  expiresAt: z.string().nullable(),
  lastSentAt: z.string().nullable(),
  sendCount: z.number().int(),
  expired: z.boolean(),
  /** The package whose seat is reserved for them, if one was chosen. */
  packageSlug: z.string().nullable(),
  packageName: z.string().nullable(),
});
export type InviteDetail = z.infer<typeof InviteDetail>;

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
  /** Departments the person belongs to now (primary first). */
  departments: z.array(DepartmentMembership),
  /** Only for a pending invitation. */
  invite: InviteDetail.nullable(),
});
export type Member = z.infer<typeof Member>;

export const InviteBody = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    roleId: z.string().uuid(),
    siteId: z.string().uuid().optional(),
    /** Scopes the role to this department (the person must be in it; it is added to departmentIds if missing). */
    departmentId: z.string().uuid().optional(),
    /** The departments the person joins. Required unless every role given is organisation-wide. */
    departmentIds: z.array(z.string().uuid()).max(20).default([]),
    /** Which of them is primary (default: the first). */
    primaryDepartmentId: z.string().uuid().optional(),
    /** A personal note shown to the invitee (max 500 characters). */
    message: z.string().trim().max(500).optional(),
    /** The package (seat) to reserve for them, e.g. contributor. Needs subscription.seats and a free seat. */
    packageSlug: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/).optional(),
  })
  .strict();
export type InviteBody = z.infer<typeof InviteBody>;

export const BulkInviteBody = z.object({ invitations: z.array(InviteBody).min(1).max(50) }).strict();
export type BulkInviteBody = z.infer<typeof BulkInviteBody>;

const EmailOutcome = z.object({ sent: z.boolean(), reason: z.string().optional(), kind: z.string().optional() });
export const BulkInviteResponse = z.object({
  results: z.array(
    z.object({
      email: z.string(),
      ok: z.boolean(),
      member: z.lazy(() => Member).optional(),
      emailOutcome: EmailOutcome.optional(),
      error: z.object({ code: z.string(), message: z.string() }).optional(),
    }),
  ),
  invited: z.number().int(),
  failed: z.number().int(),
});

export const InviteResponse = z.object({
  member: Member,
  email: EmailOutcome,
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

export const AddDepartmentBody = z.object({ departmentId: z.string().uuid(), primary: z.boolean().optional() }).strict();
export type AddDepartmentBody = z.infer<typeof AddDepartmentBody>;
export const UpdateDepartmentMembershipBody = z.object({ primary: z.literal(true) }).strict();
export type UpdateDepartmentMembershipBody = z.infer<typeof UpdateDepartmentMembershipBody>;

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
  message: z.string().nullable(),
  expiresAt: z.string().nullable(),
  expired: z.boolean(),
  roles: z.array(z.object({ key: z.string(), name: z.string() })),
  departments: z.array(z.string()),
  packageSlug: z.string().nullable(),
  packageName: z.string().nullable(),
});
