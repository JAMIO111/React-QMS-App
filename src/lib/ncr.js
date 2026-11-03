/** Shared definitions for the non-conformance (NCR) module. */

/** URL segment (/Non-Conformance/:type) → API source. */
export const NC_TYPES = {
  Internal: { source: "internal", label: "Internal", one: "internal non-conformance" },
  Customer: { source: "customer", label: "Customer", one: "customer non-conformance" },
  Supplier: { source: "supplier", label: "Supplier", one: "supplier non-conformance" },
};
export const typeFromSource = (source) => Object.keys(NC_TYPES).find((k) => NC_TYPES[k].source === source) ?? "Internal";

/** Fixed stage keys (organisation-editable labels come later, plan decision Q2). */
export const STAGES = [
  { key: "draft", label: "Draft", tone: "bg-border-color text-secondary-text" },
  { key: "open", label: "Open", tone: "bg-info-color/15 text-info-color" },
  { key: "contained", label: "Contained", tone: "bg-warning-color/20 text-primary-text" },
  { key: "investigating", label: "Investigating", tone: "bg-theme/15 text-theme" },
  { key: "dispositioned", label: "Dispositioned", tone: "bg-theme/15 text-theme" },
  { key: "awaiting_closure", label: "Awaiting closure", tone: "bg-warning-color/20 text-primary-text" },
  { key: "closed", label: "Closed", tone: "bg-success-color/15 text-success-color" },
  { key: "cancelled", label: "Cancelled", tone: "bg-border-color text-secondary-text line-through" },
];
export const stageOf = (key) => STAGES.find((s) => s.key === key) ?? STAGES[0];
const FORWARD = ["open", "contained", "investigating", "dispositioned", "awaiting_closure", "closed"];

/** What a stage can move to: { forward: [...], cancel, reopen }. Mirrors the database rules. */
export function nextStages(stage) {
  if (stage === "draft") return { forward: ["open"], cancel: true, reopen: false };
  if (stage === "closed" || stage === "cancelled") return { forward: [], cancel: false, reopen: true };
  const i = FORWARD.indexOf(stage);
  return { forward: FORWARD.slice(i + 1), cancel: true, reopen: false };
}

export const SEVERITIES = [
  { key: "critical", label: "Critical", tone: "bg-error-color/15 text-error-color" },
  { key: "major", label: "Major", tone: "bg-warning-color/20 text-primary-text" },
  { key: "minor", label: "Minor", tone: "bg-border-color text-primary-text" },
];
export const severityOf = (key) => SEVERITIES.find((s) => s.key === key) ?? null;

/** Fields that differ by source. */
export const SOURCE_FIELDS = {
  internal: ["workOrder"],
  customer: ["customerId", "customerReference", "workOrder"],
  supplier: ["supplierId", "purchaseOrder"],
};

/** Readable names for history entries (database column → label). */
export const FIELD_LABELS = {
  stage: "Stage", stage_reason: "Stage reason", severity: "Severity", title: "Title", description: "Description",
  requirement: "Requirement", actual_result: "Actual result", site_id: "Site", part_id: "Part", part_revision_id: "Revision",
  customer_id: "Customer", supplier_id: "Supplier", work_order: "Work order", purchase_order: "Purchase order",
  customer_reference: "Customer reference", lot_number: "Lot", serial_number: "Serial", quantity_affected: "Quantity affected",
  quantity_inspected: "Quantity inspected", detected_at: "Detected on", detected_by: "Detected by",
  detection_process_id: "Where detected", causal_process_id: "Causal process", failure_mode_id: "Failure mode",
  sub_failure_mode_id: "Sub-failure mode", responsible_employee_id: "Responsible operator", owner_id: "Owner",
  closed_at: "Closed at", closed_by: "Closed by", deleted_at: "Deleted", deleted_by: "Deleted by", delete_reason: "Delete reason",
};

export const formatDate = (value) =>
  value ? new Date(value.length === 10 ? `${value}T00:00:00` : value).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";
