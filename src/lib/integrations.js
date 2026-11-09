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
