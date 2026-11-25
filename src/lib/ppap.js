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
