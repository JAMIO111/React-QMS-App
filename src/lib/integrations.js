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
