/** Change management (docs/change-management-plan.md): labels, colours and small rules shared by the screens. */

export const CHANGE_STAGE = {
  draft: { label: "Draft", tone: "neutral" },
  assessment: { label: "Assessment", tone: "info" },
  approval: { label: "Approval", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  implementing: { label: "Implementing", tone: "info" },
  verifying: { label: "Verifying", tone: "info" },
  closed: { label: "Closed", tone: "success" },
  rejected: { label: "Rejected", tone: "error" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};
const TONE_CLASS = {
  success: "bg-success-color/15 text-success-color",
  warning: "bg-warning-color/15 text-warning-color",
  error: "bg-error-color/15 text-error-color",
  info: "bg-brand-primary/15 text-brand-primary",
  neutral: "bg-secondary-bg text-secondary-text",
};
export const stageLabel = (stage) => CHANGE_STAGE[stage]?.label ?? stage;
export const stagePill = (stage) => TONE_CLASS[CHANGE_STAGE[stage]?.tone ?? "neutral"];

/** The register's stage choices; "" is the default, everything still going. */
export const STAGE_OPTIONS = [
  { value: "", label: "In progress" },
  { value: "draft", label: "Draft" },
  { value: "assessment", label: "Assessment" },
  { value: "approval", label: "With the board" },
  { value: "approved", label: "Approved" },
  { value: "closed", label: "Closed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "all", label: "All" },
];

export const URGENCIES = [
  { value: "normal", label: "Normal", hint: "Goes through as usual" },
  { value: "expedited", label: "Expedited", hint: "Shown first and worded as urgent. It is still assessed and approved in full." },
];
export const urgencyLabel = (urgency) => (urgency === "expedited" ? "Expedited" : "Normal");

export const ORIGIN_KINDS = {
  ncr: "Non-conformance",
  capa: "8D",
  audit_finding: "Audit finding",
  risk: "Risk",
  document_change_request: "Document change request",
};
export const originLabel = (kind) => ORIGIN_KINDS[kind] ?? "Record";

export const LINK_KINDS = [
  { value: "part", label: "Part" },
  { value: "part_family", label: "Part family" },
  { value: "machine", label: "Machine" },
  { value: "supplier", label: "Supplier" },
  { value: "customer", label: "Customer" },
  { value: "production_order", label: "Production order" },
  { value: "operation_code", label: "Operation" },
];
export const linkKindLabel = (kind) => LINK_KINDS.find((k) => k.value === kind)?.label ?? kind;

/** The page of a record a change covers or came from, or null when it has none. */
export const recordPath = (kind, id) => {
  if (!id) return null;
  switch (kind) {
    case "ncr":
      return `/Non-Conformance/Register/${id}`;
    case "capa":
      return `/CAPA/${id}`;
    case "audit_finding":
      return `/Audits/Findings/${id}`;
    case "risk":
      return `/Risk/Register/${id}`;
    case "document_change_request":
      return "/Documentation/Change-Requests";
    case "supplier":
      return `/Suppliers/${id}`;
    case "part":
      return `/Parts/${id}`;
    case "part_family":
      return `/Part-Families/${id}`;
    case "machine":
      return "/Machines";
    case "production_order":
      return `/Production/Orders/${id}`;
    default:
      return null;
  }
};
export const linkPath = (link) => (link?.readable ? recordPath(link.kind, link.id) : null);

/** "BR-100 · Bracket", or a plain word when the reader may not see the record. */
export const linkWords = (link) => {
  if (link.kind === "operation_code") return link.code;
  if (!link.readable) return "a record you cannot open";
  return [link.reference, link.name].filter(Boolean).join(" · ") || "Unnamed";
};
export const sameLink = (a, b) => a.kind === b.kind && (a.kind === "operation_code" ? a.code?.toLowerCase() === b.code?.toLowerCase() : a.id === b.id);
/** The body of PUT /changes/{id}/links from the links on screen. */
export const linksBody = (links) => links.map((l) => (l.kind === "operation_code" ? { kind: "operation_code", code: l.code } : { kind: l.kind, id: l.id }));

export const changePath = (id) => `/Change/${id}`;
export const noticePath = (id) => `/Change/${id}/notice`;

/** The steps a change moves through, for the stepper (later stages come with their slices). */
export const STEPS = [
  { stage: "draft", label: "Draft" },
  { stage: "assessment", label: "Assessment" },
  { stage: "approval", label: "Board" },
  { stage: "approved", label: "Approved" },
];
export const stepState = (current, stage) => {
  const order = STEPS.map((s) => s.stage);
  const here = order.indexOf(current);
  const mine = order.indexOf(stage);
  if (here === -1) return "other";
  return mine < here ? "done" : mine === here ? "current" : "todo";
};

export const IMPACT_STATUS = {
  not_assessed: { label: "Not assessed", tone: "neutral" },
  affected: { label: "Affected", tone: "warning" },
  not_affected: { label: "Not affected", tone: "success" },
};
export const IMPACT_OPTIONS = ["not_assessed", "affected", "not_affected"].map((value) => ({ value, label: IMPACT_STATUS[value].label }));
export const impactPill = (status) => TONE_CLASS[IMPACT_STATUS[status]?.tone ?? "neutral"];
export const impactLabel = (status) => IMPACT_STATUS[status]?.label ?? status;

export const SIGNOFF_STATUS = {
  pending: { label: "Waiting", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  rejected: { label: "Sent back", tone: "error" },
  superseded: { label: "Not needed", tone: "neutral" },
};
export const signoffLabel = (status) => SIGNOFF_STATUS[status]?.label ?? status;
export const signoffPill = (status) => TONE_CLASS[SIGNOFF_STATUS[status]?.tone ?? "neutral"];

export const CUSTOMER_APPROVALS = [
  { value: "not_needed", label: "Not needed", hint: "The customer does not have to approve this change" },
  { value: "required", label: "Required", hint: "The customer has to approve it; not asked yet" },
  { value: "requested", label: "Requested", hint: "We have asked them and are waiting" },
  { value: "approved", label: "Approved", hint: "They approved it (give their reference)" },
  { value: "rejected", label: "Rejected", hint: "They said no" },
  { value: "waived", label: "Waived", hint: "Not asked, and why" },
];
export const customerLabel = (status) => CUSTOMER_APPROVALS.find((c) => c.value === status)?.label ?? "Not stated";

export const CUT_IN_KINDS = [
  { value: "none", label: "No fixed point", hint: "It applies from approval, or as the tasks say" },
  { value: "date", label: "From a date" },
  { value: "order", label: "From a production order" },
  { value: "lot", label: "From a lot" },
  { value: "serial", label: "From a serial number" },
];
export const STOCK_ACTIONS = [
  { value: "use_up", label: "Use up what we have" },
  { value: "rework", label: "Rework it" },
  { value: "scrap", label: "Scrap it" },
  { value: "return", label: "Return it" },
];
export const stockLabel = (action) => STOCK_ACTIONS.find((a) => a.value === action)?.label ?? null;
/** The cut-in point in words ("From 1 Dec 2026"), or null when there is none. */
export const cutInWords = (cutIn) => {
  if (!cutIn || cutIn.kind === "none") return null;
  if (cutIn.kind === "date") return `From ${formatDay(cutIn.date)}`;
  if (cutIn.kind === "order") return `From production order ${cutIn.order?.label ?? "(one you cannot open)"}`;
  if (cutIn.kind === "lot") return `From lot ${cutIn.lot?.label ?? "(one you cannot open)"}`;
  return `From serial number ${cutIn.serial?.label ?? "(one you cannot open)"}`;
};

/** What still has to happen before a draft can move on (nothing moves it yet in this slice). */
export const draftProblems = (change) => {
  const out = [];
  if (!change.description) out.push("Say what is changing");
  if (!change.reason) out.push("Say why");
  if (!change.links.length) out.push("Say what it covers (parts, machines, suppliers…)");
  return out;
};

export function formatDay(value) {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
