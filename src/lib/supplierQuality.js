/** Supplier quality: approval statuses, types, risk and the other fixed lists (the database holds the rules; these are labels and the moves the buttons offer). */

export const SUPPLIER_STATUSES = [
  { key: "pending_approval", label: "Pending approval", tone: "bg-warning-color/20 text-primary-text" },
  { key: "approved", label: "Approved", tone: "bg-success-color/15 text-success-color" },
  { key: "conditional", label: "Conditional approval", tone: "bg-info-color/15 text-info-color" },
  { key: "suspended", label: "Suspended", tone: "bg-error-color/15 text-error-color" },
  { key: "disqualified", label: "Disqualified", tone: "bg-error-color/25 text-error-color" },
  { key: "archived", label: "Archived", tone: "bg-border-color text-secondary-text" },
];
export const statusOf = (key) => SUPPLIER_STATUSES.find((s) => s.key === key) ?? SUPPLIER_STATUSES[0];

/** The moves app.supplier_status_allowed permits (the database is the authority; this only decides which buttons to offer). */
export const STATUS_MOVES = {
  pending_approval: ["approved", "conditional", "disqualified", "archived"],
  approved: ["conditional", "suspended", "disqualified", "archived"],
  conditional: ["approved", "suspended", "disqualified", "archived"],
  suspended: ["approved", "conditional", "disqualified", "archived"],
  disqualified: ["pending_approval", "archived"],
  archived: ["pending_approval"],
};
export const movesFrom = (status) => STATUS_MOVES[status] ?? [];

/** What a move is called on a button, from the status it leads to. */
export const MOVE_VERB = {
  approved: "Approve",
  conditional: "Approve conditionally",
  suspended: "Suspend",
  disqualified: "Disqualify",
  archived: "Archive",
  pending_approval: "Re-open for qualification",
};

export const SUPPLIER_TYPES = [
  { id: "manufacturer", name: "Manufacturer" },
  { id: "distributor", name: "Distributor" },
  { id: "subcontractor", name: "Subcontractor" },
  { id: "service_provider", name: "Service provider" },
  { id: "calibration_provider", name: "Calibration provider" },
  { id: "logistics_provider", name: "Logistics provider" },
  { id: "other", name: "Other" },
];
export const typeLabel = (id) => SUPPLIER_TYPES.find((t) => t.id === id)?.name ?? "";

export const RISK_RATINGS = [
  { id: "low", name: "Low", tone: "bg-success-color/15 text-success-color" },
  { id: "medium", name: "Medium", tone: "bg-warning-color/20 text-primary-text" },
  { id: "high", name: "High", tone: "bg-error-color/15 text-error-color" },
  { id: "critical", name: "Critical", tone: "bg-error-color/25 text-error-color" },
];
export const riskOf = (id) => RISK_RATINGS.find((r) => r.id === id) ?? null;

export const CONTACT_ROLES = [
  { id: "quality", name: "Quality" },
  { id: "purchasing", name: "Purchasing" },
  { id: "sales", name: "Sales" },
  { id: "technical", name: "Technical" },
  { id: "accounts", name: "Accounts" },
  { id: "logistics", name: "Logistics" },
  { id: "management", name: "Management" },
  { id: "other", name: "Other" },
];
export const contactRoleLabel = (id) => CONTACT_ROLES.find((r) => r.id === id)?.name ?? id;

export const PRODUCT_KINDS = [
  { id: "part", name: "Part" },
  { id: "material", name: "Material" },
  { id: "service", name: "Service" },
];
export const productKindLabel = (id) => PRODUCT_KINDS.find((k) => k.id === id)?.name ?? id;

/** The register's scope name for saved filters. */
export const SUPPLIER_SCOPE = "supplier_register";

/** One line of address for lists. */
export const addressLine = (s) => [s.addressLine1, s.addressLine2, s.city, s.region, s.postcode, s.country].filter(Boolean).join(", ");

/** Titles used when a saved supplier filter is listed. */
export const SUPPLIER_FILTER_TITLES = { status: "Status", type: "Type", classification: "Classification", risk: "Risk", active: "Activity", search: "Search" };
