import { ncrPath } from "./ncr";
/** Display helpers for quality alerts (docs/documentation-plan.md). Severity and status are always words and icons, never colour alone. */
export const CATEGORIES = [
  { value: "product", label: "Product" },
  { value: "process", label: "Process" },
  { value: "supplier", label: "Supplier" },
  { value: "equipment", label: "Equipment" },
  { value: "safety", label: "Safety" },
];
export const SEVERITIES = [
  { value: "low", label: "Low", className: "bg-border-color text-primary-text" },
  { value: "medium", label: "Medium", className: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  { value: "high", label: "High", className: "bg-orange-500/20 text-orange-700 dark:text-orange-300" },
  { value: "critical", label: "Critical", className: "bg-error-color/15 text-error-color" },
];
export const STATUSES = [
  { value: "draft", label: "Draft", className: "bg-border-color text-secondary-text" },
  { value: "active", label: "Active", className: "bg-success-color/15 text-success-color" },
  { value: "expired", label: "Expired", className: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  { value: "withdrawn", label: "Withdrawn", className: "bg-error-color/15 text-error-color" },
  { value: "superseded", label: "Superseded", className: "bg-border-color text-secondary-text" },
];
export const categoryLabel = (v) => CATEGORIES.find((c) => c.value === v)?.label ?? v;
export const severityOf = (v) => SEVERITIES.find((s) => s.value === v) ?? SEVERITIES[0];
export const statusOf = (v) => STATUSES.find((s) => s.value === v) ?? STATUSES[0];

/** "QA-001 rev B" */
export const referenceText = (a) => `${a.reference} rev ${a.revisionLetter}`;

/** A date-only value (2026-11-30) as 30 Nov 2026, without any time zone shift. */
export const formatDay = (d) => {
  if (!d) return "—";
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};

export const LINK_KINDS = {
  nonconformance: { label: "Nonconformance", field: "nonconformanceId" },
  supplier: { label: "Supplier", field: "supplierId" },
  gauge: { label: "Gauge", field: "gaugeId" },
  calibration: { label: "Calibration", field: "calibrationId" },
};

/** The API's link body for a link kept in the form. */
export const linkBody = (l) => ({ [LINK_KINDS[l.kind].field]: l.recordId });

/** Where a linked record lives in the app (null when there is no page). */
export const linkHref = (l) => {
  switch (l.kind) {
    case "nonconformance":
      return ncrPath(l.recordId);
    case "supplier":
      return "/Suppliers";
    case "gauge":
      return `/Calibration/Gauges/${l.recordId}`;
    case "calibration":
      return l.gaugeId ? `/Calibration/Gauges/${l.gaugeId}/calibrations/${l.recordId}` : null;
    default:
      return null;
  }
};
