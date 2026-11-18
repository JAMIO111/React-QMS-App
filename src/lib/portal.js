// The supplier and customer portal (docs/external-portal-plan.md): words and small helpers shared by the staff settings page and the portal itself.

export const PORTAL_PATH = "/portal";

/** "supplier" -> "Supplier", for headings and chips. */
export const partyKindLabel = (kind) => (kind === "customer" ? "Customer" : "Supplier");

/** What a person's access is called. */
export const ACCESS_STATUS = {
  invited: { label: "Invited", tone: "warning" },
  active: { label: "Active", tone: "success" },
  suspended: { label: "Suspended", tone: "error" },
  removed: { label: "Removed", tone: "neutral" },
};

export const accessStatus = (status) => ACCESS_STATUS[status] ?? { label: status, tone: "neutral" };

export const ROLE_LABEL = { admin: "Admin", member: "Member" };

/** Who the invitation was for, in one line: "Sam Smith (sam@acme.test)" or just the address. */
export const personLine = (person) => (person.name ? `${person.name} (${person.email})` : person.email);

/** "Never" or a short date and time, for last sign-in. */
export const lastSeenWords = (iso, now = new Date()) => {
  if (!iso) return "Never";
  const then = new Date(iso);
  const minutes = Math.floor((now - then) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days} day${days === 1 ? "" : "s"} ago`;
  return then.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};

/** The access in `portal` (from /me or /portal/me) for an organisation, or the first one. */
export const accessFor = (portal = [], organisationId) => portal.find((a) => a.organisationId === organisationId) ?? portal[0] ?? null;

/** The organisation the portal is open in is kept per browser tab, so a refresh stays where the person was. */
const KEY = "fortress.portal.organisation";
export const rememberPortalOrganisation = (organisationId) => {
  try {
    sessionStorage.setItem(KEY, organisationId);
  } catch {
    /* storage may be unavailable; the first access is used */
  }
};
export const rememberedPortalOrganisation = () => {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
};
