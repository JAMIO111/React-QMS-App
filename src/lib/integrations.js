import { cleanSteps } from "./importTemplates";
/** Shared definitions for integration connections (IN1). */

export const STATUS = {
  draft: { label: "Draft", tone: "bg-border-color text-secondary-text" },
  ready: { label: "Ready to activate", tone: "bg-warning-color/20 text-primary-text" },
  active: { label: "Active", tone: "bg-success-color/15 text-success-color" },
  paused: { label: "Paused", tone: "bg-warning-color/20 text-primary-text" },
  retired: { label: "Retired", tone: "bg-border-color text-secondary-text" },
};

export const CREDENTIAL_KINDS = {
  api_key: "API key",
  bearer: "Bearer token",
  basic: "User name and password",
  oauth_client: "OAuth client",
};

export const EVENT_LABELS = {
  created: "Created",
  config_changed: "Settings changed",
  tested: "Connection tested",
  credential_set: "Credential stored",
  credential_rotated: "Credential replaced",
  credential_revoked: "Credential revoked",
  ready: "Marked ready",
  activated: "Activated",
  paused: "Paused",
  resumed: "Resumed",
  retired: "Retired",
  reset_to_draft: "Sent back to draft",
};

export const DELIMITERS = [
  { value: ",", label: "Comma (,)" },
  { value: ";", label: "Semicolon (;)" },
  { value: "tab", label: "Tab" },
  { value: "|", label: "Bar (|)" },
];
export const ENCODINGS = [
  { value: "utf-8", label: "UTF-8", hint: "The usual choice" },
  { value: "windows-1252", label: "Windows-1252", hint: "Older Excel exports with accents" },
];
/** How to read an uploaded file in the import wizard: "work it out" first, then the explicit choices. */
export const FILE_DELIMITERS = [{ value: "auto", label: "Work it out from the file" }, ...DELIMITERS];
export const FILE_ENCODINGS = [
  { value: "auto", label: "Work it out from the file", hint: "A byte-order mark always wins" },
  ...ENCODINGS,
  { value: "utf-16le", label: "UTF-16", hint: "Windows \"export to Excel\" text files" },
];
export const AUTH_TYPES = [
  { value: "none", label: "No sign-in" },
  { value: "api_key", label: "API key in a header" },
  { value: "bearer", label: "Bearer token" },
  { value: "basic", label: "User name and password" },
];

/** The credential kind a REST connection's sign-in type needs (none: no credential). */
export const credentialKindFor = (provider, config) => (provider === "rest_api" ? ((config?.authType ?? "none") === "none" ? null : config.authType) : null);

/** A short system code from a name: lower-case letters, digits and hyphens, starting with a letter. */
export const systemCodeFrom = (name) => {
  const code = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z]+/, "").slice(0, 40).replace(/-+$/, "");
  return code.length >= 2 ? code : "";
};

/** Turn the form's values into the configuration the API takes (only what was set). */
export const configFromForm = (provider, f) => {
  if (provider === "csv") {
    const c = {};
    if (f.delimiter) c.delimiter = f.delimiter;
    if (f.encoding) c.encoding = f.encoding;
    c.hasHeader = f.hasHeader !== false;
    return c;
  }
  if (provider === "rest_api") {
    const c = { baseUrl: (f.baseUrl ?? "").trim(), authType: f.authType || "none" };
    if (c.authType === "api_key") c.apiKeyHeader = (f.apiKeyHeader ?? "").trim();
    if (f.timeoutSeconds !== "" && f.timeoutSeconds != null) c.timeoutSeconds = Number(f.timeoutSeconds);
    if ((f.testPath ?? "").trim()) c.testPath = f.testPath.trim();
    const entities = restRowsToEntities(f.records ?? []);
    if (Object.keys(entities).length) c.entities = entities;
    return c;
  }
  return {};
};

// ---- REST connections (IN7): where each kind of record is and how the API pages ----------------------------------------------------------

export const PAGING_STYLES = [
  { value: "none", label: "One answer holds everything" },
  { value: "page", label: "Page numbers", hint: "?page=1&per_page=100" },
  { value: "offset", label: "Offset and limit", hint: "?offset=0&limit=100" },
  { value: "cursor", label: "A cursor in the answer", hint: "The answer says where the next page starts" },
  { value: "next_link", label: "A link to the next page", hint: "In the answer, or in the Link header" },
];

