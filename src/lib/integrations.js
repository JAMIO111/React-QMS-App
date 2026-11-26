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
  credential_stored: "Password stored on the agent",
  credential_failed: "The agent could not store the password",
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
  { value: "oauth_client", label: "OAuth client credentials", hint: "Microsoft Entra, Auth0, Okta…" },
];
export const OAUTH_CLIENT_AUTH = [
  { value: "body", label: "In the request", hint: "client_id and client_secret in the form (the usual choice)" },
  { value: "basic", label: "With basic sign-in", hint: "An Authorization header" },
];

/** What is stored for each credential kind: the text the API's sign-in reads (JSON for user name + password and for an OAuth client). */
export const credentialSecret = (kind, { user = "", secret = "" }) => {
  if (kind === "basic") return JSON.stringify({ username: user.trim(), password: secret });
  if (kind === "oauth_client") return JSON.stringify({ clientId: user.trim(), clientSecret: secret });
  return secret;
};

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
    if (c.authType === "oauth_client") {
      c.oauthTokenUrl = (f.oauthTokenUrl ?? "").trim();
      const scope = (f.oauthScope ?? "").trim().replace(/\s+/g, " ");
      if (scope) c.oauthScope = scope;
      if ((f.oauthAudience ?? "").trim()) c.oauthAudience = f.oauthAudience.trim();
      c.oauthClientAuth = f.oauthClientAuth || "body";
    }
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
  calibration: "Calibration records (legacy)",
  nonconformance: "Non-conformances",
  ncr_cost: "NC cost lines",
  production_order: "Production orders",
  purchase_order: "Purchase orders",
  goods_receipt: "Goods receipts",
  po_receipt_total: "Received quantities",
  customer_order: "Customer orders",
  shipment: "Shipments",
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
    c.filtered && `${c.filtered} filtered out`,
    c.skipped - (c.filtered ?? 0) > 0 && `${c.skipped - (c.filtered ?? 0)} skipped`,
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
  if (drain.state === "waiting" && /^Waiting for the connector agent/.test(drain.reason ?? "")) return `${drain.reason}. The import carries on once the agent has sent every row.`;
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
  { value: "every_5m", label: "Every 5 minutes", database: true },
  { value: "every_15m", label: "Every 15 minutes", database: true },
  { value: "hourly", label: "Hourly", database: true },
  { value: "daily", label: "Daily" },
];
/** The schedules a connection can use: the minute ones only for a database read through an agent (AG4). */
export const scheduleOptions = (isDatabase) => SCHEDULES.filter((s) => isDatabase || !s.database);
export const scheduleLabel = (value) => SCHEDULES.find((s) => s.value === value)?.label ?? "By hand";
/** Where a record an import wrote is shown (a page of its own where there is one, else its register). */
export const recordPath = (entityType, id) =>
  ({
    supplier: `/Suppliers/${id}`,
    part: `/Parts/${id}`,
    gauge: `/Calibration/Gauges/${id}`,
    calibration: "/Calibration/Gauges",
    nonconformance: `/Non-Conformance/Register/${id}`,
    ncr_cost: "/Non-Conformance/Register",
    production_order: `/Production/Orders/${id}`,
    purchase_order: "/Supplier-Quality/Purchase-Orders",
    goods_receipt: "/Supplier-Quality/Goods-Receipts",
    po_receipt_total: "/Supplier-Quality/Purchase-Orders",
    customer_order: "/Shipping/Orders",
    shipment: "/Shipping/Shipments",
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
  { value: "source_wins", label: "Source wins", title: "A later import overwrites it; while a schedule is on, people cannot edit it in Fortress" },
  { value: "qms_wins", label: "Fortress wins", title: "Set when the record is created; after that only people change it, and it stays editable" },
  { value: "manual_review", label: "Review", title: "A different value waits for someone to accept or reject it; people can still edit it" },
];
export const OWNERSHIP_HINTS = {
  source_wins: "A later import overwrites this field with the source's value. While a schedule is on, the field is locked in Fortress for the records this import manages: it shows who manages it and cannot be edited.",
  qms_wins: "Set when the record is created. After that only people change it in Fortress; imports leave it alone. It stays editable.",
  manual_review: "When a later import brings a different value it is not written: it waits under Values to review for someone to accept or reject it. People can still edit it in Fortress.",
};
/** The ownership choices for a field (`reviewable` false removes Review). */
export const ownershipOptions = (field) => OWNERSHIP_OPTIONS.filter((o) => o.value !== "manual_review" || field?.reviewable !== false);

/** Cost imports (cost-import-plan §10): what a run's currency summary says, in words. */
export const costSummaryWords = (c) => {
  if (!c) return null;
  const waiting = (c.currencies ?? []).reduce((n, x) => n + (x.waiting ?? 0), 0);
  const parts = [];
  if (c.lines > 0) parts.push(waiting === 0 ? "every line has an exchange rate for its date" : waiting === 1 ? "1 line has no published rate yet" : `${waiting} lines have no published rate yet`);
  return { waiting, sentence: parts.join("; ") };
};

/** The words next to the "Match by" choice, by what the link is to. */
export const matchHint = (kind, match, sourceWords) => {
  if (kind === "nonconformance") {
    return match === "source"
      ? "The id the non-conformance had in your source, from importing the non-conformances through this connection first"
      : "The Fortress reference, such as SNC-26-0011";
  }
  return match === "source" ? sourceWords : "The code as it is in Fortress";
};

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
  { key: "mysql", providerKey: "sql_agent", engine: "mysql", name: "MySQL", description: "Read tables or views from a MySQL or MariaDB database through a connector agent on your network. Nothing connects in.", mark: "mysql", available: true },
  { key: "postgresql", providerKey: "sql_agent", engine: "postgres", name: "PostgreSQL", description: "Read tables or views from a PostgreSQL database through a connector agent on your network. Nothing connects in.", mark: "postgresql", available: true },
  { key: "folder", providerKey: "sql_agent", engine: "folder", name: "Files in a folder", description: "Pick up CSV or Excel exports from a folder or share on your network as they arrive, through a connector agent. Nothing connects in.", mark: "folder", available: true },
  { key: "agent_rest", providerKey: "sql_agent", engine: "rest", name: "Internal API", description: "Read records from a REST API inside your network that Fortress cannot reach, through a connector agent. Nothing connects in; the key stays on the agent.", mark: "network", available: true },
  { key: "sql_server", providerKey: "sql_agent", engine: "sqlserver", name: "Microsoft SQL Server", description: "Read tables or views from SQL Server through a connector agent on your network. Nothing connects in.", mark: "database", available: true },
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
  gauge: "Individual gauges. Import their old calibrations as legacy records so they do not show as uncalibrated.",
  calibration: "A gauge's past calibrations, as the old system concluded them (no readings). Each is marked legacy in Fortress and is only ever added.",
  nonconformance: "Historical non-conformances, with the stage your system gives them (a draft when it gives none).",
  ncr_cost: "Cost lines for non-conformances already in Fortress, one row per line. Each is converted on its own date into the site's currency and the organisation's, and is only ever added.",
  production_order: "Works orders.",
  purchase_order: "Order lines placed with suppliers, one row per line.",
  goods_receipt: "Deliveries and returns, one row per transaction. Old deliveries are never sent for inspection.",
  po_receipt_total: "Received so far per order line; Fortress records the increase as a delivery.",
  customer_order: "Order lines placed by customers, one row per line.",
  shipment: "What left, one row per movement out. A source's one inventory table is read with the record filter on its type and category; returns are never shipments.",
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

/** The address of the page that maps an API connection's fields for one kind of record. */
export const apiMappingPath = (connectionId, entityType, templateId) => {
  const q = new URLSearchParams();
  if (entityType) q.set("entity", entityType);
  if (templateId) q.set("template", templateId);
  const s = q.toString();
  return `/Settings/Integrations/${connectionId}/map${s ? `?${s}` : ""}`;
};

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Database connections through a connector agent (docs/connector-agent-plan.md AG2)
// ---------------------------------------------------------------------------------------------------------------------------------------------

export const DB_ENGINES = { postgres: "PostgreSQL", sqlserver: "Microsoft SQL Server", mysql: "MySQL", folder: "Files in a folder", rest: "Internal API" };

/** A folder of files read through the agent (AG5b), rather than a database. */
export const isFolderConfig = (config) => config?.engine === "folder";

/** An internal REST API read through the agent (AG5c). */
export const isRestConfig = (config) => config?.engine === "rest";

/** How each engine may sign in. SQL Server's Windows authentication uses the agent's service account: no password at all. */
export const DB_AUTH = {
  sqlserver: [
    { value: "windows", label: "Windows authentication (the agent's service account)" },
    { value: "sql", label: "SQL login (user name and password)" },
  ],
  postgres: [{ value: "password", label: "User name and password" }],
  mysql: [{ value: "password", label: "User name and password" }],
  rest: [
    { value: "none", label: "No sign-in" },
    { value: "api_key", label: "An API key in a header" },
    { value: "bearer", label: "A bearer token" },
    { value: "basic", label: "User name and password (basic)" },
  ],
};

export const dbNeedsPassword = (config) => ["sql", "password", "api_key", "bearer", "basic"].includes(config?.authType);

/** What the connection's secret is called: an API key, a token or a password. */
export const secretWord = (config) => ({ api_key: "API key", bearer: "token" }[config?.authType] ?? "password");

/** The dialog's fields from a connection's settings (or a new one for an engine). */
export const databaseForm = (engine, c = {}) => ({
  engine: c.engine ?? engine ?? "sqlserver",
  folder: c.folder ?? "",
  baseUrl: c.baseUrl ?? "",
  apiKeyHeader: c.apiKeyHeader ?? "X-Api-Key",
  testPath: c.testPath ?? "",
  timeoutSeconds: c.timeoutSeconds != null ? String(c.timeoutSeconds) : "",
  fileEncoding: c.encoding ?? "auto",
  fileDelimiter: c.delimiter ?? "auto",
  hasHeader: c.hasHeader !== false,
  server: c.server ?? "",
  port: c.port != null ? String(c.port) : "",
  instance: c.instance ?? "",
  database: c.database ?? "",
  authType: c.authType ?? ({ sqlserver: "windows", folder: "none", rest: "none" }[c.engine ?? engine ?? "sqlserver"] ?? "password"),
  encrypt: c.encrypt !== false,
  trustServerCertificate: c.trustServerCertificate === true,
});

const SERVER = /^(\(local\)|\.|[A-Za-z0-9]([A-Za-z0-9._-]{0,251}[A-Za-z0-9])?|[0-9A-Fa-f:.]{2,45})$/;
const DATABASE_BAD = /[;='"[\]]|\p{Cc}/u;

/** What is wrong with the dialog's fields, in the database's own words (the database checks again). */
export const databaseFormProblem = (f) => {
  if (f.engine === "folder") return folderPathProblem(f.folder);
  if (f.engine === "rest") return restFormProblem(f);
  if (!SERVER.test(f.server.trim())) return "Give the database server's name or address (letters, digits, dots and hyphens)";
  if (f.port && !(/^\d+$/.test(f.port) && +f.port >= 1 && +f.port <= 65535)) return "The port is a whole number from 1 to 65535";
  if (f.engine === "sqlserver" && f.instance && !/^[A-Za-z0-9_$#-]{1,32}$/.test(f.instance.trim())) return "The instance name is up to 32 letters, digits, _ $ # or -";
  if (f.instance && f.port) return "Give a port or an instance name, not both";
  const db = f.database.trim();
  if (!db || db.length > 128 || DATABASE_BAD.test(db)) return "Give the database name (no ; = quotes or brackets)";
  return null;
};

/** The settings the API takes (only what was set). */
export const databaseConfig = (f) => {
  if (f.engine === "folder") {
    const c = { engine: "folder", folder: f.folder.trim(), authType: "none" };
    if (f.fileEncoding && f.fileEncoding !== "auto") c.encoding = f.fileEncoding;
    if (f.fileDelimiter && f.fileDelimiter !== "auto") c.delimiter = f.fileDelimiter;
    if (!f.hasHeader) c.hasHeader = false;
    return c;
  }
  if (f.engine === "rest") {
    const c = { engine: "rest", baseUrl: f.baseUrl.trim(), authType: f.authType };
    if (f.authType === "api_key") c.apiKeyHeader = f.apiKeyHeader.trim();
    if (f.testPath.trim()) c.testPath = f.testPath.trim();
    if (f.timeoutSeconds) c.timeoutSeconds = Number(f.timeoutSeconds);
    return c;
  }
  const c = { engine: f.engine, server: f.server.trim(), database: f.database.trim(), authType: f.authType, encrypt: !!f.encrypt };
  if (f.port) c.port = Number(f.port);
  if (f.engine === "sqlserver" && f.instance.trim()) c.instance = f.instance.trim();
  if (f.trustServerCertificate) c.trustServerCertificate = true;
  return c;
};

/** Where the database is, in one line: "SQL01\\SQLEXPRESS / ERP" or "erp-db:5432 / erp". */
export const databaseWhere = (c) =>
  isFolderConfig(c) ? c.folder ?? "?" : isRestConfig(c) ? c.baseUrl ?? "?" : `${c?.server ?? "?"}${c?.instance ? `\\${c.instance}` : c?.port ? `:${c.port}` : ""} / ${c?.database ?? "?"}`;

const hasControl = (v) => [...v].some((ch) => ch.charCodeAt(0) < 32);

const REST_URL = /^https?:\/\/([A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]{2,45}\])(:[0-9]{1,5})?(\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/;
/** A path below the address: starts with /, no ?, #, // or .. (as app.integration_rest_path_ok). */
export const restPathProblem = (p, what = "The path") => {
  const v = p ?? "";
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(v) || v.length > 300 || v.includes("//") || /%2e/i.test(v) || /\/\.{1,2}(\/|$)/.test(v)) {
    return `${what} starts with / and stays below the address (no ?, #, // or ..)`;
  }
  return null;
};
const FORBIDDEN_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "te", "upgrade", "keep-alive", "expect", "cookie", "proxy-authorization", "proxy-connection", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "authorization"]);

/** An internal API's settings as the database checks them (AG5c). A private address is fine: the agent is inside the network. */
export const restFormProblem = (f) => {
  const url = f.baseUrl.trim();
  if (!url) return "Give the API's address as the agent's machine reaches it, such as http://erp.factory.local:8080/api";
  if (url.length > 300 || !REST_URL.test(url) || /^https?:\/\/[^/]*@/.test(url)) return "The address is http:// or https://, a host name or address, an optional :port and an optional path (no user name, ? or #)";
  if (/:\/\/[^/]+\/.*\/\//.test(url) || /\/\.{1,2}(\/|$)/.test(url) || /%2e/i.test(url)) return "The address cannot hold //, . or .. in its path";
  const host = (/^https?:\/\/(\[[^\]]+\]|[^:/]+)/.exec(url)?.[1] ?? "").toLowerCase();
  if (/^169\.254\./.test(host) || /^\[fe[89ab][0-9a-f]:/.test(host) || ["0.0.0.0", "[::]"].includes(host)) return "That address cannot be an API (link-local and \"any\" addresses are refused)";
  if (f.authType === "api_key") {
    const h = f.apiKeyHeader.trim();
    if (!/^[A-Za-z0-9-]{1,60}$/.test(h)) return "Name the header the API key is sent in (letters, digits and hyphens)";
    if (FORBIDDEN_HEADERS.has(h.toLowerCase())) return `The API key cannot be sent in the ${h} header`;
  }
  if (f.testPath.trim()) {
    const p = restPathProblem(f.testPath.trim(), "The test path");
    if (p) return p;
  }
  if (f.timeoutSeconds && !(/^\d+$/.test(f.timeoutSeconds) && +f.timeoutSeconds >= 1 && +f.timeoutSeconds <= 120)) return "The timeout is a whole number of seconds from 1 to 120";
  return null;
};

/** The folder as the database checks it: a drive path, a share or an absolute path; nothing relative, no "..". */
export const folderPathProblem = (folder) => {
  const v = (folder ?? "").trim();
  if (v.length < 3 || v.length > 260) return "Give the folder as the agent's machine knows it (up to 260 characters)";
  if (!/^([A-Za-z]:\\|\\\\[A-Za-z0-9._$-]+\\[^\\]+|\/)/.test(v)) return "Give the whole folder path: a drive (C:\\Exports), a share (\\\\server\\share\\Exports) or a path starting with /";
  if (/(^|[\\/])\.\.([\\/]|$)/.test(v) || /["<>|*?]/.test(v) || hasControl(v)) return 'The folder path cannot contain "..", quotes, < > | * ? or control characters';
  return null;
};

/** A file name or pattern directly in the folder (* any run of characters, ? one). */
export const fileNameProblem = (name) => {
  const v = name ?? "";
  if (!v || v.length > 200) return "Give the file's name, or a pattern such as machines-*.csv";
  if (/[\\/:"<>|]/.test(v) || hasControl(v) || v === "." || v === "..") return "Name a file directly in the folder (no \\ / : or control characters)";
  if (v.trim() !== v) return "A file name does not start or end with a space";
  return null;
};

/** A dated file name made into a pattern, so the newest export is read: "machines-2026-11-15.csv" → "machines-*.csv". */
export const filePatternFrom = (name) => {
  const m = /^(.*?)([-_ ]?)(\d{4}[-_]?\d{2}[-_]?\d{2}([T_ -]?\d{2}[-_:]?\d{2}([-_:]?\d{2})?)?)(\.[^.]+)$/.exec(name ?? "");
  return m && m[1] ? `${m[1]}${m[2]}*${m[6]}` : name;
};

export const AGENT_CREDENTIAL_WORDS = {
  waiting: "On its way to the agent",
  stored: "Stored on the agent",
  failed: "The agent could not store it",
  cleared: "Needs typing again",
};

/** A job given to the agent is still going. */
export const agentJobRunning = (status) => ["pending", "received", "running"].includes(status);

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Where each kind of record is read from in a database connection (docs/connector-agent-plan.md AG3)
// ---------------------------------------------------------------------------------------------------------------------------------------------

export const FILTER_OPS = [
  { value: "eq", label: "equals" },
  { value: "ne", label: "does not equal" },
  { value: "gt", label: "greater than" },
  { value: "gte", label: "at least" },
  { value: "lt", label: "less than" },
  { value: "lte", label: "at most" },
  { value: "is_null", label: "is empty", noValue: true },
  { value: "not_null", label: "is not empty", noValue: true },
];
const OP_WORDS = Object.fromEntries(FILTER_OPS.map((o) => [o.value, o.label]));
const NO_VALUE = new Set(FILTER_OPS.filter((o) => o.noValue).map((o) => o.value));

/** The record source dialog's form from a saved source (or a table just browsed: its primary key is the first guess for the key column). */
export const recordSourceForm = (source, shape) => ({
  keyColumn: source?.keyColumn ?? shape?.columns?.find((c) => c.primaryKey)?.name ?? shape?.columns?.[0]?.name ?? null,
  allColumns: !source?.columns,
  columns: source?.columns ?? (shape?.columns ?? []).map((c) => c.name),
  filters: (source?.filters ?? []).map((f) => ({ column: f.column, op: f.op, value: f.value === undefined ? "" : String(f.value) })),
  changedColumn: source?.changedColumn ?? null,
});

/** What still stops the source being saved, in words; null when it can be. */
export const recordSourceProblem = (f) => {
  if (!f.keyColumn) return "Choose the column that identifies each row";
  if (!f.allColumns) {
    if (f.columns.length === 0) return "Choose the columns to read, or read them all";
    if (!f.columns.includes(f.keyColumn)) return "Read the column that identifies each row too";
    if (f.changedColumn && !f.columns.includes(f.changedColumn)) return "Read the column that shows when a row changed too";
  }
  if (f.filters.length > 10) return "Up to 10 filters";
  for (const x of f.filters) {
    if (!x.column) return "Choose the column each filter tests";
    if (!NO_VALUE.has(x.op) && !String(x.value ?? "").trim()) return `Give the value the filter on ${x.column} compares with`;
    if (String(x.value ?? "").length > 200) return "A filter's value is at most 200 characters";
  }
  return null;
};

/** The body the API takes: columns only when chosen, filter values as typed (the database reads them as its column's type). */
export const recordSourceBody = (schema, object, f) => {
  const source = { schema, object, keyColumn: f.keyColumn };
  if (!f.allColumns) source.columns = f.columns;
  if (f.changedColumn) source.changedColumn = f.changedColumn;
  if (f.filters.length) source.filters = f.filters.map((x) => (NO_VALUE.has(x.op) ? { column: x.column, op: x.op } : { column: x.column, op: x.op, value: String(x.value).trim() }));
  return source;
};

/** An endpoint of an internal API (AG5c), as the source dialog edits it. */
export const restSourceForm = (source = {}) => ({
  path: source.path ?? "",
  recordsPath: source.recordsPath ?? "",
  query: Object.entries(source.query ?? {}).map(([name, value]) => ({ name, value })),
  pagingStyle: source.paging?.style ?? "none",
  pageSize: source.paging?.pageSize != null ? String(source.paging.pageSize) : "",
  pageParam: source.paging?.pageParam ?? source.paging?.offsetParam ?? source.paging?.cursorParam ?? "",
  sizeParam: source.paging?.sizeParam ?? source.paging?.limitParam ?? "",
  nextPath: source.paging?.nextCursorPath ?? source.paging?.nextLinkPath ?? "",
  keyColumn: source.keyColumn ?? null,
  changedColumn: source.changedColumn ?? null,
  changedParam: source.changedParam ?? "",
});

const JSON_PATH = /^[A-Za-z0-9_$@-]{1,60}(\.[A-Za-z0-9_$@-]{1,60}){0,9}$/;
const PARAM = /^[\][A-Za-z0-9_.-]{1,60}$/;

/** Paging in the API's shape (the same as a cloud REST connection's). */
export const restPagingBody = (f) => {
  const s = f.pagingStyle;
  if (s === "none") return undefined;
  const p = { style: s };
  if (f.pageSize) p.pageSize = Number(f.pageSize);
  const param = f.pageParam.trim();
  const size = f.sizeParam.trim();
  if (s === "page") { if (param) p.pageParam = param; if (size) p.sizeParam = size; }
  if (s === "offset") { if (param) p.offsetParam = param; if (size) p.limitParam = size; }
  if (s === "cursor") { if (param) p.cursorParam = param; if (size) p.sizeParam = size; p.nextCursorPath = f.nextPath.trim(); }
  if (s === "next_link") { if (size) p.sizeParam = size; p.nextLinkPath = f.nextPath.trim() || "header"; }
  return p;
};

/** The address to try, before a field identifies the records: path, list, parameters and paging. */
export const restTryRequest = (f) => {
  const r = { path: f.path.trim() };
  if (f.recordsPath.trim()) r.recordsPath = f.recordsPath.trim();
  const q = f.query.filter((x) => x.name.trim());
  if (q.length) r.query = Object.fromEntries(q.map((x) => [x.name.trim(), x.value]));
  const paging = restPagingBody(f);
  if (paging) r.paging = paging;
  return r;
};

/** What stops the address being tried (or, with `full`, the endpoint being saved), in words. */
export const restSourceProblem = (f, full = false) => {
  const path = restPathProblem(f.path.trim());
  if (path) return path;
  if (f.recordsPath.trim() && !JSON_PATH.test(f.recordsPath.trim())) return "Where the list is in the answer is keys joined by dots, such as data or value";
  if (f.query.length > 20) return "At most 20 query parameters";
  for (const x of f.query) {
    if (!x.name.trim()) continue;
    if (!PARAM.test(x.name.trim())) return `The parameter name ${x.name} is letters, digits, _ . - [ ]`;
    if ((x.value ?? "").length > 200) return "A parameter's value is at most 200 characters";
  }
  if (f.pageSize && !(/^\d+$/.test(f.pageSize) && +f.pageSize >= 1 && +f.pageSize <= 1000)) return "The page size is a whole number from 1 to 1,000";
  for (const p of [f.pageParam, f.sizeParam]) if (p.trim() && !PARAM.test(p.trim())) return "A paging parameter name is letters, digits, _ . - [ ]";
  if (f.pagingStyle === "cursor" && !JSON_PATH.test(f.nextPath.trim())) return "Say where the answer gives the next cursor, such as meta.next";
  if (f.pagingStyle === "next_link" && f.nextPath.trim() && f.nextPath.trim() !== "header" && !JSON_PATH.test(f.nextPath.trim())) return "Say where the answer gives the next page's link, or leave it empty for the Link header";
  if (!full) return null;
  if (!f.keyColumn) return "Choose the field that identifies each record";
  if (!!f.changedColumn !== !!f.changedParam.trim()) return "To read only what changed, give both the field that shows when a record changed and the parameter that asks for it";
  if (f.changedParam.trim() && !PARAM.test(f.changedParam.trim())) return "The parameter that asks for changed records is letters, digits, _ . - [ ]";
  return null;
};

/** The endpoint the API takes. */
export const restSourceBody = (f) => {
  const s = { ...restTryRequest(f), keyColumn: f.keyColumn };
  if (f.changedColumn) { s.changedColumn = f.changedColumn; s.changedParam = f.changedParam.trim(); }
  return s;
};

const PAGING_WORDS = { page: "by page number", offset: "by offset", cursor: "by cursor", next_link: "by next link" };

/** A source in one line: "erp.machines · key id · 4 columns · active equals true". */
export const describeRecordSource = (s) =>
  s?.path ? [
    s.path,
    ...(s.recordsPath ? [`list at ${s.recordsPath}`] : []),
    `key ${s.keyColumn}`,
    ...(s.paging?.style && s.paging.style !== "none" ? [`paged ${PAGING_WORDS[s.paging.style] ?? s.paging.style}`] : []),
    ...(s.changedColumn ? [`changes shown by ${s.changedColumn} (asks ${s.changedParam}=…)`] : []),
  ].join(" · ") :
  s?.file ? `Newest CSV or Excel file matching ${s.file}` : [
    `${s.schema}.${s.object}`,
    `key ${s.keyColumn}`,
    s.columns ? `${s.columns.length} column${s.columns.length === 1 ? "" : "s"}` : "all columns",
    ...(s.filters ?? []).map((x) => `${x.column} ${OP_WORDS[x.op] ?? x.op}${NO_VALUE.has(x.op) ? "" : ` ${x.value}`}`),
    ...(s.changedColumn ? [`changes shown by ${s.changedColumn}`] : []),
  ].join(" · ");
