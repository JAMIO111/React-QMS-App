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
    return c;
  }
  return {};
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
  { key: "rest_api", providerKey: "rest_api", name: "REST API", description: "Read records from a system that offers a REST API, on a schedule.", mark: "api", available: false },
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
  purchase_order: "Orders placed with suppliers.",
  goods_receipt: "Deliveries received.",
};

/** Whether a mapping row takes its value from somewhere (a column, joined columns, a fixed value or a value for empty cells). */
export const rowHasSource = (row) =>
  row.transform === "constant" ? row.value !== "" : row.transform === "concat" ? row.sources.length > 0 : !!row.source || !!row.default?.trim();

/** Rows for saving: a field is used when it takes a value from somewhere. */
export const rowsInUse = (rows) => rows.map((r) => ({ ...r, on: rowHasSource(r) }));

const pad2 = (n) => String(n).padStart(2, "0");
/** The same reading of dates the server uses (yyyy-mm-dd, or null when it is not a date written that way). */
export const readDate = (raw, format = "iso") => {
  const s = String(raw ?? "").trim();
  const iso = (y, m, d) => {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad2(m)}-${pad2(d)}` : null;
  };
  if (format === "excel" || /^\d{5}(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) && s !== "" ? new Date(Math.round((n - 25569) * 86_400_000)).toISOString().slice(0, 10) : null;
  }
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (!m || format === "iso") return null;
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return format === "dmy" ? iso(year, +m[2], +m[1]) : iso(year, +m[1], +m[2]);
};

/**
 * What one mapping row makes of one record of the file, the way the server will (column, joining, fixed value, upper / lower case, translation,
 * value for empty cells, then dates and decimal marks). `{ value, problem }`: problem is set when the value cannot be read for its field.
 */
export const exampleValue = (row, field, values) => {
  if (!values) return { value: "", problem: null };
  const get = (c) => (c ? String(values[c] ?? "").trim() : "");
  let v;
  if (row.transform === "constant") v = row.value ?? "";
  else if (row.transform === "concat") v = row.sources.map(get).filter(Boolean).join(row.separator ?? " ");
  else v = get(row.source);
  if (row.transform === "upper") v = v.toUpperCase();
  if (row.transform === "lower") v = v.toLowerCase();
  if (row.transform === "map" && v !== "") {
    const hit = Object.entries(parseValueMap(row.valuesText)).find(([from]) => from.trim().toLowerCase() === v.toLowerCase());
    if (hit) v = hit[1];
  }
  if (v === "") v = (row.default ?? "").trim();
  if (v === "") return { value: "", problem: null };
  if (field?.type === "date") {
    const d = readDate(v, row.dateFormat);
    return d ? { value: d, problem: null } : { value: v, problem: "Not a date written this way" };
  }
  if (field?.type === "number" || field?.type === "integer") {
    const s = v.replace(/\s/g, "");
    const normal = row.decimal === "," ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
    if (!/^-?\d+(\.\d+)?$/.test(normal)) return { value: v, problem: "Not a number" };
    if (field.type === "integer" && !Number.isInteger(Number(normal))) return { value: v, problem: "Not a whole number" };
    return { value: normal, problem: null };
  }
  if (field?.type === "enum" && field.options) {
    const s = v.toLowerCase().replace(/[\s-]+/g, "_");
    const opt = field.options.find((o) => o.value === s || o.label.toLowerCase() === v.toLowerCase());
    return opt ? { value: opt.label, problem: null } : { value: v, problem: `Not one of: ${field.options.map((o) => o.label).join(", ")}` };
  }
  if (field?.maxLength && v.length > field.maxLength) return { value: v, problem: `Longer than ${field.maxLength} characters` };
  return { value: v, problem: null };
};

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
export const wizardPath = (connectionId, { entity, file, step } = {}) => {
  const q = new URLSearchParams({ connection: connectionId });
  if (entity) q.set("entity", entity);
  if (file) q.set("file", file);
  if (step) q.set("step", String(step));
  return `/Settings/Integrations/csv?${q}`;
};
