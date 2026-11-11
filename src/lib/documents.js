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

/** What still stops a draft being ready for review (shown on the revision page; submitting arrives in DC2). */
export const draftProblems = (revision) => {
  if (!revision || revision.status !== "draft") return [];
  const problems = [];
  if (revision.document.contentKind === "text") {
    const hasText = JSON.stringify(revision.body ?? {}).includes('"text":"');
    if (!hasText) problems.push("Write the document's text");
  } else if (!revision.files.some((f) => f.role === "main" && !f.deletedAt)) {
    problems.push("Upload the main file");
  }
  if (revision.sequence > 1 && !revision.changeSummary) problems.push("Say what changed and why");
  return problems;
};

/** An empty editor document. */
export const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };
