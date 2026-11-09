/** Shared definitions for supplier corrective action requests (SCARs). */

export const SCAR_STATUSES = [
  { key: "draft", label: "Draft", tone: "bg-border-color text-primary-text" },
  { key: "issued", label: "Issued", tone: "bg-info-color/15 text-info-color" },
  { key: "acknowledged", label: "Acknowledged", tone: "bg-info-color/15 text-info-color" },
  { key: "response_received", label: "Response received", tone: "bg-warning-color/20 text-primary-text" },
  { key: "under_review", label: "Under review", tone: "bg-warning-color/20 text-primary-text" },
  { key: "revision_requested", label: "Revision requested", tone: "bg-error-color/15 text-error-color" },
  { key: "accepted", label: "Accepted", tone: "bg-success-color/15 text-success-color" },
  { key: "verifying", label: "Verifying effectiveness", tone: "bg-warning-color/20 text-primary-text" },
  { key: "closed", label: "Closed", tone: "bg-success-color/25 text-success-color" },
  { key: "cancelled", label: "Cancelled", tone: "bg-border-color text-secondary-text" },
];
export const scarStatusOf = (key) => SCAR_STATUSES.find((s) => s.key === key) ?? SCAR_STATUSES[0];

export const SCAR_SEVERITIES = [
  { key: "critical", label: "Critical", tone: "bg-error-color/15 text-error-color" },
  { key: "major", label: "Major", tone: "bg-warning-color/20 text-primary-text" },
  { key: "minor", label: "Minor", tone: "bg-border-color text-primary-text" },
];
export const scarSeverityOf = (key) => SCAR_SEVERITIES.find((s) => s.key === key) ?? null;

/** The stages a SCAR passes through, kept apart: what was asked, what the supplier said, what we decided, what was done, whether it worked. */
export const SCAR_STAGES = [
  { key: "issue", label: "Issued", statuses: ["draft"] },
  { key: "response", label: "Supplier response", statuses: ["issued", "acknowledged", "revision_requested"] },
  { key: "review", label: "Internal review", statuses: ["response_received", "under_review"] },
  { key: "implementation", label: "Implementation", statuses: ["accepted"] },
  { key: "verification", label: "Effectiveness check", statuses: ["verifying"] },
];

/** Which stage a SCAR is at: an index into SCAR_STAGES, or SCAR_STAGES.length once closed. Cancelled SCARs have none (-1). */
export const scarStageIndex = (status) => {
  if (status === "closed") return SCAR_STAGES.length;
  if (status === "cancelled") return -1;
  return SCAR_STAGES.findIndex((s) => s.statuses.includes(status));
};

export const scarIsRunning = (status) => status !== "closed" && status !== "cancelled";
/** Statuses in which the supplier's response is awaited (so a past due date is overdue). */
export const AWAITING_RESPONSE = ["issued", "acknowledged", "revision_requested"];

export const SCAR_FILTERS = [
  { value: "running", label: "Running" },
  { value: "overdue", label: "Overdue" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];
/** The API query a register filter stands for. */
export const scarFilterQuery = (filter) => {
  if (filter === "overdue") return { status: "running", overdue: "true" };
  if (filter === "closed") return { status: "closed,cancelled" };
  if (filter === "all") return { status: "all" };
  return { status: "running" };
};

export const ROOT_CAUSE_METHODS = [
  { value: "five_whys", label: "5 Whys" },
  { value: "fishbone", label: "Fishbone (Ishikawa)" },
  { value: "other", label: "Another method" },
];
export const rootCauseMethodLabel = (v) => ROOT_CAUSE_METHODS.find((m) => m.value === v)?.label ?? null;

export const EXTENSION_STATUS = {
  pending: { label: "Waiting for a decision", tone: "bg-warning-color/20 text-primary-text" },
  approved: { label: "Approved", tone: "bg-success-color/15 text-success-color" },
  rejected: { label: "Rejected", tone: "bg-error-color/15 text-error-color" },
  withdrawn: { label: "Withdrawn", tone: "bg-border-color text-secondary-text" },
};

export const scarPath = (id) => `/Supplier-Quality/SCARs/${id}`;
export const SCAR_REGISTER = "/Supplier-Quality/SCARs";

/** A new request key, sent with a create so a retried request returns the same SCAR. */
export const newClientKey = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
