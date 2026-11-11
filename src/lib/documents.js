/** Document control: labels and small helpers shared by the register, the document and revision pages and the settings tab. */

export const CONTENT_KINDS = [
  { value: "text", label: "Written here", hint: "Text written in Fortress's editor" },
  { value: "file", label: "A file", hint: "A Word, PDF or Excel file, with optional attachments" },
];
export const contentKindLabel = (kind) => CONTENT_KINDS.find((k) => k.value === kind)?.label ?? kind;

const TONE_CLASS = {
  success: "bg-success-color/15 text-success-color",
  warning: "bg-warning-color/15 text-warning-color",
  info: "bg-brand-primary/15 text-brand-primary",
  error: "bg-error-color/15 text-error-color",
  neutral: "bg-secondary-bg text-secondary-text",
};

export const DOCUMENT_STATUS = {
  draft: { label: "Not yet issued", tone: "warning" },
  active: { label: "In force", tone: "success" },
  withdrawn: { label: "Withdrawn", tone: "error" },
  discarded: { label: "Discarded", tone: "neutral" },
};
export const REVISION_STATUS = {
  draft: { label: "Draft", tone: "warning" },
  in_review: { label: "In review", tone: "info" },
  awaiting_approval: { label: "Awaiting approval", tone: "info" },
  approved: { label: "Approved", tone: "info" },
  effective: { label: "Effective", tone: "success" },
  superseded: { label: "Superseded", tone: "neutral" },
  withdrawn: { label: "Withdrawn", tone: "error" },
  discarded: { label: "Discarded", tone: "neutral" },
};
export const statusLabel = (table, status) => table[status]?.label ?? status;
export const statusPill = (table, status) => TONE_CLASS[table[status]?.tone ?? "neutral"];

export const DOCUMENT_STATUS_OPTIONS = [
  { value: "", label: "All" },
  { value: "draft", label: "Not yet issued" },
  { value: "active", label: "In force" },
  { value: "withdrawn", label: "Withdrawn" },
  { value: "discarded", label: "Discarded" },
];

/** "Rev B", or "Draft (will be rev C)" while it has no letter yet. */
export const revisionLabel = (revision, plannedLetter) => {
  if (revision.letter) return `Rev ${revision.letter}`;
  if (revision.status === "discarded") return `Draft ${revision.sequence} (discarded)`;
  return plannedLetter ? `Draft (will be rev ${plannedLetter})` : "Draft";
};

export const documentPath = (id) => `/Documentation/Documents/${id}`;
export const revisionPath = (documentId, revisionId) => `/Documentation/Documents/${documentId}/revisions/${revisionId}`;

/** A type's prefix as typed: capitals, digits and hyphens, at most 10. */
export const cleanPrefix = (value) => (value ?? "").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 10);
export const prefixProblem = (prefix) => (!prefix ? "Give a prefix" : /^[A-Z0-9][A-Z0-9-]{0,9}$/.test(prefix) ? null : "Start with a letter or a digit");

export const SIGNOFF_DECISION = {
  pending: { label: "Waiting", tone: "warning" },
  accepted: { label: "Accepted", tone: "success" },
  approved: { label: "Approved", tone: "success" },
  returned: { label: "Sent back", tone: "error" },
  closed: { label: "Not needed", tone: "neutral" },
};

/** "11 Nov 2026" from an ISO date or timestamp. */
export const formatDay = (value) => {
  if (!value) return "—";
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};

export const CHANGE_REQUEST_STATUS = {
  open: { label: "Open", tone: "warning" },
  accepted: { label: "Accepted", tone: "success" },
  declined: { label: "Declined", tone: "error" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
};

export const LINK_KIND = { part: "Part", part_family: "Part family", machine: "Machine", operation: "Operation" };
/** A link as the API body takes it. */
export const linkBody = (l) =>
  l.kind === "part" ? { partId: l.refId } : l.kind === "part_family" ? { partFamilyId: l.refId } : l.kind === "machine" ? { machineId: l.refId } : { operationCode: l.refId };

/** An empty editor document. */
export const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };
