/** FMEA (docs/fmea-plan.md): labels, colours and small rules shared by the screens. */
import { formatDay } from "./change";

export { formatDay };

export const FMEA_KINDS = [
  { value: "design", label: "Design FMEA", hint: "What could fail in the product or its design" },
  { value: "process", label: "Process FMEA", hint: "What could fail in how it is made, step by step" },
];
export const kindLabel = (kind) => FMEA_KINDS.find((k) => k.value === kind)?.label ?? kind;

const TONE_CLASS = {
  success: "bg-success-color/15 text-success-color",
  warning: "bg-warning-color/15 text-warning-color",
  error: "bg-error-color/15 text-error-color",
  info: "bg-brand-primary/15 text-brand-primary",
  neutral: "bg-secondary-bg text-secondary-text",
};

export const FMEA_STATUS = {
  draft: { label: "Draft", tone: "neutral" },
  active: { label: "In force", tone: "success" },
  withdrawn: { label: "Withdrawn", tone: "error" },
  discarded: { label: "Discarded", tone: "neutral" },
};
export const statusLabel = (status) => FMEA_STATUS[status]?.label ?? status;
export const statusPill = (status) => TONE_CLASS[FMEA_STATUS[status]?.tone ?? "neutral"];

export const REVISION_STATUS = {
  draft: { label: "Draft", tone: "neutral" },
  pending_approval: { label: "Waiting for approval", tone: "warning" },
  approved: { label: "Approved", tone: "info" },
  effective: { label: "In force", tone: "success" },
  superseded: { label: "Superseded", tone: "neutral" },
  withdrawn: { label: "Withdrawn", tone: "error" },
  discarded: { label: "Discarded", tone: "neutral" },
};
export const revisionStatusLabel = (status) => REVISION_STATUS[status]?.label ?? status;
export const revisionPill = (status) => TONE_CLASS[REVISION_STATUS[status]?.tone ?? "neutral"];

/** "A", or "draft 2" for a revision that has no letter yet. */
export const revisionName = (revision) => (revision.letter ? `rev ${revision.letter}` : `draft ${revision.sequence}`);

/** The register's status choices; "" is the default (drafts and those in force). */
export const STATUS_OPTIONS = [
  { value: "", label: "Live" },
  { value: "draft", label: "Draft" },
  { value: "active", label: "In force" },
  { value: "withdrawn", label: "Withdrawn" },
  { value: "all", label: "All" },
];

export const TEAM_ROLES = [
  { value: "lead", label: "Team lead" },
  { value: "design", label: "Design" },
  { value: "process", label: "Process engineering" },
  { value: "quality", label: "Quality" },
  { value: "manufacturing", label: "Manufacturing" },
  { value: "purchasing", label: "Purchasing" },
  { value: "supplier", label: "Supplier" },
  { value: "customer", label: "Customer" },
  { value: "other", label: "Other" },
];
export const roleLabel = (role) => TEAM_ROLES.find((r) => r.value === role)?.label ?? role;

export const LINK_KINDS = [
  { value: "part", label: "Part" },
  { value: "part_family", label: "Part family" },
  { value: "control_plan", label: "Control plan" },
  { value: "machine", label: "Machine" },
  { value: "supplier", label: "Supplier" },
  { value: "customer", label: "Customer" },
  { value: "operation_code", label: "Operation" },
];
export const linkKindLabel = (kind) => LINK_KINDS.find((k) => k.value === kind)?.label ?? kind;

/** The page of a record an FMEA covers, or null when it has none. */
export const linkPath = (link) => {
  if (!link?.readable || !link.id) return null;
  switch (link.kind) {
    case "part":
      return `/Parts/${link.id}`;
    case "part_family":
      return `/Part-Families/${link.id}`;
    case "control_plan":
      return `/Process-Control/Plans/${link.id}`;
    case "machine":
      return "/Machines";
    case "supplier":
      return `/Suppliers/${link.id}`;
    case "customer":
      return "/Customers";
    default:
      return null;
  }
};

/** "BR-100 · Bracket", or a plain word when the reader may not see the record. */
export const linkWords = (link) => {
  if (link.kind === "operation_code") return link.code;
  if (!link.readable) return "a record you cannot open";
  return [link.reference, link.name].filter(Boolean).join(" · ") || "Unnamed";
};
export const sameLink = (a, b) => a.kind === b.kind && (a.kind === "operation_code" ? a.code?.toLowerCase() === b.code?.toLowerCase() : a.id === b.id);
/** The body of PUT /fmea-revisions/{id}/links from the links on screen. */
export const linksBody = (links) => links.map((l) => (l.kind === "operation_code" ? { kind: "operation_code", code: l.code } : { kind: l.kind, id: l.id }));

/** A team member as the picker names them: members and employees are told apart by a prefix. */
export const personValue = (member) => `${member.kind === "employee" ? "e" : "u"}:${member.personId}`;
export const teamBody = (rows) => rows.map((r) => (r.person.startsWith("e:") ? { employeeId: r.person.slice(2), role: r.role } : { userId: r.person.slice(2), role: r.role }));
/** Why a team cannot be saved yet, or null. */
export const teamProblem = (rows) => {
  if (rows.some((r) => !r.person)) return "Choose a person for every row";
  if (new Set(rows.map((r) => r.person)).size !== rows.length) return "A person can be on the team once";
  if (rows.filter((r) => r.role === "lead").length > 1) return "There is one team lead";
  return null;
};

export const fmeaPath = (id) => `/FMEA/${id}`;
export const revisionPath = (fmeaId, revisionId) => `/FMEA/${fmeaId}/revisions/${revisionId}`;
