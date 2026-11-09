import { ncrPath } from "./ncr";

/** Shared definitions for supplier performance (SQ5). */
export const METRIC_LABELS = {
  otd: "On-time delivery",
  ppm: "Parts per million rejected",
  ncs: "Non-conformances",
  scar: "Corrective action responsiveness",
  certs: "Certifications in date",
};
export const METRIC_ORDER = ["otd", "ppm", "ncs", "scar", "certs"];

export const BAND = {
  good: { label: "Good", tone: "bg-success-color/15 text-success-color" },
  watch: { label: "Watch", tone: "bg-warning-color/20 text-primary-text" },
  poor: { label: "Poor", tone: "bg-error-color/15 text-error-color" },
  insufficient: { label: "Not enough data", tone: "bg-border-color text-secondary-text" },
};

export const PERIODS = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "12 months" },
];
export const DEFAULT_PERIOD = "90";

const day = (d) => d.toISOString().slice(0, 10);
/** The period ending today (UTC) and covering `days` days. */
export const periodFor = (days, now = new Date()) => {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to.getTime() - (Number(days) - 1) * 86_400_000);
  return { from: day(from), to: day(to) };
};

export const OTD_POLICIES = [
  { value: "agreed", label: "The latest agreed date", hint: "Counts a delivery as on time against the date last agreed with the supplier" },
  { value: "original", label: "The original requested date", hint: "Ignores later changes: judged against what was first asked for" },
];

/** Where a record behind a warning lives: the screen it links to and a label. */
export const sourceLink = (sourceType, item, supplierId) => {
  switch (sourceType) {
    case "otd":
    case "ppm":
    case "deliveries":
      return item.receiptId ? { to: `/Supplier-Quality/Goods-Receipts/${item.receiptId}`, label: `${item.reference} line ${item.lineNumber}${item.daysLate ? ` (${item.daysLate} days late)` : ""}` } : null;
    case "orders":
      return item.purchaseOrderId ? { to: `/Supplier-Quality/Purchase-Orders/${item.purchaseOrderId}`, label: `${item.poNumber} line ${item.lineNumber} (${item.daysLate} days late)` } : null;
    case "ncs":
      return item.id ? { to: ncrPath(item.id), label: `${item.reference}${item.severity ? ` · ${item.severity}` : ""}` } : null;
    case "scar":
    case "scars":
      return item.id ? { to: `/Supplier-Quality/SCARs/${item.id}`, label: `${item.reference} · ${item.status}` } : null;
    case "certs":
      return item.id ? { to: `/Suppliers/${supplierId}?tab=qualification`, label: `${item.number}${item.expiresOn ? ` · expired ${item.expiresOn}` : ""}` } : null;
    default:
      return null;
  }
};

export const percent = (v, digits = 0) => (v === null || v === undefined ? "—" : `${(Number(v) * 100).toFixed(digits)}%`);
export const formatScore = (s) => (s === null || s === undefined ? "—" : Number(s).toFixed(0));