const blankRecord = (entityType = null) => ({
  entityType, path: "", recordsPath: "", style: "none", pageSize: "", pageParam: "", sizeParam: "", firstPage: "1", offsetParam: "", limitParam: "",
  cursorParam: "", nextCursorPath: "", nextLinkPath: "", linkHeader: false, incremental: false, incParam: "", incField: "",
});
export const newRestRecord = (entityType) => blankRecord(entityType);

/** A REST connection's `entities` setting as editable rows, one per kind of record. */
export const restEntitiesToRows = (entities = {}) =>
  Object.entries(entities ?? {}).map(([entityType, e]) => {
    const p = e.paging ?? {};
    return {
      ...blankRecord(entityType),
      path: e.path ?? "", recordsPath: e.recordsPath ?? "", style: p.style ?? "none", pageSize: p.pageSize != null ? String(p.pageSize) : "",
      pageParam: p.pageParam ?? "", sizeParam: p.sizeParam ?? "", firstPage: p.firstPage != null ? String(p.firstPage) : "1",
      offsetParam: p.offsetParam ?? "", limitParam: p.limitParam ?? "", cursorParam: p.cursorParam ?? "", nextCursorPath: p.nextCursorPath ?? "",
      nextLinkPath: p.nextLinkPath === "header" ? "" : (p.nextLinkPath ?? ""), linkHeader: p.nextLinkPath === "header",
      incremental: !!e.incremental, incParam: e.incremental?.param ?? "", incField: e.incremental?.field ?? "",
      query: e.query,
    };
  });

/** The rows back into the setting the API takes (only what was given). */
export const restRowsToEntities = (rows) => {
  const out = {};
  for (const r of rows) {
    if (!r.entityType) continue;
    const t = (v) => (v ?? "").trim();
    const e = { path: t(r.path) };
    if (t(r.recordsPath)) e.recordsPath = t(r.recordsPath);
    if (r.query && Object.keys(r.query).length) e.query = r.query;
    if (r.style && r.style !== "none") {
      const p = { style: r.style };
      if (t(r.pageSize)) p.pageSize = Number(r.pageSize);
      if (r.style === "page") {
        if (t(r.pageParam)) p.pageParam = t(r.pageParam);
        if (t(r.sizeParam)) p.sizeParam = t(r.sizeParam);
        if (r.firstPage === "0") p.firstPage = 0;
      } else if (r.style === "offset") {
        if (t(r.offsetParam)) p.offsetParam = t(r.offsetParam);
        if (t(r.limitParam)) p.limitParam = t(r.limitParam);
      } else if (r.style === "cursor") {
        if (t(r.cursorParam)) p.cursorParam = t(r.cursorParam);
        if (t(r.nextCursorPath)) p.nextCursorPath = t(r.nextCursorPath);
        if (t(r.sizeParam)) p.sizeParam = t(r.sizeParam);
      } else if (r.style === "next_link") {
        p.nextLinkPath = r.linkHeader ? "header" : t(r.nextLinkPath);
        if (t(r.sizeParam)) p.sizeParam = t(r.sizeParam);
      }
      e.paging = p;
    }
    if (r.incremental && (t(r.incParam) || t(r.incField))) e.incremental = { param: t(r.incParam), field: t(r.incField) };
    out[r.entityType] = e;
  }
  return out;
};

