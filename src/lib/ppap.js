/** PPAP (docs/ppap-plan.md): labels, colours and small rules shared by the screens. */
import { formatDay } from "./change";

export { formatDay };

const TONE_CLASS = {
  success: "bg-success-color/15 text-success-color",
  warning: "bg-warning-color/15 text-warning-color",
  error: "bg-error-color/15 text-error-color",
  info: "bg-brand-primary/15 text-brand-primary",
  neutral: "bg-secondary-bg text-secondary-text",
};

/** The 18 elements, in order (the API sends each with its own label; this is for the settings screen and the words around it). */
export const ELEMENTS = [
  ["design_records", "Design records"],
  ["engineering_change_documents", "Engineering change documents"],
  ["customer_engineering_approval", "Customer engineering approval"],
  ["dfmea", "Design FMEA"],
  ["process_flow_diagram", "Process flow diagram"],
  ["pfmea", "Process FMEA"],
  ["control_plan", "Control plan"],
  ["msa_studies", "Measurement system studies"],
  ["dimensional_results", "Dimensional results"],
  ["material_performance_tests", "Material and performance test results"],
  ["initial_process_studies", "Initial process studies"],
  ["laboratory_documentation", "Qualified laboratory documentation"],
  ["appearance_approval_report", "Appearance approval report"],
  ["sample_production_parts", "Sample production parts"],
  ["master_sample", "Master sample"],
  ["checking_aids", "Checking aids"],
  ["customer_specific_requirements", "Customer-specific requirements"],
  ["part_submission_warrant", "Part Submission Warrant"],
].map(([key, label]) => ({ key, label }));
export const elementLabel = (key) => ELEMENTS.find((e) => e.key === key)?.label ?? key;

