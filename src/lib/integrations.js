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
