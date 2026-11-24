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

// ---- Complaints (PT5a) ----
export const COMPLAINT_STATUS = {
  received: { label: "Received", tone: "bg-brand-primary/15 text-brand-primary" },
  in_progress: { label: "In progress", tone: "bg-warning-color/20 text-primary-text" },
  closed: { label: "Closed", tone: "bg-success-color/15 text-success-color" },
  cancelled: { label: "Cancelled", tone: "bg-border-color text-secondary-text" },
};
/** What staff can switch for a customer: whether their people may raise complaints. */
export const CUSTOMER_TILES = [
  { key: "complaints", label: "Allow them to raise complaints" },
  { key: "changes", label: "Allow them to send change requests" },
  { key: "figures", label: "Show them their quality figures" },
];
/** Beside the performance tiles a supplier has one switch of its own: whether its people may notify us of a process change. */
export const SUPPLIER_OPTIONS = [{ key: "changes", label: "Allow them to notify process changes" }];

// ---- Change requests (CH6a) ----
export const CHANGE_REQUEST_STATUS = {
  received: { label: "Received", tone: "bg-brand-primary/15 text-brand-primary" },
  under_review: { label: "Under review", tone: "bg-warning-color/20 text-primary-text" },
  accepted: { label: "Accepted", tone: "bg-success-color/15 text-success-color" },
  done: { label: "Done", tone: "bg-success-color/15 text-success-color" },
  declined: { label: "Declined", tone: "bg-error-color/15 text-error-color" },
  cancelled: { label: "Cancelled", tone: "bg-border-color text-secondary-text" },
};
// ---- A customer approves a change (CH6b) ----
export const CHANGE_APPROVAL_STATUS = {
  pending: { label: "Waiting for your answer", tone: "bg-warning-color/20 text-primary-text" },
  approved: { label: "Approved", tone: "bg-success-color/15 text-success-color" },
  rejected: { label: "Not approved", tone: "bg-error-color/15 text-error-color" },
};
export const changeApprovalPath = (id, organisationId) => `/portal/change-approvals/${id}${organisationId ? `?org=${organisationId}` : ""}`;
/** The words for each kind of party: a customer asks for a change, a supplier tells us about one. */
export const CHANGE_WORDS = {
  customer: {
    menu: "Change requests", heading: "Your change requests", button: "Ask for a change", dialog: "Ask for a change",
    intro: "Ask for a change to a part we make for you. Their engineering and quality teams review every request before anything is decided.",
    title: "What would you like changed", titleHint: "For example: Reduce the bend radius", description: "Describe the change", reason: "Why you want it", wanted: "The date you want it from", send: "Send request",
    empty: "You have not sent any change requests yet.",
  },
  supplier: {
    menu: "Process changes", heading: "Your process change notices", button: "Notify a change", dialog: "Notify a process change",
    intro: "Tell us before you change how something we buy from you is made — a new furnace, a new site, a different material. We review each one before it takes effect.",
    title: "What is changing", titleHint: "For example: Moving the casting to a new furnace", description: "Describe the change", reason: "Why you are making it", wanted: "The date it takes effect",
    send: "Send notice", empty: "You have not notified any process changes yet.",
  },
};

// ---- Closure confirmation (PT5b) ----
export const CLOSURE_STATUS = {
  pending: { label: "Waiting for the customer", tone: "bg-warning-color/20 text-primary-text" },
  confirmed: { label: "Confirmed", tone: "bg-success-color/15 text-success-color" },
  declined: { label: "Not satisfied", tone: "bg-error-color/15 text-error-color" },
  withdrawn: { label: "Withdrawn", tone: "bg-border-color text-secondary-text" },
};

// ---- Evidence on a lot (PT5f) ----
export const EVIDENCE_KINDS = [
  { id: "certificate_of_conformance", name: "Certificate of conformance" },
  { id: "inspection_report", name: "Inspection report" },
  { id: "other", name: "Other" },
];
export const evidenceKindLabel = (id) => EVIDENCE_KINDS.find((k) => k.id === id)?.name ?? id;