export const PPAP_STATUS = {
  draft: { label: "Draft", tone: "neutral" },
  in_preparation: { label: "In preparation", tone: "info" },
  ready: { label: "Ready to send", tone: "warning" },
  submitted: { label: "Submitted", tone: "info" },
  approved: { label: "Approved", tone: "success" },
  interim_approved: { label: "Interim approval", tone: "warning" },
  rejected: { label: "Rejected", tone: "error" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
};
export const statusLabel = (status) => PPAP_STATUS[status]?.label ?? status;
export const statusPill = (status) => TONE_CLASS[PPAP_STATUS[status]?.tone ?? "neutral"];

export const REASONS = [
  { value: "new_part", label: "New part" },
  { value: "engineering_change", label: "Engineering change" },
  { value: "tooling", label: "Tooling" },
  { value: "discrepancy_correction", label: "Correction of a discrepancy" },
  { value: "alternate_material_or_supplier", label: "Alternate material or supplier" },
  { value: "process_change", label: "Process change" },
  { value: "not_produced_12_months", label: "Not produced for 12 months" },
  { value: "customer_request", label: "Customer request" },
  { value: "other", label: "Other" },
];
export const reasonLabel = (value) => REASONS.find((r) => r.value === value)?.label ?? value;

export const LEVELS = [1, 2, 3, 4, 5];
export const levelLabel = (level) => `Level ${level}`;

export const REQUIREMENT = {
  required: { label: "Required", tone: "info" },
  retain: { label: "Keep, do not send", tone: "neutral" },
  not_required: { label: "Not required", tone: "neutral" },
  n_a: { label: "Not applicable", tone: "neutral" },
};
export const requirementLabel = (value) => REQUIREMENT[value]?.label ?? value;
export const REQUIREMENT_OPTIONS = Object.entries(REQUIREMENT).map(([value, v]) => ({ value, label: v.label }));

export const ELEMENT_STATUS = {
  not_started: { label: "Not started", tone: "neutral" },
  in_progress: { label: "In progress", tone: "info" },
  ready: { label: "Ready", tone: "success" },
  waived: { label: "Waived", tone: "warning" },
};
export const elementStatusLabel = (value) => ELEMENT_STATUS[value]?.label ?? value;
export const elementStatusPill = (value) => TONE_CLASS[ELEMENT_STATUS[value]?.tone ?? "neutral"];

/** What the matrix says for an element at a level, in words. */
export const CELL = { submit: "Send", retain: "Keep", none: "Not needed" };
export const CELL_OPTIONS = Object.entries(CELL).map(([value, label]) => ({ value, label }));

export const ppapPath = (id) => `/PPAP/${id}`;

export const progressWords = ({ required, done }) => (required === 0 ? "Nothing required" : `${done} of ${required} required elements`);
export const progressPercent = ({ required, done }) => (required === 0 ? 100 : Math.round((done / required) * 100));

export const fileSizeLabel = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`);

/** The register's saved filters: the scope, and each filter in words. */
export const PPAP_SCOPE = "ppap_register";
export const PPAP_FILTER_TITLES = { status: "Status", level: "Level", reason: "Reason", owner: "Owner", customer: "Customer", part: "Part", search: "Search" };
export const describePpapFilter = (filters = {}) =>
  Object.keys(PPAP_FILTER_TITLES)
    .filter((k) => filters[k] !== undefined && String(filters[k]) !== "")
    .map((k) => {
      const label = (v) =>
        k === "status" ? (v === "all" ? "All" : statusLabel(v)) : k === "level" ? levelLabel(v) : k === "reason" ? reasonLabel(v) : k === "owner" ? "Mine" : k === "customer" ? (filters.customerLabel || v) : k === "part" ? (filters.partLabel || v) : v;
      return { key: k, title: PPAP_FILTER_TITLES[k], value: String(filters[k]).split(",").map(label).join(", ") };
    });

/** The matrix as rows for the settings screen: one per element with its five levels. */
export const matrixRows = (config) => ELEMENTS.map((e) => ({ ...e, levels: LEVELS.map((l) => config?.rows?.[e.key]?.[String(l)] ?? "none") }));
/** How many elements each level sends, for the one-line summary above the matrix. */
export const levelSummary = (config) => LEVELS.map((l) => ({ level: l, send: ELEMENTS.filter((e) => config?.rows?.[e.key]?.[String(l)] === "submit").length }));

/** The note under the minimums: what each is used for (the studies arrive with a later slice, so say so). */
export const MINIMUMS = [
  { key: "minCpkInitial", label: "Smallest acceptable Cpk, initial studies", step: "0.01" },
  { key: "minCpkOngoing", label: "Smallest acceptable Cpk, ongoing", step: "0.01" },
  { key: "minReadings", label: "Fewest readings for a study", step: "1" },
  { key: "maxGrrPercent", label: "Largest acceptable gauge R&R (%)", step: "1" },
];

/** Which records can be evidence for which element, and their words (a mirror of app.ppap_link_kinds; ppap.e2e-spec.ts compares the API's copy with the database). */
export const ELEMENT_LINK_KINDS = {
  design_records: ["part_revision", "document_revision"],
  engineering_change_documents: ["change_request", "document_revision"],
  customer_engineering_approval: ["change_request"],
  dfmea: ["fmea_revision"],
  process_flow_diagram: ["control_plan_revision", "document_revision"],
  pfmea: ["fmea_revision"],
  control_plan: ["control_plan_revision"],
  msa_studies: ["msa_study"],
  dimensional_results: ["inspection"],
  material_performance_tests: ["material_certificate", "document_revision"],
  initial_process_studies: ["plan_characteristic"],
  laboratory_documentation: ["calibration", "document_revision"],
  appearance_approval_report: ["document_revision"],
  sample_production_parts: ["document_revision"],
  master_sample: ["document_revision"],
  checking_aids: ["gauge", "document_revision"],
  customer_specific_requirements: ["document_revision"],
  part_submission_warrant: [],
};
export const LINK_KIND_LABEL = {
  part_revision: "part revision",
  control_plan_revision: "control plan revision",
  fmea_revision: "FMEA revision",
  change_request: "change",
  inspection: "inspection",
  msa_study: "gauge R&R study",
  material_certificate: "material certificate",
  calibration: "calibration",
  document_revision: "document",
  gauge: "gauge",
  plan_characteristic: "control plan characteristic",
};
export const linkKindsFor = (elementKey) => ELEMENT_LINK_KINDS[elementKey] ?? [];
export const linkKindLabel = (kind) => LINK_KIND_LABEL[kind] ?? kind;

/** What to call a piece of evidence: a file's name, or the record it links to (as it is now, else as it was when frozen). */
export const evidenceName = (v) => (v.kind === "link" ? (v.link?.state?.label ?? v.link?.frozenLabel ?? "A linked record") : (v.fileName ?? "A file"));

/**
 * How a link stands, in words and a tone: not available to this person, not in good standing (with why), a study that does not meet its minimum, or fine. A record the person
 * cannot read is never shown as passing.
 */
export const linkVerdict = (link) => {
  const state = link?.state;
  if (!state) return { tone: "neutral", words: "Its state could not be read" };
  if (!state.available) return { tone: "neutral", words: "You are not allowed to read this record, so its state is not shown to you" };
  if (!state.ok) return { tone: "error", words: state.problem ? `It ${state.problem}` : "It is not in good standing" };
  if (link.study && !link.study.ok) return { tone: "error", words: `It ${link.study.problem}` };
  return { tone: "success", words: state.status ? `In good standing (${String(state.status).replace(/_/g, " ")})` : "In good standing" };
};
export const verdictPill = (tone) => TONE_CLASS[tone === "error" ? "error" : tone === "success" ? "success" : "neutral"];

// ---- the warrant, submitting and the customer's decision (PP3) ----------------------------------------------------

export const DECISION_KIND = {
  submitted: { label: "Sent to the customer", tone: "info" },
  approved: { label: "Approved", tone: "success" },
  interim_approved: { label: "Interim approval", tone: "warning" },
  rejected: { label: "Rejected", tone: "error" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
};
export const decisionLabel = (kind, direction) => (kind === "submitted" && direction === "received" ? "Received from the supplier" : (DECISION_KIND[kind]?.label ?? kind));
/** The party a submission is with, in words: the customer it goes to, or the supplier it came from. */
export const partyOf = (ppap) => (ppap?.direction === "received" ? ppap.supplier : ppap?.customer);
export const decisionPill = (kind) => TONE_CLASS[DECISION_KIND[kind]?.tone ?? "neutral"];
/** What the customer can decide (the sending and a withdrawal are recorded by their own buttons). */
export const DECISION_CHOICES = [
  { value: "approved", label: "Approved" },
  { value: "interim_approved", label: "Interim approval" },
  { value: "rejected", label: "Rejected" },
];
export const WEIGHT_UNITS = ["kg", "g", "lb", "oz"].map((u) => ({ value: u, label: u }));
export const RESULTS_CHOICES = [
  { value: "yes", label: "Yes: the results meet all the requirements" },
  { value: "no", label: "No: some do not" },
];
export const pswPath = (id) => `/PPAP/${id}/psw`;

/** The interim approval's standing in words (worked out on read: a date that has passed is shown, never stored), or null for any other status. */
export const interimWords = (ppap) => {
  if (ppap?.status !== "interim_approved" || !ppap.interimExpiresOn) return null;
  return ppap.interimExpired ? `The interim approval ran out on ${formatDay(ppap.interimExpiresOn)}. Record the customer's decision.` : `The interim approval runs to ${formatDay(ppap.interimExpiresOn)}.`;
};
/** When an approved submission is next reviewed, in words, or null. */
export const reviewWords = (ppap) => {
  if (ppap?.status !== "approved" || !ppap.nextReviewOn) return null;
  return ppap.reviewOverdue ? `The review was due on ${formatDay(ppap.nextReviewOn)}.` : `Next review: ${formatDay(ppap.nextReviewOn)}.`;
};
/** The words about the latest decision of a kind, for the callout at the top of a sent submission. */
export const lastDecision = (ppap, ...kinds) => [...(ppap?.decisions ?? [])].reverse().find((d) => kinds.includes(d.kind)) ?? null;
/** The answers a person can take to be "results meet requirements": yes, no, or not answered. */
export const resultsValue = (v) => (v === true ? "yes" : v === false ? "no" : "");

/** The state of a supplier's part approval package for one part, as the supplier profile shows it (information only: it never changes the supplier's status). */
export const SUPPLIER_PPAP_STATE = {
  approved: { label: "Approved", tone: "success" },
  interim: { label: "Interim approval", tone: "warning" },
  interim_lapsed: { label: "Interim approval has run out", tone: "error" },
  rejected: { label: "Rejected", tone: "error" },
  submitted: { label: "Waiting for our decision", tone: "info" },
  in_preparation: { label: "In preparation", tone: "info" },
};
export const supplierPpapLabel = (state) => SUPPLIER_PPAP_STATE[state]?.label ?? state;
export const supplierPpapPill = (state) => TONE_CLASS[SUPPLIER_PPAP_STATE[state]?.tone ?? "neutral"];