/** What a row still needs before it can be saved (the server checks everything again). */
export const restRecordProblem = (r) => {
  if (!r.entityType) return "Choose the kind of record";
  if (!/^\//.test((r.path ?? "").trim())) return "The path starts with /";
  if (r.style === "cursor" && !(r.nextCursorPath ?? "").trim()) return "Say where the answer gives the next cursor";
  if (r.style === "next_link" && !r.linkHeader && !(r.nextLinkPath ?? "").trim()) return "Say where the answer gives the next page's link";
  if (r.incremental && (!(r.incParam ?? "").trim() || !(r.incField ?? "").trim())) return "An incremental import needs the parameter and the field";
  return null;
};

export const ENTITY_LABELS = {
  supplier: "Suppliers",
  customer: "Customers",
  part: "Parts",
  machine: "Machines",
  employee: "Employees",
  gauge_type: "Gauge types",
  gauge: "Gauges",
  nonconformance: "Non-conformances",
  production_order: "Production orders",
  purchase_order: "Purchase orders",
  goods_receipt: "Goods receipts",
  po_receipt_total: "Received quantities",
};

export const RUN_KINDS = {
  preview: "Preview",
  full: "Full import",
  incremental: "Incremental import",
  retry: "Retry of failed rows",
};

export const RUN_STATUS = {
  queued: { label: "Queued", tone: "bg-border-color text-secondary-text" },
  running: { label: "Running", tone: "bg-info-color/15 text-info-color" },
  succeeded: { label: "Succeeded", tone: "bg-success-color/15 text-success-color" },
  partial: { label: "Partly done", tone: "bg-warning-color/20 text-primary-text" },
  failed: { label: "Failed", tone: "bg-error-color/15 text-error-color" },
  cancelled: { label: "Cancelled", tone: "bg-border-color text-secondary-text" },
};

export const ROW_STATUS = {
  staged: "Waiting",
  previewed: "Previewed",
  unchanged: "Unchanged",
  skipped: "Skipped",
  applied: "Applied",
  rejected: "Rejected",
  failed: "Failed",
  superseded: "Superseded",
};

/** "2 created · 1 failed" — only the figures that are not zero; a preview says "would". */
export const runSummary = (run) => {
  const c = run.counts;
  const would = run.kind === "preview" ? "would be " : "";
  const parts = [
    c.created && `${c.created} ${would}created`,
    c.updated && `${c.updated} ${would}updated`,
    c.unchanged && `${c.unchanged} unchanged`,
    c.skipped && `${c.skipped} skipped`,
    c.rejected && `${c.rejected} rejected`,
    c.failed && `${c.failed} failed`,
    c.superseded && `${c.superseded} superseded`,
    c.parked && `${c.parked} to review`,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : c.total ? `${c.total} rows` : "No rows";
};

/** What the work done during a request came to, in words. */
export const drainMessage = (drain) => {
  if (!drain) return null;
  if (drain.state === "paused") return "There is more to do. Carry on to continue the import.";
  if (drain.state === "waiting") return `The source could not be read (${drain.reason}). It will be tried again automatically.`;
  if (drain.state === "failed") return drain.reason;
  if (drain.state === "blocked") return drain.reason;
  return null;
};

export const isLive = (run) => run && (run.status === "queued" || run.status === "running");

export const FILE_STATUS = {
  uploaded: { label: "Reading", tone: "bg-border-color text-secondary-text" },
  parsed: { label: "Ready", tone: "bg-success-color/15 text-success-color" },
  failed: { label: "Could not be read", tone: "bg-error-color/15 text-error-color" },
  purged: { label: "Rows cleared", tone: "bg-border-color text-secondary-text" },
};

export const TRANSFORM_OPTIONS = [
  { value: "none", label: "As it is" },
  { value: "upper", label: "In capitals" },
  { value: "lower", label: "In lower case" },
  { value: "map", label: "Translate values" },
  { value: "constant", label: "Same value for every record" },
  { value: "concat", label: "Join two or more columns" },
];

export const DATE_FORMAT_OPTIONS = [
  { value: "iso", label: "Year-month-day (2026-11-09)" },
  { value: "dmy", label: "Day/month/year (09/11/2026)" },
  { value: "mdy", label: "Month/day/year (11/09/2026)" },
  { value: "excel", label: "Excel date number" },
];

const squash = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Suggest a source column for each field from the file's headings (same words ignoring case, spaces and punctuation, or a heading that contains the field's name). */
export const suggestColumns = (fields, headers) => {
  const used = new Set();
  const out = {};
  for (const f of fields) {
    const names = [squash(f.key), squash(f.label)];
    const exact = headers.find((h) => !used.has(h) && names.includes(squash(h)));
    const loose = exact ?? headers.find((h) => !used.has(h) && names.some((n) => n.length > 3 && squash(h).includes(n)));
    if (loose) {
      out[f.key] = loose;
      used.add(loose);
    }
  }
  return out;
};

/** "FROM=TO" lines ↔ a values object (for "Translate values"). */
export const parseValueMap = (text) =>
  Object.fromEntries(
    String(text ?? "")
      .split(/\r?\n/)
      .map((l) => l.split("="))
      .filter((p) => p.length >= 2 && p[0].trim() !== "")
      .map(([from, ...to]) => [from.trim(), to.join("=").trim()]),
  );
export const formatValueMap = (values) => Object.entries(values ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");

/** One editable row per catalogue field, from a saved mapping version (or suggestions from the file's headings). */
export const mappingToRows = (fields, saved, headers = []) => {
  const byTarget = Object.fromEntries((saved?.fields ?? []).map((f) => [f.target, f]));
  const suggested = saved ? {} : suggestColumns(fields, headers);
  return fields.map((f) => {
    const m = byTarget[f.key];
    return {
      target: f.key,
      on: !!m || !!suggested[f.key] || !!f.required,
      source: m?.source ?? suggested[f.key] ?? null,
      sources: m?.sources ?? [],
      transform: m?.transform ?? "none",
      valuesText: formatValueMap(m?.values),
      value: m?.value ?? "",
      separator: m?.separator ?? " ",
      dateFormat: m?.dateFormat ?? "iso",
      decimal: m?.decimal ?? ".",
      default: m?.default ?? "",
      match: m?.match ?? "code",
      steps: m?.steps ?? [],
      formula: m?.formula ?? "",
      useFormula: !!m?.formula,
      ownership: m?.ownership ?? "source_wins",
    };
  });
};

/** The editable rows back into the API's field list (only the rows switched on, with only what each transform uses). */
export const rowsToFields = (rows, catalogueFields) =>
  rows
    .filter((r) => r.on)
    .map((r) => {
      const field = catalogueFields.find((f) => f.key === r.target);
      const out = { target: r.target };
      if (r.ownership && r.ownership !== "source_wins") out.ownership = r.ownership;
      if (r.useFormula) {
        out.formula = r.formula;
        if (r.steps?.length) out.steps = cleanSteps(r.steps);
        if (field?.ref && r.match === "source" && field.ref.source) out.match = "source";
        return out;
      }
      if (r.transform !== "none") out.transform = r.transform;
      if (r.transform === "concat") {
        out.sources = r.sources.filter(Boolean);
        if (r.separator !== " ") out.separator = r.separator;
      } else if (r.transform === "constant") out.value = r.value;
      else out.source = r.source || null;
      if (r.transform === "map") out.values = parseValueMap(r.valuesText);
      if (field?.type === "date" && r.dateFormat !== "iso") out.dateFormat = r.dateFormat;
      if ((field?.type === "number" || field?.type === "integer") && r.decimal !== ".") out.decimal = r.decimal;
      if (r.default?.trim() && r.transform !== "constant") out.default = r.default.trim();
      if (field?.ref && r.match === "source" && field.ref.source) out.match = "source";
      if (r.steps?.length) out.steps = cleanSteps(r.steps);
      return out;
    });

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Why a file cannot be uploaded to a file connection, or null. */
export const fileProblem = (file) => {
  if (!/\.(csv|txt|xlsx)$/i.test(file.name)) return "Choose a .csv, .txt or .xlsx file";
  if (file.size > MAX_FILE_BYTES) return "The file is larger than 25 MB";
  if (file.size === 0) return "The file is empty";
  return null;
};

export const WRITE_MODES = [
  { value: "add_only", label: "Add new records only", hint: "Records already imported are never touched again: for a one-time historical import" },
  { value: "add_update", label: "Add new and update existing", hint: "The source keeps feeding its changes in: for records kept in sync" },
  { value: "update_only", label: "Update existing only", hint: "Creates nothing; tops up records already in Fortress" },
];
export const WRITE_MODE_LABELS = Object.fromEntries(WRITE_MODES.map((m) => [m.value, m.label]));
export const ON_MISSING = [
  { value: "nothing", label: "Do nothing" },
  { value: "list", label: "List it on the import" },
  { value: "deactivate", label: "Make it inactive" },
];
export const SCHEDULES = [
  { value: "manual", label: "By hand" },
  { value: "daily", label: "Daily" },
];
/** Where a record an import wrote is shown (a page of its own where there is one, else its register). */
export const recordPath = (entityType, id) =>
  ({
    supplier: `/Suppliers/${id}`,
    part: `/Parts/${id}`,
    gauge: `/Calibration/Gauges/${id}`,
    nonconformance: `/Non-Conformance/Register/${id}`,
    production_order: `/Production/Orders/${id}`,
    purchase_order: "/Supplier-Quality/Purchase-Orders",
    goods_receipt: "/Supplier-Quality/Goods-Receipts",
    po_receipt_total: "/Supplier-Quality/Purchase-Orders",
    customer: "/Customers",
    machine: "/Machines",
    employee: "/Employees",
    gauge_type: "/Settings/Data-Management?tab=calibration",
  })[entityType] ?? null;

/** The received quantities check (IN6c): what each state means. */
export const RECONCILIATION_STATES = {
  short: { label: "Fortress has less", tone: "bg-warning-color/15 text-warning-color" },
  over: { label: "Fortress has more", tone: "bg-error-color/15 text-error-color" },
  date: { label: "Last date differs", tone: "bg-border-color text-secondary-text" },
  match: { label: "Agrees", tone: "bg-success-color/15 text-success-color" },
};

/** Who owns a field once the record exists (IN5): what a later import may do to it. "Review" is not offered for fields that only ever add or custom fields. */
export const OWNERSHIP_OPTIONS = [
  { value: "source_wins", label: "Source wins", title: "A later import overwrites it" },
  { value: "qms_wins", label: "Fortress wins", title: "Set when the record is created; after that only people change it" },
  { value: "manual_review", label: "Review", title: "A different value waits for someone to accept or reject it" },
];
export const OWNERSHIP_HINTS = {
  source_wins: "A later import overwrites this field with the source's value.",
  qms_wins: "Set when the record is created. After that only people change it in Fortress; imports leave it alone.",
  manual_review: "When a later import brings a different value it is not written: it waits under Values to review for someone to accept or reject it.",
};
/** The ownership choices for a field (`reviewable` false removes Review). */
export const ownershipOptions = (field) => OWNERSHIP_OPTIONS.filter((o) => o.value !== "manual_review" || field?.reviewable !== false);

export const MATCH_OPTIONS = [
  { value: "code", label: "Fortress code" },
  { value: "source", label: "Id from an earlier import" },
];

/**
 * The systems shown on Settings → Integrations, in order. `providerKey` is the database provider a card creates connections with; only `available`
 * ones can be used — the rest are on the page so people can see what is coming. `mark` names a brand mark (brandMarks.js) or a built-in icon.
 */
export const INTEGRATION_CATALOGUE = [
  { key: "csv", providerKey: "csv", name: "CSV or Excel file", description: "Import records from a spreadsheet or a file exported from another system, once.", mark: "file", available: true },
  { key: "rest_api", providerKey: "rest_api", name: "REST API", description: "Read records from a system that offers a REST API, page by page, with incremental imports.", mark: "api", available: true },
  { key: "dynamics_bc", name: "Microsoft Dynamics 365 Business Central", description: "Items, vendors, customers and production orders from Business Central.", mark: "microsoft", available: false },
  { key: "sap", name: "SAP", description: "Materials, business partners and orders from SAP S/4HANA or Business One.", mark: "sap", available: false },
  { key: "sage", name: "Sage", description: "Suppliers, customers and stock items from Sage 200 or Sage X3.", mark: "sage", available: false },
  { key: "mysql", name: "MySQL", description: "Read tables or views from a MySQL database through a small agent on your network.", mark: "mysql", available: false },
  { key: "postgresql", name: "PostgreSQL", description: "Read tables or views from a PostgreSQL database through a small agent on your network.", mark: "postgresql", available: false },
  { key: "sql_server", name: "Microsoft SQL Server", description: "Read tables or views from SQL Server through a small agent on your network.", mark: "database", available: false },
  { key: "odoo", name: "Odoo", description: "Products, partners and manufacturing orders from Odoo.", mark: "odoo", available: false },
  { key: "google_sheets", name: "Google Sheets", description: "Keep a shared sheet and Fortress in step.", mark: "googlesheets", available: false },
  { key: "xero", name: "Xero", description: "Suppliers and customers from your Xero contacts.", mark: "xero", available: false },
  { key: "quickbooks", name: "QuickBooks", description: "Vendors, customers and items from QuickBooks Online.", mark: "quickbooks", available: false },
];

/** A line for each kind of record on the first step of a file import. */
export const ENTITY_DESCRIPTIONS = {
  supplier: "Companies you buy from. New ones start pending approval.",
  customer: "Companies you sell to.",
  part: "Part numbers with their first revision.",
  machine: "Machines and work centres, by site.",
  employee: "People who work here (not sign-ins).",
  gauge_type: "Kinds of gauge and how often they are calibrated.",
  gauge: "Individual gauges. Calibration dates are recorded in Fortress.",
  nonconformance: "Historical non-conformances, added as drafts.",
  production_order: "Works orders.",
  purchase_order: "Order lines placed with suppliers, one row per line.",
  goods_receipt: "Deliveries and returns, one row per transaction. Old deliveries are never sent for inspection.",
  po_receipt_total: "Received so far per order line; Fortress records the increase as a delivery.",
};

/** Whether a mapping row takes its value from somewhere (a column, joined columns, a fixed value or a value for empty cells). */
export const rowHasSource = (row) => {
  if (row.useFormula) return !!row.formula?.trim();
  if ((row.steps ?? []).some((s) => ["join", "coalesce", "default"].includes(s.kind))) return true;
  if (row.transform === "constant") return row.value !== "";
  if (row.transform === "concat") return row.sources.length > 0;
  return !!row.source || !!row.default?.trim();
};

/** Rows for saving: a field is used when it takes a value from somewhere. */
export const rowsInUse = (rows) => rows.map((r) => ({ ...r, on: rowHasSource(r) }));

/** Whether the mapping on screen differs from the saved version (so finishing must save a new version first). */
export const mappingChanged = (saved, keyField, fields) => {
  if (!saved) return true;
  const norm = (list) => JSON.stringify([...list].map((f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v != null && v !== "").sort(([a], [b]) => a.localeCompare(b)))).sort((a, b) => a.target.localeCompare(b.target)));
  return saved.keyField !== keyField || norm(saved.fields) !== norm(fields);
};

/** A short code for a new file connection's source system that no connection of the organisation uses yet. */
export const freeSystemCode = (connections, base = "files") => {
  const used = new Set((connections ?? []).map((c) => c.externalSystem));
  if (!used.has(base)) return base;
  for (let i = 2; ; i += 1) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
};

/** The file import wizard's address (Settings → Integrations → CSV or Excel file), at a step with what is already chosen. */
export const wizardPath = (connectionId, { entity, file, step, template } = {}) => {
  const q = new URLSearchParams({ connection: connectionId });
  if (entity) q.set("entity", entity);
  if (template) q.set("template", template);
  if (file) q.set("file", file);
  if (step) q.set("step", String(step));
  return `/Settings/Integrations/csv?${q}`;
};

/** What happens when a full read no longer contains a record (IN8). */
export const MISSING_OPTIONS = [
  { value: "nothing", label: "Nothing" },
  { value: "list", label: "List it for a person" },
  { value: "deactivate", label: "Make it inactive (a person confirms above 20%)" },
];

/** The health of a connection's kind of record, in words and colour. */
export const HEALTH_STATES = {
  ok: { label: "Healthy", tone: "bg-success-color/15 text-success-color" },
  attention: { label: "Needs a look", tone: "bg-warning-color/15 text-warning-color" },
  failing: { label: "Failing", tone: "bg-error-color/15 text-error-color" },
};

/** A run's disappeared-records summary in words (null when there is nothing to say). */
export const missingSummary = (m) => {
  if (!m) return null;
  if (m.skipped) return m.skipped;
  const parts = [
    m.deactivated ? `${m.deactivated} made inactive` : null,
    m.held ? `${m.held} held for a person` : null,
    m.listed ? `${m.listed} listed` : null,
    m.returned ? `${m.returned} came back` : null,
  ].filter(Boolean);
  return parts.length ? `No longer in the source: ${parts.join(" · ")}` : null;
};