// ---- Registers and menu (PT6) ----

/**
 * The portal's side menu for one person's access: only what their kind of party has (a supplier has corrective action requests, a customer has 8Ds,
 * complaints and certificates), and Team for a party admin. `icon` is a key into the icon map in PortalNavbar so this file stays free of components.
 */
export const portalMenu = (access) => {
  const supplier = access?.partyKind === "supplier";
  const customer = access?.partyKind === "customer";
  return [
    { key: "dashboard", name: "Dashboard", icon: "dashboard", path: "/portal", end: true },
    { key: "ncrs", name: "Non-conformances", icon: "ncr", path: "/portal/non-conformances", badge: "ncrs" },
    ...(supplier ? [{ key: "scars", name: "Corrective actions", icon: "scar", path: "/portal/scars", badge: "scars" }] : []),
    ...(customer ? [{ key: "capas", name: "8D reports", icon: "capa", path: "/portal/8ds", badge: "capas" }] : []),
    ...(customer ? [{ key: "complaints", name: "Complaints", icon: "complaint", path: "/portal/complaints" }] : []),
    ...(customer || supplier ? [{ key: "changes", name: CHANGE_WORDS[customer ? "customer" : "supplier"].menu, icon: "change", path: "/portal/change-requests", badge: "changeApprovals" }] : []),
    { key: "documents", name: "Documents and alerts", icon: "document", path: "/portal/documents", badge: "documents" },
    ...(customer ? [{ key: "certificates", name: "Certificates and reports", icon: "certificate", path: "/portal/certificates" }] : []),
    ...(access?.role === "admin" ? [{ key: "team", name: "Team", icon: "team", path: "/portal/team" }] : []),
  ];
};

/** The page's name in the top bar, from its address. */
export const portalPageTitle = (pathname) => {
  const p = pathname.replace(/\/+$/, "");
  if (p === "/portal" || p === "") return "Dashboard";
  if (p.startsWith("/portal/non-conformances") || p.startsWith("/portal/shared")) return "Non-conformances";
  if (p.startsWith("/portal/scars")) return "Corrective actions";
  if (p.startsWith("/portal/8ds")) return "8D reports";
  if (p.startsWith("/portal/complaints")) return "Complaints";
  if (p.startsWith("/portal/change-requests") || p.startsWith("/portal/change-approvals")) return "Change requests";
  if (p.startsWith("/portal/documents")) return "Documents and alerts";
  if (p.startsWith("/portal/certificates")) return "Certificates and reports";
  if (p.startsWith("/portal/team")) return "Team";
  return "Portal";
};

/** The address of a shared non-conformance or 8D from a register row. */
export const registerPath = (kind) => (kind === "scar" ? "/portal/scars" : kind === "capa" ? "/portal/8ds" : kind === "document" ? "/portal/documents" : "/portal/non-conformances");

/** What a shared 8D's stage means to the customer. */
export const CAPA_STAGE = {
  open: { label: "Open", tone: "bg-info-color/15 text-info-color" },
  actions_in_progress: { label: "Actions in progress", tone: "bg-warning-color/20 text-primary-text" },
  awaiting_verification: { label: "Awaiting verification", tone: "bg-warning-color/20 text-primary-text" },
  verified_effective: { label: "Verified effective", tone: "bg-success-color/15 text-success-color" },
  closed: { label: "Closed", tone: "bg-success-color/15 text-success-color" },
  cancelled: { label: "Cancelled", tone: "bg-border-color text-secondary-text" },
};
export const capaStage = (stage) => CAPA_STAGE[stage] ?? { label: stage, tone: "bg-border-color text-secondary-text" };

/** What a shared record is waiting for from the person, in a word (empty when nothing). */
export const waitingFor = (row) => {
  if (row.needsClosure || row.closurePending) return "Confirm closure";
  if (row.needsAcknowledgement) return "Acknowledge";
  if (row.awaitingResponse) return "Respond";
  if (row.openActions > 0) return "Actions to do";
  return "";
};
