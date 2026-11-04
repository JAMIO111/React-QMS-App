/** Gauge statuses, calibration outcomes and due states, with labels and pill tones. */
export const GAUGE_STATUSES = [
  { key: "active", label: "Active", tone: "bg-success-color/15 text-success-color" },
  { key: "in_calibration", label: "In calibration", tone: "bg-info-color/15 text-info-color" },
  { key: "quarantined", label: "Quarantined", tone: "bg-error-color/15 text-error-color" },
  { key: "out_of_service", label: "Out of service", tone: "bg-warning-color/20 text-primary-text" },
  { key: "retired", label: "Retired", tone: "bg-border-color text-secondary-text" },
  { key: "lost", label: "Lost", tone: "bg-border-color text-secondary-text line-through" },
];
export const statusOf = (key) => GAUGE_STATUSES.find((s) => s.key === key) ?? GAUGE_STATUSES[0];

export const OUTCOMES = [
  { key: "pass", label: "Pass", tone: "bg-success-color/15 text-success-color", help: "Every reading in tolerance as found" },
  { key: "adjusted", label: "Adjusted", tone: "bg-warning-color/20 text-primary-text", help: "Out as found, in tolerance after adjustment" },
  { key: "fail", label: "Fail", tone: "bg-error-color/15 text-error-color", help: "Out of tolerance" },
];
export const outcomeOf = (key) => OUTCOMES.find((o) => o.key === key) ?? null;

/** Only active and in-calibration gauges are "in use" and count towards due dates. */
export const DUE_STATES = {
  overdue: { label: "Overdue", tone: "bg-error-color/15 text-error-color" },
  due_soon: { label: "Due soon", tone: "bg-warning-color/20 text-primary-text" },
  ok: { label: "In date", tone: "bg-success-color/15 text-success-color" },
  not_set: { label: "No due date", tone: "bg-border-color text-secondary-text" },
  not_in_use: { label: "Not in use", tone: "bg-border-color text-secondary-text" },
};
export const DUE_FILTERS = [
  { key: "overdue", label: "Overdue" },
  { key: "due_30", label: "Due in 30 days" },
  { key: "due_90", label: "Due in 90 days" },
  { key: "not_set", label: "No due date" },
];

export const INTERVAL_UNITS = [
  { id: "days", name: "Days" },
  { id: "weeks", name: "Weeks" },
  { id: "months", name: "Months" },
  { id: "years", name: "Years" },
];
/** "6 months", "1 year". */
export const formatInterval = (value, unit) => {
  if (!value || !unit) return "—";
  const one = unit.replace(/s$/, "");
  return `${value} ${value === 1 ? one : unit}`;
};

/** A number as entered: no float noise (0.1 + 0.2), no forced decimals. */
export const formatNumber = (n) => (n === null || n === undefined || n === "" ? "—" : String(Number(Number(n).toPrecision(12))));

/** "25 ±0.02 mm" or "25 +0.03/−0.01 mm". */
export const formatTolerance = ({ kind, nominal, toleranceMinus, tolerancePlus, unitCode }) => {
  if (kind === "attribute") return "Pass / fail";
  const tol = Number(toleranceMinus) === Number(tolerancePlus) ? `±${formatNumber(tolerancePlus)}` : `+${formatNumber(tolerancePlus)}/−${formatNumber(toleranceMinus)}`;
  return `${formatNumber(nominal)} ${tol} ${unitCode}`;
};

/** In tolerance (limits inclusive)? undefined while nothing is entered. */
export const inTolerance = (value, { nominal, toleranceMinus, tolerancePlus }) => {
  if (value === "" || value === null || value === undefined || Number.isNaN(Number(value))) return undefined;
  const v = Number(value);
  // Compare at a fixed precision so 25.02 is not "out" because of floating point.
  const round = (x) => Math.round(x * 1e9) / 1e9;
  return round(v) >= round(Number(nominal) - Number(toleranceMinus)) && round(v) <= round(Number(nominal) + Number(tolerancePlus));
};

/** Outcome the server will work out from readings: pass, adjusted or fail (null without readings). */
export const outcomeFromReadings = (readings) => {
  const judged = readings.filter((r) => r.asFoundOk !== undefined);
  if (!judged.length) return null;
  if (judged.every((r) => r.asFoundOk)) return "pass";
  if (judged.every((r) => r.asFoundOk || r.asLeftOk)) return "adjusted";
  return "fail";
};

/** "in 12 days", "3 days overdue", "due today". */
export const describeDue = (days) => {
  if (days === null || days === undefined) return "";
  if (days === 0) return "Due today";
  if (days < 0) return `${-days} ${days === -1 ? "day" : "days"} overdue`;
  return `In ${days} ${days === 1 ? "day" : "days"}`;
};

/** Gauge columns as named in the history (audit trail). */
export const CHARACTERISTIC_KINDS = [
  { id: "variable", name: "Measured", hint: "A value against nominal ± tolerance" },
  { id: "attribute", name: "Pass / fail", hint: "A check, e.g. free from damage, valid certificate" },
];

export const GAUGE_FIELD_LABELS = {
  kind: "Type of check",
  asset_number: "Asset number",
  description: "Description",
  gauge_type_id: "Type",
  manufacturer: "Manufacturer",
  model: "Model",
  serial_number: "Serial number",
  site_id: "Site",
  department_id: "Department",
  location: "Location",
  custodian_id: "Custodian",
  range_min: "Range from",
  range_max: "Range to",
  unit_code: "Unit",
  resolution: "Resolution",
  calibration_source: "Calibrated",
  supplier_id: "Calibration supplier",
  interval_value: "Interval",
  interval_unit: "Interval unit",
  status: "Status",
  status_reason: "Status reason",
  status_changed_at: "Status changed",
  last_calibrated_on: "Last calibrated",
  next_due_on: "Next due",
  commissioned_on: "Commissioned",
  notes: "Notes",
  deleted_at: "Deleted",
  delete_reason: "Reason for deleting",
  name: "Name",
  nominal: "Nominal",
  tolerance_minus: "Tolerance −",
  tolerance_plus: "Tolerance +",
  method: "Method",
  active: "Active",
  sort_order: "Order",
};
