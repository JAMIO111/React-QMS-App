/** Shared definitions for the non-conformance (NCR) module. */

/**
 * Where a non-conformance came from (the API's `source`). It is independent of the category (what the problem is).
 * `party` is what the source needs: "customer" (required to open), "supplier" (required) or "supplier?" (optional).
 */
export const NC_SOURCES = [
  { key: "internal", label: "Internal", hint: "An employee identifies a defect" },
  { key: "customer", label: "Customer", hint: "A customer raises a complaint", party: "customer" },
  { key: "supplier", label: "Supplier", hint: "A supplier-side problem is found", party: "supplier" },
  { key: "internal_audit", label: "Internal audit", hint: "An auditor identifies a process failure" },
  { key: "external_audit", label: "External audit", hint: "A certification auditor raises a finding" },
  { key: "production_inspection", label: "Production inspection", hint: "An operator finds an out-of-tolerance dimension" },
  { key: "final_inspection", label: "Final inspection", hint: "Finished product fails inspection" },
  { key: "calibration", label: "Calibration", hint: "A gauge fails calibration" },
  { key: "goods_receiving", label: "Goods receiving", hint: "Incoming material is incorrect", party: "supplier?" },
  { key: "engineering", label: "Engineering", hint: "Engineering finds an incorrect specification" },
  { key: "management_review", label: "Management review", hint: "Management identifies a system issue" },
];
export const sourceOf = (key) => NC_SOURCES.find((s) => s.key === key) ?? null;
export const sourceLabel = (key) => sourceOf(key)?.label ?? (key ? String(key) : "—");
export const SOURCE_OPTIONS = NC_SOURCES.map((s) => ({ id: s.key, name: s.label, hint: s.hint }));

/**
 * Quick tabs above the register and the dashboard: a tab is a source filter, and the three tabs together cover every source exactly once.
 * "Customer" is customer; "Supplier" is supplier and goods receiving; "Internal" is everything found inside the business (employees, audits,
 * inspections, calibration, engineering, management review).
 */
export const NC_TABS = [
  { key: "all", label: "All", source: "" },
  { key: "internal", label: "Internal", source: "internal,internal_audit,external_audit,production_inspection,final_inspection,calibration,engineering,management_review" },
  { key: "customer", label: "Customer", source: "customer" },
  { key: "supplier", label: "Supplier", source: "supplier,goods_receiving" },
];

/** Where a non-conformance lives in the app (`new` opens the form for a new one; `source` preselects its source). */
export const ncrPath = (id, source) => `/Non-Conformance/Register/${id}${source && id === "new" ? `?source=${source}` : ""}`;
export const NCR_REGISTER = "/Non-Conformance/Register";

/** Fixed stage keys (organisation-editable labels come later, plan decision Q2). */
export const STAGES = [
  { key: "draft", label: "Draft", tone: "bg-border-color text-secondary-text" },
  {
    key: "open",
    label: "Open",
    tone: "bg-warning-color/15 text-warning-color",
  },
  {
    key: "contained",
    label: "Contained",
    tone: "bg-purple-500/20 text-purple-500",
  },
  {
    key: "investigating",
    label: "Investigating",
    tone: "bg-info-color/15 text-info-color",
  },
  {
    key: "dispositioned",
    label: "Dispositioned",
    tone: "bg-info-color/15 text-info-color",
  },
  {
    key: "awaiting_closure",
    label: "Awaiting closure",
    tone: "bg-pink-500/15 text-pink-500",
  },
  {
    key: "closed",
    label: "Closed",
    tone: "bg-success-color/15 text-success-color",
  },
  {
    key: "cancelled",
    label: "Cancelled",
    tone: "bg-border-color text-secondary-text line-through",
  },
];
export const stageOf = (key) => STAGES.find((s) => s.key === key) ?? STAGES[0];
const FORWARD = [
  "open",
  "contained",
  "investigating",
  "dispositioned",
  "awaiting_closure",
  "closed",
];

/** What a stage can move to: { forward: [...], cancel, reopen }. Mirrors the database rules. */
export function nextStages(stage) {
  if (stage === "draft")
    return { forward: ["open"], cancel: true, reopen: false };
  if (stage === "closed" || stage === "cancelled")
    return { forward: [], cancel: false, reopen: true };
  const i = FORWARD.indexOf(stage);
  return { forward: FORWARD.slice(i + 1), cancel: true, reopen: false };
}

export const SEVERITIES = [
  {
    key: "critical",
    label: "Critical",
    tone: "bg-error-color/15 text-error-color",
  },
  {
    key: "major",
    label: "Major",
    tone: "bg-warning-color/20 text-primary-text",
  },
  { key: "minor", label: "Minor", tone: "bg-border-color text-primary-text" },
];
export const severityOf = (key) =>
  SEVERITIES.find((s) => s.key === key) ?? null;

/** Fields that differ by source. */
export const SOURCE_FIELDS = {
  customer: ["customerId", "customerReference", "workOrder"],
  supplier: ["supplierId", "purchaseOrder"],
  goods_receiving: ["supplierId", "purchaseOrder"],
};

/** Readable names for history entries (database column → label). */
export const FIELD_LABELS = {
  stage: "Stage",
  stage_reason: "Stage reason",
  severity: "Severity",
  title: "Title",
  description: "Description",
  requirement: "Requirement",
  actual_result: "Actual result",
  site_id: "Site",
  part_id: "Part",
  part_revision_id: "Revision",
  customer_id: "Customer",
  supplier_id: "Supplier",
  work_order: "Work order",
  purchase_order: "Purchase order",
  customer_reference: "Customer reference",
  lot_number: "Lot",
  serial_number: "Serial",
  quantity_affected: "Quantity affected",
  quantity_inspected: "Quantity inspected",
  detected_at: "Detected on",
  detected_by: "Detected by",
  detection_process_id: "Where detected",
  causal_process_id: "Causal process",
  category_id: "Category",
  source: "Source",
  source_change_reason: "Reason for the source",
  failure_mode_id: "Failure mode",
  sub_failure_mode_id: "Sub-failure mode",
  responsible_employee_id: "Responsible operator",
  owner_id: "Owner",
  closed_at: "Closed at",
  closed_by: "Closed by",
  deleted_at: "Deleted",
  deleted_by: "Deleted by",
  delete_reason: "Delete reason",
};

export const formatDate = (value) =>
  value
    ? new Date(
        value.length === 10 ? `${value}T00:00:00` : value,
      ).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "—";
