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

/** What a shared record is called. */
export const SHARE_KIND = { ncr: "Non-conformance", capa: "8D", document: "Document", quality_alert: "Quality alert" };

/** The headline of a shared record: documents have a number and revision, alerts a reference, the rest a reference and stage. */
export const sharedHeading = (kind, r) =>
  kind === "document" ? { code: r.number, title: r.title } : { code: r.reference, title: r.title };
export const shareKindLabel = (kind) => SHARE_KIND[kind] ?? kind;

/** The portal address of one shared record (the organisation goes in the address so a link from an email opens the right portal). */
export const sharedPath = (shareId, organisationId) => `/portal/shared/${shareId}${organisationId ? `?org=${organisationId}` : ""}`;

/** "Not opened yet", "Seen by 2 people, last 3 hours ago" for staff. */
export const viewedWords = (share, now = new Date()) =>
  share.viewers > 0 ? `Seen by ${share.viewers} ${share.viewers === 1 ? "person" : "people"}, last ${lastSeenWords(share.lastViewedAt, now).toLowerCase()}` : "Not opened yet";

/** Dates for the shared record page. */
export const shortDate = (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "");
export const longDateTime = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

/** What a SCAR's status means to the supplier (not our internal words). */
export const SCAR_STATUS = {
  issued: { label: "Needs your response", tone: "warning" },
  acknowledged: { label: "Acknowledged: response due", tone: "warning" },
  response_received: { label: "With us for review", tone: "info" },
  under_review: { label: "Being reviewed", tone: "info" },
  revision_requested: { label: "Revised response needed", tone: "warning" },
  accepted: { label: "Accepted", tone: "success" },
  verifying: { label: "Being checked", tone: "info" },
  closed: { label: "Closed", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};
export const scarStatus = (status) => SCAR_STATUS[status] ?? { label: status, tone: "neutral" };

export const SCAR_SEVERITY = { minor: "Minor", major: "Major", critical: "Critical" };

export const EXTENSION_WORDS = {
  pending: "Waiting for a decision",
  approved: "Agreed",
  rejected: "Not agreed",
  withdrawn: "Taken back",
};

/** The portal address of one SCAR (the organisation goes in the address so a link from an email opens the right portal). */
export const scarPath = (scarId, organisationId) => `/portal/scars/${scarId}${organisationId ? `?org=${organisationId}` : ""}`;

/** "Due 3 Dec 2026", "Overdue since 3 Dec 2026" or nothing, for a SCAR awaiting a response. */
export const dueWords = (scar) => (!scar.responseDueOn || !scar.awaitingResponse ? "" : `${scar.overdue ? "Overdue since" : "Due"} ${shortDate(`${scar.responseDueOn}T12:00:00Z`)}`);

// ---- Performance (PT4) ----
/** The tiles staff can switch on or off for a supplier, in the order they appear. */
export const PERFORMANCE_TILES = [
  { key: "score", label: "Overall score" },
  { key: "delivery", label: "Delivery (on time, in full)" },
  { key: "quality", label: "Quality (PPM, lot rejection)" },
  { key: "ncs", label: "Non-conformances" },
  { key: "scars", label: "Corrective action requests" },
  { key: "certs", label: "Certifications" },
  { key: "trend", label: "Monthly trend" },
  { key: "ranking", label: "Position among suppliers" },
];
/** A tile is on unless staff switched it off. */
export const tileOn = (tiles, key) => tiles?.[key] !== false;
export const RANK_WORDS = {
  top_quarter: "In the top quarter of our suppliers",
  upper_half: "In the upper half of our suppliers",
  lower_half: "In the lower half of our suppliers",
  bottom_quarter: "In the bottom quarter of our suppliers",
};
/** A 0–1 share as a whole percentage, or a dash when there is nothing to measure. */
export const pctWords = (v) => (v === null || v === undefined ? "—" : `${Math.round(Number(v) * 1000) / 10}%`);
