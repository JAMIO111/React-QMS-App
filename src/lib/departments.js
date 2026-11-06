/** Roles that cover the whole organisation: a person who only holds these needs no department (docs/documentation-plan.md D7). */
export const ORGANISATION_WIDE_ROLE_KEYS = ["owner", "admin", "quality_manager"];

/** True when the person belongs to no department although their roles are not organisation-wide, so alerts addressed to departments miss them. */
export const isUnassigned = (member) =>
  member.status !== "removed" &&
  (member.departments ?? []).length === 0 &&
  member.roles.some((r) => !ORGANISATION_WIDE_ROLE_KEYS.includes(r.roleKey));
