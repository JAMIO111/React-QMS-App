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
